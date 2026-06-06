# JAMARAMA — Master Spec v3 (CANONICAL)

> **The single source of truth.** Supersedes `PRD.md` (the "Master Write-Up") and the external "Master Spec v2". Where any earlier doc differs, **this one wins.** Written Saturday; present Sunday 4pm (~17h).
>
> v3 merges the PRD's safe deterministic spine with v2's BRAIN/VOICE framing and Magenta-maximalist ceiling, resolves every conflict between them, and corrects the Magenta facts against the actually-installed **MRT2 v2.0.2** (2026-06-04).

---

## 1. The idea

**Jamarama is a real-time multiplayer jam where a few people each shape one dimension of one shared, fused track — and their different tastes blend into music none of them could have made alone.**

Pitch: *the aux war, solved* — instead of fighting over the music, everyone plays at once, and your taste is your instrument.

Two to four people scan a QR, each says what they're into, and the system fuses their tastes into one continuous genre-bending track. Each person controls one **dimension** — drums, chords, melody, or crowd energy. The signature moment: one person moves to a new chord and the **whole band re-roots around their choice on the next downbeat**. Anyone — a non-musician, or a judge who just walked up — can meaningfully contribute in seconds.

Unifying thesis: **making music with people you otherwise couldn't** — whether the gap is skill or idiom. Education (harmony as geometry) is the *gift*, not the headline.

---

## 2. The core architecture (read this first)

**A tight, deterministic, clock-locked band (drums + chords + lead) wrapped in a loose Magenta texture halo that lives OFF the grid.**

This is the one decision everything else hangs on, and it's **empirically settled**: we tested whether Magenta can hold a beat (`cloud/tscript2.py` → `tempo_test.wav`). It can't — there is no tempo input to the model, and a primed on-grid loop drifts within ~30s. So **Magenta is never the timekeeper and nothing rhythmic is slaved to it.** Texture is arhythmic (ambient wash, feedback, color) — it has no downbeat to be late on, so its drift is *inaudible and reads as live-room realness.*

### BRAIN / VOICE — the framing that kills all ambiguity

Every voice splits into a **BRAIN** (the generative-MIDI logic — *always ours, deterministic*) and a **VOICE** (the synth/sampler that renders it). **Magenta never chooses notes.** It only ever (a) paints atmosphere or (b) renders notes we already chose.

| Role | Where | Controls | BRAIN (notes — ours) | VOICE (sound) | Into Magenta texture? | On the grid? |
|---|---|---|---|---|---|---|
| **Drums / Groove** | Host (desktop) | X/Y pad: chill↔hype × sparse↔dense | Jamarama generative-MIDI drum engine | Sample player (default: Stable-Audio kit) **or** Audiotool drum machine | No | **Yes — master clock** |
| **Harmony / Chords** | Phone | Draw progression on the chord wheel | Jamarama generative chord-voicing | Poly synth (default Tone.js) **or** Audiotool poly synth | Yes — low-`cfg_notes` harmonic hint | **Yes** |
| **Lead** | Phone | Play a phrase; it locks & loops till you play again | Jamarama generative call-and-response | Mono synth (default) → *upgrade:* neural (see §4) | Optional — low-`cfg_notes` melodic hint | **Yes** |
| **Texture** | (auto) | — (driven by everyone) | — (no notes; params + hints only) | **Magenta RealTime 2 (MRT2)** | **is** the texture | **No — floats** |
| **Crowd** | Phone (∞) | Mood buttons + hold-to-raise-energy | — (parameters only) | — (nudges texture + drum intensity) | Yes — params (intensity, mood) | n/a |
| *(taste)* | at join | describe what you're into | — | the MRT2 style embedding | n/a |

**There are exactly three things that keep time** (drums, harmony synth, lead synth — all deterministic, locked to one clock) **and one thing that sets the vibe** (MRT2, free-floating).

---

## 3. The roles in detail

