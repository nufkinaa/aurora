# Running Aurora so that it stays up

This page is for whoever runs the server. It covers the supervisor (what
brings Aurora back after a crash, a hang or a reboot) and how to start, stop
and restart it on Windows and on Linux.

## The short version

| Host | Do this once | Then |
| --- | --- | --- |
| Windows PC | `powershell -ExecutionPolicy Bypass -File deploy\windows\install-keeper-task.ps1` from an elevated PowerShell, stop the server that is running now, `Start-ScheduledTask Aurora` | It starts with Windows and restarts itself |
| Linux server | copy `deploy/linux/aurora.service` to `/etc/systemd/system/`, edit its three marked lines, `sudo systemctl enable --now aurora` | It starts at boot and restarts itself |
| Just trying it | `start-aurora.cmd`, or `node scripts/keeper.js` | It restarts itself, but not after a reboot |

`node server.js` on its own still works, and is **not supervised**: a crash or
a hang then lasts until somebody starts it again. The admin page says which
of the two it is (Server → Health → *supervised* / *not supervised*), and the
healer lists an unsupervised server as a finding.

## What the keeper is

`scripts/keeper.js` is a small Node program with no dependencies. It starts
`server.js` as its child and:

- **restarts it when it dies.** A crash is followed by a wait that doubles
  (1 s, 2 s, 4 s … up to a minute, with jitter); staying up for two minutes
  clears it.
- **restarts it when it hangs.** Every 10 seconds it asks the server's own
  `GET /healthz`. Six checks in a row without an answer inside 5 seconds — or
  with an answer saying the event loop was blocked for more than 5 seconds —
  and the server is killed, with its ffmpeg children, and started again. A
  server that never finishes starting (10 minutes) is treated the same way.
- **does not loop.** Five crashes inside ten minutes and it stops trying
  quickly: it writes `GIVING UP` to the log, sends one alert through ntfy /
  Telegram when they are set up in `config.json`, and from then on tries again
  only every 15 minutes. When a retry holds for two minutes it says
  "recovered".
- **keeps the log** where it has always been: `data/server-stdout.log` and
  `data/server-stderr.log`, appended. A file over 50 MB is set aside as
  `.log.1` at the next start of the server (one older copy is kept).
- **writes down what happened** in `data/keeper-state.json`; the admin page
  reads it: supervised by what, uptime, restarts in the last day, why the last
  exit.

The server and its supervisor agree on four exit codes:

| Code | Meaning | The keeper |
| --- | --- | --- |
| 0 | stopped on request | stays stopped if it asked; otherwise starts it again after a second |
| 1 (or any other) | crash | starts it again after the back-off; counted |
| 3 | the watchdog restarting the server (memory over 1300 MB for a minute, or the loop stuck) | starts it again at once; not a crash |
| 75 | "restart me now": the admin page's **Restart Aurora** and **Update and restart** | starts it again at once; not a crash |

## Restarting and stopping

- **Restart from the admin page** (Server → Restart, or Actions → Restart
  Aurora / Update and restart): the server saves every store, tells every
  connected device "restarting — back in a few seconds", lets answers in
  flight finish (4 seconds at most), ends its ffmpeg and download-engine
  processes, and exits with code 75. The keeper starts it again at once;
  devices reconnect by themselves a few seconds later, each after a random
  delay. Measured on a private instance with a small library: down for about
  1.1 seconds (a large library adds the time of its folder scan).
- **When nothing supervises the server** the same buttons are refused with a
  sentence and the server keeps running. (Before, they stopped it and nothing
  started it again.) If something of your own restarts the process — Docker's
  restart policy, NSSM, a loop — say so with the environment variable
  `AURORA_SUPERVISED=1` and the buttons work.
- **From a terminal**, in the Aurora folder:
  - `node scripts/keeper.js --status` — keeper pid, server pid, state, the last five exits
  - `node scripts/keeper.js --restart` — a clean restart of the server
  - `node scripts/keeper.js --stop` — stop Aurora cleanly; the keeper exits too
- **Stopping the keeper stops Aurora.** CTRL-C in its window, `systemctl stop
  aurora`, or `keeper.js --stop` all ask the server to stop cleanly first and
  end it after 12 seconds if it has not.

## Windows

