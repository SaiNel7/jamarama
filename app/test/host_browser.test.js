// Host page robustness in a real browser (headless Chrome through gateway.js): a blocked main
// thread must not dump the missed 16ths as one burst, the crowd count survives state messages,
// and a dropped socket resumes the same host session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function gateway() {
  const port = await freePort();
  const child = spawn(process.execPath, [join(APP, "gateway.js")], {
    cwd: APP, stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT: String(port), MAX_ROOMS: "2", ANTHROPIC_API_KEY: "", TEXTURE_URL: "", TEXTURE_TOKEN: "" },
  });
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((r) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
    if (ok) break; await sleep(100);
  }
  return { port, kill: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); }) };
}

test("host: main-thread stall is skipped silently, crowd count shows, socket drop resumes", { timeout: 90000, skip: !existsSync(CHROME) && "no Chrome" }, async () => {
  const { default: puppeteer } = await import("puppeteer-core");
  const gw = await gateway();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  const phones = [];
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${gw.port}/`, { waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("#start.allready"));
    await page.click("#start");
    await page.waitForFunction(() => window.Tone?.getTransport().state === "started", { timeout: 20000 });
    await sleep(1000);

    // 1) block the main thread for 1.5 s while the AudioContext keeps running
    const before = await page.evaluate(() => ({ ...window.__jamClock }));
    assert.equal(before.stale, 0, "no late steps in normal operation");
    await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 1500); });
    await sleep(600);
    const after = await page.evaluate(() => ({ ...window.__jamClock }));
    const missed = after.stale - before.stale;
    assert.ok(missed >= 6, `the stalled 16ths were advanced silently (${missed})`);
    await sleep(800);
    const later = await page.evaluate(() => ({ ...window.__jamClock }));
    assert.ok(later.steps > after.steps + 3 && later.stale === after.stale, "the clock recovers on time");

    // 2) crowd count: 3 phones → 1 crowd; the count survives the state messages that follow
    const cookie = (await page.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    for (let i = 0; i < 3; i++) phones.push(await new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/`, { headers: { cookie } });
      ws.on("open", () => { ws.send(JSON.stringify({ type: "hello", role: "auto", sid: "ph" + i })); res(ws); });
    }));
    await sleep(300);
    phones[2].send(JSON.stringify({ type: "control", action: "mood", payload: { mood: "brighter" } }));
    await sleep(400);
    assert.equal(await page.$eval("#voting", (e) => e.textContent), "1");

    // 3) the host socket drops → the Bus reconnects with the same session id (same player record)
    const res = await page.evaluate(async () => {
      const bus = window.__jamBus, old = bus.ws, sid = bus.sid, id = bus.id;
      old.close();
      const t = Date.now();
      while ((bus.ws === old || bus.ws?.readyState !== 1 || bus.id == null) && Date.now() - t < 8000) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 300));
      return { reconnected: bus.ws !== old && bus.ws.readyState === 1, sameSid: bus.sid === sid, sameId: bus.id === id };
    });
    assert.ok(res.reconnected, "socket reconnected");
    assert.ok(res.sameSid && res.sameId, "same session → same host record");
    assert.equal(await page.evaluate(() => window.Tone.getTransport().state), "started", "the band never stopped");
  } finally { phones.forEach((w) => w.close()); await browser.close(); await gw.kill(); }
});

