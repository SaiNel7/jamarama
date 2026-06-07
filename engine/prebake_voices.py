"""Pre-bake the host's instruments (harmony + lead + DRUM KIT) from the user's taste,
BEFORE the jam, by auto-chopping clean one-shots out of MRT2 (MLX/Metal).

Why this path (instead of Magenta DDSP): DDSP is timbre-transfer over 4 fixed pretrained
instruments, not prompt-conditioned, and won't pip-install on Apple Silicon. Here we drive
the already-installed MRT2 once, offline, to emit prompt-shaped audio, then slice it into
Tone-playable one-shots. Zero real-time neural cost during the jam — the deterministic brain
just plays prompt-shaped samplers/players.

Three instruments, one technique (chop a clean one-shot from MRT2, label it, load it on the host):

  HARMONY / LEAD (pitched) — drive a SINGLE sustained pitch at cfg_notes≈4 with drums off:
    * onset call (slot=2, 2 frames) → sustain call (slot=1, long) sharing `state`
      (the notes block is constant within a generate() call, so attack+sustain needs the chain);
    * mask ALL other pitches OFF (0), not masked (-1) → voiced ≈1.0 instead of drifting;
    * pitch CLASS is reliable but OCTAVE is not (the model picks a register to suit the timbre),
      so we DETECT f0 with librosa.pyin and LABEL by the detected pitch;
    * coverage: render a spread of anchors, dedup by detected pitch, then FILL the playable
      range (C2..C6) by phase-vocoder pitch-shifting the nearest clean sample, so Tone.Sampler
      never resamples more than a few semitones (this is what fixes dark-pad octave collapse).

  DRUMS (unpitched) — drive drums=[1] with notes OFF and high cfg_drums to get a pure groove,
    then auto-chop: detect onsets (backtracked to the true transient), classify each hit into
    kick / snare / hat by spectral shape, and keep the best exemplars as the kit.

  TEMPO SAFETY — every one-shot is trimmed so the transient sits exactly at sample[0]
    (tight_onset), with a ~1 ms fade-in to kill the edit click. Because there's no leading
    silence, Tone.Sampler pitch-shifting (which scales playback rate) can never delay an
    attack and smear the tempo feel.

  FLAIR — each instrument gets a few VARIATIONS (same prompt, different cuts → slightly
    different timbres): pitched voices take several windows of one long render; drums take
    several distinct hits of the same class. The host picks one at random per note/hit.

Run:
  .venv/bin/python engine/prebake_voices.py \
      --harmony "warm analog pad" --lead "bright lead synth" --drums "punchy acoustic kit" \
      [--only all|voices|drums] [--out app/public/voices]
"""
import sys, json, time, wave, argparse
from pathlib import Path
import numpy as np

SR = 48000
FPS = 25                  # MRT2 frames per second (25 frames = 1 s @ 48 kHz)

# ---- pitched-voice render params (empirically locked; see spike_out/FINDINGS.md) ----
ONSET_FRAMES = 2          # ~80 ms attack call (slot=2)
SUSTAIN_FRAMES = 70       # ~2.8 s body (slot=1) — long enough to cut several variations from
# TEXTURAL SYNTHESIS: a strong note constraint (cfg_notes=4) forced MRT2 to emit a clean,
# SYNTHETIC pitched tone and starved the realistic instrument character that lives in the style
# embedding. So we generate each voice the way the texture engine does — STYLE-DOMINANT: a light
# note constraint, heavy style commitment, warmer temperature for natural movement. Pitch stays
# detectable (A/B: voiced 0.81–0.94 at these values; we detect+relabel f0 anyway).
CFG_NOTES = 4.0           # keep pitch COVERAGE: lower (3) collapses the harvest to ~2 pitches → heavy
                          # phase-vocoder octave-fill, which itself sounds artificial. Realism comes
                          # from the levers below + the preserved attack, not from starving the pitch.
