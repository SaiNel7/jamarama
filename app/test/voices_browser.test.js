// Instrument-sample delivery in a real browser (headless Chrome through gateway.js):
// lobby pre-fetch → START is a decode, versioned + immutable-cached URLs, lossless FLAC twins,
// first variation first and the rest joining in the background.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function gateway(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(APP, "gateway.js")], {
    cwd: APP, stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT: String(port), MAX_ROOMS: "2", ANTHROPIC_API_KEY: "", TEXTURE_URL: "", TEXTURE_TOKEN: "", ...env },
  });
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((r) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
    if (ok) break; await sleep(100);
  }
  return { port, kill: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); }) };
}

test("default voices: pre-fetched in the lobby as FLAC, cached by version, bit-identical to the WAVs", { timeout: 120000, skip: !existsSync(CHROME) && "no Chrome" }, async () => {
  const manifest = JSON.parse(readFileSync(join(APP, "public/voices_default/manifest.json"), "utf8"));
  assert.equal(manifest.flac, true, "default kit ships FLAC twins");
  const { default: puppeteer } = await import("puppeteer-core");
  const gw = await gateway();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  try {
    const page = await browser.newPage();
    const logs = [], reqs = [];
    page.on("console", (m) => logs.push(m.text()));
    page.on("response", (r) => { if (r.url().includes("/voices/")) reqs.push({ url: r.url(), cc: r.headers()["cache-control"], cached: r.fromCache() }); });
    await page.goto(`http://127.0.0.1:${gw.port}/`, { waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("#start.allready"));
    // 1) the lobby pre-fetches the samples (versioned FLAC URLs, cached immutable)
    const t = Date.now();
    while (!logs.some((l) => l.includes("[voices] pre-fetched")) && Date.now() - t < 30000) await sleep(100);
    assert.ok(logs.some((l) => l.includes("[voices] pre-fetched")), "lobby pre-fetch ran");
    const pre = reqs.filter((r) => !r.url.includes("manifest.json"));
    assert.ok(pre.length >= 89, `prefetched ${pre.length} samples`);
    assert.ok(pre.every((r) => /\.flac\?v=/.test(r.url)), "FLAC, versioned");
    assert.ok(pre.every((r) => /immutable/.test(r.cc || "")), "immutable cache headers");

    // 2) START → the band comes in from the HTTP cache (no sample re-downloaded)
    reqs.length = 0;
    await page.click("#start");
    await page.waitForFunction(() => window.Tone?.getTransport().state === "started", { timeout: 20000 });
    const started = reqs.filter((r) => !r.url.includes("manifest.json"));
    assert.ok(started.length > 0 && started.every((r) => r.cached), "samples served from cache on START");

    // 3) the loader: first variation now, the rest join in the background; URLs are stable
    const r = await page.evaluate(async () => {
      const m = await import("/js/voices.js");
      const v = await m.loadVoices("/voices/");
      const atFirst = { lead: v.lead.samplers.length, bass: v.bass.samplers.length, harmony: v.harmony.samplers.length };
      v.lead.volume.value = -9;
      await v.more;
      return { atFirst, lead: v.lead.samplers.length, bass: v.bass.samplers.length,
               vols: v.lead.samplers.map((s) => Math.round(s.volume.value)), drums: Object.keys(v.drums.buffers) };
    });
    assert.deepEqual(r.atFirst, { lead: 1, bass: 1, harmony: 1 });
    assert.equal(r.lead, 3); assert.equal(r.bass, 3);
    assert.deepEqual(r.vols, [-9, -9, -9], "late variations inherit the voice level");
    assert.deepEqual(r.drums.sort(), ["hat", "kick", "snare"]);

    // 4) lossless: the FLAC twin decodes to exactly the WAV's samples
    const diff = await page.evaluate(async (files) => {
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      let worst = 0;
      for (const f of files) {
        const [a, b] = await Promise.all([f.replace(/\.wav$/, ".flac"), f].map(async (u) =>
          ctx.decodeAudioData(await (await fetch("/voices/" + u)).arrayBuffer())));
        if (a.length !== b.length) return Infinity;
        for (let c = 0; c < 2; c++) {
          const x = a.getChannelData(c), y = b.getChannelData(c);
          for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
        }
      }
      return worst;
    }, ["harmony_v0_C4.wav", "lead_v1_G#3.wav".replace("#", "s"), "bass_v2_E1.wav", "drums_kick_0.wav"]);
    assert.equal(diff, 0, "FLAC decode is bit-identical to WAV");
  } finally { await browser.close(); await gw.kill(); }
});
