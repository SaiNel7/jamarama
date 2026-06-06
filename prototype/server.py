"""Phone-to-Mac live Magenta RT 2 controller.

Phone browser sends control messages over /ws; a background thread runs a
continuous mrt.generate() loop conditioned on shared SessionState; audio
plays out the Mac's default output via sounddevice. The phone gets acks,
not audio — this is room audio.

MLX is thread-bound: every model call (load, embed_style, generate) must
happen on the same thread, so the gen thread owns the model entirely and
taste embeds arrive via a job queue drained between chunks.

Run:  cloud/.venv/bin/uvicorn server:app --host 0.0.0.0 --port 8000
"""

import json
import logging
import os
import queue
import threading
import time
from datetime import datetime

import numpy as np
import sounddevice as sd
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("jamarama")

# ---- tuning ---------------------------------------------------------------
# mrt2_small is the only size that streams in real time on this Mac:
# measured RTF small ~2.3, base ~0.74 (base can't keep up — constant underruns).
MODEL_SIZE = os.environ.get("MRT_SIZE", "mrt2_small")
SR = 48000
FRAMES = 25          # 25 frames = 1.0s of audio per generate() call
CFG_MUSICCOCA = 3.0
CFG_DRUMS = 1.0
DEFAULT_CFG_NOTES = 2.0
DEFAULT_STYLE = "lofi"
DEFAULT_CHORD = "Am"
STYLE_LERP = 0.35    # per-chunk exponential approach toward target embedding
AUDIO_QUEUE_CHUNKS = 2  # max chunks buffered ahead; bounds control latency to ~2-3s

# chaos 0-100 -> cfg_notes, linearly mapped into a SAFE bounded range
# [4.0 .. 1.0]: low chaos = strong harmony conditioning (tight, predictable),
# high chaos = weak conditioning (the model wanders more). chaos 50 -> 2.5,
# near the 2.0 default. Bounds match what the spike scripts used (1.0-4.0).
CHAOS_CFG_MAX = 4.0
CHAOS_CFG_MIN = 1.0

CHORDS = {
    "Am": [57, 60, 64],
    "Dm": [62, 65, 69],
    "C":  [60, 64, 67],
    "G":  [55, 59, 62],
}


def chord_vec(midi_pitches, onset=False):
    """128-slot notes vector, matching the proven spike (cloud/tscript.py):
    chord pitches = 2 (onset) or 3 (sustain), rest = -1 (masked, model decides).
    Onset only on the chunk right after a chord change — re-attacking every
    chunk makes the bed stutter; forcing the rest to 0 strangles it to 3 pitches."""
    v = [-1] * 128
    for p in midi_pitches:
        v[p] = 2 if onset else 3
    return v


def chaos_to_cfg_notes(chaos):
    chaos = max(0, min(100, chaos))
    return CHAOS_CFG_MAX - (CHAOS_CFG_MAX - CHAOS_CFG_MIN) * (chaos / 100.0)


# ---- shared state ----------------------------------------------------------
class SessionState:
    """Conditioning shared between the WS handler (writer) and gen loop (reader).
    The rolling generation `state` is NOT here — it lives only in the loop."""

    def __init__(self):
        self.lock = threading.Lock()
        self.style_target = None        # np.float32 (768,) — set by gen thread
        self.chord_pitches = CHORDS[DEFAULT_CHORD]
        self.chord_fresh = False        # True right after a chord change -> one onset chunk
        self.drums = [1]
        self.cfg_notes = DEFAULT_CFG_NOTES


session = SessionState()
embed_requests = queue.Queue()  # taste texts -> embedded on the gen thread

# ---- audio out -------------------------------------------------------------
audio_q = queue.Queue(maxsize=AUDIO_QUEUE_CHUNKS)
_leftover = np.zeros((0, 2), dtype=np.float32)
underruns = 0


def audio_callback(outdata, frames, time_info, status):
    """Pull samples from the chunk queue; on underrun emit silence, never crash."""
    global _leftover, underruns
    buf = _leftover
    while buf.shape[0] < frames:
        try:
            buf = np.concatenate([buf, audio_q.get_nowait()], axis=0)
        except queue.Empty:
            break
    if buf.shape[0] >= frames:
        outdata[:] = buf[:frames]
        _leftover = buf[frames:]
    else:
        outdata[:buf.shape[0]] = buf
        outdata[buf.shape[0]:] = 0
        _leftover = np.zeros((0, 2), dtype=np.float32)
        underruns += 1  # logged from the gen loop, not here (callback must stay fast)


