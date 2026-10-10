#!/usr/bin/env python3
"""Exact A/B comparison of the captures of a run.py output directory (or of two PNGs):
how many pixels differ AT ALL (any channel, any amount), by how much, and where.

    python strict.py <run-output-dir>            every <state>/A.png vs B.png under it
    python strict.py A.png B.png

run.py's own verdict uses a perceptual threshold (YIQ 0.1) and so reports 0 for small
differences; the rendering experiments (docs/qa/native-bench/RENDER.md) are held to this one.
Prints per state: differing pixels, of them > 1/255 and > 8/255, the largest channel delta,
and the bounding box of the differing pixels."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def compare(a: Path, b: Path):
    A = np.asarray(Image.open(a).convert("RGB"), dtype=np.int16)
    B = np.asarray(Image.open(b).convert("RGB"), dtype=np.int16)
    if A.shape != B.shape:
        return {"error": f"size {A.shape} vs {B.shape}"}
    d = np.abs(A - B).max(axis=2)
    ys, xs = np.nonzero(d)
    out = {"px": int(d.size), "differ": int((d > 0).sum()), "gt1": int((d > 1).sum()), "gt8": int((d > 8).sum()),
           "max": int(d.max())}
    if len(xs):
        out["bbox"] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    return out


def main():
    args = [Path(x) for x in sys.argv[1:]]
    pairs = []
    if len(args) == 2 and args[0].is_file():
        pairs.append((args[0].stem + " vs " + args[1].stem, args[0], args[1]))
    else:
        for root in args:
            for a in sorted(root.rglob("A.png")):
                b = a.with_name("B.png")
                if b.exists():
                    pairs.append((str(a.parent.relative_to(root)).replace("\\", "/"), a, b))
    print("| state | differing px | > 1/255 | > 8/255 | max delta | where (x0,y0,x1,y1) |")
    print("|---|---|---|---|---|---|")
    total = 0
    for name, a, b in pairs:
        r = compare(a, b)
        if "error" in r:
            print(f"| {name} | {r['error']} | | | | |")
            continue
        total += r["differ"]
        print(f"| {name} | {r['differ']} | {r['gt1']} | {r['gt8']} | {r['max']} | {r.get('bbox', '–')} |")
    print(f"\n{len(pairs)} pairs, {total} differing pixels in all")


if __name__ == "__main__":
    main()
