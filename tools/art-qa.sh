#!/bin/bash
# LAB — one QA broadcast to the lab app (tools/tv-pixel-diff/PROTOCOL.md) and its answer line.
#   tools/art-qa.sh ping | tools/art-qa.sh freeze on | tools/art-qa.sh nav detail:tt123
ADB=${ADB:-/c/elia/android-tools/sdk/platform-tools/adb.exe}; SERIAL=${SERIAL:-192.168.50.31:5555}; PKG=${PKG:-com.auroratv.lab}
export MSYS_NO_PATHCONV=1
rid="a$$-$RANDOM"
timeout 60 "$ADB" -s "$SERIAL" shell "am broadcast -n $PKG/com.auroratv.ui.qa.QaReceiver -a com.auroratv.QA --es token ${AURORA_QA_TOKEN:-aurora-lab-qa} --es cmd $1 --es arg '${2:-}' --es rid $rid" >/dev/null
for i in 1 2 3 4 5 6; do
  l=$(timeout 60 "$ADB" -s "$SERIAL" logcat -d -s AuroraQA:V AuroraQa:V | tr -d '\r' | grep "rid=$rid" | tail -1)
  [ -n "$l" ] && { echo "${l#*\[qa\] }"; exit 0; }
  sleep 0.5
done
echo "no answer to $1 ${2:-}" >&2; exit 1
