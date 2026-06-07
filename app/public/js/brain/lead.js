// LeadBrain — captures a played phrase, quantizes it to the grid, loops it, and
// generates parameter-mapped variations each loop. Rhythmic transforms are the
// headline; pitch (melodic) inversion is fractional. All knobs are mappable.
import { scaleSteps, keyRoot, pitchToDeg, quantize, clone, rng, STEPS_PER_BAR } from "./theory.js";
import { rotate, retrograde, thin, ornament, diatonicInvert, transposeDia, harmonizeToChord, fitLen, dynamics } from "./transforms.js";

export const LEAD_DEFAULTS = {
  responseEvery: 2,   // 0 = never vary (pure loop); 1 = vary every loop; 2 = call, response, call…
  shift: 0,           // 0..1 rhythmic displacement (rotate up to one beat)
  retro: 0,           // 0..1 probability a development time-reverses (rhythmic inversion)
  invert: 0,          // 0..1 diatonic melodic inversion amount
  density: 0,         // -1..1  (<0 thins, >0 ornaments)
  transpose: 0,       // diatonic steps
  harmonize: 0,       // 0..1 pull strong beats onto the current chord
  wild: 0,            // 0..1 overall wildness — drives how far the motif is allowed to drift
  reAnchor: 4,        // every N developments, snap the motif back to the player's phrase (∞ = never)
};

// GENRE PHRASING — how the motif DEVELOPS per genre feel (multipliers on the wildness-driven knobs,
// plus small baselines). Only shapes developments, never the faithful call. mult≈1 is neutral.
//   density (ornament↔thin), shift (syncopation), invert (contour flips), retro (reversals);
//   *Base = a small constant added even at low wildness so the genre character is always a touch present.
export const LEAD_FEEL = {
  swing:     { density: 1.3, shift: 1.0, invert: 1.0, retro: 1.0, densityBase: 0.15 },  // bebop ornament
  latin:     { density: 1.4, shift: 1.1, invert: 1.0, retro: 0.7, densityBase: 0.15 },  // busy, ornate
  funk:      { density: 0.6, shift: 1.4, invert: 0.8, retro: 0.6, shiftBase: 0.10 },    // syncopated, rhythmic
  boombap:   { density: 0.9, shift: 1.1, invert: 0.9, retro: 0.8 },                     // laid-back
  fourfloor: { density: 0.4, shift: 0.6, invert: 1.2, retro: 0.4, densityBase: -0.10 }, // sparse, hypnotic
  trap:      { density: 0.3, shift: 0.7, invert: 0.8, retro: 0.5, densityBase: -0.20 }, // sparse, long
  reggae:    { density: 0.7, shift: 1.2, invert: 0.9, retro: 0.6 },                     // off-beat
  sparse:    { density: 0.3, shift: 0.5, invert: 1.1, retro: 0.4, densityBase: -0.30 }, // ambient, spacious
  default:   { density: 1.0, shift: 1.0, invert: 1.0, retro: 1.0 },                     // rock/pop/etc.
};
export const leadFeel = (feel) => LEAD_FEEL[feel] || LEAD_FEEL.default;

export class LeadBrain {
  constructor({ key = "A", scale = "major", bars = 2 } = {}) {
    this.setKey(key, scale);
    this.bars = bars;
    this.len = bars * STEPS_PER_BAR;
    this.phrase = [];        // the player's quantized loop (the reactive anchor)
    this.developing = [];    // the evolving motif — grows from `phrase`, re-anchors periodically
    this.devCount = 0;       // how many development steps since the last anchor
    this._sig = "";          // signature of the current phrase (detects new player input)
    this.axisDeg = 0;
    this.chordPCs = [];      // fallback chord pitch-classes (whole loop, when no schedule)
    this.chordSched = null;  // per-BEAT chord pitch-classes [[pc,…], …] → follow the changes
  }
  setKey(key, scale) { this.root = keyRoot(key); this.scale = scaleSteps(scale); }
  setChord(midiNotes) { this.chordPCs = (midiNotes || []).map((m) => ((m % 12) + 12) % 12); }
  // Per-beat chord schedule (array of pitch-class arrays, one per beat) so harmonize follows the
  // progression across the loop. Pass null to fall back to the single setChord().
  setChordSchedule(beatPCs) { this.chordSched = (beatPCs && beatPCs.length) ? beatPCs : null; }
  // Chord pitch-classes active at step t (beat = t/4).
  chordAt(t) { return this.chordSched ? this.chordSched[Math.floor(t / 4) % this.chordSched.length] : this.chordPCs; }

