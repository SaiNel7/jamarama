// Jamarama public demo gateway (band-only).
//
// server.js keeps one room's state in module globals, so instead of rewriting it this
// gateway gives every visitor their OWN server.js process (a "room") and routes traffic
// to it by cookie:
//   GET /                → (new) room for this browser, then its host screen
//   GET /r/<code>/join   → what the QR encodes; pins a phone to that room, then /join
//   GET /new             → force a fresh room
//   everything else (assets, /info, WebSocket upgrade) → proxied to the cookie's room
// Rooms run with NO_TEXTURE / NO_PREBAKE / NO_TUNNEL (no local Magenta on a cloud box) and are
// reaped once nobody has been connected for IDLE_MIN minutes. If TEXTURE_URL + TEXTURE_TOKEN are
// set (inherited through the env), each room streams its MRT2 texture from the mrt2-cloud GPU
// service. One session per room, opened at jam start, closed when the room ends.
import http from "http";
import net from "net";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, cpSync } from "fs";
import { randomBytes } from "crypto";
import { createStatic } from "./static.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 3000);
const MAX_ROOMS = +(process.env.MAX_ROOMS || 4);
const IDLE_MIN = +(process.env.IDLE_MIN || 10);
const FIRST_ROOM_PORT = 4100;
const COOKIE = "jroom";

// Seed the default instrument samples once, before any room boots (avoids a copy race).
{
  const voices = join(__dirname, "public/voices"), defaults = join(__dirname, "public/voices_default");
  if (!existsSync(join(voices, "manifest.json")) && existsSync(join(defaults, "manifest.json")))
    cpSync(defaults, voices, { recursive: true });
}

// Assets are the same in every room → served here once (compressed + cached) instead of being
// proxied into a room process per request. Only pages, /info and WebSockets reach the rooms.
const ASSET = /^\/(js|css|assets|vendor|voices)\/|^\/lobby\.mp3$|^\/favicon\.ico$/;
const serveAsset = createStatic([
  ["/vendor/tone/", join(__dirname, "node_modules/tone/build")],
  ["/", join(__dirname, "public")],
]);

const rooms = new Map(); // code -> { port, child, conns, lastSeen, ready }

const newCode = () => randomBytes(3).toString("hex").toUpperCase();
function freePort() {
  const used = new Set([...rooms.values()].map((r) => r.port));
  for (let p = FIRST_ROOM_PORT; ; p++) if (!used.has(p)) return p;
}
function publicBase(req) {
  if (process.env.PUBLIC_BASE) return process.env.PUBLIC_BASE.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}
function cookieRoom(req) {
  const m = /(?:^|;\s*)jroom=([A-F0-9]{6})/.exec(req.headers.cookie || "");
  return m && rooms.has(m[1]) ? m[1] : null;
}
const setCookie = (code) => `${COOKIE}=${code}; Path=/; Max-Age=7200; SameSite=Lax`;

function waitForPort(port, ms = 15000) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve(); });
      s.on("error", () => (Date.now() > until ? reject(new Error("room did not start")) : setTimeout(tryOnce, 150)));
    };
    tryOnce();
  });
}

function reapIdle(force = false) {
  const now = Date.now();
  let victim = null;
  for (const [code, r] of rooms) {
    if (r.conns > 0) continue;
    const limit = r.everConnected ? IDLE_MIN * 60000 : 2 * 60000;   // never-used rooms go fast
    if (now - r.lastSeen > limit) { killRoom(code); continue; }
    if (force && (!victim || r.lastSeen < rooms.get(victim).lastSeen)) victim = code;
  }
  if (force && victim && rooms.size >= MAX_ROOMS) killRoom(victim);
}
function killRoom(code) {
  const r = rooms.get(code);
  if (!r) return;
  rooms.delete(code);
  try { r.child.kill(); } catch {}
  console.log(`[gateway] room ${code} closed (${rooms.size} open)`);
}
setInterval(() => reapIdle(false), 30000).unref();

