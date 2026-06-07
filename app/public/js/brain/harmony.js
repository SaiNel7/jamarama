// HarmonyBrain — GENRE-driven comping over the chord schedule. The WHEN/voicing/length of each
// chord articulation comes from the genre feel (brain/groove.js compStep): reggae skanks the
// off-beats, funk stabs 16ths, house plays off-beat stabs, jazz comps syncopated, ambient holds a
// pad. Pitches stay fixed to the current chord. The chord is always stated on a chord change.
import { STEPS_PER_BAR, STEPS_PER_BEAT } from "./theory.js";
import { compStep } from "./groove.js";

export class HarmonyBrain {
  constructor({ bars = 4 } = {}) { this.bars = bars; this.len = bars * STEPS_PER_BAR; }

  // schedule: beat-slots [{notes:[midi]}]. params: { feel, x (complexity), y (energy) }.
  // Returns comp notes {t,p,d,v}.
  comp(schedule, params = {}, loop = 0) {
    const feel = params.feel || "backbeat", x = params.x || 0, y = params.y || 0;
    const beats = schedule.length || this.bars * 4;     // loop length is driven by the schedule
    const len = beats * STEPS_PER_BEAT;
    const out = [];

    // 1) decide hit steps from the genre comp pattern (+ always state a new chord)
    const hits = [];
    let lastKey = null;
    for (let step = 0; step < len; step++) {
      const chord = schedule[Math.floor(step / 4) % beats]?.notes || [];
      const key = chord.join(",");
      const changed = key !== lastKey; lastKey = key;
      const c = compStep(feel, step % STEPS_PER_BAR, Math.floor(step / STEPS_PER_BAR), x, y);
      if (chord.length && (changed || c.hit)) hits.push({ step, chord, arp: c.arp, durHint: c.dur });
    }

    // 2) voice each hit (block / arp), held for its genre duration but never past the next hit
    let arpIdx = 0;
    for (let i = 0; i < hits.length; i++) {
      const { step, chord, arp, durHint } = hits[i];
      const toNext = (i + 1 < hits.length ? hits[i + 1].step : len) - step;
      const dur = Math.max(1, Math.min(durHint, toNext));
      const tones = pickTones(chord, arp, arpIdx);
      if (arp > 0) arpIdx++;
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
