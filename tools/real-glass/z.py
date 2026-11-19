# lab helper: one enlarged strip of the phone tab bar, the top buttons and the
# desktop bar from lab.js's crops, to look at closely
#   python z.py <dir> <name>
import sys
from PIL import Image
d, v = sys.argv[1], sys.argv[2]
a = Image.open(f"{d}/p-busy.{v}.1.png"); b = Image.open(f"{d}/p-busy.{v}.0.png"); c = Image.open(f"{d}/d-busy.{v}.0.png")
rows = [[a.crop((0, 0, 950, a.height))], [b.crop((0, 0, 500, b.height)), b.crop((b.width - 450, 0, b.width, b.height))],
        [c.crop((0, 0, 620, c.height)), c.crop((1240, 0, 1990, c.height))]]
ks = [2, 2, 1.5]
W = 1900
H = int(sum(max(t.height for t in r) * k for r, k in zip(rows, ks))) + 10
out = Image.new("RGB", (W, H), "black"); y = 0
for r, k in zip(rows, ks):
    x = 0
    for t in r:
        t = t.resize((int(t.width * k), int(t.height * k)), Image.LANCZOS)
        out.paste(t, (x, y)); x += t.width + 10
    y += int(max(t.height for t in r) * k)
out.save(f"{d}/z.{v}.png")
