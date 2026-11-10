"""Bake the soft shadow of the TV's two floating glass panes (docs/glass-tv.md).

Run from tv-native/:  python tools/gen_glass_shadow.py

The nav rail and Browse's filter panel are panes that SLIDE in (280 ms, on the
native driver / the native rail view). A blurred boxShadow on a surface that
moves is re-blurred as it goes; a picture is one texture the box composites. So
the shadow of the recipe (docs/glass-apple.md section 8) is baked once:

    0 14px 34px rgba(0,0,0,0.34)     the soft one
    0  3px  8px rgba(0,0,0,0.22)     the near one
    0  1px  2px rgba(0,0,0,0.22)     the tight one
    0  0    0  0.5px rgba(0,0,0,0.30) the dark hairline just outside the rim
                                     (one device pixel on the Mi TV; at @1x a
                                     whole pixel at half the strength)

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
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets')

# name, pane width, pane height (the height a 540dp panel gives; stretched otherwise), corner radius
PANES = [
    ('glass-pane-shadow', 208, 518, 38),      # NavRail: left 32, top 11, bottom 11
    ('glass-pane-shadow-wide', 266, 525, 28), # Browse filter panel: left 2, right 32, top 4, bottom 11
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


def bake(name, w, h, radius, scale):
    s = scale
    size = ((w + 2 * MARGIN) * s, (h + 2 * MARGIN) * s)
    x0, y0 = MARGIN * s, MARGIN * s
    x1, y1 = x0 + w * s - 1, y0 + h * s - 1
    r = radius * s
    soft = layer(size, (x0, y0 + 14 * s, x1, y1 + 14 * s), r, 0.34, 34, s)
    near = layer(size, (x0, y0 + 3 * s, x1, y1 + 3 * s), r, 0.22, 8, s)
    tight = layer(size, (x0, y0 + 1 * s, x1, y1 + 1 * s), r, 0.22, 2, s)
    # half a dp: one pixel at @2x; at @1x one pixel at half the strength
    line = layer(size, (x0 - 1, y0 - 1, x1 + 1, y1 + 1), r + 1, 0.30 if s >= 2 else 0.15, 0, s)
    a = over(over(over(soft, near), tight), line)
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
    for name, w, h, radius in PANES:
        for scale in (1, 2):
            bake(name, w, h, radius, scale)
