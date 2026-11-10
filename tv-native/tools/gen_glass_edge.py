"""Bake the edge of the TV's glass panes: the soft shadow that falls outside a
pane and the light that sits just inside its rim (docs/glass-tv.md).

Run from tv-native/:  python tools/gen_glass_edge.py

Why pictures. Measured on the Mi TV, on the player's menu (opening and closing
it, median frame): 15 ms before the glass; 23 ms with the shadow as three
blurred boxShadow layers and the light as five CSS gradients; 20 ms with the
shadow baked and the five gradients left. The box draws every one of those
again on each frame the screen draws while the pane is up - a blur per shadow
layer, a full-pane blend per gradient. A picture is a texture it composites
once. So a pane keeps ONE gradient (the sheen, which is as tall as half the
pane and cannot be a fixed picture) and everything along its edge is baked here.
With one gradient and these pictures the menu is back at 16 ms - and, measured
against the old look inside one start of the app, level with it (the numbers
are at the head of src/glass.ts and in docs/glass-tv.md).

The shadow, outside the pane (docs/glass-apple.md section 8), in black:

    0 14px 34px rgba(0,0,0,0.34)     the soft one
    0  3px  8px rgba(0,0,0,0.22)     the near one
    0  1px  2px rgba(0,0,0,0.22)     the tight one
    0  0    0  0.5px rgba(0,0,0,0.30) the dark hairline just outside the rim
                                     (one device pixel on the Mi TV; at @1x a
                                     whole pixel at half the strength)

The light, inside the pane, in white - straight bands from each edge, cut by
the pane's round corners, exactly what the gradients drew:

    a menu, a sheet      top 22 % -> 0 over 15 dp, each side 7 % -> 0 over
                         12 dp, foot 10 % -> 0 over 13 dp
    the rail, the        top 18 % -> 0 over 9 dp, foot 8 % -> 0 over 8 dp
    filter panel

The rail and the filter panel slide in over the page, so their one picture
holds the rest of the glass as well, and the pane under it is a plain round box
with no border and no gradient:

    the rim              a 1 dp line just inside the edge: white 28 % on top,
                         12 % at the foot, 5.5 % down the sides (glass.ts
                         `rim`); round a corner it turns from the one to the
                         other with the slope of the curve
    the sheen            white 5 % at the top -> 0 at 48 % of the height
    the ground           what the pane floats over at its foot (below)

THE GROUND. Those two are closed shapes that float 11 dp above the screen's
foot, round corners and a lit rim all round - and in those 11 dp, and round the
two foot corners, the page went on: the tops of the next row of posters, half
of "My downloads", right under the rail's profile pill. (For one build the
panes ran off the screen's foot instead; that hid the page and lost the closed
shape. Two judges asked for both, 2026-11-10.) So the picture, which already
lies over that strip with the pane's shadow in it, is OPAQUE there in the
page's own dark: under the foot, and round the foot corners from a little
above where they start to turn. Beside the pane it fades out over GROUND_SIDE
dp, so the page next to the foot goes dark the way it does under a shadow and
nothing is cut with a line. No new view and no new pixels drawn: the same
picture, other alpha.

Geometry, in dp: a pane W x H with corner radius R, and MARGIN dp of room on
every side. A picture is laid out as (W + 2*MARGIN) x (H + 2*MARGIN) with the
pane's box in the middle. It lies OVER its pane (it is the pane's child, or
comes after it), under the pane's words; the pane is opaque, so the middle of
the picture - past the light - is empty.

Two kinds:

  * one whole picture for a pane of a known size - the nav rail, Browse's
    filter panel (`glass-pane-edge*.png`): shadow, rim, glow, sheen and the
    ground under the foot.
    `resizeMode="stretch"` lets the one file serve any panel height (every TV
    is 540 dp tall today, so it is drawn pixel for pixel).
  * nine pieces for a pane of ANY size - a sheet, a player menu, the genre
    popup, X-Ray (components/GlassEdge.tsx): a corner picture per corner radius
    (the top one and the foot one, mirrored for the right side) and three runs
    that stretch along the sides. A corner reaches C dp into the pane (C_TOP at
    the top, where the soft shadow hangs 14 dp lower and settles later); past
    that neither the shadow nor the light changes along the side (under 1 % of
    alpha), so a run can stretch. A run reaches G dp into the pane, past the
    deepest band of light.

Two files each, @1x and @2x (the Mi TV is 2 px per dp), as the logo has.
"""
import os
from PIL import Image, ImageChops, ImageDraw, ImageFilter

