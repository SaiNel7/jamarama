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

## Production pipeline (engine/prebake_voices.py) — what the follow-ups resolved to

The spike above proved the thesis; these are the engineering rules the shipped pre-bake added on
top, each measured the same empirical way (analysis in this dir / verified live in headless Chrome).

1. **Octave collapse is real for dark timbres — beat it with a class-spread + octave-fill, not more
   trust in the requested octave.** A pad requested at C2/C3/C4/C5 collapses to ~one register
   (first run: everything landed on G2). Fix that actually worked: request a spread across BOTH
   octaves AND pitch *classes* (C2 G2 C3 G3 C4 G4 C5 G5) — pitch class is reliable, so this harvests
   distinct detected registers in one pass (a "warm pad" now yields real samples spanning **A1–G5**).
   Then DEDUP by detected pitch (keeping the higher-voiced render on a collision) and **fill a 4-st
   grid (C2..C6) by phase-vocoder pitch-shifting the nearest real sample** (librosa, duration-
   preserving) so Tone.Sampler never resamples more than ~4 st → minimal artifact + minimal tempo
   drift. Gate renders with `voiced < 0.15` (detection failed → label unreliable).

1b. **FFT de-mud per pitch (every sample).** MRT2's dark/pad renders carry a DC/near-DC offset
   from the decoder AND sub-fundamental rumble below the note — inaudible alone, but they pile up
   when 3 chord notes stack into a "muddy layer." Measured before fix: harmony C2/E2 had 25–31% of
   energy *below* the fundamental and several samples peaked at ~0 Hz (DC). `clean_pitched(x, f0)`
   strips DC and high-passes at 0.8·f0 (just under the fundamental, tuned per note), then we re-check
   with an FFT (`sub_energy`). After: DC → 0, sub-fundamental 0.003–0.095 (worst harmony 11%, lead/
   bass 2%). The note itself is untouched; only the junk under it is removed.

2. **Tempo safety = transient at sample[0].** Tone.Sampler repitches by playback rate, so ANY
   leading silence stretches when a note is pitched down and the attack lands late → the groove
   smears. `tight_onset()` cuts to the foot of the transient (RMS crosses −40 dB below peak, −2 ms
   pre-roll) with a 1 ms raised-cosine fade-in. Every voice variation and drum hit starts sounding
   at sample 0 (verified: drum peaks land within ≤9 ms of start, strong first-5 ms RMS).

3. **Variations for flair — but SUPER SIMILAR.** One long render is cut into 3 windows, ALL from the
   settled steady-state region (skip the attack and the tail), spread over only ~120 ms so they're
   near-identical. Earlier the cuts were spread across the whole body, so v0 (attack region) was
   bright/noisy and very different from the steady cuts (measured: MFCC dist v0↔v1 ≈ 342–536, C5 v0
   flatness 0.227 vs 0.002) — and because the host picks a variation *per note*, a chord became an
   incoherent mix of a noisy attack-cut and clean cuts → the "noise from the chords." Now all three
   are nearly identical (MFCC dist 4–55, flatness consistent). Belt-and-suspenders: `MultiSampler`
   uses ONE variation for a whole chord (all notes sharing a trigger `time`), so a chord is never a
   mix; a new time picks a fresh variation for flair.

4. **Drum kit = auto-chop, classified RELATIVELY.** Drive `drums=[1]`, notes off, high `cfg_drums`
   for a pure groove; detect onsets (backtracked, double-triggers within 40 ms dropped); then
   **cluster the hits (KMeans, log-centroid + zcr + flatness + high/low + bandwidth) and label the
   clusters by ascending spectral centroid → kick / snare / hat.** Absolute thresholds DON'T transfer
   across genres (a boom-bap kit is dark everywhere → everything scored as "kick"); relative
   clustering gives a balanced kit on any prompt (boom-bap groove → kick ~1.1 kHz, snare ~2.2 kHz,
   hat ~4 kHz). Keep the loudest, most-representative, fastest-attack exemplars per type;
   `drum_snap()` pulls any slow swell up to its transient for punch. The host fires a random
   variation per hit through a one-shot buffer source (overlap-safe), with a baked kit balance
   (kick 1.0 / snare 0.7 / hat 0.4).
   - **Peak-at-the-very-start + a real gate (strict separation).** Measured: a hit's loudest sample
     can sit 1–170 ms into the raw slice, so `peak_to_front()` cuts to ~0.3 ms before the peak (sub-ms
     anti-click fade) → the loudest sample lands within <0.6 ms of sample[0], guaranteed. Then
     `drum_gate()` hold-gates the tail at **−40 dB** (the empirical optimum: decay analysis showed
     −40 dB keeps all audible decay yet always closes BEFORE the next onset in the groove), requiring
     the envelope to stay below for 6 ms so a momentary dip can't cut early; capped to the per-type
     max length. Exemplar ranking also prefers hits with a big gap to the next onset, so kicks capture
     their full natural decay. Result: peaks at 0.17–0.58 ms, gated tails −38 to −49 dB, no inter-hit
     bleed.
   - **Force a perc SHAPE on every hit.** MRT2 grooves bleed sustained/tonal content between
     transients, so a raw onset-to-onset slice often comes back as a held tone, not a hit
     (measured: snares 267–280 ms with tail/head energy ~0.75; one "hat" tail LOUDER than its
     head at 1.11). `shape_perc()` measures drum-shapedness (tail/head RMS); if it exceeds
     `SUSTAIN_MAX` (kick/snare 0.35, hat 0.30) it multiplies by an exponential decay (tau
     0.06/0.045/0.02 s) — the transient at sample[0] is preserved (env≈1 there) while the tail is
     driven down — then trims the dead tail at −45 dB so nothing is left "too long." Already-
     percussive hits (e.g. a clean kick at 0.30) are left untouched; candidate ranking also
     prefers low-sustain hits so forcing is the exception, not the rule. Result: all 9 exemplars
     come out drum-shaped (sustain <0.35, 60–155 ms) regardless of how muddy the source groove is.

