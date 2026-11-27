#!/bin/sh
# The "Built" matrix of docs/qa/streaming-efficiency/REPORT.md: the same cells
# played by master (a frozen copy, --tree) and by this branch, with every video
# encode the server starts counted (count-encodes.js).
#   sh tools/stream-net-rig/built.sh before E:/aurora-agents/research-stream-efficiency/tree-master 47210
#   sh tools/stream-net-rig/built.sh after "" 47250
cd "$(dirname "$0")/../.." || exit 1
export MSYS_NO_PATHCONV=1
SIDE="$1"; TREE="$2"; PORT="${3:-47210}"
T=""; [ -n "$TREE" ] && T="--tree $TREE"
R="node tools/stream-net-rig/run.js --port-base $PORT $T"
L="built-$SIDE"
# the deciding cells, 3 plays each
$R --label $L --runs 3 --profiles 8M,5M --titles hevc
$R --label $L --runs 3 --at hevc=546 --profiles drop --titles hevc
$R --label $L-busy --runs 3 --at mp4=390 --profiles 5M,3M --titles mp4
$R --label $L --runs 3 --profiles 25M --titles uhd
$R --label $L-lossy --runs 3 --line 2700 --profiles 3M-L1 --titles mp4
# the rest of the lines, one play each
$R --label $L --profiles 8M,3M,1.5M,drop --titles mp4,jit
$R --label $L --profiles 3M,1.5M --titles hevc
$R --label $L --line forget --profiles 25M,5M --titles mp4
