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
- **Phones:** on the **same WiFi**, scan the QR (or open the printed `http://<LAN-IP>:3000/join`).
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
- `public/css/theme.css` — neo-brutalist design tokens (see `../DESIGN.md`).

## Next (per spec §12)
- Harmony **synth voice** (Tone.js poly) + lead/drum brains locked to the clock.
- **MRT2 texture** layer (`../engine/`) conditioned on blended taste + low-`cfg_notes` chord hints.
- Audio convergence: host Tone.js + Python MRT2 → one speaker (open question §13).
