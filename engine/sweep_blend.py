"""Taste-blend test harness — does merging player prompts keep everyone's vibe?

The live engine averages every player's prompt embedding equal-weight, then blends
60/40 with the ambient anchor (texture_engine.py style_for). Three failure modes:
  1. MUSH    — averaging N prompts collapses to generic-music centroid
  2. DROWN   — one prompt dominates the blend, another vanishes
  3. TAKEOVER— the anchor (40%) flattens whatever survived

Two probes:
  A. Embedding metrics (instant): cosine similarities — each prompt vs the blend
     (who survives?), prompt-vs-prompt (how diverse is the room?), blend vs anchor
     (is the bed just anchor?).
  B. A/B renders (judge by ear): each prompt solo, the full blend, and the blend
     at anchor weights 0.2 / 0.4 (live value) / 0.6 — all on the same held-Am bed,
     dry (no DSP wash) to isolate blending effects from the downstream low-pass.

Run:   .venv/bin/python engine/sweep_blend.py "punk" "like rain on a sunday" [more...]
       .venv/bin/python engine/sweep_blend.py --llm "country" "punk"
         --llm runs each prompt through the SAME transform the live lobby uses
         (app/taste.js: soundscape rewrite via claude-haiku-4-5, key from app/.env,
         append fallback) — so the renders test exactly what players would get.
         Without it, the raw strings are embedded as-is.
Output: tex_blend_*.wav in the working dir + a metrics table on stdout.
"""

import json
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

try:
    from magenta_rt import MagentaRT2Mlxfn as MRT
except ImportError:
    from magenta_rt.mlx.system import MagentaRT2SystemMlxfn as MRT

SR = 48000
FRAMES = 25
SECS = 8
AM = [57, 60, 64]

# Keep in sync with engine/texture_engine.py
ANCHOR_PROMPT = ("ambient sustained synth pads, atmospheric drone, shimmering "
                 "reverb wash, beatless, free time, textural ambience")
LIVE_ANCHOR_WEIGHT = 0.3


def chord_vec(pitches):
    v = [-1] * 128
    for p in pitches:
        v[p] = 3
    return v


def save_wav(path, samples, sr=SR):
    ints = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(ints.tobytes())


def cos(a, b):
    a, b = np.asarray(a, dtype=np.float32).ravel(), np.asarray(b, dtype=np.float32).ravel()
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


args = sys.argv[1:]
use_llm = "--llm" in args
prompts = [a for a in args if a != "--llm"] or ["punk", "like rain on a sunday"]
if len(prompts) < 2:
    sys.exit("need at least 2 prompts to test a blend")

if use_llm:
    # Run the live lobby transform (app/taste.js) so we embed what players get.
    app_dir = Path(__file__).resolve().parent.parent / "app"
    r = subprocess.run(
        ["node", "--env-file-if-exists=.env", "taste.js", "--json", *prompts],
        cwd=app_dir, capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        sys.exit(f"taste.js failed: {r.stderr.strip()[:300]}")
    arr = json.loads(r.stdout.strip().splitlines()[-1])
    print("\n=== live arrangement (what actually gets embedded) ===")
    print(f"  genres: {arr.get('genres')}  prog: {arr.get('progression')}  scale: {arr.get('scale')}")
    if not arr.get("texture"):
        sys.exit("empty texture — no genre matched and no ANTHROPIC_API_KEY for the vibe enricher "
                 "(live behavior: the bed plays the default ambient).")
    for t in arr["texture"]:
        print(f"   • {t}")
    prompts = arr["texture"]   # the live room embeds the fused texture strings, not raw prompts

print("Loading mrt2_small ...")
mrt = MRT(size="mrt2_small")
NOTES_AM = chord_vec(AM)

embs = [np.asarray(mrt.embed_style(p), dtype=np.float32) for p in prompts]
anchor = np.asarray(mrt.embed_style(ANCHOR_PROMPT), dtype=np.float32)
taste_blend = sum(embs) / len(embs)                       # what the live engine computes
anchored = lambda w: (1 - w) * taste_blend + w * anchor   # then 60/40 with the anchor

# ---- probe A: embedding metrics --------------------------------------------
live = anchored(LIVE_ANCHOR_WEIGHT)
print("\n=== embedding metrics (cosine similarity) ===")
print("prompt ↔ prompt (room diversity — low = more interesting blend):")
for i in range(len(prompts)):
    for j in range(i + 1, len(prompts)):
        print(f"  {prompts[i][:28]!r:32s} ↔ {prompts[j][:28]!r:32s} {cos(embs[i], embs[j]):.3f}")
print("prompt ↔ final blend (survival — roughly equal = fair merge; one ≫ others = DROWN):")
for p, e in zip(prompts, embs):
    print(f"  {p[:28]!r:32s} {cos(e, live):.3f}")
print(f"blend ↔ anchor (TAKEOVER check — >0.95 means the bed is mostly anchor): {cos(live, anchor):.3f}")
print(f"taste-only blend ↔ anchor (how texture-y the tastes already are):       {cos(taste_blend, anchor):.3f}")

# ---- probe B: renders --------------------------------------------------------
def render(name, style, label):
    state, chunks, gen = None, [], 0.0
    for _ in range(SECS):
        t0 = time.time()
        wav, state = mrt.generate(
            style=style, notes=NOTES_AM, drums=[0],
            cfg_notes=2.0, cfg_musiccoca=3.5, cfg_drums=6.0,   # live values — keep in sync
            frames=FRAMES, state=state,
        )
        gen += time.time() - t0
        chunks.append(wav.samples)
    path = f"tex_blend_{name}.wav"
    save_wav(path, np.concatenate(chunks, axis=0))
    print(f"{path:30s} {label}  (RTF {SECS / gen:.2f})")
    return path

print("\n=== renders (dry — no DSP wash, isolates the blend) ===")
written = []
for i, (p, e) in enumerate(zip(prompts, embs)):
    written.append(render(f"solo{i}", anchored_solo := (1 - LIVE_ANCHOR_WEIGHT) * e + LIVE_ANCHOR_WEIGHT * anchor,
                          f"SOLO  {p[:40]!r}"))
written.append(render("full_a03", anchored(0.3), f"BLEND of {len(prompts)} @ anchor .3 — THE LIVE VALUE"))
written.append(render("full_a02", anchored(0.2), "diagnostic floor @ .2 — more taste, watch for rhythmic leak"))
written.append(render("full_a05", anchored(0.5), "diagnostic ceiling @ .5 — anchor-heavy, tastes fading"))

print("\nListen for:")
print("  • solo_i vs full_a03 — can you still hear EACH player in the blend? (DROWN/MUSH)")
print("  • full_a02 vs a03 vs a05 — where does taste die into wallpaper? (TAKEOVER)")
print("  • re-run with LLM rewrites (node app/taste.js \"<prompt>\") to A/B append vs llm blends")
print("\nFiles:", "  ".join(written))