### Drums / Groove (host desktop) — the master clock
- **Brain:** Jamarama generative-MIDI drum engine. The host's **X/Y pad** (chill↔hype on Y, sparse↔dense on X) steers density/intensity/pattern live, never leaving the grid.
- **Voice:** our own sequencer triggering kit samples — **deterministic, sample-accurate.** Default samples designed once with Stable Audio; swappable to an Audiotool drum machine if the Audiotool adapter is adopted (§8).
- This **is the master clock.** Build it first; everything locks to it. Always-on floor — never call-and-response, never falls silent.

### Harmony / Chords (phone) — the showpiece
- **Brain:** the **chord wheel** — the key's ~6 diatonic chords (I, ii, iii, IV, V, vi) as nodes; you **draw a closed line between nodes** to author a looping progression (one bar per segment, playhead retraces your stroke). Generative voicing turns it into notes. Fallback: tap-to-add nodes if draw-to-sequence fights the clock.
- **Voice:** a poly synth, clock-locked → the crisp on-beat chordal body.
- **Into MRT2:** chords feed the texture as a **low-`cfg_notes` harmonic hint** so the wash tracks the harmony — *never as notes MRT2 plays.*
- **The signature beat:** crossing to a new chord re-roots everything on the next downbeat (§7).

### Lead (phone)
- **Brain:** Jamarama's own generative-MIDI call-and-response, tempo-locked. We own the melody.
- **Voice:** a mono synth in the core. *Upgrade path → a neural voice* (§4). Phone fires an instant local test tone for <20ms feedback.
- Behavior: tap keys to answer the call; the phrase **locks on the downbeat and loops until you play again.**
- **Into MRT2:** optional low-`cfg_notes` melodic hint; expendable.

### Crowd (phone, unlimited)
- Parameters only, no notes. Mood buttons (DARKER / BRIGHTER / HEAVIER / DREAMIER) + a **hold-to-raise-energy** control, aggregated into one bounded value (clamped: max intensifies, never detonates).
- The zero-skill, instant-join, judge-participation + accessibility play.

---

## 4. Magenta's role(s)

**MRT2 (texture) is core. A neural lead voice is a gated upgrade.**

### MRT2 = the texture halo (the one live generator in core)
Conditioned on everyone's blended taste (style embedding = weighted average of text prompts) + low-`cfg_notes` hints from chords/lead + crowd/groove params. Generates the loose fused atmosphere — the genre-fusion that *only* Magenta can do, and the realism that keeps the deterministic skeleton from sounding like a toy. **Rule:** its contribution stays textural/harmonic (washes, feedback, color), never a foreground rhythmic-melodic line that's "supposed" to lock.

**Taste lives entirely here.** The deterministic synths can't blend genres; MRT2 carries the entire fusion thesis, delivered as atmosphere rather than as the beat.

### The neural lead voice — upgrade, not core (this replaces v2's DDSP plan)
v2 specced **Magenta DDSP** as the lead's voice. **Reality check from the source:** `magenta/ddsp-vst` is **archived/read-only (Oct 2024)** with known unfixed Apple-Silicon audio bugs — too risky to make load-bearing on a Saturday. So:
- **Core:** lead = a plain deterministic mono synth. Ships first, never gated.
- **Upgrade (Tier 2), pick whichever clears its test:**
  1. **MRT2 `notes`-conditioning at high `cfg_notes`** — drive a *second* MRT2 stream (or a dedicated high-cfg pass) with our lead MIDI so MRT2 *renders* our notes as a neural timbre. Actively maintained, Metal-accelerated, no DDSP risk. Cost: a second neural stream → **compute test required.**
  2. **DDSP-VST** — only if someone wants to fight its archived M-series bugs for the Jesse-Engel narrative.
- **Invariant preserved:** MIDI is always ours; the neural layer only renders/colors. Never gate *playing* on it — default synth instant, neural voice swaps in.

> Why this still lands at a Magenta hackathon: MRT2 does the taste-fusion (its real strength) and, in the upgrade, renders our melodic line through its distinctive `notes` + style controls — never timekeeping or note-choosing (its empirically-confirmed weaknesses). Demoting Magenta to texture *correctly* reads as deep understanding to the people who built it.

