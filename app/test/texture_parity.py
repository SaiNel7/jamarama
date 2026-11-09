"""Reference outputs from the REAL engine/texture_engine.py, for test/texture_translate.test.js.

Runs texture_engine.main(--test) with a fake `magenta_rt` whose embed_style() returns a one-hot
vector per distinct prompt, so the style vector handed to generate() IS the per-prompt weight
blend. Records every generate() call + the TextureDSP gain. Also evaluates notes_from_pcs /
chord_notes_vec for the cases given on stdin. Prints one JSON object.

    echo '{"pcs":[[0,4,7]],"roman":[["A","IV","minor"]]}' | python3 -I test/texture_parity.py
"""
import importlib.util
import json
import os
import sys
import types

import numpy as np

ENGINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "engine", "texture_engine.py")
VOCAB = []
CALLS = []
GAINS = []


def _onehot(text):
    if text not in VOCAB:
        VOCAB.append(text)
    v = np.zeros(64)
    v[VOCAB.index(text)] = 1.0
    return v


class FakeMRT:
    def __init__(self, size):
        self.size = size

    def embed_style(self, text):
        return _onehot(text)

    def generate(self, style, notes, drums, cfg_drums, cfg_notes, cfg_musiccoca, temperature, frames, state):
        CALLS.append({
            "style": {VOCAB[i]: round(float(w), 6) for i, w in enumerate(style) if abs(w) > 1e-9},
            "notes": list(notes), "drums": drums, "cfg_drums": cfg_drums, "cfg_notes": cfg_notes,
            "cfg_musiccoca": cfg_musiccoca, "temperature": round(float(temperature), 6), "frames": frames,
        })
        return types.SimpleNamespace(samples=np.zeros((frames * 1920, 2), np.float32)), state


def main():
    cases = json.loads(sys.stdin.read() or "{}")
    fake = types.ModuleType("magenta_rt")
    fake.MagentaRT2Mlxfn = FakeMRT
    sys.modules["magenta_rt"] = fake
    spec = importlib.util.spec_from_file_location("texture_engine", ENGINE)
    te = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(te)

    class RecDSP(te.TextureDSP):
        def set_gain(self, target):
            GAINS.append(round(float(target), 6))
            super().set_gain(target)
    te.TextureDSP = RecDSP
    sys.argv = ["texture_engine.py", "--test"]
    import contextlib, io
    with contextlib.redirect_stdout(io.StringIO()):
        te.main()
    for c, g in zip(CALLS, GAINS):
        c["gain"] = g
    out = {
        "calls": CALLS,
        "anchor": VOCAB[0],
        "pcs": [te.notes_from_pcs(p, onset=o) for p, o in cases.get("pcs", [])],
        "roman": [te.chord_notes_vec(k, r, s, onset=o) for k, r, s, o in cases.get("roman", [])],
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
