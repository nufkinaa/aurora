#!/usr/bin/env bash
# Two versions of the site, measured side by side at the same moment.
#
#   bash tools/mobile-perf/ab.sh <ref A> <ref B> <label A> <label B> <script> [script args…]
#   bash tools/mobile-perf/ab.sh 1fa4c93 HEAD before after net.js --lines fast3g,slow3g --runs 5
#
# Unpacks each commit (snapshot.js; "WORKTREE" means the files as they are
# now), starts an instance of each, runs the script against both IN PARALLEL
# (so whatever else the machine is doing slows both alike), then stops them.
# Instances that are already up for a label (.cache/<label>.json answering)
# are reused and left running.
set -u
cd "$(dirname "$0")"
REFA="$1"; REFB="$2"; LA="$3"; LB="$4"; SCRIPT="$5"; shift 5
up() { # ref label
  local ref="$1" label="$2" state=".cache/$2.json"
  if [ -f "$state" ] && curl -s -m 2 "$(node -p "require('./$state').url")/api/ping" >/dev/null 2>&1; then echo "reuse"; return; fi
  rm -f "$state"
  if [ "$ref" = "WORKTREE" ]; then node instance.js --state "$state" > ".cache/$label.log" 2>&1 &
  else node instance.js --repo "$(node snapshot.js "$ref")" --state "$state" > ".cache/$label.log" 2>&1 & fi
  for i in $(seq 1 120); do [ -f "$state" ] && break; sleep 1; done
  [ -f "$state" ] || { echo "instance $label did not start"; tail -5 ".cache/$label.log"; exit 1; }
  echo "started"
}
down() { [ "$2" = "started" ] && taskkill //PID "$(node -p "require('./.cache/$1.json').pid")" //T //F >/dev/null 2>&1; rm -f ".cache/$1.json"; }
mkdir -p .cache
SA=$(up "$REFA" "$LA"); SB=$(up "$REFB" "$LB")
node "$SCRIPT" --instance ".cache/$LA.json" --label "$LA" "$@" > ".cache/$LA.$SCRIPT.log" 2>&1 &
PA=$!
node "$SCRIPT" --instance ".cache/$LB.json" --label "$LB" "$@" > ".cache/$LB.$SCRIPT.log" 2>&1 &
PB=$!
wait $PA; wait $PB
[ "$SA" = "started" ] && down "$LA" "$SA"
[ "$SB" = "started" ] && down "$LB" "$SB"
echo "== $LA"; tail -n 14 ".cache/$LA.$SCRIPT.log"
echo "== $LB"; tail -n 14 ".cache/$LB.$SCRIPT.log"
