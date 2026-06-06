// JAMARAMA host server — static web app + WebSocket relay over the LAN.
// The host browser owns the master clock (Tone.js Transport) and broadcasts
// beats through here; phones are thin controllers that follow.
import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { networkInterfaces } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn } from "child_process";
import { existsSync } from "fs";
import QRCode from "qrcode";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// --- LAN IP (so phones on the same WiFi can reach the host) ---
function lanIP() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}
const IP = lanIP();
// PUBLIC_URL (e.g. a cloudflared tunnel) overrides the LAN address so the QR works off-network.
const BASE = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, "") : `http://${IP}:${PORT}`;
const JOIN_URL = `${BASE}/join`;

// --- room state (single room for the demo) ---
const ROLE_COLORS = {
  groove: "#F5B82E", harmony: "#1BA88A", lead: "#F4533A", crowd: "#9B7BE6",
};
const state = {
  room: "BASEMENT SESSIONS",
  key: "A", scale: "major",
  tempo: 124,
  bar: 0, beat: 0,
  chord: "I",                       // current harmony degree (roman numeral)
  progression: ["I", "IV", "V", "vi"],
  taste: ["warm ambient pads", "cinematic texture"], // blended taste → MRT2 style embedding
  energy: 0.0,                      // crowd collective energy 0..1
  mood: { brighter: 0, heavier: 0, dreamier: 0, darker: 0 },
  recentMoods: [],                 // [{mood, t}]
  groove: { x: 0.5, y: 0.5 },      // host X/Y pad
};

// --- clients ---
let nextId = 1;
const clients = new Map(); // id -> { ws, role, color, id }

// Phone role assignment: first → harmony, second → lead, everyone else → crowd.
function assignRole() {
  const roles = [...clients.values()].map((c) => c.role);
  if (!roles.includes("harmony")) return "harmony";
  if (!roles.includes("lead")) return "lead";
  return "crowd";
}

function roster() {
  // 'texture' (the MRT2 engine) is not a player — keep it out of the roster.
  return [...clients.values()].filter((c) => c.role !== "texture")
    .map((c) => ({ id: c.id, role: c.role, color: c.color }));
}
function crowdCount() {
  return [...clients.values()].filter((c) => c.role === "crowd").length;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj, exceptId = null) {
  const msg = JSON.stringify(obj);
  for (const c of clients.values()) {
    if (c.id !== exceptId && c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
  }
}
function broadcastState() {
  broadcast({ type: "state", state, roster: roster(), crowdCount: crowdCount() });
}

// --- HTTP ---
const app = express();
// log page/info hits (not assets) so we can see if a phone actually reaches the server
app.use((req, _res, next) => {
  if (["/", "/join", "/info"].includes(req.path))
    console.log(`  HTTP ${req.method} ${req.path} ← ${req.ip}`);
  next();
});
app.use(express.static(join(__dirname, "public")));
// serve Tone.js locally (works offline on the LAN)
app.use("/vendor/tone", express.static(join(__dirname, "node_modules/tone/build")));

app.get("/", (_req, res) => res.sendFile(join(__dirname, "public/host.html")));
app.get("/join", (_req, res) => res.sendFile(join(__dirname, "public/join.html")));
app.get("/info", async (_req, res) => {
  res.json({ ip: IP, port: PORT, joinUrl: JOIN_URL, qr: await QRCode.toDataURL(JOIN_URL, { margin: 1, width: 320 }) });
});

const server = createServer(app);

// --- WebSocket ---
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  let id = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "hello": {
        id = nextId++;
        const role = (msg.role === "host" || msg.role === "texture") ? (msg.role === "host" ? "groove" : "texture") : assignRole();
        const color = ROLE_COLORS[role];
        clients.set(id, { ws, id, role, color });
        send(ws, { type: "welcome", id, role, color, state, roster: roster(), crowdCount: crowdCount() });
        broadcast({ type: "roster", roster: roster(), crowdCount: crowdCount() }, id);
        console.log(`+ ${role} #${id} (${clients.size} connected)`);
        break;
      }
      // Host clock → fan out to phones so they pulse in time.
      case "beat": {
        state.bar = msg.bar; state.beat = msg.beat;
        broadcast({ type: "beat", bar: msg.bar, beat: msg.beat, sub: msg.sub });
        break;
      }
      // Phone control → mutate state + tell everyone (incl. host engine).
      case "control": {
        applyControl(msg, id);
        broadcast({ type: "control", from: id, role: clients.get(id)?.role, action: msg.action, payload: msg.payload });
        broadcastState();
        break;
      }
      // Host pad / tempo / clock-driven chord advance.
      case "host": {
        if (msg.action === "groove") state.groove = msg.payload;
        if (msg.action === "tempo") state.tempo = msg.payload;
        if (msg.action === "chord") state.chord = msg.payload;     // host advances the playhead on the downbeat
        if (msg.action === "taste") state.taste = msg.payload;
        broadcastState();
        break;
      }
    }
  });

  ws.on("close", () => {
    if (id != null) {
      const c = clients.get(id);
      clients.delete(id);
      console.log(`- ${c?.role} #${id} (${clients.size} connected)`);
      broadcast({ type: "roster", roster: roster(), crowdCount: crowdCount() });
    }
  });
});