**Why a Scheduled Task and the keeper, and not pm2 or a service.** pm2 on
Windows needs `pm2-windows-startup` (unmaintained), keeps a daemon under the
user profile that starts by itself whenever any `pm2` command is typed, does
not notice a hung process, and opens console windows. A service wrapper
(NSSM) is one more program to download, runs as LocalSystem unless told
otherwise (no mapped drives, a different temp folder and PATH — ffmpeg and
aria2 are found through the user's PATH), and does not notice a hang either.
The keeper is part of the repository, is the same program on Linux, is
covered by the test suite, and Task Scheduler — which is already on every
Windows — only has to start it.

**Install** (once, from an elevated PowerShell in the Aurora folder):

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-keeper-task.ps1
# or, to start before anyone signs in (library on local disks only):
powershell -ExecutionPolicy Bypass -File deploy\windows\install-keeper-task.ps1 -When Startup
```

| | `-When Logon` (default) | `-When Startup` |
| --- | --- | --- |
| Starts | when you sign in — as the shortcut in `shell:startup` did | when Windows boots, before anyone signs in |
| After a power cut | back once you (or auto-logon) sign in | back by itself |
| Network drives (`Z:`, a NAS share) | available | **not available** (no password is stored) |

The script only registers the task. It does not start or stop anything. To
switch over, when the people watching can be interrupted:

1. Stop the server that is running now (CTRL-C in its window, or close it).
2. `Start-ScheduledTask Aurora`
3. `node scripts\keeper.js --status` — it should say `state: ok` and name a server pid.
4. Delete the old shortcut to `start-aurora.cmd` from `shell:startup` if there is one (the installer names it). Left in place it is harmless: a second keeper notices the first and leaves.

There is no window. The log is `data\server-stdout.log`; the admin page's
Logs tab shows it live.

**What the task does.** It runs `conhost.exe --headless node scripts\keeper.js
--host task --quiet` in the Aurora folder, with no time limit, and is started
again by Task Scheduler within a minute should the keeper itself ever be
killed.

**Ending the task from Task Scheduler** ("End") kills the keeper and, with it,
the server at once: Windows ends a child with its parent. Nothing is damaged
(stores are written atomically), but the last second or two of watch progress
may not be saved. Prefer `node scripts\keeper.js --stop`.

**Without the task.** `start-aurora.cmd` now runs the keeper in a window:
Aurora restarts after a crash or a hang, and stops when the window is closed.
`start-aurora.cmd --bare` runs `node server.js` as before.

**Remove:** `powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall-keeper-task.ps1` (elevated).

## Linux

systemd runs the keeper; the keeper runs the server. systemd alone can
restart a process that dies, but it cannot tell that a Node process is hung
without a native module inside it; the keeper probes `/healthz` from outside
instead, and is the same code that is tested on Windows. systemd's part is
the boot, the journal, restarting the keeper itself, and ending every process
of the service on stop.

```bash
sudo cp deploy/linux/aurora.service /etc/systemd/system/aurora.service
sudoedit /etc/systemd/system/aurora.service   # User=, WorkingDirectory=, and the node path in ExecStart=
sudo systemctl daemon-reload
```

If Aurora runs under pm2 today, stop that first, so that two servers do not
fight over the port:

```bash
pm2 stop aurora && pm2 delete aurora && pm2 save      # and `pm2 unstartup` if nothing else uses pm2
sudo systemctl enable --now aurora
systemctl status aurora
node scripts/keeper.js --status
```

Day to day:

```bash
journalctl -u aurora -f            # the live log (also in data/server-stdout.log)
sudo systemctl restart aurora      # a clean restart
sudo systemctl stop aurora         # stop; stays stopped until `start`
```

The unit stops the service with SIGTERM to the keeper, which asks the server
to stop cleanly; whatever is left after 25 seconds is killed by systemd. If
the keeper is killed outright, the server notices its channel closing and
stops by itself, and systemd starts both again.

**Staying on pm2** is still possible: `pm2 start ecosystem.config.js`. pm2
restarts a process that dies; it does not notice one that hangs, and its log
files need `pm2 install pm2-logrotate`. The admin page then shows *supervised
by pm2*, and the Restart buttons work.

## Changing the keeper's timings

Every figure above is a default in `src/lib/keeper.js` (`DEFAULTS`) and can be
set per run: `node scripts/keeper.js --set probeFailures=12 --set
maxDelayMs=120000`. In the systemd unit, add them to `ExecStart=`; in the
Scheduled Task, to the action's arguments.

## What an outside monitor can ask

`GET /healthz` needs no sign-in and answers
`{ ok, uptime, version, loop: { maxMs, p99Ms, meanMs, windowMs } }`: `loop` is
how long the event loop kept requests waiting over the last ten seconds.
While the server is stopping it answers `503 { stopping: true }`.

# Keeping the household's data

Profiles, watch progress, lists, sign-ins and settings live in JSON files
under `data/`. This is what protects them, and what to do when something
goes wrong.

## What happens by itself

- **Every save is whole.** A store is written to a temporary file, flushed to
  the disk (fsync), and renamed over the old one. A crash or a power cut
  leaves either the old version or the new one, never half a file. On Windows
  a rename refused because a scanner holds the file is tried again at once,
  and then every two seconds until it goes through; nothing is forgotten in
  between (the admin page shows *not saved* while it lasts).
- **Two last-good copies** sit beside every store that is not a cache:
  `profiles.json.good1` (newer) and `.good2`, taken at most every ten
  minutes, read back and checked before they count.
- **A daily backup**, verified, kept 7 daily / 4 weekly / 3 monthly. Each
  snapshot's manifest counts the household (profiles, history rows); a
  snapshot whose counts are half the previous one's is flagged and never
  rotates the older ones away.
- **A weekly restore test.** The newest snapshot is restored into a temporary
  folder, read the way the server reads its files at start, counted, and the
  folder removed. The admin page shows the result (Actions → Backups).
- **A damaged store is repaired at start.** If a file is missing, empty, not
  JSON, or JSON of the wrong shape, the server puts back, in this order: its
  newest good last-good copy; the same file out of the newest verified backup
  (either location). The damaged file is kept as `<name>.corrupt-<time>`.
  One alert goes out (the log, ntfy / Telegram) saying which file, what it was
  restored from, and how much time was lost; the admin page lists it under
  Actions → Data safety until you press *Acknowledge*.

## Put the backups on a second disk

By default the snapshots are in `data/backups`, on the same disk as the data.
Add a second location in `config.json`:

```json
{ "backupMirrorDir": "D:\\aurora-backups" }
```

(or `"/mnt/nas/aurora-backups"`; the environment variable
`AURORA_BACKUP_MIRROR_DIR` works too). Restart. Every snapshot is then also
copied there, checked there, and kept there by the same rule; a copy that
fails raises an alert. While every copy is on the data's disk the admin page
says so (Actions → Backups, *one disk*), and the healer says it once.

## Safe mode

If `profiles.json`, `sessions.json` or `settings.json` cannot be read and
there is **no** last-good copy and **no** backup, the server does not start an
empty house over it. It starts in safe mode for that file:

- the file is not written at all (the damaged one stays where it is, and a
  copy is kept as `.corrupt-<time>`);
- the server runs on that store's defaults in memory: with `profiles.json`
  that is the single default profile and no history; with `sessions.json`
  everyone is signed out; with `settings.json` the sign-in wall is **closed**
  (a damaged file must not open a walled server);
- the website shows a red bar on every screen: "Aurora is in safe mode …
  Nothing you do now is kept";
- the admin gets one critical alert, the healer fails its *Data safety*
  check, and the admin page (Actions → Data safety) shows the file with what
  was wrong and where the damaged copy is.

What to do, one of:

1. **You have a good copy somewhere** (an old backup you downloaded, a copy
   on another machine): stop Aurora, put the file into `data/`, start Aurora.
2. **You do not:** press *Start <file> fresh* on that card. Aurora carries on
   from the empty store and saves to it again. The damaged file is kept.

## Restoring a backup

```bash
node src/lib/backup.js list                    # what there is
node src/lib/backup.js drill                   # test a restore; touches nothing
node scripts/keeper.js --stop                  # the server must be stopped
node src/lib/backup.js restore-live newest     # or a snapshot's name
```

`restore-live` shows what the snapshot holds (profiles, history rows, newest
change), asks you to type `restore`, then first makes a snapshot of the data
as it is now — restore that one to undo — and puts the snapshot's data files
back. `config.json` and `.env` are left alone unless `--with-config` is
given. It refuses while Aurora is running. Start Aurora afterwards.

To bring back one file by hand: `node src/lib/backup.js restore <snapshot>
<new folder>`, stop Aurora, copy the file from `<new folder>/data` over the
one in `data/`, delete that file's `.good1` / `.good2`, start Aurora.

## Emptying a store on purpose

Deleting a store's file no longer empties it: the last-good copy comes back
at the next start (and says so in the log). To start one empty deliberately,
stop Aurora and either create an empty file named `<name>.start-empty` beside
it (for example `data/downloads.json.start-empty`) or delete
`<name>.good1` and `<name>.good2` together with the file. For
`profiles.json`, `sessions.json` and `settings.json` use the marker file:
those are also restored from backups.

# When many devices ask at once

A library change tells every connected device to ask again. Three things
keep that from freezing the server (measured before and after in
`docs/qa/capacity/REPORT.md` §3a and the change's own notes):

- **One message per burst of changes.** A scan, the probes finishing, a
  download landing and the admin's rescan each used to send `library_updated`;
  they are collected and one goes out after 1.5 s of quiet, 5 s at the latest.
- **Kept answers.** The finished bytes of `/api/home` (per profile, per kids
  limit, web or TV shape) and `/api/library` are kept for up to 30 seconds and
  thrown away the moment anything they were built from changes — the library,
  that profile's own progress / list / ratings, the recommender's index, the
  catalogue caches, the settings, who the profiles are. An unchanged answer is
  `304 Not Modified` with no body for a client that sends `If-None-Match`
  (the validator is strong: a hash of the bytes).
- **Turns.** The heavy requests (`/api/home`, `/api/library`, `/api/search`)
  take turns with everything else on the event loop, and each client gets a
  fair share: 4 in hand, 24 waiting; past that — or after 8 seconds in the
  queue — the answer is `429` with `Retry-After`. Picture variants have a
  bounded queue too (200 in all, 48 per client); past it the original picture
  is sent.

The counters are in `GET /api/admin/health` under `load`.

## What a client should do (the website does; for the TV app and others)

- On `library_updated`: refresh after a **random 0.5–5 s**, not at once —
  except when Home is on the screen or the change is the device's own (its
  download just landed): then within a random 0–0.3 s, so that a hundred
  devices do not open their connections in the same millisecond. A device that is asleep or in
  the background waits until it is looked at. However many messages arrive
  while a refresh is pending, do one refresh.
- Never have more than one `/api/home` request in flight.
- Send `If-None-Match` with the last `ETag` of `/api/home` and `/api/library`
  and keep the previous answer on `304`.
- On `429`: wait `Retry-After` seconds plus a random 0–1.5 s, then ask again
  (twice at most).
- Reconnect the WebSocket with a doubling wait (1 s → 30 s) **and jitter**:
  wait a random part of it, between half and all. On `server_restarting`
  (sent just before a planned restart, then the socket closes with code 1012)
  wait `retryInMs` plus a random 0–3 s before the first try, and do not show
  "can't reach the server" for the first few tries.

# Background work and the people watching

Some of the server's ffmpeg work is for somebody watching right now (a
transcode, a rendition of the quality ladder). The rest is not: the
play-ready copy made after a download, a phone copy, intro and credits
detection, subtitle OCR, speed calibrations. (The tiny blurred placeholders a page load asks for are left alone: they are a few milliseconds each and somebody is looking.)

Background work now always gives way (`src/media/cpuwork.js`):

- it runs at the **lowest priority** the OS has (Windows: the idle class;
  Linux: nice 19 and the idle I/O class), one step under the viewers' own
  encoders;
- a background encode uses **half the machine's threads** at most;
- it **does not start** while a viewer's stream is being encoded, nor for 20
  seconds after the last one ended;
- one that is already running when a viewer encode starts is **paused** on
  Linux and macOS (SIGSTOP, continued after the quiet period). Windows cannot
  suspend another process without native code: there the idle priority class
  does the yielding — the copy only gets cores nobody else wants;
- background jobs are counted against one small budget, so a play-ready copy,
  OCR and intro detection do not all run together;
- if the viewers' encoders fall behind real time all the same, the newest
  background encode is stopped and put back in its queue.

What a person may notice: a play-ready copy or a phone copy takes longer than
before when the server is busy (it used to take every core at normal
priority), and waits while somebody's stream is being transcoded. A copy a
person asked for goes ahead of the copies made in advance. What is running
for whom is in `GET /api/admin/health` under `load.cpu`.

Measured on 8 logical CPUs of the development PC (a 1080p HEVC → H.264 viewer
encode beside a 4K play-ready copy, three rounds): beside the copy as it used
to run, the viewer's encoder made 1.5–1.8× real time (0.8× in one round);
with the rules above 4.0–4.4×, the same as with no copy running at all.

# How many people can be transcoded for at once

It used to be the number 2, whatever the machine. It is now worked out
(`src/media/encbudget.js`), and shown with its reasons on the admin page:
Server → Encoding — "Automatic: 5 now, because 12 CPU threads × 0.86 (this
machine's measured speed against the reference) × 70% = 7.22 thread-seconds
per second of film, and a 1080p transcode costs 1.23."

- **The machine is measured.** About 25 seconds after the first start the
  server times the ladder's own encoder settings on a generated 1080p picture
  (a few seconds of CPU at the lowest priority, never while somebody's stream
  is being encoded), keeps the result in
  `data/cache/encode-calibration.json`, and measures again only when the CPU
  or ffmpeg changes, or after a month. Until the first measurement it assumes
  a slow machine. "Measure this machine again" on the card does it on demand.
- **Other programs count.** The share of the CPU that everything else on the
  machine is using — looked at while Aurora is encoding nothing — is taken
  off first. A server that shares its box with other work gets a lower number
  while that work runs, by itself.
- **Each encode is weighed by what it costs**, not counted as one: a 4K source
  takes the room of two 1080p ones, a 4K HDR title that is tone-mapped the
  room of three, a 480p rendition less than half of one. The card says how
  many of each fit.
- **70% of the machine at most** goes to viewers' encodes; the rest is for
  the server itself, direct play, downloads and the OS — and is what keeps
  every encode running faster than the film (measured: about 1.3× real
  time each at the limit).
- **Memory is a limit too**: an encoder holds 0.3–1.1 GB; none is started
  that does not fit in what is free, less a 1 GB reserve.

**When a request does not fit**, in this order: a lower quality that does fit
is offered instead (the master playlist lists only those renditions); if none
fits, the request waits up to three seconds for an encoder that is about to
be released; then it gets the quick "Server is busy" — `503` with
`Retry-After` on every stream route (the older single-rendition route used to
answer `500`). One encode is always allowed when nothing else is being
encoded, whatever it costs.

**While running**: if an encoder that somebody is waiting on makes less than
one second of film per second for 15 seconds on a machine whose CPUs are busy,
new encodes are refused for 30 seconds and the newest background job is put
back in its queue — whatever the sums said.

**To set it yourself**: Server → Encoding → *At once* → a number from 1 to 16,
*Apply*. A fixed number is a plain count (every encode one slot, as it always
was). *Automatic* puts it back. The setting is kept in `data/settings.json`
(`maxEncodes`).

What the automatic value comes to (thread budget ÷ cost; the first two scaled
from the reference machine by the capacity study's factors):

| Machine | 1080p → 1080p | 4K → 1080p | 4K HDR → 1080p, tone-mapped |
| --- | --- | --- | --- |
| i5-10400 (6 cores / 12 threads, 0.86× per thread) | 5 | 3 | 1 |
| i5-10210U laptop (4 cores / 8 threads, 0.65×) | 2 | 1 | 1 (alone, below real time) |
| i7-10700K (8 cores / 16 threads, the reference), idle | 9 | 4 | 2 |
| the same with other programs using 39% of it (measured 2026-10-11) | 6 | 3 | 1 |

Measured on the last line: six simultaneous 1080p HEVC → H.264 encodes made
1.34× real time each; eight made 1.07×; nine 0.86× (below real time).

# Behind a reverse proxy (nufurora.com)

nufurora.com runs Aurora behind a reverse proxy that holds the certificate.
What follows is configuration TEXT for Caddy and nginx — nothing here is
applied by Aurora; copy what fits into the proxy's own file. The rules matter
for streaming more than for anything else: a proxy with its defaults can
read a whole film ahead into its own temp files, cut a segment that takes a
while to be made, or close a viewer's WebSocket every minute.

What Aurora expects of the proxy:

- **No response buffering for streams.** `/stream/`, `/air/` (an Apple TV's
  AirPlay links) and `/offline/file/` must flow through as they are made.
  A buffering proxy reads ahead as fast as Aurora can send — on the house's
  hard disk that is the disk working for nobody, and the viewer's own
  back-pressure (what lets direct play share one disk between dozens of
  viewers, `src/lib/diskread.js`) never reaches the server.
- **Range and the validators passed both ways.** `Range`, `If-Range`,
  `If-None-Match`, `If-Modified-Since` in; `Content-Range`, `Accept-Ranges`,
  `ETag`, `Last-Modified` out. Both proxies do this by default unless a cache
  or a body filter is put in the way.
- **Timeouts longer than Aurora's waits.** A jit segment that has to be made
  (an encode, a torrent that is still arriving) may take up to 90 s before
  its first byte (`SEGMENT_WAIT_MS`). Give the upstream read 120 s. The
  WebSocket (on `/`, the same address as the site) is quiet for minutes at a
  time: give it an hour.
- **Upstream keep-alive shorter than Aurora's.** Aurora keeps an idle
  connection 75 s (`server.keepAliveTimeout`); the proxy's idle upstream
  connections must be closed before that (60 s), or a request can be sent on
  a connection Aurora is closing at that moment and fail.
- **Compression: only what Aurora did not.** Aurora compresses JSON, scripts,
  styles and HLS playlists itself (Brotli/gzip, marked `Content-Encoding`) and
  never video. A proxy may compress the rest of the text; it must never
  compress `video/*` or a `206`.
- **Caching: the browser, not the proxy.** Everything a signed-in device
  fetches is marked `private` (films, segments, pictures behind the sign-in
  wall): a shared cache at the proxy would hand one person's answers to the
  next. Aurora's own headers already let each browser keep what can be kept:
  hashed scripts and styles (`?v=<hash>`, `public, max-age=31536000,
  immutable`), posters and backdrops (a week), copied jit segments (named by
  the file's version, `private, max-age=86400, immutable`), torrent copy
  segments (the info hash names their bytes). The proxy runs on the same
  machine as Aurora, so a proxy cache would save a local hop and nothing
  more — leave it off.
- **HTTP/2 (and 3) to the clients.** A player asks for a playlist and its
  segments over one connection; HTTP/2 to the outside is a clear gain. The
  hop from the proxy to Aurora stays HTTP/1.1 with keep-alive.
- **The client's address and scheme.** `X-Forwarded-For` and
  `X-Forwarded-Proto` (Aurora marks the session cookie `Secure` when the
  request came over HTTPS).
- **Body size.** An admin restore or a subtitle upload can be large: allow
  200 MB.

Aurora closes a streaming response whose client has taken no bytes for ten
minutes (a dead connection, a device asleep with the player open); a proxy's
own send timeout to the client may be shorter (nginx: `send_timeout`,
default 60 s) — that is fine, a player asks again with a `Range` when it
resumes.

### Caddy (Caddyfile)

```
nufurora.com {
	# text only — Aurora's own compressed answers carry Content-Encoding and
	# are passed as they are; Caddy's default types never include video
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}

	request_body {
		max_size 200MB
	}

	reverse_proxy 127.0.0.1:4000 {
		# stream bytes the moment they arrive: direct play, segments, /air/
		flush_interval -1
		transport http {
			# idle upstream connections close before Aurora's 75 s
			keepalive 60s
			keepalive_idle_conns 32
			dial_timeout 5s
			# a jit segment may take up to 90 s to its first byte
			response_header_timeout 120s
		}
	}
}
```

Caddy forwards WebSocket upgrades, `X-Forwarded-For` and
`X-Forwarded-Proto` by itself, speaks HTTP/2 and HTTP/3 to clients by
default, and does not buffer responses with `flush_interval -1`.

### nginx

```
upstream aurora {
    server 127.0.0.1:4000;
    keepalive 32;
    keepalive_timeout 60s;      # under Aurora's 75 s
}

map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      '';                 # keep-alive to the upstream when not upgrading
}

server {
    listen 443 ssl;
    http2 on;
    server_name nufurora.com;
    # ssl_certificate / ssl_certificate_key ...

    client_max_body_size 200m;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options nosniff always;

    # text only, and never twice: Aurora's own compressed answers are left alone
    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_proxied any;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # streams: no buffering, no temp files, Aurora's back-pressure reaches it
    location ~ ^/(stream|air|offline/file)/ {
        proxy_pass http://aurora;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_max_temp_file_size 0;
        proxy_read_timeout 120s;     # a jit segment may take up to 90 s
        gzip off;
    }

    # everything else, the WebSocket included (it lives on "/")
    location / {
        proxy_pass http://aurora;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;    # an idle WebSocket
    }
}
```

Checking it from outside (any title id from `/api/library`):

```
curl -sI -H "Range: bytes=0-1023" https://nufurora.com/stream/video/<id>   # 206, Content-Range, ETag
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" -H "Range: bytes=0-1023" https://nufurora.com/stream/video/<id>   # 206 1024
curl -sI -H "Accept-Encoding: br, gzip" https://nufurora.com/stream/transcode/<id>/jit/index.m3u8   # Content-Encoding on the playlist
```

(`/stream/` answers 401 without a session cookie when the sign-in wall is
closed; sign in in a browser and copy its cookie into `-H "Cookie: …"`.)