Manifest schema is `{ sr, voices:{harmony,lead,bass:{prompt, variations:[{note:file}...]}}, drums:{prompt,
kick:[file],snare:[file],hat:[file]} }`. host.js/voices.js consume it as a pure drop-in (synths /
synth-drums remain the fallback when no prebake exists).

## Mix bus — per-stem EQ + sidechain (the chord "noise" was the pad's >3 kHz hash)

Spectral band analysis (measure, don't guess) showed the persistent chord noise was the harmony
itself: **~70% of the raw pad energy sits above 3 kHz with high-band flatness 0.67–0.78** — i.e. for
a 130–330 Hz pad that's the 25th–60th harmonic, which is hash/noise, not music. Bass energy is 95%
under 300 Hz (correct); lead is clean and mid-forward. So the mix (host.js `initSynths`) is:
- **Per-stem EQ** (`Tone.Filter`): harmony HP 150 + **LP 3.2 kHz (−24)** ← the decisive de-noise, kills
  the pad hash; bass HP 35 / LP 2.5 k (round, no fizz); lead HP 220 / LP 9 k (present mids); drums HP 35.
- **Sidechain**: harmony + bass route through `bedDuck`, dipped on every kick/snare (kick →0.5/180 ms,
  snare →0.7/120 ms) via gain automation synced to the scheduled hit time — no audio detector needed.
  Lead + drums bypass the duck (melody stays steady; drums drive the pump). Verified live: bed gain
  pumps 1.0↔0.59, master peak 0.73 (no clip).

## Mix bus — the "noise + low end" was CLIPPING (measured, not guessed)

A reported "noisy synth / noise + low end" turned out NOT to be any sample. Per-stem AnalyserNode
capture of the live graph (puppeteer) showed the **master bus peaking at 1.082 and the drum bus at
1.088 — both >1.0, i.e. the output was digitally CLIPPING**, and clipping a low-heavy mix is exactly
what reads as harsh noise. Root cause: per-stem gains had no headroom, so kick + bass + a chord hit
landing on the same downbeat summed past 0 dBFS. Fixes in host.js: (1) a brickwall **`Tone.Limiter(-1)`
on the master** as a hard safety net; (2) headroom — `drumBus` 0.7, harmony −12→**−5 dB** (it was also
far too quiet: peak 0.316), bass −7→−11 (it's the loudest/lowest stem, rms 0.11, 41% sub). After:
master peak 0.93 / drums 0.58, **no clipping**, harmony ~2.5× louder, master sub-energy 0.18→0.07.

Two verification lessons (both "measure, don't guess"): the live texture wash is **tonal** (flatness
0.00), not the noise; and a crude full-FFT flatness metric FALSELY flagged two lead samples as noisy —
**librosa's `spectral_flatness`** (the standard) showed them at 0.00 (clean). The prebake now gates
renders at `MAX_FLATNESS` 0.35 (pads read ≤0.16) so genuine noise renders are dropped, with no false
rejects. Sample-start rule is enforced everywhere: drum buffers `start(time, 0)` and samplers use
`attack: 0`, so every onset lands on the beat regardless of repitch.

## Open follow-ups (not blockers)

- Genre stress-test: render across more prompts (jazz, qawwali, techno) to confirm clean pitch +
  a balanced auto-chopped kit; fall back to a Stable-Audio one-shot only for prompts that come back muddy.
- Loop points for very long held chords (current ~1.4 s windows + Sampler release cover most cases).
- If a kit type is sparse in the groove (e.g. muffled hats), consider a second drum render with a
  brighter prompt to enrich that one cluster.