# ---- generation loop (owns ALL model calls) ---------------------------------
def generation_loop():
    global underruns

    # Proven import path from cloud/tscript.py. Import here too so every
    # MLX-touching line runs on this thread.
    try:
        from magenta_rt import MagentaRT2Mlxfn as MRT
    except ImportError:
        from magenta_rt.mlx.system import MagentaRT2SystemMlxfn as MRT

    log.info("Loading %s via %s ... (this takes a while)", MODEL_SIZE, MRT.__name__)
    t0 = time.time()
    mrt = MRT(size=MODEL_SIZE)
    log.info("Model loaded in %.1fs", time.time() - t0)

    target = np.asarray(mrt.embed_style(DEFAULT_STYLE), dtype=np.float32)
    with session.lock:
        session.style_target = target
    log.info("Default style embedded: %r — generation starting", DEFAULT_STYLE)

    state = None
    style = target.copy()  # live embedding, lerped toward session.style_target
    last_underruns = underruns  # callback ran on silence during model load; not real underruns
    chunk_n = 0

    while True:
        # embed any pending taste texts (newest wins if several queued)
        while True:
            try:
                text = embed_requests.get_nowait()
            except queue.Empty:
                break
            te = time.time()
            emb = np.asarray(mrt.embed_style(text), dtype=np.float32)
            with session.lock:
                session.style_target = emb
            log.info("STYLE TARGET set to %r (embed took %.2fs)", text, time.time() - te)

        with session.lock:
            target = session.style_target
            # onset on the first chunk after a chord change, sustain after
            notes = chord_vec(session.chord_pitches, onset=session.chord_fresh)
            session.chord_fresh = False
            drums = list(session.drums)
            cfg_notes = session.cfg_notes

        # smooth style morph: exponential approach, snap when close
        style = style + STYLE_LERP * (target - style)
        if float(np.max(np.abs(target - style))) < 1e-4:
            style = target.copy()

        t0 = time.time()
        wav, state = mrt.generate(
            style=style, notes=notes, drums=drums,
            cfg_notes=cfg_notes, cfg_musiccoca=CFG_MUSICCOCA, cfg_drums=CFG_DRUMS,
            frames=FRAMES, state=state,
        )
        dt = time.time() - t0
        secs = FRAMES / 25.0
        chunk_n += 1
        log.info("chunk %4d  gen %.2fs / %.1fs audio  RTF %.2f  cfg_notes %.2f",
                 chunk_n, dt, secs, secs / dt, cfg_notes)
        if underruns > last_underruns:
            log.warning("AUDIO UNDERRUN x%d (generation fell behind playback)",
                        underruns - last_underruns)
            last_underruns = underruns

        samples = np.asarray(wav.samples, dtype=np.float32)
        audio_q.put(samples)  # blocks when AUDIO_QUEUE_CHUNKS ahead — that's the pacing


# ---- control handling ------------------------------------------------------
def handle_control(msg: dict) -> dict:
    """Mutate SessionState from a phone control message. Never calls the model."""
    log.info("CONTROL  %s  %s", datetime.now().isoformat(timespec="milliseconds"), msg)
    mtype = msg.get("type")

    if mtype == "harmony":
        chord = msg.get("chord")
        if chord not in CHORDS:
            return {"ack": False, "error": f"unknown chord {chord!r}", "echo": msg}
        with session.lock:
            session.chord_pitches = CHORDS[chord]
            session.chord_fresh = True
        return {"ack": True, "changed": {"chord": chord, "pitches": CHORDS[chord]}, "echo": msg}

    if mtype == "taste":
        text = str(msg.get("value", "")).strip()
        if not text:
            return {"ack": False, "error": "empty taste", "echo": msg}
        embed_requests.put(text)
        return {"ack": True, "changed": {"style": text, "note": "embedding async, morphs in"},
                "echo": msg}

    if mtype == "chaos":
        try:
            chaos = float(msg.get("value"))
        except (TypeError, ValueError):
            return {"ack": False, "error": "chaos value not a number", "echo": msg}
        cfg = chaos_to_cfg_notes(chaos)
        with session.lock:
            session.cfg_notes = cfg
        return {"ack": True, "changed": {"chaos": chaos, "cfg_notes": round(cfg, 2)}, "echo": msg}

    return {"ack": False, "error": f"unknown type {mtype!r}", "echo": msg}


# ---- web app ---------------------------------------------------------------
app = FastAPI()


@app.on_event("startup")
def start_engine():
    threading.Thread(target=generation_loop, daemon=True, name="gen").start()
    stream = sd.OutputStream(samplerate=SR, channels=2, dtype="float32",
                             callback=audio_callback)
    stream.start()
    app.state.stream = stream
    log.info("Audio stream started; model loading in gen thread. Defaults: "
             "style=%r chord=%s cfg_notes=%.1f", DEFAULT_STYLE, DEFAULT_CHORD,
             DEFAULT_CFG_NOTES)


@app.get("/")
async def index():
    return FileResponse("static/index.html")


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    client = f"{ws.client.host}:{ws.client.port}" if ws.client else "unknown"
    log.info("CONNECT     %s", client)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("BAD JSON from %s: %r", client, raw)
                await ws.send_json({"ack": False, "error": "invalid JSON"})
                continue
            ack = handle_control(msg)
            await ws.send_json(ack)
    except WebSocketDisconnect:
        log.info("DISCONNECT  %s", client)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
