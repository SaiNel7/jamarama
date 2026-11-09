// Room server fan-out: who receives what, how often, and dead-socket reaping (server.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function launch(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(APP, "server.js")], {
    cwd: APP, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), NO_TUNNEL: "1", NO_PREBAKE: "1", NO_TEXTURE: "1", ANTHROPIC_API_KEY: "",
           TEXTURE_URL: "", TEXTURE_TOKEN: "", PUBLIC_URL: `http://127.0.0.1:${port}`, ...env },
  });
  child.log = "";
  child.stdout.on("data", (d) => { child.log += d; });
  child.stderr.on("data", (d) => { child.log += d; });
  for (let i = 0; i < 150; i++) {
    const ok = await new Promise((r) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
    if (ok) break; await sleep(100);
  }
  return { port, child, kill: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); }) };
}
function client(port, role, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, opts);
    const c = { ws, msgs: [], closed: false };
    ws.on("open", () => { ws.send(JSON.stringify({ type: "hello", role, sid: Math.random().toString(36) })); });
    ws.on("message", (d) => { const m = JSON.parse(d); m._at = Date.now(); c.msgs.push(m); if (m.type === "welcome") resolve(c); });
    ws.on("close", () => { c.closed = true; });
    ws.on("error", reject);
  });
}
const send = (c, o) => c.ws.send(JSON.stringify(o));
const of = (c, type) => c.msgs.filter((m) => m.type === type);

test("fan-out: beats only to phones, controls only to the host, bursts of state are coalesced", { timeout: 30000 }, async () => {
  const srv = await launch();
  try {
    const host = await client(srv.port, "host");
    const harmony = await client(srv.port, "auto");
    const lead = await client(srv.port, "auto");
    const crowdA = await client(srv.port, "auto");
    const crowdB = await client(srv.port, "auto");
    assert.equal(crowdA.msgs[0].role, "crowd"); assert.equal(lead.msgs[0].role, "lead");
    send(host, { type: "host", action: "start" });
    await sleep(400);
    for (const c of [host, harmony, lead, crowdA, crowdB]) c.msgs.length = 0;

    // 2 s of the worst realistic burst: two crowd phones holding ENERGY (10 Hz each) + host beats
    const t0 = Date.now();
    let n = 0;
    const timers = [
      setInterval(() => send(crowdA, { type: "control", action: "energy", payload: { delta: 0.01 } }), 100),
      setInterval(() => send(crowdB, { type: "control", action: "energy", payload: { delta: 0.01 } }), 100),
      setInterval(() => { send(host, { type: "beat", bar: n >> 2, beat: n & 3 }); n++; }, 120),
    ];
    await sleep(2000);
    timers.forEach(clearInterval);
    await sleep(300);                                          // let the trailing state flush
    const secs = (Date.now() - t0) / 1000;

    // routing
    assert.equal(of(host, "beat").length, 0, "the host makes its own clock — no beat echo");
    assert.ok(of(harmony, "beat").length >= 14, "phones get every beat");
    assert.equal(of(harmony, "control").length, 0, "phones never get other phones' raw controls");
    assert.ok(of(host, "control").length >= 36, "the host gets every control");
    assert.ok(of(host, "control").every((m) => m.action === "energy" && m.role === "crowd"));

    // coalescing: ~40 state changes in 2 s → ≤ 10 Hz of state messages, the latest state always wins
    const states = of(harmony, "state");
    assert.ok(states.length <= Math.ceil(secs * 10) + 2, `${states.length} state msgs in ${secs}s`);
    assert.ok(states.length >= 10, "state still flows while the burst lasts");
    const gaps = states.slice(1).map((m, i) => m._at - states[i]._at);
    assert.ok(Math.min(...gaps) >= 80, `min gap ${Math.min(...gaps)} ms`);
    const final = states.at(-1).state.energy;
    assert.ok(final > 0.3, `energy accumulated (${final})`);

    // roster rides along only when it changed; crowdCount always
    assert.equal(lead.msgs.find((m) => m.type === "state")?.crowdCount, 2);
    assert.ok(states.every((m) => m.crowdCount === 2), "crowdCount travels with every state");
    assert.ok(states.every((m) => !m.roster), "unchanged roster is not re-sent with every state");
    send(crowdA, { type: "control", action: "profile", payload: { name: "Zed" } });
    await sleep(250);
    const withRoster = of(harmony, "state").filter((m) => m.roster);
    assert.equal(withRoster.length, 1, "a profile change ships the roster once");
    assert.ok(withRoster[0].roster.some((p) => p.name === "Zed"));

    // an isolated change is not delayed (leading edge)
    await sleep(300);
    const before = of(harmony, "state").length;
    const tSend = Date.now();
    send(crowdA, { type: "control", action: "mood", payload: { mood: "darker" } });
    await sleep(60);
    const after = of(harmony, "state").slice(before);
    assert.ok(after.length >= 1 && after[0]._at - tSend < 50, "isolated change goes out immediately");

    // app-level keepalive
    send(harmony, { type: "ping", t: 42 });
    await sleep(100);
    assert.deepEqual(of(harmony, "pong").map((m) => m.t), [42]);
  } finally { await srv.kill(); }
});