CFG_MC = 5.0              # was 3.5 — commit HARD to the instrument's real timbre (the realism knob)
CFG_DRUMS_OFF = 6.0       # suppress percussion while rendering pitched tones
TEMP = 1.25               # was 1.0 — natural micro-movement/vibrato instead of a dead static tone
TOPK = 40
# Anchors to request per voice. We spread across octaves AND pitch classes: octave is
# unreliable (the model collapses dark timbres to one register) but pitch CLASS is reliable,
# so requesting several classes harvests more distinct detected pitches in one pass. Whatever
# we get is deduped by detected pitch and then octave-filled to the grid below.
ANCHORS = [36, 43, 48, 55, 60, 67, 72, 79]   # C2 G2 C3 G3 C4 G4 C5 G5
# SOLO + REALISM framing: name ONE instrument playing alone, and push the embedding toward a REAL
# RECORDED performance (warm, expressive, rich harmonics) rather than a sterile synth tone. We avoid
# the word "acoustic" so electronic voices (analog synth, 808) still read as their own real thing.
CLEAN_SUFFIX = "solo instrument, close-mic studio recording, natural expressive performance, warm rich full harmonics, single sustained note, no other instruments, no drums, no percussion"

# ---- sampler coverage grid (what the host actually plays across) ----
GRID_LO, GRID_HI, GRID_STEP = 36, 84, 4      # C2..C6 every 4 semitones (max ~2-st resample)
# BASS is a low instrument: sample + cover a lower register so its chord-root notes (C1..C3)
# have real low samples instead of pitching a mid voice down octaves.
BASS_ANCHORS = [24, 28, 31, 36, 40, 43, 48]  # C1 E1 G1 C2 E2 G2 C3
BASS_GRID = (24, 60)                          # C1..C4

# ---- variations ----
VOICE_VARIATIONS = 3      # windows cut from one long pitched render
VOICE_VAR_LEN_S = 1.4     # length of each pitched variation window
MIN_VOICED = 0.15         # drop renders where pitch detection essentially failed (label unreliable)
MAX_FLATNESS = 0.35       # drop renders that come back as NOISE not a tone (pads read ≤0.16, noise ≫0.3)
DRUM_VARIATIONS = 3       # distinct hits kept per drum type

# ---- drum render params ----
DRUM_FRAMES = 200         # ~8 s of groove → plenty of hits to chop and choose from
CFG_DRUMS_ON = 4.0        # commit to a drum groove
CFG_NOTES_OFF = 0.0       # we don't want pitched content in the drum pass
DRUM_SUFFIX = "drum kit, steady beat, clear kick snare and hi-hat, no melody, no vocals"

REPO = Path(__file__).resolve().parent.parent


# ============================================================ low-level audio utils
def notes_vec(pitch, slot, others=0):
    v = [others] * 128
    if pitch is not None:
        v[pitch] = slot
    return v


def save_wav(path, x):
    x = np.clip(x, -1, 1)
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    ints = (x * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(ints.tobytes())


def normalize(x, target_peak=0.89):
    peak = float(np.abs(x).max())
    return (x * (target_peak / peak)).astype(np.float32) if peak > 0 else x.astype(np.float32)


def tight_onset(x, fade_ms=1.0, floor_db=-40.0, pre_ms=2.0):
    """Return x re-cut so the transient sits at sample[0] — the key to tempo-safe repitching.

    Tone.Sampler repitches by scaling playback rate, so ANY leading silence is stretched when
    a note is pitched down and the attack lands late → the groove smears. We find the onset as
    the first sample whose short-window energy crosses `floor_db` below the peak, step back a
    hair (`pre_ms`) to catch the very foot of the transient, drop everything before it, and
    apply a ~1 ms raised-cosine fade-in so cutting mid-waveform doesn't click. x: [T,2] or [T]."""
    mono = x.mean(axis=1) if x.ndim == 2 else x
    n = len(mono)
    if n == 0:
        return x
    win = max(1, int(0.001 * SR))                       # 1 ms RMS window
    # cumulative-sum RMS envelope (cheap, no scipy dependency)
    e = np.sqrt(np.convolve(mono.astype(np.float64) ** 2, np.ones(win) / win, mode="same"))
    peak = float(e.max())
    if peak <= 0:
        return x
    thresh = peak * (10.0 ** (floor_db / 20.0))
    above = np.where(e >= thresh)[0]
    start = max(0, int(above[0]) - int(pre_ms * 0.001 * SR)) if len(above) else 0
    y = x[start:]
    f = max(1, int(fade_ms * 0.001 * SR))
    if len(y) > f:
        ramp = 0.5 * (1 - np.cos(np.linspace(0, np.pi, f)))   # raised cosine 0→1
        if y.ndim == 2:
            y[:f] *= ramp[:, None]
        else:
            y[:f] *= ramp
    return y.astype(np.float32)


def short_fade_out(x, fade_ms=8.0):
    """Raised-cosine fade-out so a cut tail doesn't click. x: [T,2] or [T]."""
    f = max(1, int(fade_ms * 0.001 * SR))
    if len(x) <= f:
        return x
    ramp = 0.5 * (1 + np.cos(np.linspace(0, np.pi, f)))       # 1→0
    y = x.copy()
    if y.ndim == 2:
        y[-f:] *= ramp[:, None]
    else:
        y[-f:] *= ramp
    return y.astype(np.float32)


def pitch_shift(x, n_steps):
    """Phase-vocoder pitch shift that PRESERVES duration (so a filled note keeps its envelope/
    tempo feel). Per-channel to keep stereo. x: [T,2]."""
    import librosa
    if abs(n_steps) < 1e-6:
        return x.astype(np.float32)
    chans = [librosa.effects.pitch_shift(x[:, c].astype(np.float32), sr=SR, n_steps=n_steps)
             for c in range(x.shape[1])]
    m = min(len(c) for c in chans)
    return np.stack([c[:m] for c in chans], axis=1).astype(np.float32)


def midi_hz(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))


