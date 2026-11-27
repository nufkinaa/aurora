#!/bin/sh
# The measured matrix of docs/qa/streaming-efficiency/REPORT.md, one batch per
# argument (each appends to tools/stream-net-rig/.runs/<label>.jsonl).
#   sh tools/stream-net-rig/batch.sh base        # today's code, CUBIC (the server as it is)
#   sh tools/stream-net-rig/batch.sh bbr         # the same server with BBR (loss lines)
#   sh tools/stream-net-rig/batch.sh <label> <extra run.js args…>   # a prototype, same matrix
# Lines and films: PROFILES / TITLES in run.js.
cd "$(dirname "$0")/../.." || exit 1
export MSYS_NO_PATHCONV=1
L="$1"; shift
R="node tools/stream-net-rig/run.js"
case "$L" in
  base|base-*)
    $R --label "$L" --profiles 25M,8M,5M,3M,1.5M,3M-L1,20M-L1,drop --titles mp4,jit,hevc --watch 150 "$@"
    $R --label "$L" --profiles 25M,8M,drop --titles uhd --watch 150 "$@"
    ;;
  bbr|bbr-*)
    $R --label "$L" --cc bbr --profiles 20M-L1,3M-L1,8M-L2 --titles mp4,jit,hevc --watch 150 "$@"
    $R --label "$L" --cc bbr --profiles 8M-L2 --titles uhd --watch 150 "$@"
    ;;
  *)
    $R --label "$L" --profiles 8M,5M,3M,1.5M,3M-L1,drop --titles mp4,jit,hevc --watch 150 "$@"
    ;;
esac
