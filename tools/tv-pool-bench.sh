#!/bin/bash
# The recycling shelf / grid bench (docs/qa/native-bench/POOL.md): tools/tv-present-bench.sh plus
#   - two LONG HOLDS made with real held keys (the uinput remote, tools/tv-keys-uinput.py: one key-down, the
#     system's own key repeat, one key-up), which is what makes a shelf's or a grid's mounted window move again
#     and again:
#       L1  Home, the 4th shelf (24 cards): RIGHT held to the end, LEFT held back, twice   (~92 card moves)
#       G1  Movies grid: DOWN held, UP held back, twice
#     Each hold is its own uinput run and `dumpsys gfxinfo framestats` is read in the pause after it (the app is
#     at rest then), so EVERY frame of the scenario is kept, not only the last 120;
#   - per run, from those frames (tools/pool-parse.py): the longest frame, how many frames took > 32 / > 64 ms,
#     the longest time the UI thread held a frame, and the stage table of the worst frames;
#   - GPU memory and the view count next to PSS, and the UI thread's CPU time over the scenario.
#   tools/tv-pool-bench.sh <outdir> <rounds> <label=exp-arg[@impl-arg[@scenarios]]> ...
#   e.g. tools/tv-pool-bench.sh docs/qa/native-bench/pool/bench 4 \
#          A=cardlayer=1,cull=1,shadowcache=1,unstuff=1 B=cardlayer=1,cull=1,shadowcache=1,unstuff=1,pool=1 \
#          "C=cardlayer=1,cull=1,shadowcache=1,unstuff=1,pool=1@all=native@S3 G1"
#   env: SCENARIOS="S1 S3 L1 G1" (default), IMPL (default: all native but the grid), HOLD_MS (L1, default 1700),
#        GHOLD_MS (G1, default 1400), KEEP=1 keeps each run's raw dumps under <outdir>/raw/
# Leaves the app with `exp none` and the default IMPL. Refuses to start beside another bench or pixel-diff run.
set -u
export MSYS_NO_PATHCONV=1
ADB=${ADB:-/c/elia/android-tools/sdk/platform-tools/adb.exe}; PKG=com.auroratv.lab; SERIAL=${SERIAL:-192.168.50.31:5555}
HERE="$(cd "$(dirname "$0")" && pwd)"
W() { cygpath -m "$1" 2>/dev/null || echo "$1"; }
OUT=$1; ROUNDS=$2; shift 2; mkdir -p "$OUT"
IMPL=${IMPL:-all=js,focusable=native,card=native,row=native,hero=native,rail=native}
others=$(ps -ef | grep -E "tv-bench\.sh|tv-pixel-diff/run\.py|tv-bench-matrix\.sh|tv-render-bench\.sh|tv-present-bench\.sh" | grep -v grep | wc -l)
[ "$others" -gt 0 ] && { echo "another bench/diff process is running ($others) - refusing"; exit 2; }
A() { timeout 90 "$ADB" -s "$SERIAL" "$@"; }
Q() { A shell am broadcast -n $PKG/com.auroratv.ui.qa.QaReceiver -a com.auroratv.QA --es token aurora-lab-qa --es cmd "$1" --es arg "$2" --es rid $RANDOM >/dev/null; }
keys() { local k=$1 n=$2 gap=$3 cmd="" q; for ((q=0;q<n;q++)); do cmd+="input keyevent $k; sleep $(awk "BEGIN{print $gap/1000}"); "; done; A shell "$cmd" >/dev/null; }
home() { A shell am force-stop $PKG; sleep 1; A shell am start -n $PKG/com.auroratv.MainActivity -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER >/dev/null 2>&1; sleep ${WARM_S:-10}; }
TMP="$OUT/.dump.txt"; ALL="$OUT/.all.txt"; LAT="$OUT/.lat.txt"
snap() { A shell dumpsys gfxinfo $PKG framestats > "$TMP"; cat "$TMP" >> "$ALL"; }
# one real press: key-down, held (the system repeats it), key-up; then the frames of that motion are read at rest
hold() { python "$(W "$HERE/tv-keys-uinput.py")" "$1:$2 w${3:-1200}" | A shell uinput - >/dev/null 2>&1; snap; }
pre() { # the keys that bring a scenario to its starting point (not measured)
  case $1 in
    L1) keys DPAD_DOWN 4 500; sleep 1;;
    G1) keys DPAD_LEFT 1 600; keys DPAD_DOWN 1 400; keys DPAD_CENTER 1 3500;;
  esac
}
drive() {
  local j h=${HOLD_MS:-1700} g=${GHOLD_MS:-1400}
  case $1 in
    S1) keys DPAD_DOWN 1 400; keys DPAD_RIGHT 20 50; sleep 1; keys DPAD_LEFT 20 50; sleep 0.8; keys DPAD_UP 1 400;;
    S2) keys DPAD_DOWN 8 400; keys DPAD_UP 8 400;;
    S3) keys DPAD_LEFT 1 600; keys DPAD_DOWN 1 400; keys DPAD_CENTER 1 2500; keys DPAD_DOWN 12 300; keys DPAD_RIGHT 5 50; sleep 0.5; keys BACK 1 800;;
    S4) for ((j=0;j<5;j++)); do keys DPAD_LEFT 1 600; keys DPAD_RIGHT 1 600; done;;
    L1) hold RIGHT $h; hold LEFT $h; hold RIGHT $h; hold LEFT $h;;
    G1) hold DOWN $g; hold UP $g; hold DOWN $g; hold UP $g;;
  esac
}
rtcpu() { A shell "for t in /proc/$1/task/*; do read -r l < \$t/stat; echo \$l; done" 2>/dev/null | tr -d '\r' | awk '/\(RenderThread\)/ {print ($14+$15)*10}'; }
uicpu() { A shell "read -r l < /proc/$1/task/$1/stat; echo \$l" 2>/dev/null | tr -d '\r' | awk '{n=split($0,a,") "); split(a[n],b," "); print (b[12]+b[13])*10}'; }
freq() { A shell cat /sys/devices/system/cpu/cpufreq/policy0/stats/time_in_state | tr -d '\r' | tr '\n' ' '; }
Q freeze off; Q trace off; Q focuslog off
for ((r=1;r<=ROUNDS;r++)); do for cfg in "$@"; do
  label=${cfg%%=*}; arg=${cfg#*=}; impl=$IMPL; scn=${SCENARIOS:-S1 S3 L1 G1}
  case $arg in *@*) rest=${arg#*@}; arg=${arg%%@*}; case $rest in *@*) scn=${rest#*@}; rest=${rest%%@*};; esac; [ -n "$rest" ] && impl=$rest;; esac
  A shell am force-stop $PKG
  Q impl "$impl"; Q exp "none"; [ "$arg" != "none" ] && Q exp "$arg"; sleep 0.3
  for s in $scn; do
    home; pre "$s"
    pid=$(A shell pidof $PKG | tr -d '\r')
    layer=$(A shell dumpsys SurfaceFlinger --list | tr -d '\r' | grep "^$PKG/com.auroratv.MainActivity#" | tail -1)
    A shell "rm -f /data/local/tmp/lat.stop; dumpsys SurfaceFlinger --latency-clear" >/dev/null
    timeout 180 "$ADB" -s "$SERIAL" shell "while [ ! -f /data/local/tmp/lat.stop ]; do dumpsys SurfaceFlinger --latency '$layer'; echo ===; sleep ${POLL_S:-1.2}; done" > "$LAT" 2>/dev/null &
    A logcat -c; : > "$ALL"
    A shell dumpsys gfxinfo $PKG reset >/dev/null
    f0=$(freq); c0=$(rtcpu "$pid"); u0=$(uicpu "$pid"); drive "$s"; sleep 0.6; c1=$(rtcpu "$pid"); u1=$(uicpu "$pid"); f1=$(freq)
    A shell "touch /data/local/tmp/lat.stop"; wait
    A shell "dumpsys SurfaceFlinger --latency '$layer'" >> "$LAT"; A shell "rm -f /data/local/tmp/lat.stop"
    snap
    pss=$(A shell dumpsys meminfo $PKG | tr -d '\r' | awk '/TOTAL PSS:/ {print int($3/1024); exit}')
    skips=$(A logcat -d -s AuroraExp:V | grep -c "\[unstuff\] skip")
    g=$(python "$(W "$HERE/render-parse.py")" "$(W "$TMP")" "label=$label" "scenario=$s" "run=$r" "rt_ms=$(( ${c1:-0} - ${c0:-0} ))" "pss_mb=${pss:-}")
    p=$(python "$(W "$HERE/present-parse.py")" "$(W "$LAT")" "skips=${skips:-0}" "ui_cpu_ms=$(( ${u1:-0} - ${u0:-0} ))")
    m=$(python "$(W "$HERE/present-merge.py")" "$g" "$p" "$f0" "$f1" "$(W "$ALL")" "$(W "$LAT")" 2>/dev/null)
    python "$(W "$HERE/pool-parse.py")" "$m" "$(W "$TMP")" "$(W "$ALL")" >> "$OUT/$label.jsonl"
    if [ -n "${KEEP:-}" ]; then mkdir -p "$OUT/raw"; cp "$ALL" "$OUT/raw/$label-$s-$r.gfx.txt"; cp "$LAT" "$OUT/raw/$label-$s-$r.lat.txt"; fi
  done
done; done
A shell am force-stop $PKG; Q exp "none"; Q impl "$IMPL"; rm -f "$TMP" "$ALL" "$LAT"
