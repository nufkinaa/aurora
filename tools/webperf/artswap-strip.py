#!/usr/bin/env python3
"""The strip and the numbers out of artswap.js captures.

  python tools/webperf/artswap-strip.py <out/artswap/label-cast> [--shots <out/artswap/label>]
         [--from -100] [--to 600] [--step 50] [--out strip.png] [--title "before"]
         [--cell 132] [--colors 96] [--quiet] [--tol 0.35] [--noise 1.2]

Top row: the hero out of the screencast (--cast run: every frame the browser
drew, CSS pixels), one cell per step, the frame that was on screen at that
moment. Bottom row: the piece photographed in the device's own pixels (the
other run), cut 1:1 from its middle, so soft and sharp can be told apart.
Under each cell its time from the swap in ms (0 = the page starts the swap).

Numbers, per capture (printed, and written to its numbers.json), from the
picture part of the hero (no title, no buttons):
  luma    mean brightness 0..255          -> a dark or empty frame shows as a dip
  sharp   mean absolute Laplacian         -> soft .. sharp
  toEnd   mean absolute difference to the last frame -> how far from the final picture
and the verdict: the darkest frame against the darker of the first and the
last ("dip": 0 = never darker than both), whether toEnd only ever falls
(within a small tolerance), how many in-between frames there were.
A frame within --noise (1.2) of the last one counts as the last one: the
screencast is JPEG, and a layer fading over the very same picture rounds a
pixel one step up or down, which the encoder turns into grain of about that
size (looked at, amplified 30 times: 8x8 blocks, no shape).
"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFilter, ImageStat, ImageChops


def arg(name, default=None):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default


def at_or_before(items, t):
    best = None
    for it in items:
        if it["off"] <= t:
            best = it
        else:
            break
    return best or (items[0] if items else None)


class Capture:
    def __init__(self, d):
        self.d = d
        self.m = json.load(open(os.path.join(d, "manifest.json")))
        self.frames = sorted(self.m["frames"], key=lambda f: f["off"])
        self.cache = {}
        m = self.m
        vw, vh = m["view"]["w"], m["view"]["h"]
        self.vw = vw
        head = m.get("head")
        box = head if head and head["w"] > 0 and head["h"] > 0 else m.get("hero")
        self.box = (max(0, box["x"]), max(0, box["y"]), min(vw, box["x"] + box["w"]), min(vh, box["y"] + box["h"]))
        x0, y0, x1, y1 = self.box
        w, h = min(240, (x1 - x0) * 0.6), min(170, (y1 - y0) * 0.34)
        self.part = (x0 + (x1 - x0 - w) / 2, y0 + (y1 - y0) * 0.08, x0 + (x1 - x0 - w) / 2 + w, y0 + (y1 - y0) * 0.08 + h)

    def whole(self, f):
        if f["file"] not in self.cache:
            if len(self.cache) > 8:
                self.cache.clear()
            self.cache[f["file"]] = Image.open(os.path.join(self.d, "frames", f["file"])).convert("RGB")
        return self.cache[f["file"]]

    def hero(self, f):  # cast only
        im = self.whole(f)
        sx = im.width / self.vw
        return im.crop(tuple(int(v * sx) for v in self.box))

    def piece(self, f):
        im = self.whole(f)
        if self.m.get("mode") == "shots":
            return im
        sx = im.width / self.vw
        return im.crop(tuple(int(v * sx) for v in self.part))

    def numbers(self, t_from, t_to, tol, quiet, noise=1.2):
        src = [f for f in self.frames if t_from <= f["off"] <= t_to + 400]
        last = self.piece(src[-1]).convert("L")
        rows = []
        for s in src:
            g = self.piece(s).convert("L")
            if g.size != last.size:
                continue
            lap = g.filter(ImageFilter.Kernel((3, 3), [0, -1, 0, -1, 4, -1, 0, -1, 0], scale=1, offset=128)).point(lambda v: min(255, abs(v - 128) * 4))
            rows.append({
                "off": s["off"],
                "luma": round(ImageStat.Stat(g).mean[0], 2),
                "sharp": round(ImageStat.Stat(lap).mean[0] / 4, 3),
                "toEnd": round(ImageStat.Stat(ImageChops.difference(g, last)).mean[0], 3),
            })
        first, end = rows[0], rows[-1]
        floor = min(first["luma"], end["luma"])
        darkest = min(rows, key=lambda r: r["luma"])
        rises = [(a["off"], b["off"], round(b["toEnd"] - a["toEnd"], 3)) for a, b in zip(rows, rows[1:]) if b["toEnd"] > max(a["toEnd"], noise) + tol]
        between = [r for r in rows if noise < r["toEnd"] < first["toEnd"] - tol]
        verdict = {
            "label": self.m["label"], "mode": self.m.get("mode"), "frames": len(rows),
            "lumaFirst": first["luma"], "lumaLast": end["luma"], "lumaDarkest": darkest["luma"], "darkestAt": darkest["off"],
            "dip": round(floor - darkest["luma"], 2),
            "sharpFirst": first["sharp"], "sharpLast": end["sharp"],
            "sharpMost": max(r["sharp"] for r in rows),
            "toEndFirst": first["toEnd"],
            "inBetweenFrames": len(between),
            "inBetweenFromTo": [between[0]["off"], between[-1]["off"]] if between else None,
            "movesAwayFromTheEnd": rises,
        }
        json.dump({"rows": rows, "verdict": verdict}, open(os.path.join(self.d, "numbers.json"), "w"), indent=1)
        if not quiet:
            for r in rows:
                print(f'{r["off"]:>6} ms  luma {r["luma"]:>7}  sharp {r["sharp"]:>7}  toEnd {r["toEnd"]:>7}')
        print(json.dumps(verdict))


def main():
    cast = Capture(sys.argv[1])
    shots = Capture(arg("--shots")) if arg("--shots") else None
    t_from, t_to, step = int(arg("--from", "-100")), int(arg("--to", "600")), int(arg("--step", "50"))
    cell = int(arg("--cell", "132"))
    colors = int(arg("--colors", "96"))
    tol = float(arg("--tol", "0.35"))
    title = arg("--title", cast.m["label"])
    quiet = "--quiet" in sys.argv
    noise = float(arg("--noise", "1.2"))
    cast.numbers(t_from, t_to, tol, quiet, noise)
    if shots:
        shots.numbers(t_from, t_to, tol, quiet, noise)

    ticks = list(range(t_from, t_to + 1, step))
    h0 = cast.hero(cast.frames[0])
    th = int(cell * h0.height / h0.width)
    zh = cell
    pad, lab, head = 3, 13, 15
    W = pad + len(ticks) * (cell + pad)
    H = head + th + pad + zh + lab + pad
    strip = Image.new("RGB", (W, H), (14, 14, 18))
    dr = ImageDraw.Draw(strip)
    dr.text((pad, 2), f"{title}   (ms; 0 = the page starts the swap. top: every frame, CSS px. bottom: a piece 1:1 in {'device' if shots else 'CSS'} px)", fill=(230, 230, 235))
    for i, t in enumerate(ticks):
        x = pad + i * (cell + pad)
        strip.paste(cast.hero(at_or_before(cast.frames, t)).resize((cell, th), Image.LANCZOS), (x, head))
        src = shots or cast
        z = src.piece(at_or_before(src.frames, t))
        cx, cy = z.width // 2, z.height // 2
        strip.paste(z.crop((cx - cell // 2, cy - cell // 2, cx - cell // 2 + cell, cy - cell // 2 + cell)), (x, head + th + pad))
        dr.text((x + 2, head + th + pad + zh + 1), f"{t:+d}", fill=(255, 210, 120) if t == 0 else (170, 170, 180))
    out = arg("--out", os.path.join(cast.d, "strip.png"))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    strip.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).save(out, "PNG", optimize=True)
    print(out, os.path.getsize(out), "bytes", strip.size)


main()
