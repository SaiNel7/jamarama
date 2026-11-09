// Cloud MRT2 texture: one mrt2-cloud streaming session per room (see mrt2-cloud/PROTOCOL.md).
//
// The room's server.js owns the session (never the browser, so the token stays server-side):
//   jam starts → open a session with the room's translated conditioning (texture_translate.js)
//   room state changes → diff + send style / notes / params (coalesced)
//   PCM frames (40 ms, 48 kHz stereo int16) → onPcm() → relayed to the host browser's bridge
//   room ends / host leaves / idle → stop
// Every failure path degrades to "band only" silently: the band never waits on this.
import WebSocket from "ws";
import { translate } from "./texture_translate.js";

const ONSET_HOLD_MS = 480;         // texture_engine.py held an onset for one 12-frame chunk (0.48 s)
const STYLE_MIN_INTERVAL_MS = 400; // energy decays every second → don't re-blend more often than this
const PING_MS = 15000;
const FATAL_CLOSE = new Set([4400, 4401, 4410]);   // bad request / bad token / session cap reached: don't retry

const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function styleClose(a, b) {        // ignore weight jitter < 0.02 (energy-driven damping)
  if (!a || !b || a.prompts.length !== b.prompts.length) return false;
  return a.prompts.every((p, i) => p.text === b.prompts[i].text && Math.abs(p.weight - b.prompts[i].weight) < 0.02);
}

export function normalizeUrl(u) {
  let url = String(u || "").trim();
  if (!url) return "";
  if (url.startsWith("https://")) url = "wss://" + url.slice(8);
  else if (url.startsWith("http://")) url = "ws://" + url.slice(7);
  if (!/\/v1\/stream\/?$/.test(url)) url = url.replace(/\/$/, "") + "/v1/stream";
  return url;
}

export class CloudTexture {
  /**
   * @param {object} o
   * @param {string} o.url        mrt2-cloud WS URL (https:// or wss://; /v1/stream appended if missing)
   * @param {string} o.token      shared bearer token
   * @param {(buf:Buffer)=>void} o.onPcm      called per 40 ms PCM frame
   * @param {(s:object)=>void} o.onStatus     {status: standby|warming|live|failed|stopped, ...}
   * @param {(msg:string)=>void} [o.log]
   */
  constructor({ url, token, onPcm, onStatus, log = () => {}, readyTimeoutMs = 150000,
                maxRetries = 3, minRtf = 0.95, opusBitrate = 96000, prewarmGapMs = 90000 }) {
    this.url = normalizeUrl(url);
    this.token = token;
    this.onPcm = onPcm;
    this.onStatus = onStatus;
    this.log = log;
    this.readyTimeoutMs = readyTimeoutMs;
    this.maxRetries = maxRetries;
    this.minRtf = minRtf;
    this.ws = null;
    this.want = false;             // should a session be running?
    this.retries = 0;
    this.status = "standby";
    this.sent = { style: null, notes: null, params: null };
    this.state = null;
    this.lastDegree = undefined;
    this.onsetTimer = null;
    this.styleTimer = null;
    this.lastStyleAt = 0;
    this.frames = 0;
    this.bytes = 0;
    this.format = "pcm16";         // per session: "pcm16" or "opus" (see start())
    this.opusBitrate = opusBitrate;
    this.prewarmGapMs = prewarmGapMs;
    this._prewarmAt = 0;
  }

  get configured() { return Boolean(this.url && this.token); }

  _setStatus(status, extra = {}) {
    this.status = status;
    try { this.onStatus?.({ status, ...extra }); } catch {}
  }

