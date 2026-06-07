# Deep Dive — Chords, Lead, Texture (verification-first)

Every claim below was **executed**, not assumed. JS brain modules were run via Node harnesses (`/tmp/harm_harness.mjs`, `/tmp/leadtest/*`, etc.); the texture engine was traced through the real spawn→WS→sounddevice path with dependency/API checks against the installed MRT2. Bugs include repro evidence and `file:line`.

The three subsystems sit at very different maturity levels:
- **Chords:** strong *rhythm* engine, harmonically inert *pitch* engine. 4 confirmed bugs.
- **Lead:** a deterministic *variation toy*, not a soloist. 8 confirmed bugs, including clock mismatches.
- **Texture:** thoughtful, genuinely genre-wired design — but **never verified to actually run**, ~1–6 s reaction latency, and completely outside host mix control. 9 issues.

---

## 1. CHORDS / HARMONY

### Verified working (executed)
- `chordMidiNotes` intervals are correct for all 11 qualities: `Cmaj7`→`[60,64,67,71]`, `G7`→`[67,71,74,77]`, `Cm7b5`→`[60,63,66,70]`. No NaN for any input.
- `buildSchedule` expands to exactly 16 slots; short progressions pad by repeating last, long ones truncate. No off-by-one.
- `compStep` rhythms are genuinely genre-distinct and x/y-reactive (swing syncopation, funk 16th stabs, fourfloor offbeats, reggae skank, latin arp, sparse/trap pads) — verified by running `HarmonyBrain.comp` over a 64-step schedule for 8 feels. **This is real genre intelligence and the strongest part of the harmony system.**
- Silence gate works exactly: 64 ticks with empty `effectiveSchedule()` → 0 notes. Sound only after the player draws.
- All `QUALS` arrays are length-matched to their progressions and every quality id resolves (no silent triad fallbacks).

### Confirmed bugs (executed repro)
- **H1 — Every loop is byte-identical; `loop` param is dead code. (HIGH, musical.)** `harmony.js:13` `comp(schedule, params, loop=0)` never references `loop`. `host.js:392` passes `harmonyIdx++` (verified incrementing 0→1→2) with zero effect. Running `comp(loop=0/1/2)` gave byte-identical output; 3 full transport loops (192 ticks) → identical 48-event output each loop. A 5-min jam repeats the same comp ~75×.
- **H2 — No voicing / inversions / voice-leading. (HIGH, musical.)** `pickTones` (`harmony.js:44-48`) returns the raw chord; `controllers.js:39` always builds root-position blocks at octave 4. Executed ii-V-I-vi voice motion: top voice leaps C5→F5→B4→G5, roots jump by 4ths/5ths, zero common-tone retention.
- **H3 — Chord changes inaudible in arp/single-note feels. (MEDIUM.)** `harmony.js:27` forces a hit on chord change, but `pickTones` still returns one note when `arp>=0.66`. Latin at the I-change (step 16) emits only `D5` — the new chord is unhearable.
- **H4 — `scale:"minor"` genres don't actually use a minor center. (MEDIUM, design.)** `diatonicSlot` (`controllers.js:40-44`) computes every roman against the MAJOR scale. House "vi IV I V" in key A → F#m, D, A, E (a vi-rooted *major* progression), not A-minor. `scale:"minor"/key:"A"` only affects the lead keyboard/readout, never chord roots. There are no minor roman numerals anywhere.

### Strong redesign proposals
1. **Voice-leading engine (highest impact, M).** New `voiceLead(prevVoicing, targetChord, range)` in `harmony.js`: enumerate inversions/octave placements within a tessitura (~MIDI 55-76), pick the voicing minimizing total semitone motion with a common-tone bonus. Replace the raw passthrough at `harmony.js:44`. Fixes H2.
2. **Per-loop development via the dead `loop` param (S-M).** Make `comp` consume `loop`; seed `rng(loop)`; thin early/thicken later, add a last-bar turnaround/fill every Nth loop, occasionally drop out for call-and-response with the lead. Fixes H1, no host change needed.
3. **Genre voicing grammars (M).** A `VOICINGS` table parallel to `compStep`: jazz rootless 3-7-9/7-3-13 (drop root, bass covers it), funk tight stab clusters, house wide 4-note spread, gospel close-position upper triads. Consumed by the voice-leader.
4. **Tension/extension policy (S).** Let the engine *add* color tones the player didn't draw, gated by genre + complexity (jazz +9/13, ambient +add9/sus), kept in-key via `theory.js`.
5. **Substitutions & turnarounds (M-H).** Last-chord tritone subs / ii-V inserts for jazz/blues/soul, chosen by `rng(loop)` so they appear intermittently.
6. **Resolve the minor-key inconsistency (S-M).** Either add real minor roman support + author minor progressions, or drop the misleading `scale:"minor"/key` and document that those genres use vi-rooted major loops.