---

## 5. Magenta facts (verified against installed MRT2 v2.0.2)

Source: `external/magenta-realtime` @ `v2.0.2` (2026-06-04, latest). Apple-Silicon native via **MLX/Metal** — this is the headline change vs v1 (no TPU/CUDA needed on Mac).

- **Package:** `magenta-rt` (import `magenta_rt`); install `uv pip install "magenta-rt[mlx]"`; CLI `mrt`.
- **Real-time class (Mac):** `from magenta_rt import MagentaRT2Mlxfn; mrt = MagentaRT2Mlxfn(size="mrt2_base")`.
- **Variants:** `mrt2_small` (230M, real-time on any Apple Silicon) · `mrt2_base` (2.4B, real-time on **M4 Pro** per official table). There is **no** `mrt2_large`.
- **`generate()` signature:**
  ```python
  wav, state = mrt.generate(
      style=embedding,          # 768-d MusicCoCa embedding from mrt.embed_style(text|audio); None = unconditional
      notes=[...128 ints...],   # per-pitch: -1 masked, 0 off, 1 on, 2 onset, 3 model-choice
      drums=[1],                # single int: -1 masked, 0 off, 1 on
      cfg_notes=1.0,            # how literally texture tracks our notes; KEEP LOW for texture, HIGH to render a lead
      cfg_musiccoca=3.0,        # how hard it commits to the taste/style
      cfg_drums=1.0,
      temperature=1.3, top_k=40,
      frames=25,                # 25 frames = 1.0s of 48kHz stereo
      state=None,               # pass forward for seamless streaming
  )                             # → (Waveform[.samples = [T,2] float32 @ 48kHz], state)
  ```
- **Style blend (taste fusion):** `0.7*mrt.embed_style("punk") + 0.3*mrt.embed_style("qawwali")` → pass as `style`.
- **The two dials to tune in the build:** `cfg_notes` (texture literalness) and `cfg_musiccoca` (taste commitment). Confirmed working in `cloud/tscript.py` (re-root prototype at `cfg_notes=4.0`) and `cloud/tscript2.py` (drift test).
- **Gotcha:** macOS down-clocks the GPU on idle gaps, raising per-frame cost; keep the MLX loop busy.

---

## 6. Invariants (the Nothing-Funny Checklist)

- [ ] **Brain = Jamarama (deterministic), Voice = synth/sampler/Magenta. Magenta never chooses notes.**
- [ ] **MRT2 = loose texture only** (washes/color), off the grid, never a foreground rhythmic line. Looseness = "live," and only ever for non-rhythmic material.
- [ ] **Chords/lead enter MRT2 only as low-`cfg_notes` texture hints** — except an explicit, separate high-`cfg_notes` pass *if* we build the neural lead upgrade.
- [ ] **One master clock = our deterministic drum engine.** Tight voices locked to it; MRT2 re-anchored per bar; phone test-tone is local feedback only.
- [ ] **One live generator in core** (MRT2). A second neural stream (neural lead) is allowed *only after* the compute test passes.
- [ ] **Don't make all voices neural.** Drums = sampler, chords = poly synth, lead = mono synth. Neural is a swap-in for the lead voice only.
- [ ] **Lobby/taste personalization is an upgrade, never a gate** — default voice instant, personalized swaps in.
- [ ] **Crowd is bounded** — intensity + mood only, never pitch/tempo. Clamped so max intensifies, never detonates.
- [ ] **Audiotool is optional, behind an adapter, never load-bearing** (§8).

---

## 7. The signature demo beat

Steady groove. The Harmony player's playhead crosses to a new chord on the wheel. **UI confirms instantly**, and on the next downbeat the **deterministic harmony synth states the new chord crisply on the grid** while the lead resolves over it and **MRT2's texture washes toward the new tonal center.** Player-colors react, the node flashes. One person's choice visibly + audibly bends the whole band.

