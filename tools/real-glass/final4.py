# The fourth pass's short set: every surface at its real size first (one
# pixel of the sheet is one CSS pixel), today beside real glass, then enlarged.
#
#   python tools/real-glass/final4.py <live shots> <instance shots> <out dir>
#
# (final3.py's layout and inputs.)
import os
import sys

import final3 as f3  # noqa: F401  (reads argv as final.py does)
from final3 import sheet, PHONE, P_TOP, P_BAR, D_BAR
from final import L, I, o

if __name__ == "__main__":
    T, R = "today", "real"
    o.save(sheet("Phone 390 x 844 - Home: the top buttons over the picture, the tab bar over posters", L("p-busy", T), L("p-busy", R), 3,
                 real=[("The whole screen", PHONE)], zoom=[("The top buttons", P_TOP, 2), ("The tab bar", P_BAR, 2)]), "01-phone-home.png")
    o.save(sheet("Phone - over the dark sky alone (Settings)", L("p-sky", T), L("p-sky", R), 3,
                 real=[("The whole screen", PHONE)], zoom=[("The top buttons", P_TOP, 2), ("The tab bar", P_BAR, 2)]), "02-phone-sky.png")
    o.save(sheet("Desktop 1440 x 900 - Home: the top bar and the hero's glass button over the picture", L("d-home", T), L("d-home", R), 2,
                 real=[("The top bar", D_BAR), ("The hero's buttons", (60, 800, 760, 900))],
                 zoom=[("The bar's middle", (420, 8, 1000, 100), 2), ("The hero's glass button", (60, 810, 420, 890), 2)]), "03-desktop-home.png")
    o.save(sheet("Desktop - the top bar over cream and white posters: nothing reads as a line of light along the top", L("d-bright", T), L("d-bright", R), 2,
                 real=[("The top bar", D_BAR)], zoom=[("The bar's middle", (420, 8, 1000, 100), 2), ("The bar's top edge", (520, 14, 820, 60), 4)]), "04-desktop-cream.png")
    o.save(sheet("Desktop - the top bar over posters (Home, scrolled)", L("d-busy", T), L("d-busy", R), 2,
                 real=[("The top bar", D_BAR)], zoom=[("The bar's middle", (420, 8, 1000, 100), 2), ("The logo and the bar's left end", (40, 8, 620, 100), 2)]), "05-desktop-posters.png")
    o.save(sheet("Desktop - over the dark sky alone (Settings), the sky held still", L("d-sky", T), L("d-sky", R), 2,
                 real=[("The top bar", D_BAR)], zoom=[("The bar's middle", (420, 8, 1000, 100), 2)]), "06-desktop-sky.png")
    o.save(sheet("Desktop - a film's page (a dark page): the glass buttons", L("d-title", T), L("d-title", R), 2,
                 real=[("The buttons", (330, 520, 1000, 735))], zoom=[("The buttons", (330, 520, 1000, 735), 2)]), "07-desktop-title.png")
    o.save(sheet("The round buttons - desktop, over posters", L("d-busy", T), L("d-busy", R), 2,
                 real=[("The right-hand buttons", (1060, 8, 1440, 100))], zoom=[("The right-hand buttons", (1060, 8, 1440, 100), 3)]), "08-round-desktop.png")
    o.save(sheet("The round buttons - phone, over the picture and over the sky", L("p-busy", T), L("p-busy", R), 3,
                 real=[("Over the picture", P_TOP)], zoom=[("Over the picture", P_TOP, 3)]), "09-round-phone.png")
    o.save(sheet("Tablet 1024 x 768 - Home", L("t-home", T), L("t-home", R), 2,
                 real=[("The top bar", (0, 8, 1024, 100))], zoom=[("The bar", (0, 8, 700, 100), 2)]), "10-tablet-1024.png")
    o.save(sheet("Player, PAUSED on a bright frame (private test server): the lens is on the dock and the top pills for ten seconds of stillness", I("08-player-menu", "a"), I("08-player-menu", "e"), 2,
                 real=[("The top of the screen", (0, 0, 720, 130)), ("The dock", (180, 760, 1260, 880))],
                 zoom=[("The title and Back", (20, 10, 320, 125), 3)], note=None), "11-player-paused.png")
    nl = L("p-busy", "nolens")
    if os.path.exists(nl):
        o.save(sheet("Phone - with the lens (Chrome, Edge, Android) and without (Safari, iPhone, Firefox)", L("p-busy", R), nl, 3,
                     real=[("The whole screen", PHONE)], zoom=[("The tab bar", P_BAR, 2)],
                     note="Photographed in Chrome with the lens refused: the stylesheet path Safari takes. Safari itself was not run.", labels=("With the lens", "Without")), "12-no-lens-phone.png")
        o.save(sheet("Desktop, without the lens - today beside real glass (what Safari shows)", L("d-busy", T), L("d-busy", "nolens"), 2,
                     real=[("The top bar", D_BAR)], zoom=[("The bar's middle", (420, 8, 1000, 100), 2), ("The right-hand buttons", (1060, 8, 1440, 100), 2)],
                     note="Photographed in Chrome with the lens refused. Safari itself was not run.", labels=("Today", "Real glass, no lens")), "13-no-lens-desktop.png")
