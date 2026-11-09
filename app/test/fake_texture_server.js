// A stand-in for mrt2-cloud that speaks its protocol (mrt2-cloud/PROTOCOL.md) and streams a SINE
// instead of MRT2: pitch = the first held note in the session's notes vector, or `baseHz × (n+1)`
// for the n-th session (so per-room isolation is audible in tests). Records every JSON message.
import { WebSocketServer } from "ws";
import http from "node:http";

export function startFakeTextureServer({ token = "tok", readyDelayMs = 0, rtf = 3.2, baseHz = 220,
                                         reject = null, prebufferMs = 320, pitchFrom = "notes" } = {}) {
  const sessions = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") { fake.healthz++; res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":true}'); }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path: "/v1/stream" });
  const fake = { sessions, healthz: 0, url: null, close: null };
  wss.on("connection", (ws, req) => {
    const s = { idx: sessions.length, auth: req.headers.authorization, msgs: [], closed: null, framesSent: 0, ws };
    sessions.push(s);
    if (reject) { ws.send(JSON.stringify({ type: "error", code: reject.code, message: "rejected", fatal: true })); ws.close(reject.close); return; }
    if (s.auth !== `Bearer ${token}`) {
      ws.send(JSON.stringify({ type: "error", code: "unauthorized", message: "bad token", fatal: true }));
      return ws.close(4401);
    }
    let timer = null, phase = 0, notes = null;
    const hz = () => {
      const held = pitchFrom === "notes" ? (notes || []).findIndex((v) => v > 0) : -1;
      return held >= 0 ? 440 * 2 ** ((held - 69) / 12) : baseHz * (s.idx + 1);
    };
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(raw);
      s.msgs.push(m);
      if (m.type === "start") {
        notes = m.notes;
        setTimeout(() => {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(JSON.stringify({ type: "ready", protocol: 1, session_id: `fake${s.idx}`, model: "mrt2_small",
            engine: "fake", backend: "sine", device: "cpu", gpu: "FakeGPU", sample_rate: 48000, channels: 2,
            format: "pcm16", frame_samples: 1920, frame_bytes: 7680, frame_ms: 40, rtf, prebuffer_ms: prebufferMs }));
          const t0 = Date.now();
          timer = setInterval(() => {                       // real-time pace, 40 ms frames
            while (s.framesSent * 40 < Date.now() - t0 + prebufferMs) {
              const buf = Buffer.alloc(7680);
              const f = hz();
              for (let i = 0; i < 1920; i++) {
                const v = Math.round(Math.sin(phase) * 12000);
                phase += (2 * Math.PI * f) / 48000;
                buf.writeInt16LE(v, 4 * i); buf.writeInt16LE(v, 4 * i + 2);
              }
              ws.send(buf, { binary: true });
              s.framesSent++;
            }
          }, 20);
        }, readyDelayMs);
      } else if (m.type === "notes") notes = m.notes;
      else if (m.type === "stop") ws.close(1000);
      else if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    });
    ws.on("close", (code) => { clearInterval(timer); s.closed = code || 1005; });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    fake.url = `http://127.0.0.1:${server.address().port}`;      // CloudTexture normalizes http→ws + /v1/stream
    fake.close = () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(r); });
    resolve(fake);
  }));
}

/** Dominant frequency (Hz) of Int16 interleaved stereo PCM buffers (left channel, zero-crossing count). */
export function pcmHz(bufs) {
  const all = Buffer.concat(bufs);
  let crossings = 0, prev = 0, n = 0;
  for (let i = 0; i + 1 < all.length; i += 4) {
    const v = all.readInt16LE(i);
    if (n > 0 && ((prev < 0 && v >= 0) || (prev >= 0 && v < 0))) crossings++;
    prev = v; n++;
  }
  return (crossings / 2) / (n / 48000);
}
