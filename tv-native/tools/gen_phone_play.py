"""Bake the phone's play room: src/phone/assets/play-room.png.

Run from tv-native/:  python tools/gen_phone_play.py

The phone's four play screens (Wrapped, Pick for me, Taste, Pick together)
stand in the website's .play-room (public/css/play.css, section 2): the night
gradient, the violet dome at the top, the teal floor light at the bottom
right, two aurora curtains and a still field of stars. The TV's kit bakes the
same room landscape (tools/gen_play_kit.py, 480x270); a phone is held upright,
and that picture stretched to a portrait window turns every star into a
dash. So this is the same recipe drawn tall (300x650, one opaque texture,
stretched a little to the window), with the curtains where the website's sit
on a phone: a green one high up, a violet one under it.
"""
import math
import os
import random

from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'phone', 'assets', 'play-room.png')

NIGHT0 = (3, 4, 12)
NIGHT1 = (8, 10, 29)
NIGHT2 = (18, 14, 52)
NIGHT3 = (4, 20, 28)
GREEN = (92, 245, 184)
TEAL = (58, 211, 230)
VIOLET = (160, 131, 255)
ROSE = (255, 134, 208)


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


def over(base, colour, alpha):
    return tuple(base[i] + (colour[i] - base[i]) * alpha for i in range(3))


def stops(t, table):
    if t <= table[0][0]:
        return table[0][1]
    for (p0, v0), (p1, v1) in zip(table, table[1:]):
        if t <= p1:
            k = (t - p0) / (p1 - p0) if p1 > p0 else 1
            return tuple(lerp(v0[i], v1[i], k) for i in range(3))
    return table[-1][1]


def smooth_noise(n, seed, passes=6):
    rnd = random.Random(seed)
    v = [rnd.random() for _ in range(n)]
    for _ in range(passes):
        v = [(v[max(0, i - 1)] + v[i] * 2 + v[min(n - 1, i + 1)]) / 4 for i in range(n)]
    lo, hi = min(v), max(v)
    return [(x - lo) / (hi - lo) for x in v]


RAYS = smooth_noise(300, 5)
# (hem height, wave, reach upwards, strength, hem colour, top colour, phase) — heights are of the tall picture
CURTAINS = [
    (0.155, 0.022, 0.085, 0.17, GREEN, TEAL, 0.6),
    (0.300, 0.016, 0.070, 0.09, VIOLET, ROSE, 2.4),
]


def room(W=300, H=650):
    rnd = random.Random(11)
    px = [[None] * W for _ in range(H)]
    for y in range(H):
        v = (y + 0.5) / H
        for x in range(W):
            u = (x + 0.5) / W
            c = stops(v, [(0, NIGHT1), (0.55, NIGHT0), (1, NIGHT3)])
            # radial-gradient(90% 60% at 100% 110%, rgba(16,70,82,.55) 0, transparent 60%) (a phone: the box is tall)
            d = math.hypot((u - 1.0) / 0.9, (v - 1.1) / 0.6 * (H / W) * 0.46)
            c = over(c, (16, 70, 82), 0.55 * max(0.0, 1 - d / 0.6))
            # radial-gradient(120% 70% at 50% -10%, night-2 0, transparent 62%)
            d = math.hypot((u - 0.5) / 1.2, (v + 0.1) / 0.7 * (H / W) * 0.46)
            c = over(c, NIGHT2, max(0.0, 1 - d / 0.62))
            for (base, amp, reach, peak, lo, hi, side) in CURTAINS:
                hem = base + amp * math.sin(u * 4.4 + side) + amp * 0.45 * math.sin(u * 9.7 + side * 2.3)
                if v < hem:
                    k = math.exp(-(hem - v) / reach)
                    col = mix(lo, hi, min(1.0, (hem - v) / (reach * 1.6)))
                else:
                    k = math.exp(-(v - hem) / 0.012)
                    col = lo
                ray = 0.72 + 0.28 * RAYS[int(u * (len(RAYS) - 1))]
                edge = math.sin(math.pi * min(1.0, max(0.0, (u + 0.08) / 1.16))) ** 0.8
                c = over(c, col, peak * k * ray * edge)
            px[y][x] = c
    for _ in range(300):
        x = rnd.random() * W
        y = rnd.random() * H
        big = rnd.random() < 0.14
        a = (0.75 + rnd.random() * 0.25) if big else (0.28 + rnd.random() * 0.34)
        r = 1.35 if big else 0.85
        tint = rnd.choice([(255, 255, 255), (255, 255, 255), (214, 226, 255), (255, 240, 214)])
        for yy in range(int(y - 2), int(y + 3)):
            for xx in range(int(x - 2), int(x + 3)):
                if 0 <= xx < W and 0 <= yy < H:
                    d = math.hypot(xx + 0.5 - x, yy + 0.5 - y)
                    k = max(0.0, 1 - d / r) ** 1.5
                    if k > 0:
                        px[yy][xx] = over(px[yy][xx], tint, a * k)
    img = Image.new('RGB', (W, H))
    out = img.load()
    for y in range(H):
        for x in range(W):
            n = (rnd.random() - 0.5) * 1.1
            out[x, y] = tuple(max(0, min(255, int(round(ch + n)))) for ch in px[y][x])
    img.save(OUT, optimize=True)
    print('play-room.png %dx%d %.1f KB' % (W, H, os.path.getsize(OUT) / 1024))


if __name__ == '__main__':
    room()
