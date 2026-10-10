#!/usr/bin/env python3
"""Markdown table for tools/tv-render-bench.sh output: per configuration x scenario the MEDIAN over rounds of
RenderThread CPU ms/frame, the frame stages (issue GPU commands p50/p90, sync, swap, render-thread total),
gfxinfo p50/p90/janky and memory; deltas of RT CPU and issue p50 against the first label.
    python tools/render-report.py docs/qa/native-bench/r5-diag/base.jsonl docs/qa/native-bench/r5-diag/*.jsonl
The first label seen is the baseline (name base.jsonl first; later duplicates of a file are ignored)."""
import json, sys, statistics as st, glob

sys.stdout.reconfigure(encoding="utf-8")
files = []
for a in sys.argv[1:]:
    for f in (sorted(glob.glob(a)) or [a]):
        f = f.replace("\\", "/")
        if f not in files:
            files.append(f)
rows = [json.loads(l) for f in files for l in open(f, encoding="utf-8") if l.strip().startswith("{")]
labels = list(dict.fromkeys(r["label"] for r in rows))
scen = list(dict.fromkeys(r["scenario"] for r in rows))

def med(rs, k):
    v = [r[k] for r in rs if isinstance(r.get(k), (int, float))]
    return st.median(v) if v else None

def spread(rs, k):
    v = [r[k] for r in rs if isinstance(r.get(k), (int, float))]
    return f" ({min(v):.1f}–{max(v):.1f})" if len(v) > 1 and min(v) != max(v) else ""

def f(x, d=1):
    return "–" if x is None else f"{x:.{d}f}"

print("| config | scn | runs | RT CPU ms/frame | Δ vs base | issue p50 | issue p90 | of it dequeue wait p50 | issue work p50/p90 | sync p50 | GPU finish p50 | RT total p50/p90 | gfx p50/p90 | janky % | frames | PSS MB | GPU MB |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
KEYS = ("rt_cpu", "issue_p50", "issue_p90", "dequeue_p50", "issuework_p50", "issuework_p90", "gpu_p50", "sync_p50", "swap_p50", "rt_p50", "rt_p90", "p50", "p90", "janky_pct", "frames", "pss_mb", "gpu_mb")
for s in scen:
    base = None
    for lab in labels:
        rs = [r for r in rows if r["label"] == lab and r["scenario"] == s]
        if not rs:
            continue
        m = {k: med(rs, k) for k in KEYS}
        if base is None:
            base = m
            d1 = d2 = "–"
        else:
            d1 = f"{m['rt_cpu'] - base['rt_cpu']:+.1f} ({(m['rt_cpu'] / base['rt_cpu'] - 1) * 100:+.0f}%)"
            d2 = f"{m['issue_p50'] - base['issue_p50']:+.1f}"
        print(f"| {lab} | {s} | {len(rs)} | {f(m['rt_cpu'])}{spread(rs, 'rt_cpu')} | {d1} | {f(m['issue_p50'])} | {f(m['issue_p90'])} | {f(m['dequeue_p50'])} | {f(m['issuework_p50'])}/{f(m['issuework_p90'])} | {f(m['sync_p50'])} | {f(m['gpu_p50'] if m['gpu_p50'] is not None else m['swap_p50'])} | {f(m['rt_p50'])}/{f(m['rt_p90'])} | {f(m['p50'], 0)}/{f(m['p90'], 0)} | {f(m['janky_pct'])} | {f(m['frames'], 0)} | {f(m['pss_mb'], 0)} | {f(m['gpu_mb'], 0)} |")