MARGIN = 48
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets')

# the pane's body (glass.ts BODY): only the pixels on the curve of a corner use it
BODY = (40, 40, 46)

# the light inside the edge: (strength, depth in dp) per edge, None for no band
LIGHT_MENU = {'top': (0.22, 15), 'side': (0.07, 12), 'foot': (0.10, 13)}
LIGHT_CHROME = {'top': (0.18, 9), 'side': None, 'foot': (0.08, 8)}
# the chrome's rim (glass.ts `rim`) and sheen, baked into the whole-pane pictures
RIM_CHROME = {'top': 0.28, 'side': 0.055, 'foot': 0.12}
SHEEN = (0.05, 0.48)  # strength at the top, the share of the height it fades over

# name, pane width, pane height (the height a 540dp panel gives; stretched otherwise), corner radius
PANES = [
    ('glass-pane-edge', 208, 518, 38),      # NavRail: left 32, top 11, bottom 11
    ('glass-pane-edge-wide', 266, 525, 28), # Browse filter panel: left 2, right 32, top 4, bottom 11
]
# the ground under those two (see the head of this file): its colour - the page's own dark,
# theme colors.bg; how far beside the pane it fades out, in dp; and where it starts above the
# foot, in shares of the corner radius - whole from the first down, nothing above the second
GROUND = (11, 12, 20)
GROUND_SIDE = 24
GROUND_RISE = (0.45, 1.15)

# the nine pieces: corner radii, and how far the pictures reach into the pane
SLICE_RADII = (14, 18, 22, 24)  # the genre popup, a player menu, a sheet, a sheet on the screen's foot
C = 34
C_TOP = 48
G = 16
RUN = 8  # dp along the side; stretched


def layer(size, box, radius, alpha, blur, scale):
    """One box-shadow layer as an 8-bit alpha mask. CSS blur B = a gaussian of sigma B/2."""
    im = Image.new('L', size, 0)
    ImageDraw.Draw(im).rounded_rectangle(box, radius=radius, fill=round(255 * alpha))
    return im.filter(ImageFilter.GaussianBlur(blur * scale / 2)) if blur else im


def over(a, b):
    """Two layers of one colour, one over the other: 1 - (1 - a)(1 - b)."""
    inv = ImageChops.multiply(ImageChops.invert(a), ImageChops.invert(b))
    return ImageChops.invert(inv)


def geometry(w, h, scale):
    s = scale
    size = ((w + 2 * MARGIN) * s, (h + 2 * MARGIN) * s)
    x0, y0 = MARGIN * s, MARGIN * s
    return size, x0, y0, x0 + w * s - 1, y0 + h * s - 1


def shadow(w, h, radius, scale):
    """The four shadow layers, as the alpha of black - under the pane too."""
    s = scale
    size, x0, y0, x1, y1 = geometry(w, h, s)
    r = radius * s
    soft = layer(size, (x0, y0 + 14 * s, x1, y1 + 14 * s), r, 0.34, 34, s)
    near = layer(size, (x0, y0 + 3 * s, x1, y1 + 3 * s), r, 0.22, 8, s)
    tight = layer(size, (x0, y0 + 1 * s, x1, y1 + 1 * s), r, 0.22, 2, s)
    # half a dp: one pixel at @2x; at @1x one pixel at half the strength
    line = layer(size, (x0 - 1, y0 - 1, x1 + 1, y1 + 1), r + 1, 0.30 if s >= 2 else 0.15, 0, s)
    return over(over(over(soft, near), tight), line)


def outside(w, h, radius, scale):
    """255 outside the pane's box, 0 inside, the share of a pixel on the curve of a corner.

    Drawn 4x and scaled down with BOX: the picture lies over its pane, so along
    the straight sides the cut must fall exactly between two pixels (LANCZOS
    left 4 % of the shadow on the first row inside, on the rim's hairline).
    """
    size, x0, y0, x1, y1 = geometry(w, h, scale)
    big = Image.new('L', (size[0] * 4, size[1] * 4), 255)
    ImageDraw.Draw(big).rounded_rectangle(
        (x0 * 4, y0 * 4, (x1 + 1) * 4 - 1, (y1 + 1) * 4 - 1), radius=radius * scale * 4, fill=0)
    return big.resize(size, Image.BOX)


