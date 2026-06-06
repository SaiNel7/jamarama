# prototype/ — archived early spikes

Superseded by [`/app`](../app) + [`/engine`](../engine) per
[`MASTER_SPEC_V3.md`](../MASTER_SPEC_V3.md). Kept for reference.

- **`server.py` + `static/index.html`** — the original phone→Mac control-path
  prototype: FastAPI WebSocket server with an in-process MRT2 generation loop
  (chord buttons / taste text / chaos slider from a phone browser, audio out
  the Mac speaker). Its lessons live on in `engine/texture_engine.py`
  (MLX thread-bound gen loop, onset-once/sustain/-1-masked chord vectors,
  queue-fed sounddevice output).
- **`sweep_texture.py`** — offline cfg_notes sweep that renders
  `tex_<name>.wav` A/B files for finding the "atmospheric layer, not a song"
  range. Still useful for tuning the texture engine; run with:

  ```sh
  .venv/bin/python prototype/sweep_texture.py   # from repo root
  ```

  (Writes `tex_*.wav` into the working dir; they're generated artifacts and
  not committed.)
- **`requirements.txt`** — deps for the old FastAPI server only. The real env
  is the root `.venv` — see the root README for setup.
