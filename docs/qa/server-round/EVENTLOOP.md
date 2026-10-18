# Server round 2026-10-18: the event loop and background work

Branch `srv-eventloop`, from master 4862136 (server 1.7.1). The goal was that nothing a viewer does waits behind the server's own housekeeping, and that the same CPU serves more people. This round covers items 3–12 of `docs/qa/backend-efficiency/REPORT.md` ("Plan for what is left"), the background passes added in 1.7.x, and what a profiler found under load.

## How it was measured

- **Rig.** `tools/backend-perf`, the rig from the backend-efficiency round, with new tools added (listed at the end).
- **Instances.** Every run is a private instance with its own data folder and port and its outbound network refused. The live server was never touched.
- **Library.** Synthetic: 1,201 films plus 60 shows × 10 episodes (1,801 files and 1,383 folders), 8 profiles, caches at live sizes.
- **Weak profile.** `--weak` pins the server to two CPUs that are different cores and caps the heap at 512 MB.
- **Busy machine.** This PC (i7-10700K, 16 threads) sat near 99 % CPU from other agents all day. Wall-clock and loop-delay figures are upper bounds and noisy. CPU time, call counts and bytes are robust. Where the load could not be shared fairly, the numbers that ran in different minutes are not compared.
- **Before against after.** Unless a row says otherwise, two instances of two commits ran side by side and took turns (A B A B …), with at least three runs each.
- **Other machines.** These were checked on Linux too (WSL Ubuntu, Node 22.13 and 20.18):
  - CPU affinity with `taskset`: 1, 2, 4, 8 and 16 threads.
  - Low memory: a 384 MB heap cap.
  - File systems: ext4, a 9p/drvfs share (network-like) and NTFS.

## Results

