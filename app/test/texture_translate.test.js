// Room state → MRT2 conditioning: the JS port (texture_translate.js) must condition the cloud bed
// exactly like engine/texture_engine.py conditions the local MLX one. Reference values come from
// running the real Python engine (test/texture_parity.py, fake model that records generate()).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { translate, notesFromPcs, chordNotesVec, styleFor, paramsFor, ANCHOR_PROMPT, DEFAULT_TASTE }
  from "../texture_translate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY = process.env.PYTHON || "python3";

// Random cases for the two notes builders (incl. modes, out-of-range pcs, sevenths, bad romans).
const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B", "H"];
const ROMANS = ["I", "ii", "iii", "IV", "V", "vi", "vii", "bVII"];
const SCALES = ["major", "minor", "dorian", "phrygian", "lydian", "mixolydian", "locrian", "pentatonic", "chromatic", "weird"];
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const pcsCases = Array.from({ length: 150 }, () => [Array.from({ length: 1 + rnd(5) }, () => rnd(30) - 6), rnd(2) === 1]);
const romanCases = Array.from({ length: 150 }, () => [KEYS[rnd(KEYS.length)], ROMANS[rnd(ROMANS.length)], SCALES[rnd(SCALES.length)], rnd(2) === 1]);

let ref = null;
function reference() {
  if (ref) return ref;
  const out = execFileSync(PY, ["-I", join(HERE, "texture_parity.py")],
    { input: JSON.stringify({ pcs: pcsCases, roman: romanCases }), encoding: "utf8" });
  ref = JSON.parse(out);
  return ref;
}
const styleMap = (s) => Object.fromEntries(s.prompts.map((p) => [p.text, p.weight]));
function close(a, b, eps = 1e-6) {
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  for (const k of Object.keys(a)) assert.ok(Math.abs(a[k] - b[k]) < eps, `${k}: ${a[k]} vs ${b[k]}`);
}

test("anchor prompt matches the engine", () => {
  assert.equal(ANCHOR_PROMPT, reference().anchor);
});

test("notes builders match the engine on random cases", () => {
  const r = reference();
  pcsCases.forEach(([pcs, onset], i) => assert.deepEqual(notesFromPcs(pcs, onset), r.pcs[i], `pcs case ${i}`));
  romanCases.forEach(([k, ro, sc, onset], i) => assert.deepEqual(chordNotesVec(k, ro, sc, onset), r.roman[i], `roman case ${i}`));
});

// The engine's own --test sequence: ambient → re-root + energy → lead wakes up.
const SEQ = [
  { key: "A", scale: "major", chord: "I", chordPcs: [], taste: DEFAULT_TASTE, energy: 0, leadActive: false, leadPitches: [], leadPrompt: "" },
  { key: "A", scale: "major", chord: "IV", chordPcs: [], taste: DEFAULT_TASTE, energy: 0.5, leadActive: false, leadPitches: [], leadPrompt: "" },
  { key: "A", scale: "major", chord: "IV", chordPcs: [], taste: DEFAULT_TASTE, energy: 0.5, leadActive: true,
    leadPitches: [76, 79, 83], leadPrompt: "muted jazz trumpet, breathy expressive" },
];
const ONSETS = [true, true, false];

test("full conditioning matches the engine's generate() calls (ambient, energy, lead modes)", () => {
  const calls = reference().calls;
  assert.equal(calls.length, 3);
  SEQ.forEach((st, i) => {
    const c = translate(st, { onset: ONSETS[i] });
    const py = calls[i];
    close(styleMap(c.style), py.style);
    assert.deepEqual(c.notes, py.notes, `notes call ${i}`);
    assert.equal(c.params.cfg_notes, py.cfg_notes);
    assert.equal(c.params.cfg_musiccoca, py.cfg_musiccoca);
    assert.equal(c.params.cfg_drums, py.cfg_drums);
    assert.deepEqual([c.params.drums], py.drums);
    assert.ok(Math.abs(c.params.temperature - py.temperature) < 1e-6);
    assert.ok(Math.abs(c.params.gain - py.gain) < 1e-6, `gain ${c.params.gain} vs ${py.gain}`);
    assert.equal(c.params.preset, "jamarama_texture");
  });
});

test("style weights always sum to 1 and degrade sensibly", () => {
  for (const [taste, lead, lp, e] of [[["a"], false, "", 0], [["a", "b", "c"], true, "lead", 1], [null, false, "", 0.3],
    [[], true, "", 0], [["a"], true, "a", 0.5]]) {
    const s = styleFor(taste, lead, lp, e);
    const sum = s.prompts.reduce((x, p) => x + p.weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-5, JSON.stringify(s));
    assert.equal(new Set(s.prompts.map((p) => p.text)).size, s.prompts.length);   // duplicates merged
  }
  assert.deepEqual(styleFor(null, false, "", 0).prompts, [{ text: ANCHOR_PROMPT, weight: 1 }]);
});

test("exact chord pcs (7ths, modal) win over the roman triad; lead pitches are sustained", () => {
  const st = { key: "D", scale: "dorian", chord: "ii", chordPcs: [4, 7, 11, 2], energy: 0, leadActive: true, leadPitches: [88, 200, -3] };
  const n = translate(st, { onset: true }).notes;
  assert.deepEqual(n.map((v, i) => (v >= 0 ? [i, v] : null)).filter(Boolean), [[62, 2], [64, 2], [67, 2], [71, 2], [88, 3]]);
  assert.equal(paramsFor({ energy: 2 }).gain, 0.62);       // energy clamped for gain (engine clamps too)
});
