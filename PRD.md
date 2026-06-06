# JAMARAMA — Master Write-Up

> **Canonical document.** The single source of truth for what Jamarama is and how it works. Reflects the final locked architecture. Where earlier docs differ (local-synth assumptions, lead-through-Magenta), **this one wins.**

-----

## In one line

**Jamarama is a real-time jam where a few people each shape one dimension of a single fused track, and their different tastes blend into music none of them could have made alone.**

The pitch: *the aux war, solved* — instead of fighting over whose music plays, everyone plays at once, and your taste is your instrument.

## In one paragraph

Two to four people scan a QR, each says what they’re into, and the system fuses their tastes into one continuous, genre-bending track. Each person controls a different **dimension** of that track — the chords, the melody, the groove, or the crowd energy. Most of what you hear is generated live by **one** Magenta RealTime 2 stream; the melody is played by a separate, clock-locked voice driven by the Lead player. The signature moment: one person moves to a new chord and the **whole band re-roots around their choice** on the next beat. It’s collaborative, sounds like a produced fusion record, and anyone — a non-musician, or a judge who just walked up — can meaningfully contribute in seconds.

-----

## The experience

1. **Join** — scan a QR / open a link. No install.
1. **Say your taste** — “I’m into punk” / “Carnatic and techno” / “jazz.” This feeds the blended style the whole track is generated in.
1. **Get a role** — Harmony, Lead, Groove, or Crowd.
1. **Play together** — everyone shapes their dimension at once; one fused track plays from the room speaker.
1. **The magic** — the Harmony player moves to a new chord and the entire fused texture pivots around it, live. One person’s decision visibly and audibly bends the whole band.

-----

## The roles — 3 instruments + a crowd

|Role                |Where           |What you do                                                                     |Shapes                                                                       |
|--------------------|----------------|--------------------------------------------------------------------------------|-----------------------------------------------------------------------------|
|**Harmony**         |Phone           |Draw a line across a wheel of the key’s chords to set the looping progression   |The harmonic frame everything sits in — *the foundation the band re-roots to*|
|**Lead**            |Phone           |Play a phrase; it locks to the beat and plays back, looping until you play again|The melody — its own clock-synced voice on top                               |
|**Groove**          |Computer        |Steer rhythmic complexity & drum intensity (no notes)                           |How busy/driving the beat is — the floor                                     |
|**Crowd** (the “½”) |Phone, unlimited|Collectively push energy + tap mood “drops” (no notes)                          |How hot and what mood the room is                                            |
|*(everyone’s taste)*|at join         |describe what you’re into                                                       |The blended genre-fusion the track is generated in                           |

Four genuinely different feels — *draw a path / call-and-response / dial complexity / collective surge* — so it plays like a real ensemble, not one mechanic reskinned.

-----

## How it actually works (the core architecture)

### Two sound sources, one clock

There are exactly **two** things making sound, and they’re locked to the same beat grid:

**1. Magenta RealTime 2 — the fused bed (one live generator).**
Generates the continuous, genre-blending backing texture. It is conditioned by everything *except* the melody:

- **Harmony’s chords** → fed in as note/MIDI conditioning (the harmonic frame)
- **Everyone’s blended taste** → the style embedding (weighted average of prompts; the model’s core strength)
- **Groove** → drum/rhythm parameters (`cfg_drums`, density, complexity)
- **Crowd** → energy, temperature, mood/style nudges

**2. The Lead voice — the melody (deterministic, NOT Magenta).**

- Its **brain** is our **own custom generative-MIDI algorithm** — the call-and-response logic — locked to the master tempo. We own the notes, not Magenta.
- Its **sound** is a **designed synth** rendered on the computer. The timbre can be AI-designed *once*, but playback is **deterministic** — it plays our MIDI and loops until new MIDI arrives.
- On the **phone**, a simple test tone fires the moment you play, for sub-20ms “I played that” confirmation. The phone tone is feedback; the computer synth is the authoritative lead sound.

> **The invariant that keeps everything in sync: ONE live generator total (Magenta). Everything else is clock-locked playback of pre-designed sound.** The lead voice is the one deliberate exception to “it’s all Magenta” — and because it’s deterministic, it locks tight and never drifts. A *second* live generative model for the lead would reintroduce the drift problem — so we don’t do that.

### Why this split is right

Magenta’s strength is real-time **style-fusion**; its soft spot is dense, literal, low-latency **note-playing**. So:

- The lead (which needs to be precise, instant, and reactive) is **our** deterministic voice — not asked of Magenta.
- Magenta’s note input now carries **only harmony** (held chords, changing on the bar) → sparse, no harmony-vs-lead mud.
- Magenta does what it’s best at: fuse everyone’s taste into one produced-sounding world around the harmony.

### The engine loop (per bar)

1. Blend everyone’s tastes → one style embedding (recent action weighted heavier).
1. Magenta: feed harmony’s current chord (notes) + style + groove/crowd params → generate the next chunk of the bed.
1. Lead: our MIDI algorithm produces the next phrase → the designed synth plays it, clock-locked.
1. Mix bed + lead at the room speaker.
1. Repeat. Player changes captured this bar take effect on the next downbeat.

### The dial that defines the bed’s feel

