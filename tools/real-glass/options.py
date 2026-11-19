# The option sheets: today's glass and the three directions side by side,
# from lab.js's photographs (python options.py <shots dir> <out dir>).
import sys, os
from PIL import Image, ImageDraw, ImageFont

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
V = [("today", "Today (Clear)"), ("a-bevel", "A · Bevel"), ("b-prism", "B · Prism"), ("c-crystal", "C · Crystal")]
BG = (12, 12, 20)


def font(size, bold=True):
    for f in (["segoeuib.ttf", "arialbd.ttf"] if bold else ["segoeui.ttf", "arial.ttf"]):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def im(name):
    return Image.open(os.path.join(src, name)).convert("RGB")


def save(img, name, max_bytes=1_500_000):
    p = os.path.join(out, name)
    img.save(p, optimize=True)
    k = 1.0
    while os.path.getsize(p) > max_bytes and k > 0.4:
        k -= 0.1
        img.resize((int(img.width * k), int(img.height * k)), Image.LANCZOS).save(p, optimize=True)
    print(name, img.size, os.path.getsize(p) // 1024, "KB", "scale", round(k, 1))


def columns(title, scene, w, crop=None):
    """whole screens, one column per version"""
    tiles = []
    for v, _ in V:
        t = im(f"{scene}.{v}.png")
        if crop:
            t = t.crop(crop)
        tiles.append(t.resize((w, int(t.height * w / t.width)), Image.LANCZOS))
    pad, head = 18, 84
    W = pad + len(tiles) * (w + pad)
    H = head + tiles[0].height + pad
    s = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(s)
    d.text((pad, 12), title, font=font(24), fill=(255, 255, 255))
    for i, (t, (_, label)) in enumerate(zip(tiles, V)):
        x = pad + i * (w + pad)
        d.text((x, 50), label, font=font(19), fill=(200, 190, 255))
        s.paste(t, (x, head))
    return s


def rows(title, parts, width):
    """crops, one row per version; parts = [(scene.crop index, caption)]"""
    pad, head = 18, 54
    blocks = []
    for scene, idx, cap, zoom in parts:
        block = []
        for v, label in V:
            t = im(f"{scene}.{v}.{idx}.png")
            if isinstance(zoom, tuple):
                t = t.crop(zoom[1])
                k = zoom[0]
                t = t.resize((int(t.width * k), int(t.height * k)), Image.LANCZOS)
            if t.width > width:
                t = t.resize((width, int(t.height * width / t.width)), Image.LANCZOS)
            block.append((label, t))
        blocks.append((cap, block))
    H = head + sum(34 + sum(t.height + 30 for _, t in b) + 10 for _, b in blocks)
    s = Image.new("RGB", (width + 2 * pad, H), BG)
    d = ImageDraw.Draw(s)
    d.text((pad, 12), title, font=font(24), fill=(255, 255, 255))
    y = head
    for cap, block in blocks:
        d.text((pad, y), cap, font=font(18), fill=(255, 255, 255))
        y += 34
        for label, t in block:
            d.text((pad, y), label, font=font(15, False), fill=(200, 190, 255))
            y += 22
            s.paste(t, (pad, y))
            y += t.height + 8
        y += 10
    return s


if __name__ == "__main__":
    save(columns("Phone 390 × 844 · Home, the tab bar over posters", "p-busy", 420), "01-phone-home.png")
    save(columns("Phone · a film's page: the tab bar over the sky, the top buttons over the picture", "p-title", 420), "02-phone-title.png")
    save(rows("Phone · enlarged", [
        ("p-busy", 1, "The tab bar over posters (2×)", (2 / 3 * 2, (0, 0, 1170, 250))),
        ("p-bright", 0, "The tab bar over the brightest posters (2×)", (2 / 3 * 2, (0, 0, 1170, 250))),
        ("p-busy", 0, "The top buttons over the picture (2×)", (2 / 3 * 2, (0, 0, 1170, 210))),
        ("p-home", 2, "The glass button on the hero (2×)", (2 / 3 * 2, (0, 0, 1170, 240))),
    ], 1560), "03-phone-enlarged.png")
    save(rows("Desktop 1440 × 900 · the top bar", [
        ("d-home", 0, "Over the hero's picture", None),
        ("d-busy", 0, "Over posters", None),
        ("d-bright", 0, "Over the brightest posters", None),
    ], 1900), "04-desktop-bar.png")
    save(rows("Desktop · a film's buttons", [("d-title", 0, "", None)], 1700), "05-desktop-title.png")
    save(rows("One edge, 3× (what the rim does to the picture behind it)", [
        ("p-busy", 1, "The tab bar's left end", (3, (0, 10, 620, 250))),
        ("p-busy", 0, "The settings button", (3, (800, 0, 1170, 210))),
    ], 1860), "06-edge-3x.png")
