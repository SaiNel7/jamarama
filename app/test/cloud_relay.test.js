// Cloud texture end-to-end (no GPU): a fake mrt2-cloud streams a sine; the REAL server.js / gateway.js
// open the session at jam start, translate room state, and relay PCM to the host socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import { startFakeTextureServer, pcmHz } from "./fake_texture_server.js";
import { ANCHOR_PROMPT } from "../texture_translate.js";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function waitPort(port, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = await new Promise((r) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
    if (ok) return; await sleep(100);
  }
  throw new Error("port never opened");
}
async function launch(script, env) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(APP, script)], {
    cwd: APP, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), NO_TUNNEL: "1", NO_PREBAKE: "1", NO_TEXTURE: "1",
           ANTHROPIC_API_KEY: "", PUBLIC_URL: `http://127.0.0.1:${port}`, ...env },
  });
  child.log = "";
  child.stdout.on("data", (d) => { child.log += d; });
  child.stderr.on("data", (d) => { child.log += d; });
  await waitPort(port);
  return { port, child, kill: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); }) };
}

/** A host-role socket that records JSON + binary. */
function host(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const h = { ws, json: [], bin: [], binAt: [], firstVoicesAt: 0, wait: null };
    ws.on("open", () => { ws.send(JSON.stringify({ type: "hello", role: "host", sid: "test-host" })); resolve(h); });
    ws.on("message", (d, isBin) => {
      if (isBin) { h.bin.push(Buffer.from(d)); h.binAt.push(Date.now()); return; }
      const m = JSON.parse(d); h.json.push(m);
      if (m.type === "voices" && !h.firstVoicesAt) h.firstVoicesAt = Date.now();
    });
    ws.on("error", reject);
  });
}
async function until(fn, ms = 10000, what = "condition") {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
}
const send = (h, o) => h.ws.send(JSON.stringify(o));
const texStatuses = (h) => h.json.filter((m) => m.type === "texture").map((m) => m.status);

test("server.js: jam start opens a cloud session, conditioning follows the room, PCM reaches the host", { timeout: 60000 }, async () => {
  const fake = await startFakeTextureServer({ token: "s3cret", readyDelayMs: 1200 });
  const srv = await launch("server.js", { TEXTURE_URL: fake.url, TEXTURE_TOKEN: "s3cret" });
  try {
    const info = await (await fetch(`http://127.0.0.1:${srv.port}/info`)).json();
    assert.equal(info.texture, "standby"); assert.equal(info.textureSource, "cloud");
    const h = await host(`ws://127.0.0.1:${srv.port}`);
    await until(() => texStatuses(h).includes("standby"), 3000, "standby status");
    await until(() => fake.healthz >= 1, 3000, "lobby prewarm hit /healthz");
    assert.equal(fake.sessions.length, 0, "no GPU session during the lobby");

    send(h, { type: "host", action: "start" });
    const s = await until(() => fake.sessions[0]?.msgs.find((m) => m.type === "start") && fake.sessions[0], 5000, "start msg");
    const start = s.msgs[0];
    assert.equal(s.auth, "Bearer s3cret");
    assert.equal(start.format, "pcm16"); assert.equal(start.sample_rate, 48000);
    const w = Object.fromEntries(start.style.prompts.map((p) => [p.text, p.weight]));
    assert.ok(Math.abs(w[ANCHOR_PROMPT] - 0.72) < 1e-6, "ambient anchor weight");
    assert.deepEqual(start.notes.map((v, i) => (v >= 0 ? [i, v] : null)).filter(Boolean), [[69, 2], [73, 2], [76, 2]]);
    assert.deepEqual({ g: start.params.gain, cn: start.params.cfg_notes, d: start.params.drums, p: start.params.preset },
      { g: 0.5, cn: 3.0, d: 0, p: "jamarama_texture" });

    // band is not gated on the GPU: default voices arrive before the texture is live
    await until(() => h.firstVoicesAt, 3000, "voices");
    await until(() => texStatuses(h).includes("live"), 6000, "live");
    const liveMsg = h.json.find((m) => m.type === "texture" && m.status === "live");
    assert.ok(h.firstVoicesAt < Date.now() && texStatuses(h).indexOf("warming") < texStatuses(h).indexOf("live"));
    assert.equal(liveMsg.prebufferMs, 320);
    await until(() => h.bin.length >= 40, 5000, "PCM frames");
    assert.ok(h.bin.every((b) => b.length === 7680), "40 ms int16 stereo frames");
    assert.ok(Math.abs(pcmHz(h.bin.slice(5, 35)) - 440) < 15, `A4 from the I chord, got ${pcmHz(h.bin.slice(5, 35))}`);

    // chord change → onset notes, then sustained 480 ms later; relayed audio follows
    send(h, { type: "host", action: "chord", payload: { degree: "IV", pcs: [2, 6, 9] } });
    const held = (m) => m.notes.map((v, i) => (v >= 0 ? [i, v] : null)).filter(Boolean);
    // (the I chord's own onset → sustained release may precede these; look at the IV messages)
    const notesMsgs = await until(() => { const n = s.msgs.filter((m) => m.type === "notes" && m.notes[62] >= 0); return n.length >= 2 && n; }, 3000, "notes");
    assert.deepEqual(held(notesMsgs[0]), [[62, 2], [66, 2], [69, 2]]);
    assert.deepEqual(held(notesMsgs[1]), [[62, 3], [66, 3], [69, 3]]);
    const mark = h.bin.length;
    await until(() => h.bin.length >= mark + 40, 4000, "post-chord frames");
    assert.ok(Math.abs(pcmHz(h.bin.slice(mark + 15, mark + 40)) - 293.7) < 15, "D4 after re-root");

    // lead wakes up → lead-mode params
    send(h, { type: "host", action: "leadNotes", payload: { active: true, pitches: [76, 79] } });
    const p = await until(() => s.msgs.find((m) => m.type === "params" && m.cfg_notes === 4.5), 3000, "lead params");
    assert.equal(p.gain, 0.6); assert.equal(p.cfg_musiccoca, 4.0);

    // memory: the room process stays small while relaying
    const rssKb = +execSync(`ps -o rss= -p ${srv.child.pid}`).toString().trim();
    console.log(`  room process RSS while streaming: ${(rssKb / 1024).toFixed(0)} MB`);
    assert.ok(rssKb < 150 * 1024);

    // host leaves → session closed after the 6 s reload grace
    h.ws.close();
    await until(() => s.closed, 10000, "session close");
    assert.ok(s.msgs.some((m) => m.type === "stop"));
  } finally { await srv.kill(); await fake.close(); }
});

