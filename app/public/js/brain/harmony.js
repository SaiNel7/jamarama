// HarmonyBrain — GENRE-driven comping over the chord schedule. The WHEN/length of each chord
// articulation comes from the genre feel (brain/groove.js compStep): reggae skanks the off-beats,
// funk stabs 16ths, house plays off-beat stabs, jazz comps syncopated, ambient holds a pad. The
// HOW (which octave/inversion) comes from a voice-leading engine (voiceLead) so chords glide into
// each other — holding common tones, moving the rest by the smallest step — instead of jumping to
// root position every change. The chord is always stated on a chord change.
import { STEPS_PER_BAR, STEPS_PER_BEAT, rng } from "./theory.js";
import { compStep } from "./groove.js";

// Comp register window (keeps the comp above the bass and out of the mud). G3..G5.
const VL_LO = 55, VL_HI = 79, VL_CENTER = 64;

// Per-genre voicing GRAMMAR (keyed by comp feel — the signal comp receives). Shapes HOW a chord is
// spaced, on top of the voice-leading engine:
//   dropRoot — drop the root (the bass already plays it) → rootless jazz/latin shells
//   tensions — extra colour tones as semitones above the root (2 = 9th, 9 = 13th)
//   open     — drop-2 spread (wider, airier) vs tight close position
//   lo/hi/center — register window/centre override
const EMPTY_STYLE = {};
const VOICINGS = {
  swing:     { dropRoot: true,  tensions: [2],    open: false, center: 64 },          // jazz: rootless + 9th
  latin:     { dropRoot: true,  tensions: [2],    open: false, center: 64 },          // latin-jazz montuno
  boombap:   { dropRoot: true,  tensions: [2],    open: true,  center: 62 },          // jazzy lo-fi spread
  funk:      { dropRoot: false, tensions: [],     open: false, center: 67, lo: 60 },  // tight upper-mid stab
  fourfloor: { dropRoot: false, tensions: [],     open: false, center: 67, lo: 60 },  // house/disco stab
  sparse:    { dropRoot: false, tensions: [2],    open: true,  center: 60 },          // ambient: open add9 pad
  trap:      { dropRoot: false, tensions: [],     open: true,  center: 55, lo: 48, hi: 72 }, // dark wide sustain
  reggae:    { dropRoot: false, tensions: [],     open: false, center: 64 },          // bright triad skank
  // backbeat / driving / shuffle fall through to EMPTY_STYLE → plain close voicing
};

export class HarmonyBrain {
  constructor({ bars = 4 } = {}) { this.bars = bars; this.len = bars * STEPS_PER_BAR; }

  // schedule: beat-slots [{notes:[midi]}]. params: { feel, x (complexity), y (energy) }.
  // Returns comp notes {t,p,d,v}.
  comp(schedule, params = {}, loop = 0) {
    const feel = params.feel || "backbeat", x = params.x || 0, y = params.y || 0;
    const beats = schedule.length || this.bars * 4;     // loop length is driven by the schedule
    const len = beats * STEPS_PER_BEAT;
    const out = [];

    // per-loop development: a seeded PRNG (reproducible per loop index) makes successive 4-bar
    // loops breathe instead of repeating byte-for-byte — some loops thin out, some drop a bar to
    // leave the lead space, some push a turnaround into the last bar. Warm up once to avoid the
    // low-entropy first draw for small seeds.
    const R = rng(((loop * 2654435761) >>> 0) || 1); R();
    const lastBar = Math.floor((len - 1) / STEPS_PER_BAR);
    const doThin = R() < 0.33;                                   // a sparser loop
    const dropBar = (R() < 0.22 && lastBar >= 2) ? 2 : -1;       // clear the 3rd bar for space
    const doTurn = R() < 0.45;                                   // anticipate the loop top in the last bar

    // 1) decide hit steps from the genre comp pattern (+ always state a new chord)
    const hits = [];
    let lastKey = null;
    for (let step = 0; step < len; step++) {
      const chord = schedule[Math.floor(step / 4) % beats]?.notes || [];
      const key = chord.join(",");
      const changed = key !== lastKey; lastKey = key;
      const c = compStep(feel, step % STEPS_PER_BAR, Math.floor(step / STEPS_PER_BAR), x, y);
      if (!chord.length || !(changed || c.hit)) continue;
      const bar = Math.floor(step / STEPS_PER_BAR);
      if (bar === dropBar) continue;                             // this bar sits out (space for the lead)
      if (!changed && doThin && R() < 0.45) continue;            // thin optional hits, keep chord statements
      hits.push({ step, chord, arp: c.arp, durHint: c.dur, changed });
    }
    // turnaround: make the last stab(s) anticipate the loop top — retarget any hit in the final 8th
    // to the next loop's first chord (a real push back to the top), or add one if the bar is empty
    // there. Retargeting (not adding) avoids stacking two chords on the same step.
    if (doTurn && len >= STEPS_PER_BAR) {
      const top = schedule[0]?.notes || [];
      if (top.length) {
        const late = hits.filter((h) => h.step >= len - 2);
        if (late.length) late.forEach((h) => { h.chord = top; });
        else hits.push({ step: len - 2, chord: top, arp: 0, durHint: 2 });
      }
    }
    hits.sort((a, b) => a.step - b.step);

    // 2) voice each hit: re-voice the chord by voice-leading off the previous chord (smooth motion,
    //    held common tones), then pick block/arp tones from that voiced chord. Held for its genre
    //    duration but never past the next hit.
    let arpIdx = 0, prevVoicing = null;
    for (let i = 0; i < hits.length; i++) {
      const { step, chord, arp, durHint, changed } = hits[i];
      const toNext = (i + 1 < hits.length ? hits[i + 1].step : len) - step;
      const dur = Math.max(1, Math.min(durHint, toNext));
      const voiced = voiceLead(chord, prevVoicing, VOICINGS[feel] || EMPTY_STYLE);
      prevVoicing = voiced;                                       // next chord leads off this one
      // articulate a chord CHANGE as a full block even in arpeggiated feels, so the new chord is
      // clearly heard landing (otherwise a single arp note leaves the change ambiguous); the arp
      // then resumes on the following hits.
      const stateBlock = changed && arp > 0;
      const tones = stateBlock ? voiced : pickTones(voiced, arp, arpIdx);
      if (arp > 0 && !stateBlock) arpIdx++;
      tones.forEach((mp) => out.push({ t: step, p: mp, d: dur, v: 0.8 * (0.7 + 0.3 * y) }));
    }
    return out;
  }
}

