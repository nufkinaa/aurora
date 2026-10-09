#!/usr/bin/env python3
"""The pure pixel diff of the TV screenshot harness (docs/native-rewrite/02-verification.md §4.2).

    (A, B, masks, dither, tolerance) -> (D image, numbers)

Rule, as implemented:

1. Colour distance per pixel is pixelmatch's: both pixels are alpha-blended onto
   white, converted to YIQ, and
       delta = 0.5053*dY^2 + 0.299*dI^2 + 0.1957*dQ^2        (max 35215)
   A pixel *differs* when delta > 35215 * threshold^2 (threshold 0.1 -> 352.15).
   Anti-aliasing detection is off (`includeAA: false`); the edge rule below is ours.
2. Masks (px rectangles) are excluded from the comparison entirely.
3. Edge mask: Sobel on A's luma, magnitude normalised so a clean step of height h
   reads h, thresholded at > 40 (of 255), then dilated by `edge_dilate` px.
4. Differing pixels ON the edge mask are anti-aliasing candidates: they pass as
   long as their share of the compared pixels is <= max_diff_fraction (0.0005).
   ANY differing pixel OFF the edge mask fails the pair (a flat area that differs
   is a colour, alpha or shift error, never anti-aliasing).
5. Dither regions (px rectangles, declared per state): inside them a pixel off
   the edges whose largest per-channel difference is <= 2/255 is forgiven. The
   regions and the number of forgiven pixels are always reported. (Note: at
   threshold 0.1 the YIQ test already absorbs small luma shifts; dither regions
   matter at threshold 0, which the text procedure of 02 §3.4 uses.)
6. Different image sizes fail outright.

Standalone:  python diff.py A.png B.png [--out D.png] [--triptych T.png] [--json R.json]
             [--mask x,y,w,h ...] [--dither x,y,w,h ...] [--threshold 0.1]
             [--max-diff-fraction 0.0005] [--edge-dilate 1]
Exit code 0 = pass, 1 = fail, 2 = usage/IO error.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field, asdict
from typing import Iterable, Sequence

try:
    import numpy as np
except ImportError:  # pragma: no cover
    sys.exit("tv-pixel-diff needs numpy (pip install numpy); it is used for the 1920x1080 diff")
from PIL import Image, ImageDraw, ImageFont

YIQ_MAX_DELTA = 35215.0  # pixelmatch: max possible delta of two colours
EDGE_SOBEL_THRESHOLD = 40.0  # of 255, on the normalised Sobel magnitude
DITHER_CHANNEL_TOLERANCE = 2  # per channel, out of 255


@dataclass
class Tolerance:
    threshold: float = 0.1
    max_diff_fraction: float = 0.0005
    edge_dilate: int = 1


@dataclass
class Rect:
    x: int
    y: int
    w: int
    h: int
    why: str = ""

    @staticmethod
    def parse(spec) -> "Rect":
        """Accepts [x,y,w,h], {"rect":[x,y,w,h],"why":...}, {"x":..}, or 'x,y,w,h'."""
        if isinstance(spec, Rect):
            return spec
        if isinstance(spec, str):
            x, y, w, h = (int(v) for v in spec.split(","))
            return Rect(x, y, w, h)
        if isinstance(spec, dict):
            if "rect" in spec:
                r = Rect.parse(spec["rect"])
                r.why = spec.get("why", "")
                return r
            return Rect(int(spec["x"]), int(spec["y"]), int(spec["w"]), int(spec["h"]), spec.get("why", ""))
        x, y, w, h = (int(v) for v in spec)
        return Rect(x, y, w, h)

    def as_list(self):
        return [self.x, self.y, self.w, self.h]


@dataclass
class DiffResult:
    width: int = 0
    height: int = 0
    size_mismatch: bool = False
    size_a: list = field(default_factory=list)
    size_b: list = field(default_factory=list)
    threshold: float = 0.1
    max_diff_fraction: float = 0.0005
    edge_dilate: int = 1
    compared_px: int = 0
    masked_px: int = 0
    edge_px: int = 0
    differing_px: int = 0
    on_edge_px: int = 0
    off_edge_px: int = 0
    diff_fraction: float = 0.0  # on-edge differing / compared
    dither_forgiven_px: int = 0
    max_delta: int = 0  # largest per-channel difference among compared pixels (0..255)
    max_yiq: float = 0.0  # sqrt(max yiq delta / 35215), 0..1 — the pixelmatch scale
    masks_applied: list = field(default_factory=list)
    dither_regions: list = field(default_factory=list)
    off_edge_bbox: list | None = None  # [x0,y0,x1,y1] of the failing pixels, for a reviewer
    passed: bool = False
    reasons: list = field(default_factory=list)

    def to_dict(self):
        d = asdict(self)
        d["pass"] = d.pop("passed")
        return d


# ---------------------------------------------------------------- helpers

def _load(img) -> np.ndarray:
    """-> float32 HxWx3, alpha blended onto white (pixelmatch does the same)."""
    if isinstance(img, (str, bytes)) or hasattr(img, "read"):
        img = Image.open(img)
    if isinstance(img, np.ndarray):
        a = img.astype(np.float32)
        if a.ndim == 2:
            a = np.stack([a, a, a], axis=-1)
        if a.shape[-1] == 4:
            alpha = a[..., 3:4] / 255.0
            a = 255.0 + (a[..., :3] - 255.0) * alpha
        return a[..., :3]
    rgba = np.asarray(img.convert("RGBA"), dtype=np.float32)
    alpha = rgba[..., 3:4] / 255.0
    return 255.0 + (rgba[..., :3] - 255.0) * alpha


def _yiq(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = r * 0.29889531 + g * 0.58662247 + b * 0.11448223
    i = r * 0.59597799 - g * 0.27417610 - b * 0.32180189
    q = r * 0.21147017 - g * 0.52261711 + b * 0.31114694
    return np.stack([y, i, q], axis=-1)


def yiq_delta(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """pixelmatch's colour delta per pixel (HxW float32)."""
    d = _yiq(a) - _yiq(b)
    return 0.5053 * d[..., 0] ** 2 + 0.299 * d[..., 1] ** 2 + 0.1957 * d[..., 2] ** 2


