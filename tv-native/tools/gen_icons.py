"""Generate Aurora's launcher icons and the Android TV banner.

Run from tv-native/:  python tools/gen_icons.py

One source for the brand mark, so the launcher icon, the in-app nav logo and the
TV banner can never drift apart. The mark is the site's:

    .logo-mark { border-radius: 8px;
                 background: conic-gradient(from 210deg,
                     #6c58ff, #b76cff, #4ea3ff, #6c58ff); }

Two separate things get an icon on Android TV, which is easy to miss:

  * android:icon  -> mipmap-*/ic_launcher.png, square, used in Settings and the
    app list.
  * android:banner -> drawable/banner.png, 320x180, and this is what the TV HOME
    ROW actually shows. An app with a correct launcher icon and no banner still
    looks unbranded exactly where the viewer looks first.

Pillow is used rather than hand-rolled PNG writing because the banner needs real
text. tools/gen-gradients.js stays in Node — the scrims are pure maths.
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

RES = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res')
ASSETS = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets')

BG = (11, 12, 20)  # colors.bg
# The conic-gradient stops, as (turn fraction, rgb).
STOPS = [
    (0.00, (0x6C, 0x58, 0xFF)),
    (0.33, (0xB7, 0x6C, 0xFF)),
    (0.66, (0x4E, 0xA3, 0xFF)),
    (1.00, (0x6C, 0x58, 0xFF)),
]
START_DEG = 210  # `from 210deg`


def _lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def _conic_color(frac):
    """Colour at `frac` of a turn, matching CSS conic-gradient interpolation."""
    for i in range(1, len(STOPS)):
        p1, c1 = STOPS[i]
        if frac <= p1:
            p0, c0 = STOPS[i - 1]
            return _lerp(c0, c1, (frac - p0) / (p1 - p0) if p1 > p0 else 0)
    return STOPS[-1][1]


def mark(size, radius_ratio=8 / 26, supersample=4):
    """The rounded-square brand mark, as an RGBA image of `size`x`size`.

    Rendered at `supersample`x and downscaled: the corner radius and the colour
    wheel's centre both alias badly at icon sizes otherwise.
    """
    s = size * supersample
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    px = img.load()
    cx = cy = (s - 1) / 2
    for y in range(s):
        for x in range(s):
            # CSS angles run clockwise from 12 o'clock; atan2 runs
            # counter-clockwise from 3 o'clock.
            deg = (90 - math.degrees(math.atan2(cy - y, x - cx)) - START_DEG) % 360
            px[x, y] = _conic_color(deg / 360) + (255,)

    m = Image.new('L', (s, s), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        (0, 0, s - 1, s - 1), radius=round(s * radius_ratio), fill=255
    )
    img.putalpha(m)
    return img.resize((size, size), Image.LANCZOS)


def glow(layer, blur, strength=1.0):
    """The mark's `box-shadow: 0 0 18px rgba(124,100,255,.55)`."""
    g = layer.filter(ImageFilter.GaussianBlur(blur))
    if strength != 1.0:
        a = g.getchannel('A').point(lambda v: round(v * strength))
        g.putalpha(a)
    return g


def font(size):
    """A bold sans that exists on this machine; Aurora's UI is heavy-weight."""
    for name in ('segoeuib.ttf', 'arialbd.ttf', 'seguisb.ttf'):
        path = os.path.join('C:\\', 'Windows', 'Fonts', name)
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    raise SystemExit('No bold system font found; install one or edit font().')


# ---------------------------------------------------------------- launcher icon
# Full-bleed: Android already masks and shadows adaptive icons, so a mark drawn
# inset here would look small and doubly rounded on the TV's own rounded tile.
for folder, size in (
    ('mipmap-mdpi', 48),
    ('mipmap-hdpi', 72),
    ('mipmap-xhdpi', 96),
    ('mipmap-xxhdpi', 144),
    ('mipmap-xxxhdpi', 192),
):
    out = os.path.join(RES, folder)
    os.makedirs(out, exist_ok=True)
    icon = mark(size)
    # The same "A" the adaptive foreground carries, so a pre-26 launcher and a
    # modern one show the same logo rather than two different marks.
    d = ImageDraw.Draw(icon)
    f = font(round(size * 0.56))
    bb = d.textbbox((0, 0), 'A', font=f)
    d.text(
        ((size - (bb[2] - bb[0])) / 2 - bb[0], (size - (bb[3] - bb[1])) / 2 - bb[1]),
        'A',
        font=f,
        fill=(255, 255, 255, 255),
    )
    icon.save(os.path.join(out, 'ic_launcher.png'))
    # roundIcon: same mark under a circular mask.
    circ = Image.new('L', (size, size), 0)
    ImageDraw.Draw(circ).ellipse((0, 0, size - 1, size - 1), fill=255)
    rnd = icon.copy()
    rnd.putalpha(circ)
    rnd.save(os.path.join(out, 'ic_launcher_round.png'))
    print('icon', folder, f'{size}x{size}')