| # | Change | Before → after |
| --- | --- | --- |
| 3 | Blur-up only for what a screen draws, no still made for a placeholder | picture ffmpeg runs in the 90 s after a first visit: 978 / 270 / 229 → 81 / 79 / 43, and the queue *ends* at ≤ 120 per answer instead of ~2,500 shrinks + ~2,500 variants + up to 1,260 stills |
| 9 | Library scan walk in a worker thread, built from a snapshot | unchanged rescan: worst ping 3,217 → 210 ms, loop busy 3,533 → 805 ms, main-thread fs calls 4,441 → 1. Changed rescan: worst ping 8,552 → 193 ms, loop busy 17,150 → 1,391 ms, fs 8,659 → 108 |
| 4 | An unchanged rescan keeps the index (`index.version`) | work redone after a rescan that found nothing: 145–279 ms → 0–0.2 ms |
| 9b | Restart serves the last walk at once; first walk after listen | no folder read before listening. With nothing saved, library requests wait for the first walk (≤ 20 s) |
| 9c | Background rescans coalesced (subtitle passes, OCR) | one per burst, at most one per 30 s, instead of a full rescan 3 s after every file a pass finished |
| — | A replaced file is probed again (needsProbe looks at the date) | before: never; after: on the next enrich pass |
| 6 | Intro pass dates from the walk (1.6.94's "remember unanalysable" checked and working) | 600 blocking stats per pass → 0 (87 → 0.5 ms) |
| 5 | Title-page metadata: stale-while-revalidate, one request per title, failures remembered, weekly warm, meta.json ≤ 1/min | Cinemeta requests 8,701 → 777 per hour. A stale title page: 502 (refetch failed) → 200 from the old answer |
| 8 | Picture fast path, async sweeps and writes | blocking fs calls per request: /img/ext 4 → 0, title page 6.25 → 0.75, episode 4.75 → 0, sidecar subtitle 4.9 → 0 |
| 10 | Bounded caches + sizes in admin health | usage tables ≤ 500 keys, blur-up memory 20,000, stream probes / trackers 2,000, title metadata 6,000, probe cache pruned of gone files |
| 11 | Child-process hygiene | stuck speech decode stopped after 3 min (paused time excluded); children killed on exit; buffers bounded; boot-time lookups time-limited |
| 7 | Low-power profile, from cores / RAM / heap (and config) | weak box idle CPU 156 → 131 s/h, heap 86 → 81.5 MB, blocking fs 6,240 → 5,003 /h; one heavy decode at a time on ≤ 8 threads |
| 12 | App shell kept 2 s; CSS bundle looked at once per 2 s | GET / 28.2 → 3.3 ms CPU (best), 318 → 0 fs calls inside the window |
| 12 | Scan on the main thread reads no more than before; cheaper relative paths | 5,767 → 3,263 fs calls (master: 3,194–3,659) |
| new | Credits analysis in a worker; background reads async | longest loop delay during the analysis 108–140 → 17–27 ms |
| 11 | One shared colour probe (ladder + tone mapping) | 2 → 1 ffprobe per source |
| profiler | Modules re-printed at start-up, off the loop | first visitor after a restart: shell 7.5 → 2.2 s, shell + 63 modules 16.7 → 3.9 s, loop busy 12.2 → 3.6 s |
| profiler | Helper processes started from a worker thread | loop busy per process start 12.7–45 → 0.2–2.6 ms |
| profiler | No existsSync before every cover | 682 calls / 1.3 s per loaded 3 min → 0 |
| follow-up | Picture variants: waiting bounded by time (2.5 s): the nearest size made or the original at once, shed; the variant still made once | first-sight picture browse p95 8,381 → 5,191 ms, p99 12,456 → 5,727 ms, worst 14.9 → 6.3 s, pictures/min 629 → 806 |
| profiler | Shell render looks at each module once | 312 → 64 stats per render, 25 → 6 ms |

### A household under load, start to finish

`tools/backend-perf/loopab.js --weak`: master (4862136+tools) against the final tree, side by side, with 8 clients on the household mix (Home after a progress save, library, state, title pages, search, pictures ×10, progress saves, subtitles, the shell) and a rescan every minute. There were 4 windows of 1.5–2.5 min each, taking turns, and the machine was at about 99 %, so the absolute times are long. Medians and totals over the windows:

| | master | final |
| --- | --- | --- |
| request groups answered per minute | 55.9 | 86.5 (+55 %) |
| wall time p50 / p99 | 918 ms / 138 s | 377 ms / 103 s |
| server CPU (cores) | 0.129 | 0.111 |
| event loop busy | 70.5 % | 57.7 % |
| loop delay p99 / worst | 756 ms / 35.5 s | 501 ms / 10.3 s |
| blocking fs calls on the main thread per minute | 6,366 | 1,131 (−82 %) |

| p50 per kind (ms) | master | final |
| --- | --- | --- |
| profile state | 2,884 | 63 |
| title page / episode | 545 / 512 | 273 / 159 |
| search keystroke | 669 | 353 |
| 10 pictures | 8,147 | 4,356 |
| progress save | 79 | 26 |
| app shell | 2,494 | 378 |
| Home (composed) | 2,171 | 1,750 |
| sidecar subtitle | 111 | 495 |

The sidecar subtitle got slower. Its file is now read with `fs.promises`, and on a machine this loaded that read waits behind the libuv thread pool, where `sendFile` of the pictures and the compression also run. The test instances run with Node's default pool of 4. An installed server runs under the keeper, which sets `UV_THREADPOOL_SIZE=6` (lib/keeper.js). A blocking read of a file on a spinning disk would hold everyone instead, which is why this was kept. The thread-pool size is the place to tune it (srv-streaming / srv-resilience).

The remaining time in "pictures" is first-sight variant encodes (2 at a time by design) and the machine's load.

### What the profiler found

`tools/backend-perf/loopload.js --profile` ran 8 clients on the weak profile, with a rescan every minute, for 3 minutes. Self time on the main thread was split by caller with `cpuprof-callers.js`. Master is 4862136+tools; "after" is the final tree.

| Where the main thread went | master | final | |
| --- | --- | --- | --- |
| `stat` (native), the rescan's statSync | 24.5 s | — | the walk is on a worker thread |
| `readdir` (native), the rescan | 9.2 s | — | same |
| `stat`, subaudio "fresh?" | 0.9 s | — | dates from the walk |
| esbuild `transformSync`, the first page load | 13.8 s | — | `jsassets.warm()` after listen |
| `spawn`, picture-variant encodes | 13.3 s | — | `lib/spawner.js` |
| `getNearestParentPackageJSON`, a `require()` in `budget()` | (1.6 s in one build) | — | `lib/lazy.js` |
| `stat`, shell render | 1.1 s | 1.1 → 0.2 s | `jsassets.within()` |
| request groups answered in the 3 min | 95 | 692 | |
| worst loop delay | 45.7 s | 7.5 s | |

**What is left** in the final profile belongs to other workstreams:

- **The stores (srv-storage):** `jsonstore._writeNow` + `writeSync` + `fsync` take about 15 s of the 3 minutes, from `profiles.json` written after progress saves; `materializeProgress` takes 2.2 s.
- **Composing Home:** recs `scoreAll` / `buildRows` / `collectEvents` / `buildModel` take about 13 s, and `res.json` stringify 3 s.
- **`os.cpus()` in `encbudget.js` (srv-streaming):** its idle sampling every 15 s cost 0.85–0.94 s of `getCPUs` per 3 minutes on Windows.
- **process.env reads in `supervisor.detect`:** 0.5 s; it could be read once.
- **Blocked catalogue fetches:** these are undici `init` work (1.1 s), and they exist only because the test fence refuses them.

## The 1.7.x background passes on a busy server

| Pass | Through cpuwork | Heavy decodes side by side | Yields to viewers | After a restart |
| --- | --- | --- | --- | --- |
| sublang (language, alignment) | yes ("sublang", pausable) | never on ≤ 8 threads (budget 1) | lowest priority; paused (Linux) | results per path + date (sub-langs.json): only unknown work is queued |
| subaudio / speech (audio sync) | yes ("speech", pausable) | same | same; a stall stops it after 3 min, paused time excluded | per subtitle + video date (sub-audiosync.json); timelines cached per file + date |
| creditscv (credits picture) | yes ("credits"), stopped when a viewer encode starts | same | analysis now in a worker | per episode + date (intro-auto.json `cv`); a cut-off decode is retried later |

Their "the library learned something" rescans are now one per burst, at most one every 30 s, and the walk runs on a worker thread. Sidecar reads in these passes are asynchronous.

## Other machines

| Machine | Profile chosen | Background budget | Rescan |
| --- | --- | --- | --- |
| 1 thread (`taskset -c 0`) | low ("1 CPU thread") | 1 | 20 min |
| 2 threads | low | 1 | 20 min |
| 4 threads | low | 1 | 20 min |
| 8 threads | normal | 1 ("8 or fewer: one heavy decode at a time") | 10 min |
| 16 threads, 32 GB (this PC) | normal | 2 | 10 min |
| heap capped at 384 MB | low ("a 432 MB JavaScript heap") | 1 | 20 min |
| `"powerProfile"` in config.json | as set | as profile | as profile |

- **Admin health.** Every value is shown in Server → Health ("power profile" card) with its reason. Windows follows the process's CPU affinity too: a weak-pinned instance reports 2 threads.
- **Folder dates**, checked on ext4, 9p/drvfs (a network-like share) and NTFS. On all three:
  - a new, renamed or removed file is seen on the next walk (listings are always read);
  - a file rewritten in place under the same name is seen on the next full walk (every 6th, and every scan somebody waits for).
  - Case-different twins stay two entries on Linux, and paths compare exactly.
- **Tests.**
  - Linux: `npm test` passed on Node 22 and Node 20: 1,601 passed and 56 skipped (no ffmpeg in WSL). The 2 failures are the updatecheck tests, which need a git checkout; the archive had none.
  - Two cores (`taskset -c 0,1`): the power, cpuwork, scanner, caches, spawner, children, metadata, shell and credits tests passed.

## Blocking fs calls on the main thread that remain, in this workstream's files

| Where | When | Why it stays |
| --- | --- | --- |
| `scanner.scan()` (sync), 3,263 calls | after a download lands, a delete, the admin's Rescan | the caller needs the index now; same count as master |
| `imgcheck` stat / `imgvariant` 2 stats + md5 | once per picture per 30 s | the trust window; a miss checks again |
| `jsassets.asset()` stat | each `/js/*.js` request, and once per module per shell render | a /js revalidation must see an edit at once (tests depend on it) |
| `speech.cached()` readFileSync, `store()` writeFileSync | a Resync of an already-synced film; once per decoded film | rare; a few MB at most |
| `subtitles` cache reads, `stills`/`online` existsSync | per extraction / per poster fetch | small files |
| the stores' saves (jsonstore) | sublang, subaudio, intro, discover, metadata | srv-storage's `jsonstore.js` |

## Touches outside this workstream (for the merge)

| File | What |
| --- | --- |
| `src/profiles.js` (srv-storage) | `ensureTitles`: stamp `scannedAt` → `version`, skip states with no profile (2 hunks) |
| `src/routes/stream.js` (srv-streaming) | artwork sweep + write asynchronous (`extImgSweep`, `fetchExtImage`); `/img/:id` without existsSync |
| `src/media/torrent.js`, `src/media/streamprobe.js` (srv-streaming) | `sourcesByHash` / `results` bounded; streamprobe buffers bounded + tracked + spawned via lazy children |
| `src/media/ladder.js`, `src/media/tonemap.js` (srv-streaming) | the shared colour probe (`tonemap.probeJson`) |
| `src/media/cpuwork.js` (shared) | `budget()` by threads / low power, `paused()`, children tracking |
| `src/lib/healer.js` | overdue scan → `scanAsync({ full })`; round every 3 min in low power |
| `src/routes/api.js`, `src/routes/requests.js`, `src/routes/profiles.js`, `src/media/identity.js`, `search.js`, `searchindex.js`, `recs/index.js` | `scannedAt` → `version` memo keys |

## Not verified

- **A real spinning disk, and a real network share.** The call counts are what a disk sees; seek times were not measured. A 9p share stood in for SMB/NFS.
- **A RAM-starved box.** Only a heap cap was tried; no cgroup was set up.
- **The Mi TV.** No TV code changed, so no TV pass was needed.
- **`subresync` UI test.** It fails on this machine on master too ("Moved 2.4 s" against /2.[56]/), so it is not from this branch.
- **Several UI files under concurrent load.** admin-inuse, admin, ai, live, boot and player-hls each failed once while other runs were going on. Each passed alone, 1–3 times.

## Tools added (tools/backend-perf)

- `loopab.js`: the load A/B in windows that take turns.
- `loopload.js`: one commit under load, with `--profile` (saves a .cpuprofile).
- `cpuprof-callers.js`: self time by caller.
- `scanloop.js` + `inproc/rescan.js`: the rescan as a pinging client feels it.
- `blurfirst.js`: a first visit asking for placeholders.
- `upstream.js`: Cinemeta requests per hour.
- `powercmp.js`: normal against low on one commit.
- `firstpage.js`: the first page load after a start.
- `inprocab.js` + `inproc/intro-mtimes.js`, `inproc/intro-pass.js`: an in-process A/B.
- `instance.js`: retries when the probe's port was taken, and on a keep-alive reset.
- `probe.js`: longer keep-alive.
- `dataset.js`: probe cache v6.
- `lib.js`: `EFF_RESULTS`.

## Commits (srv-eventloop, on top of 4862136)

| | |
| --- | --- |
| 83dec3c | tools/backend-perf: measurement rigs for the server round (event loop) |
| cf404a3 | Blur-up placeholders only for what a screen draws; no still made for one |
| 513f785 | The library scan off the event loop; an unchanged rescan keeps the index |
| 8128545 | A video replaced under the same name is probed again (needsProbe looks at the date) |
| bba8b7f | The intro pass takes episode dates from the library walk: no stat per episode |
| faa8c86 | Title-page metadata: stale while revalidate, one request per title, failures remembered, weekly warm |
| 07a4ebc | Pictures and per-request reads off the event loop: no re-validation per request, sweeps and writes asynchronous |
| 891c992 | Bounds for the caches that only grew, and their sizes on the admin's health page |
| 992116a | Helper processes: time limits, bounded output, ended with the server |
| 3e51dce | A low-power profile chosen from the machine; one heavy decode at a time on small boxes; "why" on the admin's health page |
| 84e746d | The app shell and the stylesheet bundle are not re-checked on every page load |
| 9fda035 | A scan somebody waits for reads no more than before; cheaper relative paths |
| 73b5970 | Background subtitle passes: the credits analysis off the event loop, file reads without blocking |
| eac698e | One colour probe for the server: the quality ladder and the tone mapping share it |
| 93b650b | The website's modules are re-printed at start-up, off the event loop |
| 873f634 | Helper processes started from a worker thread; in-function requires asked for once |
| 7f5d649 | No blocking existsSync before every library cover |
| cbd0624 | Writing the app shell looks at each module once |
| 50471ce | tools/backend-perf: the load, profile and A/B rigs of the event-loop round |

| 937bdc4 | Picture variants: waiting is bounded by time, not only by queue length |

Each commit message carries its own before/after numbers and the tests it adds.
