#!/usr/bin/env python3
"""Where the RenderThread's CPU samples fall (docs/qa/native-bench/RENDER.md, part 1).
Input: `simpleperf report-sample --show-callchain -i perf.data -o samples.txt` of a recording made with
    adb shell simpleperf record --app com.auroratv.lab -e cpu-clock -f 2000 -g --duration 30 -o /data/local/tmp/x.data
(the lab manifest is profileable). Prints, for the RenderThread only: the share per stage (sync/prepareTree,
replaying display lists into Skia, the Skia flush = GL calls, swap), the replay split by canvas op, the flush
split by GrOp.   python tools/render-profile.py samples.txt"""
import sys, re
from collections import Counter
path=sys.argv[1]; frames_n=float(sys.argv[2]) if len(sys.argv)>2 else None
def samples(p):
    cur=None
    with open(p,encoding="utf-8",errors="replace") as f:
        for line in f:
            s=line.strip()
            if s=="sample:":
                if cur: yield cur
                cur={"thread":"", "chain":[], "files":[]}
            elif cur is not None:
                if s.startswith("thread_name:"): cur["thread"]=s[13:]
                elif s.startswith("symbol:"): cur["chain"].append(s[8:])
                elif s.startswith("file:"): cur["files"].append(s[6:])
    if cur: yield cur
stage=Counter(); ops=Counter(); flush=Counter(); walk=Counter(); tot=0; unroot=Counter(); prep=Counter()
def short(s):
    s=re.sub(r"\(.*","",s); return s[-70:]
for sm in samples(path):
    if sm["thread"]!="RenderThread": continue
    tot+=1
    ch=sm["chain"]  # leaf first
    joined=ch
    def has(x): return any(x in c for c in joined)
    if has("RenderNode::prepareTree"): st="1 sync: prepareTree"
    elif has("SkiaPipeline::renderFrame"): st="2 replay display lists into Skia (renderFrame)"
    elif has("flushAndSubmit") or has("GrDrawingManager::flush"): st="3 Skia flush (GL calls)"
    elif has("swapBuffers") or has("eglSwapBuffers") or has("queueBuffer"): st="4 swap/queueBuffer"
    elif has("DrawFrameTask"): st="5 other DrawFrameTask"
    elif has("RenderThread::threadLoop"): st="6 other RenderThread work"
    else:
        st="7 unrooted stack (%s)"%(sm["files"][0].split("/")[-1] if sm["files"] else "?")
    stage[st]+=1
    if st.startswith("2"):
        # deepest DisplayListData::draw = first occurrence from leaf side
        idx=next((i for i,c in enumerate(ch) if "DisplayListData::draw" in c), None)
        if idx is None or idx==0: ops["(tree walk: RenderNodeDrawable/DisplayListData self)"]+=1
        else:
            # frames below idx (towards leaf): ch[idx-1] is the op lambda, ch[idx-2] the SkCanvas call
            inner=ch[:idx][::-1]
            name=None
            for c in inner:
                if c.startswith("SkCanvas::") or "SkCanvas::" in c[:40]:
                    name=short(c); break
            if name is None: name=short(inner[0])
            if any("RenderNodeDrawable" in c or "SkDrawable::draw" in c or "ReorderBarrier" in c for c in inner[:3]) and not any(c.startswith("SkCanvas::draw") and "Drawable" not in c for c in inner):
                name="(tree walk: RenderNodeDrawable/ReorderBarrier/setViewProperties)"
            if any("drawShapeWithMaskFilter" in c or "BlurMaskFilter" in c or "SkMaskBlurFilter" in c for c in ch[:idx]): name+=" [blur mask filter]"
            ops[name]+=1
    if st.startswith("3"):
        name=None
        for c in ch:
            m=re.search(r"([A-Za-z0-9_:() ]*?)::(onExecute|onPrepareDraws|onPrepare|onPrePrepare)\(",c)
            if m: name=m.group(1).split("::")[-1]+"::"+m.group(2); break
        if name is None:
            for key in ("removeRenderTasks","GrResourceAllocator","submit","deleteOps","reorder","GrOnFlush","flushDeferred"):
                if has(key): name="("+key+")"; break
        flush[name or "(other flush)"]+=1
    if st.startswith("1"):
        prep[short(ch[0])]+=1
print("RenderThread samples:",tot)
def show(title,c,n=25):
    print("\n"+title)
    for k,v in c.most_common(n):
        extra=" = %.2f ms/frame"%(v*0.5/frames_n*SCALE) if frames_n else ""
        print("  %5.1f%%  %s%s"%(100*v/tot,k,extra))
SCALE=1.0
show("stage",stage); show("renderFrame by canvas op",ops,30); show("flush by GrOp",flush,20); show("prepareTree leaf",prep,8)