# ------------------------------------------------------- adaptive launcher icon
# This is what was actually missing. The app targets API 36, and on API 26+ a
# launcher shrinks a LEGACY icon onto a background it generates itself (usually
# white) — so the Aurora mark showed up as a small square inside a pale blob,
# which reads as "no logo at all".
#
# An adaptive icon fixes it: the mark becomes the full-bleed BACKGROUND layer and
# the launcher's mask decides the shape (circle on Google TV, squircle elsewhere).
# The gradient is the BACKGROUND layer, full-bleed, so the launcher's mask decides
# the shape and there is no inset artwork to crop.
#
# The FOREGROUND carries an "A". That is the part that was missing: a bare
# gradient background with a transparent foreground is a colour swatch, not a
# logo — masked to a circle on Google TV it has no mark in it at all, which is
# why the app still looked unbranded after the banner was fixed. On the site the
# gradient square is always next to the word "Aurora"; a launcher tile has no
# such companion, so the letter has to carry it.
#
# Content sits inside the adaptive-icon SAFE ZONE: of the 108dp layer only the
# middle 72dp is guaranteed visible, and only a 66dp circle is safe from every
# mask. The glyph is sized against that, not against the full canvas.
for folder, size in (
    ('mipmap-mdpi', 108),
    ('mipmap-hdpi', 162),
    ('mipmap-xhdpi', 216),
    ('mipmap-xxhdpi', 324),
    ('mipmap-xxxhdpi', 432),
):
    out = os.path.join(RES, folder)
    os.makedirs(out, exist_ok=True)
    # radius_ratio 0: square, because the MASK does the rounding. Rounding here
    # too would show a rounded square peeking inside a circle.
    mark(size, radius_ratio=0).save(os.path.join(out, 'ic_launcher_background.png'))

    fg = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(fg)
    # ~46% of the layer: comfortably inside the 66/108 safe circle even after a
    # mask crops the corners.
    f = font(round(size * 0.46))
    bb = d.textbbox((0, 0), 'A', font=f)
    d.text(
        ((size - (bb[2] - bb[0])) / 2 - bb[0], (size - (bb[3] - bb[1])) / 2 - bb[1]),
        'A',
        font=f,
        fill=(255, 255, 255, 255),
    )
    fg.save(os.path.join(out, 'ic_launcher_foreground.png'))
    print('adaptive bg+fg', folder, f'{size}x{size}')

# No <monochrome>. It is only used when the viewer turns on themed icons, and
# there it REPLACES the artwork with a single-colour stencil of this layer — so
# Aurora's tile would become a flat "A" with the gradient thrown away. The
# gradient IS the brand (it is the site's .logo-mark), so the icon opts out and
# keeps its colours in every launcher mode.
ADAPTIVE = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""
anydpi = os.path.join(RES, 'mipmap-anydpi-v26')
os.makedirs(anydpi, exist_ok=True)
for name in ('ic_launcher.xml', 'ic_launcher_round.xml'):
    with open(os.path.join(anydpi, name), 'w', encoding='utf-8') as fh:
        fh.write(ADAPTIVE)
print('adaptive-icon xml x2')

# ------------------------------------------------------------- in-app nav logo
# Same mark, so the header in the app is the same brand as the launcher tile.
#
# Full-bleed and WITHOUT the glow, unlike the banner. The nav renders this at
# 34dp: transparent margin for a glow would shrink the visible mark by ~15% for a
# halo far too small to register at that size, and the glow was invisible while
# the shrinkage was not.
os.makedirs(ASSETS, exist_ok=True)
mark(96).save(os.path.join(ASSETS, 'logo.png'))
print('nav logo 96x96')

# ------------------------------------------------------------------- TV banner
# 320x180 is the size the leanback launcher asks for.
W, H = 320, 180
banner = Image.new('RGBA', (W, H), BG + (255,))

# A soft violet wash bottom-left, so the plate isn't a flat rectangle.
wash = Image.new('RGBA', (W, H), (0, 0, 0, 0))
wd = ImageDraw.Draw(wash)
wd.ellipse((-120, 40, 190, 300), fill=(0x6C, 0x58, 0xFF, 70))
banner.alpha_composite(wash.filter(ImageFilter.GaussianBlur(38)))

MARK = 52
mx, my = 26, (H - MARK) // 2
m = mark(MARK)
banner.alpha_composite(glow(m, 12, 0.6), (mx, my))
banner.alpha_composite(m, (mx, my))

# Stack the wordmark and tagline by MEASURING them. Hardcoded baselines had the
# 40px wordmark's descent running into the tagline, because a font's drawn box is
# taller than its nominal size.
d = ImageDraw.Draw(banner)
word_f, tag_f = font(40), font(15)
WORD, TAG, GAP = 'Aurora', 'personal streaming', 6
wb = d.textbbox((0, 0), WORD, font=word_f)
tb = d.textbbox((0, 0), TAG, font=tag_f)
block_h = (wb[3] - wb[1]) + GAP + (tb[3] - tb[1])
tx = mx + MARK + 18
top = (H - block_h) // 2
# textbbox offsets are relative to the anchor, so subtract them to place the
# glyphs' visible top edge exactly where we want it.
d.text((tx - wb[0], top - wb[1]), WORD, font=word_f, fill=(0xF3, 0xF4, 0xF8, 255))
d.text(
    (tx - tb[0] + 2, top + (wb[3] - wb[1]) + GAP - tb[1]),
    TAG,
    font=tag_f,
    fill=(0x9A, 0xA1, 0xB5, 255),
)

out = os.path.join(RES, 'drawable')
os.makedirs(out, exist_ok=True)
banner.convert('RGB').save(os.path.join(out, 'banner.png'))
print(f'banner {W}x{H}')