def clean_pitched(x, f0_hz):
    """Spectrally de-mud a pitched sample so it 'fits right' in a chord. MRT2's dark/pad renders
    carry (a) a DC/near-DC offset from the neural decoder and (b) sub-fundamental rumble below the
    note — both inaudible alone but they pile up when 3 chord notes stack, giving the muddy layer.
    We strip DC and high-pass just BELOW the fundamental (0.8·f0), which removes the junk while
    leaving the note itself untouched. Tuned per pitch so every sample is cleaned at its own f0.
    x: [T,2]."""
    from scipy import signal
    x = x - x.mean(axis=0, keepdims=True)                  # kill DC offset
    cutoff = max(22.0, 0.80 * f0_hz)                       # just under the fundamental
    sos = signal.butter(4, min(cutoff / (SR / 2), 0.99), btype="high", output="sos")
    y = np.stack([signal.sosfilt(sos, x[:, c]) for c in range(x.shape[1])], axis=1)
    return y.astype(np.float32)


def tonal_flatness(x):
    """Mean spectral flatness of the sustain region (0=pure tone, 1=white noise). Used to reject
    renders that came back as NOISE rather than a pitched tone."""
    import librosa
    mono = x.mean(axis=1).astype(np.float32)
    a, b = int(0.1 * SR), min(len(mono), int(0.9 * SR))
    seg = mono[a:b] if b > a else mono
    try:
        return float(np.mean(librosa.feature.spectral_flatness(y=seg)))
    except Exception:
        return 0.0


def sub_energy(x, f0_hz):
    """Fraction of spectral energy below 0.75·f0 (sub-fundamental mud) — FFT verification metric."""
    mono = x.mean(axis=1)
    n = len(mono)
    X = np.abs(np.fft.rfft(mono * np.hanning(n)))
    f = np.fft.rfftfreq(n, 1.0 / SR)
    tot = X.sum() + 1e-9
    return float(X[f < 0.75 * f0_hz].sum() / tot)


# ============================================================ pitched voices
def render_long_tone(mrt, emb, pitch):
    """One clean attack+sustain for `pitch`: onset call → long sustain call, sharing state."""
    wav_on, state = mrt.generate(
        style=emb, notes=notes_vec(pitch, 2, 0), drums=[0],
        cfg_notes=CFG_NOTES, cfg_musiccoca=CFG_MC, cfg_drums=CFG_DRUMS_OFF,
        temperature=TEMP, top_k=TOPK, frames=ONSET_FRAMES, state=None)
    wav_sus, _ = mrt.generate(
        style=emb, notes=notes_vec(pitch, 1, 0), drums=[0],
        cfg_notes=CFG_NOTES, cfg_musiccoca=CFG_MC, cfg_drums=CFG_DRUMS_OFF,
        temperature=TEMP, top_k=TOPK, frames=SUSTAIN_FRAMES, state=state)
    x = np.concatenate([np.asarray(wav_on.samples), np.asarray(wav_sus.samples)], axis=0)
    return x.astype(np.float32)


def detect_midi(x, requested):
    """Detected MIDI pitch of the sustain region (MRT2's chosen octave is unreliable)."""
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