def inside(w, h, radius, scale, inset=0):
    """255 inside the pane's box drawn in by `inset` dp, 0 outside - the same cut as outside()."""
    size, x0, y0, x1, y1 = geometry(w, h, scale)
    i = inset * scale
    big = Image.new('L', (size[0] * 4, size[1] * 4), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        ((x0 + i) * 4, (y0 + i) * 4, (x1 + 1 - i) * 4 - 1, (y1 + 1 - i) * 4 - 1),
        radius=max(0, radius - inset) * scale * 4, fill=255)
    return big.resize(size, Image.BOX)


def rim(w, h, radius, scale, lines):
    """The rim: a 1 dp line just inside the pane's edge, as the alpha of white.

    Its strength is the top line's along the top, the foot line's along the
    foot, the side line's down the sides; round a corner it goes from one to
    the other by how far the curve has turned (the square of the slope's sine),
    where a border would switch at 45 degrees.
    """
    s = scale
    size, x0, y0, x1, y1 = geometry(w, h, s)
    ring = ImageChops.subtract(inside(w, h, radius, s), inside(w, h, radius, s, 1))
    r = radius * s
    cov = ring.load()
    pane = inside(w, h, radius, s).load()
    out = Image.new('L', size, 0)
    px = out.load()
    for y in range(y0, y1 + 1):
        top_half = (y - y0) < (y1 - y)
        edge = lines['top'] if top_half else lines['foot']
        dy_in = (y - y0 + 0.5) if top_half else (y1 - y + 0.5)  # from the nearer of top and foot
        for x in range(x0, x1 + 1):
            c = cov[x, y]
            if not c:
                continue
            dx_in = min(x - x0, x1 - x) + 0.5
            if dx_in < r and dy_in < r:
                # in a corner: the centre of its arc is r in from both edges
                ax, ay = r - dx_in, r - dy_in
                t = ay * ay / (ax * ax + ay * ay)
                strength = lines['side'] + (edge - lines['side']) * t
            elif dy_in < r:
                strength = edge
            else:
                strength = lines['side']
            # as a share of the pane's own cover of this pixel: edge() cuts
            # every light to the pane's corners in one place
            px[x, y] = round(255 * strength * min(1.0, c / pane[x, y]))
    return out


def light(w, h, scale, bands, sheen=None):
    """The bands of light (and the sheen), as the alpha of white over the pane's whole box (not yet cut to its corners)."""
    s = scale
    size, x0, y0, x1, y1 = geometry(w, h, s)

    def band(px, spec):
        # px: whole pixels from the edge; the gradient's value at the pixel's middle
        if not spec:
            return 0.0
        t = (px + 0.5) / (spec[1] * s)
        return spec[0] * (1 - t) if t < 1 else 0.0

    across = [1 - (1 - band(x - x0, bands['side'])) * (1 - band(x1 - x, bands['side'])) for x in range(x0, x1 + 1)]
    data = bytearray(size[0] * size[1])
    for y in range(y0, y1 + 1):
        down = 1 - (1 - band(y - y0, bands['top'])) * (1 - band(y1 - y, bands['foot']))
        if sheen:
            down = 1 - (1 - down) * (1 - band(y - y0, (sheen[0], sheen[1] * h)))
        row = y * size[0] + x0
        for i, a in enumerate(across):
            data[row + i] = round(255 * (1 - (1 - down) * (1 - a)))
    return Image.frombytes('L', size, bytes(data))


def ground(w, h, radius, scale):
    """The ground under a floating pane's foot, as the alpha of GROUND over the whole picture.

    Whole (255) under the pane's foot and round its foot corners; it starts
    GROUND_RISE[1] radii above the foot and is whole from GROUND_RISE[0] radii
    down (where the page's share of a corner is under a twentieth of the
    radius wide, and under the pane's nearest shadow); beside the pane it
    fades to nothing over GROUND_SIDE dp. edge() uses it outside the pane only.
    """
    s = scale
    size, x0, y0, x1, y1 = geometry(w, h, s)

    def smooth(t):
        t = max(0.0, min(1.0, t))
        return t * t * (3 - 2 * t)

    foot = y1 + 1
    whole, none = foot - GROUND_RISE[0] * radius * s, foot - GROUND_RISE[1] * radius * s
    across = []
    for x in range(size[0]):
        beside = (x0 - x - 0.5) if x < x0 else (x + 0.5 - x1 - 1) if x > x1 else 0.0
        across.append(smooth(1 - beside / (GROUND_SIDE * s)))
    data = bytearray(size[0] * size[1])
    for y in range(size[1]):
        down = smooth((y + 0.5 - none) / (whole - none))
        if down <= 0:
            continue
        row = y * size[0]
        for x, a in enumerate(across):
            data[row + x] = round(255 * down * a)
    return Image.frombytes('L', size, bytes(data))


