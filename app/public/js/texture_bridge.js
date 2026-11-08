// Streamed MRT2 texture → WebAudio (host page).
// PCM arrives over the room WebSocket as binary frames of interleaved Int16 stereo @ 48 kHz —
// ~0.48 s chunks from the local MLX engine, or 40 ms frames from the cloud GPU (mrt2-cloud).
// Chunks are scheduled back-to-back on the audio clock behind a small jitter buffer; if one is
// late (underrun) the cursor re-primes. Everything goes through a private fade gain → the
// destination (textureBus), so the bed FADES IN when it first arrives (e.g. after a cloud GPU
// cold start, while the band is already playing) instead of popping in.
export class TextureBridge {
  /**
   * @param {object} o
   * @param {() => AudioContext|null} o.ctx       the running AudioContext (null → not started yet)
   * @param {(node: AudioNode) => boolean} o.connect  wire our fade node into the bus graph; false if not ready
   * @param {number} [o.leadSec]   jitter buffer ahead of the clock
   * @param {number} [o.fadeSec]   fade-in length after the stream (re)starts
   */
  constructor({ ctx, connect, leadSec = 0.18, fadeSec = 3.0, sampleRate = 48000 }) {
    this.ctx = ctx;
    this.connect = connect;
    this.leadSec = leadSec;
    this.minLead = leadSec;
    this.fadeSec = fadeSec;
    this.sampleRate = sampleRate;
    this.next = 0;
    this.fade = null;
    this.lastPush = 0;
    this.stats = { chunks: 0, seconds: 0, underruns: 0, fades: 0, lastRms: 0, dropped: 0 };
  }

  /** The cloud tells us how much to pre-buffer (network + GPU jitter). */
  setPrebuffer(ms) {
    if (typeof ms === "number" && ms > 0) this.leadSec = Math.max(this.minLead, Math.min(1.5, ms / 1000));
  }

  _ensureFade(ctx) {
    if (this.fade && this.fade.context === ctx) return true;
    const g = ctx.createGain();
    g.gain.value = 0;
    if (!this.connect(g)) return false;
    this.fade = g;
    return true;
  }

  /** One binary frame (ArrayBuffer of Int16 LE interleaved stereo). */
  push(buf) {
    const ctx = this.ctx();
    if (!ctx || !this._ensureFade(ctx)) { this.stats.dropped++; return; }   // audio engine not started yet
    const i16 = new Int16Array(buf);
    const frames = i16.length >> 1;
    if (!frames) return;
    const ab = ctx.createBuffer(2, frames, this.sampleRate);   // browser resamples to the context rate
    const L = ab.getChannelData(0), R = ab.getChannelData(1);
    let sq = 0;
    for (let i = 0; i < frames; i++) {
      const l = i16[2 * i] / 32768, r = i16[2 * i + 1] / 32768;
      L[i] = l; R[i] = r; sq += l * l + r * r;
    }
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.fade);
    const now = ctx.currentTime;
    const wall = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
    const fresh = this.stats.chunks === 0 || wall - this.lastPush > 2.0;   // first audio / back after a gap
    this.lastPush = wall;
    if (this.next < now + 0.02) {                       // (re)prime the jitter buffer
      if (this.stats.chunks > 0 && !fresh) this.stats.underruns++;
      this.next = now + this.leadSec;
    }
    if (fresh) {                                         // fade the bed in under the band
      const g = this.fade.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(0, this.next);
      g.linearRampToValueAtTime(1, this.next + this.fadeSec);
      this.stats.fades++;
    }
    src.start(this.next);
    this.next += ab.duration;
    src.onended = () => { try { src.disconnect(); } catch {} };
    this.stats.chunks++;
    this.stats.seconds += frames / this.sampleRate;
    this.stats.lastRms = Math.sqrt(sq / (2 * frames));
    if (this.stats.chunks === 1) console.log("[texture] receiving PCM — bed is live (fading in)");
  }
}
