"""Generate the site's ambient background.

Run from tv-native/:  python tools/gen_ambient.py

This is a direct transcription of public/css/base.css, not an interpretation of
it. Three fixed layers sit behind every page there:

    html::before   violet bloom   radial-gradient(46% 42% at 70% 16%, --wash-hi, transparent 62%)
    html::after    cooler bloom   radial-gradient(44% 40% at 24% 84%, --wash-lo, transparent 60%)
    body::before   film grain, static, opacity .032

THE GEOMETRY IS THE WHOLE THING, AND IT IS EASY TO GET WRONG.
Both bloom layers are `inset: -25%`, so each layer is **150% of the viewport**
in both axes and the gradient's percentages are relative to THAT, not to the
screen. Converting to viewport coordinates (the layer spans -25%..125%):

    wash-hi centre  ->  x = -25 + .70*150 =  80%   y = -25 + .16*150 =  -1%
    wash-lo centre  ->  x = -25 + .24*150 =  11%   y = -25 + .84*150 = 101%

i.e. both centres sit essentially ON the top-right and bottom-left corners, just
off-screen. What the site actually shows is the *tails* of two blooms leaking in
from opposite corners — which is why it reads as ambient light rather than as two
coloured blobs.

A previous bake put the centres at 70%/16% and 24%/84% of the SCREEN and doubled
the alphas on top ("a TV is further away"). Measured against the live site:
that bake peaked at RGB (50,43,112) where nothing on the real page exceeds
(17,26,41). It was roughly three times too strong and in the wrong places. Hence
this rewrite: exact tokens, exact geometry, no editorialising.

Output is two files, because they scale differently:

  ambient.png       the blooms over the page colour, 480x270, stretched to fit.
                    A gradient this soft has no detail to lose.
  ambient-grain.png a 160x160 grain tile, repeated at 1:1 on any panel.

Baking the grain INTO the wash forces the wash to ship at full resolution (noise
defeats PNG compression and turns to mush when stretched): the combined 960x540
file came out at 528 KB against 21 KB for the pair.
"""
import math
import os
import random

from PIL import Image

ASSETS = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets')
os.makedirs(ASSETS, exist_ok=True)

W, H = 480, 270
BG = (11, 12, 20)  # --bg / colors.bg
GRAIN_TILE = 160   # body::before's background-size
GRAIN = 0.032      # body::before's opacity

# The layer is 150% of the viewport (inset: -25%). Everything below is expressed
# in layer fractions and converted once, so the CSS numbers stay readable.
LAYER = 1.5
OFF = -0.25


def to_viewport(v):
    return OFF + v * LAYER


# (centre x, centre y, radius x, radius y, rgb, alpha, transparent-stop), with
# positions and radii straight out of base.css and alphas straight out of
# tokens.css (--wash-hi / --wash-lo).
BLOOMS = [
    (to_viewport(0.70), to_viewport(0.16), 0.46 * LAYER, 0.42 * LAYER,
     (96, 80, 220), 0.24, 0.62),
    (to_viewport(0.24), to_viewport(0.84), 0.44 * LAYER, 0.40 * LAYER,
     (48, 112, 184), 0.17, 0.60),
]

img = Image.new('RGB', (W, H), BG)
px = img.load()

for y in range(H):
    for x in range(W):
        r, g, b = BG
        for cx, cy, rx, ry, (br, bg_, bb), peak, stop in BLOOMS:
            # Normalised elliptical distance: 1.0 is the rx/ry ellipse edge,
            # which is what a radial-gradient's 100% means.
            d = math.hypot((x / W - cx) / rx, (y / H - cy) / ry)
            if d >= stop:
                continue
            # `transparent <stop>%` is a LINEAR ramp to zero at that fraction of
            # the ray. Transcribed as-is rather than smoothed: the softer curve
            # an earlier version used is part of why that bake did not match.
            a = peak * (1.0 - d / stop)
            r += (br - r) * a
            g += (bg_ - g) * a
            b += (bb - b) * a
        px[x, y] = (round(r), round(g), round(b))

path = os.path.join(ASSETS, 'ambient.png')
img.save(path, optimize=True)
print(f'ambient.png: {os.path.getsize(path) / 1024:.1f} KB')

# ---- the veil ---------------------------------------------------------------
# The same canvas again, with a vertical alpha ramp, drawn OVER the hero art so
# the artwork dissolves INTO the real background instead of being covered by a
# flat one.
#
# This replaces hero-bottom.png, which was an opaque --bg ramp. public/css/
# screens.css documents that exact mistake and its fix: painting opaque page
# colour over the art gives you "the one band on the page with no ambient light
# in it, and the join read as a horizon line". The site solved it by dissolving
# the ARTWORK to alpha zero so the fixed layers show through. RN cannot
# gradient-mask an image, so the equivalent is to bring the background forward
# with a ramp instead — same result, and the blooms are present in the join.
#
# The stops come from --hero-dissolve (#000 70%, rgba(0,0,0,.45) 81%,
# transparent 87%) — as fractions of the HERO BOX, not of the screen. So each
# veil is baked against its own screen's hero height.
#
# Home is 0.76, which is the site's own `.hero { min-height: 76vh }`
# (screens.css:4). It was 0.42, baked against the previous app's shorter hero and
# the budget that argued for it — both void (RULES rule 13, SPEC/99-open.md §I.3).
# At 0.42 the ramp finished 34% up the screen, so with the real hero the shelves
# sat on bright artwork.
HERO = {'ambient-veil.png': 0.76,       # Home: screens.css:4, min-height 76vh
        'ambient-veil-tall.png': 0.62}  # Detail: settled by 04/05
DISSOLVE = [(0.70, 0.0), (0.81, 0.55), (0.87, 1.0)]


def veil_alpha(t, hero):
    stops = [(p * hero, a) for p, a in DISSOLVE]
    if t <= stops[0][0]:
        return 0.0
    for i in range(len(stops) - 1):
        (p0, a0), (p1, a1) = stops[i], stops[i + 1]
        if t <= p1:
            return a0 + (a1 - a0) * (t - p0) / (p1 - p0)
    return 1.0


for name, hero in HERO.items():
    veil = img.convert('RGBA')
    veil.putalpha(Image.frombytes('L', (W, H), bytes(
        round(255 * veil_alpha(y / H, hero)) for y in range(H) for _ in range(W))))
    path = os.path.join(ASSETS, name)
    veil.save(path, optimize=True)
    print(f'{name}: {os.path.getsize(path) / 1024:.1f} KB  (art gone by {hero * 0.87 * 100:.0f}%)')

# The grain tile. White noise in the alpha channel; the view draws it at GRAIN
# opacity. Deterministic so regenerating never changes the asset.
random.seed(11)
tile = Image.new('RGBA', (GRAIN_TILE, GRAIN_TILE))
tile.putdata([(255, 255, 255, random.randint(0, 255))
              for _ in range(GRAIN_TILE * GRAIN_TILE)])
path = os.path.join(ASSETS, 'ambient-grain.png')
tile.save(path, optimize=True)
print(f'ambient-grain.png: {os.path.getsize(path) / 1024:.1f} KB  (draw at opacity {GRAIN})')
