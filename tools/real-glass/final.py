# The before/after sheets: today's glass (origin/master's stylesheet) beside
# real glass, the same moment twice.
#
#   python tools/real-glass/final.py <live shots> <instance shots> <out dir>
#
# <live shots>: lab.js with LIVE set, names "today" and "real" (this PC's own
# server, real posters, looked at only). <instance shots>: tools/glass-options/
# shoot.js a,e on the private instance (the player).
import os
import sys

from PIL import Image, ImageDraw

sys.argv = [sys.argv[0], sys.argv[1], sys.argv[3], sys.argv[2]]
import options as o  # noqa: E402  (reads argv: shots dir, out dir)

live, inst = sys.argv[1], sys.argv[3]
V = [("today", "Today"), ("real", "Real glass")]


def pair(title, a, b, w, strips=(), k=2, note=None):
    """two whole screens side by side, then enlarged strips of each (boxes in the screens' own pixels)"""
    A, B = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
    s = w / A.width
    pad, head = 18, 84 + (24 if note else 0)
    tiles = [im.resize((w, int(im.height * s)), Image.LANCZOS) for im in (A, B)]
    zs = []
    for cap, box in strips:
        row = []
        for im in (A, B):
            c = im.crop(box)
            zw = min(w, int(c.width * k))
            row.append(c.resize((zw, int(c.height * zw / c.width)), Image.LANCZOS))
        zs.append((cap, row))
    H = head + tiles[0].height + pad + sum(30 + r[0].height + 8 for _, r in zs) + pad
    sheet = Image.new("RGB", (pad + 2 * (w + pad), H), o.BG)
    d = ImageDraw.Draw(sheet)
    d.text((pad, 12), title, font=o.font(24), fill=(255, 255, 255))
    if note:
        d.text((pad, 46), note, font=o.font(14, False), fill=(170, 170, 190))
    for i, (t, (_, label)) in enumerate(zip(tiles, V)):
        x = pad + i * (w + pad)
        d.text((x, head - 34), label, font=o.font(19), fill=(200, 190, 255))
        sheet.paste(t, (x, head))
    y = head + tiles[0].height + pad
    for cap, row in zs:
        d.text((pad, y), cap, font=o.font(15, False), fill=(200, 190, 255))
        y += 30
        for i, t in enumerate(row):
            sheet.paste(t, (pad + i * (w + pad), y))
        y += row[0].height + 8
    return sheet


L = lambda scene, v: os.path.join(live, f"{scene}.{v}.png")
I = lambda scene, v: os.path.join(inst, f"{scene}.{v}.png")
REAL = "This PC's own server, real posters, looked at only as the test profile. Both stylesheets answered by the rig."

if __name__ == "__main__":
    # phone shots are 1170 x 2532 (3x), desktop 2880 x 1800 (2x)
    o.save(pair("Phone 390 x 844 - Home: the tab bar over posters, the top buttons over the picture", L("p-busy", "today"), L("p-busy", "real"), 585,
                [("the top buttons, enlarged", (0, 0, 1170, 190)), ("the tab bar, enlarged", (0, 2300, 1170, 2532))], k=1, note=REAL), "01-phone-home.png")
    o.save(pair("Desktop 1440 x 900 - Home: the top bar over the hero", L("d-home", "today"), L("d-home", "real"), 1100,
                [("the bar's middle, enlarged", (850, 30, 1950, 190)), ("the right-hand buttons, enlarged", (1900, 30, 2880, 190))], k=1, note=REAL), "02-desktop-home.png")
    o.save(pair("Desktop - the top bar over posters (Home, scrolled)", L("d-busy", "today"), L("d-busy", "real"), 1100,
                [("the bar's middle, enlarged", (850, 30, 1950, 190)), ("the logo, enlarged", (60, 30, 1160, 190))], k=1, note=REAL), "03-desktop-posters.png")
    o.save(pair("Desktop - a film's page: the glass buttons", L("d-title", "today"), L("d-title", "real"), 1100,
                [("the buttons, enlarged", (700, 1050, 1900, 1470))], k=0.92, note=REAL), "04-title-desktop.png")
    o.save(pair("Phone - a film's page: the top buttons over the picture, the tab bar over the sky", L("p-title", "today"), L("p-title", "real"), 585,
                [("the top buttons, enlarged", (0, 0, 1170, 190)), ("the tab bar, enlarged", (0, 2300, 1170, 2532))], k=1, note=REAL), "05-title-phone.png")
    o.save(pair("Player - the controls and the menu over a bright frame (private test server)", I("08-player-menu", "a"), I("08-player-menu", "e"), 1100,
                [("the title and Back, enlarged", (40, 20, 1140, 250)), ("the dock's left end, enlarged", (380, 1530, 1480, 1770))], k=1), "06-player.png")
    # one edge, 3x
    crops = [("The tab bar's left end over posters (6x)", L("p-busy", "today"), L("p-busy", "real"), (70, 2290, 520, 2532)),
             ("The settings button over the picture (6x)", L("p-busy", "today"), L("p-busy", "real"), (820, 20, 1170, 190)),
             ("A glass button on a film's page (desktop, 4x)", L("d-title", "today"), L("d-title", "real"), (1240, 1060, 1640, 1220))]
    pad = 18
    rowsz = []
    for cap, a, b, box in crops:
        ims = [Image.open(p).convert("RGB").crop(box) for p in (a, b)]
        rowsz.append((cap, [t.resize((t.width * 2, t.height * 2), Image.LANCZOS) for t in ims]))
    W = pad + 2 * (max(r[1][0].width for r in rowsz) + pad)
    H = 60 + sum(58 + r[1][0].height for r in rowsz) + pad
    sheet = Image.new("RGB", (W, H), o.BG)
    d = ImageDraw.Draw(sheet)
    d.text((pad, 12), "One edge, enlarged: what the rim does to the picture behind it", font=o.font(24), fill=(255, 255, 255))
    y = 60
    for cap, row in rowsz:
        d.text((pad, y), cap, font=o.font(16), fill=(255, 255, 255))
        for i, (t, (_, label)) in enumerate(zip(row, V)):
            x = pad + i * (W - pad) // 2
            d.text((x, y + 26), label, font=o.font(14, False), fill=(200, 190, 255))
            sheet.paste(t, (x, y + 50))
        y += 58 + row[0].height
    o.save(sheet, "07-edge-3x.png")
    # what a browser without the lens shows (Safari, Firefox): lab.js with the lens refused
    nl = os.path.join(os.path.dirname(live.rstrip("/\\")), "live", "p-busy.nolens.png")
    if os.path.exists(nl):
        V[:] = [("real", "Chrome, Edge, Android: with the lens"), ("nolens", "Safari, iPhone, Firefox: without")]
        o.save(pair("Phone - the same glass with and without the lens", L("p-busy", "real"), nl, 585,
                    [("the top buttons, enlarged", (0, 0, 1170, 190)), ("the tab bar, enlarged", (0, 2300, 1170, 2532))], k=1,
                    note="Photographed in Chrome with the lens refused: the stylesheet path Safari takes. Safari itself was not run."), "08-no-lens.png")
