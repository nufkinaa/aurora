#!/usr/bin/env python3
"""Made-up artwork for the /install page's screenshots: cinematic posters,
backdrops and episode stills for the invented catalogue in catalogue.js —
painted landscapes (mountains, seas, cities, forests, dunes, planets, the
aurora), each title's own poster with its own name on it. Nothing here is a
real film's picture, and nothing is fetched.

  python make-art.py <out dir> <titles.json>

titles.json: [{ "id", "name", "kind": "movie"|"series", "tagline" }].
Writes poster-<id>.jpg (500x750), backdrop-<id>.jpg (1920x1080) and
still-NN.jpg (1280x720). Deterministic: the same input draws the same files.
"""
import json, math, os, random, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

FONT_DIR = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts")

def font(names, size, variation=None):
    for name in names:
        for p in (os.path.join(FONT_DIR, name), name):
            try:
                f = ImageFont.truetype(p, size)
                if variation:
                    try: f.set_variation_by_name(variation)
                    except Exception: pass
                return f
            except OSError:
                pass
    return ImageFont.load_default()

PALETTES = [
    # sky top, horizon, sun, land near, land far
    ((10, 12, 40), (255, 138, 76), (255, 222, 170), (14, 10, 26), (120, 70, 90)),     # dusk
    ((2, 10, 26), (31, 111, 122), (232, 246, 255), (2, 8, 14), (40, 90, 100)),        # teal night
    ((18, 3, 10), (194, 38, 59), (255, 190, 160), (12, 2, 6), (110, 30, 50)),          # crimson
    ((10, 6, 32), (139, 92, 246), (245, 208, 254), (8, 5, 20), (80, 60, 150)),         # violet
    ((26, 15, 5), (242, 169, 59), (255, 241, 193), (24, 12, 4), (150, 90, 40)),        # gold
    ((11, 20, 36), (156, 201, 232), (255, 255, 255), (12, 20, 32), (90, 130, 160)),    # ice
    ((3, 20, 15), (47, 191, 138), (220, 255, 236), (2, 12, 9), (30, 110, 80)),         # emerald
    ((26, 11, 31), (240, 122, 160), (255, 220, 230), (18, 6, 20), (140, 70, 110)),     # rose
    ((6, 8, 18), (70, 90, 160), (200, 215, 255), (4, 5, 12), (50, 60, 110)),           # blue hour
]

def lerp(a, b, t):
    t = min(1.0, max(0.0, t))
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def gradient(w, h, top, bottom, curve=1.0):
    g = Image.new("RGB", (1, h))
    for y in range(h):
        g.putpixel((0, y), lerp(top, bottom, (y / max(1, h - 1)) ** curve))
    return g.resize((w, h))

def glow(img, cx, cy, r, color, strength=1.0):
    layer = Image.new("RGB", img.size, (0, 0, 0))
    d = ImageDraw.Draw(layer)
    for k in range(6, 0, -1):
        rr = r * (1 + k * 0.9)
        c = tuple(int(v * strength * (0.5 / k)) for v in color)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=c)
    layer = layer.filter(ImageFilter.GaussianBlur(r * 0.9))
    return ImageChops.add(img, layer)

def ridge(rnd, w, base, rough, steps=9):
    pts = [base + rnd.uniform(-rough, rough), base + rnd.uniform(-rough, rough)]
    amp = rough
    for _ in range(steps):
        nxt = []
        for i in range(len(pts) - 1):
            nxt.append(pts[i])
            nxt.append((pts[i] + pts[i + 1]) / 2 + rnd.uniform(-amp, amp))
        nxt.append(pts[-1])
        pts = nxt
        amp *= 0.55
    return [(w * i / (len(pts) - 1), y) for i, y in enumerate(pts)]

def stars(d, rnd, w, h, n, maxy):
    for _ in range(n):
        x, y = rnd.uniform(0, w), rnd.uniform(0, maxy) ** 1.0
        b = rnd.randint(120, 255)
        s = rnd.choice([0.6, 0.8, 1.0, 1.0, 1.4, 2.0])
        d.ellipse([x - s, y - s, x + s, y + s], fill=(b, b, min(255, b + 10)))

