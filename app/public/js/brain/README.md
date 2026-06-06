# Jamarama generative brains (in-house "BRAIN")

Pure, engine-agnostic JS (no DOM/audio) — node-testable now, host-importable later.
This is the **BRAIN** half of the BRAIN/VOICE split (MASTER_SPEC_V3 §2): *we* choose the
notes; a synth (or DDSP/MRT2) renders them. Magenta never chooses notes.

```
node public/js/brain/demo.mjs     # ASCII piano-roll review of every transform
```

## Data model
- Grid: 16th notes. `STEPS_PER_BAR = 16`, loop length = `bars × 16` steps.
- Note: `{ t, p, d, v }` = onset step, MIDI pitch, duration (steps), velocity.
- Pitch transforms work in **diatonic scale-degrees** (via `theory.js`), so output stays in key.
- Deterministic seeded PRNG (`rng(loop)`) → variations are reproducible and tight.

## Lead brain (`lead.js`) — capture → quantize → loop → vary
`capture(events)` ingests clock-stamped onsets `[{beat, pitch, durBeats?}]` → the looping phrase.
`generate(loop, params)` returns the notes for loop iteration `loop`. Params (all mappable 0..1):

| param | effect |
|---|---|
| `responseEvery` | 0 = pure loop · 1 = vary every loop · 2 = call,response,call… (call-and-response) |
| `retro` | probability this response is **time-reversed** (the rhythmic inversion) |
| `shift` | rhythmic **displacement** (rotate up to one beat) |
| `density` | `>0` ornament (passing notes) · `<0` thin |
| `invert` | **fraction of notes** melodically mirrored (diatonic; 0.5 = hybrid contour) |
| `transpose` | diatonic step shift |
| `harmonize` | pull strong-beat notes onto the current chord (`setChord(midi[])`) |

Rhythmic transforms are the headline; pitch transforms are independent knobs.

## Harmony brain (`harmony.js`) — rhythm only
`comp(schedule, params, loop)` over the chord `schedule` (the 16 beat-slots the harmony
phone already sends). Pitches are **fixed to the chord** — no melodic inversion. Params:

| param | effect |
|---|---|
| `density` | 0 sustained → 0.2 quarters → 0.45 eighths → 0.7+ sixteenths |
| `syncopate` | push hits onto the off-beats |
| `arp` | 0 block chord → 0.5 two-note → 1 single-note arpeggio (rhythmic spread of chord tones) |

## Integration contract (for the host engine)
1. **Capture (lead):** when a `note` control arrives, stamp it with the transport position →
   `beat = bar*4 + beat + sub/4`; collect a loop's worth, then `lead.capture(events)`.
2. **Per loop:** at each loop boundary call `lead.generate(loopIdx, leadParams)` /
   `harmony.comp(state.schedule, harmParams, loopIdx)` and schedule the returned `{t,p,d,v}`
   on Tone.js (step → time via the transport). Lead → mono synth; harmony → poly synth.
3. **Key/chord:** `lead.setKey(state.key, state.scale)`, `lead.setChord(currentChordNotes)`.
4. **Control mapping:** any param can be driven by lead-phone controls, crowd energy, or the
   GROOVE X/Y (e.g. crowd energy → `density`/`retro`; a lead "wildness" slider → `invert`).

Files: `theory.js` (scales/grid/quantize/roll), `transforms.js` (rhythm+pitch ops),
`lead.js`, `harmony.js`, `demo.mjs`.
