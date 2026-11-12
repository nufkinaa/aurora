"""Bake the pictures of the TV's play screens (Aurora Play: Taste, Pick for me,
Pick together, Wrapped).

Run from tv-native/:  python tools/gen_play_kit.py

Why pictures: on the Mi TV a CSS gradient and a blurred shadow are redrawn on
every frame, and react-native-svg is a tree of views per shape. A baked PNG is
one texture: it costs nothing to keep and nothing to move. Everything soft or
graded in the play look is therefore one of these files, and what moves is a
plain <Image> under a transform.

  play-room.png     the room: the website's .play-room (css/play.css, section
                    2) transcribed — the night gradient, the violet dome, the
                    teal floor light, the two aurora curtains (still here) and
                    a still field of stars. Opaque, 480x270, stretched.
  play-star.png     the star (the website's 24x24 path), white, to be tinted.
  play-glow.png     a soft round light, white, to be tinted (a star's halo,
                    the gold flash behind a prize).
  play-ribbon.png   the aurora ribbon: green -> teal at 45% -> violet. The
                    meter's fill and the aurora key's face.
  play-gold.png     the gold of a win (the website's --play-goldfill): light
                    at the top left, deep at the bottom right. The gold key's
                    face.
  play-meteor.png   one meteor: a bright head on the right, a tail fading to
                    the left. White, to be tinted, turned by its angle.
  play-shade.png    the foot of a card: clear at the top, night at the bottom,
                    so a title can sit on a poster.
  play-back.png     the back of a play card (the reel turns these while it
                    waits): the tile colours, a star and its ring.
  play-face.png     the face of Wrapped's viewer-type card, under its
                    constellation: night, a violet dome high up, a low band of
                    aurora leaning across the foot, a few faint stars. (The
                    card's gold edge is a plain border, drawn by the screen.)
"""
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter

ASSETS = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets')
os.makedirs(ASSETS, exist_ok=True)

# tokens (src/play/tokens.ts == public/css/play.css)
NIGHT0 = (3, 4, 12)
NIGHT1 = (8, 10, 29)
NIGHT2 = (18, 14, 52)
NIGHT3 = (4, 20, 28)
TILE = (23, 20, 58)
TILE_HI = (34, 29, 82)
GREEN = (92, 245, 184)
TEAL = (58, 211, 230)
VIOLET = (160, 131, 255)
ROSE = (255, 134, 208)
GOLD = (255, 209, 102)

STAR = [(12, 1.8), (14.95, 8.4), (22.15, 9.15), (16.75, 14.0), (18.3, 21.1),
        (12, 17.4), (5.7, 21.1), (7.25, 14.0), (1.85, 9.15), (9.05, 8.4)]


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


def over(base, colour, alpha):
    return tuple(base[i] + (colour[i] - base[i]) * alpha for i in range(3))


def stops(t, table):
    """Piecewise-linear value through [(position, value), ...]."""
    if t <= table[0][0]:
        return table[0][1]
    for (p0, v0), (p1, v1) in zip(table, table[1:]):
        if t <= p1:
            k = (t - p0) / (p1 - p0) if p1 > p0 else 1
            if isinstance(v0, tuple):
                return tuple(lerp(v0[i], v1[i], k) for i in range(len(v0)))
            return lerp(v0, v1, k)
    return table[-1][1]


def save(img, name):
    path = os.path.join(ASSETS, name)
    img.save(path, optimize=True)
    print('%-18s %4dx%-4d %6.1f KB' % (name, img.width, img.height, os.path.getsize(path) / 1024))


# ---------------------------------------------------------------- the room
def smooth_noise(n, seed, passes=6):
    rnd = random.Random(seed)
    v = [rnd.random() for _ in range(n)]
    for _ in range(passes):
        v = [(v[max(0, i - 1)] + v[i] * 2 + v[min(n - 1, i + 1)]) / 4 for i in range(n)]
    lo, hi = min(v), max(v)
    return [(x - lo) / (hi - lo) for x in v]


RAYS = smooth_noise(480, 5)
# (hem height, wave, reach upwards, strength, hem colour, top colour, phase)
CURTAINS = [
    (0.250, 0.046, 0.150, 0.155, GREEN, TEAL, 0.6),
    (0.430, 0.032, 0.120, 0.085, VIOLET, ROSE, 2.4),
]


