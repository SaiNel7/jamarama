// Full relay into the BROWSER: fake mrt2-cloud → gateway → room server.js → headless Chrome host page
// → texture_bridge.js → WebAudio (textureBus). Also checks the band starts before the GPU is ready
// (cold start) and the demo note only says "band only" when the texture is really off.
// Needs Chrome (CHROME_PATH or /usr/bin/google-chrome); skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startFakeTextureServer } from "./fake_texture_server.js";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function gateway(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(APP, "gateway.js")], {
    cwd: APP, stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT: String(port), MAX_ROOMS: "2", ANTHROPIC_API_KEY: "", ...env },
  });
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((r) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
    if (ok) break; await sleep(100);
  }
  return { port, kill: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); }) };
}

async function openHost(browser, port) {
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#start", { visible: true });
  await page.waitForFunction(() => document.getElementById("demo-note"), { timeout: 10000 });
  return { page, logs };
}
const noteState = (page) => page.$eval("#demo-note", (el) => ({ tex: el.dataset.texture, text: el.textContent }));

for (const fmt of ["opus", "pcm16"])
test(`cloud texture (${fmt}) plays in the host browser and fades in after a cold start`, { timeout: 90000, skip: !existsSync(CHROME) && "no Chrome" }, async () => {
  const { default: puppeteer } = await import("puppeteer-core");
  const fake = await startFakeTextureServer({ token: "b", readyDelayMs: 4000 });      // 4 s "cold start"
  const gw = await gateway({ TEXTURE_URL: fake.url, TEXTURE_TOKEN: "b", ...(fmt === "pcm16" ? { TEXTURE_FORMAT: "pcm16" } : {}) });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  try {
    const { page, logs } = await openHost(browser, gw.port);
    let n = await noteState(page);
    assert.equal(n.tex, "cloud:standby");
    assert.match(n.text, /streams from a cloud GPU and fades in/);
    assert.doesNotMatch(n.text, /band only/);

    await page.click("#start");                                   // a real user gesture → Tone.start()
    // the band starts on the default voices while the GPU is still "cold"
    await page.waitForFunction(() => window.Tone?.getTransport().state === "started", { timeout: 15000 });
    const chunksAtBandStart = await page.evaluate(() => window.__jamTexture.stats.chunks);
    assert.equal(chunksAtBandStart, 0, "band must not wait for the texture");

    await page.waitForFunction(() => window.__jamTexture.stats.chunks > 75, { timeout: 20000 });
    const st = await page.evaluate(() => ({ ...window.__jamTexture.stats, lead: window.__jamTexture.leadSec,
      ctx: window.Tone.getContext().rawContext.state, fade: window.__jamTexture.fade?.gain.value,
      format: window.__jamTexture.format }));
    assert.equal(fake.sessions[0].msgs[0].format, fmt, "the room asked the GPU for what this browser can decode");
    assert.equal(st.format, fmt);
    const mbPerMin = st.bytes / 1e6 / (st.seconds / 60);
    console.log(`  texture ${fmt}: ${mbPerMin.toFixed(2)} MB/min to the browser`);
    assert.ok(fmt === "opus" ? mbPerMin < 1.5 : mbPerMin > 10, `${fmt} bytes/min ${mbPerMin}`);
    assert.equal(st.decodeErrors, 0);
    assert.equal(st.ctx, "running");
    assert.ok(st.lastRms > 0.1, `decoded PCM is the sine (rms ${st.lastRms})`);
    assert.equal(st.fades, 1, "one fade-in when the stream started");
    assert.ok(st.lead >= 0.44 - 1e-9, "jitter buffer follows the cloud's prebuffer advice (+ relay margin)");
    assert.ok(st.underruns <= 2, `underruns ${st.underruns}`);
    assert.ok(logs.some((l) => l.includes("[texture] cloud GPU live")));
    n = await noteState(page);
    assert.equal(n.tex, "cloud:live");
    assert.match(n.text, /streams live from a cloud GPU/);
    await sleep(3200);                                            // past the 3 s fade
    const fade = await page.evaluate(() => window.__jamTexture.fade.gain.value);
    assert.ok(fade > 0.99, `faded in fully (gain ${fade})`);
    await page.close();
    await sleep(7000);                                            // reload grace → session released
    assert.ok(fake.sessions[0].closed, "closing the tab released the GPU session");
  } finally { await browser.close(); await gw.kill(); await fake.close(); }
});

test("demo note says band only when the texture really is off / failed", { timeout: 60000, skip: !existsSync(CHROME) && "no Chrome" }, async () => {
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--mute-audio"] });
  const fake = await startFakeTextureServer({ token: "right" });
  try {
    for (const [env, expect] of [[{}, "none:off"], [{ TEXTURE_URL: fake.url, TEXTURE_TOKEN: "wrong" }, "cloud:failed"]]) {
      const gw = await gateway(env);
      try {
        const { page } = await openHost(browser, gw.port);
        await page.click("#start");
        await page.waitForFunction((e) => document.getElementById("demo-note")?.dataset.texture === e, { timeout: 15000 }, expect);
        const n = await noteState(page);
        assert.match(n.text, /band only/);
        await page.close();
      } finally { await gw.kill(); }
    }
  } finally { await browser.close(); await fake.close(); }
});

test("jitter buffer: an underrun grows the buffer, edges are faded, a long gap fades back in", { timeout: 60000, skip: !existsSync(CHROME) && "no Chrome" }, async () => {
  const { default: puppeteer } = await import("puppeteer-core");
  const gw = await gateway({});
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${gw.port}/`, { waitUntil: "load" });
    const r = await page.evaluate(async () => {
      const { TextureBridge } = await import("/js/texture_bridge.js");
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      const b = new TextureBridge({ ctx: () => ctx, connect: (n) => { n.connect(ctx.destination); return true; } });
      b.setPrebuffer(200);
      const frame = () => { const a = new Int16Array(1920 * 2); for (let i = 0; i < a.length; i++) a[i] = Math.round(8000 * Math.sin(i / 7)); return a.buffer; };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const feed = async (n) => { for (let i = 0; i < n; i++) { b.push(frame()); await sleep(40); } };
      await feed(15);
      const lead0 = b.leadSec, under0 = b.stats.underruns;
      await sleep(900);                              // network stall longer than the buffer → underrun
      await feed(10);
      const afterStall = { lead: b.leadSec, under: b.stats.underruns, fades: b.stats.fades };
      await sleep(2300);                             // the stream went away → next audio fades in again
      await feed(5);
      return { lead0, under0, afterStall, fades: b.stats.fades, lead: b.leadSec, gapVal: b.gap.gain.value };
    });
    assert.equal(r.under0, 0);
    assert.equal(r.afterStall.under, 1, "one underrun");
    assert.ok(Math.abs(r.afterStall.lead - (r.lead0 + 0.1)) < 1e-9, `buffer grew 100 ms (${r.lead0} → ${r.afterStall.lead})`);
    assert.equal(r.afterStall.fades, 1, "a short stall is not a fresh fade-in");
    assert.equal(r.fades, 2, "a long gap fades the bed back in");
    assert.ok(Math.abs(r.lead - r.lead0) < 1e-9, "a fresh stream starts from the advised buffer again");
  } finally { await browser.close(); await gw.kill(); }
});
