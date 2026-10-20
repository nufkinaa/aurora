#!/usr/bin/env python3
"""stage-dist.py <raw dir> <label> [<label> ...] [--scn G1]: per label, the frames of all its runs (deduplicated per
run on IntendedVsync) and how the UI part is spread over the stages: share of frames whose animation stage (where
Fabric mounts AND the keyrate gate's moves run) exceeds 4/8/16 ms, late-start (main thread busy before the vsync)
over 4/8/16 ms, record > 4 ms, and the means."""
import sys, os, re, glob, statistics as st
_skip = {i + 1 for i, a in enumerate(sys.argv) if a == '--scn'}
args = [a for i, a in enumerate(sys.argv) if i > 0 and not a.startswith('--') and i not in _skip]
opt = {sys.argv[i][2:]: sys.argv[i+1] for i in range(1, len(sys.argv)-1) if sys.argv[i].startswith('--')}
scn = opt.get('scn', 'G1')
root = args[0]
def rows_of(path):
    hdr=None; rows={}
    for line in open(path, encoding='utf-8', errors='replace'):
        line=line.strip()
        if line.startswith('Flags,'): hdr=[h for h in line.split(',') if h]; continue
        if hdr and line and line[0].isdigit():
            v=line.split(',')
            try: r={hdr[i]:int(v[i]) for i in range(len(hdr))}
            except Exception: continue
            if r.get('FrameCompleted',0)>0 and r.get('IntendedVsync',0)>0 and r.get('Flags',0)==0: rows[r['IntendedVsync']]=r
    return list(rows.values())
def d(r,a,b): return (r[b]-r[a])/1e6 if r.get(a,0)>0 and r.get(b,0)>0 else 0.0
print(f"{'label':8s} {'runs':>4s} {'frames':>6s} | {'late>4':>6s} {'late>8':>6s} {'late>16':>7s} | {'anim>4':>6s} {'anim>8':>6s} {'anim>16':>7s} | {'lay>4':>5s} {'rec>4':>5s} | {'ui>16':>5s} {'ui>32':>5s} | {'whole>32':>8s} | mean late/anim/lay/rec ms")
for lab in args[1:]:
    files = sorted(glob.glob(os.path.join(root, f'{lab}-{scn}-*.gfx.txt')))
    R=[]
    for f in files: R += rows_of(f)
    if not R: print(lab, 'no rows'); continue
    late=[d(r,'IntendedVsync','HandleInputStart') for r in R]
    anim=[d(r,'AnimationStart','PerformTraversalsStart') for r in R]
    lay=[d(r,'PerformTraversalsStart','DrawStart') for r in R]
    rec=[d(r,'DrawStart','SyncQueued') for r in R]
    ui=[d(r,'IntendedVsync','SyncQueued') for r in R]
    whole=[d(r,'IntendedVsync','FrameCompleted') for r in R]
    n=len(R); pc=lambda xs,t: 100*sum(1 for x in xs if x>t)/n
    print(f"{lab:8s} {len(files):4d} {n:6d} | {pc(late,4):6.1f} {pc(late,8):6.1f} {pc(late,16):7.1f} | {pc(anim,4):6.1f} {pc(anim,8):6.1f} {pc(anim,16):7.1f} | {pc(lay,4):5.1f} {pc(rec,4):5.1f} | {pc(ui,16.7):5.1f} {pc(ui,32):5.1f} | {pc(whole,32):8.1f} | {st.mean(late):.2f}/{st.mean(anim):.2f}/{st.mean(lay):.2f}/{st.mean(rec):.2f}")
print()
print(f"{'label':8s} frames>32: n | mean whole / late / input / anim / layout / record / waitRT / sync / issue / swap->done  (ms)")
for lab in args[1:]:
    files = sorted(glob.glob(os.path.join(root, f'{lab}-{scn}-*.gfx.txt')))
    R=[]
    for f in files: R += rows_of(f)
    L=[r for r in R if d(r,'IntendedVsync','FrameCompleted')>32]
    if not L: continue
    keys=[('IntendedVsync','FrameCompleted'),('IntendedVsync','HandleInputStart'),('HandleInputStart','AnimationStart'),('AnimationStart','PerformTraversalsStart'),('PerformTraversalsStart','DrawStart'),('DrawStart','SyncQueued'),('SyncQueued','SyncStart'),('SyncStart','IssueDrawCommandsStart'),('IssueDrawCommandsStart','SwapBuffers'),('SwapBuffers','FrameCompleted')]
    means=[st.mean(d(r,a,b) for r in L) for a,b in keys]
    print(f"{lab:8s} {len(L):4d} | " + " / ".join(f"{m:.1f}" for m in means))
    if '--each' in sys.argv:
        for r in sorted(L, key=lambda r: r['IntendedVsync']):
            print('    ', " ".join(f"{d(r,a,b):5.1f}" for a,b in keys))