def luma(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.29889531 + rgb[..., 1] * 0.58662247 + rgb[..., 2] * 0.11448223


def sobel_edges(gray: np.ndarray, thresh: float = EDGE_SOBEL_THRESHOLD) -> np.ndarray:
    """Boolean HxW: Sobel magnitude (normalised so a clean step of height h -> h) > thresh.
    Edge pixels are replicated at the border (no false edges along the frame)."""
    p = np.pad(gray, 1, mode="edge")
    gx = (p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])
    gy = (p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])
    mag = np.sqrt(gx * gx + gy * gy) / 4.0
    return mag > thresh


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    if r <= 0:
        return mask
    p = np.pad(mask, r, mode="constant", constant_values=False)
    out = np.zeros_like(mask)
    h, w = mask.shape
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= p[r + dy : r + dy + h, r + dx : r + dx + w]
    return out


def rect_mask(shape, rects: Iterable[Rect]) -> np.ndarray:
    m = np.zeros(shape[:2], dtype=bool)
    h, w = shape[:2]
    for r in rects:
        x0, y0 = max(0, r.x), max(0, r.y)
        x1, y1 = min(w, r.x + r.w), min(h, r.y + r.h)
        if x1 > x0 and y1 > y0:
            m[y0:y1, x0:x1] = True
    return m


# ---------------------------------------------------------------- the diff

def compare(a_img, b_img, masks: Sequence = (), dither: Sequence = (), tol: Tolerance | None = None):
    """Returns (D: PIL.Image RGB, DiffResult). a_img/b_img: path, file, PIL image or ndarray."""
    tol = tol or Tolerance()
    masks = [Rect.parse(m) for m in masks]
    dither = [Rect.parse(d) for d in dither]
    A = _load(a_img)
    B = _load(b_img)
    res = DiffResult(threshold=tol.threshold, max_diff_fraction=tol.max_diff_fraction, edge_dilate=tol.edge_dilate,
                     masks_applied=[{"rect": m.as_list(), "why": m.why} for m in masks],
                     dither_regions=[{"rect": d.as_list(), "why": d.why} for d in dither])
    res.size_a, res.size_b = [A.shape[1], A.shape[0]], [B.shape[1], B.shape[0]]
    res.width, res.height = A.shape[1], A.shape[0]
    if A.shape != B.shape:
        res.size_mismatch = True
        res.reasons.append(f"size mismatch A {res.size_a} vs B {res.size_b}")
        D = Image.new("RGB", (res.width, res.height), (255, 0, 0))
        return D, res

    masked = rect_mask(A.shape, masks)
    compared = ~masked
    res.masked_px = int(masked.sum())
    res.compared_px = int(compared.sum())

    delta = yiq_delta(A, B)
    max_delta = YIQ_MAX_DELTA * tol.threshold * tol.threshold
    differing = (delta > max_delta) & compared

    edges = dilate(sobel_edges(luma(A)), tol.edge_dilate)
    res.edge_px = int((edges & compared).sum())

    chan = np.abs(A - B).max(axis=-1)  # per-pixel max channel difference
    if dither:
        dz = rect_mask(A.shape, dither) & compared
        forgiven = differing & dz & ~edges & (chan <= DITHER_CHANNEL_TOLERANCE)
        res.dither_forgiven_px = int(forgiven.sum())
        differing &= ~forgiven

    on_edge = differing & edges
    off_edge = differing & ~edges
    res.differing_px = int(differing.sum())
    res.on_edge_px = int(on_edge.sum())
    res.off_edge_px = int(off_edge.sum())
    res.diff_fraction = (res.on_edge_px / res.compared_px) if res.compared_px else 0.0
    if res.compared_px:
        res.max_delta = int(np.rint(chan[compared].max()))
        res.max_yiq = float(np.sqrt(delta[compared].max() / YIQ_MAX_DELTA))
    if res.off_edge_px:
        ys, xs = np.nonzero(off_edge)
        res.off_edge_bbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
        res.reasons.append(f"{res.off_edge_px} differing px off the edge mask (bbox {res.off_edge_bbox})")
    if res.diff_fraction > tol.max_diff_fraction:
        res.reasons.append(f"on-edge diff fraction {res.diff_fraction:.6f} > {tol.max_diff_fraction}")
    res.passed = not res.reasons

    D = render_diff(A, masked, edges, on_edge, off_edge)
    return D, res