This is the proof of the thesis — *everyone genuinely contributes, audibly* — and it's **reliable**, because the re-root is carried by a deterministic on-beat synth (no drift), with Magenta as the atmospheric glaze.

---

## 8. Topology, sync & the Audiotool question

### Topology
- **Host Mac = everything that matters:** the deterministic engine (drums/chords/lead synths + master clock), MRT2 (texture), the mix, the Groove X/Y control, and the room/spectator screen. All audio converges here → one room speaker.
- **Phones = thin browser controllers** (Harmony, Lead, Crowd). Join via **QR on the same WiFi ("JAM·LAN")**. No install, no model on the phone. Control flows over WebSocket.
- **Local Mac web server is the guaranteed path** — no external dependency.

### Sync model
- **Master clock = our drum engine** (deterministic, fixed grid).
- Harmony/lead synths schedule **sample-accurately against the drum grid** → locked tight, never drift.
- **MRT2 is deliberately OFF the grid.** Requested ~1 bar ahead, placed on the downbeat (re-anchoring absorbs slow drift); its residual looseness is the desired live texture. Nothing to sync — we never ask it to keep time.
- Phone test-tone = instant local feedback, not authoritative. Phone→host control latency hidden by "lands on next downbeat."

### Audiotool — optional, gated, never load-bearing (decision: Saturday)
We own the clock, so we **do not need** Audiotool's transport. But it's a **separate prize track** (juror Andreas Jacobi) and you can submit one project to multiple tracks, so it's pure upside *if cheap*.
- **Build the thin `control-in / beat-out` adapter regardless** so transport + drum/chord voices are swappable.
- **One timeboxed Audiotool spike (~90 min, hard cutoff today).** The single deciding question is **audio convergence** — can Audiotool-rendered drums/chords mix with host MRT2 on one clock out one speaker, with control-only phone clients?
- **Pass →** flip the adapter, claim track 3. **Fail →** ditch it, zero core rework (adapter keeps driving our own clock).

---

## 9. Prizes & submissions

You can enter one build in multiple tracks. **Two are locked by the core build, zero extra risk:**
1. **DeepMind Magenta RT2** ($2k, primary) — MRT2 texture (+ optional neural lead) is deep Magenta-ecosystem use.
2. **MIDI Accessibility** (opt-in) — taste-as-seat + zero-skill Crowd join *is* the accessibility story; costs a sentence, not build hours.
3. **Audiotool** (opt-in, gated on §8 spike) — a bonus third if convergence works.

Jury incl. Ilaria Manco (Magenta — our exact lane, pitch to her), Andreas Jacobi (Audiotool), Jonathan Rochelle, Lillia Betz, Christian Steinmetz. Magenta mentors incl. Jesse Engel (DDSP), Yotam Mann (Tone.js).

---

## 10. The stack

- **Deterministic audio engine** — drum sequencer + harmony synth + lead synth. Clock-locked backbone + master clock. **Tone.js in the host browser** (fastest path; the host room view is a web page anyway, and Tone.js gives sample-accurate scheduling + Yotam Mann is a mentor).
- **Drum sounds** — Stable-Audio-designed kit samples triggered by our sequencer (realism + live control + grid-lock). Pre-generated, not regenerated live.
- **MRT2** — texture layer, `mrt2_base` on the M4 Pro (fallback `mrt2_small`). Runs as a **Python process on the Mac**, off-grid, conditioned by taste + harmony/lead notes (low cfg) + groove/crowd params. Streams 48kHz stereo audio into the mix.
- **Host server + transport** — **Node.js** (Express + `ws`) serves the web app and relays control/state over WebSocket; the host page runs the Tone.js engine and renders the room view.
- **Audio convergence** — host browser (Tone.js) + Python MRT2 must reach one speaker. Simplest: route both into one sink (e.g. MRT2 → loopback/virtual device or a small WS/UDP audio bridge into the host page, or mix in Python). *Confirm routing approach early — this is the integration to nail (mirrors the Audiotool convergence question).*
- **Phones** — thin browser controllers; control over WebSocket. No model on phone.

