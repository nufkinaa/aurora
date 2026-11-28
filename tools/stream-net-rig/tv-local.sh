#!/usr/bin/env bash
# The Mi TV's 127.0.0.1:4000 (the only server a QA build knows) as a small
# relay ON THE TV, instead of `adb reverse` (which runs over adb, measured at
# 0.25 MB/s here — slower than the films):
#
#   tv-local.sh start <pc-ip> <pc-port> [<item id>=<file pushed to the TV> ...]
#   tv-local.sh stop
#   tv-local.sh push <local file> <name on the TV>      (slow: the TV's Wi-Fi)
#
# Each connection runs tv-local-srv.sh: a /stream/video/<id> request whose film
# was pushed to the TV is answered from the TV's storage (disk speed — a "LAN"
# with no line in it), everything else goes to <pc-ip>:<pc-port> as it came.
# With no <id>=<file> pairs it is a plain relay to the PC (the PC's own line).
# Nothing outside /data/local/tmp/aurora-qa is written; `stop` ends only the
# relay this script started (its pid is kept in that folder).
set -u
DEV=${DEV:-192.168.50.31:5555}
D=/data/local/tmp/aurora-qa
export MSYS_NO_PATHCONV=1
adb_() { timeout "${T:-30}" adb -s "$DEV" "$@"; }
# (Windows paths for adb under Git Bash: path conversion is off above)
winpath() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
here=$(winpath "$(dirname "$0")")
tmp=$(winpath "${TMPDIR:-/tmp}")
case "${1:-}" in
  start)
    pc=${2:?pc ip}; port=${3:?pc port}; shift 3
    "$0" stop >/dev/null 2>&1
    adb_ reverse --remove tcp:4000 >/dev/null 2>&1
    adb_ shell mkdir -p $D/media
    adb_ push "$here/tv-local-srv.sh" $D/srv.sh >/dev/null || exit 1
    ids=""
    for pair in "$@"; do ids="$ids${pair%%=*} ${pair#*=}"$'\n'; done
    printf '%s' "$ids" > "$tmp/tv-local-ids"
    adb_ push "$tmp/tv-local-ids" $D/ids >/dev/null || exit 1
    adb_ shell "chmod 755 $D/srv.sh; nohup nc -s 127.0.0.1 -p 4000 -L sh $D/srv.sh $pc $port >/dev/null 2>&1 </dev/null & echo \$! > $D/relay.pid"
    sleep 1
    # (toybox nc ends at its stdin's end: hold it open while the answer comes)
    adb_ shell "(printf 'GET /api/ping HTTP/1.0\r\n\r\n'; sleep 3) | nc -w 5 127.0.0.1 4000 | head -1"
    echo "tv-local: relay pid $(adb_ shell cat $D/relay.pid) on the TV's 127.0.0.1:4000 -> $pc:$port ($# films local)"
    ;;
  stop)
    pid=$(adb_ shell cat $D/relay.pid 2>/dev/null | tr -d '\r')
    if [ -n "$pid" ]; then
      # only that pid, and only if it is still our nc
      adb_ shell "grep -q nc /proc/$pid/cmdline 2>/dev/null && kill $pid; rm -f $D/relay.pid"
      echo "tv-local: stopped $pid"
    fi
    ;;
  push)
    T=3600 adb_ push "${2:?file}" "$D/media/${3:?name}"
    ;;
  *) echo "usage: $0 start <pc-ip> <pc-port> [id=file ...] | stop | push <file> <name>" >&2; exit 2 ;;
esac
