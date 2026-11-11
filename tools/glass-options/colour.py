"""How much colour comes through the glass: today's against Clear, the same
frames (tools/glass-options shots). For each glass part: the two crops side
by side at 2x, and the mean colourfulness (Hasler-Suesstrunk M) and mean
HSV saturation of the glass's own pixels.

    python tools/glass-options/colour.py <shots dir> <out.png> [out.md]"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(__file__))
from sheet import BG, DIM, GAP, INK, font, label, save  # noqa: E402

PARTS = [
    ("01-phone-home", 0, "Phone · round buttons over the sky"),
    ("01-phone-home", 1, "Phone · tab bar over Continue Watching"),
    ("03-phone-title", 0, "Phone · a film's buttons over its picture"),
    ("05-desktop-home", 0, "Desktop · the top bar over the hero"),
    ("07-desktop-title", 0, "Desktop · a film's buttons over its picture"),
]


def colourfulness(a):
    a = a.astype(np.float64)
    rg = a[..., 0] - a[..., 1]
    yb = 0.5 * (a[..., 0] + a[..., 1]) - a[..., 2]
    return float(np.sqrt(rg.std() ** 2 + yb.std() ** 2) + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2))


def saturation(a):
    a = a.astype(np.float64) / 255
    mx, mn = a.max(axis=2), a.min(axis=2)
    return float(np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0).mean())


shots, out = sys.argv[1], sys.argv[2]
md = sys.argv[3] if len(sys.argv) > 3 else None
fl, ft, fs = font(30), font(40), font(24, False)
rows, lines = [], ["| glass part | colourfulness today → Clear | saturation today → Clear |", "|---|---:|---:|"]
for sid, ci, name in PARTS:
    meta = json.load(open(os.path.join(shots, f"{sid}.json"), encoding="utf-8"))
    dpr = meta.get("dpr", 2)
    crops, vals = [], []
    for v in ("a", "e"):
        im = Image.open(os.path.join(shots, f"{sid}.{v}.png")).convert("RGB")
        x, y, w, h = meta["crops"][v][ci]
        c = im.crop((x * dpr, y * dpr, (x + w) * dpr, (y + h) * dpr))
        arr = np.asarray(c)
        vals.append((colourfulness(arr), saturation(arr)))
        crops.append(c)
    rows.append((name, crops, vals))
    lines.append(f"| {name} | {vals[0][0]:.0f} → {vals[1][0]:.0f} | {vals[0][1]:.2f} → {vals[1][1]:.2f} |")
W = 1900
H = 90
laid = []
for name, crops, vals in rows:
    k = min(1.0, (W - 3 * GAP) / 2 / max(c.width for c in crops))
    cs = [c.resize((round(c.width * k), round(c.height * k)), Image.LANCZOS) for c in crops]
    laid.append((name, cs, vals))
    H += 56 + 80 + max(c.height for c in cs) + GAP * 2
sheet = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(sheet)
label(d, GAP, 18, "Colour through the glass: today (left) and Clear (right)", ft)
y = 90
for name, cs, vals in laid:
    label(d, GAP, y + 8, name, fl, DIM)
    y += 56
    x = GAP
    for v, c, (cf, sat) in zip(("Today", "Clear"), cs, vals):
        label(d, x + 4, y + 4, v, fl, INK)
        label(d, x + 4, y + 42, f"colour {cf:.0f} · saturation {sat:.2f}", fs, DIM)
        sheet.paste(c, (x, y + 80))
        x += max(c.width, 330) + GAP
    y += 80 + max(c.height for c in cs) + GAP * 2
print(save(sheet, out))
body = "\n".join(lines) + "\n"
print(body)
if md:
    open(md, "w", encoding="utf-8").write(body)