def render_diff(A: np.ndarray, masked, edges, on_edge, off_edge) -> Image.Image:
    """D.png: A dimmed to grey; edge mask blue; masks dark with hatching; differing pixels red
    (off-edge ones dilated by 2 px so a single failing pixel is visible at 1080p)."""
    g = luma(A) * 0.35
    out = np.stack([g, g, g], axis=-1)
    out[edges] = out[edges] * 0.4 + np.array([40.0, 90.0, 255.0]) * 0.6
    if masked.any():
        yy, xx = np.nonzero(masked)
        out[masked] = 18.0
        hatch = ((xx + yy) % 12) < 2
        out[yy[hatch], xx[hatch]] = np.array([70.0, 70.0, 70.0])
    out[on_edge] = np.array([230.0, 40.0, 40.0])
    off = dilate(off_edge, 2)
    out[off] = np.array([255.0, 0.0, 0.0])
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")


def triptych(a_img, b_img, d_img: Image.Image, labels=("A  js", "B  native", "D  diff"), panel_w: int = 960) -> Image.Image:
    """A | B | D side by side, each scaled to panel_w, with a caption strip."""
    ims = [Image.open(a_img) if isinstance(a_img, str) else a_img,
           Image.open(b_img) if isinstance(b_img, str) else b_img, d_img]
    ims = [im.convert("RGB") for im in ims]
    scale = panel_w / ims[0].width
    ph = int(round(ims[0].height * scale))
    gutter, cap = 8, 22
    out = Image.new("RGB", (panel_w * 3 + gutter * 2, ph + cap), (12, 12, 16))
    draw = ImageDraw.Draw(out)
    font = ImageFont.load_default()
    for i, (im, lab) in enumerate(zip(ims, labels)):
        x = i * (panel_w + gutter)
        out.paste(im.resize((panel_w, ph), Image.BILINEAR), (x, cap))
        draw.text((x + 6, 5), lab, fill=(220, 220, 230), font=font)
    return out


# ---------------------------------------------------------------- CLI

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--out", help="write D.png here")
    ap.add_argument("--triptych", help="write the A|B|D triptych here")
    ap.add_argument("--json", help="write the result JSON here (always printed to stdout)")
    ap.add_argument("--mask", action="append", default=[], help="x,y,w,h (repeatable) — excluded from the compare")
    ap.add_argument("--dither", action="append", default=[], help="x,y,w,h (repeatable) — 2/255 per-channel allowance off edges")
    ap.add_argument("--threshold", type=float, default=0.1)
    ap.add_argument("--max-diff-fraction", type=float, default=0.0005)
    ap.add_argument("--edge-dilate", type=int, default=1)
    args = ap.parse_args(argv)
    try:
        D, res = compare(args.a, args.b, args.mask, args.dither,
                         Tolerance(args.threshold, args.max_diff_fraction, args.edge_dilate))
    except (OSError, ValueError) as e:
        print(f"diff: {e}", file=sys.stderr)
        return 2
    if args.out:
        D.save(args.out)
    if args.triptych:
        triptych(args.a, args.b, D).save(args.triptych)
    text = json.dumps(res.to_dict(), indent=2)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            f.write(text + "\n")
    print(text)
    return 0 if res.passed else 1


if __name__ == "__main__":
    sys.exit(main())
