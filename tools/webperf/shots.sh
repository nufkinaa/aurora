#!/usr/bin/env bash
# Pixel proof for a change: every screen at rest, before and after, each side
# photographed twice, compared pixel for pixel (tools/mobile-perf/shots.js and
# diff.py — see that README for how motion is held still).
#
#   bash tools/webperf/shots.sh <ref A> <ref B|WORKTREE> <name> [shots.js args…]
#   bash tools/webperf/shots.sh 190bf9d WORKTREE batch1
#       -> tools/mobile-perf/out/<name>-{a1,a2,b1,b2}/shots, out/diff-<name>/report.json
#
# Default devices: the owner's five sizes (desktop 1440×900, iPad 1024×1366
# and 820×1180, phones 390×844 and 360×800), both looks.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MP="$HERE/../mobile-perf"
REFA="$1"; REFB="$2"; NAME="$3"; shift 3
ARGS=("$@")
[ ${#ARGS[@]} -eq 0 ] && ARGS=(--devices desktop-1440,tablet-1024,tablet-820,phone-390,phone-360x800 --looks glass,legacy)
mkdir -p "$HERE/.cache"
up() { # ref label
  local ref="$1" label="$2" state="$HERE/.cache/$2.json"
  rm -f "$state"
  if [ "$ref" = "WORKTREE" ]; then (cd "$MP" && node instance.js --state "$state" > "$HERE/.cache/$label.log" 2>&1 &)
  else local dir; dir="$(cd "$MP" && node snapshot.js "$ref")"; (cd "$MP" && node instance.js --repo "$dir" --state "$state" > "$HERE/.cache/$label.log" 2>&1 &); fi
  for i in $(seq 1 180); do [ -f "$state" ] && break; sleep 1; done
  [ -f "$state" ] || { echo "instance $label did not start"; tail -5 "$HERE/.cache/$label.log"; exit 1; }
}
down() { local pid; pid="$(node -p "require('$HERE/.cache/$1.json').pid" 2>/dev/null)"; [ -n "$pid" ] && taskkill //PID "$pid" //T //F >/dev/null 2>&1; rm -f "$HERE/.cache/$1.json"; }
up "$REFA" "$NAME-A"; up "$REFB" "$NAME-B"
cd "$MP"
for run in 1 2; do
  node shots.js --instance "$HERE/.cache/$NAME-A.json" --label "$NAME-a$run" "${ARGS[@]}" > "$HERE/.cache/$NAME-a$run.log" 2>&1 &
  PA=$!
  node shots.js --instance "$HERE/.cache/$NAME-B.json" --label "$NAME-b$run" "${ARGS[@]}" > "$HERE/.cache/$NAME-b$run.log" 2>&1 &
  PB=$!
  wait $PA; wait $PB
done
down "$NAME-A"; down "$NAME-B"
echo "== noise floor (A against A)"
python diff.py "out/$NAME-a1/shots" "out/$NAME-a2/shots" | tail -3
echo "== A against B"
python diff.py "out/$NAME-a1/shots,out/$NAME-a2/shots" "out/$NAME-b1/shots,out/$NAME-b2/shots" --out "out/diff-$NAME"
