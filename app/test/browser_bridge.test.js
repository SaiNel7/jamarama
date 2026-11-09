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

test("cloud texture plays in the host browser and fades in after a cold start", { timeout: 90000, skip: !existsSync(CHROME) && "no Chrome" }, async () => {
  const { default: puppeteer } = await import("puppeteer-core");
  const fake = await startFakeTextureServer({ token: "b", readyDelayMs: 4000 });      // 4 s "cold start"
  const gw = await gateway({ TEXTURE_URL: fake.url, TEXTURE_TOKEN: "b" });
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
      ctx: window.Tone.getContext().rawContext.state, fade: window.__jamTexture.fade?.gain.value }));
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
