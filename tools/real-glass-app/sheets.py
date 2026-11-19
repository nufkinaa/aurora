# The phone app's sheets for docs/qa/real-glass/final3: device photographs
# (adb screencap on the Pixel 9 emulator), "today" (origin/master) beside real
# glass, each reduced; then every glass surface of the screen at the device's
# REAL size (the screencap scaled by 1 / 2.625: one pixel of the sheet is one
# dp, nothing enlarged), today beside real glass; then one edge enlarged 3x.
#   python tools/real-glass-app/sheets.py <folder with ms-*.png and rg-*.png> <out folder> "<caption>"
# ms-<scene>.png = today, rg-<scene>.png = real glass; scenes: home sky title sheet player.
import os
import sys
from PIL import Image, ImageDraw, ImageFont

src, out, caption = sys.argv[1], sys.argv[2], sys.argv[3]
LIMIT = 1_500_000
BG = (14, 14, 22)
INK = (232, 232, 240)
DIM = (150, 150, 170)

# scene -> (file name, what the enlarged edge is, its box in device pixels)
SCENES = {
    'home': ('app-home.png', 'the tab bar, its left end', (30, 2222, 250, 2378)),
    'sky': ('app-sky.png', 'the tab bar over the sky, its right end', (840, 2222, 1060, 2378)),
    'title': ('app-title.png', 'an action circle', (30, 1500, 250, 1656)),
    'sheet': ('app-sheet.png', "the sheet's Cancel (unchanged)", (750, 2175, 1050, 2331)),
    'player': ('app-player.png', 'the big button', (1050, 410, 1370, 680)),
}
# scene -> the surfaces shown at real size: (what, box in device pixels)
TOP = ('the top buttons', (0, 120, 1080, 290))
TABS = ('the tab bar', (0, 2205, 1080, 2395))
STRIPS = {
    'home': [TOP, ("the hero's Details", (40, 1385, 860, 1565)), TABS],
    'sky': [TOP, TABS],
    'title': [TOP, ('the action circles', (0, 1490, 1080, 1750)), TABS],
    'sheet': [("the sheet's buttons (unchanged)", (0, 2160, 1080, 2345))],
    'player': [('the middle buttons', (860, 380, 1560, 710)), ('the foot row', (0, 800, 2424, 1010))],
}
DENSITY = 2.625  # Pixel 9: device pixels per dp


def font(size, bold=False):
    for name in (['segoeuib.ttf', 'arialbd.ttf'] if bold else ['segoeui.ttf', 'arial.ttf']):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def build(scene, scale):
    name, what, box = SCENES[scene]
    a = Image.open(os.path.join(src, 'ms-%s.png' % scene)).convert('RGB')
    b = Image.open(os.path.join(src, 'rg-%s.png' % scene)).convert('RGB')
    land = a.width > a.height
    small = lambda im: im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    crop = lambda im: im.crop(box).resize(((box[2] - box[0]) * 3, (box[3] - box[1]) * 3), Image.BICUBIC)
    sa, sb, ca, cb = small(a), small(b), crop(a), crop(b)
    real = lambda im, bx: im.crop(bx).resize((round((bx[2] - bx[0]) / DENSITY), round((bx[3] - bx[1]) / DENSITY)), Image.LANCZOS)
    strips = [(w_, real(a, bx), real(b, bx)) for w_, bx in STRIPS.get(scene, [])]
    stack = any(ra.width * 2 > 900 for _, ra, _ in strips)  # a very wide strip: today above real glass
    strips_h = sum(26 + (ra.height * 2 + 6 if stack else ra.height) + 10 for _, ra, _ in strips) + (34 if strips else 0)
    strips_w = max([ra.width if stack else ra.width * 2 + 16 for _, ra, _ in strips] or [0])
    pad, gap, head, foot = 24, 16, 34, 44
    if land:  # the player: one above the other, the two enlargements side by side below
        w = max(sa.width, ca.width * 2 + gap, strips_w) + pad * 2
        h = pad + (head + sa.height) * 2 + gap + strips_h + head + ca.height + foot
    else:
        w = pad * 2 + sa.width * 2 + gap
        w = max(w, pad * 2 + ca.width * 2 + gap, pad * 2 + strips_w)
        h = pad + head + sa.height + gap + strips_h + head + ca.height + foot
    im = Image.new('RGB', (w, h), BG)
    d = ImageDraw.Draw(im)
    f, fb = font(17), font(18, True)
    y = pad
    if land:
        for label, s in (('today', sa), ('real glass', sb)):
            d.text((pad, y + 4), label, font=fb, fill=INK)
            im.paste(s, (pad, y + head))
            y += head + s.height
        y += gap
    else:
        x2 = pad + sa.width + gap
        d.text((pad, y + 4), 'today', font=fb, fill=INK)
        d.text((x2, y + 4), 'real glass', font=fb, fill=INK)
        im.paste(sa, (pad, y + head))
        im.paste(sb, (x2, y + head))
        y += head + sa.height + gap
    if strips:
        d.text((pad, y + 6), 'At real size (1 px = 1 dp, nothing enlarged): today | real glass', font=fb, fill=INK)
        y += 34
        for what_, ra, rb in strips:
            d.text((pad, y + 2), what_, font=f, fill=DIM)
            y += 26
            im.paste(ra, (pad, y))
            if stack:
                im.paste(rb, (pad, y + ra.height + 6))
                y += ra.height * 2 + 6 + 10
            else:
                im.paste(rb, (pad + ra.width + 16, y))
                y += ra.height + 10
    d.text((pad, y + 6), '3x: %s — today | real glass' % what, font=f, fill=DIM)
    im.paste(ca, (pad, y + head))
    im.paste(cb, (pad + ca.width + gap, y + head))
    y += head + ca.height
    d.text((pad, y + 12), caption, font=f, fill=DIM)
    return im


os.makedirs(out, exist_ok=True)
for scene, (name, _, _) in SCENES.items():
    if not os.path.exists(os.path.join(src, 'rg-%s.png' % scene)):
        continue
    path = os.path.join(out, name)
    for scale in (0.5, 0.45, 0.4, 0.36, 0.32, 0.28, 0.24):
        build(scene, scale).save(path, optimize=True)
        if os.path.getsize(path) <= LIMIT:
            break
    print(name, scale, os.path.getsize(path))
