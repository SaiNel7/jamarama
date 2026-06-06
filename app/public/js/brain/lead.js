// LeadBrain — captures a played phrase, quantizes it to the grid, loops it, and
// generates parameter-mapped variations each loop. Rhythmic transforms are the
// headline; pitch (melodic) inversion is fractional. All knobs are mappable.
import { MAJOR, MINOR, keyRoot, pitchToDeg, quantize, clone, rng, STEPS_PER_BAR } from "./theory.js";
import { rotate, retrograde, thin, ornament, diatonicInvert, transposeDia, harmonizeToChord, fitLen } from "./transforms.js";

export const LEAD_DEFAULTS = {
  responseEvery: 2,   // 0 = never vary (pure loop); 1 = vary every loop; 2 = call, response, call…
  shift: 0,           // 0..1 rhythmic displacement (rotate up to one beat)
  retro: 0,           // 0..1 probability this response is time-reversed (rhythmic inversion)
  invert: 0,          // 0..1 diatonic melodic inversion amount
  density: 0,         // -1..1  (<0 thins, >0 ornaments)
  transpose: 0,       // diatonic steps
  harmonize: 0,       // 0..1 pull strong beats onto the current chord
};

export class LeadBrain {
  constructor({ key = "A", scale = "major", bars = 2 } = {}) {
    this.setKey(key, scale);
    this.bars = bars;
    this.len = bars * STEPS_PER_BAR;
    this.phrase = [];
    this.axisDeg = 0;
    this.chordPCs = [];     // current chord pitch-classes (for harmonize)
  }
  setKey(key, scale) { this.root = keyRoot(key); this.scale = scale === "minor" ? MINOR : MAJOR; }
  setChord(midiNotes) { this.chordPCs = (midiNotes || []).map((m) => ((m % 12) + 12) % 12); }

  // Ingest raw onsets [{beat, pitch, durBeats?}] (clock-stamped) → the looping phrase.
  capture(events) { this.setPhrase(quantize(events, this.len)); }
  setPhrase(notes) {
    this.phrase = clone(notes);
    this.axisDeg = notes.length ? pitchToDeg(notes[0].p, this.root, this.scale) : 0;  // mirror around first note
  }

  // Notes to play for loop iteration `loop` given the (mappable) params.
  generate(loop, params = {}) {
    const p = { ...LEAD_DEFAULTS, ...params };
    let n = clone(this.phrase);
    if (!n.length) return n;

    const isResponse = p.responseEvery > 0 && (p.responseEvery === 1 || loop % p.responseEvery !== 0);
    if (isResponse) {
      const r = rng(loop * 2654435761 + 1);
      // --- rhythmic (the headline) ---
      if (p.retro > 0 && r() < p.retro) n = retrograde(n, this.len);
      if (p.shift > 0) n = rotate(n, this.len, Math.round(p.shift * 4));            // up to one beat
      if (p.density > 0) n = ornament(n, p.density, this.len, this.root, this.scale, r);
      if (p.density < 0) n = thin(n, -p.density, r);
      // --- pitch ---
      if (p.invert > 0) n = diatonicInvert(n, p.invert, this.axisDeg, this.root, this.scale, r);
      if (p.transpose) n = transposeDia(n, p.transpose, this.root, this.scale);
    }
    // consonance lock + clip to the loop
    if (p.harmonize > 0) n = harmonizeToChord(n, p.harmonize, this.chordPCs, this.root, this.scale);
    return fitLen(n, this.len).sort((a, b) => a.t - b.t);
  }
}
