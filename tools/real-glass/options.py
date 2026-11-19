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
    """a PNG; a photograph too heavy for one is kept whole as a JPEG instead of shrunk"""
    p = os.path.join(out, name)
    img.save(p)
    if os.path.getsize(p) > max_bytes:
        os.remove(p)
        p = p[:-4] + ".jpg"
        q = 92
        img.save(p, quality=q, subsampling=0)
        while os.path.getsize(p) > max_bytes and q > 70:
            q -= 4
            img.save(p, quality=q, subsampling=0)
    print(os.path.basename(p), img.size, os.path.getsize(p) // 1024, "KB")


def columns(title, scene, w, crop=None, V=None):
    """whole screens, one column per version"""
    V = V or globals()["V"]
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


def rows(title, parts, width, V=None):
    """crops, one row per version; parts = [(scene, crop index, caption, zoom)]"""
    V = V or globals()["V"]
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
    save(columns("Phone 390 x 844 - Home, the tab bar over posters", "p-busy", 420), "01-phone-home.png")
    save(columns("Phone - a film's page: the tab bar over the sky, the top buttons over the picture", "p-title", 420), "02-phone-title.png")
    save(rows("Phone - the tab bar, enlarged 2x", [
        ("p-busy", 1, "Over posters", (4 / 3, (0, 0, 1170, 250))),
        ("p-bright", 0, "Over the brightest posters", (4 / 3, (0, 0, 1170, 250))),
    ], 1560), "03-phone-tabbar.png")
    save(rows("Phone - the buttons, enlarged 2x", [
        ("p-busy", 0, "The top buttons over the picture", (4 / 3, (0, 0, 1170, 210))),
        ("p-home", 2, "The glass button on the hero", (4 / 3, (0, 0, 1170, 240))),
    ], 1560), "04-phone-buttons.png")
    save(rows("Desktop 1440 x 900 - the top bar", [
        ("d-home", 0, "Over the hero's picture", None),
        ("d-busy", 0, "Over posters", None),
        ("d-bright", 0, "Over the brightest posters", None),
    ], 1900), "05-desktop-bar.png")
    save(rows("Desktop - a film's buttons", [("d-title", 0, "", None)], 1700), "06-desktop-title.png")
    save(rows("One edge, 3x: what the rim does to the picture behind it", [
        ("p-busy", 1, "The tab bar's left end", (3, (0, 10, 500, 250))),
        ("p-busy", 0, "The settings button", (3, (830, 0, 1170, 210))),
    ], 1500), "07-edge-3x.png")
