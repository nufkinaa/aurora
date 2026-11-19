# The third pass's sheets. Every surface is shown FIRST at its real size —
# one pixel of the sheet is one CSS pixel of the screen, no enlargement —
# today above (or beside) real glass, and only then enlarged.
#
#   python tools/real-glass/final3.py <live shots> <instance shots> <out dir>
#
# <live shots>: lab.js with LIVE set, names "today", "real" and "nolens"
# (phone shots 3x, desktop and tablet 2x); <instance shots>:
# tools/glass-options/shoot.js a,e (the player, paused on a bright frame).
import os
import sys

import final as f  # noqa: F401  (reads argv as final.py does)
from final import L, I, REAL, o
from PIL import Image, ImageDraw

PAD = 18
LAB = (200, 190, 255)


def load(p):
    return Image.open(p).convert("RGB")


def at1x(im, dpr, box=None):
    """a part of a shot (box in CSS px) at its real size"""
    if box:
        im = im.crop(tuple(int(v * dpr) for v in box))
    return im.resize((max(1, round(im.width / dpr)), max(1, round(im.height / dpr))), Image.LANCZOS)


def zoomed(im, dpr, box, k):
    """a part of a shot (box in CSS px) at k times its real size"""
    c = im.crop(tuple(int(v * dpr) for v in box))
    return c.resize((round(c.width * k / dpr), round(c.height * k / dpr)), Image.LANCZOS)


def sheet(title, a, b, dpr, real=(), zoom=(), note=REAL, labels=("Today", "Real glass"), beside=None):
    """real: [(caption, box)] at 1x; zoom: [(caption, box, k)]. Pairs go side by side when they fit (beside), else one above the other."""
    A, B = load(a), load(b)
    blocks = []  # (caption, [imA, imB])
    for cap, box in real:
        blocks.append((f"{cap} - real size", [at1x(A, dpr, box), at1x(B, dpr, box)]))
    for cap, box, k in zoom:
        blocks.append((f"{cap} - {k}x", [zoomed(A, dpr, box, k), zoomed(B, dpr, box, k)]))
    rows = []
    for cap, (x, y) in blocks:
        side = beside if beside is not None else (x.width * 2 + PAD <= 2300)
        rows.append((cap, x, y, side))
    W = 2 * PAD + max((x.width * 2 + PAD) if side else x.width for _, x, _, side in rows)
    W = max(W, 900)
    H = 70 + (22 if note else 0) + sum(30 + 22 + (x.height if side else x.height * 2 + 26) + 14 for _, x, _, side in rows) + PAD
    s = Image.new("RGB", (W, H), o.BG)
    d = ImageDraw.Draw(s)
    d.text((PAD, 12), title, font=o.font(24), fill=(255, 255, 255))
    if note:
        d.text((PAD, 46), note, font=o.font(14, False), fill=(170, 170, 190))
    yy = 70 + (22 if note else 0)
    for cap, x, y, side in rows:
        d.text((PAD, yy), cap, font=o.font(17), fill=(255, 255, 255))
        yy += 30
        if side:
            d.text((PAD, yy), labels[0], font=o.font(14, False), fill=LAB)
            d.text((PAD + x.width + PAD, yy), labels[1], font=o.font(14, False), fill=LAB)
            yy += 22
            s.paste(x, (PAD, yy)); s.paste(y, (PAD + x.width + PAD, yy))
            yy += x.height + 14
        else:
            d.text((PAD, yy), labels[0], font=o.font(14, False), fill=LAB)
            yy += 22
            s.paste(x, (PAD, yy)); yy += x.height + 4
            d.text((PAD, yy), labels[1], font=o.font(14, False), fill=LAB)
            yy += 22
            s.paste(y, (PAD, yy)); yy += x.height + 14
    return s.crop((0, 0, W, yy + PAD))


PHONE = (0, 0, 390, 844)
P_TOP, P_BAR = (0, 0, 390, 70), (0, 765, 390, 844)
D_BAR = (0, 8, 1440, 100)

