// HarmonyBrain — rhythm-focused comping over the chord schedule. Same rhythmic engine
// as the lead, but pitches are FIXED to the current chord (no melodic inversion). It
// decides WHEN to articulate the chord and whether to block/arpeggiate. Rhythm only.
import { rng, STEPS_PER_BAR } from "./theory.js";

export const HARMONY_DEFAULTS = {
  density: 0.4,     // 0 sustained → 0.2 beats → 0.45 eighths → 0.7+ sixteenths
  syncopate: 0,     // 0..1 push hits onto the off-beats
  arp: 0,           // 0 block chord → 0.5 two-note → 1 single-note arpeggio
};

export class HarmonyBrain {
  constructor({ bars = 4 } = {}) { this.bars = bars; this.len = bars * STEPS_PER_BAR; }

  // schedule: beat-slots [{notes:[midi]}], length = bars*4. Returns comp notes {t,p,d,v}.
  comp(schedule, params = {}, loop = 0) {
    const p = { ...HARMONY_DEFAULTS, ...params };
    const len = this.len, beats = schedule.length || this.bars * 4;
    const r = rng(loop * 40503 + 7);
    const out = [];

    // 1) decide hit steps (rhythm)
    const hits = [];
    let lastKey = null;
    for (let step = 0; step < len; step++) {
      const chord = schedule[Math.floor(step / 4) % beats]?.notes || [];
      const key = chord.join(",");
      const changed = key !== lastKey; lastKey = key;
      let hit = false;
      if (changed) hit = true;                                  // always state a new chord
      else if (p.density >= 0.7) hit = true;                    // sixteenths
      else if (p.density >= 0.45) hit = step % 2 === 0;         // eighths
      else if (p.density >= 0.2) hit = step % 4 === 0;          // quarters
      if (!hit && p.syncopate > 0 && step % 4 === 2 && r() < p.syncopate) hit = true; // & push
      if (hit && chord.length) hits.push({ step, chord });
    }

    // 2) voice each hit (block / arp) and hold until the next hit
    let arpIdx = 0;
    for (let i = 0; i < hits.length; i++) {
      const { step, chord } = hits[i];
      const dur = Math.max(1, (i + 1 < hits.length ? hits[i + 1].step : len) - step);
      const tones = pickTones(chord, p.arp, arpIdx);
      if (p.arp > 0) arpIdx++;
      tones.forEach((mp) => out.push({ t: step, p: mp, d: dur, v: 0.8 }));
    }
    return out;
  }
}

function pickTones(chord, arp, idx) {
  if (arp <= 0) return chord;                                   // block chord (all tones)
  if (arp >= 0.66) return [chord[idx % chord.length]];          // single-note arpeggio
  return [chord[idx % chord.length], chord[(idx + 2) % chord.length]]; // two-note
}
