#!/usr/bin/env python3
"""What the UI thread was doing INSIDE the long frames (docs/qa/native-bench/POOL.md, the anatomy).

    python tools/ui-profile.py <samples.txt> <gfxinfo framestats dump(s), concatenated> [--worst 8] [--min-ms 24]

samples.txt:  `simpleperf report-sample --show-callchain -i perf.data -o samples.txt` of a recording made WHILE
              the scenario ran:  adb shell simpleperf record --app com.auroratv.lab -e cpu-clock -f 2000 -g
              --clockid monotonic --duration N -o /data/local/tmp/ui.data      (the lab manifest is profileable)
gfx dump:     `dumpsys gfxinfo <pkg> framestats` read after each motion (tools/tv-pool-bench.sh keeps them with
              KEEP=1); its frame times are CLOCK_MONOTONIC too, so a sample can be put inside a frame.

A frame's UI part runs from the moment the UI thread could have started it (IntendedVsync) to the moment it hands
the frame to the RenderThread (SyncQueued). For the frames whose UI part is longest (and longer than --min-ms)
the main thread's samples that fall inside that window are sorted into what they were doing, by the innermost
frame of the call chain that names one of the buckets below. Samples are CPU time: a window that is 80 ms long
and holds 40 ms of samples spent the rest waiting (for the RenderThread, a lock, the scheduler).
The profiler slows the app (about x2 on this TV), so read the SHARES, not the milliseconds.
"""
import sys, re, json
from collections import Counter, defaultdict

args = [a for a in sys.argv[1:] if not a.startswith("--")]
opt = {sys.argv[i][2:]: sys.argv[i + 1] for i in range(1, len(sys.argv) - 1) if sys.argv[i].startswith("--")}
WORST = int(opt.get("worst", 8))
MIN_MS = float(opt.get("min-ms", 24))
sys.stdout.reconfigure(encoding="utf-8")

# innermost-first matching: the first bucket whose pattern appears in a frame of the chain, walking from the leaf
BUCKETS = [
    ("text: layout / measure of a <Text>", r"TextLayoutManager|StaticLayout|BoringLayout|ReactTextView|PreparedLayout|android\.text\.|minikin|TextLine|MeasuredText|hb_shape|Typeface"),
    ("image: Fresco request / attach / drawable", r"fresco|drawee|imagepipeline|AuroraImages|AuroraCardView\.(submit|request|restartPicture|applyProps)|DraweeHolder"),
    ("Fabric mount: create view", r"createView|createViewInstance|preallocateView|ViewManager\.createView"),
    ("Fabric mount: delete view", r"deleteView|onDropViewInstance|ViewManager\.onDropView"),
    ("Fabric mount: insert / remove child", r"addViewAt|removeViewAt|ViewGroupManager\.addView|ViewGroupManager\.removeView|removeDeleteTreeAt"),
    ("Fabric mount: props", r"updateProps|ViewManagerPropertyUpdater|setProperty|ReactStylesDiffMap|PropSetter|onAfterUpdateTransaction|ReadableNativeMap|getMapBuffer|MapBuffer"),
    ("Fabric mount: layout / state / event emitter / other", r"updateLayout|updateState|updateEventEmitter|updatePadding|updateOverflowInset|IntBufferBatchMountItem|MountItemDispatcher|SurfaceMountingManager|FabricUIManager|scheduleMountItem"),
    ("focus: search / change / ring", r"FocusFinder|focusSearch|requestFocus|requestChildFocus|onFocusChanged|handleFocusGain|clearFocus|addFocusables|AuroraFocusableView"),
    ("measure + layout traversal (Android)", r"performMeasure|performLayout|\.measure\b|\.layout\b|onMeasure|onLayout|requestLayout"),
    ("record display lists (draw traversal)", r"updateDisplayListIfDirty|RecordingCanvas|dispatchDraw|drawChild|ViewRootImpl\.draw|performDraw|onDraw|RenderNode|getChildDrawingOrder|PoolHost|Cull"),
    ("sync with the RenderThread (blocked or copying)", r"nSyncAndDrawFrame|syncAndDrawFrame|DrawFrameTask|RenderProxy"),
    ("animation drivers (AuroraClock / RN animated)", r"AuroraClock|AuroraSpring|AuroraTiming|NativeAnimated|AnimatedNode|ValueAnimator"),
    ("events to JS (dispatch / JNI)", r"EventDispatcher|dispatchEvent|EventEmitterWrapper|FabricEventEmitter|invoke.*Event|RowItemFocusEvent"),
    ("input pipeline", r"InputEventReceiver|deliverInputEvent|ViewPostImeInputStage|processKeyEvent|dispatchKeyEvent|InputStage"),
    ("garbage collection / allocation", r"art::gc|ConcurrentCopying|Heap::|AllocObject|MarkCompact"),
    ("JIT / interpreter / class init", r"art::jit|ExecuteSwitch|artQuickToInterpreterBridge|ClassLinker|art::interpreter|nterp"),
    ("binder / system calls", r"IPCThreadState|BinderProxy|binder_|android\.os\.Parcel"),
    ("Choreographer / looper glue", r"Choreographer|MessageQueue|Looper|Handler\.dispatch"),
]
BUCKETS = [(n, re.compile(p)) for n, p in BUCKETS]


