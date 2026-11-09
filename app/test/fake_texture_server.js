// A stand-in for mrt2-cloud that speaks its protocol (mrt2-cloud/PROTOCOL.md) and streams a SINE
// instead of MRT2: pitch = the first held note in the session's notes vector, or `baseHz × (n+1)`
// for the n-th session (so per-room isolation is audible in tests). Records every JSON message.
import { WebSocketServer } from "ws";
import http from "node:http";
import { execFileSync } from "node:child_process";

/** Raw Opus packets (20 ms, 48 kHz stereo) of a sine, via ffmpeg → Ogg → packets. null without ffmpeg/libopus. */
let opusCache = null;
export function opusSinePackets(hz = 440, seconds = 2, kbps = 96) {
  if (opusCache?.key === `${hz}/${seconds}/${kbps}`) return opusCache.val;
  let ogg;
  try {
    ogg = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `aevalsrc=0.366*sin(2*PI*${hz}*t):s=48000:d=${seconds}`,
      "-ac", "2", "-c:a", "libopus", "-b:a", `${kbps}k`, "-frame_duration", "20", "-f", "ogg", "-"], { maxBuffer: 1 << 26 });
  } catch { return null; }
  const packets = [];
  let pos = 0, cur = [];
  while (pos + 27 <= ogg.length && ogg.toString("latin1", pos, pos + 4) === "OggS") {
    const nseg = ogg[pos + 26], lacing = ogg.subarray(pos + 27, pos + 27 + nseg);
    let body = pos + 27 + nseg;
    for (const l of lacing) {
      cur.push(ogg.subarray(body, body + l)); body += l;
      if (l < 255) { packets.push(Buffer.concat(cur)); cur = []; }
    }
    pos = body;
  }
  const head = packets.shift(); packets.shift();               // OpusHead, OpusTags
  const val = { packets, preSkip: head.readUInt16LE(10) };
  opusCache = { key: `${hz}/${seconds}/${kbps}`, val };
  return val;
}

export function startFakeTextureServer({ token = "tok", readyDelayMs = 0, rtf = 3.2, baseHz = 220,
                                         reject = null, prebufferMs = 320, pitchFrom = "notes",
                                         opus = true } = {}) {
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
        if (m.format === "opus" && !opus) {                   // a server without libopus
          ws.send(JSON.stringify({ type: "error", code: "unsupported_format", message: "opus encoder unavailable", fatal: true }));
          return ws.close(4400);
        }
        if (m.format === "opus") {                            // a 440 Hz sine as raw Opus packets, 20 ms each
          const { packets, preSkip } = opusSinePackets(440, 2, Math.round((m.opus?.bitrate || 96000) / 1000));
          setTimeout(() => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(JSON.stringify({ type: "ready", protocol: 1, session_id: `fake${s.idx}`, model: "mrt2_small",
              engine: "fake", backend: "sine", device: "cpu", gpu: "FakeGPU", sample_rate: 48000, channels: 2,
              format: "opus", packet_ms: 20, frame_ms: 40, rtf, prebuffer_ms: prebufferMs,
              opus: { sample_rate: 48000, channels: 2, bitrate: m.opus?.bitrate || 96000, packet_ms: 20, pre_skip: preSkip } }));
            const t0 = Date.now();
            timer = setInterval(() => {
              while (s.framesSent * 20 < Date.now() - t0 + prebufferMs) {
                ws.send(packets[s.framesSent % packets.length], { binary: true });
                s.framesSent++;
              }
            }, 20);
          }, readyDelayMs);
          return;
        }
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
