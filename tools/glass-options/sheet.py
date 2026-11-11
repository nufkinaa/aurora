"""Comparison sheets for the glass versions (tools/glass-options/shoot.js,
live.js): one PNG per scene, the versions side by side and labelled, the
glass parts enlarged under them; and an overview of the most telling scenes.

    python tools/glass-options/sheet.py <shots dir> <out dir> [a,b,c,d,e]

Every PNG is kept under 1.5 MB (an adaptive palette with dithering if the
full-colour file is larger, then a smaller scale if it still is)."""
import io
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

NAMES = {"a": "Today (1.15.28)", "b": "B · Aurora", "c": "C · Liquid", "d": "D · Frost", "e": "Clear (new)"}
BG = (14, 15, 22)
INK = (240, 241, 246)
DIM = (160, 166, 184)
GAP = 14
LIMIT = 1_500_000


def font(size, bold=True):
    for f in (["segoeuib.ttf", "arialbd.ttf"] if bold else ["segoeui.ttf", "arial.ttf"]):
        p = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", f)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def save(im, path):
    """PNG under LIMIT: full colour, else a dithered palette, else smaller."""
    scale = 1.0
    while True:
        cur = im if scale == 1.0 else im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
        for mode in ("rgb", "pal"):
            b = io.BytesIO()
            out = cur if mode == "rgb" else cur.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
            out.save(b, "PNG", optimize=True)
            if b.tell() <= LIMIT:
                with open(path, "wb") as f:
                    f.write(b.getvalue())
                return cur.size, b.tell(), mode
        scale *= 0.85


def label(draw, x, y, text, f, fill=INK):
    draw.text((x, y), text, font=f, fill=fill)


def scene_sheet(shots, sid, versions, out):
    meta = json.load(open(os.path.join(shots, f"{sid}.json"), encoding="utf-8"))
    imgs = {v: Image.open(os.path.join(shots, f"{sid}.{v}.png")).convert("RGB") for v in versions if os.path.exists(os.path.join(shots, f"{sid}.{v}.png"))}
    vs = [v for v in versions if v in imgs]
    phone = meta["width"] < 700
    dpr = meta.get("dpr", 2)
    ft, fl, fs = font(40), font(30), font(22, False)
    # the whole screens: phones in one row at 1x, desktops two to a row at 2/3
    if phone:
        tw = meta["width"]
        th = meta["height"]
        cols = len(vs)
    else:
        tw = round(meta["width"] * 0.66)
        th = round(meta["height"] * 0.66)
        cols = 2
    rows = (len(vs) + cols - 1) // cols
    lab = 46
    W = GAP + cols * (tw + GAP)
    head = 92
    tiles_h = rows * (lab + th + GAP)
    # the enlarged glass: every crop region of each version at 2x CSS, side
    # by side in one strip per version (scaled down only to fit the sheet)
    crops = []
    for v in vs:
        boxes = (meta.get("crops") or {}).get(v) or []
        parts = [imgs[v].crop((x * dpr, y * dpr, (x + w) * dpr, (y + h) * dpr)) for x, y, w, h in boxes]
        if not parts:
            continue
        sw = sum(p.width for p in parts) + GAP * (len(parts) - 1)
        sh = max(p.height for p in parts)
        strip = Image.new("RGB", (sw, sh), BG)
        x = 0
        for p in parts:
            strip.paste(p, (x, 0))
            x += p.width + GAP
        crops.append((v, strip))
    cw = max((c.width for _, c in crops), default=0)
    ccols = 2 if crops and cw * 2 + GAP * 3 <= W else 1
    if crops and cw + 2 * GAP > W:
        k = (W - 2 * GAP) / cw
        crops = [(v, c.resize((round(c.width * k), round(c.height * k)), Image.LANCZOS)) for v, c in crops]
        cw = max(c.width for _, c in crops)
    ch = max((c.height for _, c in crops), default=0)
    crows = (len(crops) + ccols - 1) // ccols
    crop_h = (60 + crows * (lab + ch + GAP)) if crops else 0
    H = head + tiles_h + crop_h + GAP
    sheet = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    label(d, GAP, 20, meta["title"], ft)
    for i, v in enumerate(vs):
        r, c = divmod(i, cols)
        x = GAP + c * (tw + GAP)
        y = head + r * (lab + th + GAP)
        label(d, x + 4, y + 6, NAMES[v], fl)
        sheet.paste(imgs[v].resize((tw, th), Image.LANCZOS), (x, y + lab))
    if crops:
        y0 = head + tiles_h + 6
        label(d, GAP, y0 + 10, "The glass, enlarged (2× the page)", fl, DIM)
        for i, (v, c) in enumerate(crops):
            r, k = divmod(i, ccols)
            x = GAP + k * (cw + GAP)
            y = y0 + 60 + r * (lab + ch + GAP)
            label(d, x + 4, y + 6, NAMES[v], fl)
            sheet.paste(c, (x, y + lab))
    size, n, mode = save(sheet, os.path.join(out, f"{sid}.png"))
    print(sid, size, n, mode)
    return imgs, meta