def edge(w, h, radius, scale, bands, lines=None, sheen=None, floats=False):
    """The whole picture: black shadow outside the pane, white light inside it.

    `floats`: the pane floats over the page above the screen's foot - the
    picture holds the ground under its foot as well (ground()).
    """
    out = outside(w, h, radius, scale)
    dark = shadow(w, h, radius, scale)
    lit = light(w, h, scale, bands, sheen)
    if lines:
        lit = over(lit, rim(w, h, radius, scale, lines))
    under = ground(w, h, radius, scale) if floats else Image.new('L', out.size, 0)
    data = bytearray()
    for o, sh, li, gr in zip(out.getdata(), dark.getdata(), lit.getdata(), under.getdata()):
        if o == 0:      # inside the pane: the light, white
            data += bytes((255, 255, 255, li))
            continue
        # Outside it: the shadow, black, and over that the ground. Together
        # they hide a share `a` of the page and add `g * GROUND` of colour.
        s, g = sh / 255, gr / 255
        a = 1 - (1 - s) * (1 - g)
        if o == 255:
            if a <= 0:
                data += bytes((0, 0, 0, 0))
            else:
                data += bytes(round(k * g / a) for k in GROUND)
                data.append(round(255 * a))
        else:
            # On the curve of a corner the pane covers a share c of the pixel
            # and the picture lies over pane and page alike. The page there
            # must get the whole shadow and ground (alpha = theirs), and the
            # colour is what then leaves the pane's share as lit body and the
            # page's share with the ground's colour: solved for the pane's
            # known body. (Cutting each by its share instead let a bright page
            # show through the corner pixels by a third more.)
            c, l = 1 - o / 255, li / 255
            if a <= 0:
                data += bytes((255, 255, 255, round(255 * l * c)))
            else:
                data += bytes(
                    max(0, min(255, round((c * (b * (a - l) + 255 * l) + (1 - c) * g * k) / a)))
                    for b, k in zip(BODY, GROUND))
                data.append(round(255 * a))
    return Image.frombytes('RGBA', out.size, bytes(data))


def save(im, name, scale):
    path = os.path.join(OUT, name + ('' if scale == 1 else '@%dx' % scale) + '.png')
    im.save(path, optimize=True)
    print(os.path.normpath(path), im.size, os.path.getsize(path), 'bytes')


def bake_slices(scale):
    s = scale
    w = h = 320  # big enough that the middle of every side is a straight run
    im = None
    for radius in SLICE_RADII:
        im = edge(w, h, radius, s, LIGHT_MENU)
        save(im.crop((0, 0, (MARGIN + C) * s, (MARGIN + C_TOP) * s)), 'glass-edge-r%d-top' % radius, s)
        if radius != 24:  # a sheet on the screen's foot has no foot corners
            save(im.crop((0, (MARGIN + h - C) * s, (MARGIN + C) * s, (h + 2 * MARGIN) * s)), 'glass-edge-r%d-foot' % radius, s)
    # the runs are the same whatever the corner
    mx, my = (MARGIN + w // 2) * s, (MARGIN + h // 2) * s
    save(im.crop((mx, 0, mx + RUN * s, (MARGIN + G) * s)), 'glass-edge-run-top', s)
    save(im.crop((mx, (MARGIN + h - G) * s, mx + RUN * s, (h + 2 * MARGIN) * s)), 'glass-edge-run-foot', s)
    save(im.crop((0, my, (MARGIN + G) * s, my + RUN * s)), 'glass-edge-run-side', s)


if __name__ == '__main__':
    for name, w, h, radius in PANES:
        for scale in (1, 2):
            save(edge(w, h, radius, scale, LIGHT_CHROME, RIM_CHROME, SHEEN, floats=True), name, scale)
    for scale in (1, 2):
        bake_slices(scale)
