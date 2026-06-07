// Pure transforms on grid-note arrays ({t,p,d,v}). The building blocks both brains
// compose. Rhythmic transforms move notes in time; pitch transforms work in diatonic
// degrees so output stays in key.
import { pitchToDeg, degToPitch, clamp, clone, STEPS_PER_BEAT } from "./theory.js";

// --- rhythmic ---------------------------------------------------------------

// Displace the whole pattern by k steps (wraps within the loop). Syncopation/phase.
export function rotate(notes, len, k) {
  if (!k) return clone(notes);
  return notes.map((n) => ({ ...n, t: (((n.t + k) % len) + len) % len }));
}

// Retrograde = time-reverse (the rhythmic "inversion"): the phrase plays backwards.
export function retrograde(notes, len) {
  return notes.map((n) => ({ ...n, t: ((len - n.t - n.d) % len + len) % len }));
}

// Drop notes (thin the texture). Weak-beat notes go first; always keep ≥1.
export function thin(notes, frac, rand) {
  if (frac <= 0 || notes.length <= 1) return clone(notes);
  const scored = notes.map((n) => ({ n, weak: (n.t % STEPS_PER_BEAT !== 0 ? 1 : 0) + rand() * 0.5 }));
  scored.sort((a, b) => b.weak - a.weak);                    // weakest first
  const drop = Math.min(notes.length - 1, Math.round(frac * notes.length));
  const dropped = new Set(scored.slice(0, drop).map((s) => s.n));
  return notes.filter((n) => !dropped.has(n)).map((n) => ({ ...n }));
}

// Add diatonic passing/neighbor notes between existing onsets (ornamentation).
export function ornament(notes, frac, len, root, scale, rand) {
  if (frac <= 0) return clone(notes);
  const out = clone(notes);
  const sorted = [...notes].sort((a, b) => a.t - b.t);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (rand() > frac) continue;
    const a = sorted[i], b = sorted[i + 1];
    const mid = Math.floor((a.t + b.t) / 2);
    if (mid <= a.t || mid >= b.t) continue;
    const da = pitchToDeg(a.p, root, scale), db = pitchToDeg(b.p, root, scale);
    const pass = Math.abs(db - da) > 1 ? Math.round((da + db) / 2) : da + (rand() < 0.5 ? 1 : -1);
    out.push({ t: mid, p: degToPitch(pass, root, scale), d: Math.max(1, b.t - mid), v: 0.6 });
  }
  return out;
}

// --- pitch (diatonic) -------------------------------------------------------

// Melodic inversion around an axis degree. `frac` = how much: the FRACTION of notes
// that get mirrored (not interval-scaling, which would collapse to the axis at 0.5).
// 0 = original, 1 = every note mirrored, 0.5 ≈ half the notes flipped (hybrid contour).
export function diatonicInvert(notes, frac, axisDeg, root, scale, rand = Math.random) {
  if (frac <= 0) return clone(notes);
  return notes.map((n) => {
    if (frac < 1 && rand() > frac) return { ...n };       // this note stays as played
    const d = pitchToDeg(n.p, root, scale);
    return { ...n, p: degToPitch(2 * axisDeg - d, root, scale) };
  });
}

// Shift everything by `steps` scale-degrees (diatonic transpose).
export function transposeDia(notes, steps, root, scale) {
  if (!steps) return clone(notes);
  return notes.map((n) => ({ ...n, p: degToPitch(pitchToDeg(n.p, root, scale) + steps, root, scale) }));
}

// Snap strong-beat notes onto the chord active at THAT beat, so the line follows the changes
// (soloing over the progression). `chord` is either a fixed pitch-class array or a function
// chord(t) → pitch classes for step t. Snaps fully to the nearest chord tone (which is in-key),
// so no out-of-key artifacts. `frac` is an on/off gate (>0 = follow). Off-beats stay as passing tones.
export function harmonizeToChord(notes, frac, chord, root, scale) {
  if (frac <= 0) return clone(notes);
  return notes.map((n) => {
    if (n.t % STEPS_PER_BEAT !== 0) return { ...n };           // only strong beats
    const pcs = typeof chord === "function" ? chord(n.t) : chord;
    if (!pcs || !pcs.length) return { ...n };
    let best = n.p, bd = 99;
    for (let off = -6; off <= 6; off++) {
      if (pcs.includes((((n.p + off) % 12) + 12) % 12) && Math.abs(off) < bd) { bd = Math.abs(off); best = n.p + off; }
    }
    return { ...n, p: best };                                  // full snap → nearest current chord tone
  });
}

// Keep notes inside the loop window (clip any pushed past the end).
export const fitLen = (notes, len) => notes.filter((n) => n.t >= 0 && n.t < len).map((n) => ({ ...n, d: clamp(n.d, 1, len - n.t) }));

// Velocity/dynamics contour: accent bar-downbeats, then beats; soften off-beats and ornaments;
// a gentle phrase arc (swell toward the middle); plus light humanization. Shapes only velocity, so
// the player's pitches and timing are untouched — it just gives the flat phone input human dynamics.
export function dynamics(notes, len, rand = Math.random) {
  return notes.map((n) => {
    const beatPos = n.t % STEPS_PER_BEAT;
    let v = 0.78;
    if (n.t % (STEPS_PER_BEAT * 4) === 0) v += 0.16;      // bar downbeat — strongest
    else if (beatPos === 0) v += 0.08;                     // on the beat
    else v -= 0.04;                                        // off-beat — lighter
    v += 0.07 * Math.sin(Math.PI * (n.t / Math.max(1, len)));  // phrase arc (swell then ease)
    if ((n.v ?? 0.9) < 0.7) v -= 0.12;                     // keep ornaments/grace notes soft
    v += (rand() - 0.5) * 0.06;                            // humanize
    return { ...n, v: clamp(v, 0.35, 1) };
  });
}