### Fallback (nothing can sink us)
Everything on the Mac + a local web server; phones over the browser; audio in the room. No external dependency. Audiotool + neural lead are accelerators, not load-bearing.

---

## 11. What Jamarama is NOT

- **Not Magenta-on-beat / not synced-to-Magenta** — drums are the clock; Magenta floats over the top.
- **Not all-Magenta** — drums/chords/lead are deterministic instruments we own.
- **Not beepy/GarageBand** — the MRT2 texture over the deterministic skeleton is what adds realism.
- **Not more than one live generator in core** — a second neural stream is a gated upgrade only.
- **Not one AI per player** — one MRT2 texture stream, many controllers.
- **Not a step sequencer or DAW** — instruments you play and a wheel you draw on.
- **Crowd is not chaos** — bounded to intensity + mood, clamped.

---

## 12. Build priority (~17h, present Sun 4pm)

**First hour — the two make-or-break tests (compressed from v2's critical tests):**
1. **Texture test:** MRT2's loose texture over a tight local kick — *live* or *sloppy*? (Decides how much MRT2 can do.) — partly answered already by `cloud/` spikes; confirm in-context.
2. **Compute test:** MRT2 (+ later a 2nd neural stream) real-time on the one host Mac — does it hold? Gates the neural lead.
3. *(Parallel, timeboxed)* **Audiotool convergence spike** (§8).

**TIER 0 — core (a complete winning demo by itself):**
- **Master clock + per-bar engine loop** (drum engine). *Build first — everything depends on it.*
- **Host↔phone sync:** Node server + WebSocket + QR join → controller → session. *(building now)*
- **Harmony wheel** (draw-to-sequence) → harmony synth → **re-root on downbeat.** *Heaviest custom piece, load-bearing for the demo beat — strongest builder; tap-to-add fallback.*
- **Drums** (X/Y pad → brain → sampler).
- **MRT2 texture** (low-cfg, taste-conditioned) over the top — prove it turns "beepy" into "produced."
- **Room/spectator visualization** (per-player color, the re-root flash, music readout).
  → **Prove the re-root feels like magic before anything else.**

**TIER 1 — additive:** Lead (brain + simple mono synth) · Crowd (collective energy + mood drops, bounded).

**TIER 2 — polish/upgrade:** neural lead voice (gated on compute test) · taste onboarding / role assignment (fake with presets if needed) · richer harmony (level-2 chords), variable chord duration · Audiotool adapter (gated on convergence spike).

**Cut line:** Tier 0 + Crowd is a full demo. The neural lead is the first thing to drop to a plain synth. Nothing in Tier 2 is load-bearing.

---

## 13. Open questions (resolve today)

1. **Audio convergence** (host Tone.js + Python MRT2 → one speaker): pick the routing approach. *Highest-priority integration.*
2. **Audiotool spike** result (convergence + control-only clients) → adopt or ditch (§8).
3. **Compute test:** MRT2 `base` vs `small`, and headroom for a 2nd neural stream (neural lead).
4. **Role assignment:** join-order fill vs taste-best-fit (fake with presets for the demo if needed).
5. **Team:** secure a Berklee creative-lead angle for the pitch.

---

## 14. Why it wins

- Bullseye on the brief ("experimental interfaces for live, collaborative improvisation"); ideal juror (Manco).
- Deep, *correct* Magenta use: fusion + (optional) neural timbre — its strengths — never timekeeping/note-choosing — its empirically-confirmed weaknesses.
- Magenta carries the thesis (taste-fusion only it can do), even as "just" the texture.
- Differentiated: taste is your seat, not skill; cross-idiom strangers can jam; harmony learned as geometry; judges join the Crowd.
- Sync is solved by architecture, not a fragile scheduler — the hardest old risk is gone.
- Multi-prize, one build: DeepMind (primary) + MIDI Accessibility locked; Audiotool gated.
- Make-or-break answered: audible per-person influence via the re-root beat, carried by a voice guaranteed to be in time.
