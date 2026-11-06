# Auto-update for nufurora.com

nufurora.com can update itself. A small script runs every ten minutes and:

1. fetches from GitHub;
2. picks the newest release: the newest commit tagged `server-<version>-stable`
   (the release tool tags `server-<version>-stable` when a release is ready);
3. waits while anyone is watching or has a player paused;
4. moves the folder to that release, runs `npm ci` only if
   `package-lock.json` changed, and restarts Aurora;
5. checks that the new version answers `/healthz`. If it does not within five
   minutes, it goes back to the old version, restarts it, and skips that
   release until a newer one appears.

It never changes a folder with local commits or files changed by hand, and it
never sends a notification unless you set one up (`ALERT_CMD`).

The files: `scripts/nufurora/update.sh` (the script),
`scripts/nufurora/probe.js` (asks the server), `scripts/nufurora/update.conf.example`
(every setting), `deploy/linux/aurora-update.service` and `.timer`.

## 1. How does Aurora run there today?

On the VPS, in the Aurora folder (below: `/opt/aurora`; use yours):

```bash
systemctl status aurora                 # a systemd unit called aurora?
pm2 ls                                  # or pm2? (skip if "command not found")
node scripts/keeper.js --status         # is the keeper running? which pid?
ps -ef | grep -E 'keeper|server\.js' | grep -v grep
```

| What you see | How the updater restarts Aurora |
| --- | --- |
| `aurora.service` active, running `scripts/keeper.js` (the recommended set-up, `docs/operations.md`) | `node scripts/keeper.js --restart`. No root needed. |
| the keeper running without systemd | the same |
| `aurora.service` active, running `server.js` itself | `systemctl restart aurora`. Needs root or the sudoers line below. |
| pm2 lists `aurora` | `pm2 restart aurora` |
| none of these | it does nothing and logs why |

The keeper restarts only the server, not itself. When an update changes the
keeper's own code (`scripts/keeper.js`, `src/lib/keeper.js`), the updater uses
`systemctl restart aurora` if it is allowed to. If not, it still restarts the
server through the keeper, and the log says that the keeper's own code loads at
the next `sudo systemctl restart aurora`.

If Aurora is on pm2, think about moving it to the keeper first
(`docs/operations.md`, "Linux"): the keeper also restarts a server that hangs.

## 2. Before you start

```bash
cd /opt/aurora
git remote -v                 # origin  https://github.com/nufkinaa/aurora(.git)
git branch --show-current     # master
git status --short            # nothing listed with M (files changed by hand)
node -v                       # v22.x (CI tests on Node 22 only, docs/ci.md)
git fetch --tags origin && git tag -l 'server-*-stable'   # the releases it may install
```

- The folder must be a git clone, on the branch `master`, with no local
  commits and no tracked files changed by hand. Untracked files (`data/`,
  `.env`, `config.json`) are fine.
- The user that owns the folder must be able to read the admin password: it
  is read the way the server reads it (`AURORA_ADMIN_PASSWORD` in `.env`, or
  `adminPassword` in `config.json`). Without it the updater cannot see who is
  watching, and does not update (see `WATCH_CHECK`).
- If no `server-*-stable` tag exists yet, it does nothing and says so once a day.

## 3. Install

```bash
sudo cp deploy/linux/aurora-update.service deploy/linux/aurora-update.timer /etc/systemd/system/
sudoedit /etc/systemd/system/aurora-update.service   # User=, WorkingDirectory=, ExecStart= path, PATH if node is elsewhere
sudo systemctl daemon-reload
```

Settings are optional. To change one:

```bash
sudo cp scripts/nufurora/update.conf.example /etc/aurora-update.conf
sudoedit /etc/aurora-update.conf      # uncomment and change a line
```

## 4. A first dry run

A dry run decides and logs what it would do, and changes nothing (it does fetch):

```bash
sudo -u aurora env DRY_RUN=1 bash /opt/aurora/scripts/nufurora/update.sh
```

Read the last line. Examples:

```
2026-11-06T10:00:01Z up to date: 48ed1b5b9 (server-1.15.11-stable is 48ed1b5b9)
2026-11-06T10:00:01Z 2 watching or paused; trying again next run
2026-11-06T10:00:02Z DRY RUN: would update to server-1.15.12-stable: 48ed1b5b9 (1.15.11) -> 9c1d2e3f4 (1.15.12); npm ci: no; restart via keeper (the keeper (pid 812))
```

If it says "no way to restart Aurora was found" or "could not read how many
are watching", fix that first.

## 5. Turn it on

```bash
sudo systemctl enable --now aurora-update.timer
systemctl list-timers aurora-update.timer        # when it runs next
```

