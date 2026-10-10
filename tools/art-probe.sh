#!/bin/bash
# LAB — one arm of the art-format experiment on a real box over adb
# (docs/qa/native-bench/ART-FORMAT-PLAN.md). NOT YET RUN ON A DEVICE: written while the
# TV was in use; the key sequences below are the plan's, check them on the first run.
#
#   tools/art-probe.sh jpeg            # baseline: probe on, artWebp off
#   tools/art-probe.sh webp            # experiment: probe on, artWebp on
#   tools/art-probe.sh off             # both switches off again (and the lab-server marker)
#
#   -n runs (3)   -o out dir (docs/qa/native-bench/art-format)   -s serial   -p package
#   ART_SERVER=http://192.168.50.108:4100   a lab server to try before the app's own list
#   CLEAR_CACHE=1                           empty Fresco's disk cache first (needs the app's
#                                           cache dir to be shell-writable; otherwise skipped)
#
# Each run: force-stop → clear logcat → cold start → one full hero rotation at rest (8 × 9 s)
# → screenshot → DOWN (the scrolled, blur-2 layer) → screenshot → open the first card's title
# page → screenshot → back. Then the AuroraArt lines are saved to <out>/<arm>-<run>.log.
# Afterwards: node tools/art-probe-report.js <out>
set -u
ADB=${ADB:-/c/elia/android-tools/sdk/platform-tools/adb.exe}
PKG=com.auroratv.lab; SERIAL=""; RUNS=3; OUT=docs/qa/native-bench/art-format
ARM=${1:-}; shift || true
while getopts "p:s:n:o:" o; do case $o in p) PKG=$OPTARG;; s) SERIAL=$OPTARG;; n) RUNS=$OPTARG;; o) OUT=$OPTARG;; esac; done
case "$ARM" in jpeg|webp|off) ;; *) echo "usage: $0 jpeg|webp|off [-n runs] [-o dir] [-s serial] [-p package]" >&2; exit 2;; esac
A() { if [ -n "$SERIAL" ]; then timeout 120 "$ADB" -s "$SERIAL" "$@"; else timeout 120 "$ADB" "$@"; fi; }
D=/sdcard/Android/data/$PKG/files

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
  A shell "rm -f $D/art-server"; A shell setprop debug.aurora.artserver '""'
  A shell am force-stop "$PKG"; echo "art switches off"; exit 0
fi
flag art-probe debug.aurora.artprobe on
flag art-webp debug.aurora.artwebp "$([ "$ARM" = webp ] && echo on || echo off)"
if [ -n "${ART_SERVER:-}" ]; then
  A shell "echo $ART_SERVER > $D/art-server" 2>/dev/null
  A shell "cat $D/art-server" 2>/dev/null | grep -q "$ART_SERVER" || A shell setprop debug.aurora.artserver "$ART_SERVER"
fi

mkdir -p "$OUT"
key() { A shell "input keyevent $1" >/dev/null; sleep "${2:-1}"; }
shot() { A exec-out screencap -p > "$OUT/$ARM-$1.png"; }
for ((r=1;r<=RUNS;r++)); do
  A shell am force-stop "$PKG"; sleep 1
  [ -n "${CLEAR_CACHE:-}" ] && A shell "rm -rf /sdcard/Android/data/$PKG/cache/* /data/data/$PKG/cache/image_cache*" 2>/dev/null
  A logcat -c
  A shell am start -n "$PKG/com.auroratv.MainActivity" -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER >/dev/null 2>&1
  sleep "${WARM_S:-10}"
  [ "$r" = 1 ] && shot home-rest            # the first hero, blur 1, before it rotates
  sleep "${ROTATE_S:-75}"                    # 8 heroes × 9 s: every billboard picture decoded once
  key DPAD_DOWN 2;   [ "$r" = 1 ] && shot home-scrolled   # focus in the shelves: the blur-2 layer
  key DPAD_CENTER 5; [ "$r" = 1 ] && shot detail          # the first card's title page, backdrop in
  key BACK 2; key DPAD_RIGHT 1; key DPAD_CENTER 5; key BACK 2   # two more title pages
  key DPAD_RIGHT 1; key DPAD_CENTER 5; key BACK 2
  A logcat -d -v time -s AuroraArt:I | tr -d '\r' > "$OUT/$ARM-$r.log"
  echo "$ARM run $r: $(grep -c ' done ' "$OUT/$ARM-$r.log") pictures, $(grep -m1 -o 'flags.*' "$OUT/$ARM-$r.log")"
done
echo "logs and screenshots in $OUT — when both arms are there: node tools/art-probe-report.js $OUT"
