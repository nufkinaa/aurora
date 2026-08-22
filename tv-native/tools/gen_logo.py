"""Generate the Aurora logo mark.

Run from tv-native/:  python tools/gen_logo.py

The site's mark (public/css/components.css, `.nav-logo .logo-mark`) is:

    width/height 26px, border-radius 8px
    background: conic-gradient(from 210deg, #6c58ff, #b76cff, #4ea3ff, #6c58ff)
    box-shadow: 0 0 18px rgba(124, 100, 255, 0.55)

The TV app had been drawing a flat --accent-strong square in its place, which is
why it did not read as the logo at all: the whole identity of the mark is the
sweep from violet through magenta to blue.

RN has no conic-gradient, so it is baked here — the same approach as every other
gradient in this app. The glow is NOT baked in; it is a boxShadow on the view, so
the mark stays a tight rounded square that can sit on any background.

Baked at 8x the layout size so it stays clean if the mark is ever drawn larger
than the nav's 22dp.
"""
import math
import os

from PIL import Image, ImageDraw

ASSETS = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets')
os.makedirs(ASSETS, exist_ok=True)

N = 208            # 26dp at 8x
RADIUS = 8 * 8     # border-radius 8px at the same scale
START = 210        # `from 210deg`

# The conic stops, evenly spaced as CSS spaces them when no positions are given.
STOPS = [(0.0, (0x6C, 0x58, 0xFF)),
         (1 / 3, (0xB7, 0x6C, 0xFF)),
         (2 / 3, (0x4E, 0xA3, 0xFF)),
         (1.0, (0x6C, 0x58, 0xFF))]


def colour_at(t):
    for i in range(len(STOPS) - 1):
        a, ca = STOPS[i]
        b, cb = STOPS[i + 1]
        if a <= t <= b:
            k = (t - a) / (b - a) if b > a else 0.0
            return tuple(round(ca[c] + (cb[c] - ca[c]) * k) for c in range(3))
    return STOPS[-1][1]


img = Image.new('RGB', (N, N))
px = img.load()
c = (N - 1) / 2
for y in range(N):
    for x in range(N):
        # atan2 with y negated so 0deg points up and the sweep runs clockwise,
        # which is what a CSS conic-gradient's `from <angle>` means.
        deg = (math.degrees(math.atan2(x - c, -(y - c))) - START) % 360
        px[x, y] = colour_at(deg / 360.0)

# Round the corners by way of an alpha mask, so the mark keeps the site's
# border-radius rather than being a hard square.
mask = Image.new('L', (N, N), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, N - 1, N - 1], radius=RADIUS, fill=255)
out = Image.new('RGBA', (N, N), (0, 0, 0, 0))
out.paste(img, (0, 0), mask)

path = os.path.join(ASSETS, 'logo-mark.png')
out.save(path, optimize=True)
print(f'logo-mark.png: {os.path.getsize(path) / 1024:.1f} KB')
