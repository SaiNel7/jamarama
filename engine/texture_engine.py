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
import sys, json, time, threading, queue
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
        self.sos = signal.butter(4, cutoff / (sr / 2), btype="low", output="sos")
        zi = signal.sosfilt_zi(self.sos)
        self.zi_l, self.zi_r = zi.copy(), zi.copy()
        self.benv, self.aenv = signal.butter(1, 8.0 / (sr / 2), btype="low")   # loudness follower
        self.bg, self.ag = signal.butter(1, 120.0 / (sr / 2), btype="low")     # gain smoother
        self.zi_env = signal.lfilter_zi(self.benv, self.aenv) * 0.05
        self.zi_g = signal.lfilter_zi(self.bg, self.ag)

    def process(self, x):
        l, self.zi_l = signal.sosfilt(self.sos, x[:, 0], zi=self.zi_l)
        r, self.zi_r = signal.sosfilt(self.sos, x[:, 1], zi=self.zi_r)
        y = np.stack([l, r], axis=1).astype(np.float32)
        peak = np.abs(y).max(axis=1)
        avg, self.zi_env = signal.lfilter(self.benv, self.aenv, peak, zi=self.zi_env)
        g = np.minimum(1.0, (avg + 0.03) / (peak + 0.03))                       # duck transients
        g, self.zi_g = signal.lfilter(self.bg, self.ag, g, zi=self.zi_g)        # smooth to avoid distortion
        return (y * g[:, None] * self.gain).astype(np.float32)

# ---------------- chord -> MRT2 notes vector ----------------
SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]
ROMAN = ["I", "ii", "iii", "IV", "V", "vi", "vii"]

def chord_notes_vec(key, roman, base_oct=4, onset=False):
    """128-slot notes vector: -1 masked (model free), 2 onset, 3 sustained-on."""
    v = [-1] * 128
    try:
        root = SHARP.index(key)
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
        self.degree = "I"
        self.taste = ["warm ambient pads", "cinematic texture"]
        self.energy = 0.0
        self._chord_changed = True   # force an onset on first/changed chord

    def update_from_state(self, st):
        with self.lock:
            self.key = st.get("key", self.key)
            self.energy = st.get("energy", self.energy)
            self.taste = st.get("taste", self.taste)
            d = st.get("chord", self.degree)
            if d != self.degree:
                self.degree = d
                self._chord_changed = True

    def snapshot(self):
        with self.lock:
            onset = self._chord_changed
            self._chord_changed = False
            return self.key, self.degree, list(self.taste), self.energy, onset

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
    ANCHOR_PROMPT = "ambient sustained synth pads, atmospheric drone, shimmering reverb wash"
    ANCHOR_WEIGHT = 0.4
    _emb_cache = {}
    _anchor = mrt.embed_style(ANCHOR_PROMPT)
    def style_for(taste):
        key = tuple(taste)
        if key not in _emb_cache:
            embs = [mrt.embed_style(p) for p in taste] or [_anchor]
            taste_emb = sum(embs) / len(embs)         # taste fusion (equal-weight blend)
            _emb_cache[key] = (1 - ANCHOR_WEIGHT) * taste_emb + ANCHOR_WEIGHT * _anchor
        return _emb_cache[key]

    audio_q = queue.Queue(maxsize=6)
    stop = threading.Event()
    gen_state = {"state": None}
    dsp = TextureDSP()

    # MLX is thread-bound: generation MUST run on the thread that loaded the model
    # (the main thread). WS + the audio callback run on other threads and never touch MLX.
    def generate_one():
        key, degree, taste, energy, onset = params.snapshot()
        style = style_for(taste)
        notes = chord_notes_vec(key, degree, onset=onset)
        wav, gen_state["state"] = mrt.generate(
            style=style, notes=notes,
            drums=[0],                     # OFF: drums come from our deterministic engine. MRT2 is
            cfg_drums=6.0,                 # texture only — never a rhythmic line (spec §6 invariant).
            cfg_notes=2.0,                 # LOW: texture tracks harmony, never states it (spec invariant)
            cfg_musiccoca=3.0,
            temperature=1.1 + 0.5 * energy,  # crowd energy → more motion
            frames=25, state=gen_state["state"],
        )
        samples = dsp.process(np.asarray(wav.samples, dtype=np.float32))  # → atmospheric wash, no drums
        try:
            audio_q.put(samples, timeout=2.0)
        except queue.Full:
            pass
        return degree, onset, energy, samples.shape

    # ---- WS client (room state) ----
    def start_ws():
        import websocket
        url = f"ws://{host}"
        def on_open(ws):
            ws.send(json.dumps({"type": "hello", "role": "texture"}))
            print(f"[texture] connected to host {url}")
        def on_message(ws, raw):
            m = json.loads(raw)
            if m.get("type") in ("welcome", "state") and "state" in m:
                params.update_from_state(m["state"])
        def on_close(ws, *a):
            if not stop.is_set():
                time.sleep(1.0); start_ws()
        threading.Thread(
            target=lambda: websocket.WebSocketApp(
                url, on_open=on_open, on_message=on_message, on_close=on_close
            ).run_forever(), daemon=True).start()

    if test:
        # drive a chord change mid-stream to prove conditioning + onset handling (no audio device)
        t0 = time.time()
        degree, onset, energy, shp = generate_one()
        print(f"[texture] gen chord={degree} onset={onset} energy={energy:.2f} -> {shp}")
        params.update_from_state({"key": "A", "chord": "IV", "energy": 0.5})  # re-root + energy up
        for _ in range(2):
            degree, onset, energy, shp = generate_one()
            print(f"[texture] gen chord={degree} onset={onset} energy={energy:.2f} -> {shp}")
        rtf = 3.0 / (time.time() - t0)
        print(f"[texture] TEST OK — {audio_q.qsize()} chunks queued, re-root onset fired, ~{rtf:.2f}x RTF.")
        return

    start_ws()

    # ---- audio out (default device = same speaker as the browser) ----
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

    # prime a couple chunks before opening the stream so the start is gapless
    print("[texture] priming…")
    generate_one(); generate_one()
    print("[texture] streaming to default output — Ctrl-C to stop")
    with sd.OutputStream(samplerate=48000, channels=2, dtype="float32",
                         blocksize=1024, callback=callback):
        try:
            while not stop.is_set():
                generate_one()   # keep the queue full on the main (MLX) thread
        except KeyboardInterrupt:
            stop.set()

if __name__ == "__main__":
    main()