test("dead sockets (no pongs) are terminated and the player can resume", { timeout: 20000 }, async () => {
  const srv = await launch({ PING_MS: "300", DEAD_AFTER_MS: "1000" });
  try {
    const host = await client(srv.port, "host");
    const zombie = await client(srv.port, "auto", { autoPong: false });   // a half-open phone
    const alive = await client(srv.port, "auto");
    await sleep(2200);
    assert.ok(zombie.closed, "half-open socket was dropped");
    assert.ok(!alive.closed && !host.closed, "healthy sockets stay up");
    assert.match(srv.child.log, /stopped answering pings/);
    const roster = of(host, "roster").at(-1).roster;
    assert.equal(roster.length, 2, "the dead player left the roster");
  } finally { await srv.kill(); }
});

test("gateway: when every room is taken, an abandoned one (no human input) makes way for a new visitor", { timeout: 30000 }, async () => {
  const port = await freePort();
  const gw = spawn(process.execPath, [join(APP, "gateway.js")], {
    cwd: APP, stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, PORT: String(port), MAX_ROOMS: "1", ABANDON_MIN: String(1.5 / 60), ACTIVITY_REPORT_MS: "300",
           ANTHROPIC_API_KEY: "", TEXTURE_URL: "", TEXTURE_TOKEN: "" },
  });
  let log = ""; gw.stdout.on("data", (d) => { log += d; });
  const visit = () => fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0", accept: "text/html" } });
  try {
    for (let i = 0; i < 100 && !log.includes("Jamarama demo on"); i++) await sleep(100);
    const first = await visit();
    const cookie = first.headers.get("set-cookie").split(";")[0];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { cookie } });   // the first visitor's open tab
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", role: "host", sid: "h1" }));
    const keepBusy = setInterval(() => ws.send(JSON.stringify({ type: "host", action: "groove", payload: { x: 0.5, y: 0.5 } })), 200);
    await sleep(2500);
    assert.equal((await visit()).status, 503, "an ACTIVE room is never evicted");
    clearInterval(keepBusy);
    // the clock keeps running on its own (chord/leadNotes) — that is not a person
    const clock = setInterval(() => ws.send(JSON.stringify({ type: "host", action: "chord", payload: { degree: "I", pcs: [0, 4, 7] } })), 200);
    await sleep(2500);
    const second = await visit();
    clearInterval(clock);
    assert.equal(second.status, 302, "the abandoned room was reclaimed");
    assert.match(log, /abandoned .* reclaiming/);
    ws.close();
  } finally { gw.kill("SIGTERM"); }
});
