# lab helper: the chrome at its real size (no enlargement), one strip per scene
#   python one.py <dir> <name>
import sys
from PIL import Image
d, v = sys.argv[1], sys.argv[2]
parts = [("p-busy", 3, (0, 0, 1170, 2532)), ("p-sky", 3, (0, 0, 1170, 2532)), ("d-busy", 2, (0, 0, 2880, 240)), ("d-sky", 2, (0, 0, 2880, 240)), ("d-home", 2, (0, 0, 2880, 1500)), ("d-title", 2, (600, 1000, 2880, 1500))]
tiles = []
for name, k, box in parts:
    try:
        im = Image.open(f"{d}/{name}.{v}.png").convert("RGB").crop(box)
    except FileNotFoundError:
        continue
    tiles.append(im.resize((im.width // k, im.height // k), Image.LANCZOS))
phones = [t for t in tiles if t.width == 390]; rest = [t for t in tiles if t.width != 390]
W = max([t.width for t in rest] + [len(phones) * 400]); H = (max(t.height for t in phones) + 8 if phones else 0) + sum(t.height + 8 for t in rest)
o = Image.new("RGB", (W, H), (30, 30, 30)); x = 0
for t in phones:
    o.paste(t, (x, 0)); x += 400
y = max(t.height for t in phones) + 8 if phones else 0
for t in rest:
    o.paste(t, (0, y)); y += t.height + 8
o.save(f"{d}/one.{v}.png")
