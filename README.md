<img width="5921" height="3947" alt="DSC00034 (1)" src="https://github.com/user-attachments/assets/44adb259-0af1-4494-a861-0832901f8411" />

# jamarama
**we won 1st place in the [`audiotool`](https://www.audiotool.com/) track**

Real-time multiplayer jam: a deterministic, clock-locked band (drums + chords
+ lead, Tone.js in the host browser) wrapped in a loose Magenta RealTime 2
texture halo that lives off the grid. Phones are thin controllers joining
over LAN via QR.

## Try it

```sh
git clone https://github.com/SaiNel7/jamarama.git && cd jamarama
./setup.sh          # Apple Silicon Mac: band + Magenta RealTime 2 texture (downloads weights once)
./setup.sh --lite   # any computer with Node 22+: band only, no Magenta
./start.sh
```

Open `http://localhost:3000`, click **START THE JAM**, and scan the QR with 1–3 phones
(1st phone plays harmony, 2nd plays lead, the rest are the crowd). No phones handy? Open
`http://localhost:3000/join` in a second browser window to play a part yourself.

`start.sh` uses the Magenta texture layer when it's installed and falls back to the
clock-locked band otherwise. The version submitted to the Audiotool Challenge is tagged
`submitted-audiotool`; this branch only adds setup, the fallback, and the bundled default
instrument samples (`app/public/voices_default/`).

### Hosted demo (band only)

`app/gateway.js` runs a public demo: every visitor gets their own room (a separate
`server.js` process), phones join through the room's QR link, and Magenta is off. Deploy it
with the included `render.yaml` (Render → New → Blueprint), or run it locally with
`cd app && npm run demo`.

**Canonical spec:** [`MASTER_SPEC_V3.md`](MASTER_SPEC_V3.md) ·
design system: [`DESIGN.md`](DESIGN.md) · app details: [`app/README.md`](app/README.md)

## Setup (once)

The Magenta texture engine needs the root `.venv` (Python 3.12 via uv;
`app/server.js` spawns `.venv/bin/python engine/texture_engine.py`):

```sh
uv venv --python 3.12 .venv
uv pip install "./external/magenta-realtime[mlx]" sounddevice websocket-client
```

Model weights live in `~/Documents/Magenta/magenta-rt-v2/` (not the repo).
Node deps are bundled (`app/node_modules` committed) — no npm install needed.

## Run

```sh
cd app
npm start                 # → http://localhost:3000
```

- **Host screen:** open `http://localhost:3000` on the room computer, click
  **START THE JAM** (user gesture required for audio). The MRT2 texture engine
  is spawned automatically and OS-mixes with the browser band on the default
  output.
- **Phones:** same WiFi (eduroam blocks device-to-device — use a hotspot),
  scan the QR or open `http://<LAN-IP>:3000/join`. Roles auto-assign:
  1st → Harmony, 2nd → Lead, rest → Crowd.
- `NO_TEXTURE=1 npm start` runs the band without the Magenta engine.
- Phones that join pre-start land in a lobby (name, avatar, taste prompt, ready);
  prompts are LLM-translated into soundscapes for the MRT2 texture blend
  (`ANTHROPIC_API_KEY` in `app/.env`, required for personalization) and feed
  the instrument-voice prebake raw — see `app/README.md`.

## Texture engine standalone checks

```sh
.venv/bin/python engine/texture_engine.py --test   # headless generation check
cd engine && ../.venv/bin/python texture_smoke.py  # RTF smoke test (~2.3x expected)
```

## Repo map

- `app/` — Node host: Express + ws relay, QR join, host console, phone controllers
- `engine/` — MRT2 texture engine (headless WS client, spawned by the app)
- `external/magenta-realtime/` — bundled magenta-rt 2.0.2 source (incl. vendored sequence-layers)
- `prototype/` — archived early spikes (original FastAPI control-path prototype, cfg sweep)
- `cloud/` — earliest model spike scripts
