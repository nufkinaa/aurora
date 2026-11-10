# Turns remote-contrast.js's photographs into contrast ratios, one column per
# look: the worst 1 % and the median of the WCAG ratio behind each word and
# icon on the Remote's panes ("panes") and straight on the film ("film").
#
#   python tools/glass-apple/remote-contrast.py <outdir> <lookname> [<lookname> ...]
import sys, os, json, glob
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8")
out = sys.argv[1]; looks = sys.argv[2:]
def lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
def lum(rgb):
    l = lin(rgb.astype(np.float64)); return 0.2126 * l[..., 0] + 0.7152 * l[..., 1] + 0.0722 * l[..., 2]
def ratios(bg, color):
    r, g, b, a = color
    fg = np.empty_like(bg, dtype=np.float64)
    for i, v in enumerate((r, g, b)): fg[..., i] = a * v + (1 - a) * bg[..., i]
    L1, L2 = lum(fg), lum(bg); hi, lo = np.maximum(L1, L2), np.minimum(L1, L2)
    return (hi + 0.05) / (lo + 0.05)
res = {}
for look in looks:
    for jf in sorted(glob.glob(os.path.join(out, look, "*.json"))):
        j = json.load(open(jf, encoding="utf-8"))
        im = np.asarray(Image.open(jf[:-5] + ".bare.png").convert("RGB")); d = j["dpr"]
        view, art = j["id"].split(".")
        for grp in ("panes", "film"):
            for l in j[grp]:
                x, y, w, h = l["rect"]
                x0, y0, x1, y1 = int(round(x * d)), int(round(y * d)), int(round((x + w) * d)), int(round((y + h) * d))
                x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(im.shape[1], x1), min(im.shape[0], y1)
                if x1 - x0 < 2 or y1 - y0 < 2: continue
                rr = ratios(im[y0:y1, x0:x1], l["color"])
                worst = float(np.percentile(rr, 1)); med = float(np.median(rr))
                name = (l.get("where") or "on the film") + " | " + ("icon" if l["kind"] == "icon" else l["text"])
                key = (art, view, grp, name)
                e = res.setdefault(key, {})
                if look not in e or worst < e[look][0]: e[look] = (worst, med)
for art in ("white", "usual"):
    print("\n==== art:", art, " (worst 1% / median)   ", "   ".join(looks))
    for key in sorted(k for k in res if k[0] == art):
        v = res[key]
        cells = ["%4.1f/%4.1f%s" % (v[l][0], v[l][1], " x" if v[l][0] < 4.5 else "  ") if l in v else "   –      " for l in looks]
        print("%-12s %-5s %-58s %s" % (key[1], key[2], key[3][:58], "  ".join(cells)))
    for l in looks:
        p = [v[l][0] for k, v in res.items() if k[0] == art and k[2] == "panes" and l in v]
        print("  ", l, "on panes: min %.2f, under 4.5: %d of %d" % (min(p), sum(1 for x in p if x < 4.5), len(p)))
