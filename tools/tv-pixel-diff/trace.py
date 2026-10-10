#!/usr/bin/env python3
"""[anim] / [key] / [focus] trace parsing and the numeric A-vs-B comparison
(docs/native-rewrite/01-architecture.md §6, 02-verification.md §4.3, §5).

Line formats (the payload after logcat's own prefix; the tag does not matter):

    [anim] <frameTimeNanos> <id> <value>        one per driver step, id = nativeId.property
    [key]  <uptimeMs> <KEYCODE_NAME>              the receiver logs each `input keyevent` arrival
    [focus] <uptimeMs> gain tag=<id> impl=js|native edgeL=0|1 edgeR=0|1

Comparison per traced id (02 §4.3, as corrected 2026-10-10):

  The first version aligned the two runs BY STEP INDEX and asked |vA - vB| <= 1e-3 x range.
  That rule fails a run against itself (js vs js): the drivers step on real frame times
  (the spring integrates the real dt; the timing driver picks frame round(elapsed/16.67)),
  so one late or dropped frame shifts every later index, and the JS side's lines are stamped
  on arrival at the native module, a few ms after the frame. What IS reproducible is the
  curve - value as a function of time since the animation's first step. So:

  * steps are taken from the first [anim] line after the aligning [key] line (the last key
    of the path; the first with `traceFrom: "first"`; from the start if no key was logged); t = frameTime - (time of that first step);
  * every B step must lie on A's curve within one and a half frames of time: vB must be
    inside [min, max] of A's (linearly interpolated) curve over t +- 25 ms, widened by
    1e-3 x range (range = max - min of A's values, 1.0 when A is flat); and the same with
    A and B swapped;
  * the rest values (last step) must agree within 1e-3 x range;
  * the SETTLE times (the last step still further than 2e-3 x range from the rest value)
    must agree within 3 frames (50 ms). Not the time of the last step: a spring's driver
    stops on the first frame where |v| <= restSpeed AND |x - to| <= restDisplacement, and
    the velocity of an under-damped spring crosses zero every half period, so which frame
    that is depends on where the frames fall (seen on the box: 403 ms vs 504 ms for the
    same spring, js or native alike) while the curve itself is the same;
  * a frame gap longer than 64 ms makes RN's spring simulate only 64 ms of it
    (MAX_DELTA_TIME_SEC), so the curve lags real time by the excess from then on: the excess
    of both runs is added to the +-25 ms and to the 50 ms (reported as lag_ms);
  * if `retarget` is set for the state, the rest time of the last step (frameTimeNanos of
    the final step minus the aligning key) must agree within 16.7 ms.
  key_to_first_ms (key -> first step) is reported per side, not judged: it is the input
  latency, which the two implementations are allowed to differ in (native is the faster).

  The ids `focus.ring` / `focus.spring` carry the element GAINING focus only; the element
  losing it logs `focus.ring.out` / `focus.spring.out` (both implementations), so two
  elements animating at once no longer interleave in one series.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

TOL_FRACTION = 1e-3
TIME_SLACK_MS = 25.0       # one and a half 60 Hz frames
DURATION_SLACK_MS = 50.0   # three frames
STEP_COUNT_SLACK = 1       # reported only (dropped frames change the count, not the curve)
REST_TIME_SLACK_MS = 16.7

_ANIM = re.compile(r"\[anim\]\s+(\d+)\s+(\S+)\s+(-?[\d.]+(?:[eE][-+]?\d+)?)")
_KEY = re.compile(r"\[key\]\s+(\d+)\s+(\S+)")
_FOCUS = re.compile(r"\[focus\]\s+(\d+)\s+(\w+)\s+(.*)")
_RING = re.compile(r"\[ring\]\s+(\d+)\s+(claim|release)\s+(\S+)")


@dataclass
class Trace:
    anim: dict = field(default_factory=dict)  # id -> [(frameTimeNanos, value)]
    keys: list = field(default_factory=list)  # [(uptimeMs, keycode)]
    focus: list = field(default_factory=list)  # [(uptimeMs, event, {k: v})]
    ring: list = field(default_factory=list)  # [(uptimeMs, claim|release, id)]

    def to_dict(self):
        return {"anim": {k: [[t, v] for t, v in steps] for k, steps in self.anim.items()},
                "keys": self.keys, "focus": [[t, e, kv] for t, e, kv in self.focus], "ring": self.ring}


def parse(text: str) -> Trace:
    tr = Trace()
    for line in text.splitlines():
        m = _ANIM.search(line)
        if m:
            tr.anim.setdefault(m.group(2), []).append((int(m.group(1)), float(m.group(3))))
            continue
        m = _KEY.search(line)
        if m:
            tr.keys.append((int(m.group(1)), m.group(2)))
            continue
        m = _FOCUS.search(line)
        if m:
            kv = dict(p.split("=", 1) for p in m.group(3).split() if "=" in p)
            tr.focus.append((int(m.group(1)), m.group(2), kv))
            continue
        m = _RING.search(line)
        if m:
            tr.ring.append((int(m.group(1)), m.group(2), m.group(3)))
    return tr


def _steps_after_key(tr: Trace, anim_id: str, align: str = "last"):
    """Steps of `anim_id` from the first one after the aligning key — the LAST key of the path
    by default (the one whose effect the state captures; the gaps between adb key presses are
    not reproducible, so earlier keys' animations are not compared), the FIRST for a burst
    (`traceFrom: "first"`). uptimeMs*1e6 ~ frameTimeNanos: both are CLOCK_MONOTONIC."""
    steps = tr.anim.get(anim_id, [])
    if not tr.keys or not steps:
        return steps, None
    key_ns = (tr.keys[0][0] if align == "first" else tr.keys[-1][0]) * 1_000_000
    after = [s for s in steps if s[0] >= key_ns]
    return (after if after else steps), key_ns


def _curve(steps):
    """[(t_ms since the first step, value)]"""
    t0 = steps[0][0]
    return [((t - t0) / 1e6, v) for t, v in steps]


def _at(curve, t):
    """Linear interpolation, clamped at both ends."""
    if t <= curve[0][0]:
        return curve[0][1]
    if t >= curve[-1][0]:
        return curve[-1][1]
    lo, hi = 0, len(curve) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if curve[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    (t0, v0), (t1, v1) = curve[lo], curve[hi]
    return v0 if t1 == t0 else v0 + (v1 - v0) * (t - t0) / (t1 - t0)


def _band(curve, t, slack):
    """(min, max) of the interpolated curve over [t - slack, t + slack]."""
    vals = [_at(curve, t - slack), _at(curve, t + slack)]
    vals += [v for tt, v in curve if t - slack <= tt <= t + slack]
    return min(vals), max(vals)


def _lag_ms(curve):
    """Time a spring's simulation fell behind real time: the part of each frame gap over 64 ms."""
    return sum(max(0.0, curve[i + 1][0] - curve[i][0] - 64.0) for i in range(len(curve) - 1))


def _settle_ms(curve, rng):
    """Time of the first step from which the value stays within 2e-3 x range of the rest value."""
    rest = curve[-1][1]
    for i in range(len(curve) - 1, -1, -1):
        if abs(curve[i][1] - rest) > 2 * TOL_FRACTION * rng:
            return curve[min(i + 1, len(curve) - 1)][0]
    return curve[0][0]


def _off_curve(ref, other, tol, slack=None):
    """First step of `other` that is not on `ref`'s curve; -> (index, t, value, lo, hi, err) or None. Also the worst err."""
    worst, first = 0.0, None
    for i, (t, v) in enumerate(other):
        lo, hi = _band(ref, t, TIME_SLACK_MS if slack is None else slack)
        err = max(lo - v, v - hi, 0.0)
        worst = max(worst, err)
        if err > tol and first is None:
            first = (i, t, v, lo, hi, err)
    return first, worst


def compare_rest(a: Trace, b: Trace, ids: list[str]) -> dict:
    """`"traceRule": "rest"` — for a key BURST only. The gaps between the presses of an adb
    burst are not reproducible (measured 2026-10-10: 114..357 ms between the presses of one
    `KEY*12@50` loop, different in every run), so the bent journey of a retargeted spring is
    a different curve every time, js against js included, and neither the curve rule nor the
    16.7 ms rest-time rule can be asked of it. What a burst must still agree on: the value
    each id comes to REST at (within 1e-3 x range, the same tolerance as the curve rule)
    and that both sides did animate. Everything else is reported, not judged."""
    out = {"pass": True, "ids": {}, "reasons": [], "rule": "rest", "tolerance": TOL_FRACTION}
    for anim_id in ids:
        sa, sb = a.anim.get(anim_id, []), b.anim.get(anim_id, [])
        rec = {"steps_a": len(sa), "steps_b": len(sb), "pass": True, "max_abs_err": 0.0, "first_bad_step": None}
        if not sa or not sb:
            rec["pass"] = False
            rec["reason"] = f"no [anim] steps for {anim_id} in " + ("A and B" if not sa and not sb else "A" if not sa else "B")
            out["reasons"].append(rec["reason"])
        else:
            va = [v for _, v in sa]
            rng = (max(va) - min(va)) or 1.0
            rec["range"], rec["rest_a"], rec["rest_b"] = rng, sa[-1][1], sb[-1][1]
            rec["max_abs_err"] = abs(sa[-1][1] - sb[-1][1])
            if a.keys and b.keys:
                rec["rest_ms_a"] = sa[-1][0] / 1e6 - a.keys[-1][0]
                rec["rest_ms_b"] = sb[-1][0] / 1e6 - b.keys[-1][0]
            if rec["max_abs_err"] > TOL_FRACTION * rng:
                rec["pass"] = False
                out["reasons"].append(f"{anim_id}: rest value A={sa[-1][1]:.6g} B={sb[-1][1]:.6g}")
        out["ids"][anim_id] = rec
        out["pass"] &= rec["pass"]
    return out


def compare(a: Trace, b: Trace, ids: list[str], retarget: bool = False, align: str = "last") -> dict:
    """-> {"pass": bool, "ids": {id: {...}}, "reasons": [...]}"""
    out = {"pass": True, "ids": {}, "reasons": [], "tolerance": TOL_FRACTION, "time_slack_ms": TIME_SLACK_MS,
           "duration_slack_ms": DURATION_SLACK_MS}
    for anim_id in ids:
        sa, ka = _steps_after_key(a, anim_id, align)
        sb, kb = _steps_after_key(b, anim_id, align)
        rec = {"steps_a": len(sa), "steps_b": len(sb), "pass": True, "max_abs_err": 0.0, "range": 0.0,
               "first_bad_step": None}
        if not sa or not sb:
            rec["pass"] = False
            rec["reason"] = f"no [anim] steps for {anim_id} in " + ("A and B" if not sa and not sb else "A" if not sa else "B")
            out["ids"][anim_id] = rec
            out["reasons"].append(rec["reason"])
            out["pass"] = False
            continue
        ca, cb = _curve(sa), _curve(sb)
        va = [v for _, v in ca]
        rng = (max(va) - min(va)) or 1.0
        rec["range"] = rng
        tol = TOL_FRACTION * rng
        rec["tolerance_abs"] = tol
        lag = _lag_ms(ca) + _lag_ms(cb)
        rec["lag_ms"] = lag
        slack = TIME_SLACK_MS + lag
        bad_b, worst_b = _off_curve(ca, cb, tol, slack)
        bad_a, worst_a = _off_curve(cb, ca, tol, slack)
        rec["max_abs_err"] = max(worst_a, worst_b)
        for who, bad in (("B", bad_b), ("A", bad_a)):
            if bad is not None:
                i, t, v, lo, hi, err = bad
                rec["pass"] = False
                rec["first_bad_step"] = rec["first_bad_step"] or {"side": who, "index": i, "t_ms": t, "value": v, "band": [lo, hi], "err": err}
                other = "A" if who == "B" else "B"
                out["reasons"].append(f"{anim_id}: {who} step {i} at {t:.1f} ms = {v:.6g}, off {other}'s curve "
                                      f"[{lo:.6g}, {hi:.6g}] within +-{slack:g} ms (|err| {err:.3g} > {tol:.3g})")
        rest_err = abs(ca[-1][1] - cb[-1][1])
        rec["rest_a"], rec["rest_b"] = ca[-1][1], cb[-1][1]
        if rest_err > tol:
            rec["pass"] = False
            out["reasons"].append(f"{anim_id}: rest value A={ca[-1][1]:.6g} B={cb[-1][1]:.6g}")
        rec["duration_ms_a"], rec["duration_ms_b"] = ca[-1][0], cb[-1][0]
        set_a, set_b = _settle_ms(ca, rng), _settle_ms(cb, rng)
        rec["settle_ms_a"], rec["settle_ms_b"] = set_a, set_b
        if abs(set_a - set_b) > DURATION_SLACK_MS + lag:
            rec["pass"] = False
            out["reasons"].append(f"{anim_id}: settle time A={set_a:.1f} ms B={set_b:.1f} ms (> {DURATION_SLACK_MS + lag:g} ms apart)")
        if ka is not None:
            rec["key_to_first_ms_a"] = (sa[0][0] - ka) / 1e6
        if kb is not None:
            rec["key_to_first_ms_b"] = (sb[0][0] - kb) / 1e6
        if retarget and ka is not None and kb is not None:
            rest_a = (sa[-1][0] - ka) / 1e6
            rest_b = (sb[-1][0] - kb) / 1e6
            rec["rest_ms_a"], rec["rest_ms_b"] = rest_a, rest_b
            if abs(rest_a - rest_b) > REST_TIME_SLACK_MS:
                rec["pass"] = False
                out["reasons"].append(f"{anim_id}: rest time A={rest_a:.1f}ms B={rest_b:.1f}ms (> {REST_TIME_SLACK_MS}ms)")
        out["ids"][anim_id] = rec
        out["pass"] &= rec["pass"]
    return out


def focus_table(tr: Trace) -> list[dict]:
    """The behaviour table of 02 §5: focus target after each key, as text-diffable rows."""
    rows = []
    keys = list(tr.keys)
    for t, ev, kv in tr.focus:
        last_key = next((k for k in reversed(keys) if k[0] <= t), None)
        rows.append({"after_key": last_key[1] if last_key else None, "event": ev, **kv, "_t": t})
    # ONE focus move is a loss and a gain. The JS Focusable logs them from its onBlur/onFocus
    # handlers, always loss first. The native one logs from View.onFocusChanged, and when the
    # element gaining focus is being MOUNTED (the rail's item as the panel opens) it takes focus
    # inside its still-detached subtree first and the old element is un-focused when that
    # subtree is attached, 1-2 frames later: "gain, loss" (seen 2026-10-10 with the JS rail and
    # the native rail alike — a property of the verified native Focusable, not of the rail).
    # The table is about WHERE focus goes, so a gain directly followed within 100 ms by the
    # loss of another element is written in the canonical order, loss first.
    i = 0
    while i + 1 < len(rows):
        g, l = rows[i], rows[i + 1]
        if g["event"] == "gain" and l["event"] == "loss" and g.get("tag") != l.get("tag") and 0 <= l["_t"] - g["_t"] <= 100:
            rows[i], rows[i + 1] = l, g
            i += 2
        else:
            i += 1
    for r in rows:
        del r["_t"]
    return rows


def _canon(rows):
    """The table with `impl` dropped and every purely numeric tag (a react tag: it names a
    view of ONE run, and the two implementations mount different numbers of views) replaced
    by the order in which the run first focused it — `#0`, `#1`, … — so "the same element
    again" still reads as the same name. nativeIDs / testIDs are kept as they are."""
    names, out = {}, []
    for r in rows:
        r = {k: v for k, v in r.items() if k != "impl"}
        tag = r.get("tag")
        if isinstance(tag, str) and tag.isdigit():
            r["tag"] = names.setdefault(tag, f"#{len(names)}")
        out.append(r)
    return out


def compare_focus(a: Trace, b: Trace) -> dict:
    """The tables agree when focus GOES to the same elements in the same order: the gain rows.
    Loss rows are written to the file but not compared - whether one is logged depends on the
    logger, not on the app: the JS Focusable cannot log the blur of an element that is being
    unmounted (the rail's item when OK closes the panel), the native one does."""
    ta, tb = focus_table(a), focus_table(b)
    gains = lambda rows: [r for r in _canon(rows) if r.get("event") == "gain"]
    same = gains(ta) == gains(tb)
    return {"pass": same, "rows_a": ta, "rows_b": tb,
            "reasons": [] if same else [f"focus table differs ({len(ta)} vs {len(tb)} rows)"]}


if __name__ == "__main__":  # python trace.py A.log B.log id1 id2 ...
    import sys
    a = parse(open(sys.argv[1], encoding="utf-8", errors="replace").read())
    b = parse(open(sys.argv[2], encoding="utf-8", errors="replace").read())
    print(json.dumps(compare(a, b, sys.argv[3:] or sorted(a.anim)), indent=2))
