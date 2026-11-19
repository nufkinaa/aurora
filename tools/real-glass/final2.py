# The second pass's sheets: today's glass beside real glass, the same moment
# twice — the first pass's pairs again, plus the dark sky, a dark title page
# and the widths between a phone and a wide desktop.
#
#   python tools/real-glass/final2.py <live shots> <instance shots> <out dir>
#
# (final.py's layout; <live shots>: lab.js with LIVE set, names "today",
# "real" and "nolens"; <instance shots>: tools/glass-options/shoot.js a,e.)
import os
import sys

import final as f  # noqa: E402  (reads argv as final.py does)
from final import pair, L, I, REAL, o
from PIL import Image, ImageDraw

live = sys.argv[1]

if __name__ == "__main__":
    P_TOP, P_BAR = (0, 0, 1170, 190), (0, 2300, 1170, 2532)
    o.save(pair("Phone 390 x 844 - Home: the tab bar over posters, the top buttons over the picture", L("p-busy", "today"), L("p-busy", "real"), 585,
                [("the top buttons, enlarged", P_TOP), ("the tab bar, enlarged", P_BAR)], k=1, note=REAL), "01-phone-home.png")
    o.save(pair("Phone - the tab bar over the brightest posters", L("p-bright", "today"), L("p-bright", "real"), 585,
                [("the tab bar, enlarged", P_BAR)], k=1, note=REAL), "02-phone-bright.png")
    o.save(pair("Phone - over the dark sky alone (Settings)", L("p-sky", "today"), L("p-sky", "real"), 585,
                [("the top buttons, enlarged", P_TOP), ("the tab bar, enlarged", P_BAR)], k=1, note=REAL), "03-phone-sky.png")
    o.save(pair("Phone - a film's page: the top buttons over the picture, the tab bar over the dark page", L("p-title", "today"), L("p-title", "real"), 585,
                [("the top buttons, enlarged", P_TOP), ("the tab bar, enlarged", P_BAR)], k=1, note=REAL), "04-phone-title.png")
    o.save(pair("Desktop 1440 x 900 - Home: the top bar over the hero", L("d-home", "today"), L("d-home", "real"), 1100,
                [("the bar's middle, enlarged", (850, 30, 1950, 190)), ("the right-hand buttons, enlarged", (1900, 30, 2880, 190))], k=1, note=REAL), "05-desktop-home.png")
    o.save(pair("Desktop - the top bar over posters (Home, scrolled)", L("d-busy", "today"), L("d-busy", "real"), 1100,
                [("the bar's middle, enlarged", (850, 30, 1950, 190)), ("the logo, enlarged", (60, 30, 1160, 190))], k=1, note=REAL), "06-desktop-posters.png")
    o.save(pair("Desktop - over the dark sky alone (Settings)", L("d-sky", "today"), L("d-sky", "real"), 1100,
                [("the bar's middle, enlarged", (850, 30, 1950, 190)), ("the right-hand buttons, enlarged", (1900, 30, 2880, 190))], k=1, note=REAL), "07-desktop-sky.png")
    o.save(pair("Desktop - a film's page (a dark page): the glass buttons", L("d-title", "today"), L("d-title", "real"), 1100,
                [("the buttons, enlarged", (700, 1050, 1900, 1470))], k=0.92, note=REAL), "08-desktop-title.png")
    # tablets: shots are 2x (1024 x 768 -> 2048 x 1536; 768 x 1024 -> 1536 x 2048)
    o.save(pair("Tablet 1024 x 768 - Home: the bar follows the logo here", L("t-home", "today"), L("t-home", "real"), 1000,
                [("the top bar, enlarged", (0, 20, 2048, 180))], k=0.5, note=REAL), "09-tablet-1024-home.png")
    o.save(pair("Tablet 1024 x 768 - the bar over posters", L("t-busy", "today"), L("t-busy", "real"), 1000,
                [("the top bar, enlarged", (0, 20, 2048, 180))], k=0.5, note=REAL), "10-tablet-1024-posters.png")
    o.save(pair("Tablet 768 x 1024 - Home", L("t7-home", "today"), L("t7-home", "real"), 760,
                [("the top bar, enlarged", (0, 20, 1536, 180))], k=0.5, note=REAL), "11-tablet-768-home.png")
    o.save(pair("Tablet 768 x 1024 - a film's page", L("t7-title", "today"), L("t7-title", "real"), 760,
                [("the top bar, enlarged", (0, 20, 1536, 180))], k=0.5, note=REAL), "12-tablet-768-title.png")
    o.save(pair("Player - the controls and the menu over a bright frame (private test server). No lens here: a film changes every frame.", I("08-player-menu", "a"), I("08-player-menu", "e"), 1100,
                [("the title and Back, enlarged", (40, 20, 1140, 250)), ("the dock's left end, enlarged", (380, 1530, 1480, 1770))], k=1), "13-player.png")
    # one edge, enlarged
    crops = [("The tab bar's left end over posters (6x)", L("p-busy", "today"), L("p-busy", "real"), (20, 2290, 470, 2532)),
             ("The desktop bar's left end over posters (4x)", L("d-busy", "today"), L("d-busy", "real"), (900, 40, 1350, 180)),
             ("The settings button over the picture (6x)", L("p-busy", "today"), L("p-busy", "real"), (820, 20, 1170, 190)),
             ("A glass button on a film's page (desktop, 4x)", L("d-title", "today"), L("d-title", "real"), (1240, 1060, 1640, 1220))]
    pad = 18
    rows = []
    for cap, a, b, box in crops:
        ims = [Image.open(p).convert("RGB").crop(box) for p in (a, b)]
        rows.append((cap, [t.resize((t.width * 2, t.height * 2), Image.LANCZOS) for t in ims]))
    W = pad + 2 * (max(r[1][0].width for r in rows) + pad)
    H = 60 + sum(58 + r[1][0].height for r in rows) + pad
    sheet = Image.new("RGB", (W, H), o.BG)
    d = ImageDraw.Draw(sheet)
    d.text((pad, 12), "One edge, enlarged: what the rim does to the picture behind it", font=o.font(24), fill=(255, 255, 255))
    y = 60
    for cap, row in rows:
        d.text((pad, y), cap, font=o.font(16), fill=(255, 255, 255))
        for i, (t, label) in enumerate(zip(row, ["Today", "Real glass"])):
            x = pad + i * (W - pad) // 2
            d.text((x, y + 26), label, font=o.font(14, False), fill=(200, 190, 255))
            sheet.paste(t, (x, y + 50))
        y += 58 + row[0].height
    o.save(sheet, "14-edge.png")
    nl = L("p-busy", "nolens")
    if os.path.exists(nl):
        f.V[:] = [("real", "Chrome, Edge, Android: with the lens"), ("nolens", "Safari, iPhone, Firefox: without")]
        o.save(pair("Phone - the same glass with and without the lens", L("p-busy", "real"), nl, 585,
                    [("the top buttons, enlarged", P_TOP), ("the tab bar, enlarged", P_BAR)], k=1,
                    note="Photographed in Chrome with the lens refused: the stylesheet path Safari takes. Safari itself was not run."), "15-no-lens-phone.png")
        o.save(pair("Desktop - the same glass with and without the lens", L("d-busy", "real"), L("d-busy", "nolens"), 1100,
                    [("the bar's middle, enlarged", (850, 30, 1950, 190))], k=1,
                    note="Photographed in Chrome with the lens refused. Safari itself was not run."), "16-no-lens-desktop.png")
