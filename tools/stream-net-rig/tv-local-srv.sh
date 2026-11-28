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
  # A shaped line (streaming round 2): $D/rate holds kbit/s; 0 or no file = disk
  # speed. Read again for every 64 KB, so a line can drop and come back mid-film.
  # Paced to the clock, not by a fixed sleep per chunk: the dd calls' own time
  # does not slow the line below its rate. (A model of a line's rate only — no
  # latency, no loss: that is the PC's netem rig, which cannot reach the TV fast.)
  rate=$(cat "$D/rate" 2>/dev/null)
  if [ -z "$rate" ] || [ "$rate" -le 0 ] 2>/dev/null; then
    exec dd if="$f" iflag=skip_bytes,count_bytes skip="$s" count="$len" bs=262144 status=none
  fi
  # (the TV's sh does 32-bit arithmetic: time is kept as ms since the line's
  # start, and what was sent as 64 KB chunks)
  # (%N's first three digits are the ms; "1" in front keeps a leading 0 from reading as octal)
  ms_now() { set -- $(date '+%s %N'); m=${2%??????}; echo $(( ($1 - S0) * 1000 + 1$m - 1000 - N0 )); }
  set -- $(date '+%s %N'); S0=$1; m=${2%??????}; N0=$((1$m - 1000))
  pos=$s
  left=$len
  chunks=0
  cur=$rate
  base=0
  while [ "$left" -gt 0 ]; do
    n=65536
    [ "$left" -lt "$n" ] && n=$left
    dd if="$f" iflag=skip_bytes,count_bytes skip="$pos" count="$n" bs="$n" status=none || exit 0
    pos=$((pos + n))
    left=$((left - n))
    chunks=$((chunks + 1))
    rate=$(cat "$D/rate" 2>/dev/null)
    [ -z "$rate" ] && rate=0
    if [ "$rate" -le 0 ]; then
      exec dd if="$f" iflag=skip_bytes,count_bytes skip="$pos" count="$left" bs=262144 status=none
    fi
    now=$(ms_now)
    if [ "$rate" != "$cur" ]; then
      cur=$rate
      chunks=0
      base=$now
      continue
    fi
    # where the clock should be for what has been sent: a 64 KB chunk is
    # 524288 bits = 524288 / rate ms (written so it cannot overflow 32 bits)
    due=$(( base + chunks * 5243 / (rate / 100) ))
    ahead=$((due - now))
    if [ "$ahead" -gt 2 ]; then
      sleep "$((ahead / 1000)).$(printf %03d $((ahead % 1000)))"
    fi
  done
  exit 0
fi
# not ours: the request as it came (asked to close after its answer, so a
# connection that carried it is never reused for a film), then the rest
{
  printf '%s\r\n%s' "$line" "$hdrs"
  if [ -n "$upgrade" ]; then printf '%s\r\n' "$conn"; else printf 'Connection: close\r\n'; fi
  printf '\r\n'
  exec cat
} | nc "$PC" "$PORT"