def room():
    W, H = 480, 270
    rnd = random.Random(11)
    px = [[None] * W for _ in range(H)]
    for y in range(H):
        v = (y + 0.5) / H
        for x in range(W):
            u = (x + 0.5) / W
            # linear-gradient(180deg, night-1 0%, night-0 55%, night-3 100%)
            c = stops(v, [(0, NIGHT1), (0.55, NIGHT0), (1, NIGHT3)])
            # radial-gradient(90% 60% at 100% 110%, rgba(16,70,82,.55) 0, transparent 60%)
            d = math.hypot((u - 1.0) / 0.9, (v - 1.1) / 0.6)
            c = over(c, (16, 70, 82), 0.55 * max(0.0, 1 - d / 0.6))
            # radial-gradient(120% 70% at 50% -10%, night-2 0, transparent 62%)
            d = math.hypot((u - 0.5) / 1.2, (v + 0.1) / 0.7)
            c = over(c, NIGHT2, max(0.0, 1 - d / 0.62))
            # the two aurora curtains. On the website they are two soft
            # ovals that drift; a TV keeps them still, and a still oval is a
            # stripe. So here each is drawn as a curtain: a waving lower hem,
            # bright at the hem, rays fading upwards, thin at the sides.
            for (base, amp, reach, peak, lo, hi, side) in CURTAINS:
                hem = base + amp * math.sin(u * 4.4 + side) + amp * 0.45 * math.sin(u * 9.7 + side * 2.3)
                if v < hem:
                    k = math.exp(-(hem - v) / reach)
                    col = mix(lo, hi, min(1.0, (hem - v) / (reach * 1.6)))
                else:
                    k = math.exp(-(v - hem) / 0.022)
                    col = lo
                ray = 0.72 + 0.28 * RAYS[int(u * (len(RAYS) - 1))]
                edge = math.sin(math.pi * min(1.0, max(0.0, (u + 0.08) / 1.16))) ** 0.8
                c = over(c, col, peak * k * ray * edge)
            px[y][x] = c
    # a still field of stars: most faint and small, a few brighter. Kept out
    # of the middle band a little less than the edges would suggest: the cards
    # cover the middle anyway.
    for _ in range(150):
        x = rnd.random() * W
        y = rnd.random() ** 1.25 * H * 0.96
        big = rnd.random() < 0.12
        a = (0.55 + rnd.random() * 0.3) if big else (0.16 + rnd.random() * 0.3)
        r = 1.15 if big else 0.72
        tint = rnd.choice([(255, 255, 255), (255, 255, 255), (214, 226, 255), (255, 240, 214)])
        for yy in range(int(y - 2), int(y + 3)):
            for xx in range(int(x - 2), int(x + 3)):
                if 0 <= xx < W and 0 <= yy < H:
                    d = math.hypot(xx + 0.5 - x, yy + 0.5 - y)
                    k = max(0.0, 1 - d / r) ** 1.5
                    if k > 0:
                        px[yy][xx] = over(px[yy][xx], tint, a * k)
    # a breath of noise (under one level) so the dark ramps do not band when
    # the picture is stretched to the panel
    img = Image.new('RGB', (W, H))
    out = img.load()
    for y in range(H):
        for x in range(W):
            n = (rnd.random() - 0.5) * 1.1
            out[x, y] = tuple(max(0, min(255, int(round(ch + n)))) for ch in px[y][x])
    save(img, 'play-room.png')


# ---------------------------------------------------------------- small parts
def white(alpha_img):
    w, h = alpha_img.size
    img = Image.new('RGBA', (w, h), (255, 255, 255, 0))
    img.putalpha(alpha_img)
    return img


def star():
    S, SS = 96, 4
    big = Image.new('L', (S * SS, S * SS), 0)
    d = ImageDraw.Draw(big)
    k = S * SS / 24.0
    pts = [(x * k, y * k) for x, y in STAR]
    d.polygon(pts, fill=255)
    # the website's star has slightly soft points (round joins): a hair of
    # rounding by drawing the outline with a round brush
    d.line(pts + [pts[0]], fill=255, width=int(0.7 * k), joint='curve')
    save(white(big.resize((S, S), Image.LANCZOS)), 'play-star.png')


def glow():
    S = 96
    a = Image.new('L', (S, S), 0)
    p = a.load()
    for y in range(S):
        for x in range(S):
            d = math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2) / (S / 2)
            p[x, y] = int(round(255 * max(0.0, 1 - d) ** 2.2))
    save(white(a), 'play-glow.png')


def ribbon():
    W, H = 256, 4
    img = Image.new('RGB', (W, H))
    p = img.load()
    for x in range(W):
        c = stops((x + 0.5) / W, [(0, GREEN), (0.45, TEAL), (1, VIOLET)])
        for y in range(H):
            p[x, y] = tuple(int(round(v)) for v in c)
    save(img, 'play-ribbon.png')


def gold():
    W, H = 128, 32
    HI, MID, DEEP = (255, 242, 194), (255, 209, 102), (240, 162, 58)
    img = Image.new('RGB', (W, H))
    p = img.load()
    for y in range(H):
        for x in range(W):
            # 135deg on the stretched key: along the diagonal of the box
            t = ((x + 0.5) / W + (y + 0.5) / H) / 2
            c = stops(t, [(0, HI), (0.38, MID), (1, DEEP)])
            p[x, y] = tuple(int(round(v)) for v in c)
    save(img, 'play-gold.png')