test("server.js: rejected or unreachable cloud → band only (failed status, no PCM, voices still arrive)", { timeout: 30000 }, async () => {
  const fake = await startFakeTextureServer({ token: "right" });
  const port = await freePort();                                        // nothing listens here
  for (const env of [{ TEXTURE_URL: fake.url, TEXTURE_TOKEN: "wrong" },
                     { TEXTURE_URL: `http://127.0.0.1:${port}`, TEXTURE_TOKEN: "x", TEXTURE_RETRIES: "0" }]) {
    const srv = await launch("server.js", env);
    try {
      const h = await host(`ws://127.0.0.1:${srv.port}`);
      send(h, { type: "host", action: "start" });
      await until(() => h.firstVoicesAt, 3000, "voices");
      await until(() => texStatuses(h).includes("failed"), 8000, "failed status");
      await sleep(300);
      assert.equal(h.bin.length, 0);
      const info = await (await fetch(`http://127.0.0.1:${srv.port}/info`)).json();
      assert.equal(info.texture, "failed");
    } finally { await srv.kill(); }
  }
  await fake.close();
});

test("server.js: not configured → texture off, no cloud traffic", { timeout: 20000 }, async () => {
  const srv = await launch("server.js", { TEXTURE_URL: "", TEXTURE_TOKEN: "" });
  try {
    const info = await (await fetch(`http://127.0.0.1:${srv.port}/info`)).json();
    assert.equal(info.texture, "off");
    const h = await host(`ws://127.0.0.1:${srv.port}`);
    await until(() => texStatuses(h).length, 3000, "status");
    assert.deepEqual(texStatuses(h), ["off"]);
  } finally { await srv.kill(); }
});

function newRoom(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/", headers: { "user-agent": "Mozilla/5.0 test", accept: "text/html" } }, (res) => {
      res.resume();
      const m = /jroom=([A-F0-9]{6})/.exec(res.headers["set-cookie"]?.[0] || "");
      m ? resolve(m[1]) : reject(new Error(`no room (status ${res.statusCode})`));
    }).on("error", reject);
  });
}

test("gateway: each visitor room gets its own cloud session; audio never crosses rooms", { timeout: 60000 }, async () => {
  const fake = await startFakeTextureServer({ token: "gw", pitchFrom: "session", baseHz: 220 });
  const gw = await launch("gateway.js", { TEXTURE_URL: fake.url, TEXTURE_TOKEN: "gw", MAX_ROOMS: "3" });
  try {
    const [a, b] = [await newRoom(gw.port), await newRoom(gw.port)];
    assert.notEqual(a, b);
    const ha = await host(`ws://127.0.0.1:${gw.port}`, { cookie: `jroom=${a}` });
    send(ha, { type: "host", action: "start" });
    await until(() => fake.sessions.length === 1, 5000, "room A session");
    const hb = await host(`ws://127.0.0.1:${gw.port}`, { cookie: `jroom=${b}` });
    send(hb, { type: "host", action: "start" });
    await until(() => fake.sessions.length === 2, 5000, "room B session");
    await until(() => ha.bin.length > 40 && hb.bin.length > 40, 6000, "both rooms streaming");
    const fa = pcmHz(ha.bin.slice(-25)), fb = pcmHz(hb.bin.slice(-25));
    assert.ok(Math.abs(fa - 220) < 10 && Math.abs(fb - 440) < 10, `room A ${fa} Hz, room B ${fb} Hz`);
    assert.equal(fake.sessions[0].auth, "Bearer gw");
    // closing room A's host ends ONLY room A's session
    ha.ws.close();
    await until(() => fake.sessions[0].closed, 10000, "room A session closed");
    assert.equal(fake.sessions[1].closed, null);
    const n = hb.bin.length; await sleep(500); assert.ok(hb.bin.length > n, "room B keeps streaming");
    hb.ws.close();
  } finally { await gw.kill(); await fake.close(); }
});
