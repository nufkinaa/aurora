# SQLite stores

Since this change, the data files that grow, or that are rewritten while people
watch, download or upload, keep their rows in one SQLite file per data folder:
`data/aurora.db`. Everything else stays a JSON file. The code is
`src/lib/sqlitestore.js`, under `src/lib/jsonstore.js`. Callers did not change:
a store is still `store.data` in memory, with `save()` and `flush()`.

## Which stores

| In SQLite (`jsonstore.js` `SQLITE_STORES`) | Why |
| --- | --- |
| `watch-sessions.json` | up to 8,000 sessions, written about once a minute per viewer. A new session is one row instead of a rewrite of the whole file. |
| `telemetry-hours.json` | up to 2,160 hours, written every hour |
| `watch-history.json` | up to 2,000 rows, written on every watch |
| `downloads.json` | written about every 10 s while something downloads |
| `uploads.json` | written on every chunk received |
| `requests.json`, `reports.json`, `replacements.json`, `auth-log.json` | lists that grow and are written on every event |
| `sub-audiosync.json`, `sub-langs.json`, `intro-auto.json`, `intro-prints.json` | grow with the library, written by background jobs |
| `healer.json` | 12 maps and a log, written on every check round |

These stay JSON files, and why:

- **`profiles.json`, `sessions.json`, `settings.json`.** They are critical: they have safe mode, and the backups and restore drill count from them. Progress is already cheap through the watch journal (`watch-journal.json`, about 0.3 KB per write). The journal is folded back into `profiles.json` at shutdown so that an older build reads it, and that coupling is the riskiest part to move. They are phase 2, if wanted.
- **Small config-like stores:** `push`, `bans`, `intros`, `idpins`, `badreleases`, `dlsources`, `password-resets`, `mylistdl`, `household-recs`, `untouched`, `drives`, `imdb-map`. They are kilobytes and rarely written.
- **Bookkeeping and caches:** `daily`, `watchdog`, `health`, and everything in `cache/`. The server rebuilds them itself, and the backups leave them out. Several caches also replace their whole data on each write, so rows would not save anything.

## Engine and settings

- **Engine:** Node's built-in `node:sqlite`. It works without a flag from Node 22.13; CI and nufurora run Node 22, and this PC runs 22.13.1. Without it (an older Node), every store stays a JSON file, exactly as before. Node's "experimental" warning is not printed.
- **Settings:** WAL, `synchronous=NORMAL`, `busy_timeout` 2 s, and a `schema_version` table (version 1). A database made by a newer schema is not touched: run that version's export first.
- **Writes:** one transaction per store write, holding only the rows that changed since the last write. A commit has no fsync.
- **Checkpoints:** done by a worker thread (`src/lib/sqlitestore-worker.js`) with its own connection, every 5 s while something changed. That is the step that fsyncs, so it stays off the event loop. If the worker cannot run, SQLite's own autocheckpoint takes over. At shutdown, `flushAll` runs a TRUNCATE checkpoint.
- **Durability:** a process crash or kill loses nothing that was committed. A power cut can lose the last few seconds (since the last checkpoint), but never the file's integrity.
- **Reads:** never touch SQLite. The store lives in memory and is read once at boot.

## The switch (first start of this build)

For each store:

1. It is loaded from its JSON file exactly as before, including every recovery (last-good copy, backup, safe mode).
2. In **one transaction**, its rows are written, then read back, rebuilt and compared: the row count, and the md5 of the content both ways. The transaction commits only if both match.
3. The JSON file is renamed `<name>.migrated-YYYYMMDD-HHMMSS`. It is kept and never deleted.

If anything fails, the store stays a JSON file and the log says so plainly: `[store] X: NOT moved into SQLite (...)`.

- **A kill before the commit** leaves nothing changed.
- **A kill between the commit and the rename** is finished at the next start: the JSON file still has the md5 it was migrated from, so it is only renamed.
- **Stores in safe mode are never moved.**
- **A process that does not own the data folder** (`.aurora-owner.json`) only reads, and moves nothing.

