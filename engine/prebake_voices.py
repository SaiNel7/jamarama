"""Pre-bake the host's two VOICES (harmony + lead) from the user's taste, BEFORE the jam.

This is the chosen path INSTEAD of Magenta DDSP (which is timbre-transfer over 4 fixed
pretrained instruments, not prompt-conditioned, and won't pip-install on Apple Silicon).
We drive the already-installed MRT2 (MLX/Metal) with a single sustained pitch at high
cfg_notes (drums off) to emit a clean, pitched one-shot whose TIMBRE follows the prompt,
then load those one-shots into a Tone.Sampler on the host. Done offline → zero real-time
neural cost during the jam; the brain's deterministic notes just play through a
prompt-shaped sampler. Recipe proven empirically in oneshot_spike.py / spike_out/FINDINGS.md.

Rules baked in (each empirically forced, see FINDINGS.md):
  - one pitch: onset call (slot=2) → sustain call (slot=1) sharing `state` (the notes block
    is constant within a generate() call, so attack+sustain needs the 2-call chain);
  - mask ALL other pitches to 0 (off), not -1 (masked) → voiced ~1.0 instead of drifting;
  - cfg_notes≈4 (steadier than 6), cfg_musiccoca=3, temp=1.0, drums=[0], cfg_drums=6;
  - pitch CLASS is reliable but OCTAVE is not — the model picks a register to suit the
    timbre — so we DETECT the real f0 with librosa.pyin and LABEL the sample by the detected
    pitch; Tone.Sampler then shifts from ground truth.

Run:
  .venv/bin/python engine/prebake_voices.py \
      --harmony "warm analog pad" --lead "bright lead synth" [--out app/public/voices]
"""
import sys, json, time, wave, argparse
from pathlib import Path
import numpy as np

SR = 48000
ONSET_FRAMES = 2          # ~80ms attack call
SUSTAIN_FRAMES = 34       # ~1.36s body
CFG_NOTES = 4.0           # spike sweet spot (steadier than 6)
CFG_MC = 3.0              # style commitment
CFG_DRUMS = 6.0           # suppress percussion
TEMP = 1.0
TOPK = 40
# Anchor pitches to render per voice (wide spread). We relabel each by its DETECTED pitch,
# so the Sampler interpolates between whatever distinct registers the model actually emits.
ANCHORS = [48, 60, 72]    # C3, C4, C5
# Bias every prompt toward a clean, pitched, drumless tone regardless of genre.
CLEAN_SUFFIX = "single sustained note, clean tone, no drums, no percussion"

REPO = Path(__file__).resolve().parent.parent


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
    """Trim leading silence + normalize peak. x: [T,2]."""
    mono = x.mean(axis=1)
    mx = np.abs(mono).max()
    if mx > 0:
        nz = np.where(np.abs(mono) > 0.02 * mx)[0]
        if len(nz):
            x = x[nz[0]:]
        peak = np.abs(x).max()
        if peak > 0:
            x = x * (target_peak / peak)
    return x.astype(np.float32)


def render_pitch(mrt, emb, pitch):
    """One clean one-shot for `pitch`: onset call → sustain call, sharing state."""
    wav_on, state = mrt.generate(
        style=emb, notes=notes_vec(pitch, 2, 0), drums=[0],
        cfg_notes=CFG_NOTES, cfg_musiccoca=CFG_MC, cfg_drums=CFG_DRUMS,
        temperature=TEMP, top_k=TOPK, frames=ONSET_FRAMES, state=None)
    wav_sus, _ = mrt.generate(
        style=emb, notes=notes_vec(pitch, 1, 0), drums=[0],
        cfg_notes=CFG_NOTES, cfg_musiccoca=CFG_MC, cfg_drums=CFG_DRUMS,
        temperature=TEMP, top_k=TOPK, frames=SUSTAIN_FRAMES, state=state)
    x = np.concatenate([np.asarray(wav_on.samples), np.asarray(wav_sus.samples)], axis=0)
    return trim_normalize(x.astype(np.float32))


def detect_midi(x, requested):
    """Detected MIDI pitch of the sustain region (octave from MRT2 is unreliable)."""
    import librosa
    mono = x.mean(axis=1).astype(np.float32)
    a, b = int(0.25 * SR), min(len(mono), int(1.0 * SR))
    seg = mono[a:b] if b > a else mono
    try:
        f0, voiced, _ = librosa.pyin(seg, fmin=55.0, fmax=2093.0, sr=SR)   # A1..C7
        f0v = f0[~np.isnan(f0)]
        if len(f0v):
            med = float(np.median(f0v))
            vf = float(np.mean(voiced)) if voiced is not None else 0.0
            return int(round(float(librosa.hz_to_midi(med)))), vf
    except Exception:
        pass
    return requested, 0.0


def bake_voice(mrt, label, prompt, outdir):
    """Render a voice across the anchor pitches → {noteName: filename} sampler map."""
    import librosa
    full = f"{prompt}, {CLEAN_SUFFIX}"
    emb = mrt.embed_style(full)
    urls, dropped = {}, 0
    for p in ANCHORS:
        x = render_pitch(mrt, emb, p)
        det, voiced = detect_midi(x, p)
        det = max(24, min(96, det))                       # clamp to a sane sampler range
        note = librosa.midi_to_note(det, unicode=False)   # e.g. "C4"
        fname = f"{label}_{note.replace('#', 's')}.wav"
        save_wav(outdir / fname, x)
        if note in urls:
            dropped += 1                                  # same detected pitch → keep the latest
        urls[note] = fname
        print(f"[prebake] {label:7s} req {librosa.midi_to_note(p, unicode=False):>3s} "
              f"-> detected {note:>3s}  voiced={voiced:.2f}  {fname}", flush=True)
    if dropped:
        print(f"[prebake] {label}: {dropped} anchor(s) collapsed to an existing pitch "
              f"(model chose one register) — Sampler will shift from {len(urls)} sample(s).", flush=True)
    return { "prompt": prompt, "urls": urls }


def load_mrt():
    try:
        from magenta_rt import MagentaRT2Mlxfn as MRT
    except ImportError:
        from magenta_rt.mlx.system import MagentaRT2SystemMlxfn as MRT
    t0 = time.time()
    print("[prebake] loading mrt2_small (MLX/Metal)…", flush=True)
    mrt = MRT(size="mrt2_small")
    print(f"[prebake] loaded in {time.time()-t0:.1f}s", flush=True)
    return mrt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--harmony", default="warm analog synth pad, soft mellow sustained")
    ap.add_argument("--lead", default="bright expressive lead synth, singing")
    ap.add_argument("--out", default=str(REPO / "app" / "public" / "voices"))
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    mrt = load_mrt()
    t0 = time.time()
    manifest = {
        "sr": SR,
        "voices": {
            "harmony": bake_voice(mrt, "harmony", args.harmony, out),
            "lead": bake_voice(mrt, "lead", args.lead, out),
        },
        "built_s": round(time.time() - t0, 2),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"[prebake] DONE in {manifest['built_s']}s → {out}/manifest.json", flush=True)
    print(json.dumps(manifest["voices"], indent=2), flush=True)


if __name__ == "__main__":
    main()