async function createRoom(req) {
  if (rooms.size >= MAX_ROOMS) reapIdle(true);          // evict the stalest empty room if full
  if (rooms.size >= MAX_ROOMS) return null;
  const code = newCode(), port = freePort();
  const child = spawn(process.execPath, [join(__dirname, "server.js")], {
    cwd: __dirname,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT: String(port), PUBLIC_URL: `${publicBase(req)}/r/${code}`,
           NO_TEXTURE: "1", NO_PREBAKE: "1", NO_TUNNEL: "1", DEMO_MODE: "1", ANTHROPIC_API_KEY: "" },
  });
  const room = { port, child, conns: 0, lastSeen: Date.now() };
  rooms.set(code, room);
  child.on("exit", () => { if (rooms.get(code) === room) rooms.delete(code); });
  try { await waitForPort(port); } catch { killRoom(code); return null; }
  console.log(`[gateway] room ${code} on :${port} (${rooms.size} open)`);
  return code;
}

function page(res, status, title, body) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><body style="font:18px/1.5 system-ui,sans-serif;max-width:34em;margin:15vh auto;padding:0 1em">
<h1 style="font-size:1.6em">${title}</h1>${body}</body>`);
}
const redirect = (res, to, code) =>
  res.writeHead(302, { location: to, "cache-control": "no-store", ...(code ? { "set-cookie": setCookie(code) } : {}) }).end();

function proxy(req, res, code) {
  const r = rooms.get(code);
  r.lastSeen = Date.now();
  const up = http.request({ host: "127.0.0.1", port: r.port, method: req.method, path: req.url, headers: req.headers },
    (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
  up.on("error", () => { if (!res.headersSent) page(res, 502, "This jam ended", `<p><a href="/new">Start a new jam</a></p>`); });
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/healthz") return res.writeHead(200).end("ok");
  if (ASSET.test(path) && await serveAsset(req, res)) return;

  const pin = /^\/r\/([A-F0-9]{6})(\/join)?\/?$/.exec(path);   // QR target: /r/<code>/join
  if (pin) {
    if (!rooms.has(pin[1]))
      return page(res, 410, "This jam has ended", `<p>Ask whoever's hosting to open the demo again for a new QR code.</p>`);
    return redirect(res, pin[2] ? "/join" : "/", pin[1]);
  }

  let code = cookieRoom(req);
  if (path === "/new" || (path === "/" && !code)) {
    // Health checks, link unfurlers and crawlers must not spin up a room process.
    const ua = req.headers["user-agent"] || "";
    const isBrowser = /mozilla/i.test(ua) && /text\/html/.test(req.headers.accept || "") && !/bot|crawl|spider|preview|render|uptime|curl|wget/i.test(ua);
    if (!isBrowser) return page(res, 200, "Jamarama", `<p>Open this page in a browser to start a jam.</p>`);
    const fresh = await createRoom(req);
    if (!fresh) return page(res, 503, "All demo rooms are busy",
      `<p>A few people are jamming right now. Try again in a few minutes.</p>`);
    return redirect(res, "/", fresh);
  }
  if (!code) {
    if (path === "/join") return page(res, 410, "No jam to join", `<p>Scan the QR code on the host screen to join a jam.</p>`);
    return page(res, 404, "Not found", `<p><a href="/">Open the Jamarama demo</a></p>`);
  }
  proxy(req, res, code);
});

// WebSockets: splice the raw upgrade through to the room's server.
server.on("upgrade", (req, socket, head) => {
  const code = cookieRoom(req);
  if (!code) return socket.destroy();
  const r = rooms.get(code);
  const up = net.connect(r.port, "127.0.0.1", () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(raw + "\r\n");
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  r.conns++; r.everConnected = true; r.lastSeen = Date.now();
  let closed = false;
  const done = () => { if (closed) return; closed = true; r.conns--; r.lastSeen = Date.now(); up.destroy(); socket.destroy(); };
  up.on("error", done); socket.on("error", done); up.on("close", done); socket.on("close", done);
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`[gateway] Jamarama demo on :${PORT} (max ${MAX_ROOMS} rooms, idle ${IDLE_MIN}m)`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { for (const c of rooms.keys()) killRoom(c); process.exit(0); });
