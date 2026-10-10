#!/usr/bin/env python3
"""Supplementary to trace.py's curve rule, for the nav rail's 280 ms timing (NOT a pass rule).

The curve rule compares value-vs-TIME, and the JS side's [anim] lines are stamped when they
arrive at the native module. The rail's opening and closing both re-render React (the panel
mounts / its items go unfocusable), so the JS run's lines arrive in a clump 100-150 ms late
and the rule fails on the time stamps. What can be checked without the stamps:

  * every value either side logs is a FRAME of the same table (RN's own pre-sampled
    `Animated.timing` frames for 280 ms bezier(0.2, 0.7, 0.2, 1) — rail-fixtures.json
    /slide/frames), walked in order, from the same start to the same end;
  * the time from the key to the LAST step (the frame the slide ends on) — the one stamp of the
    JS run that is not clumped, since nothing is rendering by then.

usage: python frame_table_check.py <out>/traces/navrail.*.json
"""
import json, sys
from pathlib import Path

FIX = Path(__file__).resolve().parent.parent.parent / "tv-native/android/app/src/test/resources/rail-fixtures.json"
FRAMES = json.loads(FIX.read_text(encoding="utf-8"))["slide"]["frames"]


def frames_of(steps):
    """-> (list of frame indices or None if a value is off the table, start, end)"""
    vals = [v for _, v in steps]
    a, b = vals[0], vals[-1]
    out = []
    for v in vals:
        k = next((i for i, f in enumerate(FRAMES) if abs(a + (b - a) * f - v) < 2e-6), None)
        out.append(k)
    return out, a, b


rows = []
for path in sys.argv[1:]:
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    if "rail.slide" not in (d.get("ids") or []):
        continue
    rec = {"state": d["state"]}
    for side in "AB":
        keys = d[side]["keys"]
        k_ns = keys[-1][0] * 1_000_000 if keys else 0
        steps = [s for s in d[side]["anim"].get("rail.slide", []) if s[0] >= k_ns]
        idx, a, b = frames_of(steps)
        rec[side] = {"from": a, "to": b, "on_table": all(i is not None for i in idx),
                     "monotonic": all(x <= y for x, y in zip([i for i in idx if i is not None], [i for i in idx if i is not None][1:])),
                     "frames": idx, "key_to_end_ms": round((steps[-1][0] - k_ns) / 1e6, 1) if keys else None}
    rows.append(rec)
print("| state | A from->to | B from->to | all values on RN's frame table (A / B) | key -> last step ms (A / B) |")
print("|---|---|---|---|---|")
for r in rows:
    A, B = r["A"], r["B"]
    print(f"| {r['state']} | {A['from']:g}->{A['to']:g} | {B['from']:g}->{B['to']:g} | "
          f"{'yes' if A['on_table'] and A['monotonic'] else 'NO'} / {'yes' if B['on_table'] and B['monotonic'] else 'NO'} | "
          f"{A['key_to_end_ms']} / {B['key_to_end_ms']} |")