def scene(w, h, seed, kind=None):
    rnd = random.Random(seed)
    pal = PALETTES[rnd.randrange(len(PALETTES))]
    top, hor, sun, near, far = pal
    kind = kind or rnd.choice(["mountains", "sea", "city", "forest", "dunes", "planet", "aurora", "mountains", "sea"])
    horizon = h * rnd.uniform(0.55, 0.7)
    img = gradient(w, h, top, hor, curve=rnd.uniform(1.4, 2.4))
    d = ImageDraw.Draw(img, "RGBA")
    if kind in ("city", "aurora", "planet") or rnd.random() < 0.35:
        stars(d, rnd, w, h, int(w * h / 2200), horizon * 0.8)
    if kind == "aurora":
        curtain = Image.new("RGB", (w, h), (0, 0, 0))
        cd = ImageDraw.Draw(curtain)
        for band in range(3):
            base = h * rnd.uniform(0.12, 0.4)
            col = rnd.choice([(60, 235, 150), (140, 255, 190), (150, 120, 255), (95, 196, 216)])
            ph = rnd.uniform(0, 6.28)
            for x in range(0, w, 2):
                y0 = base + math.sin(x / w * rnd.uniform(4, 7) + ph) * h * 0.06
                ln = h * rnd.uniform(0.12, 0.3)
                a = 0.5 + 0.5 * math.sin(x / w * 13 + ph * 2)
                cd.line([(x, y0), (x, y0 + ln)], fill=tuple(int(c * (0.35 + 0.5 * a)) for c in col), width=2)
        curtain = curtain.filter(ImageFilter.GaussianBlur(w / 90))
        img = ImageChops.add(img, curtain)
        d = ImageDraw.Draw(img, "RGBA")
    # the light
    sx, sy = w * rnd.uniform(0.25, 0.75), horizon - h * rnd.uniform(0.02, 0.2)
    sr = w * rnd.uniform(0.05, 0.11)
    if kind == "planet":
        pr = w * rnd.uniform(0.55, 0.9)
        pcx, pcy = w * rnd.uniform(0.3, 0.7), h * 0.55 + pr * 0.75
        img = glow(img, pcx, pcy - pr, pr * 0.25, hor, 0.8)
        d = ImageDraw.Draw(img, "RGBA")
        d.ellipse([pcx - pr, pcy - pr, pcx + pr, pcy + pr], fill=lerp(near, hor, 0.25))
        # its lit rim
        rim = Image.new("L", (w, h), 0)
        ImageDraw.Draw(rim).ellipse([pcx - pr, pcy - pr, pcx + pr, pcy + pr], outline=255, width=max(3, int(w / 160)))
        rim = rim.filter(ImageFilter.GaussianBlur(w / 200))
        img.paste(Image.new("RGB", (w, h), sun), (0, 0), rim)
        d = ImageDraw.Draw(img, "RGBA")
        moon = (w * rnd.uniform(0.15, 0.85), h * rnd.uniform(0.12, 0.3))
        mr = w * rnd.uniform(0.03, 0.06)
        d.ellipse([moon[0] - mr, moon[1] - mr, moon[0] + mr, moon[1] + mr], fill=lerp(sun, hor, 0.3))
    else:
        img = glow(img, sx, sy, sr, sun, 0.9)
        d = ImageDraw.Draw(img, "RGBA")
        d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=sun + (235,))
    # the land
    if kind in ("mountains", "aurora", "forest", "planet") or (kind == "sea" and rnd.random() < 0.4):
        layers = rnd.randint(3, 5) if kind != "planet" else 2
        for i in range(layers):
            t = i / max(1, layers - 1)
            col = lerp(far, near, t ** 0.8)
            base = horizon + (h - horizon) * (t * 0.55) - h * 0.04
            pts = ridge(rnd, w, base, h * (0.12 - t * 0.06))
            if kind == "forest" and i >= 1:
                d.polygon(pts + [(w, h), (0, h)], fill=col)
                for x in range(-10, w + 10, max(6, int(w / (30 - i * 4)))):
                    th = h * rnd.uniform(0.05, 0.12) * (0.6 + t)
                    yb = base + rnd.uniform(-h * 0.01, h * 0.02)
                    tw = th * 0.32
                    d.polygon([(x, yb - th), (x - tw, yb), (x + tw, yb)], fill=col)
            else:
                d.polygon(pts + [(w, h), (0, h)], fill=col)
            if i < layers - 1:
                haze = Image.new("RGBA", (w, h), hor + (0,))
                hd = ImageDraw.Draw(haze)
                spread = h * 0.07
                for y in range(int(base - spread * 2.5), min(h, int(base + spread * 2.5))):
                    a = 46 * math.exp(-(((y - base) / spread) ** 2))
                    hd.line([(0, y), (w, y)], fill=hor + (int(a),))
                img.paste(haze, (0, 0), haze)
                d = ImageDraw.Draw(img, "RGBA")
    if kind == "sea":
        d.rectangle([0, horizon, w, h], fill=lerp(near, hor, 0.18))
        for y in range(int(horizon), h, 3):
            t = max(0.0, (y - horizon) / (h - horizon))
            d.line([(0, y), (w, y)], fill=lerp(hor, near, t ** 0.5) + (150,))
            span = sr * (0.6 + t * 2.2) * rnd.uniform(0.6, 1.2)
            if rnd.random() < 0.8:
                d.line([(sx - span, y), (sx + span, y)], fill=sun + (int(150 * (1 - t) + 30),), width=1)
    if kind == "city":
        x = 0
        while x < w:
            bw = rnd.uniform(w * 0.04, w * 0.11)
            bh = h * rnd.uniform(0.12, 0.42)
            y0 = h * 0.86 - bh
            d.rectangle([x, y0, x + bw, h], fill=lerp(near, far, 0.2))
            for wy in range(int(y0 + 6), int(h * 0.86), max(5, int(h / 90))):
                for wx in range(int(x + 4), int(x + bw - 3), max(5, int(w / 110))):
                    if rnd.random() < 0.28:
                        c = rnd.choice([(255, 214, 140), (255, 236, 190), (180, 220, 255)])
                        d.rectangle([wx, wy, wx + 2, wy + 2], fill=c + (rnd.randint(140, 255),))
            x += bw + rnd.uniform(0, w * 0.01)
        d.rectangle([0, h * 0.86, w, h], fill=near)
    if kind == "dunes":
        for i in range(4):
            t = i / 3
            col = lerp(lerp(hor, far, 0.5), near, t)
            base = horizon + (h - horizon) * t * 0.7
            ph, fr = rnd.uniform(0, 6.28), rnd.uniform(1.5, 3.5)
            pts = [(x, base + math.sin(x / w * fr * 3.14 + ph) * h * 0.04) for x in range(0, w + 8, 8)]
            d.polygon(pts + [(w, h), (0, h)], fill=col)
    rnd.random(); rnd.uniform(0.2, 0.8); rnd.uniform(0.8, 0.9); rnd.uniform(1, 2.2)  # (kept: the draws a figure used to take)
    # grain and a vignette: a photograph, not a vector
    noise = Image.effect_noise((w, h), 14).convert("RGB")
    img = ImageChops.blend(img, ImageChops.overlay(img, noise), 0.35)
    vig = Image.new("L", (w, h), 0)
    ImageDraw.Draw(vig).ellipse([-w * 0.25, -h * 0.25, w * 1.25, h * 1.25], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(w / 6))
    img = Image.composite(img, Image.new("RGB", (w, h), (0, 0, 0)), vig)
    return img, pal

