"""Generate the detail page's LEFT-side scrim.

Run from tv-native/:  python tools/gen_side_scrim.py

The detail hero is full-bleed artwork with the title lockup over it, which is the
Apple TV shape. That only works if the left side of the frame is dark enough to
read type on while the right side stays picture — a flat dim over the whole image
makes the art look broken rather than composed.

RN has no linear-gradient, so this is baked, exactly like the player's scrims
(tools/gen-gradients.js) and for the same reason. Two files:

  hero-side.png    left -> right, page colour to transparent. Carries the text.
  hero-bottom.png  bottom -> up, page colour to transparent. Lands the hero on
                   the page background so a rail underneath it has an edge to
                   sit on.

Both are 1px in the constant direction and stretched by the view, so they cost
nothing to decode and scale to any TV.
"""
import os

from PIL import Image

ASSETS = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets')
BG = (11, 12, 20)  # colors.bg

os.makedirs(ASSETS, exist_ok=True)


def ramp(size, stops):
    """A 1-D alpha ramp of `size` samples from (position, alpha) stops."""
    out = []
    for i in range(size):
        t = i / (size - 1)
        for j in range(1, len(stops)):
            p1, a1 = stops[j]
            if t <= p1:
                p0, a0 = stops[j - 1]
                k = (t - p0) / (p1 - p0) if p1 > p0 else 0
                out.append(round(a0 + (a1 - a0) * k))
                break
        else:
            out.append(stops[-1][1])
    return out


# ---- left -> right -----------------------------------------------------------
# Opaque enough to carry a title for the first third, then away to nothing by
# ~78%. The long tail is what keeps it from reading as a panel edge.
W = 512
side = Image.new('RGBA', (W, 1))
# The site's own values: `linear-gradient(to right, rgba(11,12,20,0.66),
# transparent 58%)` in .hero-fade. This used to top out at 242/255 (0.95) and run
# to 78%, which is a wall rather than a scrim — it darkened half the artwork and
# was part of why the TV page read as "dark image" instead of "lit background".
for x, a in enumerate(ramp(W, [(0.0, 168), (0.30, 120), (0.58, 0), (1.0, 0)])):
    side.putpixel((x, 0), BG + (a,))
side.save(os.path.join(ASSETS, 'hero-side.png'))
print('hero-side.png', W, 'x1')

# hero-bottom.png is GONE. It painted opaque --bg over the foot of the artwork,
# which is the exact mistake public/css/screens.css documents and fixes: an
# opaque strip is the one band on the page with no ambient light in it and the
# join reads as a horizon line. The artwork now dissolves into the real
# background instead — see ambient-veil.png in tools/gen_ambient.py.
