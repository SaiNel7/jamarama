# Jamarama — Per-Instrument Pipeline Analysis & Improvement Plan

Deep trace of each instrument through **genre → prompting/samples → local (phone) → host**, plus the Magenta sample-creation pipeline and a multi-layer proposal. All findings cite `file:line`. Analysis only — no code changed.

---

## Two corrections to the mental model (read first)

These reframe the whole effort:

1. **Bass and drums have NO phone player.** Only **harmony** (chord wheel) and **lead** (looper keyboard) are human-controlled. Roles are assigned server-side and only ever hand phones `harmony` / `lead` / `crowd` (`server.js:128-133`). Bass and drums are generated 100% host-side.

2. **The "next 4 bars, else loop" constraint only applies to harmony and lead.** Bass (`host.js bassTick:417`) and drums (`host.js onSixteenth:319`, `grooveStep`) are **recomputed every 16th from live state** — they react instantly to chord, feel, and the host XY pad. They never "loop unchanged waiting for a decision." So all in-the-moment bass/drum improvements are free of the lookahead constraint and take effect immediately.

The single most surprising gap: **the crowd cannot currently affect bass or drums at all.** Crowd `energy`/`mood` feeds harmony complexity (`host.js:381`) but bass passes raw `groove.x/y` only (`host.js:428`), and drums read only `groove.y`. The plumbing (`st.energy`, `st.mood`) already exists.

---

## Shared architecture

- **`genres.js`** — deterministic genre KB. Per genre: `voices.{bass,drums,harmony,lead}` (timbre prompt strings), `affinity.*` (0..1, used for fusion slot assignment), `progression` (roman numerals), `QUALS` (chord qualities), `FEEL`/`TEMPO`. `fuseGenres` (`:421-453`) builds a fusion: harmony progression+quals from the most harmony-defining genre, feel+tempo from the most drum-defining genre, each voice timbre from its highest-affinity genre.
- **`taste.js arrangeJam`** — optional Claude "expert" rewrites only the four **timbre prompt strings** (`taste.js:104-129`). It NEVER touches structure (progression/quals/feel/scale stay deterministic, `taste.js:158-162`). Cached by sorted taste-set (`taste.js:80`).
- **`prebake_voices.py`** — bakes MRT2 one-shots → WAVs → `manifest.json` → `Tone.Sampler`. Runs at jam start at `nice -n 15` (`server.js:213`); `NO_PREBAKE=1` falls back to built-in synths.
- **`brain/`** — `groove.js` (bass + drum + comp step functions, the real generative engine), `harmony.js`, `lead.js`, `transforms.js`, `theory.js`.
- **`host.js`** — owns the Tone.Transport clock; plays ONLY the generative result, never a raw echo of phone input.

---

## BASS

Fully autonomous host voice. No player. Driven by (chord from harmony player, genre feel, host XY pad).

- **Genre.** Timbre prompt per genre (`genres.js:33-319`). Bass *line* is NOT in the KB — it comes from `feel`, and `feel` is chosen by **drum** affinity, not bass affinity (`fuseGenres:434-450`). **Bug:** a jazz+house room can give an upright-bass *timbre* playing a four-on-the-floor house *line* (voice and line disagree).
- **Samples.** Prompt `manifest.json:67`. Bass is special-cased: `BASS_ANCHORS=[24,28,31,36,40,43,48]`, grid C1–C4, `keep_attack=True` (preserves pluck), 3 variations, HP35/LP2500 at −13 dB into ducked `bassBus`. All one-shots are single sustained notes — **no articulation set** (funk ghosts and jazz walks reuse the same sustained sample).
- **Local.** None — re-derived every 16th by `groove.js bassStep(feel, sub, bar, x, y, chord, nextChord)` (`:166-230`). Genuinely genre-shaped: swing→walking (uses `nextChord`), funk→octave-pop+ghosts, fourfloor→pump, trap→808 sub, plus reggae/latin/boombap/etc. Reacts instantly to chord + feel + host XY. Does NOT react to crowd mood/energy. Walking bass is identical every loop (no per-bar reseed despite `bar` being available).
- **Host.** `bassTick` (`:417-434`), monophonic, gated on `effectiveSchedule()` so **bass is silent until the harmony player draws** — hollow low end until first draw. Sidechain-ducks under kick/snare (`duckBed:335`).

**Top bass improvements**

