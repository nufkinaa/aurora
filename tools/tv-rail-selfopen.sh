#!/bin/bash
# Does the nav rail open by itself when UP carries focus from Home's first shelf onto the hero?
# (docs/qa/native-bench/FOLLOWUP.md, problem 1)
#   tools/tv-rail-selfopen.sh <reps> <hold_ms|input|longpress> [label]
#   hold_ms: a real press through a virtual remote (tools/tv-keys-uinput.py), key-up hold_ms after key-down
#   input:   `adb shell input keyevent` (down and up in the same millisecond)
#   longpress: `input keyevent --longpress`
# Each repetition: DOWN (hero -> first shelf), UP (back onto the hero), then RIGHT (shuts the rail if it
# opened, otherwise moves along the hero's buttons). The app must be on Home's hero; trace must be on
# (`cmd trace on` before launch) - the rail's slide is read from its `[anim] rail.slide` lines.
# Prints: opened/total.
set -u
export MSYS_NO_PATHCONV=1
ADB=${ADB:-/c/elia/android-tools/sdk/platform-tools/adb.exe}; SERIAL=${SERIAL:-192.168.50.31:5555}
HERE="$(cd "$(dirname "$0")" && pwd)"
REPS=$1; MODE=$2; LABEL=${3:-$MODE}
LOG=$(mktemp); SEQ=$(mktemp)
A() { timeout ${T:-60} "$ADB" -s "$SERIAL" "$@"; }
A logcat -c
timeout $((REPS*6+60)) "$ADB" -s "$SERIAL" logcat -s AuroraAnim:V > "$LOG" & LP=$!
case $MODE in
  input|longpress)
    flag=""; [ "$MODE" = longpress ] && flag="--longpress"
    for ((i=0;i<REPS;i++)); do
      A shell "input keyevent DPAD_DOWN; sleep 1.3; input keyevent $flag DPAD_UP; sleep 1.6; input keyevent DPAD_RIGHT; sleep 0.9" >/dev/null
    done;;
  *)
    python "$(cygpath -m "$HERE/tv-keys-uinput.py")" "DOWN:80 w1300 UP:$MODE w1600 RIGHT:80 w900" --repeat "$REPS" > "$SEQ"
    T=$((REPS*5+30)) A shell uinput - < "$SEQ";;
esac
sleep 1
# (kill the adb.exe under `timeout`, not only the wrapper: a stray `adb logcat` must not outlive the run)
for p in $(ps -ef | awk -v pp=$LP '$3==pp {print $2}') $LP; do kill $p 2>/dev/null; done
tr -d '\r' < "$LOG" | awk -v label="$LABEL" '
  /\[key\]/ { if (up) { n++; if (slid) o++ } up = ($NF == "KEYCODE_DPAD_UP"); slid = 0; next }
  /rail\.slide/ { if (up) slid = 1 }
  END { if (up) { n++; if (slid) o++ } printf "%s: rail opened on %d of %d UP presses\n", label, o+0, n+0 }'
rm -f "$LOG" "$SEQ"
