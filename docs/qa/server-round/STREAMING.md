# Server round 2026-10-18 — streaming

Branch `srv-streaming` (from master `4862136`, server 1.7.1). Goal: more simultaneous streams on the same hardware, steadier under load, standard practice for media serving. Every change below is its own commit with its numbers; this page collects them, says how they were taken, and what is left.

## How it was measured

- **The house server is this PC**: i7-10700K (8 cores / 16 threads), 32 GB, library on a real 7,200 rpm disk (`E:`, Seagate ST1000DM003), system and cache on NVMe (`C:`), RTX 3090 (driver 610.88), Windows 11, Node 22.13.
- **Real films, read-only.** 28 films from the live library were hard-linked (no copy, no write to the files) into `E:\aurora-agents\srv-streaming\lib\movies`; the live library folders were never touched. The links were removed at the end (the originals checked: every size unchanged, one name each again). A private instance (`scripts/ui-test-server.js`) served them. For SSD runs 8 films were copied to `C:`.
- **Cold reads.** The disk tests read regions no earlier run had read (tracked in a file), so the OS cache does not flatter them.
- **Simulated viewers** (`tools/streamload/`): `direct.js` — `<video>`-like players (one open Range request, start at 2 s in hand, read ahead to 30 s, a stall = the buffer running dry), two of them through `tools/throttle-proxy.js` lines (18 Mbit/s, 30 ms); `hls.js` — hls.js-like players on the jit stream (30 s buffer, TTFS, stalls, 503s, the instance's own ffmpeg children's CPU from the OS); `rewatch.js`, `ahead.js`, `diskread.js`, `hwbench.js`, `torrentmem.js`. Server CPU, memory and event-loop delay come from inside the instance (`stats-preload.js`).
- **Before/after** are two private instances started side by side from a copy of the base commit and the branch, measured in turn (A B A B), so the PC's noise falls on both.
- **The PC was busy throughout** — other agents' builds, tests and encodes, often 100 % CPU (measured). Wall-clock figures are therefore pessimistic; counts, bytes and CPU seconds hold.

## Results

### 1. Direct play on a spinning disk (`06899dc`, `e638e78`)

`/stream/video` read every film with 64 KB chunks, every viewer for itself: N viewers made the head jump between N places every 64 KB. Now `src/lib/diskread.js` reads 1 MB at a time and lets at most 2 reads per disk run at once, the rest in order (one outstanding read per stream = round robin; a slow viewer is never starved by a fast one). `src/lib/disktype.js` asks the OS what each disk is and picks the pattern:

| Disk kind (detected) | Reads | At once per disk |
| --- | --- | --- |
| HDD (Windows MediaType HDD; Linux rotational=1 on a real disk) | 1 MB | 2, in turns |
| SSD / NVMe | as before: 64 KB `fs.createReadStream` | free |
| network share, virtual disk (VPS virtio, Hyper-V/WSL), unknown | 512 KB | 4 |

Viewers at 12 Mbit/s on the HDD, 40 s, cold regions, 2 of them on slow lines:

| Viewers | Before: stalled / data read | After: stalled / data read | Startup p50 before → after |
| --- | --- | --- | --- |
| 10 | 0–1 / 0.92–0.99 GB | 0 / 0.99–1.01 GB | 0.9–1.9 s → 0.7–0.9 s |
| 13 | 0 / 1.27 GB | — | 1.6 s |
| 16 | **16 of 16** / 0.75 GB | — | 3.3 s |
| 20 | **20 of 20** / 0.40–0.96 GB | **0** / 1.95–1.97 GB | 3.3–4.0 s → 1.4–1.8 s |
| 30 | **30 of 30** / 0.62–0.73 GB | **0** / 2.84–2.90 GB | 5.8–6.6 s → 2.1–2.2 s |
| 40 | — | 0 / 3.23 GB | 2.7 s |
| 50 | — | 2 (1.2 s in all) / 3.12 GB | 3.2 s |
| 60 | — | 60 of 60 / 3.03 GB | 5.0 s |

