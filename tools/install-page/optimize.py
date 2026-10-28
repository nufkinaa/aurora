#!/usr/bin/env python3
"""The /install page's pictures: every screenshot in WebP and AVIF at the
widths the page asks for (public/install.html's srcset lists), written to
public/install/.

  python tools/install-page/optimize.py

Sources: tools/install-page/.cache/raw/*.png (shots.js — a private instance
with made-up titles and people) and two photos of the TV app taken on the
test TV with the UI tests' library (docs/qa/tv-5.7.0; no household names or
library in them). AVIF is encoded by ffmpeg (libaom), WebP by Pillow.
"""
import os, subprocess, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
RAW = os.path.join(HERE, ".cache", "raw")
OUT = os.path.join(REPO, "public", "install")
QA = os.path.join(REPO, "docs", "qa", "tv-5.7.0")

# name -> (source, widths, crop box in the source's pixels or None). The
# feature cards show the part of a screen that the card is about, at a size
# that can be read (the desktop shots are 2880x1800: 1440x900 at 2x).
JOBS = {
    "hero-laptop": (os.path.join(RAW, "home-desktop.png"), [480, 800, 1200, 1600], None),
    "hero-tv": (os.path.join(QA, "c18-held-right-mid.png"), [480, 960, 1440], None),
    "hero-phone": (os.path.join(RAW, "home-phone.png"), [240, 360, 540], None),
    "f-home": (os.path.join(RAW, "home-desktop-rows.png"), [480, 800, 1200, 1600], (0, 250, 2880, 1800)),
    "f-tv": (os.path.join(QA, "c16-noa-home.png"), [480, 960, 1440], None),
    "f-title": (os.path.join(RAW, "title-desktop.png"), [480, 800, 1200], (0, 260, 2240, 1660)),
    "f-player": (os.path.join(RAW, "player-desktop.png"), [480, 800, 1200], (360, 450, 2520, 1800)),
    "f-party": (os.path.join(RAW, "party-desktop.png"), [480, 800, 1200], (1100, 140, 2880, 1252)),
    "f-intro": (os.path.join(RAW, "skipintro-desktop.png"), [480, 800, 1200], (1040, 650, 2880, 1800)),
    "f-household": (os.path.join(RAW, "household-desktop.png"), [480, 800, 1200], (0, 180, 2080, 1480)),
    "f-remote": (os.path.join(RAW, "remote-phone.png"), [360, 540], None),
}

def avif(src_png, out, crf):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src_png,
                    "-c:v", "libaom-av1", "-still-picture", "1", "-crf", str(crf), "-b:v", "0",
                    "-cpu-used", "4", "-pix_fmt", "yuv420p", out], check=True)

def main():
    os.makedirs(OUT, exist_ok=True)
    only = set(sys.argv[1:])
    tmp = os.path.join(HERE, ".cache", "resized")
    os.makedirs(tmp, exist_ok=True)
    total = 0
    for name, (src, widths, box) in JOBS.items():
        if only and name not in only:
            continue
        im = Image.open(src).convert("RGB")
        if box:
            im = im.crop(box)
        for w in widths:
            h = round(im.height * w / im.width)
            small = im.resize((w, h), Image.LANCZOS)
            webp = os.path.join(OUT, f"{name}-{w}.webp")
            small.save(webp, "WEBP", quality=78, method=6)
            png = os.path.join(tmp, f"{name}-{w}.png")
            small.save(png)
            a = os.path.join(OUT, f"{name}-{w}.avif")
            avif(png, a, 34 if w >= 1000 else 30)
            total += os.path.getsize(webp) + os.path.getsize(a)
            print(f"{name}-{w}: {w}x{h}  webp {os.path.getsize(webp) // 1024} KB  avif {os.path.getsize(a) // 1024} KB")
    print(f"total {total // 1024} KB")

if __name__ == "__main__":
    main()