def cut_variations(x, n_var=VOICE_VARIATIONS, keep_attack=False):
    """Cut `n_var` windows from one render.

    keep_attack=False (CHORDS / harmony): cuts come from the SETTLED steady-state — we skip the
    attack/onset (its transient is brighter/noisier and unlike the body) because stacked chord
    onsets read as noise (spike FINDINGS). Spread over ~120 ms → near-identical cuts.

    keep_attack=True (MELODIC voices / lead, bass): every cut STARTS AT THE TRANSIENT and keeps the
    instrument's ATTACK — a Rhodes bell, a trumpet breath, a plucked-bass thump. That onset is where
    instrument identity lives; cutting it off (the old behavior) is what made every voice collapse
    into a generic sustained tone. Monophonic voices don't stack, so the attack is pure articulation,
    not chord mud. All variations include the attack (so every played note has it).

    Each cut is tight-onset'd so it starts sounding at sample[0]. Returns [T,2] list."""
    win = int(VOICE_VAR_LEN_S * SR)
    body = tight_onset(x)                                  # transient at 0
    total = len(body)
    if total < win:
        body = np.pad(body, ((0, win - total), (0, 0)))
        total = win
    tail = int(0.20 * SR)                                  # keep clear of end drift
    if keep_attack:
        start0 = 0                                         # START on the attack → keep the articulation
        hopspan = 0                                        # every variation includes the full attack
    else:
        settle = int(0.30 * SR)                            # skip attack/settling → steady state
        start0 = min(settle, max(0, total - win))
        last_start = max(start0, total - tail - win)
        hopspan = min(max(0, last_start - start0), int(0.12 * SR))   # ≤120 ms spread → near-identical cuts
    outs = []
    for v in range(n_var):
        frac = 0.0 if n_var <= 1 or hopspan == 0 else v / (n_var - 1)
        seg = body[int(start0 + frac * hopspan):][:win]
        if not keep_attack:
            seg = tight_onset(seg)                          # re-seat steady-state cuts on their transient
        if len(seg) < win:
            seg = np.pad(seg, ((0, win - len(seg)), (0, 0)))
        outs.append(short_fade_out(normalize(seg[:win])))
    return outs


def midi_to_name(m):
    import librosa
    return librosa.midi_to_note(int(m), unicode=False).replace("#", "s")


def fill_grid(by_pitch, lo=GRID_LO, hi=GRID_HI, step=GRID_STEP):
    """Given {detected_midi: [T,2]} REAL samples, return {grid_midi: [T,2]} covering
    lo..hi every `step` by phase-vocoder shifting the nearest real sample.

    Real samples are kept verbatim at their own pitch; grid points are synthesized only to
    fill gaps, always from the closest neighbor so the shift (and any artifact) is minimal."""
    if not by_pitch:
        return {}
    real = sorted(by_pitch)
    out = dict(by_pitch)                                   # keep every real sample
    targets = list(range(lo, hi + 1, step))
    for g in targets:
        if any(abs(g - r) < step for r in by_pitch):       # already covered closely enough
            continue
        src = min(real, key=lambda r: abs(r - g))
        out[g] = normalize(pitch_shift(by_pitch[src], g - src))
    return out


