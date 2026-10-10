#!/bin/bash
# The bench with the viewer's numbers in it (docs/qa/native-bench/FOLLOWUP.md): as tools/tv-render-bench.sh, plus
#   - presented frames: `dumpsys SurfaceFlinger --latency <the app's layer>` polled during the scenario
#     (tools/present-parse.py: pres_fps, refreshes without a new frame; tools/present-join.py: from a frame's
#     vsync to the screen, and the share of frames shown one / two refreshes late),
#   - CPU frequency residency over the scenario (cpu_top_pct = share of time at the top frequency, cpu_mhz = mean),
#   - the implementation per configuration,
#   - skips = how often the `unstuff` / `unstuffq` experiments held a vsync back (AuroraClock, logcat AuroraExp).
#   tools/tv-present-bench.sh <outdir> <rounds> <label=exp-arg[@impl-arg]> ...
#   e.g. tools/tv-present-bench.sh docs/qa/native-bench/f3 4 js=none@all=js nat=none ccs=cardlayer=1,cull=1,shadowcache=1
#   env: SCENARIOS="S1 S2 S3 S4" (default), IMPL (default: all native but the grid), POLL_S=1.2, KEEP=1 keeps
#        each run's raw dumps as <outdir>/raw/<label>-<scenario>-<round>.{gfx,lat}.txt
# Leaves the app with `exp none` and the default IMPL. Refuses to start beside another bench or pixel-diff run.
set -u
export MSYS_NO_PATHCONV=1
ADB=${ADB:-/c/elia/android-tools/sdk/platform-tools/adb.exe}; PKG=com.auroratv.lab; SERIAL=${SERIAL:-192.168.50.31:5555}
HERE="$(cd "$(dirname "$0")" && pwd)"
W() { cygpath -m "$1" 2>/dev/null || echo "$1"; }
OUT=$1; ROUNDS=$2; shift 2; mkdir -p "$OUT"
IMPL=${IMPL:-all=js,focusable=native,card=native,row=native,hero=native,rail=native}
others=$(ps -ef | grep -E "tv-bench\.sh|tv-pixel-diff/run\.py|tv-bench-matrix\.sh|tv-render-bench\.sh" | grep -v grep | wc -l)
[ "$others" -gt 0 ] && { echo "another bench/diff process is running ($others) - refusing"; exit 2; }
A() { timeout 90 "$ADB" -s "$SERIAL" "$@"; }
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
rtcpu() { A shell "for t in /proc/$1/task/*; do read -r l < \$t/stat; echo \$l; done" 2>/dev/null | tr -d '\r' | awk '/\(RenderThread\)/ {print ($14+$15)*10}'; }
freq() { A shell cat /sys/devices/system/cpu/cpufreq/policy0/stats/time_in_state | tr -d '\r' | tr '\n' ' '; }
TMP="$OUT/.dump.txt"; LAT="$OUT/.lat.txt"
Q freeze off; Q trace off; Q focuslog off
for ((r=1;r<=ROUNDS;r++)); do for cfg in "$@"; do
  label=${cfg%%=*}; arg=${cfg#*=}; impl=$IMPL
  case $arg in *@*) impl=${arg#*@}; arg=${arg%%@*};; esac
  A shell am force-stop $PKG
  Q impl "$impl"; Q exp "none"; [ "$arg" != "none" ] && Q exp "$arg"; sleep 0.3
  for s in ${SCENARIOS:-S1 S2 S3 S4}; do
    home
    pid=$(A shell pidof $PKG | tr -d '\r')
    layer=$(A shell dumpsys SurfaceFlinger --list | tr -d '\r' | grep "^$PKG/com.auroratv.MainActivity#" | tail -1)
    A shell "rm -f /data/local/tmp/lat.stop; dumpsys SurfaceFlinger --latency-clear" >/dev/null
    timeout 120 "$ADB" -s "$SERIAL" shell "while [ ! -f /data/local/tmp/lat.stop ]; do dumpsys SurfaceFlinger --latency '$layer'; echo ===; sleep ${POLL_S:-1.2}; done" > "$LAT" 2>/dev/null &
    A logcat -c
    A shell dumpsys gfxinfo $PKG reset >/dev/null
    f0=$(freq); c0=$(rtcpu "$pid"); drive "$s"; sleep 0.6; c1=$(rtcpu "$pid"); f1=$(freq)
    A shell "touch /data/local/tmp/lat.stop"; wait
    A shell "dumpsys SurfaceFlinger --latency '$layer'" >> "$LAT"; A shell "rm -f /data/local/tmp/lat.stop"
    A shell dumpsys gfxinfo $PKG framestats > "$TMP"
    pss=$(A shell dumpsys meminfo $PKG | tr -d '\r' | awk '/TOTAL PSS:/ {print int($3/1024); exit}')
    skips=$(A logcat -d -s AuroraExp:V | grep -c "\[unstuff\] skip")
    g=$(python "$(W "$HERE/render-parse.py")" "$(W "$TMP")" "label=$label" "scenario=$s" "run=$r" "rt_ms=$(( ${c1:-0} - ${c0:-0} ))" "pss_mb=${pss:-}")
    p=$(python "$(W "$HERE/present-parse.py")" "$(W "$LAT")" "skips=${skips:-0}")
    python "$(W "$HERE/present-merge.py")" "$g" "$p" "$f0" "$f1" "$(W "$TMP")" "$(W "$LAT")" >> "$OUT/$label.jsonl"
    if [ -n "${KEEP:-}" ]; then mkdir -p "$OUT/raw"; cp "$TMP" "$OUT/raw/$label-$s-$r.gfx.txt"; cp "$LAT" "$OUT/raw/$label-$s-$r.lat.txt"; fi
  done
done; done
A shell am force-stop $PKG; Q exp "none"; Q impl "$IMPL"; rm -f "$TMP" "$LAT"
