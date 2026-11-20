#!/usr/bin/env bash
# Scroll frame numbers only (dumpsys gfxinfo, dev.py fling): the episode cards' rail and the
# Downloads list, 3 runs of 5 flings each way, for the build installed on emulator-5554.
#   bash tools/real-glass-app/perf.sh <out folder>
set -u
O="${1:?out folder}"; mkdir -p "$O"
HERE="$(cd "$(dirname "$0")" && pwd)"
D="python $HERE/dev.py"
A="timeout 30 ${ADB:-C:/elia/android-tools/sdk/platform-tools/adb.exe} -s emulator-5554"
runs() { for i in 1 2 3; do $D fling 5 "${@:2}" | tee -a "$O/gfx-$1.txt"; sleep 1; done; }
$A shell input tap 540 60
$A shell am force-stop com.aurora.phone
$A shell monkey -p com.aurora.phone -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
sleep 14
$A shell input tap 460 2300; sleep 6                 # Shows
$D tap "Paper Harbor" || { sleep 4; $D tap "Paper Harbor"; }; sleep 7
$D nodes | grep -q "^Paper Harbor" || echo "WARN: not on Paper Harbor"
$A shell input swipe 540 1900 540 900 500; sleep 2
$A shell input swipe 540 1900 540 1100 800; sleep 2
runs episodes 1500 1500 950 150
$A shell input swipe 540 900 540 1800 600; sleep 2
$A shell input tap 790 2300; sleep 2.5               # More
$D tap "My downloads, What" || { sleep 3; $D tap "My downloads, What"; }; sleep 6
runs downloads
$A shell input swipe 540 900 540 1900 200; sleep 1
$A shell input swipe 540 900 540 1900 200; sleep 2
echo done