if __name__ == "__main__":
    T, R = "today", "real"
    o.save(sheet("Phone 390 x 844 - Home: the top buttons over the picture, the tab bar over posters", L("p-busy", T), L("p-busy", R), 3,
                 real=[("The whole screen", PHONE)], zoom=[("The top buttons", P_TOP, 2), ("The tab bar", P_BAR, 2)]), "01-phone-home.png")
    o.save(sheet("Phone - the tab bar over the brightest posters", L("p-bright", T), L("p-bright", R), 3,
                 real=[("The foot of the screen", (0, 600, 390, 844))], zoom=[("The tab bar", P_BAR, 2)]), "02-phone-bright.png")
    o.save(sheet("Phone - over the dark sky alone (Settings)", L("p-sky", T), L("p-sky", R), 3,
                 real=[("The whole screen", PHONE)], zoom=[("The top buttons", P_TOP, 2), ("The tab bar", P_BAR, 2)]), "03-phone-sky.png")
    o.save(sheet("Phone - a film's page: the top buttons over the picture, the tab bar over the dark page", L("p-title", T), L("p-title", R), 3,
                 real=[("The whole screen", PHONE)], zoom=[("The top buttons", P_TOP, 2), ("The tab bar", P_BAR, 2)]), "04-phone-title.png")
    o.save(sheet("Desktop 1440 x 900 - Home: the top bar and the hero's glass button over the picture", L("d-home", T), L("d-home", R), 2,
                 real=[("The top bar", D_BAR), ("The hero's buttons", (60, 800, 760, 900))],
                 zoom=[("The bar's middle", (420, 8, 1000, 100), 2), ("The right-hand buttons", (1060, 8, 1440, 100), 2), ("The hero's glass button", (60, 810, 420, 890), 2)]), "05-desktop-home.png")
    o.save(sheet("Desktop - the top bar over posters (Home, scrolled)", L("d-busy", T), L("d-busy", R), 2,
                 real=[("The top bar", D_BAR)], zoom=[("The bar's middle", (420, 8, 1000, 100), 2), ("The logo and the bar's left end", (40, 8, 620, 100), 2), ("The right-hand buttons", (1060, 8, 1440, 100), 2)]), "06-desktop-posters.png")
    o.save(sheet("Desktop - over the dark sky alone (Settings). The sky is held still: the same phase on both sides.", L("d-sky", T), L("d-sky", R), 2,
                 real=[("The top bar", D_BAR)], zoom=[("The bar's middle", (420, 8, 1000, 100), 2), ("The right-hand buttons", (1060, 8, 1440, 100), 2)]), "07-desktop-sky.png")
    o.save(sheet("Desktop - a film's page (a dark page): the glass buttons", L("d-title", T), L("d-title", R), 2,
                 real=[("The buttons", (330, 520, 1000, 735)), ("The top bar", D_BAR)], zoom=[("The buttons", (330, 520, 1000, 735), 2)]), "08-desktop-title.png")
    o.save(sheet("Tablet 1024 x 768 - Home: the bar follows the logo here", L("t-home", T), L("t-home", R), 2,
                 real=[("The top bar", (0, 8, 1024, 100))], zoom=[("The bar", (0, 8, 700, 100), 2)]), "09-tablet-1024-home.png")
    o.save(sheet("Tablet 1024 x 768 - the bar over posters", L("t-busy", T), L("t-busy", R), 2,
                 real=[("The top bar", (0, 8, 1024, 100))], zoom=[("The bar", (0, 8, 700, 100), 2)]), "10-tablet-1024-posters.png")
    o.save(sheet("Tablet 768 x 1024 - Home and a film's page", L("t7-home", T), L("t7-home", R), 2,
                 real=[("The top bar", (0, 8, 768, 100))], zoom=[("The bar", (0, 8, 768, 100), 2)]), "11-tablet-768-home.png")
    o.save(sheet("Player, PAUSED on a bright frame (private test server): the dock and the top pills take the lens on a still frame", I("08-player-menu", "a"), I("08-player-menu", "e"), 2,
                 real=[("The top of the screen", (0, 0, 720, 130)), ("The dock", (180, 760, 1260, 880))],
                 zoom=[("The title and Back", (20, 10, 320, 125), 3), ("The dock's left end", (190, 765, 560, 885), 3)], note=None), "12-player-paused.png")
    nl = L("p-busy", "nolens")
    if os.path.exists(nl):
        o.save(sheet("Phone - with the lens (Chrome, Edge, Android) and without (Safari, iPhone, Firefox)", L("p-busy", R), nl, 3,
                     real=[("The whole screen", PHONE)], zoom=[("The top buttons", P_TOP, 2), ("The tab bar", P_BAR, 2)],
                     note="Photographed in Chrome with the lens refused: the stylesheet path Safari takes. Safari itself was not run.", labels=("With the lens", "Without")), "13-no-lens-phone.png")
        o.save(sheet("Desktop - with the lens and without", L("d-busy", R), L("d-busy", "nolens"), 2,
                     real=[("The top bar", D_BAR)], zoom=[("The bar's middle", (420, 8, 1000, 100), 2), ("The right-hand buttons", (1060, 8, 1440, 100), 2)],
                     note="Photographed in Chrome with the lens refused. Safari itself was not run.", labels=("With the lens", "Without")), "14-no-lens-desktop.png")
        o.save(sheet("Desktop, without the lens - today beside real glass on a film's page (what Safari shows)", L("d-title", T), L("d-title", "nolens"), 2,
                     real=[("The buttons", (330, 520, 1000, 735))], zoom=[("The buttons", (330, 520, 1000, 735), 2)],
                     note="Photographed in Chrome with the lens refused. Safari itself was not run.", labels=("Today", "Real glass, no lens")), "15-no-lens-title.png")