| # | Change | Effort | Why |
|---|--------|--------|-----|
| 1 | Feed crowd energy+mood into bass `x`/`y` in `bassTick:428` (mirror harmony's `0.3*energy`) | Trivial | Closes the biggest gap — crowd currently can't touch bass at all |
| 2 | Derive a `bassFeel` from `affinity.bass`, not the drum `feel` | Low | Fixes voice/line mismatch |
| 3 | Pre-progression root pedal (fall back to `st.progression` instead of silence) | Low | Removes hollow low end before first draw |
| 4 | Per-bar walking/funk variation using the already-passed `bar` arg | Low | Jazz loop currently note-identical every cycle |
| 5 | Mood→register/density (heavier→sub octave + doublings, dreamier→sparse) | Low-Med | Tangible crowd control of low end |
| 6 | Bake a 2nd short/muted bass articulation + flag from `bassStep` | Medium | Real funk-ghost / staccato feel |

---

## DRUMS

Fully autonomous host voice. No player. Driven by host XY pad + genre feel.

- **Genre.** Three deterministic fields: `feel` (`FEEL`, 11 feels), `tempo` (`TEMPO`), drum prompt. Fusion is drum-specific (groove from highest drum-affinity genre, intentionally independent of harmony leader). Many genres collapse to a shared feel (soul/gospel→funk, disco/synthwave→fourfloor, country/pop/rock→backbeat). Expert LLM only rewrites the prompt, never swing/density.
- **Samples.** Completely different path: render ~8s continuous groove (`render_drum_groove`), then `chop_drums` auto-extracts a kit — onset-detect, spectral fingerprint per hit, **KMeans k=3** → kick/snare/hat (genre-relative), keep best 3 exemplars each, gate/shape/normalize. **Only ever 3 classes** — no ride, tom, clap, or open-hat captured even when the groove plays them. No velocity layers (ghost and accent snare = same buffer at different gain).
- **Local.** None — `groove.js grooveStep(feel, sub, bar, x, y)` + the `FEELS` table (`:19-125`), called every 16th. `x` (complexity) reshapes pattern (syncopation, ghosts, 16th hats); `y` (energy) scales velocity. **The only phrase-aware element in the entire engine** is backbeat's end-of-phrase fill (`groove.js:28`, `bar%4===3`). Every other feel loops forever with no fill. With a fixed pad the groove is **bit-for-bit identical every bar** — no humanization, no bar-to-bar variation.
- **Host.** Renders instantly; swing applied band-wide via `swingOffsetSec` (`:352`). Kick/snare drive the sidechain pump. Kit balance (`voices.js:47` levels) is fixed regardless of genre; `hit()` picks a **random** buffer (not velocity-based).

**Top drum improvements**

| # | Change | Effort | Why |
|---|--------|--------|-----|
| 1 | Add phrase-end fills to every feel (`bar%4===3`), not just backbeat | Low-Med | #1 "alive vs loop" win; pattern + `bar` arg already exist |
| 2 | Velocity humanization + micro-timing jitter (seed from `bar`+`sub`) | Low | Kills the robotic bit-identical-every-bar feel |
| 3 | Bake velocity layers (soft/hard); select by velocity not random | Medium | Ghost vs accent become different strikes, not gain |
| 4 | Capture ride + open-hat (k=4/5), genre-gated | Medium | Jazz ride / disco open-hat are lost today |
| 5 | Per-genre kit balance + energy-scaled sidechain depth | Low | Brush jazz vs trap want very different balances |
| 6 | Fold crowd energy into drum `y` | Low | Room can drive intensity |

---

## HARMONY

The only voice with a true human controller (chord wheel). Currently a prebaked grand piano.

- **Genre.** Strong static blueprint: `progression` + `QUALS` (jazz→m7/7/maj7, blues→all 7, etc.) + comp rhythm via `feel`. Real fusion (jazz ii-V-I over a funk comp). But one fixed 4-chord loop per genre; never evolves; no register/density/voicing fields in the KB.
- **Samples.** `n_var=1` (one coherent chord timbre — multiple variations read as mud). `keep_attack=False` → effectively attack-less sustain (loses the piano "thunk"). Aggressive de-mud (`clean_pitched`). One static timbre, no velocity layers.
- **Local (chord wheel).** Genre-seeded palette + default loop (`seedFromProgression`). Player draws/edits a loop; local oscillator preview of the raw chord only (no comp groove preview). **Sends only `chordMidiNotes(root, qual, 4)` — fixed root-position block chords at octave 4** (`controllers.js:409`). All voicing/register info is discarded before the host sees it.
- **Host (generative comp).** Never echoes drawn chords. `harmonyTick` regenerates the comp **only at loop boundary or on edit** (true 4-bar lookahead). `compStep` gives genre-true rhythms (reggae skank, funk 16ths, house off-beat stabs, jazz syncopation, latin montuno arp). Density/energy track groove X/Y + crowd energy. **But: pitches stay the exact block chord — no inversion, no voice-leading, no added/dropped tones.** And `HarmonyBrain.comp` accepts a `loop` index (`harmony.js:13`, passed `harmonyIdx++` from `host.js:392`) but **never uses it** → every loop is byte-identical.

**Top harmony improvements**

| # | Change | Effort | Why |
|---|--------|--------|-----|
| 1 | Voice-leading + inversions in `HarmonyBrain` (re-voice to minimize motion; drop root for jazz since bass covers it) | Medium | Biggest musical win — turns stamped triads into a real player. Deterministic per loop, respects lookahead |
| 2 | Per-genre `harmonyVoicing` KB field (rootless+tensions / wide spread / tight stab / open) | Medium | Makes harmony *read* as the genre, not just the rhythm |
| 3 | Use the ignored `loop` index for per-loop variation via `rng(loop)` | Low | Removes "identical every 4 bars" staleness; tiny change |
| 4 | Velocity-layered harmony samples; `MultiSampler` selects by velocity | Medium | Comp already outputs velocity — instant dynamics |
| 5 | Genre chord-substitution table (tritone sub, quick-IV, vi/iii swaps) | Medium | Adds the harmonic motion genres are known for |

---

## LEAD

Melodic/solo voice (default "muted jazz trumpet" = Harmon-mute timbre, not silenced). Human-controlled live looper. Plays at −9 dB, audible only once a phrase is recorded.

- **Genre.** Timbre prompt only. **No genre-specific musical behavior** — nothing specifies lead phrasing, register, density, ornamentation, or call-and-response. This is the standout gap: bass/drums/harmony all get genre-shaped patterns; lead does not. Scale (major/minor) is shared room-wide.
- **Samples.** `keep_attack=True` (preserves breathy bloom). 3 variations chosen **at random** per note, uncorrelated with dynamics/register — just three near-identical cuts.
- **Local.** Live looper keyboard locked to the song scale; local sawtooth feedback; OVERWRITE/LAYER/CLEAR. The brain (`lead.js`) lives host-side: call/response via `responseEvery` (even loops faithful, odd varied), rhythmic transforms (retrograde/rotate/ornament/thin), pitch transforms (diatonic invert/transpose), `harmonizeToChord` consonance-lock on strong beats — **all in diatonic degrees** so it stays in key.
- **Host.** Plays the remixed `playLoop`, never raw taps. `leadGenerate` at each loop boundary. **`leadParams()` is genre-blind** — driven only by the host `leadWild` slider, never `st.feel`. Chord for harmonization is captured **once per loop** (`host.js:489`), so a mid-loop chord change doesn't re-target. Lead also seeds the MRT2 texture bed.

**Top lead improvements**

| # | Change | Effort | Why |
|---|--------|--------|-----|
| 1 | Drive `leadParams()` from `st.feel` (per-feel ornament/shift/density bias) | Small | Closes the biggest gap — lead is the only genre-blind voice |
| 2 | Per-beat chord re-targeting in `harmonizeToChord` (use the beat-indexed schedule) | Small-Med | Makes the lead actually solo over the changes |
| 3 | Genre-aware ornament vocabulary (jazz enclosures, blues slides, trance octave leaps) | Medium | Phrasing lives in ornamentation; today all genres ornament identically |
| 4 | Motif development (response N = transform of N−1) instead of re-randomizing | Medium | Turns a looping remix into a building solo |
| 5 | Variation rotation by velocity/register (needs meaningful-axis re-bake) | Medium | Soft breathy on weak beats, brassy bloom on accents |
| 6 | Phrase-contour velocity (accent strong beats, soften ornaments) | Small | Flat `v:0.9` is a big part of why loops feel mechanical |

---

## Magenta sample-creation pipeline

### Today
- Spawned at jam start, `nice -n 15`, swallows failure (`server.js:213-252`). Model loads ~0.5s warm.
- **Pitched voices** (`bake_voice`): embed prompt+`CLEAN_SUFFIX`; per anchor a 2-call onset→sustain chain sharing state; mask other pitches **OFF (0, not -1)** for a clean mono tone (the key spike finding); detect octave with `librosa.pyin` and relabel (octave unreliable); quality-gate on voiced/flatness; cut variations; phase-vocoder fill the grid every 4 semitones; de-mud (DC + HP below fundamental). Harmony `n_var=1` attack-less; lead/bass keep attack, 3 variations.
- **Drums** (`bake_drums`): render ~8s groove → onset-detect → spectral fingerprint → KMeans k=3 → keep best 3 exemplars each → gate/shape/normalize.
- **Cost:** `built_s: 42.91` for a full 4-instrument bake. ~50 serial `generate()` calls on the single MLX thread.
- **Bottlenecks:** (1) serial 70-frame (2.8s) sustain rendering dominates; (2) per-render librosa CPU starved by `nice -n 15`; (3) 8 anchors render then collapse to ~1-3 distinct pitches — much generation discarded then the grid is synthesized anyway; (4) no persistence — every jam re-bakes from scratch.

### Optimizations (ranked)
1. **Persist/cache bakes** keyed by a hash of the 4 prompts + params, under `app/public/voices/<hash>/`. The bake is a pure function of the prompts (already cached at `arrangeJam`). Cache hit → instant, zero generation. Biggest win, lowest risk.
2. **Fewer/adaptive anchors** — render 3-4 well-spaced (or render one, detect octave, fill missing registers). Cuts pitched calls ~40-50% since they collapse anyway.
3. **Shorter sustain** — `SUSTAIN_FRAMES 70→~40` where `n_var≤3`; ~40% per-voice cut, verify gates still pass.
4. **Off-thread librosa** — run pyin/flatness/mfcc/pitch-shift in a `ProcessPoolExecutor` while the next render generates (overlap GPU/ANE with CPU).
5. **Move the bake into the warm texture-engine process** instead of spawning a fresh Python (saves MLX import + JIT; it already keeps a resident model).
6. **Milder nice / pin librosa to efficiency cores** — `nice -n 15` is aggressive for a user-visible gate; measure first.
7. **Quality:** cross-fade two neighbors in `fill_grid` (or `GRID_STEP 4→3`) to reduce phase-vocoder artifacts on octave-collapsed voices.

### Multi-layer proposal (2 tonal + 2 texture per instrument)
- **Concept:** Tonal A (core), Tonal B (octave-up/HP-separated for richness), Texture 1/2 (pitch-agnostic washes gated/enveloped to the note). Essentially baking what `texture_engine.py` already produces as note-aligned one-shots.
- **`prebake_voices.py`:** Tonal B reuses `bake_voice` with a variant prompt; texture layers reuse the beatless texture pipeline as **one shared sustained one-shot per instrument** (pitch-agnostic, so 1 file, not a grid). Store an explicit envelope spec + per-layer `gain` in the manifest. Cost roughly doubles the pitched generation → makes caching/anchor/sustain optimizations **prerequisites**.
- **`manifest.json`:** add a backward-compatible `layers[]` array (`{role, gain, env, variations|file}`); keep top-level `variations` mirroring `layers[0]` so un-upgraded hosts still play the core.
- **`voices.js`/`host.js`:** `MultiSampler` → `LayeredVoice` with the same public surface (`triggerAttackRelease/connect/volume/dispose`) so brain code is untouched. Tonal layers = Samplers; texture layers = looped player + `AmplitudeEnvelope` triggered with the same `time`. All baked transients are at sample[0], so layers start phase-aligned. Per-layer `gain` from manifest; harmony/bass texture → ducked bus, lead texture → un-ducked.
- **Tradeoffs:** polyphony explosion (mitigate: texture = 1 shared mono bed per instrument, not per chord note); muddiness (mitigate: Tonal B octave-up + HP, texture LP'd, verify with existing `sub_energy`/`tonal_flatness`); phase comb-filtering (mitigate: spectral separation + slight detune); bake time (mitigate: optimizations above + share texture across range). Reuse `sweep_blend.py`/`sweep_prompts.py` harnesses to tune blends.

### Recommended path
1. Ship caching first (de-risks all added bake cost).
2. Trim the existing pipeline (anchors, sustain, off-thread librosa) to get a full bake well under ~25s.
3. Add **one shared texture layer per instrument** first (cheap, big payoff, low mud risk) via the backward-compatible schema.
4. Add Tonal B last (highest mud + CPU cost), octave/HP-separated, `n_var=1`, only if texture proved out.

---

## Cross-cutting roadmap (highest leverage first)

**Near-free wins that close real gaps:**
1. **Route crowd energy+mood into bass and drums** (`host.js:428` and drum `y`). Plumbing exists; crowd currently can't touch either.
2. **Wire `leadParams()` to `st.feel`** — make the only genre-blind voice genre-aware.
3. **Use the ignored harmony `loop` index** for per-loop variation.
4. **Add phrase-end fills to every drum feel** (pattern + `bar` arg already there).
5. **Fix `bassFeel`** to come from bass affinity, not drum affinity.

**Medium musical wins:**
6. Harmony voice-leading + inversions + per-genre voicing.
7. Lead per-beat chord re-targeting + genre ornament vocabulary + motif development.
8. Per-bar/per-loop variation + velocity humanization across all voices.

**Sample pipeline:**
9. Cache bakes; trim anchors/sustain; off-thread librosa.
10. Velocity layers (drums, harmony, lead) — recurring theme across all four.
11. Then layered voices (texture-first).
