#!/usr/bin/env python3
"""Compare two sets of screenshots (shots.js) pixel for pixel.

  python tools/mobile-perf/diff.py out/before/shots out/after/shots [--out out/diff-before-after]
  python tools/mobile-perf/diff.py out/before/shots,out/before2/shots out/after/shots,out/after2/shots

Each side may be several runs of the same version, comma-separated. A file
then counts as identical when ANY run of one side equals ANY run of the
other - a rendering both versions can produce is the same rendering - and
the closest pair is the one reported. (Even software rasterisation leaves a
handful of screenshots with a few corner pixels that fall one of two ways.)

For every PNG present in both sets:

  exact      pixels whose RGB differs at all
  visible    pixels where any channel differs by more than 8/255 - above the
             level of anti-aliasing and compositor rounding
  max        the largest single-channel difference anywhere

A file with exact == 0 is identical. Anything else gets a picture written
beside the report: the two shots and the differing pixels in red, cropped to
the region that differs, to be LOOKED at - the numbers alone do not say
whether a difference matters. Prints a table, writes report.json, and exits 1
when any file differs (0 when every pair is identical).
"""
import json, os, sys
from PIL import Image, ImageChops

def files(root):
    out = {}
    for d, _, names in os.walk(root):
        for n in names:
            if n.endswith(".png"):
                p = os.path.join(d, n)
                out[os.path.relpath(p, root).replace("\\", "/")] = p
    return out

def compare(a_path, b_path, out_dir, rel):
    a = Image.open(a_path).convert("RGB")
    b = Image.open(b_path).convert("RGB")
    if a.size != b.size:
        return {"file": rel, "sizes": [a.size, b.size], "exact": -1, "visible": -1, "max": 255}
    d = ImageChops.difference(a, b)
    box = d.getbbox()
    if not box:
        return {"file": rel, "exact": 0, "visible": 0, "max": 0}
    # per-pixel largest channel difference
    r, g, bl = d.split()
    m = ImageChops.lighter(ImageChops.lighter(r, g), bl)
    hist = m.histogram()
    exact = sum(hist[1:])
    visible = sum(hist[9:])
    mx = max(i for i, c in enumerate(hist) if c)
    res = {"file": rel, "exact": exact, "visible": visible, "max": mx, "box": box, "pixels": a.size[0] * a.size[1]}
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        pad = 40
        x0, y0 = max(0, box[0] - pad), max(0, box[1] - pad)
        x1, y1 = min(a.size[0], box[2] + pad), min(a.size[1], box[3] + pad)
        ca, cb = a.crop((x0, y0, x1, y1)), b.crop((x0, y0, x1, y1))
        mask = m.crop((x0, y0, x1, y1)).point(lambda v: 255 if v > 0 else 0)
        marked = cb.copy()
        marked.paste((255, 0, 60), mask=mask)
        w, h = ca.size
        sheet = Image.new("RGB", (w * 3 + 20, h), (20, 20, 20))
        sheet.paste(ca, (0, 0)); sheet.paste(cb, (w + 10, 0)); sheet.paste(marked, (w * 2 + 20, 0))
        name = rel.replace("/", "__")
        sheet.save(os.path.join(out_dir, name))
        res["sheet"] = name
    return res

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out_dir = None
    if "--out" in sys.argv:
        out_dir = sys.argv[sys.argv.index("--out") + 1]
        args = [a for a in args if a != out_dir]
    a_roots, b_roots = args[0].split(","), args[1].split(",")
    fas, fbs = [files(r) for r in a_roots], [files(r) for r in b_roots]
    in_a = set().union(*[set(f) for f in fas])
    in_b = set().union(*[set(f) for f in fbs])
    both = sorted(in_a & in_b)
    only = sorted(in_a ^ in_b)
    results = []
    for k in both:
        best = None
        for fa in fas:
            for fb in fbs:
                if k not in fa or k not in fb:
                    continue
                r = compare(fa[k], fb[k], None, k)
                if best is None or (r["exact"] if r["exact"] >= 0 else 1e12) < (best[0]["exact"] if best[0]["exact"] >= 0 else 1e12):
                    best = (r, fa[k], fb[k])
                if r["exact"] == 0:
                    break
            if best and best[0]["exact"] == 0:
                break
        r = best[0]
        if r["exact"] != 0 and out_dir:
            r = compare(best[1], best[2], out_dir, k)
        results.append(r)
    differing = [r for r in results if r["exact"] != 0]
    for r in differing:
        print(f"  {r['file']:<60} exact {r['exact']:>8}  visible {r['visible']:>8}  max {r['max']:>3}  box {r.get('box')}")
    print()
    print(f"{len(both)} pairs compared: {len(both) - len(differing)} identical, {len(differing)} differ"
          + (f" ({sum(1 for r in differing if r['visible'] > 0)} above the anti-aliasing threshold)" if differing else "")
          + (f"; {len(only)} present in one side only" if only else ""))
    report = {"a": a_roots, "b": b_roots, "pairs": len(both), "identical": len(both) - len(differing), "differing": differing, "onlyInOne": only}
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        json.dump(report, open(os.path.join(out_dir, "report.json"), "w"), indent=1)
    sys.exit(1 if differing or only else 0)

main()
