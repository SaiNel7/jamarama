"""Jamarama MRT2 texture engine (MASTER_SPEC_V3 §4, §10).

Runs on the host Mac. Connects to the Node host as a passive 'texture' client,
listens for the live room state (blended taste, current chord, crowd energy),
and streams Magenta RealTime 2 audio to the default output device. The browser
plays the tight deterministic band to the SAME device, so the OS mixer is the
single sink — convergence without a sample-accurate bridge. MRT2 is OFF the grid
by design, so it just needs to share the speaker, not the clock.

Run (host audio):  ../.venv/bin/python texture_engine.py [host_ip[:port]]
Test (no audio):   ../.venv/bin/python texture_engine.py --test
"""
import sys, os, json, time, threading, queue
import numpy as np
from scipy import signal


class TextureDSP:
    """Turn MRT2's full-band output into a pure atmospheric wash so no rhythmic /
    percussive content is audible (spec §6: MRT2 = texture only, drums are ours).
    Steep low-pass kills hat/snare transients; a transient softener ducks percussive
    peaks so any residual kick/pulse flattens into sustained texture. Filter state is
    carried across chunks to avoid clicks at boundaries."""
    def __init__(self, sr=48000, cutoff=1300.0, gain=0.5):
        self.gain = gain
        self.target_gain = gain      # lead mode lifts this; process() ramps to it click-free
        self.sos = signal.butter(4, cutoff / (sr / 2), btype="low", output="sos")
        zi = signal.sosfilt_zi(self.sos)
        self.zi_l, self.zi_r = zi.copy(), zi.copy()
        self.benv, self.aenv = signal.butter(1, 8.0 / (sr / 2), btype="low")   # loudness follower
        self.bg, self.ag = signal.butter(1, 120.0 / (sr / 2), btype="low")     # gain smoother
        self.zi_env = signal.lfilter_zi(self.benv, self.aenv) * 0.05
        self.zi_g = signal.lfilter_zi(self.bg, self.ag)

    def set_gain(self, target):
        self.target_gain = float(target)

    def process(self, x):
        l, self.zi_l = signal.sosfilt(self.sos, x[:, 0], zi=self.zi_l)
        r, self.zi_r = signal.sosfilt(self.sos, x[:, 1], zi=self.zi_r)
        y = np.stack([l, r], axis=1).astype(np.float32)
        peak = np.abs(y).max(axis=1)
        avg, self.zi_env = signal.lfilter(self.benv, self.aenv, peak, zi=self.zi_env)
        g = np.minimum(1.0, (avg + 0.03) / (peak + 0.03))                       # duck transients
        g, self.zi_g = signal.lfilter(self.bg, self.ag, g, zi=self.zi_g)        # smooth to avoid distortion
        gains = np.linspace(self.gain, self.target_gain, y.shape[0], dtype=np.float32)  # ramp → no click
        self.gain = self.target_gain
        return (y * g[:, None] * gains[:, None]).astype(np.float32)

# ---------------- chord -> MRT2 notes vector ----------------
SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]
ROMAN = ["I", "ii", "iii", "IV", "V", "vi", "vii"]
# Semitones from a mode's tonic to its PARENT major tonic (mirrors shared.js MODES), so a roman
# numeral resolves to the same chord the band plays in minor/modal keys (not always major).
MODE_PARENT = {"major": 0, "ionian": 0, "minor": 3, "aeolian": 3, "dorian": 10, "phrygian": 8,
               "lydian": 7, "mixolydian": 5, "locrian": 1, "pentatonic": 0, "chromatic": 0}

def notes_from_pcs(pcs, base_oct=4, onset=False):
    """128-slot notes vector from explicit pitch classes (what the band actually plays).
    -1 masked (model free), 2 onset, 3 sustained-on."""
    v = [-1] * 128
    base = 12 * (base_oct + 1)
    for pc in pcs:
        midi = base + (int(pc) % 12)
        if 0 <= midi < 128:
            v[midi] = 2 if onset else 3
    return v