def meteor():
    W, H = 128, 16
    a = Image.new('L', (W, H), 0)
    p = a.load()
    hx, hy, hr = W - 8.0, H / 2.0, 3.6
    for y in range(H):
        for x in range(W):
            # the tail: a wedge that widens towards the head and fades to the left
            t = max(0.0, min(1.0, (x + 0.5) / hx))
            half = 0.5 + 2.6 * t ** 1.6
            dy = abs(y + 0.5 - hy)
            tail = max(0.0, 1 - dy / half) * t ** 2.2 * 0.85 if x + 0.5 <= hx else 0.0
            # the head: a small bright ball with a soft edge
            d = math.hypot(x + 0.5 - hx, y + 0.5 - hy)
            head = max(0.0, min(1.0, (hr + 0.8 - d) / 1.6))
            halo = max(0.0, 1 - d / 7.5) ** 2 * 0.45
            p[x, y] = int(round(255 * min(1.0, max(tail, head, halo))))
    save(white(a), 'play-meteor.png')


def shade():
    W, H = 4, 128
    img = Image.new('RGBA', (W, H))
    p = img.load()
    for y in range(H):
        t = (y + 0.5) / H
        a = stops(t, [(0, 0.0), (0.35, 0.18), (0.7, 0.72), (1, 0.94)])
        for x in range(W):
            p[x, y] = (NIGHT0[0], NIGHT0[1], NIGHT0[2] + 4, int(round(255 * a)))
    save(img, 'play-shade.png')


def back():
    W, H, SS = 200, 300, 2
    w, h = W * SS, H * SS
    img = Image.new('RGB', (w, h))
    p = img.load()
    for y in range(h):
        for x in range(w):
            t = (x / w * 0.35 + y / h * 0.65)
            c = mix(TILE_HI, TILE, t)
            # a soft light from the middle, the aurora's colours very low
            d = math.hypot((x - w / 2) / (w * 0.62), (y - h * 0.46) / (h * 0.5))
            c = over(c, mix(VIOLET, TEAL, y / h), 0.20 * max(0.0, 1 - d) ** 1.6)
            p[x, y] = tuple(int(round(v)) for v in c)
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = w / 2, h * 0.46
    # the ring and its small stars
    R = w * 0.30
    d.ellipse([cx - R, cy - R, cx + R, cy + R], outline=(232, 228, 255, 46), width=3)
    R2 = w * 0.385
    for i in range(12):
        ang = math.pi * 2 * i / 12 - math.pi / 2
        x, y = cx + math.cos(ang) * R2, cy + math.sin(ang) * R2
        r = 4.2 if i % 3 == 0 else 2.6
        d.ellipse([x - r, y - r, x + r, y + r], fill=(232, 228, 255, 110 if i % 3 == 0 else 64))
    # the star
    k = w * 0.34 / 24.0
    pts = [(cx + (x - 12) * k, cy + (y - 11.4) * k) for x, y in STAR]
    d.polygon(pts, fill=(247, 245, 255, 235))
    d.line(pts + [pts[0]], fill=(247, 245, 255, 235), width=int(0.7 * k), joint='curve')
    # an inner frame, the card's own edge
    m = 14 * SS / 2
    d.rounded_rectangle([m, m, w - m, h - m], radius=22, outline=(232, 228, 255, 34), width=3)
    img = Image.alpha_composite(img.convert('RGBA'), layer).convert('RGB')
    save(img.resize((W, H), Image.LANCZOS), 'play-back.png')


def face():
    W, H, SS = 160, 240, 2
    w, h = W * SS, H * SS
    img = Image.new('RGB', (w, h))
    p = img.load()
    for y in range(h):
        ty = y / h
        for x in range(w):
            tx = x / w
            c = stops(ty, [(0, NIGHT2), (0.55, NIGHT1), (1, NIGHT0)])
            # the dome: a violet light behind where the constellation stands
            d = math.hypot((tx - 0.5) / 0.62, (ty - 0.38) / 0.42)
            c = over(c, VIOLET, 0.40 * max(0.0, 1 - d) ** 1.5)
            # the aurora: a band low on the card, leaning up to the right
            band = (ty - (0.74 - 0.12 * tx)) / 0.085
            c = over(c, mix(GREEN, TEAL, tx), 0.34 * math.exp(-band * band))
            # a second, fainter one under it
            band = (ty - (0.86 - 0.07 * tx)) / 0.06
            c = over(c, mix(TEAL, VIOLET, tx), 0.18 * math.exp(-band * band))
            p[x, y] = tuple(int(round(v)) for v in c)
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    rnd = random.Random(11)
    for _ in range(26):
        x, y = rnd.uniform(0.07, 0.93) * w, rnd.uniform(0.05, 0.6) * h
        r = rnd.choice([1.0, 1.0, 1.4, 1.9])
        d.ellipse([x - r, y - r, x + r, y + r], fill=(232, 228, 255, rnd.randint(38, 96)))
    img = Image.alpha_composite(img.convert('RGBA'), layer).convert('RGB')
    save(img.resize((W, H), Image.LANCZOS), 'play-face.png')


if __name__ == '__main__':
    room()
    star()
    glow()
    ribbon()
    gold()
    meteor()
    shade()
    back()
    face()
