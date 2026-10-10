#!/bin/bash
# tools/tv-rail-selfopen-matrix.sh <out.txt> <reps> <impl-label=implarg> ... ; env MODES="input longpress 30 80 120 200 350", EXP="none"
# A cold start per (impl, mode); see tv-rail-selfopen.sh.
set -u
export MSYS_NO_PATHCONV=1
ADB=${ADB:-/c/elia/android-tools/sdk/platform-tools/adb.exe}; SERIAL=${SERIAL:-192.168.50.31:5555}; PKG=com.auroratv.lab
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT=$1; REPS=$2; shift 2
A() { timeout 60 "$ADB" -s "$SERIAL" "$@"; }
Q() { A shell am broadcast -n $PKG/com.auroratv.ui.qa.QaReceiver -a com.auroratv.QA --es token aurora-lab-qa --es cmd "$1" --es arg "$2" >/dev/null; }
for cfg in "$@"; do
  label=${cfg%%=*}; arg=${cfg#*=}
  for m in ${MODES:-input longpress 30 80 120 200 350}; do
    A shell am force-stop $PKG; Q impl "$arg"; Q exp "${EXP:-none}"; Q freeze off; Q focuslog off; Q trace on
    A shell am start -n $PKG/com.auroratv.MainActivity >/dev/null 2>&1; sleep 12
    "$HERE/tv-rail-selfopen.sh" "$REPS" "$m" "$label $m" | tee -a "$OUT"
  done
done
A shell am force-stop $PKG; Q trace off
