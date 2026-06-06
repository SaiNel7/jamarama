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
import { existsSync, readFileSync } from "fs";
import QRCode from "qrcode";
import { transformPrompts, voicePrompts } from "./taste.js";

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
// Join URL resolution (phones often sit on networks that block device-to-device, e.g. eduroam):
//   1. PUBLIC_URL env — explicit override, used as-is.
//   2. cloudflared quick tunnel — spawned automatically at startup (the default);
//      `base` flips to the tunnel URL once it's up. Disable with NO_TUNNEL=1.
//   3. LAN IP — immediate fallback, and the final answer if cloudflared is missing/offline.
let base = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, "") : `http://${IP}:${PORT}`;
const joinUrl = () => `${base}/join`;
// True while we're still waiting on the cloudflared URL — the host page shows a
// "creating link…" state instead of ever flashing the LAN address.
let tunnelPending = !process.env.PUBLIC_URL && !process.env.NO_TUNNEL;

// --- room state (single room for the demo) ---
const ROLE_COLORS = {
  groove: "#F5B82E", harmony: "#1BA88A", lead: "#F4533A", crowd: "#9B7BE6",
};
const state = {
  phase: "lobby",                   // "lobby" (pre-jam onboarding) | "jam" (host started)
  room: "BASEMENT SESSIONS",
  key: "A", scale: "major",
  tempo: 124,
  bar: 0, beat: 0,
  chord: "I",                       // current harmony degree (roman numeral)
  progression: ["I", "IV", "V", "vi"],
  progressionChords: [],            // [{label, notes:[midi]}] — voicing for swapped/non-diatonic chords
  palette: [],                      // harmony wheel nodes [{roman, display}] — host mirrors the wheel
  schedule: [],                     // 16 beat-slots: chord on each beat of the fixed 4-bar loop
  taste: ["warm ambient pads", "cinematic texture"], // blended taste → MRT2 style embedding
  energy: 0.0,                      // crowd collective energy 0..1
  mood: { brighter: 0, heavier: 0, dreamier: 0, darker: 0 },
  recentMoods: [],                 // [{mood, t}]
  groove: { x: 0.5, y: 0.5 },      // host X/Y pad
};

// --- clients ---
let nextId = 1;
const clients = new Map(); // id -> { ws, role, color, id }

// Avatar pool (images in public/assets/pfps). Avatars are EXCLUSIVE: each player
// holds at most one, a claim for a taken one is rejected, and disconnecting frees
// it (the client simply leaves the map — taken-ness is always derived live).
const AVATARS = ["pickle", "duck", "frog", "dog", "cat", "rocker", "alien", "cow", "pig", "rasta", "cantor", "baba"];
function takenAvatars(exceptId = null) {
  return new Set([...clients.values()].filter((c) => c.id !== exceptId && c.avatar).map((c) => c.avatar));
}
function randomAvatar() {
  const taken = takenAvatars();
  const free = AVATARS.filter((a) => !taken.has(a));
  return free.length ? free[Math.floor(Math.random() * free.length)] : "";
}

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
    .map((c) => ({ id: c.id, role: c.role, color: c.color,
                   name: c.name, avatar: c.avatar, ready: c.ready, taste: c.taste }));
}
function crowdCount() {
  return [...clients.values()].filter((c) => c.role === "crowd").length;
}
function hostCount() {
  return [...clients.values()].filter((c) => c.role === "groove").length;
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
    // cf-connecting-ip = the phone's real IP when the request comes through the
    // cloudflare tunnel (otherwise everything logs as the tunnel's 127.0.0.1).
    console.log(`  HTTP ${req.method} ${req.path} ← ${req.headers["cf-connecting-ip"] || req.ip}`);
  next();
});
app.use(express.static(join(__dirname, "public")));
// serve Tone.js locally (works offline on the LAN)
app.use("/vendor/tone", express.static(join(__dirname, "node_modules/tone/build")));

app.get("/", (_req, res) => res.sendFile(join(__dirname, "public/host.html")));
app.get("/join", (_req, res) => res.sendFile(join(__dirname, "public/join.html")));
app.get("/info", async (_req, res) => {
  const ju = joinUrl();   // re-read every request: flips to the tunnel URL once it's up
  res.json({ ip: IP, port: PORT, joinUrl: ju, pending: tunnelPending,
             qr: await QRCode.toDataURL(ju, { margin: 1, width: 320 }) });
});

