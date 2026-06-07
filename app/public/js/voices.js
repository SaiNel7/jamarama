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

// Re-bakes overwrite the same filenames (harmony_C4.wav, …), so bust the browser
// cache per load — a mid-session re-bake must not serve last bake's samples.
const bust = () => `?v=${Date.now()}`;

// Drop-in replacement for a poly/mono synth that fans out across several variation samplers.
class MultiSampler {
  constructor(samplers) {
    this.samplers = samplers.filter(Boolean);
    this._t = null; this._i = 0;   // remember the variation used for the current trigger-time
    // host.js sets `.volume.value = x`; fan it out to every variation.
    this.volume = { set value(v) { for (const s of this._s) s.volume.value = v; }, _s: this.samplers };
  }
  connect(node) { for (const s of this.samplers) s.connect(node); return this; }
  triggerAttackRelease(note, dur, time, vel) {
    // All notes of one CHORD arrive with the SAME `time` → use ONE variation for the whole chord,
    // so a chord is never an incoherent mix of variations. A new time picks a fresh variation (flair).
    if (time !== this._t) { this._t = time; this._i = (Math.random() * this.samplers.length) | 0; }
    const s = this.samplers[this._i];
    if (s) s.triggerAttackRelease(note, dur, time, vel);
  }
  dispose() { for (const s of this.samplers) { try { s.dispose(); } catch {} } }
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

// Build the variation samplers for one pitched voice. Resolves to a MultiSampler or null.
async function loadVoice(v, base) {
  const variations = v?.variations || (v?.urls ? [v.urls] : []);   // tolerate the old single-map schema
  let maps = variations.filter((u) => u && Object.keys(u).length);
  if (!maps.length) return null;
  const b = bust();
  maps = maps.map((u) => Object.fromEntries(Object.entries(u).map(([note, f]) => [note, f + b])));
  const samplers = await Promise.all(maps.map((urls) => new Promise((resolve) => {
    // attack:0 → the sampler plays each buffer from sample[0] with no fade-in, so the baked
    // transient lands exactly on the beat (Tone.Sampler always plays from the buffer start; the
    // explicit 0 attack guarantees nothing delays the onset). A short release avoids note-off clicks.
    // onload resolves once decoded; onerror still resolves so one bad sample can't hang the load.
    const s = new Tone.Sampler({ urls, baseUrl: base, attack: 0, release: 0.12,
      onload: () => resolve(s), onerror: () => resolve(s) });
  })));
  const ok = samplers.filter(Boolean);
  return ok.length ? new MultiSampler(ok) : null;
}

// Pre-load all drum one-shots into buffers → a DrumKit, or null if none.
async function loadDrums(drums, base) {
  if (!drums) return null;
  const types = ["kick", "snare", "hat"];
  const buffers = {};
  const b = bust();
  await Promise.all(types.flatMap((type) => (drums[type] || []).map(async (fn) => {
    try {
      const buf = await Tone.ToneAudioBuffer.fromUrl(base + fn + b);
      (buffers[type] = buffers[type] || []).push(buf);
    } catch { /* skip a bad sample */ }
  })));
  return Object.keys(buffers).length ? new DrumKit(buffers) : null;
}

// Returns { manifest, harmony, lead, drums } — any field null if absent — or null if no prebake.
// Nodes are created but NOT connected; the caller wires routing (stems / FX / destination).
export async function loadVoices(base = "/voices/") {
  let manifest;
  try {
    const r = await fetch(base + "manifest.json", { cache: "no-store" });
    if (!r.ok) return null;
    manifest = await r.json();
  } catch {
    return null;
  }
  const voices = manifest?.voices || {};
  const [harmony, lead, bass, drums] = await Promise.all([
    loadVoice(voices.harmony, base),
    loadVoice(voices.lead, base),
    loadVoice(voices.bass, base),
    loadDrums(manifest?.drums, base),
  ]);
  return { manifest, harmony, lead, bass, drums };
}