  // Ingest raw onsets [{beat, pitch, durBeats?}] (clock-stamped) → the looping phrase.
  capture(events) { this.setPhrase(quantize(events, this.len)); }
  setPhrase(notes) {
    this.phrase = clone(notes);
    this.axisDeg = notes.length ? pitchToDeg(notes[0].p, this.root, this.scale) : 0;  // mirror around first note
    // REACTIVITY: when the player plays something new, re-anchor the evolution to it immediately,
    // so fresh input always takes over instead of the motif wandering off the old phrase.
    const sig = notes.map((n) => `${n.t}:${n.p}`).join(",");
    if (sig !== this._sig) { this._sig = sig; this.developing = clone(notes); this.devCount = 0; }
  }

  // Notes to play for loop iteration `loop` given the (mappable) params.
  generate(loop, params = {}) {
    const p = { ...LEAD_DEFAULTS, ...params };
    if (!this.phrase.length) return [];

    // CALL loops replay the player's exact phrase (the reactive anchor); RESPONSE loops play the
    // next step of the evolving motif. responseEvery = 1-in-N loops is a response, so LARGER N = more
    // faithful (e.g. 4 → call,call,call,response…; 2 → call,response…; 1 → develop every loop).
    const isResponse = p.responseEvery > 0 && (p.responseEvery === 1 || (loop % p.responseEvery) === p.responseEvery - 1);
    let n = isResponse ? this.develop(p) : clone(this.phrase);

    // Consonance lock only on developments — the faithful call keeps the player's pitches & timing.
    // Strong beats snap to the chord active at THAT beat (chordAt) → the line solos over the changes.
    if (isResponse && p.harmonize > 0) n = harmonizeToChord(n, p.harmonize, (t) => this.chordAt(t), this.root, this.scale);
    // Dynamics contour (velocity only — pitches/timing preserved), seeded per loop for humanization.
    const rd = rng(((loop + 1) * 2246822519) >>> 0 || 1); rd();
    n = dynamics(fitLen(n, this.len), this.len, rd);
    return n.sort((a, b) => a.t - b.t);
  }

  // One development step: grow the CURRENT motif (not the original) by small, seeded operators, so
  // successive responses build on each other instead of re-randomizing. WILDNESS controls how far it
  // drifts: low wildness re-anchors to the player's phrase often and applies one small move (stays
  // recognizable); high wildness re-anchors rarely (or never) and compounds several moves per step
  // (gets progressively unrecognizable).
  develop(p) {
    const reAnchor = p.reAnchor || Infinity;
    if (reAnchor !== Infinity && this.devCount > 0 && this.devCount % reAnchor === 0) this.developing = clone(this.phrase);
    const r = rng(((this.devCount + 1) * 2654435761) >>> 0 || 1); r();   // warm up (avoid low-entropy first draw)
    let n = clone(this.developing);

    // Menu of small moves, WEIGHTED by the (genre-biased) params so each genre develops in character:
    // high density → ornament, low density → thin, high shift → syncopate, etc. How many compound per
    // step scales with wildness.
    const sh = p.shift || 0, inv = p.invert || 0, ret = p.retro || 0;
    const moves = [
      { w: Math.max(0.05, 0.35 + p.density), fn: () => ornament(n, 0.25 + 0.5 * Math.max(0, p.density), this.len, this.root, this.scale, r) },
      { w: Math.max(0.05, 0.35 - p.density), fn: () => thin(n, 0.2, r) },
      { w: 0.2 + sh,                          fn: () => rotate(n, this.len, (r() < 0.5 ? 1 : -1) * Math.max(1, Math.round(sh * 3))) },
      { w: inv > 0 ? 0.15 + inv : 0,          fn: () => diatonicInvert(n, inv, this.axisDeg, this.root, this.scale, r) },
      { w: (p.transpose || sh > 0.4) ? 0.2 : 0, fn: () => transposeDia(n, r() < 0.5 ? 1 : -1, this.root, this.scale) },
      { w: ret > 0 ? ret * 0.4 : 0,           fn: () => retrograde(n, this.len) },
    ];
    const total = moves.reduce((a, m) => a + m.w, 0);
    const nOps = 1 + (p.wild > 0.6 ? 1 : 0) + (p.wild > 0.9 ? 1 : 0);    // more wildness → compounding drift
    for (let k = 0; k < nOps; k++) {
      let x = r() * total, pick = moves[0];
      for (const m of moves) { x -= m.w; if (x <= 0) { pick = m; break; } }
      n = pick.fn();
    }
    this.developing = clone(n);
    this.devCount++;
    return n;
  }
}
