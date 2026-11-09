# HTTP/3 on nufurora.com

Checked from this PC on 2026-11-09. There is no shell on nufurora here, so the
steps below are for elia to run on the server.

## The short answer: HTTP/3 is already on

Nothing has to be turned on. Caddy turns HTTP/3 on by default, UDP 443 is open
all the way to it, and browsers already use it:

| Check (from outside) | Result |
|---|---|
| `Alt-Svc` header on every answer (`/`, `/api/ping`, `/stream/...`, `/download`) | `h3=":443"; ma=2592000` |
| A raw QUIC packet to UDP 443 (version-negotiation probe) | answered in ~80 ms; it offers QUIC v1 and v2 (quic-go, Caddy's QUIC library) |
| Real Chrome, first visit | `h2` (the browser learns about h3 from `Alt-Svc`) |
| Real Chrome, next visit and every visit after | `h3`: the page and all 57 of its files |
| Chrome forced onto QUIC (`--origin-to-force-quic-on`) | everything loads over h3 |
| Range request over h3 (`bytes=100-1123` of `/download`) | `206`, `Content-Range: bytes 100-1123/47407173`, 1024 bytes |
| Range from the end over h3 (`bytes=-512`) | `206`, the right last 512 bytes |
| Long transfer over h3 (24 MB of `/download`, streamed and thrown away) | `206`, every byte, 59–99 Mbit/s; over h2 on the same PC it was 46–71 Mbit/s (this PC's line is the limit) |
| WebSocket (`wss://nufurora.com`) while the page runs on h3 | opens (browsers run WebSockets over TCP, see below) |

The probe and the browser script live in this round's scratch folder. To check
again from any PC you can use the steps in "Verify" below.

## What this means for Aurora's streaming

- **Range requests** (playing and seeking a file directly, `/download`, offline
  saves): Caddy passes `Range` on to Aurora unchanged. Caddy talks to Aurora over
  plain HTTP/1.1 on the same machine whatever the browser used, so Aurora sees no
  difference. Checked above: the prefix and suffix ranges came back right.
- **HLS** (`/stream/.../*.m3u8`, `.ts`, `.m4s`, the JIT segments): these are plain
  GET requests for small files, the same mechanism as above. hls.js (website)
  uses fetch/XHR, which use h3 when the browser has it. Safari's own HLS player
  uses Apple's network stack, which can use h3 too. Not checked signed in on
  nufurora (this PC does not sign in to production). The unsigned
  `/stream/hls/x/index.m3u8` answers `401` with the `Alt-Svc` header, as
  expected.
- **Long downloads**: checked above with 24 MB in one go, no stall and no
  error. On a download the browser sets the flow-control window, and the
  browsers tune it themselves.
- **WebSockets** (watch party, remote, live updates) stay on HTTP/1.1 over TCP.
  No browser runs WebSockets over HTTP/3 (RFC 9220) yet. They keep working
  exactly as before, next to an h3 page. Checked above.
- **TV and phone apps**: their image loader (Fresco), `fetch` (OkHttp) and video
  player (ExoPlayer's default HTTP stack) have no HTTP/3. They keep using TCP
  (h2/h1.1), with no change.

## Risks

- **Networks that block UDP** (some offices, hotels, school Wi-Fi): the browser
  tries QUIC, gets no answer, and uses TCP (h2) by itself, usually racing both,
  so the page does not hang. It then marks h3 as broken for that network for a
  while. Nothing on the server needs to change for this.
- **Server CPU**: QUIC encrypts in user space and uses more CPU per byte than TCP
  with TLS. For one household on 8 cores this is small. If `caddy` ever shows up
  high in `top` during a busy evening of streaming, the switch-off below costs
  nothing but a little speed on bad mobile connections.
- **A UDP buffer warning** (the only real tuning): quic-go wants bigger UDP
  buffers than Ubuntu's defaults. Without them it still works, but heavy
  transfers can drop packets. Step 1 below checks for this and fixes it.

## Steps for elia (copy and paste on nufurora)

### 1. Recommended: give QUIC bigger UDP buffers

Check whether Caddy complained:

```bash
sudo journalctl -u caddy --since "30 days ago" | grep -i "buffer size" | tail -3
```

If it prints a line like `failed to sufficiently increase receive buffer size`,
or to make sure it never does:

```bash
printf 'net.core.rmem_max=7500000\nnet.core.wmem_max=7500000\n' | sudo tee /etc/sysctl.d/60-quic-buffers.conf
sudo sysctl --system | grep -E 'rmem_max|wmem_max'
sudo systemctl restart caddy
```

(A restart takes about a second. Anyone in the middle of a film sees a short
rebuffer at most. Do it when nobody is watching.)

### 2. Check that nothing switches h3 off (read-only)

```bash
caddy version
grep -n -E 'protocols|servers|h3' /etc/caddy/Caddyfile
```

It is fine when there is no `protocols` line, or when it lists `h3`
(for example `protocols h1 h2 h3`). A line like `protocols h1 h2` would turn
HTTP/3 off. Today it is on, so expect no such line.

### 3. Check the firewalls (read-only; it is already open)

```bash
sudo ufw status verbose
sudo ss -ulpn | grep ':443'
```

- `ss` should show `caddy` listening on UDP `:443`.
- With ufw `active`, there should be a line for `443/udp` (or `443` with no
  protocol, which covers both). With ufw `inactive`, nothing to do.
- If you ever turn ufw on, or the rules are rebuilt, keep UDP open:

  ```bash
  sudo ufw allow 443/udp
  ```

  With plain iptables instead of ufw:

  ```bash
  sudo iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p udp --dport 443 -j ACCEPT
  sudo ip6tables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null || sudo ip6tables -I INPUT -p udp --dport 443 -j ACCEPT
  ```

- netcup: if a firewall policy is set for this server in netcup's Server Control
  Panel (SCP), it needs an "allow UDP 443 in" rule next to TCP 443.
  Today UDP 443 answers, so either there is no policy or it already allows it.

### 4. Verify

From any computer:

```bash
curl -sI https://nufurora.com/api/ping | grep -i alt-svc
# expect: alt-svc: h3=":443"; ma=2592000
```

In Chrome: open nufurora.com, open DevTools → Network, right-click the column
header and turn on **Protocol**, reload twice. Expect `h3` for the page, the
scripts and the posters (`h2` on the very first visit is normal). A curl built
with HTTP/3 (`curl --http3 -I https://nufurora.com`) shows `HTTP/3 200`. This
PC's curl (Windows, Schannel) has no HTTP/3, so the check here used Chrome and a
raw QUIC probe.

### If you ever need to switch h3 off

Add to the global options block at the top of `/etc/caddy/Caddyfile`:

```
{
	servers {
		protocols h1 h2
	}
}
```

then `sudo systemctl reload caddy`. Browsers that remember h3 fall back to TCP by
themselves.
