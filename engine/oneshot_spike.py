"""MRT2 one-shot timbre spike (Jamarama pre-jam voice rendering).

Question this answers empirically (not by guessing):
  Can MRT2, driven with a SINGLE sustained pitch at high cfg_notes (drums off),
  emit a CLEAN, PITCH-ACCURATE one-shot whose TIMBRE follows the text prompt —
  good enough to load into a Tone.Sampler as the harmony / lead voice?

Why this is the right test (from reading magenta_rt/mlx/system.py):
  - notes is a 128-slot vector, CONSTANT across all frames inside one generate()
    call. So a natural attack→sustain envelope needs a 2-call chain that shares
    `state`: call A = onset (slot=2) for a couple frames, call B = sustain
    (slot=1) for the body. One clean articulation, no per-frame retrigger.
  - drums=[0] + high cfg_drums suppresses percussion (same trick the texture
    engine already uses) so we capture a pitched tone, not a groove.
  - Masking all OTHER pitches to 0 (off) — not -1 (masked) — tells the model
    "only this pitch sounds", which should give the cleanest monophonic tone.
    We render one -1 (masked) variant too, to prove the 0-vs-(-1) difference.

Run:  .venv/bin/python engine/oneshot_spike.py
Out:  engine/spike_out/*.wav  +  engine/spike_out/REPORT.md
"""
import os, time, json, wave
from pathlib import Path
import numpy as np

OUT = Path(__file__).parent / "spike_out"
OUT.mkdir(exist_ok=True)
SR = 48000

# ----- render matrix (kept small to bound runtime) -----------------------
# Two deliberately CONTRASTING prompts: a soft sustained pad vs a bright/edgy
# plucked tone. If the timbres come back audibly + measurably different, the
# "prompt -> voice" link is real.
PROMPTS = {
    "pad":  "warm analog synth pad, soft mellow sustained, no drums",
    "punk": "bright distorted electric guitar, aggressive punk, no drums",
}
PITCH = 60          # C4 — middle of a sampler's range
ONSET_FRAMES = 2    # ~80ms attack call
SUSTAIN_FRAMES = 34 # ~1.36s body
CFG_NOTES_SWEEP = [4.0, 6.0]   # how literally MRT2 states our pitch
CFG_MC = 3.0        # style commitment
TEMP = 1.0          # a touch cooler than default 1.3 for a steadier tone
TOPK = 40


def notes_vec(pitch, slot, others=0):
    v = [others] * 128
    v[pitch] = slot
    return v


def save_wav(path, x):
    x = np.clip(x, -1, 1)
    ints = (x * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(ints.tobytes())


def trim_normalize(x, target_peak=0.89):
    """Trim leading silence, normalize peak. x: [T,2]."""
    mono = x.mean(axis=1)
    thresh = 0.02 * np.abs(mono).max() if np.abs(mono).max() > 0 else 0
    nz = np.where(np.abs(mono) > thresh)[0]
    if len(nz):
        x = x[nz[0]:]
    peak = np.abs(x).max()
    if peak > 0:
        x = x * (target_peak / peak)
    return x


def render(mrt, style_emb, cfg_notes, others=0):
    """One clean one-shot: onset call -> sustain call, sharing state."""
    wav_on, state = mrt.generate(
        style=style_emb, notes=notes_vec(PITCH, 2, others), drums=[0],
        cfg_notes=cfg_notes, cfg_musiccoca=CFG_MC, cfg_drums=6.0,
        temperature=TEMP, top_k=TOPK, frames=ONSET_FRAMES, state=None,
    )
    wav_sus, _ = mrt.generate(
        style=style_emb, notes=notes_vec(PITCH, 1, others), drums=[0],
        cfg_notes=cfg_notes, cfg_musiccoca=CFG_MC, cfg_drums=6.0,
        temperature=TEMP, top_k=TOPK, frames=SUSTAIN_FRAMES, state=state,
    )
    x = np.concatenate([np.asarray(wav_on.samples), np.asarray(wav_sus.samples)], axis=0)
    return x.astype(np.float32)


def analyze(x, target_pitch):
    """Empirical metrics on the sustain region. Returns a dict."""
    import librosa
    mono = x.mean(axis=1).astype(np.float32)
    # sustain region: 0.25s..1.0s after trim
    a, b = int(0.25 * SR), min(len(mono), int(1.0 * SR))
    seg = mono[a:b] if b > a else mono
    target_hz = librosa.midi_to_hz(target_pitch)
    try:
        f0, voiced, vprob = librosa.pyin(
            seg, fmin=float(librosa.midi_to_hz(target_pitch - 12)),
            fmax=float(librosa.midi_to_hz(target_pitch + 12)), sr=SR)
        f0v = f0[~np.isnan(f0)]
        med_hz = float(np.median(f0v)) if len(f0v) else float("nan")
        voiced_frac = float(np.mean(voiced)) if voiced is not None else float("nan")
    except Exception as e:
        med_hz, voiced_frac = float("nan"), float("nan")
    semitone_err = (12 * np.log2(med_hz / target_hz)) if med_hz == med_hz and med_hz > 0 else float("nan")
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=seg, sr=SR)))
    flatness = float(np.mean(librosa.feature.spectral_flatness(y=seg)))  # 0=tonal, 1=noisy
    mfcc = librosa.feature.mfcc(y=seg, sr=SR, n_mfcc=13).mean(axis=1)
    return {
        "median_hz": round(med_hz, 2), "target_hz": round(float(target_hz), 2),
        "pitch_err_semitones": round(semitone_err, 3) if semitone_err == semitone_err else None,
        "voiced_frac": round(voiced_frac, 3) if voiced_frac == voiced_frac else None,
        "spectral_centroid_hz": round(centroid, 1),
        "spectral_flatness": round(flatness, 4),
        "mfcc": [round(float(v), 2) for v in mfcc],
    }


