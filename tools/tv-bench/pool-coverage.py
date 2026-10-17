#!/usr/bin/env python3
"""How much of a shelf is THERE while a key is held along it (aurora-lab:docs/qa/native-bench/POOL.md).

    python tools/tv-bench/pool-coverage.py <frames-dir> --y 145 --h 372 [--xmin 200]

Per frame of a screenrecord (ffmpeg -vsync 0), the share of the shelf's strip (x from xmin to the right edge)
that shows a card rather than the empty page: a column counts as "card" when its pixels vary down the strip
(std of luma > 12; the page behind a shelf is a smooth dark gradient). Only frames in which the strip moved
(it differs from the frame before) are counted. Prints the mean and the distribution."""
import argparse, sys
from pathlib import Path
import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("dir"); ap.add_argument("--y", type=int, required=True); ap.add_argument("--h", type=int, required=True)
ap.add_argument("--xmin", type=int, default=200)
a = ap.parse_args()
prev = None
cov = []
for fp in sorted(Path(a.dir).glob("*.png")):
    g = np.asarray(Image.open(fp).convert("L"), dtype=np.float32)[a.y + 40 : a.y + a.h - 40, a.xmin :]
    moved = prev is not None and float(np.abs(g - prev).mean()) > 1.0
    prev = g
    if moved:
        cov.append(float((g.std(axis=0) > 12).mean()))
if not cov:
    sys.exit("no moving frames")
c = np.array(cov)
print(f"moving frames {len(c)}: shelf shown mean {100*c.mean():.0f} %, median {100*np.median(c):.0f} %, "
      f"frames with under half of it {int((c < 0.5).sum())} ({100*(c < 0.5).mean():.0f} %), with under a tenth {int((c < 0.1).sum())} ({100*(c < 0.1).mean():.0f} %)")