**About 13 → 45 simultaneous direct-play viewers at 12 Mbit/s on one hard disk** (the disk delivers ~80 MB/s with the new pattern against ~20 MB/s before at 20+ readers). The two throttled viewers never stalled where the others did not. Server CPU 0.2–0.3 core at 30–50 viewers; memory 112 → 115–164 MB.

Raw disk, 12 films flat out (`diskread.js`): 64 KB reads 53–80 MB/s in all; 1–4 MB reads 87–119 MB/s; the slowest reader 2.5–4 MB/s free-for-all against 6.3–8.9 MB/s in turns.

**SSD (NVMe), the same rig**: turns cost a flash disk throughput (12 readers flat out: 2 at once 1.5–2.2 GB/s against 3.1–3.4 GB/s free), so an SSD keeps the old reader. End to end, 12 Mbit/s viewers, 2 rounds, startup p50: 40 viewers before 0.43–0.91 s · after 0.47–0.51 s · "unknown" pattern 0.31–0.38 s; 80 viewers before 1.0–2.3 s · after 0.82–1.49 s · "unknown" 0.46–0.68 s; no stalls anywhere. Nothing got slower.

HTTP byte serving (`src/lib/rangeserve.js`): strong ETag + Last-Modified; If-Range (a changed file gets all of it, 200); If-None-Match / If-Modified-Since → 304; a malformed Range is ignored (was a 206 of the whole file); 416 for an unsatisfiable one; HEAD reads nothing; the file's stat kept 2 s instead of existsSync + statSync per range request; `Cache-Control: private`; a response whose client took no bytes for 10 minutes is closed.

### 2. Job folders never deleted on the event loop (`ac876de`)

The load test saw one `fs.rmSync` of a finished `data/cache/hls` job hold the loop 12.8 s. Every job-folder removal (remux, torrent transcode, jit) now renames the folder away at once and deletes it on a worker thread (`src/lib/rmqueue.js`). 1,500-file, 1.5 GB folder: `rmSync` held the loop 2.6–2.7 s; `fs.promises.rm` 16–420 ms worst case; the worker 17–23 ms (the PC's timer noise).

### 3. The encode gate and other programs' load (`53574d6`)

encbudget refused every new encode for 30 s when a watched encode fell behind on a machine 85 %+ busy — whoever kept it busy. It now also needs Aurora's own encoders to be at least half of what is busy (`ownShare`); beside foreign load it says so in the log and nobody is refused. On a box that only serves, nothing changes.

### 4. jit copy segments kept by the player (`c212e14`)

Copy segments are named by the file's version (`&m=`) and sent `private, max-age=86400, immutable`; encoded renditions and old URLs stay `no-cache` (their bytes depend on how they were encoded).

### 5. Decoder threads (`8fde8a8`)

The decoder of a software encode gets 4 threads (6 above 1080p) instead of one per CPU. 4K HEVC 10-bit: 914 → 602 MB, same CPU, same speed; 1080p HEVC 480 → 383 MB; 1080p H.264 369 → 299 MB.

### 6. Idle jit segments kept and bounded (`a6b9a3c`)

An idle job's published segments stay under a manifest (table rule, ffmpeg, the encoder's exact arguments) and are reused only if made the same way; the jit cache is swept (no manifest / old rule / 6 h unused → removed; then least recently used while over 20 GB or under 5 GB free). Pause 200 s and watch the same 10 segments of a 720p encode again: **12.6 s → 0.31 s**, no encoder.

### 7. Budgets from the CPUs this process may use (`bd5f30b`, `435f2a9`)

With an affinity mask, a container cpuset or a cgroup CPU quota the server counted every CPU of the box: on 2 of 16 threads it admitted 5 transcodes of 8 x264 threads each. `src/lib/cpucount.js` now gives the smaller of `os.availableParallelism()` and (Linux) the cgroup quota (`cpu.max`, v1 `cfs_quota_us`), used by encbudget, the ladder's and the older encoders' threads and cpuwork. 2 threads → limit 1, x264 2 threads; 4 → 1 (before calibration), 2; 16 → unchanged; fake cgroup files in the tests.

