"""Bake the soft shadow of the TV's two floating glass panes (docs/glass-tv.md).

Run from tv-native/:  python tools/gen_glass_shadow.py

The nav rail and Browse's filter panel are panes that SLIDE in (280 ms, on the
native driver / the native rail view). A blurred boxShadow on a surface that
moves is re-blurred as it goes; a picture is one texture the box composites. So
the shadow of the recipe (docs/glass-apple.md section 8) is baked once:

    0 12px 32px rgba(0,0,0,0.32)   the soft one
    0  2px  6px rgba(0,0,0,0.20)   the near one
    0  0    0  1px rgba(0,0,0,0.26) the dark line just outside the rim

Geometry, in dp: a pane W x H with corner radius R, and MARGIN dp of room on
every side. The picture is laid out as (W + 2*MARGIN) x (H + 2*MARGIN) with the
pane's box in the middle, and `resizeMode="stretch"` lets one file serve any
panel height (the pane is the screen's height less its two insets). The pane's
own box is left EMPTY in the picture - the pane is opaque, nothing under it
shows, and an empty middle is less to blend.

Two files per pane, @1x and @2x (the Mi TV is 2 px per dp), as the logo has.
"""
import os
from PIL import Image, ImageChops, ImageDraw, ImageFilter

MARGIN = 48
RADIUS = 38
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets')

# name, pane width, pane height (the height a 540dp panel gives; stretched otherwise)
PANES = [
    ('glass-pane-shadow', 208, 518),      # NavRail: left 32, top 11, bottom 11
    ('glass-pane-shadow-wide', 266, 523), # Browse filter panel: left 2, right 32, top 6, bottom 11
]


def layer(size, box, radius, alpha, blur, scale):
    """One box-shadow layer as an 8-bit alpha mask. CSS blur B = a gaussian of sigma B/2."""
    im = Image.new('L', size, 0)
    ImageDraw.Draw(im).rounded_rectangle(box, radius=radius, fill=round(255 * alpha))
    return im.filter(ImageFilter.GaussianBlur(blur * scale / 2)) if blur else im


def over(a, b):
    """Two black layers one over the other: 1 - (1 - a)(1 - b)."""
    inv = ImageChops.multiply(ImageChops.invert(a), ImageChops.invert(b))
    return ImageChops.invert(inv)


def bake(name, w, h, scale):
    s = scale
    size = ((w + 2 * MARGIN) * s, (h + 2 * MARGIN) * s)
    x0, y0 = MARGIN * s, MARGIN * s
    x1, y1 = x0 + w * s - 1, y0 + h * s - 1
    r = RADIUS * s
    soft = layer(size, (x0, y0 + 12 * s, x1, y1 + 12 * s), r, 0.32, 32, s)
    near = layer(size, (x0, y0 + 2 * s, x1, y1 + 2 * s), r, 0.20, 6, s)
    line = layer(size, (x0 - s, y0 - s, x1 + s, y1 + s), r + s, 0.26, 0, s)
    a = over(over(soft, near), line)
    # the pane's own box: empty (drawn 4x and scaled down for a clean edge)
    hole = Image.new('L', (size[0] * 4, size[1] * 4), 255)
    ImageDraw.Draw(hole).rounded_rectangle((x0 * 4, y0 * 4, (x1 + 1) * 4 - 1, (y1 + 1) * 4 - 1), radius=r * 4, fill=0)
    a = ImageChops.multiply(a, hole.resize(size, Image.LANCZOS))
    out = Image.new('RGBA', size, (0, 0, 0, 0))
    out.putalpha(a)
    path = os.path.join(OUT, name + ('' if s == 1 else '@%dx' % s) + '.png')
    out.save(path, optimize=True)
    print(os.path.normpath(path), size, os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    for name, w, h in PANES:
        for scale in (1, 2):
            bake(name, w, h, scale)
