#!/usr/bin/env python3
"""Made-up artwork for the mobile-perf fixture: posters and backdrops that
weigh what real ones weigh (a catalogue poster is a 20-50 KB JPEG about 340
pixels wide, a backdrop a 140-280 KB JPEG at 1280x720 - measured on the live
server's answers), so image bytes, decode time and the server's ?w= resizer
behave the way they do in the house. Nothing here is a real film's picture.

  python make-art.py <out dir> [posters=240] [backdrops=48]

Deterministic: the same call draws the same files.
"""
import os, random, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

def font(size):
    for name in ("arialbd.ttf", "DejaVuSans-Bold.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()

def picture(w, h, seed, label):
    r = random.Random(seed)
    # colour fields: a tiny random image blown up (soft blobs, like a graded still)
    small = Image.new("RGB", (r.randint(3, 6), r.randint(4, 7)))
    small.putdata([(r.randint(10, 235), r.randint(10, 215), r.randint(20, 245)) for _ in range(small.width * small.height)])
    img = small.resize((w, h), Image.BICUBIC)
    d = ImageDraw.Draw(img, "RGBA")
    # shapes with hard edges (faces, horizons, lettering all compress like these)
    for _ in range(r.randint(8, 16)):
        x, y = r.randint(-w // 4, w), r.randint(-h // 4, h)
        s = r.randint(w // 10, w // 2)
        col = (r.randint(0, 255), r.randint(0, 255), r.randint(0, 255), r.randint(60, 190))
        if r.random() < 0.5:
            d.ellipse([x, y, x + s, y + int(s * r.uniform(0.5, 1.6))], fill=col)
        else:
            d.polygon([(x, y), (x + s, y + r.randint(-s // 3, s // 3)), (x + r.randint(0, s), y + s)], fill=col)
    img = img.filter(ImageFilter.GaussianBlur(r.uniform(0.6, 2.2)))
    # fine detail + grain: what makes a photograph cost bytes
    detail = Image.effect_noise((w, h), r.uniform(4, 8)).convert("RGB")
    img = ImageChops.overlay(img, detail)
    # ...and coarser texture, so a picture scaled down to a phone's poster
    # (150-300 px) still weighs what a real one does at that size
    for div, lo, hi in ((3, 16, 30), (7, 14, 26)):
        coarse = Image.effect_noise((max(2, w // div), max(2, h // div)), r.uniform(lo, hi)).convert("RGB").resize((w, h), Image.BICUBIC)
        img = ImageChops.overlay(img, coarse)
    d = ImageDraw.Draw(img, "RGBA")
    f = font(max(14, w // 9))
    d.text((w * 0.08, h * 0.78), label, font=f, fill=(255, 255, 255, 235), stroke_width=2, stroke_fill=(0, 0, 0, 200))
    return img

def main():
    out = sys.argv[1]
    posters = int(sys.argv[2]) if len(sys.argv) > 2 else 240
    backdrops = int(sys.argv[3]) if len(sys.argv) > 3 else 48
    os.makedirs(out, exist_ok=True)
    for i in range(posters):
        picture(342, 513, 1000 + i, f"P{i:03d}").save(os.path.join(out, f"poster-{i:03d}.jpg"), "JPEG", quality=82)
    for i in range(backdrops):
        picture(1280, 720, 5000 + i, f"B{i:02d}").save(os.path.join(out, f"backdrop-{i:02d}.jpg"), "JPEG", quality=80)
    for i in range(24):  # episode stills
        picture(780, 439, 9000 + i, f"E{i:02d}").save(os.path.join(out, f"still-{i:02d}.jpg"), "JPEG", quality=78)
    for i in range(24):  # portraits (X-Ray)
        picture(185, 278, 12000 + i, f"C{i:02d}").save(os.path.join(out, f"face-{i:02d}.jpg"), "JPEG", quality=80)
    open(os.path.join(out, ".ready"), "w").write("ok")

main()
