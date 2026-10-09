#!/usr/bin/env python3
"""Turn tv-bench.sh JSON lines into a markdown table: per label × scenario, the median over runs
(and the spread, min–max) of frames, janky %, p50/p90/p99 frame ms, input-latency p50/p90 ms, PSS MB.
    python tools/bench-report.py docs/qa/.../bench-js.jsonl docs/qa/.../bench-F.jsonl
Labels are compared in the order given; a second label gets a Δ column against the first for p90 and janky %."""
import json, sys, statistics as st
sys.stdout.reconfigure(encoding="utf-8")  # the table has a few non-ASCII glyphs; Windows consoles default to a code page
rows = [json.loads(l) for f in sys.argv[1:] for l in open(f, encoding="utf-8") if l.strip().startswith("{")]
labels = list(dict.fromkeys(r["label"] for r in rows)); scen = list(dict.fromkeys(r["scenario"] for r in rows))
def med(vals):
    v = [x for x in vals if isinstance(x, (int, float))]
    return (st.median(v), min(v), max(v)) if v else (None, None, None)
def cell(m, d=0):
    return "–" if m[0] is None else (f"{m[0]:.{d}f}" + (f" ({m[1]:.{d}f}–{m[2]:.{d}f})" if m[1] != m[2] else ""))
print("| label | scenario | runs | frames | janky % | p50 ms | p90 ms | p99 ms | input p50 | input p90 | PSS MB | Δp90 | Δjank |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
base = {}
for s in scen:
    for lab in labels:
        rs = [r for r in rows if r["label"] == lab and r["scenario"] == s]
        if not rs: continue
        m = {k: med([r.get(k) for r in rs]) for k in ("frames", "janky_pct", "p50", "p90", "p99", "input_p50", "input_p90", "pss_mb")}
        if lab == labels[0]: base[s] = m; dp = dj = "–"
        else:
            b = base.get(s, {})
            dp = "–" if not b or b["p90"][0] is None or m["p90"][0] is None else f"{m['p90'][0]-b['p90'][0]:+.0f} ms ({(m['p90'][0]/b['p90'][0]-1)*100:+.0f}%)"
            dj = "–" if not b or b["janky_pct"][0] is None or m["janky_pct"][0] is None else f"{m['janky_pct'][0]-b['janky_pct'][0]:+.1f} pt"
        print(f"| {lab} | {s} | {len(rs)} | {cell(m['frames'])} | {cell(m['janky_pct'],1)} | {cell(m['p50'])} | {cell(m['p90'])} | {cell(m['p99'])} | {cell(m['input_p50'],1)} | {cell(m['input_p90'],1)} | {cell(m['pss_mb'])} | {dp} | {dj} |")
