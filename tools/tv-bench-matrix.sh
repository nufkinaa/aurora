#!/bin/bash
# Interleaved A/B bench: ROUNDS rounds, each running every configuration once (so thermal and
# server drift hit all of them alike).  tools/tv-bench-matrix.sh <outdir> <rounds> <label=implarg> ...
#   e.g. tools/tv-bench-matrix.sh docs/qa/native-bench/r2 4 js=all=js F=all=js,focusable=native
# Refuses to start while another bench or pixel-diff run is alive on this PC (stray key senders
# ruined the first measurements, 2026-10-09).
set -u
ADB=${ADB:-/c/elia/android-tools/sdk/platform-tools/adb.exe}; PKG=com.auroratv.lab
OUT=$1; ROUNDS=$2; shift 2; mkdir -p "$OUT"
others=$(ps -ef | grep -E "tv-bench\.sh|tv-pixel-diff/run\.py" | grep -v grep | wc -l)
[ "$others" -gt 0 ] && { echo "another bench/diff process is running ($others) - refusing"; exit 2; }
Q() { timeout 20 "$ADB" shell am broadcast -n $PKG/com.auroratv.ui.qa.QaReceiver -a com.auroratv.QA --es token aurora-lab-qa --es cmd "$1" --es arg "$2" --es rid $RANDOM >/dev/null; }
Q freeze off; Q trace off; Q focuslog off
for ((r=1;r<=ROUNDS;r++)); do for cfg in "$@"; do
  label=${cfg%%=*}; arg=${cfg#*=}
  Q impl "$arg"; sleep 0.5
  LABEL=$label "$(dirname "$0")/tv-bench.sh" -p $PKG -n 1 ${SCENARIOS:-S1 S2 S3 S4} | sed "s/\"run\":1/\"run\":$r/" >> "$OUT/$label.jsonl"
done; done
