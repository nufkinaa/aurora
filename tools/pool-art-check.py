#!/usr/bin/env python3
"""Does a card ever show ANOTHER title's picture or label? (docs/qa/native-bench/POOL.md, the rebind check)

    python tools/pool-art-check.py <dir> --w 248 --h 372 --step 276 --y 145 --count 24 [--left 168] [--out report.json]

<dir>/ref-<f>.png   lossless screencaps of the shelf AT REST with card f focused (f = 0..count-1), taken with the
                    keyed (non-recycling) row: the reference picture of every card of the shelf
<dir>/frames/*.png  the frames of a screenrecord made while a key was HELD along that shelf (ffmpeg -vsync 0)

Geometry in screen px: a card is w x h, cards are `step` apart, card i's left edge is `left + i*step + tx`, the
shelf's cards start at row `y`. tx at rest with card f focused is -max(0, (f-1)*step) (rowMath LEAD = 1).

Each card of the shelf is cut from a reference shot in which it is NOT the focused one (the lit card is scaled),
as two templates: its whole inner face, and its lower part (where a frame card carries its title, sub-title and
progress bar). Per video frame the shelf's offset is found from the cards that match (the consensus of where
each known card is), then every card place on screen is classified against ALL the shelf's cards:

  ok      it shows the card that belongs at that place
  blank   it shows no picture yet (the dark raised card / a placeholder) - what a freshly mounted card shows too
  WRONG   it matches a DIFFERENT card of the shelf well: another title's picture (or label) at this place
  unsure  nothing matches well (the lit card mid-scale, a cross-fade, a card half under the left fade)

Exit code 1 when any place in any frame is WRONG. `unsure` places are listed with their best guess so they can
be looked at; --dump N writes the first N frames that have a WRONG or unsure place, annotated, to <dir>/flagged/.
"""
import argparse, json, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ap = argparse.ArgumentParser()
ap.add_argument("dir")
ap.add_argument("--w", type=int, required=True)
ap.add_argument("--h", type=int, required=True)
ap.add_argument("--step", type=int, required=True)
ap.add_argument("--y", type=int, required=True)
ap.add_argument("--count", type=int, required=True)
ap.add_argument("--left", type=int, default=168)
ap.add_argument("--inset", type=int, default=28, help="px cut off each side of a card (the ring, the neighbour's shadow)")
ap.add_argument("--good", type=float, default=14.0, help="mean abs difference (of 255) under which a place 'matches' a card")
ap.add_argument("--margin", type=float, default=1.6, help="a match must beat the runner-up by this factor")
ap.add_argument("--xmin", type=int, default=200, help="places starting left of this are under the row fade: skipped")
ap.add_argument("--dump", type=int, default=12)
ap.add_argument("--out", default=None)
a = ap.parse_args()
root = Path(a.dir)
S = 4  # work at a quarter of the resolution: the video is compressed, single pixels mean nothing


def load(p):
    return np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)


