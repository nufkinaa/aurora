#!/usr/bin/env python3
"""LAB — the art-format experiment's screenshot pairs (docs/qa/native-bench/ART-FORMAT.md).

    python tools/art-shots-diff.py docs/qa/native-bench/art-format

Reads raw/<arm>-shot<R>1-<state>.png (tools/art-probe.sh -m shots, rounds A, B, C…), and per
state prints, with tools/tv-pixel-diff/strict.py's exact count:
  - the noise floor: the same arm twice (jpeg round A vs jpeg round B) — must be 0;
  - jpeg vs webp: differing pixels, > 1, > 8, > 16 levels, the largest delta, the mean
    absolute difference in levels of 255 (all channels), and PSNR.
For the worst 240x135 window of each state it writes a 4x nearest-neighbour crop pair
<state>-worst-jpeg.png / -webp.png and a side-by-side <state>-worst.png into the directory."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent / "tv-pixel-diff"))
from strict import compare  # noqa: E402

STATES = ["home-rest", "home-scrolled", "detail1", "detail2"]
W, H, ZOOM = 240, 135, 4


def load(p):
    return np.asarray(Image.open(p).convert("RGB"), dtype=np.int16)


def main():
    out = Path(sys.argv[1])
    raw = out / "raw"
    rounds = sorted({p.name.split("-")[1] for p in raw.glob("jpeg-shot*-home-rest.png")})
    for st in STATES:
        j = [raw / f"jpeg-{r}-{st}.png" for r in rounds]
        w = [raw / f"webp-{r}-{st}.png" for r in rounds]
        for name, files in (("jpeg", j), ("webp", w)):
            for other in files[1:]:
                c = compare(files[0], other)
                print(f"{st:14} noise {name} {files[0].name.split('-')[1]} vs {other.name.split('-')[1]}: differ={c['differ']} max={c['max']}")
        c = compare(j[0], w[0])
        A, B = load(j[0]), load(w[0])
        d = np.abs(A - B)
        mse = float((d.astype(np.float64) ** 2).mean())
        psnr = 10 * np.log10(255 * 255 / mse) if mse else 99.0
        dm = d.max(axis=2)
        print(f"{st:14} jpeg vs webp: differ={c['differ']} ({100 * c['differ'] / c['px']:.1f}%) gt1={c['gt1']} gt8={c['gt8']} "
              f"gt16={int((dm > 16).sum())} max={c['max']} mean={d.mean():.3f} psnr={psnr:.1f} bbox={c.get('bbox')}")
        # the worst window: the largest summed difference over W x H (integral image, step 15)
        s = dm.astype(np.int64)
        ii = np.pad(s.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
        best, bx, by = -1, 0, 0
        for y in range(0, s.shape[0] - H + 1, 15):
            for x in range(0, s.shape[1] - W + 1, 15):
                v = ii[y + H, x + W] - ii[y, x + W] - ii[y + H, x] + ii[y, x]
                if v > best:
                    best, bx, by = v, x, y
        if best <= 0:
            continue  # home-scrolled: the hero has left the screen, nothing differs
        win = dm[by:by + H, bx:bx + W]
        print(f"{'':14} worst {W}x{H} window at x={bx} y={by}: mean {win.mean():.2f} max {int(win.max())}")
        crops = []
        for arm, f in (("jpeg", j[0]), ("webp", w[0])):
            im = Image.open(f).convert("RGB").crop((bx, by, bx + W, by + H)).resize((W * ZOOM, H * ZOOM), Image.NEAREST)
            im.save(out / f"{st}-worst-{arm}.png", optimize=True)
            crops.append(im)
        pair = Image.new("RGB", (W * ZOOM * 2 + 8, H * ZOOM), (255, 0, 255))
        pair.paste(crops[0], (0, 0))
        pair.paste(crops[1], (W * ZOOM + 8, 0))
        pair.save(out / f"{st}-worst.png", optimize=True)


if __name__ == "__main__":
    main()
