#!/usr/bin/env python3
"""Where a frame's time goes: reads `dumpsys gfxinfo <pkg> framestats` on stdin and prints, per stage, the
median / p90 ms over the frames in the dump.  Stages (android FrameInfo): input, animation, traversal
(measure+layout), draw (record display list), wait-for-sync, sync (upload to RenderThread), GPU commands issue,
swap, then GPU completion; plus `vsync delay` = how late the UI thread started after the intended vsync
(time the main thread was busy with something else, e.g. Fabric mounting or JS-driven work)."""
import sys, statistics as st
sys.stdout.reconfigure(encoding="utf-8")
hdr=None; rows=[]
for line in sys.stdin:
    line=line.strip()
    if line.startswith("Flags,"): hdr=[h for h in line.split(",") if h]; continue
    if hdr and line and line[0].isdigit():
        v=line.split(",")
        try: rows.append({hdr[i]:int(v[i]) for i in range(len(hdr))})
        except Exception: pass
rows=[r for r in rows if r.get("Flags",0)==0 and r["FrameCompleted"]>0]
def ms(a,b): return [(r[b]-r[a])/1e6 for r in rows if r.get(a,0)>0 and r.get(b,0)>0]
stages=[("vsync delay (main thread late)","IntendedVsync","Vsync"),("input","HandleInputStart","AnimationStart"),
 ("animation","AnimationStart","PerformTraversalsStart"),("measure+layout","PerformTraversalsStart","DrawStart"),
 ("draw (record)","DrawStart","SyncQueued"),("wait for render thread","SyncQueued","SyncStart"),
 ("sync/upload","SyncStart","IssueDrawCommandsStart"),("issue GPU commands","IssueDrawCommandsStart","SwapBuffers"),
 ("swap buffers","SwapBuffers","FrameCompleted"),("UI thread total","Vsync","SyncQueued"),
 ("render thread total","SyncStart","FrameCompleted"),("whole frame","IntendedVsync","FrameCompleted"),
 ("GPU finish after swap","FrameCompleted","GpuCompleted")]
print(f"frames: {len(rows)}")
for name,a,b in stages:
    v=ms(a,b)
    if not v: continue
    v.sort(); print(f"{name:32s} p50 {st.median(v):6.1f}   p90 {v[int(len(v)*0.9)]:6.1f}   max {v[-1]:6.1f}")
