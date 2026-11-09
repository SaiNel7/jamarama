// Loads the pre-baked MRT2 instruments (harmony + lead samplers, and an auto-chopped drum kit)
// from /voices/manifest.json into Tone nodes the host can play with ZERO real-time neural cost.
//
// Pitched voices: each is a set of VARIATION sampler maps (same prompt, slightly different cuts
// → subtly different timbres). MultiSampler wraps them behind the SAME triggerAttackRelease /
// volume / connect / dispose surface as a PolySynth/MonoSynth, picking a random variation per
// note for natural flair — so host.js's brain/clock code is untouched.
//
// Drums: each kit piece (kick/snare/hat) is a few one-shot buffers chopped from one MRT2 groove.
// DrumKit.hit(type, time, velocity) fires a random buffer through a one-shot source so hits can
// overlap and each gets its own velocity. Every one-shot's transient sits at sample[0], so
// nothing drifts off the beat.
const Tone = window.Tone;

const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// Re-bakes overwrite the same filenames (harmony_C4.wav, …), so sample URLs carry the manifest's
// revision (its Last-Modified time): a re-bake gets fresh URLs, while the SAME samples keep the
// same URLs across page loads and rooms — so they can be cached (the server marks ?v= URLs
// immutable) and pre-fetched in the lobby. (Previously every load busted the cache with Date.now(),
// re-downloading ~22 MB on every START.)
async function fetchManifest(base) {
  const r = await fetch(base + "manifest.json", { cache: "no-store" });
  if (!r.ok) return null;
  const manifest = await r.json();
  const rev = r.headers.get("last-modified") || r.headers.get("etag") || String(Date.now());
  return { manifest, q: `?v=${encodeURIComponent(rev)}` };
}

// The committed default kit ships losslessly FLAC-encoded twins ("flac": true in its manifest):
// 43% of the WAV bytes, bit-identical audio. Any browser that can't decode FLAC falls back to WAV.
const canFlac = (() => {
  try { return !!document.createElement("audio").canPlayType("audio/flac"); } catch { return false; }
})();
const flacName = (f) => f.replace(/\.wav$/i, ".flac");
function sampleUrls(manifest, base, q, file) {
  const wav = base + file + q;
  return manifest?.flac && canFlac && /\.wav$/i.test(file) ? [base + flacName(file) + q, wav] : [wav];
}
async function loadBuffer(urls) {
  for (const url of urls) {
    try { return await Tone.ToneAudioBuffer.fromUrl(url); } catch { /* try the next format */ }
  }
  return null;
}

// Drop-in replacement for a poly/mono synth that fans out across several variation samplers.
class MultiSampler {
  constructor(samplers) {
    this.samplers = samplers.filter(Boolean);
    this._t = null; this._i = 0;   // remember the variation used for the current trigger-time
    this._dests = []; this._vol = null; this._disposed = false;
    // host.js sets `.volume.value = x`; fan it out to every variation (and remember it for late ones).
    const self = this;
    this.volume = { set value(v) { self._vol = v; for (const s of self.samplers) s.volume.value = v; },
                    get value() { return self._vol; } };
  }
  connect(node) { this._dests.push(node); for (const s of this.samplers) s.connect(node); return this; }
  // Variations beyond the first stream in AFTER the band has started; each joins the random pool
  // with the same level/routing as the rest (or is dropped if this voice was already swapped out).
  add(s) {
    if (!s) return;
    if (this._disposed) { try { s.dispose(); } catch {} return; }
    if (this._vol != null) s.volume.value = this._vol;
    for (const d of this._dests) s.connect(d);
    this.samplers.push(s);
  }
  triggerAttackRelease(note, dur, time, vel) {
    // All notes of one CHORD arrive with the SAME `time` → use ONE variation for the whole chord,
    // so a chord is never an incoherent mix of variations. A new time picks a fresh variation (flair).
    if (time !== this._t) { this._t = time; this._i = (Math.random() * this.samplers.length) | 0; }
    const s = this.samplers[this._i];
    if (s) s.triggerAttackRelease(note, dur, time, vel);
  }
  dispose() { this._disposed = true; for (const s of this.samplers) { try { s.dispose(); } catch {} } }
}

// A sampled drum kit. Buffers are pre-loaded; each hit spins up a short-lived buffer source
// (so retriggers/overlaps are clean) through a per-hit gain for velocity, both auto-disposed.
class DrumKit {
  // one-shots are peak-normalized, so bake in a musical kit balance (kick forward, hat back).
  constructor(buffers) {
    this.buffers = buffers;
    this.bus = Tone.getDestination();
    this.levels = { kick: 0.95, snare: 0.75, hat: 0.42 };  // drums forward in the mix (master trim+limiter guard clipping)
  }
  connect(node) { this.bus = node; return this; }
  has(type) { return !!(this.buffers[type] && this.buffers[type].length); }
  hit(type, time, velocity = 0.9) {
    if (!this.has(type)) return false;
    const g = new Tone.Gain(velocity * (this.levels[type] ?? 1)).connect(this.bus);
    const src = new Tone.ToneBufferSource(pick(this.buffers[type])).connect(g);
    src.onended = () => { try { src.dispose(); g.dispose(); } catch {} };
    src.start(time, 0);          // offset 0 → always play from the very start of the sample (the transient)
    return true;
  }
  dispose() {
    for (const arr of Object.values(this.buffers)) for (const b of arr) { try { b.dispose(); } catch {} }
  }
}