## Watching it

```bash
tail -f /opt/aurora/data/auto-update.log         # everything it did, UTC times
journalctl -u aurora-update -n 50                # the same, from systemd
```

An update looks like this:

```
... nobody is watching
... updating to server-1.15.12-stable: 48ed1b5b9 (1.15.11) -> 9c1d2e3f4 (1.15.12); npm ci: no; restart via keeper (the keeper (pid 812))
... restart via keeper: exit 0: Aurora was restarted (server pid 90211).
... UPDATED to server-1.15.12-stable: 48ed1b5b9 (1.15.11) -> 9c1d2e3f4 (1.15.12), healthy after 6 s
```

"Healthy" means: `/healthz` answers ok, with the new version, from a process
that started after the restart.

## Pause, resume, run now

```bash
sudo systemctl disable --now aurora-update.timer   # pause
sudo systemctl enable --now aurora-update.timer    # resume
sudo systemctl start aurora-update.service         # one run now
```

## Follow master instead of releases

In `/etc/aurora-update.conf`: `MODE=master`. Every new commit on
`origin/master` is then installed, tagged or not. `MODE=stable` goes back to
tagged releases only. (Going back never moves the folder backwards: it waits
for a tag newer than what is installed.)

## When a release fails: the rollback

The log then says:

```
... the new version did not become healthy within 300 s (last answer: no answer (ECONNREFUSED)); rolling back to 48ed1b5b9
... ROLLED BACK to 48ed1b5b9 (1.15.11), healthy after 5 s; server-1.15.12-stable is skipped until a newer one appears
```

The old version is running again; nothing else needs doing. To see why the new
one failed: `data/server-stderr.log` or `journalctl -u aurora`. The failed
release is skipped until a newer tag appears. To try the same one again, delete
the `bad_target=` line from `data/auto-update.state`.

Exit codes (`systemctl status aurora-update` shows the last one):

| Code | Meaning |
| --- | --- |
| 0 | nothing to do, put off (someone watching), a dry run, or updated |
| 1 | refused, nothing changed: the log says why (local changes, no way to restart, password missing, fetch failed...) |
| 2 | the new version failed and was rolled back; the old one is healthy |
| 3 | a person must look: the rollback did not bring a healthy server back |
| 4 | set-up problem: settings, not a git clone, git or node not found |

## Notifications (off by default)

Nothing is sent unless you set `ALERT_CMD` in `/etc/aurora-update.conf`. It
runs after a rollback and after three runs in a row that could not update,
with the message in `$1`. For an email (needs a working `mail` command):

```bash
ALERT_CMD='printf "%s\n" "$1" | mail -s "Aurora auto-update" you@example.com'
```

For a check from outside that the site is up at all, see
`docs/nufurora-uptime.md`.

## Optional: let it run `systemctl restart aurora`

Only needed when systemd runs `server.js` directly, or so that a keeper update
takes effect at once. The keeper path needs no root. As root, `visudo -f
/etc/sudoers.d/aurora-update` and add (user `aurora`, unit `aurora`):

```
aurora ALL=(root) NOPASSWD: /usr/bin/systemctl restart aurora, /bin/systemctl restart aurora
```

Check it with `sudo -u aurora sudo -n -l systemctl restart aurora`.

## Cron instead of the timer

As the user that owns the folder, `crontab -e`:

```
PATH=/usr/local/bin:/usr/bin:/bin
*/10 * * * * /bin/bash /opt/aurora/scripts/nufurora/update.sh >/dev/null 2>&1
```

The log file has everything. Two runs never overlap (the script takes a lock).

## Uninstall

```bash
sudo systemctl disable --now aurora-update.timer
sudo rm /etc/systemd/system/aurora-update.service /etc/systemd/system/aurora-update.timer
sudo systemctl daemon-reload
sudo rm -f /etc/aurora-update.conf /etc/sudoers.d/aurora-update
rm -f /opt/aurora/data/auto-update.*      # its log and state
```

## Good to know

- The admin page's own **Update and restart** keeps working: the folder stays
  on `master`, moved forward only.
- Who is watching lives in the server's memory. Right after any restart,
  viewers take a little while to reconnect, so a server that started less than
  two minutes ago is left alone (`MIN_SERVER_UPTIME`).
- The install step is `npm install --omit=dev` (as the admin's own updater
  does), not `npm ci`: `npm ci` empties `node_modules` first, and a module the
  running server loads late would be missing until the restart. It only runs
  when the lockfile changed and nobody is watching (`NPM_CI_CMD` overrides it).
- A run stopped half-way (a reboot during an update) is finished by the next
  run.
- The admin password is sent only to `127.0.0.1` and never written to the log.
