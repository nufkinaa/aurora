"""The phone app's sky: the website's glass look (aurora-sky.js over the page
colour), baked once into a portrait picture — the site paints it on a living
canvas, which costs a phone ~40% of its main thread while visible; a still
picture costs nothing per frame.

Run from tv-native/:  python tools/gen_phone_sky.py

Colours are SAMPLED from the website at 412 px (tools/mobile-perf shots.js,
glass look, Home): navy at the top, the green aurora band a little above the
middle (greener on the left), the violet wash low on the right, near-black at
the very bottom where the tab bar sits.
"""
import math
import os
import random

from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'phone', 'assets')
os.makedirs(OUT, exist_ok=True)
W, H = 270, 600

# (y fraction, left colour, right colour) — read off the site's Home at x=20 / x=w-20
STOPS = [
    (0.00, (7, 12, 41), (16, 43, 60)),
    (0.20, (11, 29, 43), (17, 53, 58)),
    (0.45, (19, 65, 60), (35, 67, 81)),
    (0.60, (31, 77, 81), (57, 59, 110)),
    (0.75, (59, 72, 120), (80, 56, 143)),
    (0.88, (80, 57, 146), (40, 28, 80)),
    (0.95, (60, 44, 110), (17, 14, 35)),
    (1.00, (30, 22, 56), (6, 6, 16)),
]


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def at(y):
    for (y0, l0, r0), (y1, l1, r1) in zip(STOPS, STOPS[1:]):
        if y <= y1:
            t = (y - y0) / (y1 - y0)
            t = t * t * (3 - 2 * t)  # smoothstep: no visible kinks between bands
            return lerp(l0, l1, t), lerp(r0, r1, t)
    return STOPS[-1][1], STOPS[-1][2]


def bake(name, dim=1.0):
    random.seed(20261028)
    im = Image.new('RGB', (W, H))
    px = im.load()
    for y in range(H):
        left, right = at(y / (H - 1))
        for x in range(W):
            t = x / (W - 1)
            t = t * t * (3 - 2 * t)
            c = lerp(left, right, t)
            # a soft bloom so the band is not a flat stripe
            b = math.exp(-(((x / W) - 0.3) ** 2 / 0.08 + ((y / H) - 0.48) ** 2 / 0.02)) * 10
            c = (c[0], c[1] + b, c[2] + b * 0.6)
            n = random.random() - 0.5  # one grey level of dither: no banding when stretched
            px[x, y] = tuple(max(0, min(255, int(round(v * dim + n)))) for v in c)
    im.save(os.path.join(OUT, name), optimize=True)
    print(name, os.path.getsize(os.path.join(OUT, name)), 'bytes')


bake('sky.png')
# the profile wall / sign-in: the same sky, dimmed as the site dims it there
bake('sky-dim.png', 0.62)
