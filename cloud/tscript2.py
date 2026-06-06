import time, wave
import numpy as np

try:
    from magenta_rt import MagentaRT2Mlxfn as MRT
except ImportError:
    from magenta_rt.mlx.system import MagentaRT2SystemMlxfn as MRT

SR        = 48000
FRAMES    = 25                  # 1.0s per call
SECONDS   = 60
PROMPT    = "120 bpm four on the floor house beat, steady kick drum"
TARGET_BPM = 120.0
CFG_MC    = 3.0
CFG_NOTES = 1.0
OUT       = "tempo_test.wav"

def chord_vec(p, onset=False):
    v = [-1]*128
    for n in p: v[n] = 2 if onset else 3
    return v

def click_track(n_samples, bpm, sr=SR):
    # steady metronome at fixed BPM: short tick every beat, dead-on the grid
    track = np.zeros((n_samples, 2), dtype=np.float32)
    spb = int(sr * 60.0 / bpm)
    tick = int(sr * 0.012)
    t = np.linspace(0, 1, tick)
    blip = (np.sin(2*np.pi*1500*t) * np.hanning(tick) * 0.6).astype(np.float32)
    for i in range(0, n_samples - tick, spb):
        track[i:i+tick, 0] += blip
        track[i:i+tick, 1] += blip
    return track

def save(path, x, sr=SR):
    ints = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(ints.tobytes())

print("Loading...")
mrt = MRT(size="mrt2_small")
style = mrt.embed_style(PROMPT)
notes = chord_vec([45, 48, 52])   # low, stable harmony so the pulse is what you hear

state = None
chunks = []
n_calls = SECONDS  # 1s per call
print(f"Generating {SECONDS}s, prompted at {TARGET_BPM} bpm...")
for i in range(n_calls):
    wav, state = mrt.generate(
        style=style, notes=notes, drums=[1],
        cfg_musiccoca=CFG_MC, cfg_notes=CFG_NOTES, cfg_drums=1.0,
        frames=FRAMES, state=state,
    )
    chunks.append(wav.samples)

magenta = np.concatenate(chunks, axis=0)
n = magenta.shape[0]

# crude tempo estimate from Magenta's own audio (onset autocorrelation, mono)
mono = magenta.mean(axis=1)
hop = 512
env = np.array([np.sqrt(np.mean(mono[j:j+hop]**2)) for j in range(0, n-hop, hop)])
env = np.clip(np.diff(env), 0, None)            # onset-ish flux
env = env - env.mean()
ac = np.correlate(env, env, "full")[len(env)-1:]
fps = SR / hop
lo, hi = int(fps*60/200), int(fps*60/60)        # search 60-200 bpm
peak = lo + np.argmax(ac[lo:hi])
est_bpm = 60.0 * fps / peak
print(f"\nMagenta's estimated self-tempo: {est_bpm:.1f} bpm   (target was {TARGET_BPM})")

click = click_track(n, TARGET_BPM)
mix = magenta * 0.8 + click[:n] * 0.9
save(OUT, mix)
print(f"Saved {OUT}\n")
print("LISTEN (60s): does the click stay glued to Magenta's kick the whole way,")
print("or do they start together and drift apart? Drift = the click slowly")
print("slides off the beat. If they're still locked at 0:55, you're fine.")
print("If est-tempo is far from 120, Magenta ignored the BPM prompt entirely.")