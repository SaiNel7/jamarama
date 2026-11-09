#!/usr/bin/env python3
"""WebP copies of the images the pages actually load (the PNG sources stay in the repo).

* avatars (assets/pfps): shown at most 88 CSS px → 264 px wide (3x DPR), q90   (~1.8 MB → ~0.18 MB)
* lobby sprites + bottom character lineup: same pixels, q90 with alpha         (~1.5 MB → ~0.33 MB)

Composited onto the cream background the mean difference is ~1/255 per channel.
usage: python3 -I app/scripts/optimize_images.py     (needs Pillow)
"""
import re
from pathlib import Path

from PIL import Image

ASSETS = Path(__file__).resolve().parent.parent / "public/assets"
HOST_HTML = ASSETS.parent / "host.html"


def webp(src: Path, width=None, rgb=False):
    im = Image.open(src)
    im = im.convert("RGB" if rgb else "RGBA")
    if width and im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    out = src.with_suffix(".webp")
    im.save(out, "WEBP", quality=90, method=6)
    return src.stat().st_size, out.stat().st_size


def main():
    before = after = 0
    for png in sorted((ASSETS / "pfps").glob("*.png")):
        a, b = webp(png, width=264, rgb=True); before += a; after += b
    sprites = set(re.findall(r"/assets/sprites/([\w-]+)\.(?:png|webp)", HOST_HTML.read_text()))
    for name in sorted(sprites):
        a, b = webp(ASSETS / "sprites" / f"{name}.png"); before += a; after += b
    a, b = webp(ASSETS / "bgd_overlay.png"); before += a; after += b
    print(f"{before / 1e6:.2f} MB PNG → {after / 1e6:.2f} MB WebP")


if __name__ == "__main__":
    main()
