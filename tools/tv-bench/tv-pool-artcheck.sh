#!/bin/bash
# Does a recycled card ever show another title's picture or label, even for one frame?
# (aurora-lab:docs/qa/native-bench/POOL.md; the judge is tools/tv-bench/pool-art-check.py.)
#   tools/tv-bench/tv-pool-artcheck.sh <outdir> <poster|frame> <rows-down> <count> [exp-arg]
#     poster 4 24   = Home's 4th shelf (24 poster cards);  frame 1 <n> = Continue Watching (n frame cards)
# 1. the reference: the keyed row (exp none), one lossless screencap per focused card, at rest;
# 2. the test: the given exp (default: pool=1), a screenrecord while RIGHT is HELD to the end of the shelf and
#    LEFT is held back (the uinput remote: real key repeat), then every frame of it is cut out with ffmpeg;
# 3. pool-art-check.py classifies every card place of every frame against all the shelf's cards.
# Leaves the app with `exp none`.
set -u
export MSYS_NO_PATHCONV=1
ADB=${ADB:-/c/elia/android-tools/sdk/platform-tools/adb.exe}; PKG=${PKG:-com.auroratv}; SERIAL=${SERIAL:-192.168.50.31:5555}
HERE="$(cd "$(dirname "$0")" && pwd)"
W() { cygpath -m "$1" 2>/dev/null || echo "$1"; }
OUT=$1; KIND=$2; DOWN=$3; COUNT=$4; EXP=${5:-pool=1}; mkdir -p "$OUT/frames"
IMPL=${IMPL:-all=js,focusable=native,card=native,row=native,hero=native,rail=native}
A() { timeout 90 "$ADB" -s "$SERIAL" "$@"; }
Q() { A shell am broadcast -n $PKG/com.auroratv.ui.qa.QaReceiver -a com.auroratv.QA --es token ${AURORA_QA_TOKEN:-aurora-port-qa} --es cmd "$1" --es arg "$2" --es rid $RANDOM >/dev/null; }
keys() { local k=$1 n=$2 gap=$3 cmd="" q; for ((q=0;q<n;q++)); do cmd+="input keyevent $k; sleep $(awk "BEGIN{print $gap/1000}"); "; done; A shell "$cmd" >/dev/null; }
home() { A shell am force-stop $PKG; sleep 1; A shell am start -n $PKG/com.auroratv.MainActivity -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER >/dev/null 2>&1; sleep 10; }
case $KIND in poster) GEO="--w 248 --h 372 --step 276";; frame) GEO="--w 448 --h 280 --step 476";; *) echo "poster|frame"; exit 2;; esac
Q freeze on; Q trace off; Q focuslog off; Q impl "$IMPL"
if [ -z "${SKIP_REF:-}" ]; then
  Q exp none; home; keys DPAD_DOWN "$DOWN" 600; sleep 1.5
  for ((f=0;f<COUNT;f++)); do
    A exec-out screencap -p > "$OUT/ref-$f.png"
    [ $((f+1)) -lt "$COUNT" ] && { keys DPAD_RIGHT 1 100; sleep 1.6; }
  done
fi
Q exp none; [ "$EXP" != "none" ] && Q exp "$EXP"; home; keys DPAD_DOWN "$DOWN" 600; sleep 1.5
HOLD=${HOLD_MS:-$(( 400 + COUNT * 52 ))}
A shell "screenrecord --bit-rate 40000000 --time-limit $(( (2*HOLD + 2500 + 2500 + 1500) / 1000 + 2 )) /sdcard/Download/pool-art.mp4" >/dev/null 2>&1 &
sleep 1
python "$(W "$HERE/tv-keys-uinput.py")" "RIGHT:$HOLD w1500 LEFT:$HOLD w1200" | A shell uinput - >/dev/null 2>&1
wait
timeout 120 "$ADB" -s "$SERIAL" pull /sdcard/Download/pool-art.mp4 "$(W "$OUT/hold.mp4")" >/dev/null; A shell rm -f /sdcard/Download/pool-art.mp4
rm -f "$OUT"/frames/*.png
ffmpeg -loglevel error -y -i "$(W "$OUT/hold.mp4")" -vsync 0 "$(W "$OUT/frames")/f%04d.png"
Q freeze off; A shell am force-stop $PKG; Q exp none
echo "frames: $(ls "$OUT/frames" | wc -l); now: python tools/tv-bench/pool-art-check.py $OUT $GEO --y <top of the cards, px> --count $COUNT"
