#!/usr/bin/env python3
"""Re-judge the [focus] tables of a finished run.py output directory from its saved logcats, with
trace.py as it is now (e.g. after `by_item` naming was added for the recycling shelf).

    python refocus.py <run-output-dir>

Prints, per state: run.py's stored verdict and reasons, the focus verdict recomputed, and whether the
state passes once the stored focus reason is replaced by the recomputed one. Changes no file."""
import json, sys
from pathlib import Path
import trace as tracemod

root = Path(sys.argv[1])
ok = bad = 0
for res in sorted(root.rglob("result.json")):
    d = res.parent
    r = json.loads(res.read_text(encoding="utf-8"))
    a = tracemod.parse((d / "A.logcat.txt").read_text(encoding="utf-8", errors="replace"))
    b = tracemod.parse((d / "B.logcat.txt").read_text(encoding="utf-8", errors="replace"))
    f = tracemod.compare_focus(a, b)
    other = [x for x in r.get("reasons", []) if not x.startswith("focus table differs")]
    reasons = other + (f["reasons"] if r.get("focus_checked") else [])
    gains = sum(1 for x in f["rows_a"] if x.get("event") == "gain")
    by = "item" if (a.pool and b.pool) else "tag"
    print(f"{str(d.relative_to(root)).replace(chr(92), '/'):34s} stored={'PASS' if r.get('pass') else 'FAIL'}  focus({by}, {gains} gains)={'ok' if f['pass'] else 'DIFFERS'}  "
          f"px={r.get('differing_px')}  now={'PASS' if not reasons else 'FAIL ' + '; '.join(reasons)}")
    ok += not reasons
    bad += bool(reasons)
print(f"\n{ok} pass, {bad} fail")
