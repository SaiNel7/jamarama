#!/usr/bin/env python3
"""Losslessly re-encode the committed default instrument samples (public/voices_default) as FLAC.

The host downloads every sample the manifest references before the band starts, so this is the
biggest single item on the time-to-first-sound path (~21.7 MB of WAV). FLAC is bit-exact, decodes
natively in every current browser's decodeAudioData, and keeps "the transient at sample[0]" (no
encoder delay, unlike MP3/AAC/Opus). The WAVs stay next to them as the fallback; the manifest gets
"flac": true so voices.js knows the .flac twins exist. Freshly pre-baked voices (prebake_voices.py)
write a manifest without the flag and keep loading as WAV.

usage: python3 -I app/scripts/encode_default_voices.py [voices_dir]     (needs ffmpeg)
"""
import json
import subprocess
import sys
import wave
from pathlib import Path

VOICES = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "public/voices_default")


def referenced(manifest):
    files = []
    for v in manifest.get("voices", {}).values():
        for var in v.get("variations") or ([v["urls"]] if v.get("urls") else []):
            files += list(var.values())
    for kind in ("kick", "snare", "hat"):
        files += (manifest.get("drums") or {}).get(kind, [])
    return sorted(set(files))


def strip_metadata(data: bytes) -> bytes:
    """Keep only STREAMINFO: drop PADDING (8 KB from ffmpeg), SEEKTABLE and VORBIS_COMMENT."""
    assert data[:4] == b"fLaC"
    pos, keep = 4, []
    while True:
        hdr = data[pos]
        last, btype = hdr & 0x80, hdr & 0x7F
        length = int.from_bytes(data[pos + 1:pos + 4], "big")
        block = data[pos + 4:pos + 4 + length]
        if btype == 0:
            keep.append(block)
        pos += 4 + length
        if last:
            break
    out = bytearray(b"fLaC")
    for i, block in enumerate(keep):
        out.append((0x80 if i == len(keep) - 1 else 0) | 0)
        out += len(block).to_bytes(3, "big") + block
    return bytes(out + data[pos:])


def pcm_of(path: Path) -> bytes:
    return subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-"],
                          check=True, capture_output=True).stdout


def main():
    mpath = VOICES / "manifest.json"
    manifest = json.loads(mpath.read_text())
    total_wav = total_flac = 0
    for name in referenced(manifest):
        wav = VOICES / name
        flac = wav.with_suffix(".flac")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-map_metadata", "-1",
                        "-c:a", "flac", "-compression_level", "12", str(flac)], check=True)
        flac.write_bytes(strip_metadata(flac.read_bytes()))
        with wave.open(str(wav)) as w:
            ref = w.readframes(w.getnframes())
        if pcm_of(flac) != ref:
            raise SystemExit(f"{flac.name}: decoded PCM differs from the WAV — not lossless")
        total_wav += wav.stat().st_size
        total_flac += flac.stat().st_size
    manifest["flac"] = True
    mpath.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{len(referenced(manifest))} samples: {total_wav / 1e6:.2f} MB WAV → {total_flac / 1e6:.2f} MB FLAC "
          f"({100 * total_flac / total_wav:.0f}%), all bit-exact")


if __name__ == "__main__":
    main()
