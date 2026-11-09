// Streamed MRT2 texture → WebAudio (host page).
// Binary frames arrive over the room WebSocket in one of two formats:
//   pcm16 — interleaved Int16 stereo @ 48 kHz: ~0.48 s chunks from the local MLX engine, or 40 ms
//           frames from the cloud GPU (mrt2-cloud). 11.5 MB/min.
//   opus  — one raw Opus packet per frame (20 ms, ~96 kbit/s ≈ 0.7 MB/min) from the cloud GPU,
//           decoded here with WebCodecs. Used only when this browser reported it can decode it.
// Decoded audio is scheduled back-to-back on the audio clock behind a jitter buffer:
//   - the buffer starts at the cloud's prebuffer advice (+ a relay margin) and GROWS by 100 ms after
//     every underrun (up to 1.5 s), so a jittery cellular link stops re-buffering over and over;
//   - every chunk's edge is micro-faded (5 ms) unless the next chunk arrives in time, so an underrun
//     is a short dip instead of a click;
//   - the bed FADES IN (fadeSec) when the stream first arrives or comes back after a long gap (e.g.
//     a cloud GPU cold start, while the band is already playing) instead of popping in.
const EDGE = 0.005;

export class TextureBridge {
  /**
   * @param {object} o
   * @param {() => AudioContext|null} o.ctx       the running AudioContext (null → not started yet)
   * @param {(node: AudioNode) => boolean} o.connect  wire our fade node into the bus graph; false if not ready
   * @param {number} [o.leadSec]   initial jitter buffer ahead of the clock
   * @param {number} [o.fadeSec]   fade-in length after the stream (re)starts
   * @param {number} [o.maxLeadSec] ceiling for the adaptive jitter buffer
   */
  constructor({ ctx, connect, leadSec = 0.18, fadeSec = 3.0, sampleRate = 48000, maxLeadSec = 1.5 }) {
    this.ctx = ctx;
    this.connect = connect;
    this.leadSec = leadSec;
    this.minLead = leadSec;
    this.maxLead = maxLeadSec;
    this.fadeSec = fadeSec;
    this.sampleRate = sampleRate;
    this.next = 0;
    this.fade = null;
    this.gap = null;
    this.lastPush = 0;
    this.format = "pcm16";
    this.decoder = null;
    this.preSkip = 0;
    this._skip = 0;
    this._ts = 0;
    this._edgeAt = 0;
    this.stats = { chunks: 0, seconds: 0, underruns: 0, fades: 0, lastRms: 0, dropped: 0, bytes: 0, decodeErrors: 0 };
  }

  /** Can this browser decode raw Opus packets (WebCodecs)? */
  static async opusSupported() {
    try {
      if (typeof AudioDecoder === "undefined") return false;
      const r = await AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
      return Boolean(r?.supported);
    } catch { return false; }
  }

  /** The cloud tells us how much to pre-buffer (network + GPU jitter). */
  setPrebuffer(ms) {
    if (typeof ms === "number" && ms > 0) {
      this.leadSec = Math.max(this.minLead, Math.min(this.maxLead, ms / 1000));
      this.baseLead = this.leadSec;
    }
  }

  /** A (new) session went live: which format its frames are in. Resets the decoder state. */
  setFormat(format, { preSkip = 312 } = {}) {
    this.format = format === "opus" ? "opus" : "pcm16";
    this._closeDecoder();
    this.preSkip = this.format === "opus" ? preSkip : 0;
    this._skip = this.preSkip;
    this._ts = 0;
  }

  _closeDecoder() {
    try { this.decoder?.state !== "closed" && this.decoder?.close(); } catch {}
    this.decoder = null;
  }

  _ensureDecoder() {
    if (this.decoder && this.decoder.state === "configured") return this.decoder;
    this._closeDecoder();
    const dec = new AudioDecoder({
      output: (ad) => this._onDecoded(ad),
      error: () => { this.stats.decodeErrors++; if (this.decoder === dec) this.decoder = null; },
    });
    dec.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
    this.decoder = dec;
    return dec;
  }

