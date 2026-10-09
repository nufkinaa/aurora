#!/usr/bin/env python3
"""Self-test of diff.py and trace.py on synthetic 1920x1080 frames. No device needed.

    python selftest.py            (from tools/tv-pixel-diff/)
    python -m selftest            (same, when cwd is tools/tv-pixel-diff/)

Cases:
  1. gradient + 1-level dither noise (B = A +-1 per channel at scattered pixels)   -> PASS
  2. same gradient, a 3-px change in a flat area (off the edge mask)              -> FAIL
  3. an anti-aliased edge drawn 1 px differently (on the edge mask, tiny share)   -> PASS
  4. threshold 0: the dither noise fails unless the region is declared `dither`   -> FAIL then PASS
  5. a trace pair within 1e-3 passes; a curve 1 % off or 30 % slower fails; a dropped frame passes
Also times the full-frame diff (must be well under 10 s).
"""
from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from PIL import Image, ImageDraw

import diff
import trace

W, H = 1920, 1080


def gradient_frame(seed: int = 7) -> np.ndarray:
    """A dark-blue-to-violet gradient (the hero scrim look), a bright card with an
    anti-aliased rounded edge, and some text-like strokes: edges and flats both present."""
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    r = 10 + 40 * (x / W)
    g = 12 + 20 * (y / H)
    b = 30 + 90 * (x / W) * (y / H)
    a = np.stack([r, g, b], axis=-1)
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((400, 300, 648, 672), radius=24, fill=(19, 21, 35), outline=(200, 205, 220), width=2)
    d.rounded_rectangle((420, 330, 628, 400), radius=8, fill=(108, 88, 255))
    for i in range(6):
        d.line((700, 320 + i * 40, 1500 + (i * 37) % 200, 322 + i * 40), fill=(230, 232, 240), width=3)
    return np.asarray(im).astype(np.int16)


