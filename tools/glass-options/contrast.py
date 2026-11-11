# Contrast of the words on the glass, per version (tools/glass-options/
# contrast.js -> <outdir>/<version>/…). The method is tools/glass-apple/
# contrast.py's: for each word, the pixels behind it (the surface
# photographed with its words taken off) against the word's own colour;
# "worst" is the 1st percentile of the WCAG ratios behind that word.
#
#   python tools/glass-options/contrast.py <outdir> [a,b,c,d,e] [out.md]
import glob
import json
import os
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
out = sys.argv[1]
versions = (sys.argv[2] if len(sys.argv) > 2 else "a,b,c,d,e").split(",")
md = sys.argv[3] if len(sys.argv) > 3 else None
NAMES = {"a": "A today", "b": "B Aurora", "c": "C Liquid", "d": "D Frost", "e": "E Clear"}


def lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lum(rgb):
    l = lin(rgb.astype(np.float64))
    return 0.2126 * l[..., 0] + 0.7152 * l[..., 1] + 0.0722 * l[..., 2]


def ratios(bg, color):
    r, g, b, a = color
    fg = np.empty_like(bg, dtype=np.float64)
    for i, v in enumerate((r, g, b)):
        fg[..., i] = a * v + (1 - a) * bg[..., i]
    L1, L2 = lum(fg), lum(bg)
    return (np.maximum(L1, L2) + 0.05) / (np.minimum(L1, L2) + 0.05)


def group(l):
    r, g, b, a = l["color"]
    bright = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    if l.get("on"):
        return "chosen"
    if l["kind"] == "icon":
        return "icons"
    if bright >= 0.35 and bright * a < 0.8:
        return "quiet words"
    return "words"


res = {}
for v in versions:
    for jf in sorted(glob.glob(os.path.join(out, v, "*.json"))):
        j = json.load(open(jf, encoding="utf-8"))
        im = np.asarray(Image.open(jf[:-5] + ".bare.png").convert("RGB"))
        d, cx, cy = j["dpr"], j["clip"]["x"], j["clip"]["y"]
        for l in j["labels"]:
            x, y, w, h = l["rect"]
            x0, y0 = max(0, int(round((x - cx) * d))), max(0, int(round((y - cy) * d)))
            x1, y1 = min(im.shape[1], int(round((x + w - cx) * d))), min(im.shape[0], int(round((y + h - cy) * d)))
            if x1 - x0 < 2 or y1 - y0 < 2:
                continue
            worst = float(np.percentile(ratios(im[y0:y1, x0:x1], l["color"]), 1))
            key = (j["name"], group(l), j["kind"])
            e = res.setdefault(key, {})
            if worst < e.get(v, (99, ""))[0]:
                e[v] = (worst, l["text"])

KIND = {"white": "white poster", "poster": "bright poster", "mid": "mid grey", "text": "white text under", "skybright": "bright sky band", "black": "black", "sky": "the sky", "art": "white picture"}
lines = ["| surface | words | behind | " + " | ".join(NAMES[v] for v in versions) + " |", "|---|---|---|" + "---:|" * len(versions)]
fails = {v: 0 for v in versions}
low = {v: 99 for v in versions}
for (name, grp, kind), e in sorted(res.items()):
    cells = []
    for v in versions:
        if v not in e:
            cells.append("–")
            continue
        w = e[v][0]
        low[v] = min(low[v], w) if grp != "quiet words" else low[v]
        if w < 4.5 and grp != "quiet words":
            fails[v] += 1
        cells.append(("%.1f" % w) + (" ✗" if w < 4.5 else ""))
    lines.append(f"| {name} | {grp} | {KIND.get(kind, kind)} | " + " | ".join(cells) + " |")
head = "under 4.5:1 (words, chosen, icons): " + ", ".join(f"{NAMES[v]} {fails[v]}" for v in versions) + "; lowest: " + ", ".join(f"{NAMES[v]} {low[v]:.1f}" for v in versions)
print(head)
body = head + "\n\n" + "\n".join(lines) + "\n"
if md:
    open(md, "w", encoding="utf-8").write(body)
else:
    print(body)