def bake_voice(mrt, label, prompt, outdir, anchors=ANCHORS, grid=(GRID_LO, GRID_HI), n_var=VOICE_VARIATIONS, keep_attack=False):
    """Render a voice → `n_var` sampler maps spanning the grid. Returns
    {prompt, variations:[{noteName: filename}, ...]}. `anchors`/`grid` let a low instrument
    (e.g. BASS) be sampled + covered in a lower register; `n_var=1` makes a single clean voice
    (the chords use this — one coherent sound, no variation stacking)."""
    glo, ghi = grid
    full = f"{prompt}, {CLEAN_SUFFIX}"
    emb = mrt.embed_style(full)
    # per-variation {detected_midi: waveform}; later filled to the grid. We also track the voiced
    # fraction per detected pitch so that (a) failed detections are dropped and (b) on an
    # octave collision the cleaner (more voiced) render wins.
    var_pitch = [dict() for _ in range(n_var)]
    voiced_of = {}
    best = {"voiced": -1.0, "det": None, "vars": None}     # fallback if everything is gated out
    for p in anchors:
        x = render_long_tone(mrt, emb, p)
        det, voiced = detect_midi(x, p)
        det = max(glo - 12, min(ghi + 12, det))
        flatv = tonal_flatness(x)
        variations = cut_variations(x, n_var, keep_attack=keep_attack)
        flag = ""
        if voiced >= MIN_VOICED and flatv <= MAX_FLATNESS and voiced > best["voiced"]:
            best = {"voiced": voiced, "det": det, "vars": variations}
        if voiced < MIN_VOICED:
            flag = " (gated: unstable pitch)"
        elif flatv > MAX_FLATNESS:
            flag = f" (gated: noisy, flat={flatv:.2f})"
        elif det not in voiced_of or voiced > voiced_of[det]:
            voiced_of[det] = voiced
            for v, seg in enumerate(variations):
                var_pitch[v][det] = seg
        print(f"[prebake] {label:7s} req {midi_to_name(p):>3s} -> detected {midi_to_name(det):>3s}"
              f"  voiced={voiced:.2f} flat={flatv:.2f}{flag}", flush=True)
    if not voiced_of and best["vars"] is not None:          # nothing passed the gate → keep the best
        for v, seg in enumerate(best["vars"]):
            var_pitch[v][best["det"]] = seg
        print(f"[prebake] {label}: all renders below voiced gate — kept best ({midi_to_name(best['det'])})",
              flush=True)
    variations_out = []
    worst = 0.0
    for v in range(n_var):
        gridmap = fill_grid(var_pitch[v], glo, ghi)
        urls = {}
        for m, seg in sorted(gridmap.items()):
            f0 = midi_hz(m)
            seg = normalize(clean_pitched(seg, f0))        # de-mud (DC + sub-fundamental) per pitch
            worst = max(worst, sub_energy(seg, f0))        # FFT check: residual sub-fundamental mud
            note = midi_to_name(m)
            fname = f"{label}_v{v}_{note}.wav"
            save_wav(outdir / fname, seg)
            urls[note.replace("s", "#")] = fname           # Tone wants sharps as "C#2"
        variations_out.append(urls)
    real = len(var_pitch[0]); total = len(variations_out[0])
    print(f"[prebake] {label}: {real} real pitch(es) → {total}-note grid × {n_var} variation(s) "
          f"(FFT-cleaned, worst sub-fundamental {worst*100:.0f}%)", flush=True)
    return {"prompt": prompt, "variations": variations_out}


# ============================================================ drums (auto-chopped kit)
def render_drum_groove(mrt, emb):
    """Generate a pure drum groove: drums on, notes off, high cfg_drums (no melody)."""
    x_all, state = [], None
    remaining = DRUM_FRAMES
    while remaining > 0:                                   # chunk to bound per-call memory
        f = min(50, remaining)
        wav, state = mrt.generate(
            style=emb, notes=notes_vec(None, 0, 0), drums=[1],
            cfg_notes=CFG_NOTES_OFF, cfg_musiccoca=CFG_MC, cfg_drums=CFG_DRUMS_ON,
            temperature=TEMP, top_k=TOPK, frames=f, state=state)
        x_all.append(np.asarray(wav.samples, dtype=np.float32))
        remaining -= f
    return np.concatenate(x_all, axis=0)


def hit_features(seg):
    """Spectral fingerprint of one drum hit (mono). Returns physical descriptors used to
    cluster + label hits RELATIVE to the rest of this groove (absolute thresholds don't
    transfer across genres — a boom-bap kit is dark everywhere, a techno kit bright)."""
    import librosa
    mono = seg.mean(axis=1) if seg.ndim == 2 else seg
    if len(mono) < 256:
        mono = np.pad(mono, (0, 256 - len(mono)))
    nfft = 1024
    S = np.abs(librosa.stft(mono, n_fft=nfft, hop_length=256)) + 1e-9
    freqs = librosa.fft_frequencies(sr=SR, n_fft=nfft)
    spec = S.mean(axis=1)
    tot = spec.sum()
    spec_n = spec / tot
    centroid = float(np.sum(freqs * spec_n))
    bandwidth = float(np.sqrt(np.sum(((freqs - centroid) ** 2) * spec_n)))
    low = float(spec[freqs < 150].sum() / tot)                  # sub/kick energy fraction
    high = float(spec[freqs > 6000].sum() / tot)                # cymbal/hat energy fraction
    zcr = float(np.mean(librosa.feature.zero_crossing_rate(mono, frame_length=1024, hop_length=256)))
    flat = float(np.mean(librosa.feature.spectral_flatness(y=mono, n_fft=min(nfft, len(mono)))))
    env = np.sqrt(np.convolve(mono ** 2, np.ones(256) / 256, mode="same"))
    pk = env.max()
    peak_i = int(np.argmax(env))
    below = np.where(env < pk * 0.1)[0]
    after = below[below > peak_i]
    decay_s = float((after[0] - peak_i) / SR) if len(after) else float(len(mono) / SR)
    # sustain = how drum-shaped it is: tail RMS / head RMS. A real hit has a transient up front
    # and a quiet tail (low ratio); a sustained/tonal blob stays loud to the end (high ratio).
    am = np.abs(mono); nn = len(am)
    head = float(np.sqrt((am[:max(1, int(nn * 0.3))] ** 2).mean()))
    tail = float(np.sqrt((am[int(nn * 0.6):] ** 2).mean())) if nn > 3 else 0.0
    sustain = float(tail / (head + 1e-9))
    return {"centroid": centroid, "bandwidth": bandwidth, "low": low, "high": high, "sustain": sustain,
            "zcr": zcr, "flat": flat, "decay_s": decay_s, "attack_s": float(peak_i / SR),
            "peak": float(np.abs(mono).max())}


