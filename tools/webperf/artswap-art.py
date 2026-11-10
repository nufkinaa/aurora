#!/usr/bin/env python3
"""Artwork for tools/webperf/artswap.js: the mobile-perf fixture's made-up
pictures (tools/mobile-perf/make-art.py), drawn once LARGE and scaled down for
the small version - so "the same picture, sharper" is true of them, as it is of
the catalogue's small and large posters. Nothing here is a real film's picture.

  python artswap-art.py <out dir>

  poster-NNN.jpg    300x450, the large one scaled down   (/poster/small/)
  posterL-NNN.jpg   780x1170                             (/poster/large/)
  backdrop-NN.jpg   1920x1080
  still-NN.jpg, face-NN.jpg   as make-art.py draws them
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, "..", "mobile-perf", "make-art.py"), encoding="utf-8").read()
# (its last line runs it: take the drawing code, not the run)
ns = {}
exec(src.rsplit("main()", 1)[0], ns)
picture = ns["picture"]
Image = ns["Image"]

def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for i in range(60):
        big = picture(780, 1170, 1000 + i, f"P{i:03d}")
        big.save(os.path.join(out, f"posterL-{i:03d}.jpg"), "JPEG", quality=85)
        big.resize((300, 450), Image.LANCZOS).save(os.path.join(out, f"poster-{i:03d}.jpg"), "JPEG", quality=82)
    for i in range(16):
        picture(1920, 1080, 5000 + i, f"B{i:02d}").save(os.path.join(out, f"backdrop-{i:02d}.jpg"), "JPEG", quality=82)
    for i in range(24):
        picture(780, 439, 9000 + i, f"E{i:02d}").save(os.path.join(out, f"still-{i:02d}.jpg"), "JPEG", quality=78)
    for i in range(24):
        picture(185, 278, 12000 + i, f"C{i:02d}").save(os.path.join(out, f"face-{i:02d}.jpg"), "JPEG", quality=80)
    open(os.path.join(out, ".ready"), "w").write("ok")

main()
