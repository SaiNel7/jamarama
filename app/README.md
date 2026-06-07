# Jamarama — app (host + phone controllers)

Real-time multiplayer jam over the LAN. The **host browser owns the master clock** (Tone.js
Transport) and broadcasts beats; **phones are thin controllers** that follow. See
[`../MASTER_SPEC_V3.md`](../MASTER_SPEC_V3.md) (canonical) and [`../DESIGN.md`](../DESIGN.md).

## Run
```bash
cd app
npm install        # once
npm start          # → http://localhost:3000
```
- **Host screen:** open `http://localhost:3000` on the room computer, click **START THE JAM**
  (a user gesture is required to enable audio). A kick/hat groove starts and a QR appears.
- **Phones:** scan the QR. A **cloudflared quick tunnel starts automatically** and the QR flips
  to its `https://….trycloudflare.com` URL a few seconds after boot — so phones join from ANY
  network (eduroam, cellular). Needs `brew install cloudflared` once; without it (or offline)
  the QR stays on the LAN URL (`http://<LAN-IP>:3000/join`, same-WiFi only). `NO_TUNNEL=1`
  forces LAN-only; `PUBLIC_URL=…` pins an explicit URL and skips the auto-tunnel.
  Roles are auto-assigned in order: **1st → Harmony, 2nd → Lead, everyone else → Crowd.**
  (Host = Groove/Drums.)

## What works now (Tier-0 core + MRT2 texture)
- Node + WebSocket relay, single room, auto role assignment + live roster.
- Master clock in the host (Tone.js), audible groove, beat fan-out → phones pulse in time.
- **Harmony synth voice (host):** a clock-locked poly synth plays the drawn loop, advancing one
  chord/bar and **re-rooting crisply on the downbeat** (the signature beat), with a flash on the host.
- **Harmony** phone: chord wheel (tap to build a loop); host plays it back, re-root shows on host + phone `NOW PLAYING`.
- **Crowd** phone: mood grid + hold-to-raise-energy → live on the host's energy meter + "just now".
- **Lead** phone: keyboard with instant local test-tone (<20ms) + note relay.
- Host room view: room/key/tempo, G/H/L/C heartbeat dots, QR, roster, now-playing chord, crowd energy.
- **MRT2 texture engine** (`../engine/texture_engine.py`): Magenta RealTime 2 atmosphere conditioned
  on blended taste + the live chord (low `cfg_notes`) + crowd energy; washes toward the new tonal
  center on each re-root; streams to the Mac's default output → OS-mixed with the browser band.

## Full stack (host Mac)
```bash
# 1) host server + web app
cd app && npm start                       # http://localhost:3000  → click START THE JAM

# 2) MRT2 texture layer (separate terminal; runs on the same Mac)
cd engine && ../.venv/bin/python texture_engine.py     # default output = same speaker as the browser
#   smoke test (no audio): ../.venv/bin/python texture_engine.py --test
```
Then phones scan the QR. The browser plays the tight deterministic band; the Python engine plays the
loose MRT2 texture; the OS mixer sums both out one speaker. MRT2 is off-grid by design, so it only
needs to share the speaker, not the clock (MASTER_SPEC_V3 §8–9). MRT2 confirmed real-time on this
Mac (`mrt2_small`, ~2.37× RTF).

## Pre-jam lobby + taste prompts

Phones that join before the host starts land in a **lobby**: name, emoji avatar, an optional
"what are you into?" prompt, and a READY toggle. The host lobby shows `n/m ready`; START is
translucent and **gated until every player is ready** (Kahoot-style — a deliberate deviation
from the spec's "never a gate" invariant; gate is client-side in `startAudio()`, trivially
removable). On START, all prompts are blended into `state.taste`
(the MRT2 style conditioning); blank prompts just ride the blend. Late joiners skip the lobby.

Player prompts shape **two** Magenta layers on jam start:
1. **Texture bed** — each prompt is translated into a SOUNDSCAPE by claude-haiku-4-5
   (`taste.js`, key in `app/.env`): "country" → "dry wind over open plains, distant horse
   whinny, rattlesnake hiss…". Genre words make MRT2 *play* the genre (rhythmic, song-like),
   so there is **no raw-prompt fallback** — if the LLM is unavailable, the prompt is left
   out of the blend and the bed stays default ambient.
2. **Instrument voices** — RAW prompts (genre identity intact, on purpose) drive an MRT2
   one-shot prebake (`prebakeFromTastes()` → `engine/prebake_voices.py`, ~7s); the host gets
   a `voices` broadcast and swaps its harmony/lead synths for the baked Tone.Samplers. Jam
   starts on the built-in synths, personalized voices swap in — never a wait.

Testing the taste pipeline:
```bash
node --env-file=.env taste.js "punk" "country"        # print the soundscape translations
../.venv/bin/python ../engine/sweep_blend.py --llm "country" "punk"
                                                      # blend metrics + A/B renders through
                                                      # the LIVE transform (what players get)
```

## Architecture
```
phones (browser, control-only) ──WS──► Node server (relay + room state) ◄──WS── host browser
                                                                              │ Tone.js clock
                                                                              │ (beats ► all)
                                                                              ▼
                                                              [next] Python MRT2 texture → mix → speaker
```

## Files
- `server.js` — Express static + `ws` relay; role assignment; room state; LAN QR via `/info`.
- `public/host.html` + `js/host.js` — master clock, audible groove, room view.
- `public/join.html` + `js/controllers.js` — phone controllers (per role).
- `public/js/shared.js` — WS `Bus` + protocol + diatonic-chord helpers.
- `taste.js` — taste→soundscape translation (claude-haiku-4-5) → `state.taste`; raw-prompt voice prompts for the prebake.
- `public/css/theme.css` — neo-brutalist design tokens (see `../DESIGN.md`).

## Next (per spec §12)
- Harmony **synth voice** (Tone.js poly) + lead/drum brains locked to the clock.
- **MRT2 texture** layer (`../engine/`) conditioned on blended taste + low-`cfg_notes` chord hints.
- Audio convergence: host Tone.js + Python MRT2 → one speaker (open question §13).