function applyControl(msg, id) {
  const { action, payload } = msg;
  switch (action) {
    case "chord":          // harmony: set current chord degree
      state.chord = payload.degree;
      break;
    case "progression":    // harmony: replace the drawn loop
      state.progression = payload.degrees;
      break;
    case "mood": {         // crowd: a mood tap
      if (state.mood[payload.mood] != null) state.mood[payload.mood]++;
      state.recentMoods.unshift({ mood: payload.mood, id });
      state.recentMoods = state.recentMoods.slice(0, 6);
      break;
    }
    case "energy":         // crowd: hold-to-raise (delta 0..1)
      state.energy = Math.max(0, Math.min(1, state.energy + (payload.delta || 0)));
      break;
  }
}

// Crowd energy decays slowly toward calm so "hold to raise" feels live.
setInterval(() => {
  if (state.energy > 0) { state.energy = Math.max(0, state.energy - 0.01); broadcastState(); }
}, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  JAMARAMA host running`);
  console.log(`  Host screen : http://localhost:${PORT}`);
  console.log(`  Phones join : ${JOIN_URL}\n`);
  startTexture();
});

// --- spawn the MRT2 texture engine as a child so one command runs the whole stack ---
// Disable with NO_TEXTURE=1 (e.g. UI-only testing). It connects back over WS for room
// state and plays to the default audio device (OS-mixed with the browser's band).
let texture = null;
function startTexture() {
  if (process.env.NO_TEXTURE) { console.log("  [texture] disabled (NO_TEXTURE=1)\n"); return; }
  const py = join(__dirname, "../.venv/bin/python");
  const script = join(__dirname, "../engine/texture_engine.py");
  if (!existsSync(py) || !existsSync(script)) {
    console.log("  [texture] engine not found (skipping) — run from repo root with .venv set up\n");
    return;
  }
  console.log("  [texture] starting MRT2 engine (loads model, then streams)…\n");
  texture = spawn(py, [script, `localhost:${PORT}`],
    { cwd: join(__dirname, "../engine"), env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  texture.stdout.on("data", (d) => process.stdout.write(d));               // engine already tags [texture]
  texture.stderr.on("data", (d) => {                                        // filter ML/HF noise
    const s = d.toString();
    if (!/warning|hf_token|tflite|xnnpack|delegate|it\/s|^\s*\d+%/i.test(s)) process.stderr.write("[texture] " + s);
  });
  texture.on("exit", (c) => console.log(`  [texture] engine exited (code ${c})`));
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { texture?.kill("SIGTERM"); process.exit(0); });
process.on("exit", () => texture?.kill("SIGTERM"));
