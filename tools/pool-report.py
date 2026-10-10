#!/usr/bin/env python3
"""Markdown tables for tools/tv-pool-bench.sh output.

    python tools/pool-report.py <dir> [label ...]        (labels in the order given; default: every *.jsonl)

Per scenario x configuration, over the rounds: the MEDIAN of each number, and for the long-frame counts also the
TOTAL over all rounds (a p99 of one run is one or two frames; the count over four runs is the steadier number).
Then the worst frame of every run, taken apart by stage.
"""
import json, sys, statistics as st, glob, os

sys.stdout.reconfigure(encoding="utf-8")
d = sys.argv[1]
labels = sys.argv[2:] or [os.path.basename(f)[:-6] for f in sorted(glob.glob(os.path.join(d, "*.jsonl")))]
rows = []
for lab in labels:
    p = os.path.join(d, lab + ".jsonl")
    if os.path.exists(p):
        rows += [json.loads(l) for l in open(p, encoding="utf-8") if l.strip().startswith("{")]
scen = [s for s in ("S1", "L1", "S3", "G1", "S2", "S4") if any(r["scenario"] == s for r in rows)]


def vals(rs, k):
    return [r[k] for r in rs if isinstance(r.get(k), (int, float))]


def med(rs, k, dgt=0):
    v = vals(rs, k)
    return "–" if not v else f"{st.median(v):.{dgt}f}"


def tot(rs, k):
    v = vals(rs, k)
    return "–" if not v else str(sum(v))


def mx(rs, k, dgt=0):
    v = vals(rs, k)
    return "–" if not v else f"{max(v):.{dgt}f}"


def rng(rs, k, dgt=0):
    v = vals(rs, k)
    return "–" if not v else f"{min(v):.{dgt}f}–{max(v):.{dgt}f}"


print("| scn | config | runs | frames | p50 / p90 / p99 ms | p99 per run | longest frame ms: median (worst run) | frames > 32 ms: median (total) | frames > 64 ms: median (total) | janky % | presented fps | refreshes without a new frame /1000 | UI thread held a frame > 32 / > 64 ms (total) | longest UI hold ms: median (worst) | RT CPU ms/frame | UI CPU ms/frame | PSS MB | GPU MB | views |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for s in scen:
    for lab in labels:
        rs = [r for r in rows if r["label"] == lab and r["scenario"] == s]
        if not rs:
            continue
        exact = all(r.get("f_n", 0) >= 0.97 * (r.get("h_frames") or 1) for r in rs)  # every frame has a row
        fmax, g32, g64 = ("f_max", "f_gt32", "f_gt64") if exact else ("h_max", "h_gt32", "h_gt64")
        uic = [r["ui_cpu_ms"] / r["frames"] for r in rs if isinstance(r.get("ui_cpu_ms"), (int, float)) and r.get("frames")]
        ui = f"{tot(rs, 'ui_gt32')} / {tot(rs, 'ui_gt64')}" + ("" if exact else " (last 120 frames of each run)")
        print(f"| {s} | {lab} | {len(rs)} | {med(rs, 'frames')} | {med(rs, 'p50')} / {med(rs, 'p90')} / {med(rs, 'p99')} | "
              f"{' '.join(str(v) for v in vals(rs, 'p99'))} | {med(rs, fmax)} ({mx(rs, fmax)}) | {med(rs, g32)} ({tot(rs, g32)}) | "
              f"{med(rs, g64)} ({tot(rs, g64)}) | {med(rs, 'janky_pct', 1)} | {med(rs, 'pres_fps', 1)} | {med(rs, 'missed_per_1000', 1)} ({rng(rs, 'missed_per_1000')}) | "
              f"{ui} | {med(rs, 'ui_max')} ({mx(rs, 'ui_max')}) | {med(rs, 'rt_cpu', 1)} | {st.median(uic):.1f} | "
              f"{med(rs, 'pss_mb')} | {med(rs, 'gpu_mb')} | {med(rs, 'views')} |" if uic else "")

print()
print("Worst frame of each run (ms): whole = vsync → GPU done; then where it went.")
print()
print("| scn | config | run | whole | UI thread started late | input | animation (Fabric mounts run here) | layout | record | waits for RenderThread | sync | issue | swap → done |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for s in scen:
    for lab in labels:
        for r in [r for r in rows if r["label"] == lab and r["scenario"] == s]:
            w = (r.get("worst") or [None])[0]
            if w:
                print(f"| {s} | {lab} | {r['run']} | " + " | ".join(f"{x:.0f}" for x in w) + " |")
