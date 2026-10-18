# Storage: the stores stop being the wall

Server round 2026-10-18, STORAGE workstream. Branch `srv-storage`, starting from master `4862136` (server 1.7.1). Measurements come from private instances only. Tools: `tools/backend-perf/storage.js`, `storage-drill.js` and `store-disk.js` (see `tools/backend-perf/README.md`). Raw results are in `docs/qa/backend-efficiency/results/storage-*.json`, `store-disk-*.json` and `sqlite-estimate-round-2026-10-18.json`.

## What was wrong (1.7.1, measured)

Every player reports every 5 s: one progress POST and one WebSocket `activity` message. Each one rewrote a whole store:

- `profiles.json`: every progress POST called `store.save()`, so all profiles and all their history were written 1.5 s later. That is 735 rewrites per viewer-hour.
- `watch-sessions.json`: every activity report saved the whole viewing history. That is another 735 per viewer-hour.
- `telemetry-hours.json`: rewritten every 30 s even when nobody was watching (27.4 MB/h, plus its good copy).
- `sub-audiosync.json` and `sub-langs.json`: rewritten after every background subtitle job (190 and 60 times an hour while the jobs run, 215 + 36 MB/h).
- Every write was synchronous on the event loop: open, write, fsync, rename. The load-test agent saw single calls block for 0.1–10.5 s on a busy disk, and loop stalls of 3–27 s.

Baseline, "grown" household (8 profiles, up to 1,500 history rows, profiles.json 3.8 MB, watch-sessions.json 0.77 MB), whole server:

| 1.7.1 | MB written / h | file rewrites / h | fsyncs / h | loop time in saves s / h | longest save ms | loop delay max ms |
| --- | --- | --- | --- | --- | --- | --- |
| idle | 281 | 430 | 400 | 7.0 | 85 | 8,242* |
| 1 viewer | 3,313 | 2,115 | 1,755 | 109 | 513 | 565 |
| 5 viewers | 5,942 | 4,665 | 2,940 | 621 | 16,985 | 17,197 |
| 20 viewers | 8,988 | 7,290 | 4,410 | 502 | 2,056 | 2,154 |

(*) The idle window included the subtitle background jobs, which also burn CPU. The final tool waits for those jobs to finish first.

## What changed (commits in order)

1. **`575f7b6` Write on a cadence.**
   - `jsonstore.save({ within })` means "this may wait up to N ms". A plain `save()` brings the write forward, and `flush()`/`flushAll()` write it at once.
   - New hooks: `prepare`, `afterWrite`, `digestOnLoad` (the md5 of the text loaded) and `beforeFlushAll`.
   - `watch-sessions.json` is now written at a session's start, its end and on a seek (more than 30 s away from where playback would be). Otherwise it is written at most once a minute.
2. **`8f6b173` Progress no longer rewrites profiles.json: the watch journal** (`src/lib/watchjournal.js`, `data/watch-journal.json`). The design and its rules are below.
3. **`8869e97` `telemetry-hours.json`** is written when an hour closes and at a graceful shutdown. A hard kill loses at most the open hour of that chart (owner-approved). The two subtitle job stores are coalesced to at most one write per 30 s.
4. **`79f7650` + `53bdd16` Keeper logs** (requested by the orchestrator; `src/lib/keeper.js` had no other owner this round).
   - A log is now set aside while the server runs too. Before, rotation happened only at a start.
   - The rotation's own copies are named `.log.r1` and `.log.r2`. The live file plus those copies are capped at 150 MB.
   - **Only the `.rN` copies are ever removed.** The live server's 891 MB `server-stdout.log.1` is from before the keeper and is left where it is. The healer's data-growth check names it on the admin page: Server → Library & data → Data growth, "An old log of 891 MB in data/ — you can delete it". The finding gives the exact delete command and is a warning, never an alert. Verified in Chrome at desktop and phone sizes (`test/ui/admin-oldlog.test.js`).
5. **`4e7678c` Store writes off the event loop** (asked for after the load-test baseline). Every write a timer makes goes through the libuv threadpool, with the same crash-safety. This covers every JsonStore save, the retry after a failure, the last-good copies, and `tel-timings` / `tel-errors` / `tel-controls`.
   - Each write gets its own temp file: fsync, then rename (tried again while the file is locked), then a folder fsync on Linux.
   - Only one write per store is in flight at a time, and a burst during it becomes exactly one more write.
   - `flush()` and `flushAll()` (shutdown, exit, an admin action) stay synchronous. They overtake a write already under way.
   - A synchronous write first waits (up to 3 s) for an asynchronous rename already running in another thread. An overtaken asynchronous write is dropped and never renamed over a newer file.