The switch happens while the stores load, which is before the server listens, so no request ever sees a half-moved store.

**Timings** (this PC, loaded by other agents):

- First start on today's real data: about 120 ms for all 14 stores.
- At the stores' caps (8,000 sessions, 8.3 MB of JSON): about 1.5 s on a quiet machine. watch-sessions alone takes 0.55 s of that.
- Later starts: about 100 ms today, about 0.8 s at the caps.

## A JSON file that comes back

When a store is in SQLite and its JSON file appears again, the file's age decides. This can happen after an export for a downgrade, after an older build ran, after a backup was restored, or after a store fell back to JSON because SQLite would not take writes.

- **Newer than the store's last SQLite write:** the file is the truth and is imported (the same verified transaction). What SQLite held is kept as `<name>.sqlite-before-<time>.json` when it differs.
- **Older:** SQLite stays the truth. The file is set aside as `<name>.conflict-<time>`, kept, and logged.

## Going back to an older build

1. Stop Aurora.
2. Run `node scripts/sqlite-export.js`. It writes every SQLite store back as its JSON file, atomically, and reads each one back. It refuses while the server runs.
3. Start the older build. It reads the JSON files as always. It ignores `data/aurora.db`.

Coming forward again imports those files (they are newer).

`--out <folder>` writes a copy elsewhere, and is safe while the server runs. `--dry-run` only says what would be written.

Without the export, an older build finds no JSON file. It restores each store from its `.good1` last-good copy, which is at most about 10 minutes old (the copies are still written for SQLite stores), and logs that as a recovery.

**Switch-off:** `"sqlite": false` in `config.json`, or `AURORA_SQLITE=0`. The next start hands every store back to its JSON file by itself, and the server then runs on JSON. Removing the switch imports the files again.

## Damage

- **A damaged JSON file at the switch:** recovered exactly as before (last-good copy, backup, safe mode or defaults), then moved.
- **A damaged database** (not a database, malformed, or a failed `quick_check` at open): it is moved aside whole as `aurora.db.corrupt-<time>`, with its `-wal` and `-shm`, and never written over. A new database is started, and each store is recovered from its last-good copy, then the newest backup, then its `.migrated-*` file, with a recovery record (admin page, Server → Data safety). A database that is only locked for a moment is asked again for 2 s and is never taken for damage.
- **A damaged row:** the store's raw rows are written to `<name>.corrupt-<time>`, and the store is recovered the same way.
- **Writes that keep failing:** the store is marked unsaved and tried again (`Failed to save ...`, the line the healer reads). After 3 failures in a row, the store is written as its JSON file for the rest of the run, and the next start imports it again.
- **Two processes writing one store** (only possible when no server owns the folder): the last writer wins, and the store is written whole, so the rows are never a mix.

## Backups (for whoever works on `src/lib/backup.js`)

`createSnapshot` calls `require("./sqlitestore").backupEntries(dataDir)`, which returns:

- **`data/<name>.json` for every store in SQLite.** This is exactly what the JSON file would hold. A newer JSON file beside the database is copied as it is instead.
- **`sqlite/aurora.db`.** All of these come from **one** `VACUUM INTO` copy of the database, made by the worker in the server and directly in the CLI, so they are consistent with each other.

So `summarize`, the drill, `copyFromSnapshotsSync` (the boot's "restore a damaged store from the newest backup") and `restore-live` all work unchanged.

**Restoring:** put the `data/*.json` files back. The next start imports them, because they are newer. `sqlite/aurora.db` is a consistent copy to inspect or keep; a restore does not need it. If you ever restore it by hand, delete `data/aurora.db-wal` and `data/aurora.db-shm` first.

**Never copy `data/aurora.db` raw while the server runs.** Use `backupEntries`, `snapshotTo`, or `scripts/sqlite-export.js --out`.

## nufurora.com

Nothing is needed. It runs Node 22 via nodesource, which is newer than 22.13. The first start after the update makes the switch by itself. To go back, use the export above.
