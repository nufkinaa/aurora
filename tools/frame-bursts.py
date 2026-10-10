#!/usr/bin/env python3
"""Frame by frame through each motion of a `dumpsys gfxinfo <pkg> framestats` dump (the last 120 frames).

    python tools/frame-bursts.py <dump.txt> [first-N-frames-per-motion, default 10]

A motion = frames whose intended vsyncs are at most 6 periods apart. Per frame, in ms after ITS OWN vsync:
  vs      refreshes since the previous frame's vsync (1 = the next one; 2 = the app made no frame for one)
  start   when the UI thread began the frame (HandleInputStart) - late when it was still blocked in the last one
  queued  when it handed the frame to the RenderThread (SyncQueued)
  sync    when the RenderThread took it (SyncStart); queued -> sync is the UI thread blocked behind the last frame
  dq      ms the RenderThread then waited in dequeueBuffer for a free buffer
  work    issue-draw-commands minus that wait
  swap    when it queued the buffer (SwapBuffers)
  gpu     when the GPU had finished it
  dl      the deadline the system gave the frame (FrameDeadline)
and a summary per motion: the median "start" and "swap" of its frames, and the state it settled in.
"""
import sys, statistics as st

sys.stdout.reconfigure(encoding="utf-8")
path = sys.argv[1]
first = int(sys.argv[2]) if len(sys.argv) > 2 else 10
hdr = None
rows = []
for line in open(path, encoding="utf-8", errors="replace"):
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
rows = [r for r in rows if r.get("FrameCompleted", 0) > 0 and r.get("IntendedVsync", 0) > 0]
seen = set()
uniq = []
for r in rows:
    if r["IntendedVsync"] in seen:
        continue
    seen.add(r["IntendedVsync"])
    uniq.append(r)
rows = sorted(uniq, key=lambda r: r["IntendedVsync"])
P = 16.683333
motions = []
for r in rows:
    if motions and (r["IntendedVsync"] - motions[-1][-1]["IntendedVsync"]) / 1e6 <= 6 * P + 1:
        motions[-1].append(r)
    else:
        motions.append([r])


def rel(r, k):
    return (r[k] - r["IntendedVsync"]) / 1e6 if r.get(k, 0) > 0 else float("nan")


for i, m in enumerate(motions):
    if len(m) < 4:
        continue
    starts = [rel(r, "HandleInputStart") for r in m[3:]] or [float("nan")]
    swaps = [rel(r, "SwapBuffers") for r in m[3:]] or [float("nan")]
    dqs = [r.get("DequeueBufferDuration", 0) / 1e6 for r in m[3:]] or [0]
    s50, w50, d50 = st.median(starts), st.median(swaps), st.median(dqs)
    state = "UI a frame behind" if s50 > 5 else ("buffer queued" if d50 > 3 else "shallow")
    print(f"motion {i + 1}: {len(m)} frames; after its 3rd frame: start p50 {s50:.1f}, dequeue wait p50 {d50:.1f}, swap p50 {w50:.1f}  -> {state}")
    print("   #  flags vs  start queued   sync    dq  work   swap    gpu     dl")
    prev = None
    for j, r in enumerate(m[:first]):
        vs = 0 if prev is None else round((r["IntendedVsync"] - prev) / 1e6 / P)
        prev = r["IntendedVsync"]
        dq = r.get("DequeueBufferDuration", 0) / 1e6
        work = (r["SwapBuffers"] - r["IssueDrawCommandsStart"]) / 1e6 - dq
        print(f"  {j + 1:2d}  {r.get('Flags', 0):4d} {vs:2d} {rel(r, 'HandleInputStart'):6.1f} {rel(r, 'SyncQueued'):6.1f} {rel(r, 'SyncStart'):6.1f} "
              f"{dq:5.1f} {work:5.1f} {rel(r, 'SwapBuffers'):6.1f} {rel(r, 'GpuCompleted'):6.1f} {rel(r, 'FrameDeadline'):6.1f}")