6. **`0b1111e` `similar.json`** (a ~640 KB cache, rewritten for every new title page) is written at most once a minute. This is srv-eventloop's area; only its four `save()` calls changed.
7. **`9b69e2b` Owner's decision: the journal window is 30 s.** A pause now counts as urgent too. The players keep reporting "Watching" every 5 s while paused; when the position stands still, `realtime.js` has the journal written at once.
8. **`15eb0b7` Ghost states.** The live `profiles.json` held watch state under 20 ids that are no profile and no pending request. At load these are written to `data/profile-states-orphaned.json` (kept, appended to, never deleted, included in backups), and only then removed from `profiles.json`. Each move is logged once.

9. **`35f9788` Checkpoint timing.** The checkpoint is counted from the oldest waiting row. The measurements caught the first tick after an idle stretch rewriting the whole 3.8 MB file.

Plus tools, tests and docs: `tools/backend-perf/{storage,storage-drill,store-disk}.js`, a probe that counts writes made off the loop, `docs/operations.md` (log rotation) and the tools README.

## The watch journal: how it works

- **profiles.json keeps its exact format.** Every profile's whole state stays in it, so an older build reads it as it always did. It is just written less often:
  - on every change that is not a playback tick (exactly as before: lists, ratings, marks, removals, profile edits);
  - at a checkpoint, once a row has waited 15 min for it (counted from the oldest waiting row, so the first tick after a quiet evening is not a full write);
  - at a graceful shutdown (`beforeFlushAll`).
- **A playback tick changes memory at once.** Every device reads memory (`/api/profiles/:id/state`, Home, Continue Watching), so what anyone sees, and when, does not change. Progress is not pushed over the WebSocket; the devices ask, as before.
- **The tick is noted in the journal.** The journal holds every row changed since the last full write of profiles.json (progress, titles, streamItems), plus `base`, the md5 of that profiles.json. It is a JsonStore with all the safety (fsync, last-good copies, recovery from damage, the recovery record) and it is small: only the rows being watched (0.3–4 KB in the runs).
- **When the journal is written:**
  - within 1.5 s on a start, a resume after a pause, a seek, a finish, a pause or a stop (stop means "Browsing" or the socket going away);
  - otherwise at most every **30 s** (owner).
- **At boot:**
  - If the journal's `base` matches the profiles.json just read, the journal is applied exactly.
  - Otherwise (profiles.json restored from a backup or a last-good copy, edited by hand, or written by an **older build that ran in between**), the rows are **merged newest-wins**: a row is taken only when it is newer than the one in profiles.json, nothing is removed, and profiles.json is written whole at once.
  - A profiles.json in safe mode takes nothing from the journal, and the journal file is left untouched.
- **A full write of profiles.json:** rows are tracked by generation, so a write taken before a tick never clears that tick. A journal with rows on disk is re-based and emptied at once.
- **Backups** read the journal before profiles.json, so a snapshot taken across a checkpoint is consistent. The household count includes the journal's rows.

## Results

All runs: `tools/backend-perf/storage.js`, 3-minute windows, interleaved 1.7.1 / branch runs (`storage-b1/b2/a1/a2.json`).

How to read the tables:
- Every figure is scaled to an hour, for the whole server.
- **Write calls** include the usage log's small appends. **On the loop** counts the `fsyncSync` calls that blocked the event loop.
- **Loop delay** comes from a 10 ms-resolution monitor; about 16 ms is the Windows timer floor.
- The machine was busy with other agents' work throughout, so wall-clock figures are upper bounds. Bytes, call counts and fsyncs are not affected.

### Grown household (8 profiles, up to 1,500 history rows; profiles.json 3.8 MB, watch-sessions.json 0.75 MB)