// One variation's note→file map → a Tone.Sampler over pre-decoded buffers (null if nothing loaded).
// attack:0 → the sampler plays each buffer from sample[0] with no fade-in, so the baked transient
// lands exactly on the beat. A short release avoids note-off clicks. A bad sample is skipped.
async function loadVariation(map, manifest, base, q) {
  const entries = await Promise.all(Object.entries(map).map(async ([note, f]) =>
    [note, await loadBuffer(sampleUrls(manifest, base, q, f))]));
  const urls = Object.fromEntries(entries.filter(([, b]) => b));
  if (!Object.keys(urls).length) return null;
  return new Tone.Sampler({ urls, attack: 0, release: 0.12 });
}

// Build the variation samplers for one pitched voice → a MultiSampler, or null.
// Time-to-first-sound: only the FIRST variation is awaited; the others (2 more per voice in the
// default kit, ~half the bytes) load in the background and join the random pool as they land.
async function loadVoice(v, manifest, base, q, background) {
  const variations = v?.variations || (v?.urls ? [v.urls] : []);   // tolerate the old single-map schema
  const maps = variations.filter((u) => u && Object.keys(u).length);
  if (!maps.length) return null;
  let first = null, i = 0;
  while (!first && i < maps.length) first = await loadVariation(maps[i++], manifest, base, q);
  if (!first) return null;
  const ms = new MultiSampler([first]);
  const rest = maps.slice(i);
  if (rest.length) background.push(async () => { for (const m of rest) ms.add(await loadVariation(m, manifest, base, q)); });
  return ms;
}

// Pre-load all drum one-shots into buffers → a DrumKit, or null if none.
async function loadDrums(drums, manifest, base, q) {
  if (!drums) return null;
  const types = ["kick", "snare", "hat"];
  const buffers = {};
  await Promise.all(types.flatMap((type) => (drums[type] || []).map(async (fn) => {
    const buf = await loadBuffer(sampleUrls(manifest, base, q, fn));
    if (buf) (buffers[type] = buffers[type] || []).push(buf);
  })));
  return Object.keys(buffers).length ? new DrumKit(buffers) : null;
}

// Returns { manifest, harmony, lead, drums, more } — any field null if absent — or null if no prebake.
// Nodes are created but NOT connected; the caller wires routing (stems / FX / destination).
// `more` resolves when the background variations have finished loading.
export async function loadVoices(base = "/voices/") {
  let m;
  try { m = await fetchManifest(base); } catch { return null; }
  if (!m) return null;
  const { manifest, q } = m;
  const voices = manifest?.voices || {};
  const background = [];
  const [harmony, lead, bass, drums] = await Promise.all([
    loadVoice(voices.harmony, manifest, base, q, background),
    loadVoice(voices.lead, manifest, base, q, background),
    loadVoice(voices.bass, manifest, base, q, background),
    loadDrums(manifest?.drums, manifest, base, q),
  ]);
  const more = Promise.all(background.map((job) => job().catch(() => {})));
  return { manifest, harmony, lead, bass, drums, more };
}

// Lobby pre-fetch: warm the HTTP cache with the exact sample URLs loadVoices() will request, so
// START only has to decode. First variations + drums first (that's what the band waits for), a
// few requests at a time at low priority so the lobby itself stays responsive. Skipped when the
// visitor asked to save data or is on a 2G-class link.
export async function prefetchVoices(base = "/voices/", { concurrency = 4 } = {}) {
  const c = navigator.connection;
  if (c?.saveData || /(^|-)2g$/.test(c?.effectiveType || "")) return { skipped: true };
  const m = await fetchManifest(base).catch(() => null);
  if (!m) return { skipped: true };
  const { manifest, q } = m;
  const first = [], later = [];
  for (const v of Object.values(manifest.voices || {})) {
    const vars = v?.variations || (v?.urls ? [v.urls] : []);
    vars.forEach((map, i) => Object.values(map || {}).forEach((f) => (i ? later : first).push(f)));
  }
  for (const t of ["kick", "snare", "hat"]) first.push(...(manifest.drums?.[t] || []));
  const queue = [...first, ...later].map((f) => sampleUrls(manifest, base, q, f)[0]);
  let bytes = 0;
  const worker = async () => {
    for (let url; (url = queue.shift());) {
      try { const r = await fetch(url, { priority: "low" }); bytes += (await r.arrayBuffer()).byteLength; } catch {}
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { skipped: false, bytes };
}
