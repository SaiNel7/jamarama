import time
import wave
import numpy as np

# Use the exported-mlxfn class (loads models/<name>/<name>.mlxfn — what you have on disk)
try:
    from magenta_rt import MagentaRT2Mlxfn as MRT
except ImportError:
    from magenta_rt.mlx.system import MagentaRT2SystemMlxfn as MRT

# ---- knobs (tune these) -------------------------------------------------
SIZE       = "mrt2_small"
FRAMES     = 30          # 25 frames = 1.0s of audio = one "bar" here
CFG_NOTES  = 4.0         # how hard the bed follows your harmony (THE knob to tune)
CFG_MC     = 3.0         # how hard it follows the style prompt
CFG_DRUMS  = 1.0
PROMPT_A   = "punk"
PROMPT_B   = "qawwali"
OUT        = "spike.wav"
# -------------------------------------------------------------------------

def chord_vec(midi_pitches, onset=False):
    # 128-slot notes vector: -1 masked (let model decide), 2 onset, 3 sustained-on
    v = [-1] * 128
    for p in midi_pitches:
        v[p] = 2 if onset else 3
    return v

DM    = chord_vec([62, 65, 69])           # D minor: D4 F4 A4
A_MAJ = chord_vec([61, 64, 69], onset=True)  # A major: C#4 E4 A4 (re-attack on re-root)

def lerp(a, b, t):
    return (1.0 - t) * a + t * b

def save_wav(path, samples, sr=48000):
    ints = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(ints.tobytes())

print(f"Loading {SIZE} via {MRT.__name__} ...")
mrt = MRT(size=SIZE)

emb_a = mrt.embed_style(PROMPT_A)
emb_b = mrt.embed_style(PROMPT_B)
print("style embedding:", type(emb_a).__name__, "shape:", getattr(emb_a, "shape", None))

state = None
all_samples = []

# for bar in range(8):
#     # --- style schedule: A for bars 0-1, morph A->B over 2-5, B after ---
#     if bar <= 1:
#         style, phase = emb_a, "A) base groove (continuity test)"
#     elif bar <= 5:
#         t = (bar - 2) / 3.0
#         style, phase = lerp(emb_a, emb_b, t), f"B) morph {PROMPT_A}->{PROMPT_B} t={t:.2f}"
#     else:
#         style, phase = emb_b, "B-held"

#     # --- notes schedule: Dm until bar 6, then re-root to A major ---
#     if bar < 6:
#         notes, chord = DM, "Dm"
#     else:
#         notes, chord, phase = A_MAJ, "A (RE-ROOT)", "C) re-root to A major"

#     t0 = time.time()
#     wav, state = mrt.generate(
#         style=style, notes=notes, drums=[1],
#         cfg_notes=CFG_NOTES, cfg_musiccoca=CFG_MC, cfg_drums=CFG_DRUMS,
#         frames=FRAMES, state=state,
#     )
#     dt = time.time() - t0
#     secs = FRAMES / 25.0
#     print(f"bar {bar}: {phase:32s} chord={chord:11s} gen {dt:4.2f}s / {secs:.1f}s audio  RTF {secs/dt:4.2f}")
#     all_samples.append(wav.samples)
HELD_STYLE = mrt.embed_style("disco funk")   # one stable bed, no morph

for bar in range(8):
    if bar < 4:
        notes, chord = DM, "Dm"
    else:
        notes, chord = chord_vec([57, 60, 64], onset=True), "Am (RE-ROOT)"  # A minor, clear move
    wav, state = mrt.generate(
        style=HELD_STYLE, notes=notes, drums=[1],
        cfg_notes=4.0, cfg_musiccoca=3.0, cfg_drums=1.0,
        frames=25, state=state,
    )
    print(f"bar {bar}: {chord:14s} cfg_notes=4.0")
    all_samples.append(wav.samples)

    
save_wav(OUT, np.concatenate(all_samples, axis=0))
print(f"\nSaved {OUT}")
print("Listen for: bars 0-1 steady groove that doesn't restart (continuity),")
print(f"            bars 2-5 sliding from {PROMPT_A} toward {PROMPT_B} (style morph),")
print("            bars 6-7 harmony re-roots to A without the groove restarting (the demo beat).")
print("samples shape:", wav.samples.shape, "dtype:", wav.samples.dtype)