def to_img(a: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")


def dither_noise(a: np.ndarray, seed: int = 3, density: float = 0.25) -> np.ndarray:
    rng = np.random.default_rng(seed)
    pick = rng.random((H, W)) < density
    sign = rng.integers(0, 2, size=(H, W, 3)) * 2 - 1
    b = a.copy()
    b[pick] = a[pick] + sign[pick]
    return b


def check(name: str, cond: bool, detail: str = ""):
    print(f"  [{'ok' if cond else 'FAIL'}] {name}" + (f"  - {detail}" if detail else ""))
    return cond


def main() -> int:
    ok = True
    A = gradient_frame()
    tol = diff.Tolerance()

    # 1. dither noise across the whole frame, including flat regions -> must pass at 0.1
    B1 = dither_noise(A)
    t0 = time.perf_counter()
    D, r = diff.compare(to_img(A), to_img(B1), tol=tol)
    dt = time.perf_counter() - t0
    print("case 1: 1-level dither noise over the whole frame (threshold 0.1)")
    ok &= check("passes", r.passed, f"differing={r.differing_px} off_edge={r.off_edge_px} max_delta={r.max_delta} max_yiq={r.max_yiq:.4f}")
    ok &= check("full-frame diff time < 10 s", dt < 10, f"{dt:.2f} s")

    # 2. a 3-px change in a flat area -> must fail (off-edge pixels)
    B2 = B1.copy()
    B2[800, 1200:1203] = [255, 255, 255]
    D, r = diff.compare(to_img(A), to_img(B2), tol=tol)
    print("case 2: 3 px changed in a flat area")
    ok &= check("fails", not r.passed, "; ".join(r.reasons))
    ok &= check("exactly 3 off-edge px", r.off_edge_px == 3, f"off_edge={r.off_edge_px} bbox={r.off_edge_bbox}")
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".selftest-out")
    os.makedirs(out, exist_ok=True)
    to_img(A).save(os.path.join(out, "A.png"))
    to_img(B2).save(os.path.join(out, "B.png"))
    D.save(os.path.join(out, "D.png"))
    diff.triptych(to_img(A), to_img(B2), D).save(os.path.join(out, "triptych.png"))

    # 2b. the same change inside a mask -> passes, and the mask is reported
    D, r = diff.compare(to_img(A), to_img(B2), masks=[{"rect": [1190, 790, 30, 20], "why": "selftest"}], tol=tol)
    ok &= check("passes when the change is masked", r.passed and r.masks_applied[0]["why"] == "selftest",
                f"masked_px={r.masked_px}")

    # 3. an anti-aliased edge drawn 1 px differently -> on-edge diffs only, tiny share -> pass
    imB3 = to_img(A)
    d = ImageDraw.Draw(imB3)
    d.line((700, 320, 1500, 322), fill=(230, 232, 240), width=3)  # redraw the first stroke, shifted 0 px
    d.line((700, 321, 1500, 323), fill=(230, 232, 240), width=3)  # and a copy 1 px lower: fattens its AA fringe
    D, r = diff.compare(to_img(A), imB3, tol=tol)
    print("case 3: an edge's anti-aliased fringe differs by 1 px")
    ok &= check("passes (on-edge only, within 0.05 %)", r.passed,
                f"on_edge={r.on_edge_px} off_edge={r.off_edge_px} fraction={r.diff_fraction:.6f}")

    # 4. threshold 0 (the text procedure): 1-level noise fails; a dither region forgives it off edges
    strict = diff.Tolerance(threshold=0.0)
    B4 = A.copy()
    B4[100:160, 100:400] = dither_noise(A, seed=11, density=0.5)[100:160, 100:400]
    D, r = diff.compare(to_img(A), to_img(B4), tol=strict)
    print("case 4: threshold 0 with 1-level noise in a flat patch")
    ok &= check("fails without a dither region", not r.passed, f"off_edge={r.off_edge_px}")
    D, r = diff.compare(to_img(A), to_img(B4), dither=[{"rect": [100, 100, 300, 60], "why": "selftest"}], tol=strict)
    ok &= check("passes with the region declared, forgiven px reported", r.passed and r.dither_forgiven_px > 0,
                f"forgiven={r.dither_forgiven_px} regions={r.dither_regions}")

    # 4b. size mismatch fails
    D, r = diff.compare(to_img(A), to_img(A[:, :1900]), tol=tol)
    ok &= check("size mismatch fails", (not r.passed) and r.size_mismatch)

    # 5. traces
    print("case 5: [anim] traces")
    base = 1_000_000_000
    key = "[key] 1000 KEYCODE_DPAD_RIGHT\n"
    la = key + "".join(f"[anim] {base + i * 16_666_667} row.tx {-(i / 16.0) * 260:.6f}\n" for i in range(18))
    lb = key + "".join(f"[anim] {base + 5000 + i * 16_666_667} row.tx {-(i / 16.0) * 260 + 0.0002:.6f}\n" for i in range(18))
    res = trace.compare(trace.parse(la), trace.parse(lb), ["row.tx"], retarget=True)
    ok &= check("identical-within-1e-3 traces pass", res["pass"], f"max_abs_err={res['ids']['row.tx']['max_abs_err']:.2g}")
    # (the rule is the curve in TIME, +-25 ms: one mid-flight step 1 % off sits inside the
    #  neighbouring frames' band and is not a failure; a different rest value, or the same
    #  curve run 30 % slower, is)
    lc = key + "".join(f"[anim] {base + i * 16_666_667} row.tx {-(i / 16.0) * 260 * 1.01:.6f}\n" for i in range(18))
    res = trace.compare(trace.parse(la), trace.parse(lc), ["row.tx"])
    ok &= check("a curve 1 % off (rest value included) fails", not res["pass"], "; ".join(res["reasons"])[:160])
    le = key + "".join(f"[anim] {base + i * 16_666_667} row.tx {-(min(i / 1.3, 17) / 16.0) * 260:.6f}\n" for i in range(24))
    res = trace.compare(trace.parse(la), trace.parse(le), ["row.tx"])
    ok &= check("the same curve 30 % slower fails", not res["pass"], "; ".join(res["reasons"])[:160])
    lf = key + "".join(f"[anim] {base + i * 16_666_667} row.tx {-(i / 16.0) * 260:.6f}\n" for i in range(18) if i != 7)
    res = trace.compare(trace.parse(la), trace.parse(lf), ["row.tx"])
    ok &= check("one dropped frame passes", res["pass"], "; ".join(res["reasons"])[:160])
    ld = la + f"[anim] {base + 99 * 16_666_667} row.tx 0\n" * 2
    res = trace.compare(trace.parse(la), trace.parse(ld), ["row.tx"])
    ok &= check("step count off by 2 fails", not res["pass"], "; ".join(res["reasons"]))
    res = trace.compare(trace.parse(la), trace.parse(""), ["row.tx"])
    ok &= check("a missing trace fails", not res["pass"])

    print("\nSELFTEST", "GREEN" if ok else "RED", f"(sample output in {out})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