# target one-shot length per drum type (seconds) — kicks ring, hats are tight
DRUM_LEN_S = {"kick": 0.45, "snare": 0.28, "hat": 0.12}
# above this tail/head energy ratio a hit isn't drum-shaped → force a percussive decay
SUSTAIN_MAX = {"kick": 0.35, "snare": 0.35, "hat": 0.30}
# forced exponential-decay time constant per type (s); ~10% level at 2.3·tau, ~1% at 4.6·tau
DECAY_TAU = {"kick": 0.06, "snare": 0.045, "hat": 0.02}
# Gate: −40 dB is the empirical optimum (decay analysis) — it keeps all audible decay (≈1% level)
# yet always closes BEFORE the next hit in the groove, so one-shots are strictly separated.
GATE_DB = -40.0
GATE_HOLD_MS = 6.0            # env must stay below the gate this long to "close" (ignore brief dips)


def _env(x):
    """Smoothed amplitude envelope (mono, 64-tap RMS)."""
    mono = x.mean(axis=1) if x.ndim == 2 else x
    return np.sqrt(np.convolve(mono ** 2, np.ones(64) / 64, mode="same"))


def peak_to_front(x, pre_ms=0.3, fade_ms=0.2):
    """Guarantee the LOUDEST sample plays at the very start. The hit's true peak can sit tens of ms
    into the raw slice (measured: onset→peak 1–170 ms), so we cut to just before the peak and apply
    a sub-ms raised-cosine fade-in (so starting at near-full level doesn't click). The peak then
    lands within <0.5 ms of sample[0], and any pre-transient bleed is removed by construction. [T,2]."""
    e = _env(x)
    if e.max() <= 0:
        return x.astype(np.float32)
    start = max(0, int(np.argmax(e)) - int(pre_ms * 0.001 * SR))
    y = x[start:].astype(np.float32)
    f = max(1, int(fade_ms * 0.001 * SR))
    if len(y) > f:
        ramp = 0.5 * (1 - np.cos(np.linspace(0, np.pi, f)))
        y[:f] = y[:f] * (ramp[:, None] if y.ndim == 2 else ramp)
    return y


def shape_perc(hit, kind):
    """If a hit isn't drum-shaped (sustained/tonal bleed between transients → a held tone, not a
    hit), force a percussive exponential decay so it reads as percussion. The peak is already at the
    front (peak_to_front), so env≈1 at t=0 is preserved and only the tail is driven down; the gate
    then trims the dead tail. x: [T,2]."""
    mono = np.abs(hit.mean(axis=1)) if hit.ndim == 2 else np.abs(hit)
    n = len(mono)
    if n < 8:
        return hit.astype(np.float32)
    head = float(np.sqrt((mono[:max(1, int(n * 0.3))] ** 2).mean()))
    tail = float(np.sqrt((mono[int(n * 0.6):] ** 2).mean()))
    if tail / (head + 1e-9) > SUSTAIN_MAX.get(kind, 0.35):
        env = np.exp(-np.arange(n) / (DECAY_TAU[kind] * SR)).astype(np.float32)
        hit = (hit * env[:, None]).astype(np.float32)
    return hit.astype(np.float32)


