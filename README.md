# jamarama

Phone-to-Mac live Magenta RealTime 2 controller. A phone browser sends
control messages (chord / taste / chaos) over a WebSocket to a FastAPI server
on the Mac; a background thread runs a continuous `mrt.generate()` loop on
those controls and plays the audio out the Mac's speakers (48 kHz stereo via
sounddevice). The phone gets acks, not audio — it's room audio.

## Run

Magenta RT (MLX) lives in `cloud/.venv`, so run the server from that venv
(fastapi / uvicorn / sounddevice are installed there too):

```sh
cloud/.venv/bin/uvicorn server:app --host 0.0.0.0 --port 8000
```

Model load takes a while; generation and audio start immediately after,
on the default style ("lofi") and default chord (Am).

## Connect from your phone

1. Find your Mac's LAN IP:

   ```sh
   ipconfig getifaddr en0
   ```

2. Phone on the **same network** as the Mac (eduroam blocks device-to-device —
   use a personal hotspot), open:

   ```
   http://<LAN-IP>:8000
   ```

## Controls

| Phone control | Message | Effect |
| --- | --- | --- |
| Chord buttons (Am/Dm/C/G) | `{type:"harmony", chord:"Am"}` | Re-roots the bed within ~1 chunk (~1-3s with buffering). Onset (2) on the first chunk after the change, sustain (3) after; non-chord slots are masked (-1) so the model voices freely |
| Taste text | `{type:"taste", value:"..."}` | **Replaces** the style target (does not layer). Embeds async, then lerps the live embedding toward it (~35%/chunk) — a smooth morph over a few seconds |
| Chaos slider 0-100 | `{type:"chaos", value:N}` | Maps linearly to `cfg_notes` in [4.0 → 1.0]: low chaos = tight harmony-following, high chaos = the model wanders. 50 ≈ 2.5 |

## What to watch in the terminal

- `chunk N gen X.XXs / 1.0s audio RTF Y.YY` per second of audio — RTF should
  stay above 1 (typically ~2.3 on this model).
- `CONTROL ...` lines for every phone message; `STYLE TARGET set to ...` when
  a taste embedding finishes.
- `AUDIO UNDERRUN` warnings if generation ever falls behind playback
  (playback emits silence instead of crashing).

## Architecture notes

- The WebSocket handler only mutates a lock-guarded `SessionState`; it never
  calls the model. The generation thread snapshots that state each chunk
  (25 frames = 1 s) and feeds the rolling Magenta `state` forward every call —
  never re-initialized, so the groove keeps continuity.
- Audio queue holds max 2 chunks; the generator blocks on `put` when ahead,
  which both paces generation and bounds control latency to ~2-3 s.
- MLX is thread-bound, so ALL model calls (load, `embed_style`, `generate`)
  live on the gen thread; taste texts reach it through a queue.
- Model size: `MRT_SIZE=mrt2_base` env var to experiment, but measured RTF on
  this Mac is small ≈ 2.3, base ≈ 0.74 — base cannot stream in real time.