def overview(shots, out, versions, picks):
    """The most telling moments: one row per version, the same pieces in
    each row (picks: scene, crop index or None for the whole screen, width)."""
    fl, ft, fs = font(34), font(42), font(24, False)
    metas = {sid: json.load(open(os.path.join(shots, f"{sid}.json"), encoding="utf-8")) for sid, _, _ in picks}
    rows = []
    for v in versions:
        cells = []
        for sid, ci, w in picks:
            meta = metas[sid]
            dpr = meta.get("dpr", 2)
            im = Image.open(os.path.join(shots, f"{sid}.{v}.png")).convert("RGB")
            if ci is not None:
                x, y, cw, ch = meta["crops"][v][ci]
                im = im.crop((x * dpr, y * dpr, (x + cw) * dpr, (y + ch) * dpr))
            k = w / im.width
            cells.append(im.resize((w, round(im.height * k)), Image.LANCZOS))
        rows.append((v, cells))
    widths = [w for _, _, w in picks]
    W = GAP + sum(w + GAP for w in widths)
    lab = 52
    heads = 150
    H = heads + sum(lab + max(c.height for c in cs) + GAP * 2 for _, cs in rows)
    sheet = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    label(d, GAP, 18, "Aurora glass: today and Clear, the same moments", ft)
    x = GAP
    for (sid, ci, w) in picks:
        label(d, x + 2, 90, PICK_NAMES.get((sid, ci), sid), fs, DIM)
        x += w + GAP
    y = heads
    for v, cells in rows:
        label(d, GAP + 2, y + 8, NAMES[v], fl)
        x = GAP
        for c in cells:
            sheet.paste(c, (x, y + lab))
            x += c.width + GAP
        y += lab + max(c.height for c in cells) + GAP * 2
    print("overview", save(sheet, os.path.join(out, "00-overview.png")))


PICK_NAMES = {
    ("01-phone-home", None): "Phone · Home",
    ("01-phone-home", 1): "Phone · the tab bar (2x)",
    ("06-desktop-menu", 0): "Desktop · profile menu",
    ("08-player-menu", 0): "Player · menu on a bright frame",
}


if __name__ == "__main__":
    shots, out = sys.argv[1], sys.argv[2]
    versions = (sys.argv[3] if len(sys.argv) > 3 else "a,e").split(",")
    os.makedirs(out, exist_ok=True)
    ids = sorted({f.rsplit(".", 1)[0] for f in os.listdir(shots) if f.endswith(".json")})
    for sid in ids:
        scene_sheet(shots, sid, versions, out)
    picks = [("01-phone-home", None, 300), ("01-phone-home", 1, 760), ("06-desktop-menu", 0, 270), ("08-player-menu", 0, 470)]
    picks = [p for p in picks if os.path.exists(os.path.join(shots, f"{p[0]}.json"))]
    if picks:
        overview(shots, out, versions, picks)