def drum_gate(x, kind):
    """Strict separation: hold-gate the tail. From the front transient, close the one-shot at the
    first point where the smoothed envelope falls below GATE_DB of the peak and STAYS below for
    GATE_HOLD_MS (a momentary dip won't cut early). Cap to the per-type max length, fade out. This
    removes inter-hit bleed/tails so each one-shot is cleanly just its own drum. x: [T,2]."""
    e = _env(x)
    n = len(e)
    if n < 8 or e.max() <= 0:
        return x.astype(np.float32)
    peak_i = int(np.argmax(e))                            # ≈0 after peak_to_front
    thresh = e[peak_i] * (10.0 ** (GATE_DB / 20.0))
    hold = max(1, int(GATE_HOLD_MS * 0.001 * SR))
    end, below = n, 0
    for j in range(peak_i, n):
        if e[j] < thresh:
            below += 1
            if below >= hold:
                end = j - hold + 1                        # close at the start of the silent run
                break
        else:
            below = 0
    end = min(max(end, int(0.03 * SR)), int(DRUM_LEN_S[kind] * SR))   # ≥30 ms, ≤ per-type cap
    y = x[:end].astype(np.float32)
    fo = max(1, int(0.006 * SR))
    if len(y) > fo:
        ramp = 0.5 * (1 + np.cos(np.linspace(0, np.pi, fo)))
        y[-fo:] = y[-fo:] * (ramp[:, None] if y.ndim == 2 else ramp)
    return y


def classify_kit(hits):
    """Assign every hit to kick/snare/hat by clustering, then labeling clusters along the
    spectral-centroid axis (lowest = kick, highest = hat). This is genre-relative, so it works
    whether the groove is a dark boom-bap kit or a bright techno kit. Returns {kind: [hit,...]}.

    hits: list of dicts each with a 'feat' fingerprint. Falls back to centroid-percentile
    splits if clustering is unavailable or degenerate."""
    import numpy as np
    feats = [h["feat"] for h in hits]
    # feature matrix emphasizing the axes that separate drums: brightness (centroid), noisiness
    # (zcr/flatness), top-end (high), body (low), bandwidth. log-centroid so octave gaps are linear.
    X = np.array([[np.log(f["centroid"] + 1), f["zcr"], f["flat"], f["high"], f["low"],
                   f["bandwidth"]] for f in feats], dtype=np.float64)
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Xs = (X - mu) / sd
    labels = None
    try:
        from sklearn.cluster import KMeans
        if len(hits) >= 6:
            km = KMeans(n_clusters=3, n_init=10, random_state=0).fit(Xs)
            labels = km.labels_
    except Exception:
        labels = None
    if labels is None:                                          # percentile fallback on centroid
        c = np.array([f["centroid"] for f in feats])
        lo, hi = np.percentile(c, 33.3), np.percentile(c, 66.6)
        labels = np.where(c <= lo, 0, np.where(c >= hi, 2, 1))
    # order clusters by mean centroid → 0=kick(darkest) .. 2=hat(brightest)
    cents = {}
    for lab in set(labels):
        cents[lab] = np.mean([feats[i]["centroid"] for i in range(len(feats)) if labels[i] == lab])
    order = sorted(cents, key=lambda l: cents[l])
    name_of = {order[0]: "kick", order[1 if len(order) > 1 else 0]: "snare",
               order[-1]: "hat"}
    out = {"kick": [], "snare": [], "hat": []}
    for i, h in enumerate(hits):
        out[name_of[labels[i]]].append(h)
    return out


