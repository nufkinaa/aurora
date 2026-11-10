# Turns contrast.js's photographs into contrast ratios.
#
#   python tools/glass-apple/contrast.py <outdir> [contrast.md]
#
# For each word: the pixels behind it (the surface photographed with its
# words taken off), the colour the word is drawn in (with its own alpha laid
# over each pixel), and the WCAG 2 contrast ratio of the two. "worst" is the
# 1st percentile of the ratios behind that word — the dimmest place a letter
# can land, e.g. on the ghost of a white letter passing under the glass.
import sys, os, json, glob
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
out = sys.argv[1]
md = sys.argv[2] if len(sys.argv) > 2 else None

def lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def lum(rgb):
    l = lin(rgb.astype(np.float64))
    return 0.2126 * l[..., 0] + 0.7152 * l[..., 1] + 0.0722 * l[..., 2]

def ratios(bg, color):
    r, g, b, a = color
    fg = np.empty_like(bg, dtype=np.float64)
    for i, v in enumerate((r, g, b)):
        fg[..., i] = a * v + (1 - a) * bg[..., i]
    L1, L2 = lum(fg), lum(bg)
    hi, lo = np.maximum(L1, L2), np.minimum(L1, L2)
    return (hi + 0.05) / (lo + 0.05)

def group(l):
    # by the part a word plays, not by its colour (today's nav turns its
    # words dark over a bright picture: the same words, another ink)
    r, g, b, a = l["color"]
    bright = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    if l.get("on"):
        return "chosen"
    if l["kind"] == "icon":
        return "icons"
    # a word drawn well below white is a "quiet" one (a sub-line, a hint)
    if bright >= 0.35 and bright * a < 0.8:
        return "quiet words"
    return "words"

# A word keeps the part it played BEFORE: the new sheet lifts some greys, and
# a grey that became lighter is still the same sub-line.
part = {}
def tag(j, l):
    return (j["id"], j["kind"], l["kind"], l["text"], round(l["rect"][0] / 6), round(l["rect"][1] / 6))

res = {}
for side in ("before", "after"):
    for jf in sorted(glob.glob(os.path.join(out, side, "*.json"))):
        j = json.load(open(jf, encoding="utf-8"))
        im = np.asarray(Image.open(jf[:-5] + ".bare.png").convert("RGB"))
        d, cx, cy = j["dpr"], j["clip"]["x"], j["clip"]["y"]
        for l in j["labels"]:
            x, y, w, h = l["rect"]
            x0, y0 = int(round((x - cx) * d)), int(round((y - cy) * d))
            x1, y1 = int(round((x + w - cx) * d)), int(round((y + h - cy) * d))
            x0, y0 = max(0, x0), max(0, y0)
            x1, y1 = min(im.shape[1], x1), min(im.shape[0], y1)
            if x1 - x0 < 2 or y1 - y0 < 2:
                continue
            rr = ratios(im[y0:y1, x0:x1], l["color"])
            worst = float(np.percentile(rr, 1))
            med = float(np.median(rr))
            g = group(l)
            if side == "before":
                part[tag(j, l)] = g
            else:
                g = part.get(tag(j, l), g)
            key = (j["id"], j["name"], g, j["kind"])
            e = res.setdefault(key, {})
            s = e.setdefault(side, {"worst": 99, "med": 99, "text": "", "n": 0})
            s["n"] += 1
            if worst < s["worst"]:
                s["worst"], s["med"], s["text"] = worst, med, l["text"]

KIND = {"white": "white poster", "poster": "bright poster", "mid": "mid grey", "text": "white text under", "skybright": "bright sky band", "black": "black", "sky": "the sky", "art": "white picture"}
ORDER = ["white", "poster", "mid", "text", "skybright", "sky", "art", "black"]
GORDER = ["words", "chosen", "icons", "quiet words"]
rows = sorted(res.items(), key=lambda kv: (kv[0][0], GORDER.index(kv[0][2]), ORDER.index(kv[0][3])))
json.dump([{"id": k[0], "name": k[1], "group": k[2], "kind": k[3], **v} for k, v in rows], open(os.path.join(out, "contrast.json"), "w"), indent=1)

def f(v):
    return "–" if v is None else ("%.1f" % v)

lines = []
cur = None
fails_b = fails_a = n = 0
for (tid, name, grp, kind), v in rows:
    if name != cur:
        cur = name
        lines += ["", "### " + name, "", "| what | behind it | before | after |", "|---|---|---:|---:|"]
    bv = v.get("before", {}).get("worst")
    av = v.get("after", {}).get("worst")
    if grp != "dark words":
        n += 1
        if bv is not None and bv < 4.5: fails_b += 1
        if av is not None and av < 4.5: fails_a += 1
    mark = lambda x: "" if x is None or x >= 4.5 or grp == "dark words" else " ✗"
    lines.append("| %s | %s | %s%s | %s%s |" % (grp, KIND.get(kind, kind), f(bv), mark(bv), f(av), mark(av)))
head = "%d measured cells; under 4.5:1 — before: %d, after: %d" % (n, fails_b, fails_a)
print(head)
body = "\n".join(lines)
if md:
    open(md, "w", encoding="utf-8").write(body + "\n")
else:
    print(body)
