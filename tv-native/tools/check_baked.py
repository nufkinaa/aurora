"""Check that the baked overlays draw the same picture as what they replace.

Run from tv-native/:  python tools/check_baked.py [picture ...]

Two replacements made for weak TV boxes (gen_ambient.py) are checked here:

  1. hero-scrim.png — ONE layer standing for Home's hero-side.png (stretched
     over the left 72%) followed by ambient-veil.png (full window).
  2. card-shade-v.png / card-frame-shade.png — strips standing for the
     react-native-svg <LinearGradient> shades on the cards.

Each is drawn the way the device draws it — PNG decoded to PREMULTIPLIED
8-bit, stretched with bilinear filtering (texel centres, clamp to edge),
blended SRC_OVER into an 8-bit frame buffer that is rounded after every
layer — over a set of backgrounds (flat black / grey / white, a ramp, and
real artwork when pictures are given, dimmed as Home dims it). The report is
the largest per-channel difference in 8-bit levels between old and new.

The SVG side is the gradient evaluated analytically at every pixel centre
(what Skia's shader does), premultiplied and rounded to 8 bits. Not
modelled: dithering (Skia may dither gradients by ±1 level), and the corner
anti-aliasing of the rounded clip (the SVG's rx vs the Image's borderRadius).
"""
import os
import sys

import numpy as np
from PIL import Image

ASSETS = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets')
SCREEN_W, SCREEN_H = 1920, 1080  # a 1080p set: 960 x 540 dp at density 2
SIDE_W = int(SCREEN_W * 0.72)    # Home.tsx styles.artSide: 72%, snapped to a pixel by Yoga


def load_premul(name):
    a = np.asarray(Image.open(os.path.join(ASSETS, name)).convert('RGBA')).astype(np.float64)
    alpha = a[..., 3:4]
    rgb = np.round(a[..., :3] * alpha / 255.0)  # the decoder's premultiply, rounded
    return np.concatenate([rgb, alpha], axis=2)


def bilinear(src, out_h, out_w):
    """GL_LINEAR stretch of src (h, w, c) to (out_h, out_w): texel centres,
    clamp to edge."""
    h, w = src.shape[:2]

    def axis(n_in, n_out):
        x = (np.arange(n_out) + 0.5) * n_in / n_out - 0.5
        i0 = np.floor(x).astype(int)
        f = x - i0
        return np.clip(i0, 0, n_in - 1), np.clip(i0 + 1, 0, n_in - 1), f

    y0, y1, fy = axis(h, out_h)
    x0, x1, fx = axis(w, out_w)
    top = src[y0][:, x0] * (1 - fx)[None, :, None] + src[y0][:, x1] * fx[None, :, None]
    bot = src[y1][:, x0] * (1 - fx)[None, :, None] + src[y1][:, x1] * fx[None, :, None]
    return top * (1 - fy)[:, None, None] + bot * fy[:, None, None]


def over(fb, layer, x_off=0):
    """SRC_OVER of a premultiplied layer onto the 8-bit frame buffer, rounded."""
    out = fb.copy()
    h, w = layer.shape[:2]
    dst = out[:h, x_off:x_off + w]
    a = layer[..., 3:4] / 255.0
    out[:h, x_off:x_off + w] = np.clip(np.round(layer[..., :3] + dst * (1 - a)), 0, 255)
    return out


def backgrounds(h, w, pictures, dim):
    yield 'black', np.zeros((h, w, 3))
    yield 'grey', np.full((h, w, 3), 128.0)
    yield 'white', np.full((h, w, 3), 255.0)
    ramp = np.linspace(0, 255, w)[None, :, None] * np.ones((h, 1, 3))
    yield 'ramp', np.round(ramp)
    for p in pictures:
        im = np.asarray(Image.open(p).convert('RGB').resize((w, h), Image.BILINEAR)).astype(np.float64)
        yield os.path.basename(p)[:12], np.round(im * (1 - dim))


def report(label, diffs):
    worst = max(d.max() for _, d in diffs)
    mean = np.mean([d.mean() for _, d in diffs])
    print(f'{label}: max {worst:.0f} level(s), mean {mean:.3f}')
    for name, d in diffs:
        print(f'    over {name:14s} max {d.max():.0f}  pixels off by >1: {(d > 1).mean() * 100:.3f}%')
    return worst


def check_scrim(pictures):
    side = bilinear(load_premul('hero-side.png'), SCREEN_H, SIDE_W)
    veil = bilinear(load_premul('ambient-veil.png'), SCREEN_H, SCREEN_W)
    scrim = bilinear(load_premul('hero-scrim.png'), SCREEN_H, SCREEN_W)
    diffs = []
    # Home's art sits under a black dim of 0.45 at rest
    for name, bg in backgrounds(SCREEN_H, SCREEN_W, pictures, 0.45):
        old = over(over(bg, side), veil)
        new = over(bg, scrim)
        diffs.append((name, np.abs(old - new)))
    return report('hero-scrim.png vs hero-side.png + ambient-veil.png', diffs)


def svg_shade(h, w, stops):
    """The SVG gradient: alpha at each pixel centre, #05060c, premultiplied."""
    t = 1 - (np.arange(h) + 0.5) / h  # offset from the foot (y1=1 -> y2=0)
    alpha = np.interp(t, [p for p, _ in stops], [a for _, a in stops])
    a8 = np.round(alpha * 255)
    rgb = np.round(np.array([5, 6, 12])[None, :] * a8[:, None] / 255.0)
    layer = np.concatenate([rgb, a8[:, None]], axis=1)
    return np.repeat(layer[:, None, :], w, axis=1)


def check_shades(pictures):
    worst = 0
    # card padding boxes in device pixels at density 2 (Card.tsx sizes minus the 1dp border)
    boxes = {
        'card-shade-v.png': ([(0.0, 0.92), (0.45, 0.0)], [(244, 368), (172, 260), (348, 194)]),
        'card-frame-shade.png': ([(0.0, 0.95), (0.24, 0.72), (0.52, 0.18), (0.68, 0.0)], [(444, 276)]),
    }
    for name, (stops, sizes) in boxes.items():
        strip = load_premul(name)
        diffs = []
        for w, h in sizes:
            ref = svg_shade(h, w, stops)
            png = bilinear(strip, h, w)
            for bname, bg in backgrounds(h, w, pictures, 0.0):
                diffs.append((f'{bname} {w}x{h}', np.abs(over(bg, ref) - over(bg, png))))
        worst = max(worst, report(f'{name} vs the SVG gradient', diffs))
    return worst


if __name__ == '__main__':
    pics = sys.argv[1:]
    a = check_scrim(pics)
    b = check_shades(pics)
    print(f'WORST: {max(a, b):.0f} level(s) of 255')