def chop_drums(x, outdir, label="drums"):
    """Detect onsets, cluster-classify hits into kick/snare/hat, keep the best
    DRUM_VARIATIONS exemplars per type (loudest + most representative of its cluster)."""
    import librosa
    mono = x.mean(axis=1).astype(np.float32)
    onsets = librosa.onset.onset_detect(
        y=mono, sr=SR, backtrack=True, units="samples",
        hop_length=256, wait=4, pre_avg=5, post_avg=5, pre_max=5, post_max=5, delta=0.07)
    # drop double-triggers within 40 ms (keep the first; backtrack already lands on the foot)
    keep = []
    for s in onsets:
        if not keep or (s - keep[-1]) > int(0.04 * SR):
            keep.append(int(s))
    onsets = keep
    hits = []
    for i, s in enumerate(onsets):
        nxt = onsets[i + 1] if i + 1 < len(onsets) else len(mono)
        seg = x[s:min(nxt, s + int(0.5 * SR))]
        if len(seg) < int(0.02 * SR):
            continue
        f = hit_features(seg)
        if f["peak"] < 0.03:                                   # skip near-silent detections
            continue
        hits.append({"seg": seg, "feat": f, "gap": (nxt - s) / SR})   # gap = decay room before next hit
    print(f"[prebake] drums: {len(onsets)} onsets → {len(hits)} usable hits "
          f"in {len(mono)/SR:.1f}s groove", flush=True)
    by_kind = classify_kit(hits) if hits else {"kick": [], "snare": [], "hat": []}

    kit = {}
    for kind in ("kick", "snare", "hat"):
        cand = by_kind.get(kind, [])
        if cand:
            cents = np.array([h["feat"]["centroid"] for h in cand])
            med = float(np.median(cents))
            # representative = loud, near the cluster's median brightness (avoid oddballs),
            # DRUM-SHAPED (low sustain), and with DECAY ROOM (a big gap to the next hit → the
            # one-shot captures the full natural decay instead of being cut short by the next hit).
            cand = sorted(cand, key=lambda h: h["feat"]["peak"]
                          - 0.0008 * abs(h["feat"]["centroid"] - med)
                          - 0.8 * h["feat"]["sustain"]
                          + 0.6 * min(h["gap"], 0.4), reverse=True)
        files = []
        for h in cand:
            if len(files) >= DRUM_VARIATIONS:
                break
            hit = peak_to_front(h["seg"])      # loudest sample at the very start
            hit = shape_perc(hit, kind)        # force a perc envelope if it's a sustained blob
            hit = drum_gate(hit, kind)         # gate the tail → strict separation + length cap
            if len(hit) < int(0.02 * SR):
                continue
            hit = normalize(hit)
            fname = f"{label}_{kind}_{len(files)}.wav"
            save_wav(outdir / fname, hit)
            files.append(fname)
        kit[kind] = files
        print(f"[prebake] drums: {kind:5s} {len(cand):>3d} candidates -> {len(files)} exemplar(s)", flush=True)
    return kit


def bake_drums(mrt, prompt, outdir, debug=False):
    full = f"{prompt}, {DRUM_SUFFIX}"
    emb = mrt.embed_style(full)
    groove = render_drum_groove(mrt, emb)
    if debug:
        save_wav(outdir / "drums_groove_debug.wav", normalize(groove))   # full groove for inspection
    kit = chop_drums(groove, outdir)
    return {"prompt": prompt, **kit}


# ============================================================ driver
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
    ap.add_argument("--harmony", default="clean smooth analog synth pad, clear warm mellow sustained chord, soft and pure")
    ap.add_argument("--lead", default="bright expressive lead synth, singing")
    ap.add_argument("--bass", default="deep round electric bass, warm sub low end")
    ap.add_argument("--drums", default="punchy acoustic drum kit, tight and clean")
    ap.add_argument("--only", default="all", choices=["all", "voices", "harmony", "bass", "drums"])
    ap.add_argument("--debug", action="store_true", help="also save the full drum groove wav")
    ap.add_argument("--out", default=str(REPO / "app" / "public" / "voices"))
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    mrt = load_mrt()
    t0 = time.time()

    # merge into any existing manifest so --only voices/drums doesn't wipe the other instrument
    manifest = {"sr": SR, "voices": {}, "drums": {}}
    mpath = out / "manifest.json"
    if mpath.exists():
        try:
            old = json.loads(mpath.read_text())
            manifest["voices"] = old.get("voices", {})
            manifest["drums"] = old.get("drums", {})
        except Exception:
            pass

    if args.only in ("all", "voices"):
        manifest["voices"] = {
            "harmony": bake_voice(mrt, "harmony", args.harmony, out, n_var=1),   # ONE clean chord voice (no attack → no chord mud)
            "lead": bake_voice(mrt, "lead", args.lead, out, keep_attack=True),    # keep the attack → recognizable lead
            "bass": bake_voice(mrt, "bass", args.bass, out, anchors=BASS_ANCHORS, grid=BASS_GRID, keep_attack=True),
        }
    elif args.only == "harmony":   # add/refresh just the chord voice (one clean variation)
        manifest["voices"]["harmony"] = bake_voice(mrt, "harmony", args.harmony, out, n_var=1)
    elif args.only == "bass":      # add/refresh just the bass, keeping existing harmony+lead
        manifest["voices"]["bass"] = bake_voice(mrt, "bass", args.bass, out,
                                                anchors=BASS_ANCHORS, grid=BASS_GRID, keep_attack=True)
    if args.only in ("all", "drums"):
        manifest["drums"] = bake_drums(mrt, args.drums, out, debug=args.debug)

    manifest["built_s"] = round(time.time() - t0, 2)
    mpath.write_text(json.dumps(manifest, indent=2))
    print(f"[prebake] DONE in {manifest['built_s']}s → {mpath}", flush=True)


if __name__ == "__main__":
    main()
