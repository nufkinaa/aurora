#!/bin/bash
# Frame-timing bench for the TV app on a real box over adb (docs/native-rewrite/02-verification.md §6).
#   tools/tv-bench.sh [-p package] [-s serial] [-n runs] [-l label] [scenario ...]
# Scenarios (default: S1 S2 S3 S4): S1 home-hold, S2 home-rows, S3 browse-grid, S4 rail, S5 idle.
# Each run: gfxinfo reset → drive the keys → gfxinfo framestats + meminfo → one JSON line on stdout
# {label, scenario, run, frames, janky_pct, p50, p90, p95, p99, input_p50, input_p90, pss_mb, views}.
# Input latency = HANDLE_INPUT_START − INTENDED_VSYNC per frame (FRAME_STATS table); frame = FRAME_COMPLETED − INTENDED_VSYNC.
# The app must be on the Home hero (focus on its first button) when a scenario starts; S3 needs the Movies tab reachable via the rail.
set -u
ADB=${ADB:-/c/elia/android-tools/sdk/platform-tools/adb.exe}
PKG=com.auroratv.lab; SERIAL=""; RUNS=3; LABEL=${LABEL:-}
while getopts "p:s:n:l:" o; do case $o in p) PKG=$OPTARG;; s) SERIAL=$OPTARG;; n) RUNS=$OPTARG;; l) LABEL=$OPTARG;; esac; done
shift $((OPTIND-1))
SC=("$@"); [ ${#SC[@]} -eq 0 ] && SC=(S1 S2 S3 S4)
A() { if [ -n "$SERIAL" ]; then "$ADB" -s "$SERIAL" "$@"; else "$ADB" "$@"; fi; }
keys() { # keys CODE COUNT GAP_MS — one shell call, so the cadence is the box's own
  local k=$1 n=$2 gap=$3 cmd=""; for ((j=0;j<n;j++)); do cmd+="input keyevent $k; sleep $(awk "BEGIN{print $gap/1000}"); "; done; A shell "$cmd" >/dev/null; }
# A cold start before every run: the only way to be sure of the screen (BACK on Home leaves the app),
# and the same warm-up for JS and native alike. ~9 s on a Mi TV.
home() { A shell am force-stop "$PKG"; sleep 1; A shell am start -n "$PKG/com.auroratv.MainActivity" -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER >/dev/null 2>&1; sleep ${WARM_S:-10}; }
drive() {
  case $1 in
    S1) keys DPAD_DOWN 1 400; keys DPAD_RIGHT 20 50; sleep 1; keys DPAD_LEFT 20 50; sleep 0.8; keys DPAD_UP 1 400;;
    S2) keys DPAD_DOWN 8 400; keys DPAD_UP 8 400;;
    S3) keys DPAD_LEFT 1 600; keys DPAD_DOWN 1 400; keys DPAD_CENTER 1 2500; keys DPAD_DOWN 12 300; keys DPAD_RIGHT 5 50; sleep 0.5; keys BACK 1 800;;
    S4) for ((j=0;j<5;j++)); do keys DPAD_LEFT 1 600; keys DPAD_RIGHT 1 600; done;;
    S5) sleep 30;;
  esac
}
parse() { # stdin: framestats dump → tab-separated numbers
  tr -d '\r' | awk -v RS="" '1' | awk '
    /Total frames rendered/ {frames=$NF}
    /^Janky frames: / {match($0,/\(([0-9.]+)%\)/,m); janky=m[1]}
    /50th percentile/ {gsub("ms","",$NF); p50=$NF}
    /90th percentile/ {gsub("ms","",$NF); p90=$NF}
    /95th percentile/ {gsub("ms","",$NF); p95=$NF}
    /99th percentile/ {gsub("ms","",$NF); p99=$NF}
    # column names are CamelCase on Android 12+ (IntendedVsync, HandleInputStart, FrameCompleted), UPPER_SNAKE before
    /^Flags,/ {hdr=1; split($0,h,","); for(i=1;i<=length(h);i++){k=tolower(h[i]); gsub("_","",k); col[k]=i}; next}
    hdr && /^[0-9]/ {split($0,f,","); iv=f[col["intendedvsync"]]; hi=f[col["handleinputstart"]]; fc=f[col["framecompleted"]];
      if (iv>0 && hi>0) { lat[++nl]=(hi-iv)/1e6 } }
    END { n=asort(lat); ip50=(n?lat[int(n*0.5)+1]:""); ip90=(n?lat[int(n*0.9)+(n>=10?0:1)]:"");
      printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", frames, janky, p50, p90, p95, p99, ip50, ip90 }'
}
for ((r=1;r<=RUNS;r++)); do for s in "${SC[@]}"; do
  home
  A shell dumpsys gfxinfo "$PKG" reset >/dev/null
  drive "$s"
  sleep 0.6
  IFS=$'\t' read -r frames janky p50 p90 p95 p99 ip50 ip90 < <(A shell dumpsys gfxinfo "$PKG" framestats | parse)
  pss=$(A shell dumpsys meminfo "$PKG" | tr -d '\r' | awk '/TOTAL PSS:/ {print int($3/1024); exit} /^ +TOTAL +[0-9]/ {print int($2/1024); exit}')
  views=$(A shell dumpsys meminfo "$PKG" | tr -d '\r' | awk '/Views:/ {print $2; exit}')
  printf '{"label":"%s","scenario":"%s","run":%d,"frames":%s,"janky_pct":%s,"p50":%s,"p90":%s,"p95":%s,"p99":%s,"input_p50":%s,"input_p90":%s,"pss_mb":%s,"views":%s}\n' \
    "$LABEL" "$s" "$r" "${frames:-null}" "${janky:-null}" "${p50:-null}" "${p90:-null}" "${p95:-null}" "${p99:-null}" "${ip50:-null}" "${ip90:-null}" "${pss:-null}" "${views:-null}"
done; done
