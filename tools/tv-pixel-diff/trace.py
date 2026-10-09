#!/usr/bin/env python3
"""[anim] / [key] / [focus] trace parsing and the numeric A-vs-B comparison
(docs/native-rewrite/01-architecture.md §6, 02-verification.md §4.3, §5).

Line formats (the payload after logcat's own prefix; the tag does not matter):

    [anim] <frameTimeNanos> <id> <value>        one per driver step, id = nativeId.property
    [key]  <uptimeMs> <KEYCODE_NAME>              the receiver logs each `input keyevent` arrival
    [focus] <uptimeMs> gain tag=<id> impl=js|native edgeL=0|1 edgeR=0|1

Comparison per traced id (02 §4.3):
  * steps are taken from the first [anim] line after the first [key] line (if any key
    was logged; else from the start) and aligned by step index;
  * per aligned step |vA - vB| <= 1e-3 * range, range = max - min of A's values for that
    id (1.0 when A is flat);
  * total step count within +-1;
  * if `retarget` is set for the state, the rest time of the last step (frameTimeNanos of
    the final step minus the aligning key) must agree within 16.7 ms.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

TOL_FRACTION = 1e-3
STEP_COUNT_SLACK = 1
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


def _steps_after_key(tr: Trace, anim_id: str):
    """Steps of `anim_id` from the first one after the first key (uptimeMs*1e6 ~ frameTimeNanos:
    both are CLOCK_MONOTONIC on Android; uptimeMillis vs frameTimeNanos share the clock)."""
    steps = tr.anim.get(anim_id, [])
    if not tr.keys or not steps:
        return steps, None
    key_ns = tr.keys[0][0] * 1_000_000
    after = [s for s in steps if s[0] >= key_ns]
    return (after if after else steps), key_ns


def compare(a: Trace, b: Trace, ids: list[str], retarget: bool = False) -> dict:
    """-> {"pass": bool, "ids": {id: {...}}, "reasons": [...]}"""
    out = {"pass": True, "ids": {}, "reasons": [], "tolerance": TOL_FRACTION, "step_slack": STEP_COUNT_SLACK}
    for anim_id in ids:
        sa, ka = _steps_after_key(a, anim_id)
        sb, kb = _steps_after_key(b, anim_id)
        rec = {"steps_a": len(sa), "steps_b": len(sb), "pass": True, "max_abs_err": 0.0, "range": 0.0,
               "first_bad_step": None}
        if not sa or not sb:
            rec["pass"] = False
            rec["reason"] = f"no [anim] steps for {anim_id} in " + ("A" if not sa else "B")
            out["ids"][anim_id] = rec
            out["reasons"].append(rec["reason"])
            out["pass"] = False
            continue
        va = [v for _, v in sa]
        vb = [v for _, v in sb]
        rng = (max(va) - min(va)) or 1.0
        rec["range"] = rng
        tol = TOL_FRACTION * rng
        rec["tolerance_abs"] = tol
        n = min(len(va), len(vb))
        errs = [abs(va[i] - vb[i]) for i in range(n)]
        rec["max_abs_err"] = max(errs) if errs else 0.0
        bad = next((i for i, e in enumerate(errs) if e > tol), None)
        if bad is not None:
            rec["pass"] = False
            rec["first_bad_step"] = {"index": bad, "a": va[bad], "b": vb[bad], "err": errs[bad]}
            out["reasons"].append(f"{anim_id}: step {bad} A={va[bad]:.6g} B={vb[bad]:.6g} (|err| {errs[bad]:.3g} > {tol:.3g})")
        if abs(len(va) - len(vb)) > STEP_COUNT_SLACK:
            rec["pass"] = False
            out["reasons"].append(f"{anim_id}: step count A={len(va)} B={len(vb)} (slack {STEP_COUNT_SLACK})")
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
        rows.append({"after_key": last_key[1] if last_key else None, "event": ev, **kv})
    return rows


def compare_focus(a: Trace, b: Trace) -> dict:
    ta, tb = focus_table(a), focus_table(b)
    strip = lambda rows: [{k: v for k, v in r.items() if k != "impl"} for r in rows]
    same = strip(ta) == strip(tb)
    return {"pass": same, "rows_a": ta, "rows_b": tb,
            "reasons": [] if same else [f"focus table differs ({len(ta)} vs {len(tb)} rows)"]}


if __name__ == "__main__":  # python trace.py A.log B.log id1 id2 ...
    import sys
    a = parse(open(sys.argv[1], encoding="utf-8", errors="replace").read())
    b = parse(open(sys.argv[2], encoding="utf-8", errors="replace").read())
    print(json.dumps(compare(a, b, sys.argv[3:] or sorted(a.anim)), indent=2))
