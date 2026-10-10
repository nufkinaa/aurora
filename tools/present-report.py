#!/usr/bin/env python3
"""Markdown table for tools/tv-present-bench.sh output: per configuration x scenario the MEDIAN over rounds.
    python tools/present-report.py <dir>/first.jsonl <dir>/*.jsonl        (the first label seen leads each block)
Columns: what the viewer got (frames per second while something moves, vsyncs without a new frame per 1000,
from a frame's vsync to the screen and the share shown late), then gfxinfo's numbers, then the work."""
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
scen = sorted(set(r["scenario"] for r in rows))


def med(rs, k):
    v = [r[k] for r in rs if isinstance(r.get(k), (int, float))]
    return st.median(v) if v else None


def rng(rs, k, d=0):
    v = [r[k] for r in rs if isinstance(r.get(k), (int, float))]
    return f"{min(v):.{d}f}–{max(v):.{d}f}" if v else "–"


def f(x, d=1):
    return "–" if x is None else f"{x:.{d}f}"


print("| config | scn | runs | presented fps in motion | vsyncs without a new frame /1000 (range) | vsync → screen p50 / p90 ms (31.4 = straight through) | frames shown ≥1 / ≥2 refreshes late % | gfx p50 (range) / p90 / p99 | janky % | whole frame p50 | UI start→sync queued p50 | dequeue wait p50 | RT CPU ms/frame | CPU mean MHz / % at top | PSS MB | held vsyncs per run |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for s in scen:
    for lab in labels:
        rs = [r for r in rows if r["label"] == lab and r["scenario"] == s]
        if not rs:
            continue
        m = lambda k: med(rs, k)
        print(f"| {lab} | {s} | {len(rs)} | {f(m('pres_fps'))} | {f(m('missed_per_1000'))} ({rng(rs, 'missed_per_1000')}) | "
              f"{f(m('v2s_p50'))} / {f(m('v2s_p90'))} | {f(m('late1_pct'), 0)} / {f(m('late2_pct'), 0)} | {f(m('p50'), 0)} ({rng(rs, 'p50')}) / {f(m('p90'), 0)} / {f(m('p99'), 0)} | "
              f"{f(m('janky_pct'))} | {f(m('whole_p50'))} | {f(m('ui_p50'))} | {f(m('dequeue_p50'))} | {f(m('rt_cpu'))} | "
              f"{f(m('cpu_mhz'), 0)} / {f(m('cpu_top_pct'), 0)} | {f(m('pss_mb'), 0)} | {f(m('skips'), 0)} |")
