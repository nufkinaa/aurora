#!/bin/bash
# Render-thread bench for the lab app (docs/qa/native-bench/RENDER.md): interleaved rounds over
# EXPERIMENT configurations (AuroraExp.kt, `cmd exp`), the implementation fixed (default: all native).
#   tools/tv-render-bench.sh <outdir> <rounds> <label=exp-arg> ...
#   e.g. tools/tv-render-bench.sh docs/qa/native-bench/r5-fix 3 base=none cull=cull=1 both=cull=1,bake=1
#   env: SCENARIOS="S1 S2" (the default; S3 S4 as in tv-bench.sh), IMPL="all=js,focusable=native,..."
# Per run (a cold start, as tv-bench.sh): gfxinfo reset, the keys, then one JSON line (tools/render-parse.py):
# the gfxinfo percentiles of the run, the frame-stage medians of its last 120 frames, memory, and
#   rt_cpu = RenderThread CPU ms per rendered frame (utime+stime of that thread over the run / frames),
# the one number here that does not depend on when a frame happened to be queued.
# Leaves the app with `exp none`. Refuses to start beside another bench or pixel-diff run.
set -u
export MSYS_NO_PATHCONV=1
ADB=${ADB:-/c/elia/android-tools/sdk/platform-tools/adb.exe}; PKG=com.auroratv.lab
HERE="$(cd "$(dirname "$0")" && pwd)"
PARSE="$(cygpath -m "$HERE/render-parse.py" 2>/dev/null || echo "$HERE/render-parse.py")"
OUT=$1; ROUNDS=$2; shift 2; mkdir -p "$OUT"
IMPL=${IMPL:-all=js,focusable=native,card=native,row=native,hero=native,rail=native}
others=$(ps -ef | grep -E "tv-bench\.sh|tv-pixel-diff/run\.py|tv-bench-matrix\.sh" | grep -v grep | wc -l)
[ "$others" -gt 0 ] && { echo "another bench/diff process is running ($others) - refusing"; exit 2; }
A() { timeout 90 "$ADB" "$@"; }
Q() { A shell am broadcast -n $PKG/com.auroratv.ui.qa.QaReceiver -a com.auroratv.QA --es token aurora-lab-qa --es cmd "$1" --es arg "$2" --es rid $RANDOM >/dev/null; }
keys() { local k=$1 n=$2 gap=$3 cmd="" q; for ((q=0;q<n;q++)); do cmd+="input keyevent $k; sleep $(awk "BEGIN{print $gap/1000}"); "; done; A shell "$cmd" >/dev/null; }
home() { A shell am force-stop $PKG; sleep 1; A shell am start -n $PKG/com.auroratv.MainActivity -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER >/dev/null 2>&1; sleep ${WARM_S:-10}; }
drive() {
  local j
  case $1 in
    S1) keys DPAD_DOWN 1 400; keys DPAD_RIGHT 20 50; sleep 1; keys DPAD_LEFT 20 50; sleep 0.8; keys DPAD_UP 1 400;;
    S2) keys DPAD_DOWN 8 400; keys DPAD_UP 8 400;;
    S3) keys DPAD_LEFT 1 600; keys DPAD_DOWN 1 400; keys DPAD_CENTER 1 2500; keys DPAD_DOWN 12 300; keys DPAD_RIGHT 5 50; sleep 0.5; keys BACK 1 800;;
    S4) for ((j=0;j<5;j++)); do keys DPAD_LEFT 1 600; keys DPAD_RIGHT 1 600; done;;
  esac
}
# RenderThread utime+stime in ms (USER_HZ 100)
rtcpu() { A shell "for t in /proc/$1/task/*; do read -r l < \$t/stat; echo \$l; done" 2>/dev/null | tr -d '\r' | awk '/\(RenderThread\)/ {print ($14+$15)*10}'; }
TMP="$OUT/.dump.txt"
Q freeze off; Q trace off; Q focuslog off; Q impl "$IMPL"
for ((r=1;r<=ROUNDS;r++)); do for cfg in "$@"; do
  label=${cfg%%=*}; arg=${cfg#*=}
  Q exp "none"; [ "$arg" != "none" ] && Q exp "$arg"; sleep 0.3
  for s in ${SCENARIOS:-S1 S2}; do
    home
    pid=$(A shell pidof $PKG | tr -d '\r')
    A shell dumpsys gfxinfo $PKG reset >/dev/null
    c0=$(rtcpu "$pid"); drive "$s"; sleep 0.6; c1=$(rtcpu "$pid")
    A shell dumpsys gfxinfo $PKG framestats > "$TMP"
    pss=$(A shell dumpsys meminfo $PKG | tr -d '\r' | awk '/TOTAL PSS:/ {print int($3/1024); exit}')
    python "$PARSE" "$(cygpath -m "$TMP" 2>/dev/null || echo "$TMP")" "label=$label" "scenario=$s" "run=$r" "rt_ms=$(( ${c1:-0} - ${c0:-0} ))" "pss_mb=${pss:-}" >> "$OUT/$label.jsonl"
    tail -1 "$OUT/$label.jsonl" | cut -c1-260
  done
done; done
Q exp "none"; rm -f "$TMP"