  _onDecoded(ad) {
    try {
      let frames = ad.numberOfFrames;
      const L = new Float32Array(frames), R = new Float32Array(frames);
      ad.copyTo(L, { planeIndex: 0, format: "f32-planar" });
      ad.copyTo(R, { planeIndex: ad.numberOfChannels > 1 ? 1 : 0, format: "f32-planar" });
      let off = 0;
      if (this._skip > 0) { off = Math.min(this._skip, frames); this._skip -= off; }   // encoder lookahead
      if (off < frames) this._play(off ? L.subarray(off) : L, off ? R.subarray(off) : R, frames - off, ad.sampleRate || 48000);
    } finally { ad.close(); }
  }

  _ensureNodes(ctx) {
    if (this.fade && this.fade.context === ctx) return true;
    const g = ctx.createGain();
    g.gain.value = 0;
    if (!this.connect(g)) return false;
    const gap = ctx.createGain();
    gap.gain.value = 0;
    gap.connect(g);
    this.fade = g; this.gap = gap;
    return true;
  }

  /** One binary frame: Int16 LE interleaved stereo (pcm16) or one raw Opus packet (opus). */
  push(buf) {
    const ctx = this.ctx();
    if (!ctx || !this._ensureNodes(ctx)) { this.stats.dropped++; return; }   // audio engine not started yet
    this.stats.bytes += buf.byteLength;
    if (this.format === "opus") {
      if (typeof AudioDecoder === "undefined") { this.stats.dropped++; return; }
      try {
        const dec = this._ensureDecoder();
        dec.decode(new EncodedAudioChunk({ type: "key", timestamp: this._ts, data: buf }));
        this._ts += 20000;
      } catch { this.stats.decodeErrors++; this._closeDecoder(); }
      return;
    }
    const i16 = new Int16Array(buf);
    const frames = i16.length >> 1;
    if (!frames) return;
    const L = new Float32Array(frames), R = new Float32Array(frames);
    for (let i = 0; i < frames; i++) { L[i] = i16[2 * i] / 32768; R[i] = i16[2 * i + 1] / 32768; }
    this._play(L, R, frames, this.sampleRate);
  }

  _play(L, R, frames, rate) {
    const ctx = this.ctx();
    if (!ctx || !this._ensureNodes(ctx)) { this.stats.dropped++; return; }
    const ab = ctx.createBuffer(2, frames, rate);              // browser resamples to the context rate
    ab.copyToChannel(L, 0); ab.copyToChannel(R, 1);
    let sq = 0;
    for (let i = 0; i < frames; i++) sq += L[i] * L[i] + R[i] * R[i];
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.gap);
    const now = ctx.currentTime;
    const wall = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
    const fresh = this.stats.chunks === 0 || wall - this.lastPush > 2.0;   // first audio / back after a gap
    this.lastPush = wall;
    const gap = this.gap.gain;
    let reprime = false;
    if (this.next < now + 0.02) {                       // (re)prime the jitter buffer
      if (this.stats.chunks > 0 && !fresh) {
        this.stats.underruns++;
        this.leadSec = Math.min(this.maxLead, this.leadSec + 0.1);   // adapt to this link's jitter
      }
      if (fresh) this.leadSec = this.baseLead ?? this.leadSec;
      this.next = now + this.leadSec;
      reprime = true;
    }
    const start = this.next, end = start + ab.duration;
    if (reprime) {                                      // fade the edge in (5 ms) — no click after a gap
      gap.cancelScheduledValues(start);                 // (the previous tail keeps its own fade-out)
      gap.setValueAtTime(0, start);
      gap.linearRampToValueAtTime(1, start + EDGE);
    } else {
      gap.cancelScheduledValues(this._edgeAt);          // the next chunk arrived in time: no fade-out
    }
    gap.setValueAtTime(1, end - EDGE);                   // …unless nothing follows this chunk
    gap.linearRampToValueAtTime(0, end);
    this._edgeAt = end - EDGE;
    if (fresh) {                                         // fade the bed in under the band
      const g = this.fade.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(0, start);
      g.linearRampToValueAtTime(1, start + this.fadeSec);
      this.stats.fades++;
    }
    src.start(start);
    this.next = end;
    src.onended = () => { try { src.disconnect(); } catch {} };
    this.stats.chunks++;
    this.stats.seconds += ab.duration;
    this.stats.lastRms = Math.sqrt(sq / (2 * frames));
    if (this.stats.chunks === 1) console.log(`[texture] receiving ${this.format} — bed is live (fading in)`);
  }
}
