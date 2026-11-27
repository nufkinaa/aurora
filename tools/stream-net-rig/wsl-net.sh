#!/bin/sh
# A real-TCP shaped line inside WSL2, for the stream rig (README.md).
# Run as root in the Ubuntu distro:  wsl.exe -d Ubuntu -u root -e sh wsl-net.sh <cmd> ...
#
# SLOT (env, 0-99, default 0) names one line, so two can exist side by side and
# one being taken down never touches another:
#   namespace  auranet<SLOT>
#   sa<SLOT> 10.77.<2·SLOT>.2   <->  ra<SLOT> 10.77.<2·SLOT>.1     the SHAPED link
#   sb<SLOT> 10.77.<2·SLOT+1>.2 <->  rb<SLOT> 10.77.<2·SLOT+1>.1   a plain link
#
#   up                       the namespace and its two veth pairs (an old one of the same slot is removed first)
#   shape DOWN UP RTT LOSS   netem on both ends of the shaped link:
#                              sa egress (server -> viewer): RTT/2 delay, DOWN kbit/s, LOSS %
#                              ra egress (viewer -> server): RTT/2 delay, UP kbit/s
#                            queue: about 250 ms at the rate (a home router's buffer)
#   cc cubic|bbr             the server namespace's TCP congestion control
#   ssai 0|1                 net.ipv4.tcp_slow_start_after_idle in the server namespace
#   show                     the qdiscs and the sysctls
#   down                     remove the namespace (and with it every veth of the slot)
#
# Nothing outside the namespace and its veths is touched: the root namespace's
# own sysctls, qdiscs and routes stay as they are. "down" (or a WSL shutdown)
# leaves no trace. tcp_bbr / sch_netem are kernel modules loaded once
# (modprobe), used by nothing else.
set -e
SLOT="${SLOT:-0}"
NS="auranet$SLOT"
A=$((SLOT * 2))
B=$((SLOT * 2 + 1))
cmd="$1"; shift || true

limit_for() { # rate kbit/s, one-way delay ms -> packets netem may hold (delay line + ~250 ms queue)
  awk -v r="$1" -v d="$2" 'BEGIN { p = r * 1000 / 8 / 1500 * (d + 250) / 1000; if (p < 30) p = 30; printf "%d", p + 10 }'
}

case "$cmd" in
  up)
    modprobe tcp_bbr 2>/dev/null || true
    modprobe sch_netem 2>/dev/null || true
    modprobe sch_fq 2>/dev/null || true
    ip netns del $NS 2>/dev/null || true
    ip link del ra$SLOT 2>/dev/null || true
    ip link del rb$SLOT 2>/dev/null || true
    ip netns add $NS
    ip link add ra$SLOT type veth peer name sa$SLOT
    ip link add rb$SLOT type veth peer name sb$SLOT
    ip link set sa$SLOT netns $NS
    ip link set sb$SLOT netns $NS
    ip addr add 10.77.$A.1/30 dev ra$SLOT
    ip addr add 10.77.$B.1/30 dev rb$SLOT
    ip link set ra$SLOT up
    ip link set rb$SLOT up
    ip netns exec $NS ip addr add 10.77.$A.2/30 dev sa$SLOT
    ip netns exec $NS ip addr add 10.77.$B.2/30 dev sb$SLOT
    ip netns exec $NS ip link set lo up
    ip netns exec $NS ip link set sa$SLOT up
    ip netns exec $NS ip link set sb$SLOT up
    # no GSO/TSO on the shaped pair: netem and the loss model see real packets
    ethtool -K ra$SLOT gso off tso off gro off 2>/dev/null || true
    ip netns exec $NS ethtool -K sa$SLOT gso off tso off gro off 2>/dev/null || true
    echo "up: $NS"
    ;;
  shape)
    DOWN="$1"; UP="$2"; RTT="$3"; LOSS="${4:-0}"
    HALF=$(awk -v r="$RTT" 'BEGIN { printf "%.1f", r / 2 }')
    LD=$(limit_for "$DOWN" "$HALF")
    LU=$(limit_for "$UP" "$HALF")
    ip netns exec $NS tc qdisc replace dev sa$SLOT root netem delay ${HALF}ms rate ${DOWN}kbit loss ${LOSS}% limit $LD
    tc qdisc replace dev ra$SLOT root netem delay ${HALF}ms rate ${UP}kbit limit $LU
    echo "shape: down ${DOWN} kbit/s, up ${UP} kbit/s, rtt ${RTT} ms, loss ${LOSS}% (limits $LD/$LU pkts)"
    ;;
  cc)
    ip netns exec $NS sysctl -q -w net.ipv4.tcp_congestion_control="$1"
    echo "cc: $(ip netns exec $NS cat /proc/sys/net/ipv4/tcp_congestion_control)"
    ;;
  ssai)
    ip netns exec $NS sysctl -q -w net.ipv4.tcp_slow_start_after_idle="$1"
    echo "ssai: $(ip netns exec $NS cat /proc/sys/net/ipv4/tcp_slow_start_after_idle)"
    ;;
  show)
    ip netns exec $NS tc qdisc show dev sa$SLOT
    tc qdisc show dev ra$SLOT
    echo "cc=$(ip netns exec $NS cat /proc/sys/net/ipv4/tcp_congestion_control) ssai=$(ip netns exec $NS cat /proc/sys/net/ipv4/tcp_slow_start_after_idle)"
    ;;
  down)
    ip netns del $NS 2>/dev/null || true
    ip link del ra$SLOT 2>/dev/null || true
    ip link del rb$SLOT 2>/dev/null || true
    echo "down"
    ;;
  *)
    echo "usage: SLOT=n wsl-net.sh up|shape DOWN UP RTT LOSS|cc cubic|bbr|ssai 0|1|show|down" >&2
    exit 2
    ;;
esac