  /** Fire-and-forget GET /healthz: makes Modal boot a GPU container during the lobby, so the
   *  texture is (nearly) ready by the time the jam starts. Costs only the warm-container time. */
  prewarm() {
    if (!this.configured || this.ws) return false;                 // a session is already up
    if (Date.now() - this._prewarmAt < this.prewarmGapMs) return false;   // container is still warm
    this._prewarmAt = Date.now();
    const http = this.url.replace(/^ws/, "http").replace(/\/v1\/stream\/?$/, "/healthz");
    fetch(http, { signal: AbortSignal.timeout(150000) })
      .then((r) => this.log(`[texture-cloud] prewarm ${r.status}`))
      .catch((e) => this.log(`[texture-cloud] prewarm failed (${e.name || e.message})`));
    return true;
  }

  /** Start (or keep) a session for this room state. Idempotent.
   *  format: "opus" when every listening host can decode it (≈0.7 MB/min instead of 11.5 MB/min
   *  of pcm16 per room, on the GPU→room hop AND the room→browser hop); fixed for the session. */
  start(state, { format } = {}) {
    if (!this.configured) return;
    if (!this.ws && format) this.format = format === "opus" ? "opus" : "pcm16";
    this.state = state;
    this.want = true;
    if (!this.ws) this._open();
  }