def main():
    t_load = time.time()
    from magenta_rt import MagentaRT2Mlxfn as MRT
    print("[spike] loading mrt2_small …", flush=True)
    mrt = MRT(size="mrt2_small")
    print(f"[spike] loaded in {time.time()-t_load:.1f}s", flush=True)

    embeds = {name: mrt.embed_style(p) for name, p in PROMPTS.items()}
    results = []
    for name, emb in embeds.items():
        for cfg in CFG_NOTES_SWEEP:
            t0 = time.time()
            x = render(mrt, emb, cfg, others=0)
            dt = time.time() - t0
            xt = trim_normalize(x)
            tag = f"{name}_cfg{cfg:g}_off"
            save_wav(OUT / f"{tag}.wav", xt)
            m = analyze(xt, PITCH)
            secs = (ONSET_FRAMES + SUSTAIN_FRAMES) / 25.0
            m.update(prompt=name, cfg_notes=cfg, mask="off(0)", gen_s=round(dt, 2),
                     rtf=round(secs / dt, 2), file=f"{tag}.wav")
            results.append(m)
            print(f"[spike] {tag:22s} f0={m['median_hz']}Hz err={m['pitch_err_semitones']}st "
                  f"voiced={m['voiced_frac']} centroid={m['spectral_centroid_hz']}Hz "
                  f"flat={m['spectral_flatness']} RTF={m['rtf']}", flush=True)
    # one masked(-1) comparison at the higher cfg to show 0-vs-(-1)
    for name, emb in embeds.items():
        x = render(mrt, emb, CFG_NOTES_SWEEP[-1], others=-1)
        xt = trim_normalize(x)
        tag = f"{name}_cfg{CFG_NOTES_SWEEP[-1]:g}_masked"
        save_wav(OUT / f"{tag}.wav", xt)
        m = analyze(xt, PITCH)
        m.update(prompt=name, cfg_notes=CFG_NOTES_SWEEP[-1], mask="masked(-1)",
                 file=f"{tag}.wav")
        results.append(m)
        print(f"[spike] {tag:22s} f0={m['median_hz']}Hz err={m['pitch_err_semitones']}st "
              f"voiced={m['voiced_frac']} centroid={m['spectral_centroid_hz']}Hz "
              f"flat={m['spectral_flatness']}", flush=True)

    # timbre separation: centroid + MFCC distance between the two prompts (cfg=6, off)
    def get(name):
        return next(r for r in results if r["prompt"] == name and r["mask"] == "off(0)"
                    and r["cfg_notes"] == CFG_NOTES_SWEEP[-1])
    pad, punk = get("pad"), get("punk")
    mfcc_dist = float(np.linalg.norm(np.array(pad["mfcc"]) - np.array(punk["mfcc"])))
    cent_ratio = punk["spectral_centroid_hz"] / max(1.0, pad["spectral_centroid_hz"])

    (OUT / "results.json").write_text(json.dumps(results, indent=2))
    print(f"\n[spike] TIMBRE SEPARATION (pad vs punk, cfg{CFG_NOTES_SWEEP[-1]:g}): "
          f"MFCC L2={mfcc_dist:.1f}  centroid ratio={cent_ratio:.2f}x", flush=True)
    print(f"[spike] wrote {len(results)} wavs + results.json to {OUT}")


if __name__ == "__main__":
    main()
