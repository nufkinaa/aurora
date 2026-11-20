# The phone app's sheets for docs/qa/real-glass/sweep: device photographs
# (tools/real-glass-app/pass.sh on the Pixel 9 emulator), "today" beside the
# glass sweep. Each sheet: the two screens at the device's REAL size (the
# screencap scaled by 1 / 2.625 - one pixel of the sheet is one dp, nothing
# enlarged), then one edge of the changed pane enlarged 3x.
#   python tools/real-glass-app/sweep-sheets.py <today folder> <new folder> <out folder> "<caption>"
# A folder holds <scene>.png and <scene>.txt (dev.py nodes) from pass.sh.
import os
import re
import sys
from PIL import Image, ImageDraw, ImageFont

today, new, out, caption = sys.argv[1:5]
LIMIT = 1_500_000
BG, INK, DIM = (14, 14, 22), (232, 232, 240), (150, 150, 170)
DENSITY = 2.625

# sheet -> (scene, what the enlarged edge is, how to find its box)
#   ('node', label, corner, w, h): a w x h box (device px) around that corner of the node with this label
#   ('box', x0, y0, x1, y1): the same box in both
SHEETS = {
    'app-home.png': ('home', "the hero's Details button, its left end (not part of the sweep: unchanged)", ('node', 'Details', 'bl', 300, 170)),
    'app-episodes.png': ('episodes', "an episode card, its lower left corner", ('node', 'Chapter 1, episode 1', 'bl', 300, 200)),
    'app-search.png': ('search', 'the search field, its left end', ('box', 20, 350, 320, 550)),
    'app-sheet.png': ('sheet', "the note's pane and Cancel, the lower right", ('node', 'Cancel', 'tr', 300, 240)),
    'app-toast.png': ('toast', 'the toast, its left end', ('box', 290, 2020, 590, 2200)),
    'app-calendar.png': ('calendar-month', 'the Next-up pane, its lower left corner, and the chips above', ('node', 'Next up', 'bl', 300, 330)),
    'app-calendar-list.png': ('calendar-list', "a day's card, its lower right corner", ('node', 'Save & watch', 'br', 300, 220)),
    'app-downloads.png': ('downloads', 'a download row, its lower left corner', ('node', 'ON ITS WAY', 'row', 300, 200)),
    'app-chips.png': ('shows', 'the chips, the chosen one (All) first', ('node', 'All', 'tl', 420, 150)),
    'app-more.png': ('more', "the More sheet's top left corner", ('node', 'More', 'tl', 300, 200)),
}


def font(size, bold=False):
    for name in (['segoeuib.ttf', 'arialbd.ttf'] if bold else ['segoeui.ttf', 'arial.ttf']):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def node(folder, scene, label):
    best = None
    for line in open(os.path.join(folder, scene + '.txt'), encoding='utf-8', errors='replace'):
        m = re.match(r'(.*?)\s+\((\d+), (\d+), (\d+), (\d+)\) \d+x\d+ ?(click)?', line)
        if not m:
            continue
        name = m.group(1).replace('&amp;', '&')
        if name == label or (best is None and name.startswith(label)):
            b = tuple(int(x) for x in m.group(2, 3, 4, 5))
            if name == label and m.group(6):
                return b
            best = best if (best and name != label) else b
    if best is None:
        raise SystemExit('no node "%s" in %s/%s.txt' % (label, folder, scene))
    return best


def box(folder, scene, how, size):
    if how[0] == 'box':
        return how[1:]
    _, label, corner, w, h = how
    x0, y0, x1, y1 = node(folder, scene, label)
    if corner == 'row':  # the first row under a heading: its lower left corner
        x, y = 42, y1 + 17 + 262
        corner = 'bl'
    else:
        x, y = (x0 if 'l' in corner else x1), (y0 if 't' in corner else y1)
    pad = 36
    bx = x - pad if 'l' in corner else x + pad - w
    by = y - pad if 't' in corner else y + pad - h
    bx = max(0, min(size[0] - w, bx))
    by = max(0, min(size[1] - h, by))
    return (bx, by, bx + w, by + h)


def build(name, bits):
    scene, what, how = SHEETS[name]
    a = Image.open(os.path.join(today, scene + '.png')).convert('RGB')
    b = Image.open(os.path.join(new, scene + '.png')).convert('RGB')
    real = lambda im: im.resize((round(im.width / DENSITY), round(im.height / DENSITY)), Image.LANCZOS)
    big = lambda im, bx: im.crop(bx).resize(((bx[2] - bx[0]) * 3, (bx[3] - bx[1]) * 3), Image.BICUBIC)
    ra, rb = real(a), real(b)
    ca, cb = big(a, box(today, scene, how, a.size)), big(b, box(new, scene, how, b.size))
    pad, gap, head, foot = 24, 16, 34, 44
    w = pad * 2 + max(ra.width * 2 + gap, ca.width * 2 + gap)
    h = pad + head + ra.height + gap + head + ca.height + foot
    im = Image.new('RGB', (w, h), BG)
    d = ImageDraw.Draw(im)
    f, fb = font(17), font(18, True)
    y = pad
    d.text((pad, y + 4), 'today - real size (1 px = 1 dp)', font=fb, fill=INK)
    d.text((pad + ra.width + gap, y + 4), 'the glass sweep', font=fb, fill=INK)
    im.paste(ra, (pad, y + head))
    im.paste(rb, (pad + ra.width + gap, y + head))
    y += head + ra.height + gap
    d.text((pad, y + 6), '3x: %s - today | the sweep' % what, font=f, fill=DIM)
    im.paste(ca, (pad, y + head))
    im.paste(cb, (pad + ca.width + gap, y + head))
    y += head + ca.height
    d.text((pad, y + 12), caption, font=f, fill=DIM)
    if bits < 8:  # made-up posters are noise and pack badly: fewer colour steps, nothing visible changes
        step = 1 << (8 - bits)
        im = im.point(lambda v: min(255, (v // step) * step + step // 2))
    return im


os.makedirs(out, exist_ok=True)
for name, (scene, _, _) in SHEETS.items():
    if not (os.path.exists(os.path.join(today, scene + '.png')) and os.path.exists(os.path.join(new, scene + '.png'))):
        print('skip', name)
        continue
    path = os.path.join(out, name)
    for bits in (8, 6, 5, 4):
        build(name, bits).save(path, optimize=True)
        if os.path.getsize(path) <= LIMIT:
            break
    print(name, 'bits', bits, os.path.getsize(path))