### 8. Torrent streaming memory and upload (`c7f8b9c`)

A private two-client swarm (`torrentmem.js`, 1.2 GB at 24–30 MB/s, 8 MB pieces): the process grew to 235–1,291 MB (4 of 9 runs over 1.1 GB, the watchdog's soft line is 1 GB) — garbage V8 does not collect while the heap is small (a forced GC holds it at ~220 MB). `src/lib/memnudge.js` runs one full collection when ArrayBuffers pass 384 MB (at most every 5 s): 6 runs peaked at 336–509 MB. Uploads are capped at 512 KB/s by default (`torrentUploadKBps`, -1 = no cap) so the home uplink stays for remote viewers — **not measured** (no real swarm).

### 9. Streams under load (`dcef774`)

- **Copies no longer run to the end of the film.** jit copy producers park 40 segments ahead of their reader (encoders: 20); the TV's offset jobs (remux.js) are suspended 50 segments ahead and resumed at 20 (`src/lib/procpause.js`: SIGSTOP/SIGCONT, NtSuspendProcess/NtResumeProcess on Windows). One TV offset viewer + one website jit viewer, 5 min: cache/hls **436 → 185 MB**, cache/jit **1,681 → 140 MB**, ffmpeg **272 → 71 CPU-s**, the same film delivered to both.
- **409 "Playlist first"**: the table cache is an LRU (200) instead of being cleared whole at 100 and by every soft heal; one in-flight index read per file; async reads; a declined file answers 404 (its playlist does too), which the website's player turns into the offset path from the playhead ~9 s later (`test/ui/jit-withdrawn.test.js`, 5 runs; the TV never plays jit).
- **No false declines**: a producer cut short inside a segment declines the file only the second time at the same place; a job broken by a transient error is made again after 10 s.

### 10. A damaged stretch is bridged, not declined (`d87e8b5`)

The load test's decline (Inception (2010).mkv, then 103 × 409 at 48 viewers) is a damaged file, not a wrong table: ffprobe reports a corrupt cluster ("0x00 at pos 6335541 invalid as first byte of an EBML number"); the demuxer resyncs past it and the cue keyframe at 19.645 s is never delivered. Now a segment whose closing keyframe is missing runs on to the next true boundary and the declared segments in between carry its bytes; a run that starts on such a segment starts one earlier. Bounded (10 segments a stretch, 5 stretches a rendition; past that the file is declined as before). The real file: master — seg 1 504, every later segment 409, the playlist 404; branch — segments 0–8 all 200 (stretches at 19.6 s and 48.9 s bridged), the playlist 200.

### 11. Hardware encoding (`d5a23cc`)

Probed at boot, never required; `hwEncode` "auto" (default) uses a family whose own ladder command passed AND whose picture was measured at least as good as x264's (NVENC, all rungs), while one of its sessions is free; "on" uses any probed family; "off" never. HDR stays on the CPU. Silent per-job fallback; the admin page says which encoder each running encode uses and why.

Quality and cost (x264 superfast crf 18 / NVENC p4 cq 19, lanczos; four real films; each rung's ceiling):

| Rung | VMAF x264 → NVENC | PSNR | SSIM | CPU-s per film-s |
| --- | --- | --- | --- | --- |
| 1080p | 93.7→95.0 · 99.6→99.8 · 96.2→96.7 · 95.5→96.7 | 46.5→46.4 · 50.2→51.3 · 51.8→52.4 · 52.7→55.2 | within 0.0005 | 1.0–2.8 → 0.03–0.06 |
| 720p | 87.8→91.0 · 93.1→94.9 · 94.2→95.0 · 93.1→93.8 | 43.7→43.6 · 45.4→45.3 · 48.9→48.1 · 49.9→48.6 | within 0.0005 | 0.6–2.4 → 0.03–0.06 |
| 480p | 89.6→92.3 · 90.1→92.9 · 93.8→94.7 · 92.8→93.6 | 43.2→43.3 · 43.1→43.7 · 47.9→46.9 · 48.2→47.9 | within 0.0005 | 0.5–2.2 → 0.02–0.06 |

VMAF higher in 12 of 12; PSNR up to 1.3 dB lower on 4 of the 8 ceiling-bound pairs (slower NVENC settings did not change that). scale_cuda's default bilinear cost 1–3 VMAF points; lanczos is used. Sessions: 10 at once all opened (slowest 4K→1080p 2.2× real time).

Under load (the H.264 rung of HEVC films, 90 s, PC at ~100 % CPU):

| Viewers | CPU (hwEncode off) | Graphics card (auto) |
| --- | --- | --- |
| 3 | TTFS 8.5 s, 3 stalled | 2.2 s, 0 stalled |
| 6 | 14.1 s, 6 stalled | 3.7 s, 0 stalled |
| 9 | 7 admitted, 74 × 503, 33 s | 9 admitted, 0 × 503, 3.8 s (6 on the card, 3 on the CPU) |

Fallback, measured: `hwEncodeSessions: 2`, 4 viewers → 2 "NVIDIA NVENC — decoded and encoded on the card", 2 "x264 on the CPU — all 2 of the graphics card's sessions are in use", all admitted, none stalled.

## Profiles

Same branch, the private instance and the rig started under an affinity mask (`start /affinity`), so the server, its ffmpeg children **and the simulated viewers** share those cores — on a PC already at ~100 % from other work. Read the encode rows as "what the server decides", not as speed.

| Profile | Direct play, 12 Mbit/s, HDD | Encodes (720p rung of 1080p films, software) | Notes |
| --- | --- | --- | --- |
| 16 threads, HDD (the house server) | 40 viewers 0 stalls; 50: 2 short stalls | limit 5–6 (measured speed 0.67×) | §1, §11 |
| 16 threads, NVMe | 80 viewers 0 stalls, startup p50 0.8–1.5 s (before: 1.0–2.3 s) | — | §1 |
| **4 threads** | 10 viewers 0 stalls (p50 0.76 s); 20: 2 stalled, 8.7 s in all | limit **1**: the first viewer admitted, the others told 503 at once (28–58 × 503 in 60 s); TTFS 10–32 s on the starved cores | before this round the same box was sized as 16 threads: limit 5, 8 x264 threads each |
| **2 threads** | 10 viewers 0 stalls (p50 0.49 s); 20: 4 stalled, 40 s in all, loop max 975 ms | limit **1**: one admitted, the rest 503; TTFS 20–56 s | the graphics-card probe was starved here and said "none" — since then it runs below normal (not idle) priority and asks again after 10 min |
| Low memory (`--max-old-space-size=96`) | 30 viewers 0 stalls, RSS 139 MB | — | 1 MB reads did not need a bigger heap |
| No GPU / `hwEncode: "off"` | — | everything on the CPU, as before (§11 "CPU" column) | a machine whose probe fails says "none available" on the admin page |
| Linux (WSL Ubuntu, Node 22.13 and 20.18) | unit tests only (no ffmpeg in that box) | — | `npm test`: 1,607 pass, 6 fail, 57 skipped on both — the 6 are the copy's own limits (no `tv-native/`, no `.git` in it; base 4862136 fails the same 6 there); disk detection: ext4 on Hyper-V's virtual disk → "unknown" (middle pattern), `/mnt/c` → "9p share" |

## Raw results and how to run them again

`docs/qa/server-round/results/*.json` — one file per run, named as below. The tools take `--trees name=<dir>[,name=<dir>]` (a copy of the code to run: the base commit unpacked with `git archive`, and the branch) and `--movies <folder of films>`:

| File | Tool |
| --- | --- |
| `direct-*.json` | `tools/streamload/direct.js --viewers 10,20,30 --mbit 12 --secs 40 --slow 2 [--rounds 2] [--cold 0]` |
| `hls-*.json` | `tools/streamload/hls.js --viewers 3,6,9 --v h264 --codec hevc --hw auto\|off [--config '{"hwEncodeSessions":2}']` |
| `hwbench-*.json` | `tools/streamload/hwbench.js --clips <dir> --rungs h264,h264-720,h264-480 --cq 19 [--sessions 1,3,5,6,8,10]` (`-q`: the first run, bilinear scaling, cq 21/24, with x264; `-lanczos`, `-cq`: the final settings; `-hq`: slower NVENC settings, no better) |
| `rewatch-keep.json` | `tools/streamload/rewatch.js --pause 200` |
| `ahead-copy.json` | `tools/streamload/ahead.js --mins 5` |
| (console) | `tools/streamload/diskread.js --n 12 --hwm 1048576 --limit 2`, `tools/streamload/torrentmem.js --mb 1200 --slots 20 --rate 30 [--nudge]` |

## The reverse proxy

`docs/operations.md`, "Behind a reverse proxy": Caddy and nginx configuration text (no buffering for `/stream/`, `/air/`, `/offline/file/`; 120 s upstream reads; upstream keep-alive under Aurora's 75 s; HTTP/2 to clients; no shared cache of signed-in content; compression of text only). Nothing was applied.

## What was not done, and why

- **VA-API and Quick Sync** are designed and probed (the probe runs the exact command a viewer would get) but never ran on real hardware here: this PC's Intel graphics is off and it has no Linux GPU. In "auto" they are not used (no quality measurement); "on" uses them.
- **The older routes** (`remux.js` single-rendition encodes — the TV's offsets — and torrent transcodes) still encode on the CPU; the jit ladder is where the card is used. The torrent jit route stays software too.
- **Torrent upload cap**: reasoned, not measured (no real swarm allowed). Torrent offset transcodes (`torrent-transcode.js`) have no ahead-of-reader pause yet.
- **Linux end to end**: unit tests ran on WSL Ubuntu with Node 20 and 22; the streaming rigs need ffmpeg, which the WSL box lacks, so the e2e numbers are Windows only. Disk detection was checked on WSL (ext4 on a Hyper-V virtual disk → "unknown"; `/mnt/c` → "9p share").
- **Real players**: the viewers are simulations of hls.js and `<video>`; nothing here ran on the Mi TV or an iPhone.

## Tests

- Root `npm test` (Windows, Node 22): **1,670 tests, 1,654 pass, 0 fail, 16 skipped — twice in a row** at the end. Earlier full runs sometimes failed two real-ffmpeg tests at their clean-up (`jit-budget-warm` "budget fixed at 2…", `jit-warm` "normal priority…": a killed ffmpeg still holding the test film on a loaded PC); the base commit fails the same two the same way (1 run of 4 here), and both pass alone (3 of 3).
- WSL Ubuntu, Node 22.13 and 20.18: see Profiles.
- `npm run test:ui`, whole, twice: 269 tests; run 1 264 pass / 4 fail (live, settings, subresync ×2), run 2 267 pass / 1 fail (admin, a 15 s wait) — every failing file passes alone (admin 30/30, live 6/6, settings 9/9, subresync 5/5). New or touched UI files three times alone or more: `admin.test.js` 3 × 30/30 (+1), `jit-withdrawn.test.js` 6 × 1/1.
- New unit/route tests: `directplay` (11), `disktype` (5), `rmqueue` (2), `jit-keep` (6), `jit-load` (6), `jit-cache-headers` (1), `hwenc` (10), `memnudge` (1), `cpucount` (6), additions to `encbudget` and `jit-exact`.
- Real browser (Chrome, private instance): the admin Encoding card at 1366×900 and 390×844 — the graphics-card sentence and switch, the processor's name (it showed "[object Object]" before), no horizontal overflow.