def small(img):
    h, w = img.shape[:2]
    return img[: h - h % S, : w - w % S].reshape(h // S, S, w // S, S, 3).mean(axis=(1, 3))


def face(img, x):
    """The inner face of the card whose left edge is at x (full-res px) -> small array, or None when off screen."""
    x0, x1 = x + a.inset, x + a.w - a.inset
    if x0 < 0 or x1 > img.shape[1]:
        return None
    return small(img[a.y + 16 : a.y + a.h - 16, x0:x1])


def pill(img, x):
    """Share of the card's top-left corner (where the NEW pill sits) that is the pill's violet."""
    c = img[a.y + 8 : a.y + 52, max(0, x + 8) : x + 100]
    if c.size == 0:
        return 0.0
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    return float(((b > 170) & (r > 70) & (r < 170) & (g > 40) & (g < 130) & (b - g > 80)).mean())


# ---- the references: card j cut from the rest shot of focus j-1, where it is the card right of the lit one
# (always mounted and fully on screen there; a shelf's window can end one or two places short of the screen's
# right edge, so any other place might be empty). Card 0 comes from the shot of focus 1.
refs = {}
pills = {}
for j in range(a.count):
    f = j - 1 if j > 0 else 1
    p = root / f"ref-{f}.png"
    if not p.exists():
        continue
    tx = -max(0, (f - 1) * a.step)
    shot = load(p)
    cr = face(shot, a.left + j * a.step + tx)
    if cr is not None and float(cr.std()) >= 9.0:
        refs[j] = cr
        pills[j] = pill(shot, a.left + j * a.step + tx)
missing = [j for j in range(a.count) if j not in refs]
if missing:
    print(f"no reference for cards {missing} (they are compared as unknown)")
ids = sorted(refs)
stack = np.stack([refs[j] for j in ids])  # N x h x w x 3
lower = slice(int(stack.shape[1] * 0.55), stack.shape[1])
# how alike two different cards of this shelf are at best: the floor a WRONG verdict has to clear
if len(ids) > 1:
    alike = min(float(np.abs(stack[i] - stack[k]).mean()) for i in range(len(ids)) for k in range(i + 1, len(ids)))
    print(f"{len(ids)} reference cards; the two most alike differ by {alike:.1f}/255 (a match is < {a.good})")


def classify(crop, region=slice(None)):
    d = np.abs(stack[:, region] - crop[region][None]).mean(axis=(1, 2, 3))
    o = np.argsort(d)
    return ids[o[0]], float(d[o[0]]), float(d[o[1]]) if len(o) > 1 else 999.0


def is_blank(crop):
    # no picture: one flat dark colour (the raised card) - little contrast and little light
    return float(crop.std()) < 16.0 and float(crop.mean()) < 60.0


frames = sorted((root / "frames").glob("*.png"))
if not frames:
    sys.exit("no frames under " + str(root / "frames"))
tot = {"ok": 0, "blank": 0, "WRONG": 0, "unsure": 0}
pill_max = 0.0
pill_seen = 0
flagged = []
offsets = []
(root / "flagged").mkdir(exist_ok=True)
for fi, fp in enumerate(frames):
    img = load(fp)
    # ---- the shelf's offset in this frame: try every tx, keep the one under which most places match their card
    best = None
    strip = img
    cands = set()
    for j in ids[:: max(1, len(ids) // 12)]:
        # where is card j? slide its template along x (coarse 4 px), take the best place
        t = refs[j]
        row = small(strip[a.y + 16 : a.y + a.h - 16, :])
        tw = t.shape[1]
        sc = [(float(np.abs(row[:, k : k + tw] - t).mean()), k) for k in range(0, row.shape[1] - tw + 1)]
        s, k = min(sc)
        if s < a.good:
            cands.add(k * S - a.inset - a.left - j * a.step)
    if not cands:
        offsets.append(None)
        continue
    tx = int(np.median(sorted(cands)))
    # refine +-6 px on the full set
    def cost(t_):
        c = []
        for j in ids:
            x = a.left + j * a.step + t_
            if x < a.xmin or x + a.w > img.shape[1]:
                continue
            cr = face(img, x)
            c.append(float(np.abs(cr - refs[j]).mean()))
        return np.median(c) if c else 999.0
    tx = min(range(tx - 6, tx + 7, 2), key=cost)
    offsets.append(tx)
    notes = []
    for p in range(a.count):
        x = a.left + p * a.step + tx
        if x < a.xmin or x + a.w > img.shape[1]:
            continue
        cr = face(img, x)
        b, s, s2 = classify(cr)
        bl, sl, sl2 = classify(cr, lower)
        if is_blank(cr):
            v = "blank"
        elif b == p and s < a.good and (bl == p or sl >= a.good):
            v = "ok"
        elif (b != p and s < a.good and s2 > s * a.margin) or (bl != p and sl < a.good * 0.8 and sl2 > sl * a.margin and b == p):
            v = "WRONG"
        else:
            v = "unsure"
        # a card that is right as a whole can still carry another card's TAG: the NEW pill (a violet pill in
        # the top-left corner) must be there exactly when the card's own reference has it
        if v == "ok" and p in pills:
            pf = pill(img, x)
            pill_seen += pf > 0.3
            pill_max = max(pill_max, abs(pf - pills[p]))
            if abs(pf - pills[p]) > 0.3:
                v = "WRONG"
                b, s = p, round(100 * pf, 0)
        tot[v] += 1
        if v in ("WRONG", "unsure"):
            notes.append({"place": p, "verdict": v, "face": [b, round(s, 1)], "lower": [bl, round(sl, 1)], "x": x,
                          "own": round(float(np.abs(cr - refs[p]).mean()), 1) if p in refs else None,
                          "mean": round(float(cr.mean()), 1), "std": round(float(cr.std()), 1)})
    if notes:
        flagged.append({"frame": fp.name, "tx": tx, "places": notes})
        if len(flagged) <= a.dump or any(n["verdict"] == "WRONG" for n in notes):
            im = Image.open(fp).convert("RGB")
            dr = ImageDraw.Draw(im)
            for n in notes:
                col = (255, 0, 0) if n["verdict"] == "WRONG" else (255, 200, 0)
                dr.rectangle([n["x"], a.y, n["x"] + a.w, a.y + a.h], outline=col, width=4)
                dr.text((n["x"] + 6, a.y + 6), f"place {n['place']}: {n['verdict']} face~{n['face']} lower~{n['lower']}", fill=col)
            im.crop((0, max(0, a.y - 40), im.width, min(im.height, a.y + a.h + 40))).save(root / "flagged" / fp.name)

moving = [o for o in offsets if o is not None]
print(f"{len(frames)} frames, {len(moving)} with the shelf located; shelf offset from {max(moving) if moving else '-'} to {min(moving) if moving else '-'} px")
print(f"card places judged: ok {tot['ok']}, blank {tot['blank']}, unsure {tot['unsure']}, WRONG {tot['WRONG']}")
print(f"NEW pill: {sum(1 for v in pills.values() if v > 0.3)} of the shelf's cards carry one; seen on {pill_seen} ok places; "
      f"largest difference in pill cover from the card's own reference {100 * pill_max:.0f} % (WRONG above 30 %)")
wrong = [f for f in flagged if any(n["verdict"] == "WRONG" for n in f["places"])]
for f in wrong[:20]:
    print("  WRONG", f["frame"], f["places"])
if a.out:
    Path(a.out).write_text(json.dumps({"frames": len(frames), "located": len(moving), "totals": tot, "flagged": flagged}, indent=1), encoding="utf-8")
sys.exit(1 if tot["WRONG"] else 0)
