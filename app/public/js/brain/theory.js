// Music-theory primitives for the Jamarama generative brains.
// Pure functions, no DOM/audio — node-testable, browser-importable.
//
// Pitches are MIDI ints (C-1 = 0, A4 = 69). Transforms operate on DIATONIC
// scale-degrees (steps along the key's scale) so variations stay in key.

export const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export const MINOR = [0, 2, 3, 5, 7, 8, 10];
// Scale-degree interval sets for every offered mode (semitones from the tonic). Melody/snap use
// these so a dorian/lydian/pentatonic jam stays in its actual mode, not forced to major/minor.
// (Mirrors the steps in shared.js MODES, which also carries the parent-major offset for CHORDS.)
export const SCALES = {
  major: MAJOR, ionian: MAJOR, minor: MINOR, aeolian: MINOR,
  dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10], pentatonic: [0, 2, 4, 7, 9],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
export const scaleSteps = (name) => SCALES[name] || MAJOR;
export const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
export const STEPS_PER_BAR = 16;          // 16th-note grid
export const STEPS_PER_BEAT = 4;

export const keyRoot = (name) => NOTE_NAMES.indexOf(name);
export const midiName = (p) => NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);

// MIDI pitch → diatonic degree index (n scale-steps from the key root, across octaves).
export function pitchToDeg(p, root, scale = MAJOR) {
  const n = scale.length;
  const rel = (((p - root) % 12) + 12) % 12;
  const oct = Math.floor((p - root) / 12);
  let bi = 0, bd = 99;
  scale.forEach((s, i) => { const d = Math.abs(s - rel); if (d < bd) { bd = d; bi = i; } });
  return oct * n + bi;
}
// Diatonic degree index → MIDI pitch.
export function degToPitch(deg, root, scale = MAJOR) {
  const n = scale.length;
  const oct = Math.floor(deg / n);
  const idx = ((deg % n) + n) % n;
  return root + oct * 12 + scale[idx];
}
// Snap any pitch into the key.
export const snap = (p, root, scale = MAJOR) => degToPitch(pitchToDeg(p, root, scale), root, scale);

// Tiny deterministic PRNG (seeded) so variations are reproducible & testable.
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export const clone = (notes) => notes.map((n) => ({ ...n }));
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Quantize raw onsets (in beats from loop start) to the grid.
// events: [{beat, pitch, durBeats?, vel?}] → notes [{t,p,d,v}] within `len` steps.
export function quantize(events, len, minDur = 1) {
  return events.map((e) => {
    const t = ((Math.round(e.beat * STEPS_PER_BEAT) % len) + len) % len;
    const d = Math.max(minDur, Math.round((e.durBeats ?? 0.5) * STEPS_PER_BEAT));
    return { t, p: e.pitch, d, v: e.vel ?? 0.9 };
  }).sort((a, b) => a.t - b.t);
}

// ASCII piano-roll for reviewing output in the terminal.
export function pianoRoll(notes, len, label = "") {
  if (!notes.length) return `${label}\n(empty)`;
  const lo = Math.min(...notes.map((n) => n.p)), hi = Math.max(...notes.map((n) => n.p));
  const rows = [];
  for (let p = hi; p >= lo; p--) {
    let row = "";
    for (let t = 0; t < len; t++) {
      const on = notes.find((n) => n.p === p && t >= n.t && t < n.t + n.d);
      const onset = notes.some((n) => n.p === p && n.t === t);
      row += onset ? "█" : on ? "▬" : (t % STEPS_PER_BEAT === 0 ? "·" : " ");
    }
    rows.push(midiName(p).padStart(4) + " |" + row + "|");
  }
  const ruler = "     " + Array.from({ length: len }, (_, t) => (t % STEPS_PER_BAR === 0 ? "▌" : t % STEPS_PER_BEAT === 0 ? "'" : " ")).join("");
  return `${label}\n${rows.join("\n")}\n${ruler}`;
}