def chord_notes_vec(key, roman, scale="major", base_oct=4, onset=False):
    """Fallback when no explicit pitch classes are sent: build the diatonic triad of `roman`
    in the key's PARENT major (so minor/modal keys stay in-key)."""
    v = [-1] * 128
    try:
        root = (SHARP.index(key) + MODE_PARENT.get(scale, 0)) % 12
        d = ROMAN.index(roman)
    except ValueError:
        return v
    for t in (0, 2, 4):
        idx = d + t
        midi = 12 * (base_oct + 1) + root + MAJOR_STEPS[idx % 7] + 12 * (idx // 7)
        if 0 <= midi < 128:
            v[midi] = 2 if onset else 3
    return v

# ---------------- shared, thread-safe room params ----------------
class Params:
    def __init__(self):
        self.lock = threading.Lock()
        self.key = "A"
        self.scale = "major"
        self.degree = "I"
        self.chord_pcs = []          # explicit chord pitch-classes from the host (exact band chord)
        self.taste = ["warm ambient pads", "cinematic texture"]
        self.energy = 0.0
        self._chord_changed = True   # force an onset on first/changed chord
        self.lead_active = False     # the lead synth has started → texture wakes to it
        self.lead_pitches = []       # the lead loop's live MIDI (fed in sustained, non-rhythmic)
        self.lead_prompt = ""        # lead voice timbre → "conscious of the synth" style
        self.phase = "lobby"         # MUTED until "jam" — the host plays the lobby track during onboarding

    def update_from_state(self, st):
        with self.lock:
            self.phase = st.get("phase", self.phase)
            self.key = st.get("key") or self.key      # key can be null (blank) pre-jam → keep last valid
            self.scale = st.get("scale") or self.scale
            if st.get("chordPcs") is not None:
                self.chord_pcs = list(st.get("chordPcs"))
            self.energy = st.get("energy", self.energy)
            self.taste = st.get("taste", self.taste)
            self.lead_active = bool(st.get("leadActive", self.lead_active))
            self.lead_pitches = list(st.get("leadPitches", self.lead_pitches))
            self.lead_prompt = st.get("leadPrompt", self.lead_prompt)
            d = st.get("chord", self.degree)
            if d != self.degree:
                self.degree = d
                self._chord_changed = True

    def snapshot(self):
        with self.lock:
            onset = self._chord_changed
            self._chord_changed = False
            return (self.key, self.scale, self.degree, list(self.chord_pcs), list(self.taste),
                    self.energy, onset, self.lead_active, list(self.lead_pitches), self.lead_prompt)

    def playing(self):               # generate texture only during the jam (muted in the lobby)
        with self.lock:
            return self.phase == "jam"

# ---------------- main ----------------
def main():
    test = "--test" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    host = args[0] if args else "localhost:3000"
    if ":" not in host:
        host += ":3000"

    try:
        from magenta_rt import MagentaRT2Mlxfn as MRT
    except ImportError:
        from magenta_rt.mlx.system import MagentaRT2SystemMlxfn as MRT

    print(f"[texture] loading mrt2_small (MLX/Metal)…")
    t0 = time.time()
    mrt = MRT(size="mrt2_small")
    print(f"[texture] loaded in {time.time()-t0:.1f}s")

    params = Params()

    # A fixed textural anchor blended into EVERY style embedding so the bed stays
    # atmospheric (no percussion) even if a user's taste is a beat-heavy genre. MRT2 is
    # texture only — drums come from the deterministic engine (spec §6 invariant).
    # Positive descriptors only — MusicCoCa is a contrastive embedder, so "no drums"
    # can embed NEAR drums; "beatless / free time" describe what TO hear instead.
    # A/B-tested offline via engine/sweep_prompts.py.
    ANCHOR_PROMPT = ("ambient sustained synth pads, atmospheric drone, shimmering "
                     "reverb wash, beatless, free time, textural ambience")
    # The bed has TWO modes (it is always off-grid / beatless — spec §6):
    #   AMBIENT (jam start, before any lead note) — "barely any instruments": anchor-
    #     dominant so it's a formless atmospheric wash, the genre only faintly tinting it.
    #   LEAD-CONSCIOUS (after the first lead note) — the anchor steps back so the genre
    #     soundscape AND the lead's own timbre (lead_prompt) come through; the lead's live
    #     MIDI is fed into the notes (generate_one) and cfg_notes rises, so the bed follows
    #     and lifts the lead — without ever becoming rhythmic (all sustained, drums off).
    # A/B these via engine/sweep_blend.py (anchor) and by ear at the mode switch.
    AMBIENT_ANCHOR_WEIGHT = 0.72   # anchor-heavy → barely any instrument character
    LEAD_ANCHOR_WEIGHT    = 0.30   # let the genre + lead timbre read
    LEAD_PROMPT_WEIGHT    = 0.45   # how much the lead voice colors the style
    _emb_text = {}
    def embed(text):
        if text not in _emb_text:
            _emb_text[text] = mrt.embed_style(text)
        return _emb_text[text]
    _anchor = embed(ANCHOR_PROMPT)
    def style_for(taste, lead_active, lead_prompt, energy=0.0):
        embs = [embed(p) for p in taste] if taste else [_anchor]
        taste_emb = sum(embs) / len(embs)         # taste fusion (equal-weight blend)
        # crowd energy pulls the anchor back so the genre soundscape reads MORE when the room is hot
        # (intensity = more character, not just more motion).
        damp = 1.0 - 0.25 * max(0.0, min(1.0, energy))
        if not lead_active:
            aw = AMBIENT_ANCHOR_WEIGHT * damp
            return (1 - aw) * taste_emb + aw * _anchor
        base = taste_emb
        if lead_prompt:                           # fold the lead's timbre in → conscious of the synth
            base = (1 - LEAD_PROMPT_WEIGHT) * taste_emb + LEAD_PROMPT_WEIGHT * embed(lead_prompt)
        aw = LEAD_ANCHOR_WEIGHT * damp
        return (1 - aw) * base + aw * _anchor

    # Latency: small chunks + a shallow queue so a chord/lead/energy change is HEARD within ~1s
    # instead of up to ~6s. FRAMES=12 ≈ 0.48s of audio per generation (MRT2 frame ≈ 0.04s).
    FRAMES = 12
    FRAME_SEC = 0.04
    audio_q = queue.Queue(maxsize=2)
    stop = threading.Event()
    gen_state = {"state": None}
    ws_holder = {"ws": None}       # live WS to the host (set on connect) → stream PCM to the browser
    dsp = TextureDSP()

    # MLX is thread-bound: generation MUST run on the thread that loaded the model
    # (the main thread). WS + the audio callback run on other threads and never touch MLX.
    # Per-mode generation params. Lead mode commits harder to the (lead-tinted) style and
    # tracks notes more so the lead reads — but cfg_drums stays high and everything is
    # sustained, so the bed never turns rhythmic. Ambient mode is faint and formless.
    AMBIENT_CFG_NOTES, LEAD_CFG_NOTES = 1.5, 3.0
    AMBIENT_CFG_MC,    LEAD_CFG_MC    = 3.0, 4.0
    AMBIENT_GAIN,      LEAD_GAIN      = 0.5, 0.6
    def render_chunk():
        key, scale, degree, chord_pcs, taste, energy, onset, lead_active, lead_pitches, lead_prompt = params.snapshot()
        style = style_for(taste, lead_active, lead_prompt, energy)
        # condition on the EXACT chord pitch classes the band is playing when the host sends them
        # (covers 7ths/voicings + minor/modal keys); fall back to the roman triad otherwise.
        notes = notes_from_pcs(chord_pcs, onset=onset) if chord_pcs else chord_notes_vec(key, degree, scale, onset=onset)
        if lead_active:
            for p in lead_pitches:                      # feed the lead's live MIDI straight in,
                p = int(p)                              # SUSTAINED (3) → present, not rhythmic
                if 0 <= p < 128:
                    notes[p] = 3
        dsp.set_gain((LEAD_GAIN if lead_active else AMBIENT_GAIN) + 0.12 * max(0.0, min(1.0, energy)))  # hot room → louder bed
        wav, gen_state["state"] = mrt.generate(
            style=style, notes=notes,
            drums=[0],                     # OFF: drums come from our deterministic engine. MRT2 is
            cfg_drums=6.0,                 # texture only — never a rhythmic line (spec §6 invariant).
            cfg_notes=LEAD_CFG_NOTES if lead_active else AMBIENT_CFG_NOTES,   # lead mode tracks the melody
            cfg_musiccoca=LEAD_CFG_MC if lead_active else AMBIENT_CFG_MC,     # …and commits to the style
            temperature=1.1 + 0.5 * energy,  # crowd energy → more motion
            frames=FRAMES, state=gen_state["state"],
        )
        samples = dsp.process(np.asarray(wav.samples, dtype=np.float32))  # → atmospheric wash, no drums
        return samples, (degree, onset, energy, lead_active)

    def generate_one():                                 # used by --test and the OS-audio fallback path
        samples, info = render_chunk()
        try:
            audio_q.put(samples, timeout=2.0)
        except queue.Full:
            pass
        return info[0], info[1], info[2], samples.shape, info[3]

    # ---- WS client (room state) ----
    def start_ws():
        import websocket
        url = f"ws://{host}"
        def on_open(ws):
            ws_holder["ws"] = ws
            ws.send(json.dumps({"type": "hello", "role": "texture"}))
            print(f"[texture] connected to host {url}")
        def on_message(ws, raw):
            m = json.loads(raw)
            if m.get("type") in ("welcome", "state") and "state" in m:
                params.update_from_state(m["state"])
        def on_close(ws, *a):
            if ws_holder["ws"] is ws:
                ws_holder["ws"] = None
            if not stop.is_set():
                time.sleep(1.0); start_ws()
        threading.Thread(
            target=lambda: websocket.WebSocketApp(
                url, on_open=on_open, on_message=on_message, on_close=on_close
            ).run_forever(), daemon=True).start()

    if test:
        # drive a chord change AND the ambient→lead transition to prove conditioning (no audio device)
        t0 = time.time()
        degree, onset, energy, shp, lead = generate_one()                     # ambient mode (no lead yet)
        print(f"[texture] gen chord={degree} onset={onset} energy={energy:.2f} lead={lead} -> {shp}")
        params.update_from_state({"key": "A", "chord": "IV", "energy": 0.5})  # re-root + energy up
        degree, onset, energy, shp, lead = generate_one()
        print(f"[texture] gen chord={degree} onset={onset} energy={energy:.2f} lead={lead} -> {shp}")
        # first lead note plays → texture wakes to the lead and its live MIDI feeds in
        params.update_from_state({"leadActive": True, "leadPitches": [76, 79, 83],
                                  "leadPrompt": "muted jazz trumpet, breathy expressive"})
        degree, onset, energy, shp, lead = generate_one()                     # lead-conscious mode
        print(f"[texture] gen chord={degree} onset={onset} energy={energy:.2f} lead={lead} -> {shp}")
        assert lead is True, "lead mode did not engage after leadActive"
        rtf = (3 * FRAMES * FRAME_SEC) / (time.time() - t0)
        print(f"[texture] TEST OK — {audio_q.qsize()} chunks queued, re-root onset + lead-wake fired, ~{rtf:.2f}x RTF.")
        return

    start_ws()

    # Magenta is MUTED during onboarding/lobby — the host plays the lobby track instead. The model
    # stays loaded/warm but we generate nothing until the jam starts, so the texture comes in cleanly
    # the moment the host hits START.
    if os.environ.get("TEXTURE_OS_AUDIO"):
        # FALLBACK: play to the OS default device (mixes with the browser at the OS sink). Use this if
        # the WebAudio bridge ever misbehaves. Default path below streams PCM into the browser instead.
        import sounddevice as sd
        leftover = {"buf": np.zeros((0, 2), dtype=np.float32)}
        def callback(outdata, frames, time_info, status):
            buf = leftover["buf"]
            while buf.shape[0] < frames:
                try:
                    buf = np.concatenate([buf, audio_q.get_nowait()], axis=0)
                except queue.Empty:
                    buf = np.concatenate([buf, np.zeros((frames - buf.shape[0], 2), dtype=np.float32)], axis=0)
                    break
            outdata[:] = buf[:frames]
            leftover["buf"] = buf[frames:]
        print("[texture] streaming to default output (muted until jam start) — Ctrl-C to stop")
        with sd.OutputStream(samplerate=48000, channels=2, dtype="float32",
                             blocksize=1024, callback=callback):
            try:
                while not stop.is_set():
                    if params.playing():
                        generate_one()
                    else:
                        time.sleep(0.1)
            except KeyboardInterrupt:
                stop.set()
        return

    # DEFAULT: bridge PCM to the host browser over the WS — it joins the WebAudio bus graph there
    # (ducks under the drums, hits the master limiter, captured in the export). Generation is paced to
    # ~real-time with a small lead so we never flood the socket (RTF ~2.5x would otherwise outrun it).
    import websocket
    print("[texture] bridging PCM to the host browser over WS (muted until jam start) — Ctrl-C to stop")
    LEAD_S = 0.6                                   # seconds of audio to stay ahead of wall-clock
    produced, t0 = 0.0, None
    try:
        while not stop.is_set():
            ws = ws_holder["ws"]
            if params.playing() and ws is not None:
                if t0 is None:                     # jam (re)started → reset the pacing timeline
                    t0, produced = time.time(), 0.0
                samples, _ = render_chunk()
                pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()  # int16 LE stereo
                try:
                    ws.send(pcm, opcode=websocket.ABNF.OPCODE_BINARY)
                except Exception:
                    pass
                produced += FRAMES * FRAME_SEC
                ahead = produced - (time.time() - t0)
                if ahead > LEAD_S:
                    time.sleep(ahead - LEAD_S)     # pace to real-time + lead buffer
            else:
                t0 = None
                time.sleep(0.1)                    # lobby/idle, or waiting for the host WS
    except KeyboardInterrupt:
        stop.set()

if __name__ == "__main__":
    main()