def samples(path):
    cur = None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            s = line.strip()
            if s == "sample:":
                if cur:
                    yield cur
                cur = {"thread": "", "time": 0, "tid": -1, "pid": -2, "chain": []}
            elif cur is not None:
                if s.startswith("thread_name:"):
                    cur["thread"] = s[13:]
                elif s.startswith("time:"):
                    cur["time"] = int(s[5:].strip())
                elif s.startswith("thread_id:"):
                    cur["tid"] = int(s[10:].strip())
                elif s.startswith("process_id:") or s.startswith("pid:"):
                    cur["pid"] = int(s.split(":")[1].strip())
                elif s.startswith("symbol:"):
                    cur["chain"].append(s[8:])
    if cur:
        yield cur


def bucket(chain):
    for sym in chain:  # leaf first
        for name, rx in BUCKETS:
            if rx.search(sym):
                return name
    return "other"


def frames(path):
    hdr = None
    rows = {}
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if line.startswith("Flags,"):
            hdr = [h for h in line.split(",") if h]
            continue
        if hdr and line and line[0].isdigit():
            v = line.split(",")
            try:
                r = {hdr[i]: int(v[i]) for i in range(len(hdr))}
            except Exception:
                continue
            if r.get("FrameCompleted", 0) > 0 and r.get("IntendedVsync", 0) > 0 and r.get("SyncQueued", 0) > 0:
                rows[r["IntendedVsync"]] = r
    return [rows[k] for k in sorted(rows)]


main = [s for s in samples(args[0]) if s["tid"] == s["pid"] or s["thread"].endswith("auroratv.lab")]
if not main:
    sys.exit("no main-thread samples (thread names seen: check report-sample output)")
main.sort(key=lambda s: s["time"])
times = [s["time"] for s in main]
period_ms = None
if len(times) > 50:
    gaps = sorted(b - a for a, b in zip(times, times[1:]) if b > a)
    period_ms = gaps[len(gaps) // 10] / 1e6  # the sampling period: the short end of the gaps
fr = frames(args[1])
print(f"main-thread samples: {len(main)} (period ~{period_ms:.2f} ms); frames with a row: {len(fr)}")
if not fr:
    sys.exit(0)
import bisect


def inside(a, b):
    return main[bisect.bisect_left(times, a): bisect.bisect_right(times, b)]


def ui_ms(r):
    return (r["SyncQueued"] - r["IntendedVsync"]) / 1e6


def table(title, sel):
    c = Counter(bucket(s["chain"]) for s in sel)
    n = sum(c.values())
    print(f"\n{title}: {n} samples" + (f" = {n * period_ms:.0f} ms of CPU" if period_ms else ""))
    for k, v in c.most_common():
        print(f"  {100 * v / n:5.1f} %  {k}")
    return c


allin = []
for r in fr:
    allin += inside(r["IntendedVsync"], r["SyncQueued"])
table("every frame's UI part, the whole recording", allin)
long = sorted([r for r in fr if ui_ms(r) >= MIN_MS], key=lambda r: -ui_ms(r))
print(f"\nframes whose UI part took >= {MIN_MS:.0f} ms: {len(long)} of {len(fr)}")
sel = []
for r in long:
    sel += inside(r["IntendedVsync"], r["SyncQueued"])
if sel:
    table(f"inside those {len(long)} long UI parts", sel)
for r in long[:WORST]:
    s = inside(r["IntendedVsync"], r["SyncQueued"])
    late = (r["HandleInputStart"] - r["IntendedVsync"]) / 1e6
    anim = (r["PerformTraversalsStart"] - r["AnimationStart"]) / 1e6
    lay = (r["DrawStart"] - r["PerformTraversalsStart"]) / 1e6
    rec = (r["SyncQueued"] - r["DrawStart"]) / 1e6
    whole = (r["FrameCompleted"] - r["IntendedVsync"]) / 1e6
    c = Counter(bucket(x["chain"]) for x in s)
    n = sum(c.values()) or 1
    print(f"\nframe @{r['IntendedVsync'] // 1000000} ms: whole {whole:.0f} ms; UI part {ui_ms(r):.0f} ms = started {late:.0f} late"
          f" + callbacks {anim:.0f} + layout {lay:.0f} + record {rec:.0f}; {len(s)} samples"
          + (f" ({len(s) * period_ms:.0f} ms on CPU)" if period_ms else ""))
    for k, v in c.most_common(6):
        print(f"    {100 * v / n:5.1f} %  {k}")
    # the hottest leaf-side symbols of this frame, for the bucket "other" and as a sanity check
    leaf = Counter(re.sub(r"\(.*", "", x["chain"][0])[-80:] if x["chain"] else "?" for x in s)
    print("    hottest leaves: " + "; ".join(f"{k} x{v}" for k, v in leaf.most_common(4)))
