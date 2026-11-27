# Network for streaming (admin → Server)

Why: on a long connection that loses a little data (nufurora in Germany → the
household in Israel, ~72 ms), Linux's default way of sending, CUBIC, slows
right down after every loss. BBR keeps the line full. Measured on real Linux
TCP at 70 ms and 1 % loss: one connection carried 2.9 Mbit/s of a 20 Mbit/s
line with CUBIC and 18.8 with BBR. Players went from long stalls to none
(docs/qa/streaming-efficiency/REPORT.md §3.2, on the research branch).

## What the section shows (no root needed)

- **Way of sending:** the TCP congestion control in force (`cubic` / `bbr`).
- **Queue:** the network card's queue (`fq` goes with BBR), and the default for after a restart.
- **Speed after a pause:** `tcp_slow_start_after_idle`. A player that pauses
  between pieces should not start slow again each time.
- **Data sent twice:** retransmitted ÷ sent, from `/proc/net/snmp`. It is
  sampled every minute over the last hour, plus the total since the server started.
  Above about 0.3 %, BBR matters a lot.
- **This browser's protocol:** HTTP/2 (BBR steers it) or HTTP/3 (it doesn't).
- **Caddy:** whether Caddy also offers HTTP/3.

## The buttons

| Button | What happens |
|---|---|
| Turn on BBR | `net.core.default_qdisc=fq`, `net.ipv4.tcp_congestion_control=bbr`, `net.ipv4.tcp_slow_start_after_idle=0`, and the UDP buffers HTTP/3 wants (raised to 7.5 MB, never lowered). Applied now, and kept after a reboot in `/etc/sysctl.d/90-aurora-streaming.conf` + `/etc/modules-load.d/aurora-bbr.conf`. Every queue of the card is set to `fq`. New connections use BBR at once; films already playing switch when they next connect. |
| Undo | The values from before the first "Turn on", and both files removed. |
| Use HTTP/2 for video | Caddy's HTTP/3 has its own sending, which BBR does not steer and which slows down on lost data much like CUBIC. This adds a marked block at the top of the Caddyfile's global options: `servers { protocols h1 h2 }`. If there is no global options block, one is added. The new file is checked with `caddy validate`. It is then put in place and Caddy is reloaded (`systemctl reload caddy`, which drops nobody). If the check fails, nothing changes. If the reload fails, the old Caddyfile is put back. |
| Back to HTTP/3 | The marked block taken out again; the Caddyfile is byte for byte as before. |

A Caddyfile that already has its own `protocols` line is left alone, and the section says so.

## The one-time setup

Aurora never runs as root. The changes go through one root-owned helper,
`scripts/nufurora/aurora-net-helper`, installed at `/usr/local/sbin/aurora-net-helper`.
It is allowed to Aurora's user by one sudoers line, and it takes only one word:
`status`, `apply`, `undo`, `caddy-h2` or `caddy-h3`.

The section shows the exact line to paste once over SSH. It asks for the sudo
password that one time:

```sh
sudo install -o root -g root -m 0755 <repo>/scripts/nufurora/aurora-net-helper /usr/local/sbin/aurora-net-helper && t=$(mktemp) && echo '<user> ALL=(root) NOPASSWD: /usr/local/sbin/aurora-net-helper' > "$t" && sudo visudo -cf "$t" && sudo install -o root -g root -m 0440 "$t" /etc/sudoers.d/aurora-net; rm -f "$t"
```

When a newer Aurora brings a newer helper, the section says so; paste the
same line again.

## By hand, without the admin

```sh
sudo /usr/local/sbin/aurora-net-helper status
sudo /usr/local/sbin/aurora-net-helper apply      # or undo, caddy-h2, caddy-h3
```

To remove everything:

```sh
sudo aurora-net-helper caddy-h3; sudo aurora-net-helper undo; sudo rm /usr/local/sbin/aurora-net-helper /etc/sudoers.d/aurora-net
```

Tests: `test/nettune-helper.test.js` (the helper in its test mode, stubs for
ip/tc/modprobe/caddy/systemctl), `test/nettune.test.js`, `test/ui/admin-net.test.js`.