---

## 2. LEAD

### Verified working (executed)
- All transforms do what their names claim (before→after proven): retrograde, rotate (with wrap), transposeDia (stays in key), diatonicInvert (mirror around axis; `frac` = fraction of notes flipped), thin (drops weak beats first, keeps ≥1), ornament (midpoint passing/neighbor at v:0.6), harmonizeToChord (pulls strong beats to chord tones). No out-of-range MIDI or negative times in any tested case; empty phrase → `[]`.
- Call/response structure is real: with `responseEvery=2`, loops 0/2/4 are identical CALLs, 1/3/5 are distinct RESPONSEs.
- Quantization + latency comp math is reasonable (subtract latency, then quantize to step).

### Confirmed bugs (executed repro)
- **L1 — Re-randomizes off the ORIGINAL every loop; no development. (HIGH, musical.)** `lead.js:39` `clone(this.phrase)` — every `generate()` starts from the original; prior output is never fed back. loop 3 has no memory of loop 1. It is a variation generator, not a soloist.
- **L2 — Genre-blind. (HIGH, musical.)** `leadParams()` (`host.js:463-470`) reads **only** `leadWild` (set in exactly 2 places: default `0.3` and the slider). `st.feel` is never read anywhere in the lead path. Genre contributes only major/minor scale + the harmonize chord. Two different genres produce identical lead behavior at the same wildness.
- **L3 — Degenerate seed on loop 0. (MEDIUM.)** `host.js:466` sets `responseEvery:1` so loop 0 is a response, seeded `rng(1)` whose first draw is 0.0000629; the retro gate `r() < p.retro` therefore **always** retrogrades loop 0 whenever retro>0. The first loop is biased every session. Fix: seed `rng(loop*0x9E3779B9 + …)` and discard the first draw.
- **L4 — AUTO_LOCK silence timer mixes two clocks. (MEDIUM.)** `host.js:539` compares `s16` (look-ahead scheduler counter) against `lastNoteStep` set from `nowStep()` (real transport). Auto-lock fires earlier than one true bar, with jitter.
- **L5 — Playhead phase mixes clocks too. (MEDIUM, timing.)** `host.js:541` `ph = (s16 - loopStart) % loopLen` but `loopStart` came from `nowStep()`; recording used `nowStep`-based `rel`. Playback is offset from where notes were recorded by the look-ahead amount.
- **L6 — harmonize applied even at wildness 0. (MEDIUM.)** `harmonizeToChord` is outside the `isResponse` block (`lead.js:55`) and `leadParams` hardcodes `harmonize:0.4` regardless of wildness. So "wildness 0 = faithful loop" is false — strong beats are always nudged, breaking overdub coherence.
- **L7 — Fractional harmonize is a dead parameter. (LOW-MED.)** `transforms.js:75` rounds toward the target producing out-of-scale pitches (D5→A#4 at frac 0.5), which the host's post-snap (`host.js:492`) then quantizes back — so partial harmonize moves are discarded.
- **L8 — Non-major/minor scales silently treated as MAJOR. (MEDIUM.)** Lobby offers dorian/lydian/mixolydian/pentatonic/chromatic etc. (`host.js:599`), but `scaleNotes` (`shared.js:56`) and the host snap (`host.js:491`) fall back to MAJOR for anything not literally `"minor"`. A lydian/pentatonic jam plays the lead in major.
- Also: velocities are effectively flat (recorded notes hardcoded `v:0.9` at `host.js:530`, ornaments `v:0.6`); lead is monophonic (`MonoSynth`, `host.js:113`) so same-step notes collide.

### Strong redesign proposals
1. **Per-beat chord-following (M, biggest musical win; fixes L6/L7).** Replace the single `setChord` with the beat-indexed `effectiveSchedule()`; `harmonizeToChord` snaps each strong beat to the chord active *at that step*, passing tones stay scalar. Gate harmonize by wildness so wildness 0 is truly faithful.
2. **Evolving motif development instead of re-randomization (M-L; fixes L1).** Keep `this.developing = lastOutput`; apply incremental operators (fragment, sequence, augment/diminish, extend tail) so each loop grows from the last. New `develop:0..1` param. This is the change that turns it into a soloist.
3. **Genre-driven phrasing params (M; fixes L2).** `LEAD_FEEL` table in `genres.js` → `{ornamentStyle, density, syncopation, swingAccent, restProb, range}`; wire into `leadParams()` so the slider means "distance from the genre baseline." Jazz → enclosures + chromatic approach; house → sparse stabs; metal → fast scalar runs.
4. **Ornament vocabulary (M).** Expand `ornament` (`transforms.js:30`) into a dispatch: passing, neighbor, grace, turn, enclosure (chromatic approach above+below into the next strong-beat chord tone), scalar run to fill gaps. Pick by genre.
5. **Velocity/dynamics contour (S, high payoff).** Accent strong beats, de-emphasize offbeats/ornaments, phrase-level arc (build to bar 3, ease bar 4), humanized jitter.
6. **Unify the clocks + fix the seed (S; fixes L3/L4/L5).** Use `nowStep()` for record/lock/playhead consistently; reseed loop 0.
7. **Real mode support (S-M; fixes L8).** A `SCALES` interval table in `shared.js` + host snap instead of binary minor/MAJOR.
8. **Optional polyphonic lead (S).** PolySynth + harmonize that *adds* a chord tone for double-stops; resolves same-step collisions.

---

## 3. TEXTURE

### Verified runtime model (ground truth)
- The texture is a **live, continuously-generating MRT2 stream in a separate Python process** (`texture_engine.py:124` loads `MRT(size="mrt2_small")` once; `:264-265` loops `generate_one()` at `frames=25` ≈ 1 s chunks via carried `state`). It is **not** the prebaked one-shots (those are the lead/harmony Tone.Sampler voices — different system).
- Audio path: `server.js:579-599 startTexture()` spawns the engine on host connect; the engine connects back as a WS client (`role:"texture"`), receives room `state`, and writes PCM to the **OS default output device** via `sounddevice` (`texture_engine.py:243-261`). **There is no JS audio node for the texture** — it and the browser band converge only at the OS mixer.
- Dependencies all present in `.venv` (magenta_rt 2.0.2, mlx 0.31.2, sounddevice, etc.) and the `generate()` signature matches the installed MRT2 exactly.
- **Genre-reactivity is genuinely wired** (not a fixed prompt): rich per-genre texture strings in `genres.js` → `fuseGenres` union (cap 3) → `taste.js arrangeJam` → `server.js state.taste` → broadcast → `style_for()` embeds + blends. A dedicated per-genre texture voice exists; this is the strongest part.
- **Lead→texture steering reaches the running generator:** first lead note pushes `{leadNotes, active, pitches}`; loop boundaries re-push up to 6 unique pitches (`host.js:511-516`); server validates into `state.leadPitches`; `generate_one` writes them as sustained `notes[p]=3` and flips to LEAD mode (cfg_notes 1.5→3.0, etc.), read fresh each generation.

### Confirmed bugs / fragility
- **T0 — CRITICAL EVIDENCE GAP: the integrated engine has NEVER been proven to run.** No log, wav, or artifact from `texture_engine.py` exists anywhere in the repo (grep for its banners matches only the source). All MRT2 runtime evidence comes from `oneshot_spike.py`/`prebake_voices.py`. RTF (~2.1× from the spike) is *inferred*, not measured. Latency/glitching/underruns are unverified. **Prove it runs before tuning anything.**
- **T1 — Texture is uncontrollable from the host. (HIGH.)** No JS node → host's master Limiter protects only the band; the OS-summed texture can clip the combined signal with no guard. `bedDuck` ducks the JS harmony/bass buses only — zero effect on the MRT2 texture. Host cannot duck under a lead solo, mute, or EQ it.
- **T2 — ~1–6 s reaction latency. (HIGH.)** State is consumed only at the start of each `generate_one` (~1 s chunk at frames=25), and `audio_q` maxsize=6 buffers up to 6 s ahead — so a chord/lead change can take up to ~6 s to be heard. Too slow for "in the moment."
- **T3 — Chord conditioning silently no-ops. (MEDIUM.)** `chord_notes_vec` parses only roman numerals; on `ValueError` it returns an all-masked vector. Host sends `slot.roman || slot.label` (`host.js:406`) — a label can't parse → chord contributes nothing, no log.
- **T4 — Chord harmony hardcoded to MAJOR. (MEDIUM.)** `chord_notes_vec` always uses `MAJOR_STEPS`; `state.scale` is sent but never read. Minor-key jams feed a major-third chord vector that fights the band.
- **T5 — Silent frame drops advance state. (MEDIUM.)** On `audio_q` full, `generate_one` discards the chunk (`except queue.Full: pass`) but `gen_state["state"]` already advanced — continuity moves forward while audio is lost, unlogged.
- **T6 — No crash recovery. (MEDIUM.)** If the engine crashes mid-jam, `server.js:599` just logs and never respawns; texture is gone for the rest of the session.
- **T7-T9 (LOW-MED):** unbounded embed cache (slow leak in a long process), spawn race on rapid host reload (brief double model load), leadPitches length contract disagreement (host caps 6, server 8, engine ∞).

### Strong redesign proposals (in priority order)
1. **R7 — Actually capture a run first (S).** Run `texture_engine.py --test` + a short live run; log RTF, queue depth, underruns; add a `--wav` dump for A/B. Closes T0, the biggest gap in the whole system.
2. **R1 — Cut latency (M).** `audio_q` maxsize 6→2, `frames` 25→10-12, re-snapshot params mid-loop. Worst-case response ~6 s → <1 s, still within the spike's 2.1× RTF headroom.
3. **R3 — Fix harmonic locking (S).** Read `state.scale` for major/minor; accept roman *and* label (or always send roman) and **log** parse failures. Fixes T3/T4 cheaply.
4. **R2 — Bring texture under host control (M-L).** Start cheap: a `state.textureGain`/`textureDuck` control the engine ramps (`dsp.set_gain`) when a lead solo starts. Larger option: bridge PCM into WebAudio so it joins `bedDuck`/`masterBus`/limiter and export capture. Fixes T1.
5. **R6 — Crash recovery + heartbeat (S).** Auto-respawn with backoff during `phase==="jam"`; periodic alive ping so the host shows texture status.
6. **R4 — Per-genre texture *behavior* params (M).** Not just prompts — per-genre cfg/temperature/anchor weights so ambient genres sit back and dense genres move more.
7. **R5 — Dynamic intensity/swells (M).** Tie crowd energy to gain, low-pass cutoff (open up when hot), and anchor weight; add slow cutoff drift so the bed breathes.
8. **R8 — Tighter lead coupling (M).** Feed the lead's actual contour over the chunk (onset=2 / sustain=3) rather than a static pitch cloud; raise lead-mode cfg_notes toward ~4. With R1's shorter chunks this is what makes the bed truly follow the lead.

---

## Cross-cutting priorities

**Prove-it / correctness first:**
1. T0/R7 — capture a real texture run (we don't know it works).
2. T3+T4 / H4 / L8 — three independent **major-key-only** bugs (texture chord vector, chord engine, lead snap) all silently break minor/modal jams. Worth a single coordinated "key correctness" pass.
3. L4+L5 — unify lead clocks (timing drift).

**Then the big musical wins (all "make it generative" upgrades):**
4. Harmony voice-leading engine (H2/proposal 1).
5. Lead per-beat chord-following + evolving motif development (L1/L6, proposals 1-2).
6. Texture latency cut + host duck control (T1/T2, R1/R2).
7. Genre behavior params across all three (harmony voicing grammars, `LEAD_FEEL`, per-genre texture conditioning) — currently genre drives *timbre/rhythm* but barely drives *pitch/phrasing/behavior*.

**Recurring theme:** genre reactivity is strong for *sound* and (for chords) *rhythm*, but weak-to-absent for *pitch choices, phrasing, voicing, and behavior*. That gap is where the biggest "feels alive and in the genre" gains are.
