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
