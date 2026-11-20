# White-on-body contrast behind the words of the phone app's glass panes, from
# pass.sh's device photographs: the pane's own colour sampled in the gaps
# between its lines of text (no glyphs there), against white.
#   python tools/real-glass-app/contrast.py <pass folder> [<pass folder> ...]
import os
import re
import sys
from PIL import Image


def nodes(folder, scene):
    out = []
    for line in open(os.path.join(folder, scene + '.txt'), encoding='utf-8', errors='replace'):
        m = re.match(r'(.*?)\s+\((\d+), (\d+), (\d+), (\d+)\) \d+x\d+ ?(click)?', line)
        if m:
            out.append((m.group(1), tuple(int(x) for x in m.group(2, 3, 4, 5)), bool(m.group(6))))
    return out


def find(ns, label, click=None, nth=0):
    hits = [b for name, b, c in ns if name.startswith(label) and (click is None or c == click)]
    return hits[nth] if len(hits) > nth else None


def lum(c):
    f = lambda v: v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (f(v / 255) for v in c)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def sample(im, box):
    px = list(im.crop(box).getdata())
    px.sort(key=lum)
    lightest = px[int(len(px) * 0.95)]  # the hardest spot for white words: the lightest part of the body
    mid = px[len(px) // 2]
    return mid, lightest


def gap(ns, upper, lower, x0, x1):
    a, b = find(ns, upper, click=False), find(ns, lower, click=False)
    if not a or not b or b[1] - a[3] < 3:
        return None
    return (x0, a[3] + 1, x1, b[1] - 1)


# what -> (scene, how to find a text-free box of the pane's body)
SPOTS = {
    'episode card (between its title and summary)': ('episodes', lambda ns: gap(ns, 'Chapter 1', 'A made-up episode summary', 90, 600)),
    'search field (right of the typed text)': ('search', lambda ns: (420, 420, 700, 480)),
    "sheet body (between its lines)": ('sheet', lambda ns: gap(ns, 'Pick who should see it', "There's nobody", 60, 1000)),
    "sheet: the note's pane": ('sheet', lambda ns: (lambda b: b and (b[0] + 500, b[1] + 30, b[2] - 40, b[1] + 70))(find(ns, 'Add a note', click=True))),
    'download row (between title and status)': ('downloads', lambda ns: gap(ns, 'The Golden Tide', 'Finished', 250, 1000)),
    'calendar list card (between title and kind)': ('calendar-list', lambda ns: gap(ns, 'The Ninth Hour', 'New episode', 250, 1000)),
    'calendar Next-up pane': ('calendar-month', lambda ns: gap(ns, 'NEXT UP', 'New episode', 420, 760)),
    'chip (Trending, beside its word)': ('shows', lambda ns: (lambda b: b and (b[0] + 12, b[1] + 35, b[0] + 40, b[3] - 35))(find(ns, 'Trending', click=True))),
    'More sheet (between a row\'s two lines)': ('more', lambda ns: gap(ns, 'Calendar', 'What comes out', 180, 900)),
    # + the full glass (2026-11-20)
    'profile menu (between two items)': ('profile-menu', lambda ns: gap(ns, 'Switch profile', 'Children mode', 520, 980)),
    'Settings pane (between two lines)': ('settings', lambda ns: gap(ns, 'Edit profile &amp; password', 'Name, avatar', 230, 900)),
    'a text field (Edit profile, right of its words)': ('edit-profile', lambda ns: (lambda b: b and (b[0] + 500, b[1] + 25, b[2] - 40, b[3] - 25))(find(ns, 'Glass', click=True))),
}

for folder in sys.argv[1:]:
    print(folder)
    for what, (scene, how) in SPOTS.items():
        if not os.path.exists(os.path.join(folder, scene + '.png')):
            continue
        box = how(nodes(folder, scene))
        if not box:
            print('  %-46s (not found)' % what)
            continue
        mid, light = sample(Image.open(os.path.join(folder, scene + '.png')).convert('RGB'), box)
        cr = lambda c: 1.05 / (lum(c) + 0.05)
        print('  %-46s body %-15s white %.1f:1   lightest 5%% %-15s white %.1f:1' % (what, mid, cr(mid), light, cr(light)))
