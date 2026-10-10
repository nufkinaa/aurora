#!/bin/bash
# LAB — one arm of the art-format experiment on a real box over adb
# (docs/qa/native-bench/ART-FORMAT-PLAN.md; results in ART-FORMAT.md).
# Run on the Mi TV 2026-10-10 — the sequences below are the checked ones.
#
#   tools/art-probe.sh jpeg            # baseline: probe on, artWebp off
#   tools/art-probe.sh webp            # experiment: probe on, artWebp on
#   tools/art-probe.sh off             # every art switch off again, freeze off
#   tools/art-probe.sh jpeg -m shots   # the still pictures + memory instead of the timing run
#
#   -n runs (1)   -l label (file names: <arm>-<label><run>.log; default "r")
#   -o out dir (docs/qa/native-bench/art-format)   -s serial   -p package   -m time|shots
#   CLEAR_CACHE=1   a cold image cache: the app empties its own Fresco + OkHttp caches at the
#                   next launch (marker art-clear, ArtProbe.clearIfAsked — the shell cannot
#                   reach /data/data/<pkg>/cache on Android 14)
#   HEROES=8        hero pictures to walk     TITLES="tt…[:show] …"   title pages to open
#
# time mode, per run: force-stop → cold start (rotation running: QA `freeze off`) → for each
# hero: its blur-1 picture arrives → DOWN (focus in the first shelf: the blur-2 layer is asked
# for) → UP (back on the hero; the next rotation follows ~9 s later) → then each title page
# through the QA receiver's `nav detail:<imdb>` (NO key presses there: the page opens with
# Play focused) with a `dumpsys meminfo` on it → the AuroraArt lines to <out>/<arm>-<label><run>.log.
# shots mode, per run: `freeze on` (slide 0 pinned, no rotation) → home at rest → home
# scrolled → two title pages, a screenshot and a meminfo of each → raw/<arm>-<label><run>-*.png, shots/<arm>-<label><run>.mem.
# Afterwards: node tools/art-probe-report.js <out>
set -u
export MSYS_NO_PATHCONV=1
ADB=${ADB:-/c/elia/android-tools/sdk/platform-tools/adb.exe}
PKG=com.auroratv.lab; SERIAL=${SERIAL:-192.168.50.31:5555}; RUNS=1; OUT=docs/qa/native-bench/art-format; LABEL=r; MODE=time
ARM=${1:-}; shift || true
while getopts "p:s:n:o:l:m:" o; do case $o in p) PKG=$OPTARG;; s) SERIAL=$OPTARG;; n) RUNS=$OPTARG;; o) OUT=$OPTARG;; l) LABEL=$OPTARG;; m) MODE=$OPTARG;; esac; done
case "$ARM" in jpeg|webp|off) ;; *) echo "usage: $0 jpeg|webp|off [-n runs] [-l label] [-m time|shots] [-o dir] [-s serial] [-p package]" >&2; exit 2;; esac
HERE=$(cd "$(dirname "$0")" && pwd)
A() { timeout 60 "$ADB" -s "$SERIAL" "$@"; }
QA() { SERIAL=$SERIAL PKG=$PKG ADB=$ADB "$HERE/art-qa.sh" "$@"; }
D=/sdcard/Android/data/$PKG/files
HEROES=${HEROES:-8}
# six 1920×1080 originals and two 1280×720 ones (Forgotten Island, The Love Hypothesis)
TITLES=${TITLES:-"tt15239678 tt2788316:show tt1375666 tt0903747:show tt26657236 tt31938062:show tt36583977 tt22526100"}
SHOT_TITLES=${SHOT_TITLES:-"tt15239678 tt0903747:show"}

# A switch: the marker file, or the debug property where the shell may not write there.
flag() { # flag NAME PROP on|off
  if [ "$3" = on ]; then
    A shell "mkdir -p $D && touch $D/$1" 2>/dev/null
    if A shell "ls $D/$1" 2>/dev/null | grep -q "$1"; then A shell setprop "$2" 0; else echo "(marker not writable: using setprop $2)" >&2; A shell setprop "$2" 1; fi
  else
    A shell "rm -f $D/$1" 2>/dev/null; A shell setprop "$2" 0
  fi
}
if [ "$ARM" = off ]; then
  flag art-webp debug.aurora.artwebp off; flag art-probe debug.aurora.artprobe off
  A shell "rm -f $D/art-server $D/art-clear"; A shell setprop debug.aurora.artserver '""'
  QA freeze off >/dev/null
  A shell am force-stop "$PKG"; echo "art switches off, freeze off"; exit 0
fi
flag art-probe debug.aurora.artprobe on
flag art-webp debug.aurora.artwebp "$([ "$ARM" = webp ] && echo on || echo off)"