// Pre-bake the host's two voices (harmony + lead) from a taste prompt → Tone.Sampler one-shots
// under public/voices/ (served statically). Offline MRT2 render (engine/prebake_voices.py), ~7s.
// Triggered automatically on jam start with prompts derived from the players' raw taste
// prompts (voicePrompts in taste.js); the host is told via a `voices` broadcast and swaps
// its synths for the baked samplers. GET /prebake remains for manual testing/re-bakes.
let prebaking = false;
function runPrebake(harmony, lead) {
  return new Promise((resolve, reject) => {
    if (prebaking) return reject(new Error("prebake already running"));
    const py = join(__dirname, "../.venv/bin/python");
    const script = join(__dirname, "../engine/prebake_voices.py");
    if (!existsSync(py) || !existsSync(script)) return reject(new Error("prebake engine not found"));
    prebaking = true;
    console.log(`  [prebake] harmony="${harmony}" lead="${lead}" …`);
    const child = spawn(py, [script, "--harmony", harmony, "--lead", lead, "--out", join(__dirname, "public/voices")],
      { cwd: join(__dirname, "../engine") });
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { prebaking = false; reject(e); });
    child.on("exit", (code) => {
      prebaking = false;
      if (code !== 0) return reject(new Error(`prebake failed (code ${code}): ${err.slice(-400)}`));
      try { resolve(JSON.parse(readFileSync(join(__dirname, "public/voices/manifest.json"), "utf8"))); }
      catch { reject(new Error("manifest read failed")); }
      console.log("  [prebake] done");
    });
  });
}
app.get("/prebake", (req, res) => {
  const harmony = String(req.query.harmony || "warm analog synth pad, mellow").slice(0, 200);
  const lead = String(req.query.lead || "bright expressive lead synth").slice(0, 200);
  runPrebake(harmony, lead)
    .then((manifest) => res.json(manifest))
    .catch((e) => res.status(e.message.includes("already running") ? 409 : 500).json({ error: e.message }));
});

// Jam start → bake the harmony/lead voices from everyone's raw taste prompts, then tell
// the host to swap them in ("default voice instant, personalized swaps in" — spec §invariants).
async function prebakeFromTastes() {
  const { harmony, lead } = voicePrompts(playerTastes());
  try {
    const manifest = await runPrebake(harmony, lead);
    broadcast({ type: "voices", manifest });
    console.log("  [prebake] taste voices ready — host notified");
  } catch (e) {
    console.log(`  [prebake] skipped (${e.message}) — host keeps the built-in synths`);
  }
}

const server = createServer(app);