  /** Room state changed → send what differs. */
  update(state) {
    this.state = state;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.status !== "live") return;
    const onset = state.chord !== this.lastDegree;
    if (onset) this.lastDegree = state.chord;
    const c = translate(state, { onset });
    if (!sameJSON(c.params, this.sent.params)) this._send({ type: "params", ...c.params }), this.sent.params = c.params;
    if (!sameJSON(c.notes, this.sent.notes)) this._send({ type: "notes", notes: c.notes }), this.sent.notes = c.notes;
    if (onset) {                   // onset (2) for one chunk, then sustained (3) — like the MLX engine
      clearTimeout(this.onsetTimer);
      this.onsetTimer = setTimeout(() => this.update(this.state), ONSET_HOLD_MS);
    }
    this._maybeStyle(c.style);
  }

  // Dead-band (weight drift < 0.02 is inaudible; the decaying crowd energy nudges weights every
  // second) + rate limit (≤ 1 re-blend per STYLE_MIN_INTERVAL_MS; the latest state wins).
  _maybeStyle(style) {
    if (styleClose(style, this.sent.style)) return;
    const wait = STYLE_MIN_INTERVAL_MS - (Date.now() - this.lastStyleAt);
    if (wait > 0) {
      if (!this.styleTimer)
        this.styleTimer = setTimeout(() => { this.styleTimer = null; this._maybeStyle(translate(this.state).style); }, wait);
      return;
    }
    this._send({ type: "style", ...style });
    this.sent.style = style;
    this.lastStyleAt = Date.now();
  }

  stop(reason = "stop") {
    this.want = false;
    clearTimeout(this.onsetTimer); clearTimeout(this.styleTimer); clearTimeout(this._retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" })); } catch {}
      try { ws.close(1000); } catch {}
      setTimeout(() => { try { ws.terminate(); } catch {} }, 2000).unref?.();
      const secs = this.format === "opus" ? this.frames * 0.02 : this.frames * 0.04;
      this.log(`[texture-cloud] session closed (${reason}) after ${secs.toFixed(1)}s of ${this.format} audio, `
        + `${(this.bytes / 1e6).toFixed(2)} MB (${(this.bytes / 1e6 / Math.max(secs / 60, 1e-9)).toFixed(2)} MB/min)`);
    }
    if (this.status !== "failed") this._setStatus("stopped");
  }

  _send(obj) {
    try { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); } catch {}
  }

  _open() {
    const s = this.state;
    this.lastDegree = s.chord;
    const c = translate(s, { onset: true });
    this.sent = { style: c.style, notes: c.notes, params: c.params };
    this.lastStyleAt = Date.now();
    this.frames = 0; this.bytes = 0;
    this._setStatus("warming");
    this.log(`[texture-cloud] opening session → ${this.url}`);
    const ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.token}` },
      handshakeTimeout: this.readyTimeoutMs, maxPayload: 1 << 20 });
    this.ws = ws;
    let ready = false;
    const readyTimer = setTimeout(() => {
      if (!ready && this.ws === ws) { this.log("[texture-cloud] no 'ready' in time"); try { ws.terminate(); } catch {} }
    }, this.readyTimeoutMs);
    let ping = null;
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "start", model: "mrt2_small", sample_rate: 48000, format: this.format,
        ...(this.format === "opus" ? { opus: { bitrate: this.opusBitrate, packet_ms: 20 } } : {}),
        style: c.style, notes: c.notes, params: c.params, seed: Math.floor(Math.random() * 1e9) }));
      ping = setInterval(() => this._send({ type: "ping" }), PING_MS);
    });
    ws.on("message", (data, isBinary) => {
      if (this.ws !== ws) return;
      if (isBinary) { this.frames++; this.bytes += data.length; this.onPcm?.(data); return; }
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.type === "ready") {
        ready = true; clearTimeout(readyTimer);
        if (typeof m.rtf === "number" && m.rtf > 0 && m.rtf < this.minRtf) {
          // The GPU can't keep up → a choppy bed is worse than none. Give up for this room.
          this.log(`[texture-cloud] GPU too slow (rtf ${m.rtf}) — band only`);
          this.retries = this.maxRetries;
          this._setStatus("failed", { reason: "slow" });
          try { ws.close(1000); } catch {}
          return;
        }
        this.retries = 0;
        if (m.format && m.format !== this.format) this.format = m.format;   // trust what the server streams
        this.log(`[texture-cloud] live: ${m.gpu || m.device} ${m.backend} rtf=${m.rtf} prebuffer=${m.prebuffer_ms}ms format=${this.format}`);
        this._setStatus("live", { prebufferMs: m.prebuffer_ms, rtf: m.rtf, gpu: m.gpu, format: this.format,
          ...(this.format === "opus" ? { preSkip: m.opus?.pre_skip ?? 312, packetMs: m.opus?.packet_ms ?? 20 } : {}) });
        this.update(this.state);                 // anything that changed while warming
      } else if (m.type === "error") {
        this.log(`[texture-cloud] ${m.fatal ? "error" : "warning"}: ${m.code} ${m.message}`);
        if (m.code === "capacity") this._capacity = m.retry_after_ms || 15000;
        if (m.code === "unsupported_format" && this.format === "opus") {     // server without libopus
          this.log("[texture-cloud] opus unavailable on the GPU service — falling back to pcm16");
          this.format = "pcm16"; this._reformat = true;
        }
      } else if (m.type === "stats" && m.underruns && m.underruns !== this._lastUnderruns) {
        this._lastUnderruns = m.underruns;
        this.log(`[texture-cloud] GPU underruns=${m.underruns} rtf=${m.rtf}`);
      }
    });
    ws.on("error", (e) => this.log(`[texture-cloud] socket error: ${e.code || e.message}`));
    ws.on("close", (code) => {
      clearInterval(ping); clearTimeout(readyTimer);
      if (this.ws !== ws) return;               // we replaced/stopped it on purpose
      this.ws = null;
      if (!this.want) return;
      if (this._reformat) { this._reformat = false; this._open(); return; }   // same session, pcm16
      if (FATAL_CLOSE.has(code) || this.retries >= this.maxRetries) {
        this.log(`[texture-cloud] giving up (close ${code}) — band only`);
        this._setStatus("failed", { reason: String(code) });
        this.want = false;
        return;
      }
      const delay = this._capacity || Math.min(20000, 2000 * 2 ** this.retries);
      this._capacity = 0;
      this.retries++;
      this.log(`[texture-cloud] session closed (${code}) — retry ${this.retries}/${this.maxRetries} in ${delay / 1000}s`);
      this._setStatus("warming", { retry: this.retries });
      this._retryTimer = setTimeout(() => { if (this.want && !this.ws) this._open(); }, delay);
    });
  }
}
