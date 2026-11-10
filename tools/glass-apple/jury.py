# Builds the blind jury kit from shoot.js's pairs.
#
#   python tools/glass-apple/jury.py <shots dir> <jury dir> [reference dir] [private dir]
#
# Per scene: scene-NN-A.png / scene-NN-B.png (which look is A is drawn at
# random per scene and written to key.json — an existing key.json is kept, so
# a re-shoot does not reshuffle), scene-NN-A-crop.png / -B-crop.png (the glass
# parts at twice their size on the page, stacked), and scenes.md (what each
# scene is and what to look at — never which side is which).
# Every PNG is at most 600 KB: both sides of a scene are shrunk by the SAME
# factor until both fit.
import sys, os, json, glob, io, secrets, shutil
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
shots, out = sys.argv[1], sys.argv[2]
ref = sys.argv[3] if len(sys.argv) > 3 else None
os.makedirs(out, exist_ok=True)
LIMIT = 600 * 1024
SCALES = [1.0, 0.9, 0.8, 0.72, 0.66, 0.6, 0.55, 0.5, 0.45, 0.4, 0.36, 0.33, 0.3, 0.27, 0.25]

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
    # the largest common scale at which every picture is under the limit. A
    # quick, loose encode finds where to start (the careful one is slow on a
    # phone's 3x photograph); the careful one decides.
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
    # each part cut from the full-size photograph and brought to 2x page size
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
key = {}
if os.path.exists(keyf):
    key = json.load(open(keyf, encoding="utf-8")).get("scenes", {})

DEVICE = {"phone": "Phone, 402 × 874", "tablet": "Tablet, 1024 × 768", "desktop": "Desktop, 1440 × 900", "desktop-2560": "Desktop, 2560 × 1440"}
md = ["# The scenes", "",
      "Each scene is one moment of the website photographed twice — the same data, the same scroll position, the sky and every animation held still — once with each of two looks for the glass. `scene-NN-A.png` and `scene-NN-B.png` are the whole screen; `scene-NN-A-crop.png` and `scene-NN-B-crop.png` are the glass parts of the same two photographs at twice their size on the page, stacked in the order listed. Which look is A changes from scene to scene.", "",
      "`reference-1-…` and `reference-2-…` are frames of Apple's own glass on an iPhone (the Apple TV app's tab bar, at rest and under a finger), for the comparison “which of the two is closer to this, and on which do the words read better”. Three more frames (WhatsApp's tab bar over a list of chats: `reference-3.jpg`, `-4`, `-5`) show private names and faces, so they are NOT in the repository; on the PC the photographs were made on they are in the agent's scratch folder, `aurora-agents/glass-apple/jury-private/`.", ""]
n_ok = 0
for jf in sorted(glob.glob(os.path.join(shots, "scene-*.json"))):
    j = json.load(open(jf, encoding="utf-8"))
    nn = "%02d" % j["n"]
    fb, fa = os.path.join(shots, "scene-%s.before.png" % nn), os.path.join(shots, "scene-%s.after.png" % nn)
    if not (os.path.exists(fb) and os.path.exists(fa)):
        print("scene", nn, "is missing a side")
        continue
    if nn not in key:
        key[nn] = {"A": "before", "B": "after"} if secrets.randbits(1) else {"A": "after", "B": "before"}
    side_of = {v: k for k, v in key[nn].items()}  # before -> A or B
    ib, ia = Image.open(fb).convert("RGB"), Image.open(fa).convert("RGB")
    s, (pb, pa) = fit([ib, ia])
    open(os.path.join(out, "scene-%s-%s.png" % (nn, side_of["before"])), "wb").write(pb)
    open(os.path.join(out, "scene-%s-%s.png" % (nn, side_of["after"])), "wb").write(pa)
    # the same parts on both sides (the layout is the same; the "after" rects are used)
    rects = j["crops"].get("after") or j["crops"].get("before") or []
    cb, ca = strip(ib, rects, j["dpr"]), strip(ia, rects, j["dpr"])
    cs = None
    if cb is not None:
        cs, (qb, qa) = fit([cb, ca])
        open(os.path.join(out, "scene-%s-%s-crop.png" % (nn, side_of["before"])), "wb").write(qb)
        open(os.path.join(out, "scene-%s-%s-crop.png" % (nn, side_of["after"])), "wb").write(qa)
    md += ["## Scene %s — %s%s" % (nn, j["title"], " (a worst case for reading)" if j.get("worst") else ""), "",
           "%s. %s" % (DEVICE.get(j["size"], j["size"]), j["look"]), ""]
    n_ok += 1
    print("scene", nn, "full x%.2f" % s, len(pb) // 1024, len(pa) // 1024, "KB; crop", ("x%.2f" % cs) if cs else "-", (len(qb) // 1024, len(qa) // 1024) if cs else "")

json.dump({"note": "which look each letter is, per scene: before = today's glass (origin/master), after = the new material", "scenes": dict(sorted(key.items()))}, open(keyf, "w", encoding="utf-8"), indent=1)
open(os.path.join(out, "scenes.md"), "w", encoding="utf-8", newline="\n").write("\n".join(md) + "\n")

if ref:
    # Apple TV's bar carries nothing private: into the kit. The WhatsApp frames
    # show names and faces: never into the repository — into the private
    # folder (4th argument), if one is given.
    private = sys.argv[4] if len(sys.argv) > 4 else None
    names = [("appletv-bar-rest.jpg", "reference-1-appletv-tab-bar.jpg", out), ("appletv-bar-lens.jpg", "reference-2-appletv-tab-bar-pressed.jpg", out),
             ("rec-16.jpg", "reference-3.jpg", private), ("rec-14.jpg", "reference-4.jpg", private), ("rec-20.jpg", "reference-5.jpg", private)]
    for a, b, where in names:
        p = os.path.join(ref, a)
        if not where:
            continue
        if os.path.exists(p):
            os.makedirs(where, exist_ok=True)
            shutil.copyfile(p, os.path.join(where, b))
        else:
            print("no reference", a)
print(n_ok, "scenes written")