mkdir -p "$OUT/raw"
key() { A shell "input keyevent $1" >/dev/null; sleep "${2:-1}"; }
count() { A logcat -d -s AuroraArt:I | grep -c "done kind=$1"; }
waitmore() { # waitmore KIND HAD SECONDS — until one more `done` line of that kind is there
  local t=0; while [ "$(count "$1")" -le "$2" ] && [ $t -lt $(($3 * 2)) ]; do sleep 0.5; t=$((t + 1)); done
  [ $t -lt $(($3 * 2)) ]
}
launch() {
  A shell am force-stop "$PKG"; sleep 1
  [ -n "${CLEAR_CACHE:-}" ] && A shell "touch $D/art-clear"
  A logcat -c
  A shell am start -n "$PKG/com.auroratv.MainActivity" >/dev/null 2>&1
  waitmore hero-b1 0 25 || echo "  (no hero picture after 25 s)" >&2
}
mem() { A shell dumpsys meminfo "$PKG" | tr -d '\r' | awk -v t="$1" '/TOTAL PSS:/{pss=$3} /Graphics:/{g=$2} /Native Heap:/{n=$3} /Java Heap:/{j=$3} END{print t, "pss_kb=" pss, "graphics_kb=" g, "native_kb=" n, "java_kb=" j}'; }

for ((r=1;r<=RUNS;r++)); do
  tag="$ARM-$LABEL$r"
  # a shots run's log and memory go to shots/, out of the report's way (its one launch picture is no timing sample)
  dir="$OUT"; [ "$MODE" = shots ] && dir="$OUT/shots"; mkdir -p "$dir"
  if [ "$MODE" = shots ]; then
    QA freeze on >/dev/null; launch; sleep 8
    A exec-out screencap -p > "$OUT/raw/$tag-home-rest.png"
    b2=$(count hero-b2); key DPAD_DOWN 0; waitmore hero-b2 "$b2" 8; sleep 3
    A exec-out screencap -p > "$OUT/raw/$tag-home-scrolled.png"
    key DPAD_UP 1.5; key DPAD_RIGHT 1
    i=0; : > "$dir/$tag.mem"
    for t in $SHOT_TITLES; do
      i=$((i + 1)); bd=$(count backdrop); QA nav "detail:$t" >/dev/null; waitmore backdrop "$bd" 15 || echo "  (no backdrop for $t)" >&2
      sleep 6; A exec-out screencap -p > "$OUT/raw/$tag-detail$i.png"; mem "$t" >> "$dir/$tag.mem"
    done
    QA nav home >/dev/null; sleep 1
  else
    QA freeze off >/dev/null; launch
    for ((h=1;h<=HEROES;h++)); do
      sleep 3
      b1=$(count hero-b1); b2=$(count hero-b2)
      # The rail sometimes OPENS BY ITSELF right after UP lands on the hero (seen on the Mi TV,
      # [focus] log: Stream gains, 40 ms later the rail's Home item gains, no key in between).
      # RIGHT after every UP covers both cases: it closes the rail (focus back on the hero), or
      # moves Stream → Details — DOWN reaches the first shelf from either. Never CENTER here.
      key DPAD_DOWN 0; waitmore hero-b2 "$b2" 6 || { echo "  (hero $h: no blur-2 picture; RIGHT, DOWN again)" >&2; key DPAD_RIGHT 1; key DPAD_DOWN 0; waitmore hero-b2 "$b2" 6 || { echo "  (hero $h: still none)" >&2; A exec-out screencap -p > "$OUT/raw/fail-$tag-h$h.png"; }; }
      sleep 1; key DPAD_UP 1.5; key DPAD_RIGHT 0
      [ $h -lt "$HEROES" ] && { waitmore hero-b1 "$b1" 20 || echo "  (hero $h: no next picture after 20 s)" >&2; }
    done
    : > "$dir/$tag.mem"
    for t in $TITLES; do
      bd=$(count backdrop); QA nav "detail:$t" >/dev/null; waitmore backdrop "$bd" 15 || echo "  (no backdrop for $t)" >&2
      sleep 3; mem "$t" >> "$dir/$tag.mem"
    done
    QA nav home >/dev/null; sleep 1
  fi
  A logcat -d -v time -s AuroraArt:I | tr -d '\r' > "$dir/$tag.log"
  echo "$tag: $(grep -c 'done kind=hero-b1' "$dir/$tag.log") b1, $(grep -c 'done kind=hero-b2' "$dir/$tag.log") b2, $(grep -c 'done kind=backdrop' "$dir/$tag.log") backdrops; $(grep -m1 -o 'flags webp=. probe=.' "$dir/$tag.log"); $(grep -m1 -o 'cleared files=[0-9]* bytes=[0-9]*' "$dir/$tag.log")"
done
echo "logs in $OUT — when both arms are there: node tools/art-probe-report.js $OUT"