// --- WebSocket ---
// Session resume: phones send a stable `sid` in hello. Flaky links (cellular through
// the cloudflare tunnel) drop + auto-reconnect constantly; without this every
// reconnect minted a NEW player (new id/name, profile + ready wiped) and churned the
// roster. With it, a reconnect reclaims the same player record — id, role, name,
// avatar, taste, ready all survive.
const sessions = new Map(); // sid -> player record (latest, incl. disconnected)
const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  let id = null;
  const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress; // real phone IP through the tunnel

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "hello": {
        const sid = typeof msg.sid === "string" ? msg.sid.slice(0, 64) : null;
        const prev = sid ? sessions.get(sid) : null;
        let c;
        if (prev) {
          // Reclaim: kick any zombie socket still holding this player, keep the identity.
          const live = clients.get(prev.id);
          if (live && live.ws !== ws) { try { live.ws.terminate(); } catch {} }
          c = { ...prev, ws };
          id = c.id;
          clients.set(id, c);
          console.log(`+ ${c.role} #${id} resumed (${ip}) (${clients.size} connected)`);
        } else {
          id = nextId++;
          const role = (msg.role === "host" || msg.role === "texture") ? (msg.role === "host" ? "groove" : "texture") : assignRole();
          // Lobby/onboarding fields: name + avatar set via control:profile, taste +
          // ready via control:ready. Host and texture count as always-ready.
          const isPlayer = role !== "groove" && role !== "texture";
          c = { ws, id, role, color: ROLE_COLORS[role],
                name: isPlayer ? `PLAYER ${id}` : role.toUpperCase(),
                avatar: isPlayer ? randomAvatar() : "", taste: "", ready: !isPlayer };
          clients.set(id, c);
          console.log(`+ ${c.role} #${id} (${ip}) (${clients.size} connected)`);
        }
        if (sid) sessions.set(sid, c);
        send(ws, { type: "welcome", id, role: c.role, color: c.color, state, roster: roster(), crowdCount: crowdCount() });
        broadcast({ type: "roster", roster: roster(), crowdCount: crowdCount() }, id);
        if (c.role === "groove") onHostConnect();   // host tab opened → bring the texture engine up
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
        if (msg.action === "start" && state.phase === "lobby") {   // lobby → jam (host UI gates this on all-players-ready)
          state.phase = "jam";
          const players = roster().filter((p) => p.role !== "groove");
          console.log(`  [lobby] host started the jam (${players.filter((p) => p.ready).length}/${players.length} players ready)`);
          recomputeTaste();                                        // async; broadcasts again when transforms land
          prebakeFromTastes();                                     // async; `voices` broadcast when the bake lands
        }
        broadcastState();
        break;
      }
    }
  });

  ws.on("close", () => {
    // Only tear down if WE still own the player — a resumed connection replaces the
    // record's ws, and the old socket's late close must not delete the new one.
    if (id == null || clients.get(id)?.ws !== ws) return;
    const c = clients.get(id);
    clients.delete(id);
    console.log(`- ${c?.role} #${id} (${clients.size} connected)`);
    broadcast({ type: "roster", roster: roster(), crowdCount: crowdCount() });
    // A leaving player's prompt leaves the blend — but only if they're really gone.
    // Flaky links resume within ~1s (same id); without the grace window every blip
    // would yank their prompt out of the texture conditioning and morph the bed.
    if (c?.taste) setTimeout(() => { if (!clients.has(id)) recomputeTaste(); }, 3000);
    if (c?.role === "groove" && hostCount() === 0) onHostGone();  // last host tab closed → stop the engine
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
      // additive: per-step chord {label, notes:[midi]} so swapped/non-diatonic chords
      // can be voiced from notes (host can read this when integrating arbitrary chords).
      if (payload.chords) state.progressionChords = payload.chords;
      // additive: 16-beat schedule (chord playing on each beat of the fixed 4-bar loop).
      // Host plays state.schedule[(bar*4+beat) % 16] each beat for sub-bar chord durations.
      if (payload.schedule) state.schedule = payload.schedule;
      break;
    case "palette":        // harmony wheel nodes [{roman, display}] → host mirrors the wheel
      state.palette = payload.nodes;
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
    case "profile": {      // lobby: name + avatar (avatar claims are exclusive — a
      const c = clients.get(id);                 // claim for one another player holds is silently
      if (!c) break;                             // rejected; the roster echo corrects the phone)
      if (typeof payload.name === "string") c.name = payload.name.trim().slice(0, 24) || c.name;
      if (typeof payload.avatar === "string" && AVATARS.includes(payload.avatar)
          && !takenAvatars(id).has(payload.avatar)) c.avatar = payload.avatar;
      break;
    }
    case "ready": {        // lobby: ready toggle + optional taste prompt ("" = vibe with the blend)
      const c = clients.get(id);
      if (!c) break;
      c.ready = Boolean(payload.ready);
      if (typeof payload.taste === "string") c.taste = payload.taste.trim().slice(0, 200);
      recomputeTaste();    // async; broadcasts when transforms land
      break;
    }
  }
}

// Every player's raw (untransformed) taste prompt — feeds both the texture blend
// (transformed) and the one-shot voice prebake (raw, keeps genre identity).
function playerTastes() {
  return [...clients.values()]
    .filter((c) => c.role !== "texture" && c.role !== "groove" && c.taste)
    .map((c) => c.taste);
}

// Blend every player's taste prompt into state.taste (the MRT2 style conditioning).
// Transforms run through app/taste.js (TASTE_MODE=append|llm); falls back to the
// default bed when nobody wrote anything. Guarded against out-of-order async
// completions so a slow LLM call can't clobber a newer recompute.
const DEFAULT_TASTE = [...state.taste];
let tasteGen = 0;
async function recomputeTaste() {
  const prompts = playerTastes();
  const gen = ++tasteGen;
  const next = prompts.length ? await transformPrompts(prompts) : DEFAULT_TASTE;
  if (gen !== tasteGen) return; // a newer recompute superseded this one
  state.taste = next;
  console.log(`  [taste] blend → ${JSON.stringify(next)}`);
  broadcastState();
}

// Crowd energy decays slowly toward calm so "hold to raise" feels live.
setInterval(() => {
  if (state.energy > 0) { state.energy = Math.max(0, state.energy - 0.01); broadcastState(); }
}, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  JAMARAMA host running`);
  console.log(`  Host screen : http://localhost:${PORT}`);
  console.log(`  Phones join : ${tunnelPending ? "(starting cloudflare tunnel…)" : joinUrl()}`);
  startTunnel();
  // The texture engine is now started on demand when the host tab connects (onHostConnect)
  // and stopped when the last host tab closes — so MRT2 never runs without a host present.
});

