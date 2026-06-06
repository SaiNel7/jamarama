# JAMARAMA — Master Write-Up

> ⚠️ **SUPERSEDED by [`MASTER_SPEC_V3.md`](./MASTER_SPEC_V3.md) (canonical).** Kept for history. v3 merges this doc with the external "Master Spec v2", resolves all conflicts (BRAIN/VOICE split, neural-lead-as-gated-upgrade, Audiotool-behind-an-adapter), and corrects the Magenta facts against installed MRT2 v2.0.2. Read v3, not this.
>
> _Original note:_ Single source of truth for what Jamarama is and how it works. Reflects the final locked architecture after the tempo test. **Where earlier docs differ — Magenta-on-beat, master-clock-syncs-Magenta, one-generator-as-the-bed — this one wins.**

---

## In one line

**Jamarama is a real-time jam where a few people each shape one dimension of a single fused track, and their different tastes blend into music none of them could have made alone.**

The pitch: *the aux war, solved* — instead of fighting over whose music plays, everyone plays at once, and your taste is your instrument.

## In one paragraph

Two to four people scan a QR, each says what they're into, and the system fuses their tastes into one continuous, genre-bending track. Each person controls a different **dimension** — the drums, the chords, the melody, or the crowd energy. The rhythmic body of the music is played by **deterministic, clock-locked instruments** (drums, a harmony synth, a lead synth) that stay tight together. Over the top, **one Magenta RealTime 2 stream** paints the atmosphere — the genre-fused texture, the floating melodies, the "produced record" realism that keeps the instruments from sounding like a toy keyboard. The signature moment: one person moves to a new chord and the **whole band re-roots around their choice on the next downbeat** — the harmony synth states it crisply on the beat, and Magenta's texture washes toward the new tonal center. It's collaborative, sounds like a produced fusion record, and anyone — a non-musician, or a judge who just walked up — can meaningfully contribute in seconds.

---

## The experience

1. **Join** — scan a QR / open a link. No install.
2. **Say your taste** — "I'm into punk" / "Carnatic and techno" / "jazz." This sets the blended texture the whole track floats in.
3. **Get a role** — Drums/Groove, Harmony, Lead, or Crowd.
4. **Play together** — everyone shapes their dimension at once; one fused track plays from the room speaker.
5. **The magic** — the Harmony player moves to a new chord and the entire band re-roots around it on the next beat. One person's decision visibly and audibly bends the whole ensemble.

---

## The big architectural change (read this first)

**We tested whether Magenta can stay on a beat grid. It can't.** There is no tempo input in the model (`generate` takes style, notes, drums, cfgs, frames, state — no clock), and when prompted to a fixed BPM and primed with an on-grid loop, its pulse drifts noticeably within ~30 seconds. So Magenta cannot be the rhythmic bed, and nothing rhythmic can be slaved to it.

**The fix: invert the roles.** Magenta is demoted to a pure **texture layer that lives off the grid**. The musical backbone — drums, harmony, lead — is now carried by **deterministic, clock-locked instruments** that we own and that lock together sample-accurately. Magenta's drift becomes irrelevant, because **texture is arhythmic: ambient wash and floating feedback have no downbeat to be late on.** You only ever hear drift when something with a pulse slides against the grid. Magenta no longer has a pulse. That single reframe is why this architecture works and the old one didn't.

---

## The instruments — 3 deterministic voices + a texture + a crowd

There are now **three things that keep time** (deterministic, locked to one clock) and **one thing that sets the vibe** (Magenta, free-floating).

