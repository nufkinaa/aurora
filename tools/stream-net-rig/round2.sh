#!/bin/sh
# Streaming round 2 (docs/qa/streaming-round-2/web.md): the events matrix —
# seeks, a Wi-Fi drop, a network change, a server restart, a busy server, the
# phone flavours — for one build.
#
#   sh tools/stream-net-rig/round2.sh <label> [--tree E:/frozen/master] [sets...]
#
# sets: seek net offline busy phone (default: all). Rows go to .runs/<label>-<set>.jsonl.
set -e
L="$1"; shift
TREE=""
if [ "$1" = "--tree" ]; then TREE="--tree $2"; shift 2; fi
SETS="${*:-seek net offline busy phone}"
export MSYS_NO_PATHCONV=1
R="node tools/stream-net-rig/run.js $TREE"
SEEKS="seek@20:+10,seek@35:0.5,seek@55:-10,seek@70:0.15"
for s in $SETS; do
  case "$s" in
    seek)
      $R --label "$L-seek" --profiles 8M,3M --titles jit,hevc,mp4 --runs 3 --watch 100 --events "$SEEKS"
      $R --label "$L-seek" --profiles 25M --titles jit,hevc,mp4 --watch 100 --events "$SEEKS"
      ;;
    net)
      # early in the film (little in hand yet), on a good line and a thin one
      for e in "blip@10:20" "cut@10:10" "restart@10"; do
        $R --label "$L-net" --profiles 8M,3M --titles jit,mp4 --runs 2 --watch 100 --events "$e"
      done
      ;;
    offline)
      # the device's own Wi-Fi switched off and on (the browser goes offline: requests fail at once)
      $R --label "$L-offline" --profiles 8M,3M --titles jit,mp4 --runs 2 --watch 100 --events "offline@10:15"
      ;;
    busy)
      $R --label "$L-busy" --profiles 8M --titles jit,mp4,hevc --runs 2 --watch 90 --busy 4 --busy-enc 1 --events "seek@30:0.5"
      ;;
    phone)
      $R --label "$L-android" --flavour android --profiles 8M --titles jit,mp4 --runs 2 --watch 100 --events "$SEEKS,blip@85:10"
      $R --label "$L-iphone" --flavour iphone --profiles 8M --titles jit --runs 2 --watch 100 --events "$SEEKS,blip@85:10"
      ;;
  esac
done
