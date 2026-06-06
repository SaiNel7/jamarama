# MRT2 one-shot timbre spike — findings

**Question:** Can MRT2, driven with one sustained pitch at high `cfg_notes` (drums off),
emit a clean, pitch-accurate one-shot whose timbre follows a text prompt — good enough
to be a `Tone.Sampler` voice baked **before** the jam from the user's taste?

**Verdict: YES (with two engineering rules).** Reproduce with `engine/oneshot_spike.py`.

## Measured results (target pitch C4 = 261.63 Hz)

| render | detected f0 | pitch err | voiced frac | centroid | flatness |
|---|---|---|---|---|---|
| pad · cfg4 · off | 130.8 Hz | **−12.0 st (octave down)** | 0.97 | 508 Hz (dark) | 0.0001 (tonal) |
| pad · cfg6 · off | 131.6 Hz | −11.9 st | 0.68 | 1991 Hz | 0.0038 |
| punk · cfg4 · off | **261.6 Hz** | **0.0 st** | **1.00** | 2783 Hz (bright) | 0.0001 |
| punk · cfg6 · off | 263.1 Hz | 0.1 st | 1.00 | 3418 Hz | 0.0046 |
| pad · cfg6 · **masked(−1)** | 132.7 Hz | −11.7 st | **0.23** (wanders) | 327 Hz | — |
| punk · cfg6 · masked(−1) | 131.6 Hz | −11.9 st | 0.82 | 2707 Hz | — |

Timbre separation pad-vs-punk (cfg6): **MFCC L2 = 162**, **centroid ratio = 1.72×**. RTF ≈ **2.1–2.2**.

## What this proves

1. **Timbre tracks the prompt — measurably.** "pad" comes back dark/tonal (centroid ~0.5–2 kHz),
   "punk" bright/edgy (~2.8–3.4 kHz). Audible in the A/B files. This is the whole thesis: prompt → voice.
2. **Pitch *class* is reliable; *octave* is not.** punk nailed C4 exactly; the pad dropped to C3.
   The model picks a register that suits the timbre. → **don't trust the requested octave.**
3. **Mask other pitches OFF (0), not masked (−1).** off → voiced 0.97–1.00; masked → 0.23–0.82 and
   pitch drifts. Off = clean monophonic tone.
4. **`cfg_notes ≈ 4` is the sweet spot.** Cleaner/steadier than 6 (higher voiced frac, lower flatness);
   6 is brighter but less pitch-stable. cfg_musiccoca 3.0, temp 1.0, top_k 40, drums=[0], cfg_drums 6.0.
5. **Fast enough to pre-bake at join.** ~1.4 s render in ~0.7 s; a full voice (e.g. 4 pitches) is a few seconds.

## The pre-bake recipe (locked)

For each voice (harmony, lead) and each anchor pitch p in a small set spanning the range
(e.g. C2, C3, C4, C5):

1. `emb = mrt.embed_style(taste_prompt)` (+ optional anchor blend, as the texture engine does).
2. onset call: `notes = [0]*128; notes[p] = 2`, `frames=2`, `state=None`.
3. sustain call: `notes[p] = 1`, `frames≈34`, reuse `state`. Concatenate → one clean attack+sustain.
   Params: `drums=[0], cfg_drums=6.0, cfg_notes=4.0, cfg_musiccoca=3.0, temperature=1.0, top_k=40`.
4. trim leading silence, normalize.
5. **Detect actual f0 with `librosa.pyin` and label the sample by the DETECTED pitch**, not the
   requested one (this neutralizes the octave wandering — `Tone.Sampler` pitch-shifts from ground truth).
6. Emit WAVs + a manifest `{ "C3": "harmony_c3.wav", ... }` → `Tone.Sampler(manifest)` is a drop-in
   for the current `PolySynth`/`MonoSynth` (`host.js:44/53`), same `triggerAttackRelease` API.

## Open follow-ups (not blockers)

- Sample a few pitches per voice and let Sampler interpolate (one render can't cover 4 octaves cleanly).
- Decide loop points for sustained notes (held chords) vs one-shot decay (plucks) — or just render
  ~1.4 s and let the Sampler envelope release handle tails.
- Genre stress-test: render across more prompts (jazz, qawwali, techno) to confirm clean pitch holds;
  fall back to a Stable-Audio one-shot only for any prompt that comes back muddy.
