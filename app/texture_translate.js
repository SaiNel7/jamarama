// Room state → MRT2 conditioning, for the CLOUD texture path (texture_cloud.js).
// A line-for-line port of engine/texture_engine.py (Params / style_for / render_chunk) so the
// cloud bed is conditioned exactly like the local MLX engine:
//   blended taste prompts (+ anchor, + lead timbre)  → style  (weighted prompt blend)
//   exact chord pitch classes (or the roman triad)     → notes  (128-slot vector)
//   crowd energy / lead mode                           → temperature, cfg, gain
// Pure functions — unit-tested against the Python engine in test/texture_translate.test.js.

const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const ROMAN = ["I", "ii", "iii", "IV", "V", "vi", "vii"];
// Semitones from a mode's tonic to its PARENT major tonic (mirrors shared.js MODES).
const MODE_PARENT = { major: 0, ionian: 0, minor: 3, aeolian: 3, dorian: 10, phrygian: 8,
  lydian: 7, mixolydian: 5, locrian: 1, pentatonic: 0, chromatic: 0 };

// Fixed textural anchor blended into every style so the bed stays atmospheric (spec §6).
export const ANCHOR_PROMPT = "ambient sustained synth pads, atmospheric drone, shimmering "
  + "reverb wash, beatless, free time, textural ambience";
export const AMBIENT_ANCHOR_WEIGHT = 0.72;
export const LEAD_ANCHOR_WEIGHT = 0.30;
export const LEAD_PROMPT_WEIGHT = 0.45;
export const AMBIENT = { cfg_notes: 3.0, cfg_musiccoca: 3.0, gain: 0.5 };
export const LEAD = { cfg_notes: 4.5, cfg_musiccoca: 4.0, gain: 0.6 };
export const DEFAULT_TASTE = ["warm ambient pads", "cinematic texture"];

const clamp01 = (x) => Math.max(0, Math.min(1, +x || 0));

/** 128-slot notes from explicit pitch classes. -1 masked, 2 onset, 3 sustained-on. */
export function notesFromPcs(pcs, onset = false, baseOct = 4) {
  const v = new Array(128).fill(-1);
  const base = 12 * (baseOct + 1);
  for (const pc of pcs) {
    const midi = base + (((Math.trunc(+pc) % 12) + 12) % 12);   // Python % is non-negative
    if (midi >= 0 && midi < 128) v[midi] = onset ? 2 : 3;
  }
  return v;
}

/** Fallback when no pcs are sent: the roman triad in the key's PARENT major. */
export function chordNotesVec(key, roman, scale = "major", onset = false, baseOct = 4) {
  const v = new Array(128).fill(-1);
  const k = SHARP.indexOf(key), d = ROMAN.indexOf(roman);
  if (k < 0 || d < 0) return v;
  const root = (k + (MODE_PARENT[scale] ?? 0)) % 12;
  for (const t of [0, 2, 4]) {
    const idx = d + t;
    const midi = 12 * (baseOct + 1) + root + MAJOR_STEPS[idx % 7] + 12 * Math.floor(idx / 7);
    if (midi >= 0 && midi < 128) v[midi] = onset ? 2 : 3;
  }
  return v;
}

/** style_for(): the same embedding blend, expressed as weighted prompts (weights sum to 1;
 *  the service blends embeddings by these weights, which is algebraically identical). */
export function styleFor(taste, leadActive, leadPrompt, energy = 0) {
  const w = new Map();
  const add = (text, x) => { if (x > 0) w.set(text, (w.get(text) || 0) + x); };
  const t = taste && taste.length ? taste : null;
  const damp = 1 - 0.25 * clamp01(energy);
  // taste_emb = mean(taste) — or the anchor itself when nobody has a taste
  const tasteTerms = t ? t.map((p) => [p, 1 / t.length]) : [[ANCHOR_PROMPT, 1]];
  let base = tasteTerms, aw;
  if (!leadActive) aw = AMBIENT_ANCHOR_WEIGHT * damp;
  else {
    if (leadPrompt) base = [...tasteTerms.map(([p, x]) => [p, x * (1 - LEAD_PROMPT_WEIGHT)]), [leadPrompt, LEAD_PROMPT_WEIGHT]];
    aw = LEAD_ANCHOR_WEIGHT * damp;
  }
  for (const [p, x] of base) add(p, x * (1 - aw));
  add(ANCHOR_PROMPT, aw);
  return { prompts: [...w].map(([text, weight]) => ({ text, weight: Math.round(weight * 1e6) / 1e6 })) };
}

/** Notes for the current chord (+ the lead's live MIDI, sustained) — render_chunk(). */
export function notesFor(state, onset) {
  const pcs = state.chordPcs || [];
  const notes = pcs.length ? notesFromPcs(pcs, onset)
    : chordNotesVec(state.key || "A", state.chord || "I", state.scale || "major", onset);
  if (state.leadActive) {
    for (const p of state.leadPitches || []) {
      const q = Math.trunc(+p);
      if (q >= 0 && q < 128) notes[q] = 3;
    }
  }
  return notes;
}

/** Generation params — render_chunk() + TextureDSP gain. drums OFF, cfg_drums 6 (spec §6). */
export function paramsFor(state) {
  const lead = Boolean(state.leadActive);
  const e = +state.energy || 0;
  const m = lead ? LEAD : AMBIENT;
  return {
    temperature: Math.round((1.1 + 0.5 * e) * 1000) / 1000,
    cfg_musiccoca: m.cfg_musiccoca,
    cfg_notes: m.cfg_notes,
    cfg_drums: 6.0,
    drums: 0,
    gain: Math.round((m.gain + 0.12 * clamp01(e)) * 1000) / 1000,
    preset: "jamarama_texture",
  };
}

/** Whole conditioning for a state snapshot. */
export function translate(state, { onset = false } = {}) {
  return {
    style: styleFor(state.taste && state.taste.length ? state.taste : null,
      Boolean(state.leadActive), state.leadPrompt || "", +state.energy || 0),
    notes: notesFor(state, onset),
    params: paramsFor(state),
  };
}