| viewers | MB written / h | fsyncs / h (on the loop) | loop time in saves s / h | longest save ms | loop delay max ms |
| --- | --- | --- | --- | --- | --- |
| idle, 1.7.1 → branch | 29.7 → **0.1** | 140 (140) → 10 (**0**) | 5.3 → 0 | 391 → 0.2 | 749 → 2,009 (not a store: 0 ms in saves) |
| 1, 1.7.1 b1 / b2 | 3,357 / 3,362 | 1,800 / 1,820 (all) | 173 / 103 | 929 / 248 | 1,551 / 949 |
| 1, branch a1 / a2 | **92 / 90** | 460 / 400 (**0**) | **0.9 / 1.4** | 8.5 / 24 | 296 / 73 |
| 5, 1.7.1 b1 / b2 | 6,424 / 6,424 | 3,180 / 3,200 (all) | 208 / 190 | 638 / 307 | 942 / 386 |
| 5, branch a1 / a2 | **117 / 109** | 540 / 560 (**0**) | **1.5 / 1.2** | 9.6 / 17.9 | 58 / 94 |
| 20, 1.7.1 b1 / b2 | 8,989 / 9,600 | 4,400 / 4,680 (all) | 549 / 245 | 980 / 283 | 1,567 / 335 |
| 20, branch a1 / a2 | **127 / 159** | 620 / 720 (**0**) | **1.8 / 1.6** | 14.8 / 10.6 | 60 / 84 |

Per file (rewrites per hour × size):

| file | 1.7.1, 1 / 5 / 20 viewers | branch, 1 / 5 / 20 viewers |
| --- | --- | --- |
| profiles.json | 740 / 1,460 / 2,040–2,180 × 3.7 MB | **0 / 0 / 0** (a checkpoint only once a row has waited 15 min: at most 4/h) |
| watch-sessions.json | 740 / 1,460 / 2,040–2,180 × 0.75 MB | 100 / 140 / 160–200 × 0.75 MB (60 a minute-cadence + starts, stops, seeks) |
| watch-journal.json | — | 160 / 220 / 280–300 × 0.3 / 1.3 / 4.2 KB |
| telemetry-hours.json | 120 × 234 KB (+ its good copy) | 0 (one write when an hour closes) |

"Longest save" is now only the part on the loop: the snapshot (`JSON.stringify` of watch-sessions.json, about 8 ms). The disk part is in the threadpool.

### With a disk hog (a second process writing 16 MB + fsync flat out on the same disk), 5 viewers

| | MB written / h | fsyncs on the loop / h | loop time in saves s / h | longest save ms | loop delay max ms |
| --- | --- | --- | --- | --- | --- |
| 1.7.1 | 6,423 | 3,160 | 288 | 1,105 | 1,138 |
| branch | **107** | **0** | **0.7** | **5.1** | **33** |

### Weak profile (2 cores, 512 MB heap), grown household

| viewers | MB / h 1.7.1 → branch | loop time in saves s / h | longest save ms | loop delay max ms |
| --- | --- | --- | --- | --- |
| 1 | 3,268 → **76** | 35.8 → 0.5 | 39.7 → 4.5 | 65.5 → 34.5 |
| 5 | 6,516 → **122** | 72.2 → 0.7 | 108 → 4.9 | 147 → 56.8 |

### Today's household (5 profiles, ~40 rows; profiles.json ~100 KB in the dataset, 64 KB live)

| viewers | MB / h 1.7.1 → branch | fsyncs on the loop / h | loop time in saves s / h |
| --- | --- | --- | --- |
| 1 | 644 → **76** | 1,700 → 0 | 9.7 → 0.5 |
| 5 | 1,248 → **107** | 3,180 → 0 | 18.4 → 0.8 |
| 20 | 1,893 → **156** | 4,740 → 0 | 28.7 → 0.9 |

The dataset's watch-sessions.json is 0.75 MB, against 100 KB live today. On the live house, the remaining bytes are therefore about a seventh of these.

- **Cross-device check** in every run: the resume point another device reads right after the stop equals the one sent (`resumeSeenByAnotherDevice`), before and after.
- **Intermediate figures** (the journal before writes went off the loop, 60 s window): `storage-after-intermediate-sync-journal.json`.

## SQLite: decided against (stay on JSON)

The numbers, for the same grown household and one viewer-hour:

- **1.7.1 JSON:** 2,621 MB written; 61 s of the loop blocked.
- **SQLite** (node:sqlite, WAL, one transaction per save, `sqlite-estimate-round-2026-10-18.json`): 3.9 MB written; 0.29 s blocked; longest save 21 ms.
- **This branch**, per viewer-hour of progress: the journal writes **0.05 MB** (160 writes of 0.3 KB), and **0 s** of the loop is blocked by the disk. What remains is `watch-sessions.json` (74 MB/h with one viewer in the grown dataset, about 10 MB/h at today's 100 KB). That figure is per household, not per viewer: 20 viewers write 1.4–1.7× what one does.

Why stay on JSON:

1. With the journal, progress costs well under SQLite's 3.9 MB per viewer-hour. The remaining bytes are `watch-sessions.json` at most once a minute (a household-wide figure, not per viewer) and the 15-min checkpoints.
2. Since step 5, writes no longer block the loop at all. `node:sqlite` has only a synchronous API (`DatabaseSync`), so every commit, and every WAL checkpoint on a busy HDD, would wait on the event loop: exactly what step 5 removed. Avoiding that would need a worker thread with its own queue.
3. `node:sqlite` does not exist on Node 20 (CI, and possibly nufurora). SQLite would mean two backends behind one interface, two migrations, two restore paths, and Windows file-locking work. The cost is high for a gain that steps 1–2 and 5 already deliver.

Revisit if `watch-sessions.json` grows to its cap (8,000 sessions, about 3 MB). Moving closed sessions into an append-only file would then be the next step, still without SQLite.

## Migration safety (on a copy of the live data, read only)

`node tools/backend-perf/storage-drill.js --data C:\elia\aurora\data` copies the folder into scratch (without cache/, backups/ — they hold config.json and .env — aria2/, usage/ and logs). It drives progress on the test profile inside private instances. Latest run: **25 of 25 checks**, in `storage-drill.json`.

- **Ghost states:** 20 moved, all 20 kept in `profile-states-orphaned.json`, household untouched (5 profiles, 167 history rows); profiles.json 64.4 → 61.9 KB.
- **kill -9 at random moments (5 rounds, TerminateProcess):**
  - every boot clean (no recovery, no safe mode), the household whole;
  - the resume point never behind the last seek that had time to reach the disk, never beyond the last save;
  - typical loss 1–13 s (the routine window); a seek in the last 1.5 s before the kill can be lost (about 600 s in the drill, because the drill seeks 10 minutes).
- **Downgrade after a hard kill:**
  - 1.7.1 boots clean and the household is whole (it reads profiles.json); it sees the journal's rows only as of the last checkpoint;
  - it plays and writes; this build boots again in **merge** mode, and both the journal-only row and the old build's row are there.
- **Downgrade after a graceful stop:** 1.7.1 sees the very last save (it is in profiles.json).
- Unit and child-process tests repeat these paths: `watch-journal.test.js` (15 tests: exact, merge, safe mode, damage → last-good, checkpoints, ghost rows, a backup snapshot restored into an empty folder), `watch-journal-crash.test.js` (6 kill rounds with the real `profiles.js`, plus a graceful stop) and `jsonstore-async.test.js` (including kill -9 while writing off the loop flat out).

## Other machines (per profile)

`tools/backend-perf/store-disk.js`, `store-disk-{win,linux}-{quiet,hog}.json`. The same store write, both ways, per disk:
- **sync** (1.7.1) is how long the loop was blocked per write;
- **async** (now) is how long the write itself took in the threadpool, and the longest the loop was held while those writes ran. That last figure is measured by a `setImmediate` chain, which on this busy box includes scheduler noise.

| disk | store size | 1.7.1: loop blocked p50 / p99 ms | now: write takes p50 ms | now: loop held max ms |
| --- | --- | --- | --- | --- |
| NVMe (Windows) | 64 KB / 4 MB | 2.5 / 4.0 · 9.0 / 11.1 | 2.7 · 11.4 | 2.2 · 3.5 |
| NVMe + disk hog | 64 KB / 4 MB | 3.6 / 39.9 · 14.8 / 22.4 | 8.5 · 30.7 | 15.8 · 12.7 |
| HDD (Seagate ST1000DM003, Windows) | 64 KB / 4 MB | 27 / 99 · 91 / 165 | 26 · 83 | 10.7 · 5.5 |
| HDD + disk hog | 64 KB / 4 MB | **90 / 393 · 142 / 182** | 59 · 177 | 17.7 · 4.0 |
| network share (SMB, \localhost\C$) | 64 KB / 4 MB | 3.5 / 9.6 · 12.4 / 30.2 | 3.6 · 18.2 | 6.0 · 13.4 |
| Linux ext4 (WSL, Node 22) | 64 KB / 4 MB | 14.7 / 42.6 · 15.4 / 41.5 | 12.7 · 23 | 8.2 · 9.7 |
| Linux ext4 + disk hog | 64 KB / 4 MB | 8.4 / 45 · 22 / 33 | 13.8 · 27.5 | 9.3 · 10.0 |
| WSL /mnt/c (9p, a network-like FS) | 64 KB / 4 MB | 13.3 / 19.0 · 45 / 56 | 18.2 · 56.5 | 8.7 · 8.6 |

On every disk the write still takes as long as the disk needs, but the loop no longer waits for it. On a spinning disk under load, that is 0.1–0.4 s per save, which before landed on every viewer's requests.

- **Linux (WSL Ubuntu, ext4 and 9p/`/mnt/c`):** rename over a file works; the folder fsync works on both.
- **Windows (NVMe, HDD, SMB loopback):** rename over a file works. The folder fsync is not used on Windows (a folder cannot be opened for it).
- **On a network share:**
  - the writes stay atomic: SMB2 rename-with-replace, and fsync is FlushFileBuffers;
  - a folder fsync that NFS/CIFS refuses is caught and skipped;
  - a rename refused for a moment (EPERM/EBUSY/EACCES) is retried, then again every 2 s, and the store stays marked unsaved.
- **No setting depends on the disk type.** The cadences are fixed (30 s, 60 s, 15 min, hourly) and only reduce writes. The writes are off the loop everywhere, so a slow disk now costs time in the threadpool, not on the loop.
- Store and journal tests on Linux Node 20.18 and Node 22.13: 148 pass. The 2 failures are tests that read `tv-native/`, which was left out of that copy; they pass in a full clone.
- Full Linux `npm test` (copy without `tv-native` and `.git`): 1,591 pass, 6 fail. All 6 need `tv-native/` or git and pass in a full clone, on both Node 20 and 22.
- The 2-core weak profile (`--weak`: 2 cores, 512 MB heap) is in the Results tables.

## Tests

All on the final code (`53bdd16`):

- **Root `npm test` on Windows, twice:** 1,640 pass of 1,656, 0 fail, 16 skipped, both times.
- **The whole `npm run test:ui`, twice:**
  - run 1: 267 pass of 270, 2 fail. `player` › "plays to its end and returns" and `search` › "suggestions" fail under load; both files pass alone (33 of 33).
  - run 2: 269 pass of 270, **0 fail**.
- **Earlier full runs:** `subresync` failed in them ("Moved 2.4 s" where 2.5–2.6 is expected). It failed the same way with master's `src/` checked out in this worktree, so it is not this branch, and it passed in the last run. The other earlier failures (page timeouts, `ERR_NO_BUFFER_SPACE`, kids, images, admin-inuse) pass alone, three runs each.
- **Store and journal tests on Linux, Node 20.18 and 22.13:** 148 pass. The only failures are tests that need `tv-native/`, which was left out of that copy.
- **The full Linux suite:** green in a full clone.

New UI test `test/ui/storage-sync.test.js` (real Chrome, desktop then phone, run 3 times alone, green):

- a film watched on a desktop resumes on a phone at the same second ("Resumed at 0:29" after a stop at 33 s; the player resumes 4 s early) and is in Continue Watching;
- profiles.json was not rewritten by the playback ticks (store write counters);
- the journal on disk holds the row right after the stop.

New UI test `test/ui/admin-oldlog.test.js` (desktop + phone, 3 runs). New unit test files: `store-cadence`, `watch-journal`, `watch-journal-crash`, `jsonstore-async`, `keeper-logs`, `realtime-pause`. `jsonstore.test.js` was adapted: writes driven by a timer are awaited.

## Before deploying: what the owner must know

1. **A hard kill (power cut, kill -9, a crash) now loses up to 30 s of resume position** for a title that was simply playing; before, it was about 1.5 s. Starts, seeks, pauses, finishes and stops are written within 1.5 s. A graceful stop or restart (keeper, Ctrl-C, admin restart) loses nothing.
2. **If you roll back to 1.7.1 after a HARD kill**, 1.7.1 does not read `watch-journal.json`. It shows progress as of the last checkpoint (at most 15 min old), and the household itself is complete. Rolling forward again merges the journal back in, so nothing is lost overall. **Roll back after a graceful stop** and 1.7.1 sees everything.
3. **New files in `data/`:**
   - `watch-journal.json` (+ `.good1/.good2`): never delete it while the server runs;
   - `profile-states-orphaned.json`: the 20 ghost states, kept for you; safe to delete by hand once you have looked.
   - Both are taken by the backups.
4. Viewing-session analytics (`watch-sessions.json`) and the hourly chart lag on disk by up to a minute and an hour after a hard kill. Memory, and so the admin page, is live.
5. The keeper never deletes `data/server-stdout.log.1` (891 MB, from October 11). The admin page (Server → Data growth) names it and gives the command to delete it, when you want to.
6. Nothing to configure: no new settings, no change to config.json, Node 20 and 22, Windows and Linux.
7. Deploy as usual and restart. On the first boot the log says the ghost states were moved (once).
