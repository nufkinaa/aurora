#!/system/bin/sh
# ONE HTTP connection on the Mi TV, run by toybox `nc -L` (tv-local.sh starts it):
# a /stream/video/<id> request for a film whose bytes were pushed to the TV is
# answered from the TV's own storage; everything else is handed to the private
# rig server on the PC, as it came. So the film's bytes reach ExoPlayer at disk
# speed while the app still talks to the real server for everything else — the
# way to watch the player on a FAST source when the only way from this PC to the
# TV is a slow one (measured 2026-11-28: ~2 Mbit/s over the PC's Wi-Fi).
#   $1  the PC's address   $2  its port
# The films: $D/media/<file>, and $D/ids (lines "<item id> <file>").
D=/data/local/tmp/aurora-qa
PC=$1
PORT=$2
cr=$(printf '\r')
IFS= read -r line
line=${line%$cr}
hdrs=""
range=""
upgrade=""
conn=""
while IFS= read -r h; do
  h=${h%$cr}
  [ -z "$h" ] && break
  case "$h" in
    [Rr]ange:*) range=${h#*=} ;;
    [Uu]pgrade:*) upgrade=1 ;;
  esac
  case "$h" in
    [Cc]onnection:*) conn=$h ;;
    *) hdrs="$hdrs$h$cr
" ;;
  esac
done
set -- $line
method=$1
target=${2%%\?*}
id=""
case "$target" in /stream/video/*) id=${target#/stream/video/} ;; esac
file=""
if [ -n "$id" ]; then
  file=$(grep "^$id " "$D/ids" 2>/dev/null | head -1 | cut -d' ' -f2)
fi
if [ -n "$file" ] && [ -f "$D/media/$file" ]; then
  f="$D/media/$file"
  total=$(stat -c %s "$f")
  case "$file" in *.mp4) ct=video/mp4 ;; *) ct=video/x-matroska ;; esac
  if [ -n "$range" ]; then
    s=${range%%-*}
    e=${range#*-}
    [ -z "$e" ] && e=$((total - 1))
    [ "$e" -ge "$total" ] && e=$((total - 1))
    len=$((e - s + 1))
    printf 'HTTP/1.1 206 Partial Content\r\nContent-Type: %s\r\nAccept-Ranges: bytes\r\nContent-Range: bytes %s-%s/%s\r\nContent-Length: %s\r\nConnection: close\r\n\r\n' "$ct" "$s" "$e" "$total" "$len"
  else
    s=0
    len=$total
    printf 'HTTP/1.1 200 OK\r\nContent-Type: %s\r\nAccept-Ranges: bytes\r\nContent-Length: %s\r\nConnection: close\r\n\r\n' "$ct" "$total"
  fi
  [ "$method" = HEAD ] && exit 0
  exec dd if="$f" iflag=skip_bytes,count_bytes skip="$s" count="$len" bs=262144 status=none
fi
# not ours: the request as it came (asked to close after its answer, so a
# connection that carried it is never reused for a film), then the rest
{
  printf '%s\r\n%s' "$line" "$hdrs"
  if [ -n "$upgrade" ]; then printf '%s\r\n' "$conn"; else printf 'Connection: close\r\n'; fi
  printf '\r\n'
  exec cat
} | nc "$PC" "$PORT"
