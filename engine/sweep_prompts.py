"""Prompt-ingestion A/B harness — offline, writes WAVs, no playback.

Renders the same held-Am bed under different prompt treatments so you can
settle by ear:
  1. raw user prompt vs append-transformed (does the suffix tame a beat-heavy
     genre into a texture layer?)
  2. positive-only anchor vs negative-phrased anchor ("no drums, no bass" —
     MusicCoCa is contrastive, negation may embed NEAR the thing it negates)
  3. any custom strings (e.g. paste in LLM rewrites from `node app/taste.js`)

Run:  .venv/bin/python engine/sweep_prompts.py ["custom prompt" ...]
Output: tex_<name>.wav files in the working dir (8s each, 48kHz stereo).
"""

import sys
import time
import wave

import numpy as np

try:
    from magenta_rt import MagentaRT2Mlxfn as MRT
except ImportError:
    from magenta_rt.mlx.system import MagentaRT2SystemMlxfn as MRT

SR = 48000
FRAMES = 25  # 1.0s per generate() call
SECS = 8
AM = [57, 60, 64]

# Mirrors app/taste.js APPEND_SUFFIX — keep in sync when tuning.
APPEND_SUFFIX = "rendered as beatless ambient texture, sustained pads, atmospheric wash"
RAW_PROMPT = "punk"  # deliberately beat-heavy: the hardest case for "texture, not a song"

# Anchor candidates (texture_engine.py ANCHOR_PROMPT) — positive vs negative phrasing.
ANCHOR_POS = ("ambient sustained synth pads, atmospheric drone, shimmering "
              "reverb wash, beatless, free time, textural ambience")
ANCHOR_NEG = ("ambient texture, no drums, no bass, just texturing, not rhythmic "
              "components, create ambience only")
ANCHOR_WEIGHT = 0.3   # live value (texture_engine.py) — keep in sync


def chord_vec(pitches):
    v = [-1] * 128          # rest masked (model decides)
    for p in pitches:
        v[p] = 3            # sustained — held ambient, not re-attacked
    return v


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


def render(name, style_emb, label):
    state = None
    chunks = []
    gen_time = 0.0
    for _ in range(SECS):
        t0 = time.time()
        wav, state = mrt.generate(
            style=style_emb, notes=NOTES_AM, drums=[0],
            cfg_notes=2.0, cfg_musiccoca=3.5, cfg_drums=6.0,   # live values — keep in sync
            frames=FRAMES, state=state,
        )
        gen_time += time.time() - t0
        chunks.append(wav.samples)
    path = f"tex_{name}.wav"
    save_wav(path, np.concatenate(chunks, axis=0))
    print(f"{path:28s} {label}  (RTF {SECS / gen_time:.2f})")
    return path


def emb(text):
    return mrt.embed_style(text)


def anchored(taste_text, anchor_text):
    return (1 - ANCHOR_WEIGHT) * emb(taste_text) + ANCHOR_WEIGHT * emb(anchor_text)


written = [
    # 1) raw vs append (both through the positive anchor blend, like the live engine)
    render("raw",        anchored(RAW_PROMPT, ANCHOR_POS),
           f"raw {RAW_PROMPT!r} + pos anchor"),
    render("append",     anchored(f"{RAW_PROMPT}, {APPEND_SUFFIX}", ANCHOR_POS),
           "append-transformed + pos anchor"),
    # 2) anchor phrasing head-to-head (same append-transformed taste)
    render("anchor_neg", anchored(f"{RAW_PROMPT}, {APPEND_SUFFIX}", ANCHOR_NEG),
           "append-transformed + NEG anchor ('no drums, no bass')"),
    # 3) anchor alone (what the bed sounds like with zero user taste)
    render("anchor_only", emb(ANCHOR_POS), "pos anchor alone"),
]

# Custom strings from the CLI — e.g. paste in LLM rewrites from `node app/taste.js`.
for i, text in enumerate(sys.argv[1:]):
    written.append(render(f"custom{i}", anchored(text, ANCHOR_POS), f"custom: {text[:50]!r}"))

print("\nListen in order:", "  ".join(written))
print("Verdicts to settle: does append tame the beat? does the NEG anchor leak rhythm?")
