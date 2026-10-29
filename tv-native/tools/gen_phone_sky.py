"""The phone app's sky: the website's glass look, baked once into a still
picture. The site paints its sky on a living canvas (aurora-sky.js over the
glass look's page colour #070811), which costs a phone ~40% of its main thread
while visible; a still costs nothing per frame.

2026-10-29 (phone 1.0.1, "closer to the website"): the sky is no longer drawn
from colour stops. The first version's stops were read off the mobile-perf
harness's screenshots, whose shots.js swaps the living canvas for a FIXED TEST
GRADIENT (navy -> green -> violet) — so the app's sky was green and violet where
the real site is a dark navy night with a violet glow at the top, a faint blue
in the lower left, and stars. This script now takes a real capture of the site's
sky and scales it to the size the app ships.

The capture: the website at the Pixel 9's dp size (411 x 923, device scale
2.625, Chrome mobile emulation), glass look, any page, ~8 s after load (the
painter has faded in), with everything but the sky hidden:

    #app, nav, .nav, main, .toast, .nav-items { visibility: hidden !important }

Run from tv-native/:  python tools/gen_phone_sky.py <capture.png>
"""
import os
import sys

from PIL import Image, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'phone', 'assets')
W = 540  # half the Pixel 9's pixels: the stars stay points, the bitmap stays small (2.6 MB decoded)
BG = (7, 8, 17)  # the glass look's --bg


def main(src):
    im = Image.open(src).convert('RGB')
    h = round(im.height * W / im.width)
    sky = im.resize((W, h), Image.LANCZOS)
    sky.save(os.path.join(OUT, 'sky.png'), optimize=True)
    # the profile wall / sign-in: the site lays its overlay over the sky there
    # (.ui-overlay: rgba(7, 8, 17, 0.55) with an 18 px blur)
    dim = Image.blend(sky, Image.new('RGB', sky.size, BG), 0.55).filter(ImageFilter.GaussianBlur(18 * W / 411))
    dim.save(os.path.join(OUT, 'sky-dim.png'), optimize=True)
    for n in ('sky.png', 'sky-dim.png'):
        print(n, Image.open(os.path.join(OUT, n)).size, os.path.getsize(os.path.join(OUT, n)), 'bytes')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1])
