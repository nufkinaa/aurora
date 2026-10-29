#!/usr/bin/env bash
# The phone app's QA build (docs/android-phone/DEVICE-CHECKS.md): ONLY
# http://127.0.0.1:4000 — reached through `adb reverse` to a private instance.
# A QA build must never reach nufurora.com or the house server.
#
#   bash tv-native/tools/build-phone-qa.sh [extra gradle args]
#   ABIS=arm64-v8a,armeabi-v7a bash tv-native/tools/build-phone-qa.sh   (a real phone; default: the emulator's x86_64)
#
# Three guards: src/api.ts's list is replaced and restored around the build
# (this script); Gradle's auroraQaGuard (-PauroraQa) fails the build if the list
# names anything but 127.0.0.1; afterwards the source must hold no QA marker.
set -u
TV="$(cd "$(dirname "$0")/.." && pwd)"
API="$TV/src/api.ts"
WORK="${TMPDIR:-${TEMP:-/tmp}}/aurora-phone-qa"
mkdir -p "$WORK"
BAK="$WORK/api.ts.bak"
LOG="$WORK/build.log"
cp "$API" "$BAK"
restore() { cp "$BAK" "$API"; }
trap restore EXIT
python - "$API" <<'PY'
import sys
p=sys.argv[1]
s=open(p,encoding='utf-8',newline='').read()
nl='\r\n' if '\r\n' in s else '\n'
i=s.index('export const SERVER_CANDIDATES = [')
j=s.index('];',i)
s=s[:i]+"export const SERVER_CANDIDATES = ["+nl+"  'http://127.0.0.1:4000', // QA VARIANT (private instance only)"+nl+s[j:]
open(p,'w',encoding='utf-8',newline='').write(s)
PY
grep -n -A2 "export const SERVER_CANDIDATES" "$API"
cd "$TV/android"
export JAVA_HOME="${JAVA_HOME:-C:\elia\android-tools\jdk}"
./gradlew.bat assembleRelease -Paurora=phone -PauroraQa -PreactNativeArchitectures="${ABIS:-x86_64}" --console=plain "$@" > "$LOG" 2>&1
rc=$?
restore
trap - EXIT
echo "markers left in src/api.ts: $(grep -c 'QA VARIANT' "$API")"
grep -E "QA guard" "$LOG" | head -2
tail -2 "$LOG"
if ! grep -q "BUILD SUCCESSFUL" "$LOG"; then echo "BUILD FAILED rc=$rc (log: $LOG)"; grep -E "error:|^e: |FAILED|What went wrong" -A3 "$LOG" | head -40; exit 1; fi
[ "$(grep -c 'QA VARIANT' "$API")" = 0 ] || { echo "QA marker left in src/api.ts"; exit 1; }
echo OK-BUILD "$TV/android/app/build/outputs/apk/release/aurora-phone-release.apk"
