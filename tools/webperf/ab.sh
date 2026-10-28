#!/usr/bin/env bash
# Two versions of the site measured side by side, at the same moment (so
# whatever else the machine is doing slows both alike).
#
#   bash tools/webperf/ab.sh <ref A> <ref B|WORKTREE> <label A> <label B> [run.js args…]
#   bash tools/webperf/ab.sh 190bf9d WORKTREE before after --devices phone-390 --cpu 4 --nets none --runs 5
#   node tools/webperf/compare.js before after
#
# Each ref is unpacked by tools/mobile-perf/snapshot.js (WORKTREE = the files
# as they are now) and gets its own private instance (tools/mobile-perf/
# instance.js); both are stopped at the end, by the PIDs started here.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MP="$HERE/../mobile-perf"
REFA="$1"; REFB="$2"; LA="$3"; LB="$4"; shift 4
mkdir -p "$HERE/.cache"
up() { # ref label -> starts an instance, writes .cache/<label>.json
  local ref="$1" label="$2" state="$HERE/.cache/$2.json"
  rm -f "$state"
  if [ "$ref" = "WORKTREE" ]; then (cd "$MP" && node instance.js --state "$state" > "$HERE/.cache/$label.log" 2>&1 &)
  else local dir; dir="$(cd "$MP" && node snapshot.js "$ref")"; (cd "$MP" && node instance.js --repo "$dir" --state "$state" > "$HERE/.cache/$label.log" 2>&1 &); fi
  for i in $(seq 1 180); do [ -f "$state" ] && break; sleep 1; done
  [ -f "$state" ] || { echo "instance $label did not start"; tail -5 "$HERE/.cache/$label.log"; exit 1; }
}
# (the pid is read through stdin: node on Windows cannot open a /c/... path)
down() { local pid; pid="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(0,'utf8')).pid))" < "$HERE/.cache/$1.json" 2>/dev/null)"; [ -n "$pid" ] && taskkill //PID "$pid" //T //F >/dev/null 2>&1; rm -f "$HERE/.cache/$1.json"; }
up "$REFA" "$LA"; up "$REFB" "$LB"
CA="$REFA"; [ "$REFA" = "WORKTREE" ] && CA=""
CB="$REFB"; [ "$REFB" = "WORKTREE" ] && CB=""
node "$HERE/run.js" --instance "$HERE/.cache/$LA.json" --label "$LA" ${CA:+--commit "$(git -C "$HERE" rev-parse --short=10 "$CA")"} "$@" > "$HERE/.cache/$LA.run.log" 2>&1 &
PA=$!
node "$HERE/run.js" --instance "$HERE/.cache/$LB.json" --label "$LB" ${CB:+--commit "$(git -C "$HERE" rev-parse --short=10 "$CB")"} "$@" > "$HERE/.cache/$LB.run.log" 2>&1 &
PB=$!
wait $PA; wait $PB
down "$LA"; down "$LB"
echo "== $LA"; tail -n 3 "$HERE/.cache/$LA.run.log"
echo "== $LB"; tail -n 3 "$HERE/.cache/$LB.run.log"