// --- cloudflared quick tunnel (default join path — works from any network) ---
// Spawned at startup unless PUBLIC_URL is set or NO_TUNNEL=1. The QR/banner start
// on the LAN URL and flip to https://<random>.trycloudflare.com when the tunnel
// connects (~2-5s); the host page re-polls /info so its QR updates itself. If
// cloudflared is missing or there's no internet, we just stay on the LAN URL.
let tunnel = null;
function startTunnel() {
  if (process.env.PUBLIC_URL) return;                                       // explicit override wins
  if (process.env.NO_TUNNEL) { console.log("  [tunnel] disabled (NO_TUNNEL=1)\n"); return; }
  const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`]);
  tunnel = child;
  const sniff = (d) => {                                                    // cloudflared logs to stderr
    const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      base = m[0];
      tunnelPending = false;
      console.log(`\n  [tunnel] phones join : ${joinUrl()}  (QR updated)\n`);
    }
  };
  child.stderr.on("data", sniff);
  child.stdout.on("data", sniff);
  child.on("error", () => {
    tunnelPending = false;   // no tunnel coming — host page falls back to showing the LAN URL
    console.log(`  [tunnel] cloudflared not found — phones join on the LAN: ${joinUrl()} (brew install cloudflared)\n`);
  });
  child.on("exit", (c) => {
    if (tunnel === child) tunnel = null;
    tunnelPending = false;
    if (!process.env.PUBLIC_URL) base = `http://${IP}:${PORT}`;
    if (c) console.log(`  [tunnel] exited (code ${c}) — phones join on the LAN: ${joinUrl()}\n`);
  });
}

// --- spawn the MRT2 texture engine as a child so one command runs the whole stack ---
// Disable with NO_TEXTURE=1 (e.g. UI-only testing). It connects back over WS for room
// state and plays to the default audio device (OS-mixed with the browser's band).
let texture = null;            // current MRT2 child process (null when not running)
let textureGrace = null;       // pending shutdown timer (grace window for host reloads)

// Host tab connected → start the engine; cancel any pending shutdown from a quick reload.
function onHostConnect() {
  if (textureGrace) { clearTimeout(textureGrace); textureGrace = null; }
  startTexture();
}
// Last host tab closed → stop the engine, but wait out a grace window first so a page
// reload (close immediately followed by reconnect) doesn't thrash a full model reload.
function onHostGone() {
  if (textureGrace) clearTimeout(textureGrace);
  textureGrace = setTimeout(() => { textureGrace = null; stopTexture(); }, 6000);
}

function startTexture() {
  if (texture) return;                                                      // already running (idempotent)
  if (process.env.NO_TEXTURE) { console.log("  [texture] disabled (NO_TEXTURE=1)\n"); return; }
  const py = join(__dirname, "../.venv/bin/python");
  const script = join(__dirname, "../engine/texture_engine.py");
  if (!existsSync(py) || !existsSync(script)) {
    console.log("  [texture] engine not found (skipping) — run from repo root with .venv set up\n");
    return;
  }
  console.log("  [texture] host present — starting MRT2 engine (loads model, then streams)…\n");
  const child = spawn(py, [script, `localhost:${PORT}`],
    { cwd: join(__dirname, "../engine"), env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  texture = child;
  child.stdout.on("data", (d) => process.stdout.write(d));                  // engine already tags [texture]
  child.stderr.on("data", (d) => {                                          // filter ML/HF noise
    const s = d.toString();
    if (!/warning|hf_token|tflite|xnnpack|delegate|it\/s|^\s*\d+%/i.test(s)) process.stderr.write("[texture] " + s);
  });
  // Only clear `texture` if THIS child is still the current one (avoids a late exit from an
  // old process wiping a freshly-spawned one).
  child.on("exit", (c) => { if (texture === child) texture = null; console.log(`  [texture] engine exited (code ${c})`); });
}
// Stop the engine when no host is connected. The child's exit handler clears `texture`.
function stopTexture() {
  if (!texture) return;
  console.log("  [texture] no host connected — stopping engine\n");
  texture.kill("SIGTERM");
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { texture?.kill("SIGTERM"); tunnel?.kill("SIGTERM"); process.exit(0); });
process.on("exit", () => { texture?.kill("SIGTERM"); tunnel?.kill("SIGTERM"); });
