"""Texture-tuning sweep: find the cfg/prompt range where mrt2_small sounds
like an atmospheric LAYER, not a full song. Offline — writes WAVs, no playback.

Run:  cloud/.venv/bin/python sweep_texture.py
"""

import time
import wave

import numpy as np

try:
    from magenta_rt import MagentaRT2Mlxfn as MRT
except ImportError:
    from magenta_rt.mlx.system import MagentaRT2SystemMlxfn as MRT

SR = 48000
FRAMES = 25  # 1.0s per generate() call
CFG_MUSICCOCA = 3.0
AM = [57, 60, 64]

ATMOS = ("ambient electric guitar texture, airy reverb pads, atmospheric, "
         "free time, unmetered, sustained, no drums, no beat")


def chord_vec(pitches):
    """128-slot notes vector: given pitches = 3 (sustained/held — NOT onset,
    we want held ambient), everything else -1 (masked, model decides)."""
    v = [-1] * 128
    for p in pitches:
        v[p] = 3
    return v


def clamp_cfg(x):
    return max(-1.0, min(7.0, float(x)))


def save_wav(path, samples, sr=SR):
    ints = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(ints.tobytes())


print("Loading mrt2_small ...")
t0 = time.time()
mrt = MRT(size="mrt2_small")
print(f"Loaded in {time.time() - t0:.1f}s\n")

NOTES_AM = chord_vec(AM)


def render(name, prompt, cfg_notes, cfg_drums, drums_on, secs=8):
    style = mrt.embed_style(prompt)
    cfg_notes = clamp_cfg(cfg_notes)
    cfg_drums = clamp_cfg(cfg_drums)
    drums = [1 if drums_on else 0]

    state = None
    chunks = []
    gen_time = 0.0
    for _ in range(secs):
        t0 = time.time()
        wav, state = mrt.generate(
            style=style, notes=NOTES_AM, drums=drums,
            cfg_notes=cfg_notes, cfg_musiccoca=CFG_MUSICCOCA, cfg_drums=cfg_drums,
            frames=FRAMES, state=state,
        )
        gen_time += time.time() - t0
        chunks.append(wav.samples)

    path = f"tex_{name}.wav"
    save_wav(path, np.concatenate(chunks, axis=0))
    rtf = secs * (FRAMES / 25.0) / gen_time
    print(f"{path:22s} prompt={prompt[:40]!r:44s} cfg_notes={cfg_notes:5.2f} "
          f"cfg_drums={cfg_drums:4.2f} drums={drums}  avg RTF {rtf:.2f}")
    return path


written = [
    render("genre_full", "lofi hip hop", cfg_notes=2.0,  cfg_drums=1.0, drums_on=True),
    render("atmos_n2",   ATMOS,          cfg_notes=2.0,  cfg_drums=0.0, drums_on=False),
    render("atmos_n1",   ATMOS,          cfg_notes=1.0,  cfg_drums=0.0, drums_on=False),
    render("atmos_n0",   ATMOS,          cfg_notes=0.0,  cfg_drums=0.0, drums_on=False),
    render("atmos_nneg", ATMOS,          cfg_notes=-0.5, cfg_drums=0.0, drums_on=False),
]

print("\nListen in order:", "  ".join(written))
