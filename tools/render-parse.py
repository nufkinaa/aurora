#!/usr/bin/env python3
"""One JSON line for tools/tv-render-bench.sh from a `dumpsys gfxinfo <pkg> framestats` dump.
    python tools/render-parse.py <dump.txt> label=<l> scenario=<s> run=<n> rt_ms=<RenderThread cpu ms> pss_mb=<n>
Fields: the gfxinfo summary (frames, janky %, p50..p99 — whole run), the frame-stage medians over the
frames the dump still holds (the last 120; same definitions as tools/frame-stages.py), GPU cache MB,
view count, and rt_cpu = RenderThread CPU ms per rendered frame."""
import sys, re, json, statistics as st

path = sys.argv[1]
kv = dict(a.split("=", 1) for a in sys.argv[2:])
text = open(path, encoding="utf-8", errors="replace").read().replace("\r", "")
out = {"label": kv.get("label", ""), "scenario": kv.get("scenario", ""), "run": int(kv.get("run", 1))}

def grab(rx, cast=float):
    m = re.search(rx, text, re.M)
    return cast(m.group(1)) if m else None

out["frames"] = grab(r"^Total frames rendered: (\d+)", int)
out["janky_pct"] = grab(r"^Janky frames: \d+ \(([0-9.]+)%\)")
for p in (50, 90, 95, 99):
    out[f"p{p}"] = grab(rf"^{p}th percentile: (\d+)ms", int)
rt_ms = float(kv.get("rt_ms", 0) or 0)
out["rt_cpu"] = round(rt_ms / out["frames"], 2) if out["frames"] else None
pss = kv.get("pss_mb", "")
out["pss_mb"] = int(pss) if pss.isdigit() else None
g = grab(r"Total GPU memory usage:\s*\n\s*(\d+) bytes", int)
out["gpu_mb"] = round(g / 1048576, 1) if g else None
out["views"] = grab(r"^\s*(\d+) views, ", int)

hdr = None
rows = []
for line in text.split("\n"):
    line = line.strip()
    if line.startswith("Flags,"):
        hdr = [h for h in line.split(",") if h]
        continue
    if hdr and line and line[0].isdigit():
        v = line.split(",")
        try:
            rows.append({hdr[i]: int(v[i]) for i in range(len(hdr))})
        except Exception:
            pass
rows = [r for r in rows if r.get("Flags", 0) == 0 and r.get("FrameCompleted", 0) > 0]
stages = {
    "ui": ("Vsync", "SyncQueued"),
    "wait": ("SyncQueued", "SyncStart"),
    "sync": ("SyncStart", "IssueDrawCommandsStart"),
    "issue": ("IssueDrawCommandsStart", "SwapBuffers"),
    "swap": ("SwapBuffers", "FrameCompleted"),
    "rt": ("SyncStart", "FrameCompleted"),
    "whole": ("IntendedVsync", "FrameCompleted"),
    # eglSwapBuffers itself; FrameCompleted is stamped when the GPU has finished the frame, so
    # "swap" above is mostly GPU time, not RenderThread time
    "swapcall": ("SwapBuffers", "SwapBuffersCompleted"),
    "gpu": ("SwapBuffers", "GpuCompleted"),
}
out["n"] = len(rows)
for key, (a, b) in stages.items():
    v = sorted((r[b] - r[a]) / 1e6 for r in rows if r.get(a, 0) > 0 and r.get(b, 0) > 0)
    if v:
        out[key + "_p50"] = round(st.median(v), 2)
        out[key + "_p90"] = round(v[int(len(v) * 0.9)], 2)
# time the RenderThread sat in dequeueBuffer waiting for a free buffer (inside "issue"), and issue minus it
dq = sorted(r["DequeueBufferDuration"] / 1e6 for r in rows if "DequeueBufferDuration" in r)
if dq:
    out["dequeue_p50"] = round(st.median(dq), 2)
    out["dequeue_p90"] = round(dq[int(len(dq) * 0.9)], 2)
    work = sorted((r["SwapBuffers"] - r["IssueDrawCommandsStart"] - r["DequeueBufferDuration"]) / 1e6 for r in rows
                  if r.get("SwapBuffers", 0) > 0 and r.get("IssueDrawCommandsStart", 0) > 0 and "DequeueBufferDuration" in r)
    if work:
        out["issuework_p50"] = round(st.median(work), 2)
        out["issuework_p90"] = round(work[int(len(work) * 0.9)], 2)
print(json.dumps(out))
