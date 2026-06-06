// Review harness for the generative brains. Run from app/:  node public/js/brain/demo.mjs
import { pianoRoll, STEPS_PER_BAR } from "./theory.js";
import { LeadBrain } from "./lead.js";
import { HarmonyBrain } from "./harmony.js";

const hr = (t) => `\n${"━".repeat(76)}\n  ${t}\n${"━".repeat(76)}`;

// ---------------------------------------------------------------- LEAD
const lead = new LeadBrain({ key: "A", scale: "major", bars: 2 });
const LEN = lead.len; // 32 steps (2 bars)
// a played motif in A major (█ onset, ▬ sustain)
lead.setPhrase([
  { t: 0, p: 69, d: 2 }, { t: 3, p: 73, d: 1 }, { t: 6, p: 76, d: 2 }, { t: 10, p: 74, d: 2 },
  { t: 16, p: 73, d: 2 }, { t: 19, p: 71, d: 1 }, { t: 24, p: 69, d: 4 }, { t: 28, p: 72, d: 2 },
]);
lead.setChord([69, 73, 76]); // A major, for harmonize demos

console.log(hr("LEAD — the captured phrase (the 'call')"));
console.log(pianoRoll(lead.generate(0, { responseEvery: 0 }), LEN, "original:"));

console.log(hr("LEAD — single transforms (each knob, full amount)"));
console.log(pianoRoll(lead.generate(1, { responseEvery: 1, retro: 1 }), LEN, "retro=1  (rhythmic inversion / time-reversed):"));
console.log(pianoRoll(lead.generate(1, { responseEvery: 1, shift: 0.75 }), LEN, "shift=0.75  (rhythmic displacement):"));
console.log(pianoRoll(lead.generate(1, { responseEvery: 1, invert: 1 }), LEN, "invert=1  (full diatonic melodic inversion):"));
console.log(pianoRoll(lead.generate(1, { responseEvery: 1, invert: 0.5 }), LEN, "invert=0.5  (halfway morph):"));
console.log(pianoRoll(lead.generate(1, { responseEvery: 1, density: 0.8 }), LEN, "density=+0.8  (ornamented):"));
console.log(pianoRoll(lead.generate(1, { responseEvery: 1, density: -0.6 }), LEN, "density=-0.6  (thinned):"));

console.log(hr("LEAD — call & response over 4 loops (responseEvery=2, retro=1, invert=0.6)"));
for (let loop = 0; loop < 4; loop++) {
  const label = (loop % 2 === 0) ? `loop ${loop}  CALL` : `loop ${loop}  RESPONSE`;
  console.log(pianoRoll(lead.generate(loop, { responseEvery: 2, retro: 1, invert: 0.6, shift: 0.25 }), LEN, label + ":"));
}

// ---------------------------------------------------------------- HARMONY
const harm = new HarmonyBrain({ bars: 4 });
const HLEN = harm.len; // 64 steps
const N = (...m) => ({ notes: m });
const chord = { I: [69, 73, 76], IV: [62, 66, 69], V: [64, 68, 71], vi: [66, 69, 73] };
const schedule = [
  ...Array(4).fill(N(...chord.I)), ...Array(4).fill(N(...chord.IV)),
  ...Array(4).fill(N(...chord.V)), ...Array(4).fill(N(...chord.vi)),
]; // 16 beats: I | IV | V | vi (1 bar each)

console.log(hr("HARMONY — comp over I·IV·V·vi (4 bars), rhythm only, notes fixed to chord"));
console.log(pianoRoll(harm.comp(schedule, { density: 0 }), HLEN, "density=0  (sustained block chords):"));
console.log(pianoRoll(harm.comp(schedule, { density: 0.4 }), HLEN, "density=0.4  (on the beat):"));
console.log(pianoRoll(harm.comp(schedule, { density: 0.55, syncopate: 0.6 }), HLEN, "density=0.55 syncopate=0.6  (pushed eighths):"));
console.log(pianoRoll(harm.comp(schedule, { density: 0.7, arp: 1 }), HLEN, "density=0.7 arp=1  (single-note arpeggio, still just chord tones):"));
console.log("");
