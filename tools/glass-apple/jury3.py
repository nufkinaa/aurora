# Builds a blind jury kit with MORE than two looks per scene (jury.py does two).
#
#   python tools/glass-apple/jury3.py <jury dir> <name>=<shots dir>:<side>[@<ref>] ...
#
# Each look is one run of shoot.js: its folder and which side it was shot as
# ("before" = the stylesheets of GA_BEFORE_REF, "after" = the working tree),
# e.g.
#
#   GA_BEFORE_REF=2cd75c12 GA_BEFORE_CSS=<bundle> node tools/glass-apple/shoot.js shots/old before 28,29,30
#   GA_BEFORE_REF=c5f51f78 GA_BEFORE_CSS=<bundle> node tools/glass-apple/shoot.js shots/mid before 28,29,30
#   node tools/glass-apple/shoot.js shots/new after 28,29,30
#   python tools/glass-apple/jury3.py docs/qa/glass-apple/jury3 old=shots/old:before@2cd75c12 mid=shots/mid:before@c5f51f78 new=shots/new:after@6b7a8890
#
# Per scene: scene-NN-A.png, -B.png, -C.png … (which look is which letter is
# drawn at random per scene and written to key.json; an existing key.json is
# kept, so a re-shoot does not reshuffle), scene-NN-A-crop.png … (the glass
# parts at twice their size on the page, stacked), and scenes.md (what each
# scene is and what to look at — never which letter is which).
# Every PNG is at most 600 KB: all looks of a scene are shrunk by the SAME
# factor until all fit.
import sys, os, json, glob, io, random, secrets
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
out = sys.argv[1]
looks = []
for a in sys.argv[2:]:
    name, rest = a.split("=", 1)
    ref = None
    if "@" in rest:
        rest, ref = rest.rsplit("@", 1)
    d, side = rest.rsplit(":", 1)
    looks.append({"name": name, "dir": d, "side": side, "ref": ref})
os.makedirs(out, exist_ok=True)
LIMIT = 600 * 1024
SCALES = [1.0, 0.9, 0.8, 0.72, 0.66, 0.6, 0.55, 0.5, 0.45, 0.4, 0.36, 0.33, 0.3, 0.27, 0.25]
LETTERS = "ABCDEFGH"[:len(looks)]

def png(im, fast=False):
    b = io.BytesIO()
    if fast:
        im.save(b, "PNG", compress_level=1)
    else:
        im.save(b, "PNG", optimize=True)
    return b.getvalue()

def scaled(im, s):
    return im if s == 1.0 else im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)

def fit(ims):
    start = len(SCALES) - 1
    for i, s in enumerate(SCALES):
        if all(len(png(scaled(im, s), fast=True)) <= LIMIT * 1.3 for im in ims):
            start = i
            break
    for s in SCALES[start:]:
        outs = [png(scaled(im, s)) for im in ims]
        if all(len(o) <= LIMIT for o in outs):
            return s, outs
    return s, outs

def strip(im, rects, dpr):
    parts = []
    for x, y, w, h in rects:
        c = im.crop((round(x * dpr), round(y * dpr), round((x + w) * dpr), round((y + h) * dpr)))
        f = 2.0 / dpr
        if abs(f - 1) > 1e-6:
            c = c.resize((max(1, round(c.width * f)), max(1, round(c.height * f))), Image.LANCZOS)
        parts.append(c)
    if not parts:
        return None
    W = max(p.width for p in parts)
    gap = 12
    H = sum(p.height for p in parts) + gap * (len(parts) - 1)
    sheet = Image.new("RGB", (W, H), (24, 24, 26))
    y = 0
    for p in parts:
        sheet.paste(p, (0, y))
        y += p.height + gap
    return sheet

keyf = os.path.join(out, "key.json")
keydoc = json.load(open(keyf, encoding="utf-8")) if os.path.exists(keyf) else {}
key = keydoc.get("scenes", {})
rng = random.Random(secrets.randbits(64))

DEVICE = {"phone": "Phone, 402 × 874", "tablet": "Tablet, 1024 × 768", "desktop": "Desktop, 1440 × 900", "desktop-2560": "Desktop, 2560 × 1440"}
count = {2: "twice", 3: "three times", 4: "four times"}.get(len(looks), "%d times" % len(looks))
names = ", ".join("`scene-NN-%s.png`" % l for l in LETTERS)
crops = ", ".join("`scene-NN-%s-crop.png`" % l for l in LETTERS)
md = ["# The scenes", "",
      "Each scene is one moment of the website photographed %s — the same data, the same position, the sky and every animation held still — once with each of %d looks for the glass. %s are the whole screen; %s are the glass parts of the same photographs at twice their size on the page, stacked in the order listed. Which look carries which letter changes from scene to scene." % (count, len(looks), names, crops), "",
      "The frames of Apple's own glass are the ones in `../jury/` (`reference-1-…`, `reference-2-…`).", ""]
n_ok = 0
first = looks[0]
for jf in sorted(glob.glob(os.path.join(first["dir"], "scene-*.json"))):
    j = json.load(open(jf, encoding="utf-8"))
    nn = "%02d" % j["n"]
    files = [os.path.join(l["dir"], "scene-%s.%s.png" % (nn, l["side"])) for l in looks]
    if not all(os.path.exists(f) for f in files):
        print("scene", nn, "is missing a look")
        continue
    if nn not in key or sorted(key[nn].values()) != sorted(l["name"] for l in looks):
        order = [l["name"] for l in looks]
        rng.shuffle(order)
        key[nn] = dict(zip(LETTERS, order))
    letter_of = {v: k for k, v in key[nn].items()}
    ims = [Image.open(f).convert("RGB") for f in files]
    s, pngs = fit(ims)
    for l, p in zip(looks, pngs):
        open(os.path.join(out, "scene-%s-%s.png" % (nn, letter_of[l["name"]])), "wb").write(p)
    # the same parts on every look (the layout is the same; the last look's rects are used)
    jl = json.load(open(os.path.join(looks[-1]["dir"], "scene-%s.json" % nn), encoding="utf-8"))
    rects = jl["crops"].get(looks[-1]["side"]) or []
    strips = [strip(im, rects, j["dpr"]) for im in ims]
    cs = None
    if strips[0] is not None:
        cs, cps = fit(strips)
        for l, p in zip(looks, cps):
            open(os.path.join(out, "scene-%s-%s-crop.png" % (nn, letter_of[l["name"]])), "wb").write(p)
    md += ["## Scene %s — %s%s" % (nn, j["title"], " (a worst case for reading)" if j.get("worst") else ""), "",
           "%s. %s" % (DEVICE.get(j["size"], j["size"]), j["look"]), ""]
    n_ok += 1
    print("scene", nn, "full x%.2f" % s, [len(p) // 1024 for p in pngs], "KB; crop", ("x%.2f" % cs) if cs else "-")

note = "which look each letter is, per scene; the looks: " + "; ".join("%s = %s" % (l["name"], ("the stylesheets of commit " + l["ref"]) if l["ref"] else l["side"]) for l in looks)
json.dump({**keydoc, "note": note, "scenes": dict(sorted(key.items()))}, open(keyf, "w", encoding="utf-8"), indent=1)
open(os.path.join(out, "scenes.md"), "w", encoding="utf-8", newline="\n").write("\n".join(md) + "\n")
print(n_ok, "scenes written")
