#!/usr/bin/env python3
"""tools/tv-present-bench.sh: one JSON line from the gfxinfo line, the presented-frames line and two
`time_in_state` readings (cpu_top_pct = share of the scenario at the top frequency, cpu_mhz = the mean),
plus tools/present-join.py's vsync-to-screen numbers when the two raw dumps are given.
    python tools/present-merge.py '<gfx json>' '<present json>' '<time_in_state before>' '<after>' [gfx-dump lat-dump]"""
import sys, json

g = json.loads(sys.argv[1])
g.update(json.loads(sys.argv[2]))
a = sys.argv[3].split()
b = sys.argv[4].split()
d = {int(a[i]): int(b[i + 1]) - int(a[i + 1]) for i in range(0, min(len(a), len(b)) - 1, 2)}
tot = sum(d.values())
if tot > 0:
    g["cpu_top_pct"] = round(100 * d[max(d)] / tot, 1)
    g["cpu_mhz"] = round(sum(k * v for k, v in d.items()) / tot / 1000)
if len(sys.argv) > 6:
    import importlib.util, os
    spec = importlib.util.spec_from_file_location("pj", os.path.join(os.path.dirname(os.path.abspath(__file__)), "present-join.py"))
    pj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pj)
    g.update(pj.measure(pj.join(sys.argv[5], sys.argv[6])))
print(json.dumps(g))
sys.stderr.write(" ".join(f"{k}={g.get(k)}" for k in (
    "label", "scenario", "run", "frames", "p50", "p90", "janky_pct", "rt_cpu", "whole_p50", "ui_p50", "dequeue_p50",
    "pres_fps", "missed_per_1000", "v2s_p50", "late1_pct", "late2_pct", "cpu_mhz")) + "\n")
