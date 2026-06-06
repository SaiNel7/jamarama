// Loads the pre-baked MRT2 voices (harmony + lead) into Tone.Sampler instances.
//
// A Tone.Sampler pitch-shifts a handful of sampled notes across the whole keyboard and exposes
// the IDENTICAL triggerAttackRelease(note, dur, time, vel) API as the current chordSynth
// (PolySynth) / leadSynth (MonoSynth) — and it's polyphonic, so harmony chords work too. So the
// brain + clock code never changes: host.js just uses these samplers when a prebake is present,
// and falls back to the built-in synths when it isn't.
const Tone = window.Tone;

// Returns { samplers: { harmony, lead }, manifest } or null if no prebake is available.
// Samplers are created but NOT connected — the caller wires routing (FX / destination).
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
  const samplers = {};
  // Re-bakes overwrite the same filenames (harmony_C4.wav, …), so bust the browser
  // cache per load — a mid-session re-bake must not serve last bake's samples.
  const bust = `?v=${Date.now()}`;
  await Promise.all(Object.entries(voices).map(([name, v]) => new Promise((resolve) => {
    const urls = Object.fromEntries(Object.entries(v?.urls || {}).map(([note, f]) => [note, f + bust]));
    if (!Object.keys(urls).length) { samplers[name] = null; return resolve(); }
    // onload resolves once every sample is decoded; onerror still resolves so one bad
    // voice can't hang the whole load.
    samplers[name] = new Tone.Sampler({ urls, baseUrl: base, onload: resolve, onerror: resolve });
  })));
  return { samplers, manifest };
}
