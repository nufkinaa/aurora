#!/usr/bin/env python3
"""tools/tv-bench/tv-pool-bench.sh: adds the LONG-FRAME numbers to a run's JSON line.

    python tools/tv-bench/pool-parse.py '<json so far>' <last gfxinfo dump> <all dumps of the run, concatenated>

From the last dump's HISTOGRAM (every frame since `gfxinfo reset`, whatever the 120-frame table kept):
  h_frames, h_gt32, h_gt64   frames, and how many took longer than 32 / 64 ms (vsync -> GPU done)
  h_max                      the bucket of the longest frame, ms
From the per-frame rows of ALL dumps of the run, de-duplicated on the intended vsync (a long hold is read after
each of its motions, so these are all its frames; a short scenario has its last 120):
  f_n                        frames with a row
  f_max, f_gt32, f_gt64      the same three, exact, over those rows
  ui_max, ui_gt16/32/64      the UI thread's share: intended vsync -> the frame handed to the RenderThread
                             (late start + input + animation, which is where Fabric mounts, + layout + record)
  worst                      the five longest frames: [whole, late start, input, anim, layout, record, wait RT,
                             sync, issue, swap->done] in ms
"""
import sys, json, re

out = json.loads(sys.argv[1])
last = open(sys.argv[2], encoding="utf-8", errors="replace").read().replace("\r", "")
allt = open(sys.argv[3], encoding="utf-8", errors="replace").read().replace("\r", "")

m = re.search(r"^HISTOGRAM: (.*)$", last, re.M)
if m:
    h = [(int(a), int(b)) for a, b in re.findall(r"(\d+)ms=(\d+)", m.group(1))]
    out["h_frames"] = sum(n for _, n in h)
    out["h_gt32"] = sum(n for ms, n in h if ms > 32)
    out["h_gt64"] = sum(n for ms, n in h if ms > 64)
    out["h_max"] = max((ms for ms, n in h if n), default=None)

hdr = None
rows = {}
for line in allt.split("\n"):
    line = line.strip()
    if line.startswith("Flags,"):
        hdr = [x for x in line.split(",") if x]
        continue
    if hdr and line and line[0].isdigit():
        v = line.split(",")
        try:
            r = {hdr[i]: int(v[i]) for i in range(len(hdr))}
        except Exception:
            continue
        if r.get("FrameCompleted", 0) > 0 and r.get("IntendedVsync", 0) > 0:
            rows[r["IntendedVsync"]] = r
rows = [rows[k] for k in sorted(rows)]


def d(r, a, b):
    return (r[b] - r[a]) / 1e6 if r.get(a, 0) > 0 and r.get(b, 0) > 0 else 0.0


whole = [d(r, "IntendedVsync", "FrameCompleted") for r in rows]
ui = [d(r, "IntendedVsync", "SyncQueued") for r in rows]
out["f_n"] = len(rows)
if rows:
    out["f_max"] = round(max(whole), 1)
    out["f_gt32"] = sum(1 for x in whole if x > 32)
    out["f_gt64"] = sum(1 for x in whole if x > 64)
    out["ui_max"] = round(max(ui), 1)
    out["ui_gt16"] = sum(1 for x in ui if x > 16.7)
    out["ui_gt32"] = sum(1 for x in ui if x > 32)
    out["ui_gt64"] = sum(1 for x in ui if x > 64)
    worst = sorted(rows, key=lambda r: -d(r, "IntendedVsync", "FrameCompleted"))[:5]
    out["worst"] = [[round(x, 1) for x in (
        d(r, "IntendedVsync", "FrameCompleted"), d(r, "IntendedVsync", "HandleInputStart"),
        d(r, "HandleInputStart", "AnimationStart"), d(r, "AnimationStart", "PerformTraversalsStart"),
        d(r, "PerformTraversalsStart", "DrawStart"), d(r, "DrawStart", "SyncQueued"), d(r, "SyncQueued", "SyncStart"),
        d(r, "SyncStart", "IssueDrawCommandsStart"), d(r, "IssueDrawCommandsStart", "SwapBuffers"),
        d(r, "SwapBuffers", "FrameCompleted"))] for r in worst]
print(json.dumps(out))
sys.stderr.write(" ".join(f"{k}={out.get(k)}" for k in (
    "label", "scenario", "run", "frames", "p50", "p90", "p99", "janky_pct", "h_gt32", "h_gt64", "h_max", "f_n", "f_max",
    "ui_max", "ui_gt32", "pres_fps", "missed_per_1000", "rt_cpu", "pss_mb", "gpu_mb", "views")) + "\n")
