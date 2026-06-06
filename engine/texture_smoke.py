"""Smoke test: confirm MRT2 loads and streams in real time on this Mac.
Validates the make-or-break "texture/compute" test from MASTER_SPEC_V3 §12.
Run: ../.venv/bin/python texture_smoke.py
"""
import time
import numpy as np

try:
    from magenta_rt import MagentaRT2Mlxfn as MRT
except ImportError:
    from magenta_rt.mlx.system import MagentaRT2SystemMlxfn as MRT

SIZE = "mrt2_small"
SECONDS = 6

print(f"Loading {SIZE} (MLX/Metal) …")
t0 = time.time()
mrt = MRT(size=SIZE)
print(f"  loaded in {time.time()-t0:.1f}s")

# taste fusion: blend two prompts into one style embedding
style = 0.6 * mrt.embed_style("punk") + 0.4 * mrt.embed_style("qawwali")

state, chunks, rtfs = None, [], []
print(f"Streaming {SECONDS}s of texture (1s chunks)…")
for i in range(SECONDS):
    t = time.time()
    wav, state = mrt.generate(
        style=style, drums=[1],
        cfg_musiccoca=3.0, cfg_notes=1.0, cfg_drums=1.0,
        frames=25, state=state,
    )
    dt = time.time() - t
    rtfs.append(1.0 / dt)
    chunks.append(wav.samples)
    print(f"  chunk {i}: {dt:.2f}s for 1.0s audio  → RTF {1.0/dt:.2f}x")

audio = np.concatenate(chunks, axis=0)
print(f"\nmedian RTF: {np.median(rtfs):.2f}x  (>1.0 = real-time)")
print(f"output: {audio.shape} @ 48kHz stereo")
print("RESULT:", "REAL-TIME ✓" if np.median(rtfs) > 1.0 else "TOO SLOW ✗ (try smaller frames / mrt2_small)")