| Role | Where | What you do | Sound source | On the grid? |
|---|---|---|---|---|
| **Drums / Groove** | Computer | Steer intensity, complexity, pattern | Deterministic drum engine (kit sounds optionally generated with Stable Audio, sequenced by us) | **Yes — master clock** |
| **Harmony** | Phone | Draw a progression on the chord wheel | Splits two ways (see below) | Synth voice: **yes** |
| **Lead** | Phone | Play a phrase; it locks and loops until you play again | Splits two ways, single line | Synth voice: **yes** |
| **Texture** | (auto) | — | **Magenta RealTime 2** | **No — floats** |
| **Crowd** (the "½") | Phone, unlimited | Collectively push energy + tap mood "drops" | Nudges texture + drum intensity | n/a |
| *(everyone's taste)* | at join | describe what you're into | The Magenta style embedding (the texture's genre/color) | n/a |

---

## How it actually works (the core architecture)

### One clock: the drums

The **drum engine is the master clock.** It's deterministic playback on a fixed grid (a sequencer triggering kit samples — the samples can be designed once with Stable Audio, but playback is ours and sample-accurate). Everything that needs to be in time locks to the drum grid. The Groove player steers it live (intensity, density, pattern) without it ever leaving the grid.

### Harmony splits two ways

The Harmony player draws a progression on the chord wheel. Jamarama processes it and sends it to **two places at once:**

1. **→ a deterministic generative synth** that voices and plays the user's progression, **rhythmically locked to the drums.** This is the on-beat chordal body — crisp, tight, always in time.
2. **→ Magenta, as notes conditioning,** so the texture floats *over and around* the harmony — space, atmosphere, response. Magenta colors the harmonic world without being asked to play it on the beat.

### Lead follows the same pattern

Same split as harmony, but a **single melodic line** instead of chords:

1. **→ a deterministic lead synth,** locked to the drums.
2. **→ (optionally) Magenta**, informing the texture over the top.

> **Harmony is chords; lead is one line.** Both are deterministic, clock-locked synth voices that ALSO feed Magenta for textural color.

### Magenta = texture only, off the grid

Magenta is no longer the bed and never keeps time. Its job is **realism and atmosphere over the deterministic skeleton** — the feedback of an electric guitar, floating melodies in the background, the genre-fused ambient wash that "sets the vibe." It's the layer that makes the whole thing sound like a produced record instead of a beepy GarageBand sketch. **Taste lives entirely here:** everyone's blended genres (punk + qawwali + jazz) become one coherent sonic world — and *only* Magenta can do that fusion. The deterministic synths can't blend genres; Magenta is what carries the entire thesis, delivered as atmosphere rather than as the beat.

### The engine loop (per step)

1. **Drums** advance on the grid (master clock).
2. **Harmony synth + lead synth** play their current notes, quantized to the drum grid (deterministic, tight).
3. **Magenta** generates its next texture chunk — conditioned by blended **taste** (style) + **harmony notes** (for color) + **groove/crowd** params — mixed in as floating atmosphere, *not* time-aligned.
4. **Mix:** drums + harmony synth + lead synth (locked) + Magenta texture (floating) → room speaker.
5. Player changes land on the next downbeat for the deterministic instruments; Magenta's texture morphs gradually.

### The dial that defines the texture's feel

`cfg_notes` controls how literally Magenta's texture tracks the harmony: low = atmospheric, riffs around the chords in-style; high = states them more plainly. Keep it loose here — Magenta is the wash, not the chords. `cfg_musiccoca` controls how hard it commits to the blended taste. Main things to tune during the build.

---

## The magic moment (the demo beat)

Steady groove playing. The Harmony player's playhead crosses to a new chord on the wheel. The UI confirms instantly, and on the next downbeat **the deterministic harmony synth states the new chord crisply on the grid** while the lead resolves over it and **Magenta's texture washes toward the new tonal center.** Everyone's sound bends to one person's choice — seen (node flash, player colors react) and heard.

This is now **more reliable than the old design**: the re-root is carried by a deterministic, on-beat synth (it lands clean on the downbeat, no drift), with Magenta as the atmospheric glaze. The make-or-break question — *"can I hear my own contribution?"* — is answered by a voice that's guaranteed to be in time.

---

## Sync — solved by architecture, not engineering

The old PRD tried to make a master clock that Magenta schedules against. **That's impossible — Magenta has no clock input and drifts (we tested it).** So we removed the problem instead of solving it:

- **Drums are the master clock.** Deterministic, on a grid.
- **Harmony and lead synths schedule sample-accurately against the drum grid.** They're our deterministic playback, so they lock tight and never drift.
- **Magenta is deliberately OFF the grid.** Texture only. There is nothing to sync, because we never ask it to keep time, and its arhythmic wash has no audible beat to drift.

The hardest unsolved risk in the previous design is gone.

---

## The stack

- **Deterministic audio engine** — drum sequencer + harmony synth + lead synth. Clock-locked; the musical backbone and the master clock. (Stack choice open: Tone.js in-browser vs AudioKit/JUCE/Python on the Mac — decided by where we mix.)
- **Drum sounds** — optionally designed with **Stable Audio**, but triggered by our own sequencer so the Groove player can steer them live on the grid. (Recommended: Stable-Audio kit samples + our sequencer, not regenerating loops live.)
- **Magenta RealTime 2** — the texture layer only. `mrt2_small` (confirmed real-time on M4 Pro at ~2.3x RTF). Runs free, off-grid, conditioned by taste + harmony notes + groove/crowd.
- **Phones** — thin browser controllers (Harmony, Lead, Crowd). No install, no model on the phone.
- **Computer (Mac)** — runs the deterministic engine + Magenta + the mix + the Groove control + the room/spectator screen.
- **Multiplayer** — phones as control-only browser clients; control over WebSocket. **Audiotool/NEXUS optional** (prize + accelerator), not required: because our drums are the clock, we no longer need Audiotool's transport. Local Mac web server is the guaranteed path.

### Fallback (so nothing can sink us)

Everything runs on the Mac with a small local web server; phones connect over the browser; audio plays in the room. No external dependency. Audiotool is a bonus track, not a requirement.

---

## What Jamarama is NOT (kills ambiguity)

- **Not Magenta-on-beat.** Magenta is texture, off the grid, never the timekeeper.
- **Not synced-to-Magenta.** Drums are the clock; Magenta floats over the top.
- **Not all-Magenta.** Drums, harmony, and lead are deterministic instruments we own; Magenta is the atmospheric layer.
- **Not beepy/GarageBand.** The Magenta texture over the deterministic skeleton is exactly what adds realism so it doesn't sound like a toy.
- **Not more than one live generator.** Magenta is the only real-time model; everything else is deterministic playback.
- **Not one AI per player.** One Magenta texture stream, many controllers.
- **Not a step sequencer or DAW.** Instruments you play and a wheel you draw on, not grids you program.
- **Crowd is not chaos.** Bounded to intensity + mood, never pitch/tempo, clamped so max intensifies, never detonates.

---

## Why it wins

- **Bullseye on the brief:** the hackathon wants "experimental interfaces for live, collaborative improvisation." This is exactly that.
- **Ideal juror:** Ilaria Manco (Magenta) researches new forms of real-time musical interaction — our exact lane. Pitch to her.
- **On the model's grain (now even truer):** we use Magenta *only* for atmospheric genre-fusion (its real strength) and *never* for timekeeping or literal note-playing (the weaknesses we empirically confirmed). Knowing to demote it to texture reads as deep understanding to the people who built it.
- **Magenta carries the thesis:** the taste-fusion — strangers' incompatible genres blended into one world — is something *only* Magenta can do. The deterministic synths can't fuse genres. So the differentiator lives in Magenta even though it's "just" the texture.
- **Differentiated:** your *taste* is your seat, not your skill → non-musicians and virtuosos contribute equally; strangers from incompatible genres who *couldn't* jam now can; harmony is learned as geometry; judges join the Crowd and become part of the demo.
- **Sync is no longer a risk:** solved by architecture, not by a fragile scheduler.
- **Three prizes, one build:** DeepMind Magenta (primary, $2k) + Audiotool (opt-in) + MIDI Accessibility (opt-in).

---

## Build priority (so scope can't sink it)

~17 working hours, present Sunday 4pm. Build in order; don't polish all roles equally from hour one.

**Core (a complete winning demo by itself):**

1. **Drum engine + master clock** — deterministic sequencer on a fixed grid. This is the timekeeper everything locks to. Build first; everything depends on it.
2. **Harmony wheel → harmony synth** (draw-to-sequence → deterministic synth voicing locked to drums; node-crossing fires the re-root). *Heaviest custom piece, load-bearing for the demo beat — strongest builder, tap-to-add as fallback.*
3. **The re-root, deterministic and on-beat** + room/spectator visualization (per-player color, the re-root flash).
4. **Join path** (QR → phone controller → session).

→ Prove *harmony move → harmony synth re-roots crisply on the downbeat over steady drums* before anything else. (It's deterministic now, so this is reliable, not a gamble.)

**Then:** Magenta texture layer over the top (taste-conditioned) — prove it turns the deterministic skeleton from "beepy" into "produced." This is where the wow lives, but it sits on a working core.

**Then:** Lead (deterministic synth + Magenta texture informing).

**Then:** Crowd (collective energy + mood drops, bounded).

**Fake if needed:** taste onboarding (pre-set roles).

---

## Open questions to resolve

1. **Pitch framing — is Magenta "too demoted" for a Magenta hackathon?** It's now the texture, not the beat. Be ready to articulate the counter on stage: Magenta carries the entire taste-fusion thesis and the realism, and we still drive it through its distinctive controls (notes conditioning + style embedding). Decide whether to keep a visibly *interactive* Magenta moment in the demo (e.g. a live taste shift that audibly morphs the texture) so judges see its real-time control, not just ambient wash.
2. **Drum engine choice:** Stable-Audio-generated kit samples + our sequencer (recommended — realism + live control + grid-lock) vs pre-generated loops (less live control) vs pure programmed drums (most control, least realism).
3. **Deterministic synth stack:** Tone.js (browser) vs AudioKit/JUCE/Python (Mac) — decided by where the final mix happens.
4. **Audiotool:** now optional (we own the clock). Worth it only for the prize track and accelerator. Confirm phones can be control-only browser clients if we use it.
5. **Submission:** can one project enter DeepMind + Audiotool tracks? (sponsor intros / Discord)
6. **Team:** secure a Berklee creative-lead angle for the pitch.