function pickTones(chord, arp, idx) {
  if (arp <= 0) return chord;                                   // block chord (all tones)
  if (arp >= 0.66) return [chord[idx % chord.length]];          // single-note arpeggio
  return [chord[idx % chord.length], chord[(idx + 2) % chord.length]]; // two-note
}

// ---- Voice-leading -----------------------------------------------------------
// Re-voice a chord (any inversion / octave placement of its pitch classes) so it moves the least
// from the previous voicing — common tones stay put, the rest step by the smallest interval. The
// genre `style` first reshapes the pitch-class set (drop root, add tensions) and the register, then
// `open` spreads it. Keeps the result ascending. Returns MIDI notes low→high.
export function voiceLead(chord, prev, style = EMPTY_STYLE) {
  if (!chord.length) return [];
  const rootPc = ((chord[0] % 12) + 12) % 12;
  let pcs = [...new Set(chord.map((m) => ((m % 12) + 12) % 12))];
  if (style.dropRoot && pcs.length > 2) pcs = pcs.filter((pc) => pc !== rootPc);   // bass covers the root
  for (const off of (style.tensions || [])) {                                       // add colour tones
    const pc = (rootPc + off) % 12;
    if (!pcs.includes(pc)) pcs.push(pc);
  }
  const lo = style.lo ?? VL_LO, hi = style.hi ?? VL_HI, center = style.center ?? VL_CENTER;
  const cands = candidateVoicings(pcs);
  let best = cands[0], bestC = Infinity;
  for (const v of cands) {
    const c = voiceCost(v, prev, lo, hi, center);
    if (c < bestC) { bestC = c; best = v; }
  }
  return style.open ? openVoicing(best) : best;
}

// Drop-2 spread: lower the 2nd-from-top voice an octave for a wider, airier voicing.
function openVoicing(v) {
  if (v.length < 3) return v;
  const s = [...v].sort((a, b) => a - b);
  s[s.length - 2] -= 12;
  return s.sort((a, b) => a - b);
}

// All close-position voicings: every inversion (which pitch class is the bass) across a few octaves.
function candidateVoicings(pcs) {
  const n = pcs.length, out = [];
  for (let r = 0; r < n; r++) {
    const order = pcs.slice(r).concat(pcs.slice(0, r));          // rotation r → order[0] is the bass
    for (let baseOct = 3; baseOct <= 6; baseOct++) {
      const v = []; let prev = -1;
      for (const pc of order) { let p = baseOct * 12 + pc; while (p <= prev) p += 12; v.push(p); prev = p; }
      out.push(v);
    }
  }
  return out;
}

// Cost = total voice motion from prev (nearest-note per voice; common tones → 0) + register penalty.
// With no prev, prefer a voicing centered in the comp window.
function voiceCost(v, prev, lo = VL_LO, hi = VL_HI, center = VL_CENTER) {
  let pen = 0;
  for (const p of v) { if (p < lo) pen += (lo - p); else if (p > hi) pen += (p - hi); }
  if (!prev || !prev.length) {
    const ctr = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.abs(ctr - center) + pen * 2;
  }
  let motion = 0;
  for (const p of v) { let best = Infinity; for (const q of prev) best = Math.min(best, Math.abs(p - q)); motion += best; }
  return motion + pen * 2;
}