def spaced(d, xy, text, f, fill, spacing, anchor_center_w=None):
    x, y = xy
    widths = [d.textlength(ch, font=f) for ch in text]
    total = sum(widths) + spacing * (len(text) - 1)
    if anchor_center_w is not None:
        x = (anchor_center_w - total) / 2
    for ch, cw in zip(text, widths):
        d.text((x, y), ch, font=f, fill=fill)
        x += cw + spacing
    return total

FIRST = ["Mara", "Jonah", "Priya", "Tomas", "Lena", "Odin", "Sofia", "Caleb", "Noor", "Ezra", "Ines", "Felix", "Ada", "Rafe", "Yara", "Milo"]
LAST = ["Ellison", "Vale", "Anand", "Reyes", "Fischer", "Marsh", "Lund", "Stone", "Haddad", "Finch", "Duarte", "Brandt", "Okafor", "Kerr", "Solberg", "Ivers"]

def poster(t, seed):
    w, h = 500, 750
    img, pal = scene(w, h, seed)
    d = ImageDraw.Draw(img, "RGBA")
    rnd = random.Random(seed * 7 + 3)
    # darken the bottom for the title
    shade = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    for y in range(int(h * 0.55), h):
        sd.line([(0, y), (w, y)], fill=(0, 0, 0, int(200 * max(0.0, (y - h * 0.55) / (h * 0.45)) ** 1.3)))
    img.paste(shade, (0, 0), shade)
    d = ImageDraw.Draw(img, "RGBA")
    name = t["name"].upper()
    style = rnd.choice(["bahn", "bahn", "serif"])
    words = name.split()
    lines, cur = [], ""
    for wd in words:
        if len(cur) + len(wd) + 1 > 13 and cur:
            lines.append(cur); cur = wd
        else:
            cur = (cur + " " + wd).strip()
    lines.append(cur)
    size = 70 if max(len(l) for l in lines) <= 9 else 56 if max(len(l) for l in lines) <= 12 else 46
    if style == "serif":
        f = font(["georgiab.ttf", "cambriab.ttf"], size - 4)
    else:
        f = font(["bahnschrift.ttf"], size, "Bold SemiCondensed")
    y = h * 0.86 - len(lines) * size * 1.05
    top_line = "A SERIES" if t.get("kind") == "series" else rnd.choice(["A FILM BY " + rnd.choice(FIRST).upper() + " " + rnd.choice(LAST).upper(), "FROM THE DIRECTOR OF THE LONG SIGNAL", "ONE NIGHT CHANGES EVERYTHING", "BASED ON A TRUE STORY", "SOME DOORS STAY OPEN"])
    small = font(["bahnschrift.ttf", "segoeui.ttf"], 15, "SemiBold")
    spaced(d, (0, y - 34), top_line, small, (255, 255, 255, 200), 3, anchor_center_w=w)
    for line in lines:
        spaced(d, (0, y), line, f, (250, 248, 242, 255), 4 if style == "bahn" else 2, anchor_center_w=w)
        y += size * 1.05
    tag = t.get("tagline") or ""
    if tag:
        tf = font(["bahnschrift.ttf", "segoeui.ttf"], 16, "Light")
        tw = d.textlength(tag, font=tf)
        d.text(((w - tw) / 2, y + 6), tag, font=tf, fill=(255, 255, 255, 190))
    # the billing block
    bf = font(["bahnschrift.ttf", "arial.ttf"], 9, "Light Condensed")
    billing = "  ".join(f"{rnd.choice(FIRST).upper()} {rnd.choice(LAST).upper()}" for _ in range(9))
    bw = d.textlength(billing, font=bf)
    d.text(((w - min(bw, w - 30)) / 2, h - 30), billing[: int(len(billing) * min(1, (w - 30) / max(1, bw)))], font=bf, fill=(255, 255, 255, 110))
    return img

def main():
    out, titles_file = sys.argv[1], sys.argv[2]
    titles = json.load(open(titles_file, encoding="utf-8"))
    os.makedirs(out, exist_ok=True)
    for i, t in enumerate(titles):
        seed = 5000 + i * 13
        poster(t, seed).save(os.path.join(out, f"poster-{t['id']}.jpg"), "JPEG", quality=88)
        img, _ = scene(1920, 1080, seed)  # the same world as its poster, wide
        img.save(os.path.join(out, f"backdrop-{t['id']}.jpg"), "JPEG", quality=86)
    for i in range(40):
        img, _ = scene(1280, 720, 90000 + i * 31)
        img.save(os.path.join(out, f"still-{i:02d}.jpg"), "JPEG", quality=84)
    open(os.path.join(out, ".ready"), "w").write("ok")

if __name__ == "__main__":
    main()