`cfg_notes` controls how literally Magenta follows the harmony: low = riffs around the chords in-style (loose, musical); high = states them plainly. Main thing to tune during the build.

-----

## The magic moment (the demo beat)

Steady groove playing. The Harmony player’s playhead crosses to a new chord on the wheel. The UI confirms instantly, and on the next downbeat **the entire fused bed re-roots around the new chord** while the lead voice resolves over it — everyone’s sound bends to one person’s choice, seen (node flash, player colors react) and heard. That single moment proves the thesis: *everyone genuinely contributes, and it’s audible.*

-----

## Sync (the one hard part, solved)

One **master clock** — Audiotool’s transport (or the Mac’s, as fallback). Everyone **schedules ahead** of the beat grid; nobody plays “now.”

- **Magenta** chunks are requested ~1 bar early, so its ~200ms latency becomes budgeted lead-time, not lag. (At ~100 BPM a bar is ~2.4s — far more than enough headroom.)
- **The lead synth** is deterministic, so it schedules sample-accurately against the same grid — locks tight.
- **The phone test tone** is instant local feedback, not the authoritative sound.
  The bar-quantize (changes land on the downbeat) is what gives Magenta its lead-time for free. *(Confirm with Audiotool that their transport is the clock we schedule against — if so, multi-device timing is handled for us.)*

-----

## The stack

- **Magenta RealTime 2** — the one live generator (the fused bed). Real-time on Apple Silicon (`mrt2_small` for demo stability).
- **Custom lead engine** — our generative-MIDI algorithm + a designed synth (deterministic, clock-locked). Runs on the computer; phone fires a test tone.
- **Audiotool (NEXUS)** — multiplayer backbone: phones join as browser clients, real-time sync, and the **master clock** everyone schedules against. (Lets us hit the Magenta *and* Audiotool tracks with one build.)
- **Phones** — thin browser controllers (Harmony, Lead, Crowd). No install, no model on the phone.
- **Computer** — runs Magenta + the lead synth + audio out + the Groove control + the room/spectator screen.

### Fallback (so nothing can sink us)

If Audiotool’s beta fights us: phones hit a small local web server on the Mac; Magenta + the lead synth run on the Mac; audio plays in the room. Same design, no dependency. Audiotool is an accelerator + a prize track, not a requirement.

-----

## What Jamarama is NOT (kills ambiguity)

- **Not** all-Magenta — the **lead is a separate, deterministic voice** with our own MIDI brain.
- **Not** local synths everywhere either — the *bed* is fully Magenta-generated; only the lead is a played synth.
- **Not** more than one live generator — Magenta is the only real-time model; the lead is clock-locked playback.
- **Not** one AI per player — one bed stream, many controllers.
- **Not** a step sequencer or DAW — instruments you play, not grids you program.
- **Crowd is not chaos** — bounded to intensity + mood, never pitch/tempo, clamped so max intensifies, never detonates.

-----

## Why it wins

- **Bullseye on the brief:** the hackathon explicitly wants “experimental interfaces for live, collaborative improvisation.” This is exactly that.
- **Ideal juror:** Ilaria Manco (Magenta) researches new forms of real-time musical interaction — our exact lane. Pitch to her.
- **On the model’s grain:** Magenta does fusion (its strength), not literal note-playing (its soft spot) — reads as *understanding the model* to the people who built it.
- **Differentiated:** your *taste* is your seat, not your skill → non-musicians and virtuosos contribute equally; strangers from incompatible genres who *couldn’t* jam now can; harmony is learned as geometry; judges join the Crowd and become part of the demo.
- **Three prizes, one build:** DeepMind Magenta (primary, $2k) + Audiotool + MIDI Accessibility (opt-in).
- **Make-or-break is answered:** “can I hear my own contribution?” → the re-root beat, seen and heard.

-----

## Build priority (so scope can’t sink it)

~17 working hours, present Sunday 4pm. Build in order; don’t polish all roles equally from hour one.

**Core (a complete winning demo by itself):**

1. Master clock + Magenta engine loop (harmony notes + taste + groove/crowd params → the bed).
1. **Harmony wheel** (draw-to-sequence → notes in; node-crossing fires the re-root). *Heaviest custom piece, load-bearing for the demo beat — build first, strongest builder, tap-to-add as fallback.*
1. Groove parameters + room/spectator visualization (per-player color, the re-root beat).
1. Join path (QR → phone controller → session).

→ Prove *harmony move → whole bed re-roots on the downbeat* feels like magic before anything else.

**Then:** Lead (our MIDI engine + designed synth + phone test tone).
**Then:** Crowd (collective energy + mood drops, bounded).
**Fake if needed:** taste onboarding (pre-set roles).

-----

## Open questions to resolve (Friday @ Dillon’s / Saturday AM)

1. **NEXUS:** can phones be control-only browser clients while the Mac handles playback, and is Audiotool’s transport the clock we schedule against? (Mirta Gilson / Andreas Jacobi)
1. **Submission:** can one project enter both DeepMind + Audiotool tracks? (sponsor intros / Discord)
1. **Host Mac** model → confirms `mrt2_small` vs `base`.
1. **Team:** secure a Berklee creative-lead angle for the pitch.