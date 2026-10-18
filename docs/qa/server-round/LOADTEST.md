# Server round 2026-10-18: load and soak (srv-loadtest)

What this is: a reusable harness (`tools/loadtest/`, README there has every command) that starts a PRIVATE Aurora from any git ref or worktree, fills it with synthetic households (each one a browser plus a TV), and drives them as the real clients do. It is the yardstick for the other four agents of this round. This file holds the master 1.7.1 baseline (`4862136`), per machine profile, a 2-hour soak, and an A/B of each `srv-*` branch against master.

Every number here was measured on the development PC: an i7-10700K (8 cores / 16 threads), 32 GB, NVMe system disk (C:, which holds data/), library on a 1 TB 7,200 rpm HDD (E:), Windows 11, Node 22.13.1. Linux is WSL2 Ubuntu with Node 22.13.1 and 20.18.1.

**The PC was shared the whole time.** Other agents ran test suites, encodes and instances on it. Whole-PC CPU sat at 65–100 % in almost every window (column "PC CPU %", `*` = over 85 % or under 1 GB free RAM). Free RAM dipped to 52–113 MB more than once. So:

- Wall-clock latencies are pessimistic, and they swing run to run.
- CPU seconds, bytes written, fs-call counts, handles and memory are the robust numbers.
- A/B runs were interleaved (A B B A A B) so that both sides met the same noise.

Result files: `docs/qa/server-round/loadtest-results/*.json` (everything) and `*.md` (tables).

---

## 0. The answer

**Master 1.7.1 is not CPU-bound and does not leak. What makes it degrade is the event loop WAITING on synchronous disk work.**

Server CPU, not counting ffmpeg, at the largest size tried:

| Load | Server CPU | ELU |
| --- | --- | --- |
| 48 households (96 devices, 24 streams, 4 of them encodes) | 0.33–0.47 of a core | 0.29–0.49 |
| 60 mostly idle households (120 devices) | 0.09 core | 0.06 |

The process stays at 150–250 MB RSS. Over two hours of evening load its memory, handles and threads stayed flat.

What freezes everybody is time the loop spends *blocked without using the CPU*. The probe catches it in the act:

- **JSON-store saves.** `fsyncSync` is 100–900 ms each on a busy disk, `renameSync` / `openSync` of the `.tmp` up to 7 s, `writeSync` up to 10 s. These are `profiles.json` and `watch-sessions.json` every ~2.5 s with viewers, plus `sessions`, `healer` and `tel-timings`.
- **The stream caches.** The TV offset job (`remux.js`) and jit copy write the film into `data/cache/hls` and `data/cache/jit` far ahead of the viewer: about 140 MB/min per copy-stream, 2.8–4.1 GB per 4-minute window at n=16. They are then deleted with a synchronous `fs.rmSync` on the loop: one removal took 12.8 s, and a soak window with a 1.4 GB sweep had 610 stalls over 100 ms.
- **`readdirSync` of `cache/img-variants`**: 1.3 s.

Most of the loop-stall time, 75–95 % in most windows, is "waiting": the process used under half the CPU during the stall. That holds on Windows and Linux alike. Without the stream caches (direct play only), the same 48 households run with API p99 around 100–200 ms on both OSes.

**Capacity of master 1.7.1 on this PC (i7-10700K, measured while other agents kept it at 70–100 % CPU)**, "holds" meaning API p99 ≤ 1 s and no viewer stall:

| Profile | Holds up to | First sign of trouble |
| --- | --- | --- |
| Evening mix (browsing + n/2 streams, 1 in 6 encoded), real library, full PC | **32 households** (64 devices, 16 streams): API p99 0.1–0.6 s, 0 stalls | n=48: browse p99 2.4 s, loop stalled 16 s/min, 1 viewer stall. Loop stalls > 1 s appear at every size whenever the data disk is busy |
| Evening, direct play only (no stream caches), SSD media, Windows | 48+ households: browse p99 ≤ 152 ms, 0 stalls | not reached |
| Same, Linux (WSL, Node 22 / Node 20) | 48+: browse p99 48–267 ms, 0 stalls | not reached; `fsyncSync` still 1–10 s per 2 min |
| Streams-heavy, generated media on SSD (10 % encoded) | 32 streams: 0 stalls, server 0.33 core | viewer stalls at 8 and 24 coincide with multi-second loop waits |
| Direct play from the household HDD (2–6 Mbit films) | 12 streams: 0 stalls, TTFF ~105 ms, disk 5–30 % busy | not reached (stopped at 12 to spare the household's disk) |
| Many households (mostly idle, 2 streams) | 60 households / 120 devices: browse p99 0.3–0.6 s, ELU ≤ 0.08 | not reached |
| 4 CPUs (affinity, on CPUs shared with the busy PC) | nothing within 1 s: browse p99 19–47 s from n=4 (pictures warmed), viewer stalls from n=8 | ELU 0.31 → 0.77 while the server used 0.05–0.17 core: on 4 busy CPUs the loop waits far longer |
| 2 CPUs (affinity, shared) | nothing within 1 s: API p99 0.8–10 s, browse p99 9–60 s from n=4 (two runs) | ELU 0.3 → 1.0 at n=32 with 0.1 core of CPU; 4–15 viewer stalls at n=16–32; 20–24 encodes refused at n ≥ 24 |
| Low memory (256 MB heap, 320 MB working-set cap) | 8 (API p99 ≤ 0.36 s); 16 with one viewer stall | n=32: API p99 3.3 s, 21 refused. The cap was never reached (RSS ≤ 209 MB) |
| Starved (140 MB working set: it pages) | 16 (API p99 0.3 s, no viewer stalls) | no worse than full. Windows trims to the standby list, which costs little; a machine-wide shortage could not be produced without hurting the other agents |

**Extrapolated to an i5-10400 / 16 GB box** (method of `docs/qa/capacity/REPORT.md` §2: Node's single thread is 1.19× slower there; encoders get 10.3 thread-seconds per second):

- **CPU and event loop:** about 65–90 households of the evening mix (130–180 devices, 30–45 streams) before the loop's own CPU reaches 0.7–0.8 of a core. On a 2–4 core laptop or mini-PC (single thread 1.45× slower, 5.2 thread-s/s) about 40–60.
- **Encoders:** about 6 at once (encbudget sizes them from the CPU), so about 36 streams of the 1-in-6-encoded mix.
- **RAM:** not a limit at 16 GB: 0.25 GB for the server plus 0.3–1 GB per encode.
- **Disk:** 2–6 Mbit direct play from one HDD: 12 measured fine, 20–30 estimated.
- **But today the practical ceiling is lower and depends on the disk, not the CPU.** On a box whose system disk is busy (another program writing, the server's own stream caches, Windows Defender scanning new files), master shows multi-second freezes at **any** size, from 4 households up. That is what the four other branches attack, and the A/B shows it.

**A/B of the four branches against master** (evening n=16, 6 runs interleaved; "no overlap" = every B run beat every A run):

| Branch (commit) | Clear wins (no overlap) | Everything else |
| --- | --- | --- |
| srv-storage (`cd867e8` → `9b69e2b`, moved mid-run) | data/ writes 5,260 → 11 KB/min (−99.8 %); sync fs time 2.95 → 1.10 s/min | loop stall time −44 %, longest stall 2.98 → 0.32 s (medians, overlap: one B run hit a saturated PC) |
| srv-eventloop (`cf404a3`) | loop stall time 4.3 → 1.8 s/min; stalls > 100 ms 43 → 24; healthz p99 300 → 75 ms; ELU 0.21 → 0.17; Home p99 669 → 92 ms; sync fs time −43 % | browse p95/p99 −23..28 % (overlap) |
| srv-streaming (`d5a23cc`) | data/ growth 3.5 GB → 0.17 GB per window (−95 %); ffmpeg 2.22 → 0.73 cores; server CPU 12.6 → 8.7 s/min; fs calls/s 98 → 61; sync fs −49 % | latencies a little better, overlapping; 0 viewer stalls both sides |
| srv-resilience (`0e21d1c` → `5ac0ea2`) | ffmpeg cores −39 % | browse p95 965 → 4,569 ms (**worse**, no overlap), all of it pictures (/img p95 2–8 s → 7.5–20.5 s) |
| srv-resilience, picture fix (`e6a8021`) | API p99 436 → 171 ms (−61 %) | pictures p95 3.8 → 2.0 s, browse p99 4.3 → 3.0 s, loop stall time 2.9 → 1.45 s/min, healthz p99 137 → 74 ms (overlap). The regression is gone |
| srv-storage on the "small" profile (2 CPUs, 256 MB heap; `35f9788`, n=8) | store writes 2,500 → 6 KB/min; sync fs time 2.46 → 1.15 s/min | everything else overlaps on 2 shared CPUs; TTFF p50 2.3 s → 0.13 s |

Zero 429s anywhere: every simulated device has its own signed-in session.

---

## 1. Method

**Instance.** `instance.js` extracts the ref with `git archive` into `%TEMP%/aurora-agents/srv-loadtest/src-<sha>`. A directory works too, uncommitted work included. Dependencies are installed with `npm ci` once per package-lock into `deps-<lock>/`. Each instance is a copy of the code under that folder, so Node finds `node_modules` by walking up. There is **no junction or symlink anywhere**.

Each instance gets its own port, data folder and TEMP. It also gets the UI tests' network fence (every outbound connection refused, and it dies with its parent).

- Profiles and sessions are synthetic.
- The live data folder is read once a day. Only the caches of public catalogue facts and of what the server learnt about the files (probes, intros, subtitle languages, pictures) are copied. Never profiles, sessions, history, usage, downloads or logs.
- The library is the live config's `libraries`, read in-process and read only. Downloads, OCR, play-ready copies, backups, healer repairs, My List downloads and the daily round are switched off, because each of them can write into the library folders (README "Safety"). A probe listing of writes outside `data/` stayed empty in every run.
- `--media gen` instead uses a generated library on the SSD: 10-minute 1080p files at 6/8/25 Mbit, one of them AC-3 MKV, plus 300 small films.

**Before a window:**
1. Wait until the boot's background work is done (ELU under 3 % twice in a row).
2. Warm the pictures a settled server already has (library covers and backdrops, Home cards, at the devices' widths). Runs started before 12:25 did not have this step.
3. Let every device arrive, then warm 30–60 s.

**Devices** (README "What a device does", with source lines):
- Website and TV boots, Home (TV `slim=1` with ETag), grids, title pages, search typed key by key with the clients' debounce and abort, person sheet, My List.
- Pictures fetched once per device.
- Usage batches, netprobe every 5 min, TV version and tuning polls.
- A WebSocket per device that says `hello` and reports `activity` every 5 s while playing.
- Progress saved every 5 s.

**Viewers.**
- Web direct: one open Range request, reading paused above 120 s buffered and resumed under 60 s.
- TV direct: ExoPlayer's 50/120 s.
- Web jit: master playlist, the copy rendition (or the 720p encode), segments while under 45 s buffered.
- TV offset: the claim, then the growing playlist, buffered to 120 s.
- Seeks: about every 12 min, half the time.
- A simulated player buffer gives time to first frame, stalls (the playhead reaching the end of what has arrived) and seek times.

**Server side** (`probe.js`, preloaded):
- **Loop stalls.** A 20 ms timer counts gaps over 50/100/250/1000 ms and their total. Each stall is split into *busy* (the process used the CPU during it) and *waiting* (it did not: a synchronous disk call, or a thread nobody scheduled). On Windows every timer is rounded to 15.6 ms, so the delay histogram's median reads about 14 ms on an idle server. The stall counts and ELU are what compare across machines.
- Event-loop utilisation (ELU).
- CPU of the server and of every ffmpeg it started.
- RSS, heap, handles.
- Every `fs.*` call counted, and every synchronous one timed. The slowest are listed with their path.
- Bytes written per `data/` file.
- Server-side time per route group.
- The data folder's size per window.

**Degraded** means one of:
- browse p99 > 1 s;
- browse errors > 0.5 %;
- any 429;
- any viewer stall;
- a viewer that never started;
- a refused stream;
- a loop stall > 1 s;
- the loop stalled for more than 2 % of the window.

---

## 2. Capacity tables, master 1.7.1, per machine profile

Columns:
- **hh**: households (each one a browser and a TV).
- **browse**: every request a person waits for, pictures included. API alone is in the `.md` result files.
- **healthz p99**: the event loop as anyone would meet it.
- **loop stall ms/min**: time the loop was held more than 50 ms, per minute, split as (waiting/busy).
- **server cores**: the Node process. **ffmpeg cores**: its children.
- **writes KB/min**: what the server itself wrote into `data/`, not counting ffmpeg's segments.
- **TTFF**: time to first frame of the window's viewers.
- **refused**: streams refused.
- **PC CPU %**: the whole machine, including other agents. `*` = over 85 % or under 1 GB free.

Windows instances are pinned with CPU affinity on the server and, inherited, every ffmpeg it starts. "lowmem" / "starved" set a V8 heap cap plus a hard working-set cap (`SetProcessWorkingSetSizeEx`).

**Which runs did not warm pictures first** (started before 12:08 UTC): `baseline-ramp-evening-2`, `-2core`, `-4core`, `-gen-direct-win`, both WSL runs, `streams-gen-1`. Their browse tail includes first-visit picture variants. `baseline-ramp-evening-3`, `-4core-b`, `-2core-b` and everything later did warm them.

#### baseline-ramp-evening-3 — master@4862136f evening machine=full media=real node=v22.13.1 win32
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 4 | 3 | 0.4 | 57.5/631.5/1274.1 | 177.5 | 4083 (3841/242) | 2416 | 0.11 | 0.117 | 0.714 | 176 | 1510.3 | 0 | 128 | 0 | 93.5* |
| 8 | 8 | 4 | 2.2 | 19.1/280.4/688 | 14.9 | 286 (57/229) | 94 | 0.08 | 0.134 | 1.391 | 177 | 2899.3 | 0 | 128 | 0 | 70.9 |
| 16 | 16 | 8 | 3.2 | 17.1/848.6/1530.1 | 338.1 | 4907 (4611/296) | 1272 | 0.17 | 0.128 | 1.405 | 195 | 6601.1 | 0 | 747 | 0 | 71.5 |
| 24 | 24 | 12 | 5.5 | 15.8/306.6/532.8 | 69.3 | 1426 (335/1091) | 513 | 0.19 | 0.283 | 2.019 | 213 | 9823.3 | 0 | 791 | 0 | 92.2* |
| 32 | 32 | 16 | 7.5 | 17.6/371.5/745.3 | 285 | 4392 (3689/703) | 1058 | 0.27 | 0.362 | 3.156 | 223 | 6913.8 | 0 | 815 | 0 | 99.2* |
| 48 | 48 | 24 | 9.8 | 30.5/871.5/2449.5 | 765.7 | 16121 (13857/2265) | 1671 | 0.49 | 0.403 | 4.194 | 247 | 22398.3 | 1 | 815 | 0 | 97.5* |

#### baseline-ramp-evening-2 — master@4862136f evening machine=full media=real node=v22.13.1 win32
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 4 | 3 | 0.4 | 77.5/590.7/1091.1 | 526.5 | 6285 (0/0) | 3151 | 0.15 | 0.089 | 0.433 | 183 | 1712 | 0 | 1164 | 0 | 64.2 |
| 8 | 8 | 4 | 2.1 | 37.5/2259.8/8352.6 | 1005.5 | 14282 (0/0) | 10128 | 0.32 | 0.134 | 0.644 | 178 | 2026.6 | 1 | 1164 | 0 | 65.6* |
| 16 | 16 | 8 | 2.8 | 63.2/4001.2/21043.9 | 381.3 | 17159 (0/0) | 26719 | 0.37 | 0.116 | 0.165 | 192 | 3242.9 | 3 | 1089 | 0 | 74.2 |
| 24 | 24 | 12 | 4 | 158.4/12602.6/35580.8 | 4744.9 | 34650 (0/0) | 12809 | 0.74 | 0.21 | 80.766 | 211 | 6175.1 | 6 | 1164 | 0 | 86.3* |
| 32 | 32 | 16 | 6.9 | 29.8/6570.1/26573.3 | 444.5 | 12056 (0/0) | 1692 | 0.37 | 0.262 | 2.411 | 185 | 10384.3 | 4 | 1497 | 0 | 99.9* |
| 48 | 48 | 24 | 10.2 | 18.1/1698.3/7884.5 | 1065.9 | 15191 (0/0) | 10703 | 0.44 | 0.328 | 4.966 | 202 | 18070.8 | 1 | 1497 | 14 | 88.5* |

#### baseline-ramp-evening-gen-direct-win — master@4862136f evening machine=full media=gen node=v22.13.1 win32
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 4 | 3 | 0.2 | 11.5/31.5/81.8 | 89.1 | 1779 (1706/73) | 1967 | 0.11 | 0.061 | 0.042 | 119 | 419.4 | 0 | 311 | 0 | 100* |
| 8 | 8 | 4 | 1.3 | 7.5/482.9/1392.6 | 1029.2 | 15869 (15447/423) | 4736 | 0.26 | 0.064 | 0.007 | 119 | 514.9 | 0 | 309 | 0 | 99.9* |
| 16 | 16 | 8 | 2 | 10.3/57.4/140.4 | 68.1 | 1935 (1583/352) | 1094 | 0.25 | 0.163 | 0.015 | 135 | 554.8 | 0 | 114 | 0 | 100* |
| 32 | 32 | 16 | 7.1 | 10.2/67.8/152.1 | 164.1 | 2903 (2652/251) | 674 | 0.38 | 0.297 | 0.015 | 172 | 1141 | 0 | 202 | 0 | 100* |
| 48 | 48 | 24 | 10.2 | 5.8/31.4/101.6 | 49.6 | 795 (330/465) | 210 | 0.29 | 0.35 | 0.013 | 182 | 1491.1 | 0 | 202 | 0 | 97.8* |

#### wsl-node22-ramp-evening — master@4862136f evening machine=full media=/home/elia/aurora-lt/media node=v22.13.1 linux
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 4 | 3 | 0.3 | 5.1/46.9/47.8 | 15.5 | 292 (251/41) | 175 | 0.08 | 0.162 | 0 | 156 | 216.2 | 0 | 111 | 0 | 1.1 |
| 8 | 8 | 4 | 1 | 3.1/58.4/108.9 | 122 | 2755 (2542/213) | 1335 | 0.13 | 0.164 | 0 | 177 | 506.7 | 0 | 111 | 0 | 1.2 |
| 16 | 16 | 8 | 2.5 | 5.7/56.8/103.2 | 105 | 2945 (2189/757) | 469 | 0.21 | 0.364 | 0 | 192 | 524.4 | 0 | 143 | 0 | 2.2 |
| 32 | 32 | 16 | 5.1 | 5.6/55.1/129.1 | 131.2 | 4798 (3500/1298) | 2081 | 0.33 | 0.563 | 0 | 225 | 1147.9 | 0 | 205 | 0 | 3.5 |
| 48 | 48 | 24 | 7.6 | 4.1/38.3/206.1 | 184.6 | 2622 (2438/185) | 604 | 0.33 | 0.472 | 0 | 236 | 1372.8 | 0 | 205 | 0 | 3.8 |

#### wsl-node20-ramp-evening — master@4862136f evening machine=full media=/home/elia/aurora-lt/media node=v20.18.1 linux
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 4 | 3 | 0.1 | 42.6/223.5/223.5 | 1779.2 | 26842 (23722/3121) | 4121 | 0.53 | 0.375 | 0 | 125 | 337.5 | 0 | 3687 | 0 | 1.1 |
| 8 | 8 | 4 | 1.3 | 9.8/234.5/1222.5 | 711.8 | 12381 (12128/253) | 2353 | 0.28 | 0.285 | 0 | 142 | 522.6 | 0 | 2692 | 0 | 1.3 |
| 16 | 16 | 8 | 2.9 | 6.3/61.6/228.2 | 224.3 | 4401 (3815/586) | 545 | 0.2 | 0.414 | 0 | 179 | 543.4 | 0 | 205 | 0 | 2.2 |
| 32 | 32 | 16 | 5.7 | 5.4/145.3/267.3 | 325.6 | 8841 (7994/847) | 1517 | 0.34 | 0.644 | 0 | 212 | 1114.9 | 0 | 206 | 0 | 3.7 |
| 48 | 48 | 24 | 8.3 | 4/38.6/146.9 | 122.6 | 2272 (1829/443) | 1167 | 0.25 | 0.393 | 0 | 218 | 1362.5 | 0 | 209 | 0 | 3.3 |

#### baseline-ramp-evening-4core-b — master@4862136f evening machine=4core media=real node=v22.13.1 win32
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 4 | 3 | 1 | 9.7/17995.9/19333.2 | 560 | 15578 (15257/321) | 3634 | 0.31 | 0.049 | 0.138 | 148 | 1895.4 | 0 | 7876 | 0 | 99.1* |
| 8 | 8 | 4 | 1.3 | 262.2/25016.7/29437 | 937.1 | 18808 (18427/381) | 4388 | 0.42 | 0.111 | 0.291 | 204 | 1987.5 | 1 | 7876 | 1 | 98.6* |
| 16 | 16 | 8 | 1.5 | 3510.6/43057.4/46502.7 | 4371.8 | 39821 (39491/330) | 4726 | 0.77 | 0.099 | 0.178 | 201 | 2790.9 | 1 | 6540 | 0 | 99.2* |
| 32 | 32 | 16 | 4.9 | 36.1/5068.6/17533.7 | 4009.8 | 22356 (21572/784) | 8864 | 0.54 | 0.166 | 1.087 | 253 | 9438.6 | 8 | 1695 | 5 | 93.5* |

#### baseline-ramp-evening-4core — master@4862136f evening machine=4core media=real node=v22.13.1 win32
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 4 | 3 | 0.1 | 43.3/656.6/656.6 | 268.3 | 6021 (5767/254) | 892 | 0.13 | 0.044 | 0.179 | 152 | 842.4 | 0 | 2161 | 0 | 98.2* |
| 8 | 8 | 4 | 1.2 | 169/6070.9/27847.3 | 1392.6 | 25068 (24609/459) | 2620 | 0.48 | 0.093 | 0.2 | 220 | 2466.5 | 0 | 2161 | 0 | 98.9* |
| 16 | 16 | 8 | 4.1 | 25.7/16270.8/35639 | 928.4 | 20474 (19478/996) | 2882 | 0.54 | 0.193 | 0.465 | 230 | 3905 | 4 | 1354 | 0 | 97.7* |
| 32 | 32 | 16 | 3.5 | 627.9/60011.1/60018.4 | 2614.1 | 50502 (48665/1837) | 3671 | 0.99 | 0.147 | 0.154 | 239 | 6039.6 | 4 | 1693 | 23 | 100* |

#### baseline-ramp-evening-2core-b — master@4862136f evening machine=2core media=real node=v22.13.1 win32
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 4 | 3 | 0.2 | 2713.1/21023.7/21023.7 | 936.3 | 18376 (18071/305) | 5269 | 0.34 | 0.062 | 0.126 | 142 | 1156.3 | 0 | 222 | 0 | 92.7* |
| 8 | 8 | 4 | 2.7 | 26.7/12252.1/22931.5 | 511.2 | 10582 (9781/801) | 972 | 0.32 | 0.149 | 0.812 | 189 | 3029.6 | 1 | 222 | 0 | 79.8 |
| 16 | 16 | 8 | 3.6 | 118.3/41605.8/50583.2 | 900.4 | 26725 (25593/1132) | 1916 | 0.63 | 0.106 | 0.188 | 216 | 2254.8 | 4 | 31765 | 0 | 99.9* |
| 32 | 32 | 16 | 5.7 | 948.8/51968.8/60022.4 | 3841.6 | 55359 (54174/1185) | 5633 | 1 | 0.103 | 0.112 | 226 | 3600.6 | 15 | 31765 | 20 | 99.8* |

#### baseline-ramp-evening-2core — master@4862136f evening machine=2core media=real node=v22.13.1 win32
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 4 | 3 | 1.5 | 319.5/16245.6/24879.6 | 599.4 | 9554 (8854/699) | 2920 | 0.28 | 0.08 | 0.21 | 171 | 1246.8 | 0 | 2400 | 0 | 99.6* |
| 8 | 8 | 4 | 1.6 | 84.9/4817.3/8823.8 | 907.5 | 15494 (13948/1546) | 1560 | 0.45 | 0.142 | 0.22 | 176 | 2165.7 | 1 | 2400 | 0 | 99.8* |
| 16 | 16 | 8 | 3.9 | 119.4/35468.5/40279.3 | 838.7 | 22555 (20667/1889) | 1678 | 0.59 | 0.158 | 0.191 | 211 | 3950.5 | 1 | 1904 | 0 | 99.9* |
| 24 | 24 | 12 | 3.7 | 491.6/45532.4/50857.4 | 2302.8 | 47051 (45463/1588) | 7148 | 0.87 | 0.14 | 0.135 | 187 | 4108.9 | 2 | 2400 | 22 | 98.9* |
| 32 | 32 | 16 | 5.1 | 550.3/26805.7/40204.3 | 1596.9 | 46563 (44340/2223) | 2975 | 0.98 | 0.165 | 0.186 | 222 | 5997.5 | 1 | 2400 | 24 | 99* |

#### baseline-ramp-evening-lowmem — master@4862136f evening machine=lowmem media=real node=v22.13.1 win32
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 4 | 3 | 0.3 | 24.3/2378/3092.6 | 36.9 | 719 (532/187) | 238 | 0.06 | 0.09 | 0.742 | 166 | 1605.8 | 0 | 119 | 0 | 100* |
| 8 | 8 | 4 | 1.7 | 41.8/3929/5506 | 411.9 | 5325 (4638/687) | 1255 | 0.22 | 0.207 | 0.906 | 187 | 3075.4 | 0 | 119 | 0 | 99.8* |
| 16 | 16 | 8 | 3.4 | 24.6/947.8/1488.3 | 79.5 | 1145 (514/630) | 371 | 0.16 | 0.17 | 1.582 | 203 | 7575.3 | 1 | 316 | 0 | 99.9* |
| 32 | 32 | 16 | 7.1 | 23.2/1447.3/10285.4 | 1841.9 | 18860 (16679/2182) | 6762 | 0.47 | 0.26 | 2.159 | 209 | 8394.8 | 0 | 490 | 21 | 97.4* |

#### baseline-ramp-evening-starved — master@4862136f evening machine=starved media=real node=v22.13.1 win32
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 4 | 3 | 0.6 | 67.9/981.8/2618.6 | 109.8 | 1306 (957/349) | 312 | 0.09 | 0.12 | 0.672 | 114 | 1470.3 | 0 | 172 | 0 | 100* |
| 8 | 8 | 4 | 1.2 | 30.4/2421.9/7012 | 194.9 | 2121 (1171/950) | 829 | 0.14 | 0.199 | 1.049 | 129 | 2641.5 | 0 | 172 | 0 | 99.9* |
| 16 | 16 | 8 | 2.4 | 22.9/818.5/3616.9 | 162.4 | 2811 (2139/673) | 719 | 0.15 | 0.139 | 2.533 | 130 | 5811.2 | 0 | 172 | 0 | 97.4* |

#### baseline-ramp-streams-gen-1 — master@4862136f streams machine=full media=gen node=v22.13.1 win32
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 3 | 4 | 0 | null/null/null | 247.5 | 4279 (4241/38) | 3615 | 0.09 | 0.048 | 0.028 | 102 | 93.6 | 0 | 110 | 0 | 88.7* |
| 8 | 3 | 8 | 0 | 12.2/14.2/14.2 | 2259 | 16170 (16046/124) | 6433 | 0.38 | 0.082 | 0.173 | 107 | 99.4 | 2 | 114 | 0 | 84.7 |
| 12 | 4 | 12 | 0 | null/null/null | 23.3 | 757 (757/0) | 534 | 0.11 | 0.126 | 0.576 | 121 | 164.4 | 0 | 114 | 0 | 88.5* |
| 16 | 6 | 16 | 0 | 7.1/8.2/8.2 | 207.7 | 3387 (3085/302) | 1149 | 0.27 | 0.203 | 0.33 | 115 | 287.7 | 0 | 109 | 0 | 97.7* |
| 24 | 6 | 24 | 0 | 16.1/26.8/26.8 | 206.2 | 12876 (12149/726) | 1511 | 0.59 | 0.269 | 0.082 | 140 | 245.5 | 3 | 500 | 0 | 100* |
| 32 | 6 | 32 | 0 | 8.1/9.9/9.9 | 175.9 | 2058 (2028/30) | 778 | 0.29 | 0.326 | 0.047 | 146 | 343.9 | 0 | 302 | 0 | 100* |

#### baseline-ramp-streams-direct-hdd — master@4862136f streams machine=full media=real node=v22.13.1 win32
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 4 | 2 | 1.3 | 32.9/1182.9/1918.3 | 79 | 969 (628/341) | 311 | 0.08 | 0.077 | 0.011 | 177 | 2621.5 | 0 | 102 | 0 | 98.3* |
| 4 | 4 | 4 | 0.7 | 26.5/885.8/1450.7 | 19.8 | 332 (199/133) | 104 | 0.05 | 0.057 | 0.001 | 156 | 1208.4 | 0 | 105 | 0 | 91.8* |
| 8 | 4 | 8 | 1.1 | 22.6/374.9/627.9 | 38.2 | 902 (712/191) | 790 | 0.1 | 0.1 | 0.004 | 169 | 2161.2 | 0 | 106 | 0 | 99.7* |
| 12 | 4 | 12 | 0.8 | 14.9/278.6/747.8 | 27 | 383 (33/350) | 236 | 0.07 | 0.087 | 0.002 | 186 | 1158.8 | 0 | 106 | 0 | 89* |

#### baseline-ramp-streams-direct-ssd — master@4862136f streams machine=full media=gen node=v22.13.1 win32
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 4 | 2 | 0.7 | 3.6/16.4/25.1 | 7.4 | 0 (0/0) | 39 | 0.03 | 0.039 | 0 | 96 | 39.5 | 0 | 102 | 0 | 63.5 |
| 4 | 4 | 4 | 1.2 | 8.3/20.4/26.9 | 11.3 | 0 (0/0) | 50 | 0.05 | 0.065 | 0.009 | 125 | 58.1 | 0 | 106 | 0 | 75.5 |
| 8 | 4 | 8 | 0.5 | 7.3/25.7/27.2 | 29.7 | 134 (108/26) | 62 | 0.11 | 0.105 | 0 | 132 | 131 | 0 | 108 | 0 | 78.5 |
| 12 | 4 | 12 | 1 | 5.2/18.8/63.6 | 14.5 | 108 (0/108) | 116 | 0.15 | 0.186 | 0 | 145 | 287.2 | 0 | 103 | 0 | 74.9 |
| 24 | 4 | 24 | 0.6 | 3/271.5/332.2 | 385.1 | 3482 (3482/0) | 1166 | 0.15 | 0.189 | 0 | 153 | 444.8 | 0 | 111 | 0 | 49.6 |

#### baseline-ramp-households — master@4862136f households machine=full media=real node=v22.13.1 win32
| n | hh | streams | browse req/s | browse p50/p95/p99 ms | healthz p99 | loop stall ms/min (wait/busy) | longest stall | ELU | server cores | ffmpeg cores | RSS MB | writes KB/min | viewer stalls | TTFF p50 | refused | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 15 | 15 | 2 | 0.9 | 18.7/319.3/457 | 11.5 | 62 (0/62) | 63 | 0.03 | 0.05 | 0.002 | 154 | 2792.3 | 0 | 100 | 0 | 57.4 |
| 30 | 30 | 2 | 1.6 | 14.4/348.2/530.2 | 16.2 | 292 (55/237) | 102 | 0.05 | 0.079 | 0.002 | 192 | 2913.6 | 0 | 100 | 0 | 67.1 |
| 45 | 45 | 2 | 2.6 | 16.1/269.2/644.6 | 32.5 | 732 (222/511) | 205 | 0.08 | 0.091 | 0.006 | 207 | 6038.2 | 0 | 100 | 0 | 86.7* |
| 60 | 60 | 2 | 3.3 | 11.4/193.9/318.5 | 15.2 | 395 (26/369) | 283 | 0.06 | 0.085 | 0 | 189 | 5274.1 | 0 | 100 | 0 | 66.3 |

Notes:
- **Real-library evening runs vs the generated direct-only runs.** The real-library runs include jit copy, TV offset copy and one encode in six. Those streams write their caches into `data/` (0.8–2.1 GB per 2-minute window here, about 140 MB/min per copy-stream). That is the difference between a browse p99 of seconds and one of ~100 ms.
- **WSL "PC CPU %"** is the Linux VM's own view, not the PC's. Its "server cores" come from `/proc` and count every thread of the process.
- **HDD direct play.** 12 streams of the household's 2–6 Mbit films: no stall, TTFF about 105 ms, E: 5–30 % busy (other readers included). The ramp stopped at 12 to spare the household's disk. The capacity report's estimate for one 7,200 rpm disk is 15–20 × 8 Mbit.

## 3. i5-10400 / 16 GB, and smaller boxes

The method of `docs/qa/capacity/REPORT.md` §2:
- The 10400 is the 10700K's core with six of them at a lower clock. Node's single thread takes 1.19× as long. Encoders get 12 × 0.86 = 10.3 thread-seconds per second.
- A 4-core laptop (i5-10210U class): 1.45× as long, 5.2 thread-s/s.

| | This PC (measured) | i5-10400 (scaled) | 4-core laptop / mini-PC (scaled) | 2-core box (estimated) |
| --- | --- | --- | --- | --- |
| Server CPU per household, evening mix | 0.007–0.012 core (0.33–0.47 at 48) | 0.008–0.014 | 0.010–0.017 | as the laptop, but it competes with ffmpeg for 2 CPUs |
| Households before the loop's own CPU reaches 0.7 core | ~70–100 | **~65–90** (130–180 devices, 30–45 streams) | ~40–60 | ~20–30 |
| Encodes at once (encbudget, from the CPU) | 9 (16 threads) | ~6 → ~36 streams of the 1-in-6 mix | ~3 → ~18 streams | 1–2 |
| RAM | 0.15–0.25 GB server + 0.3–1 GB per encode | fine at 16 GB | fine at 8 GB | 4 GB: about 2 encodes |
| What actually limits master today | loop **waiting** on sync disk I/O: freezes of 1–27 s at any size when the data disk is busy | the same: a property of the disk and of the code, not of the CPU | the same, worse on an HDD system disk | the same; on 2 CPUs ELU reached 0.98 at 32 households with 0.17 core of CPU |

The two pinned-CPU profiles show what a small box adds: the waits get much longer. At n=32 on 4 CPUs the loop's ELU was 0.99 and the API answered in up to 60 s, with 23 encodes refused, while the server used 0.15 core. Pinned CPUs here were shared with other agents' work, so this is a pessimistic floor, but its shape is the point: on a small box the same synchronous disk calls hold the loop longer.

## 4. Soak: 2 hours of evening load (master, n=8: 8 households, 4 streams, real library)

`soak-evening-n8-master.json`, one 10-minute window after another. Viewers start a new title every 30 min.

| | first window | last window | over the 2 h |
| --- | --- | --- | --- |
| RSS | 157 MB | 172 MB | 140–198, no trend |
| heap used | 78 MB | 76 MB | 71–79, flat |
| handles | 369 | 365 | 345–386, flat |
| threads | 15 | 13 | 13–15 |
| server CPU | 6.1 s/min | 3.8 s/min | 3.8–6.1 (the first window includes arrivals) |
| ELU | 0.41 | 0.06 | 0.06–0.11, except the windows with a cache sweep (0.38) |
| data/ size | 4.4 GB | 3.6 GB | 3.2–6.7 GB: cache/hls + cache/jit fill and are swept; the stores stay a few hundred KB |
| store writes | 4.2 MB/min | 1.6 MB/min | 1.3–4.2 MB/min |
| browse p99 | 10.8 s | 1.1 s | 0.26–10.8 s; the 10 s windows are the ones in which ~1.4 GB of segments were deleted with `rmSync` on the loop (610 stalls > 100 ms in that window) |
| viewer stalls | 0 | 1 | 0–5 per window, 10 in 2 h, all in windows with loop waits |

**No leak, no fd growth, no latency drift.** Latency follows the cache sweeps, not time.

## 5. A/B of each branch against master (pinned commits, interleaved A B B A A B, evening n=16, real library)

Full tables: `loadtest-results/ab-evening16-<branch>.md` (every metric, every run). The calls: "no overlap" = every B run beat (or lost to) every A run, the only call this noisy PC supports.

**srv-storage (cd867e8→9b69e2b) vs master (4862136)** — evening n=16; PC CPU during the runs 100/100/100/99/99/100 %

| metric | master (median) | branch (median) | change | call |
| --- | --- | --- | --- | --- |
| browse p99 ms | 17163.1 | 36513.3 | +113 % | overlap |
| pictures p95 ms | 14045.8 | 35415.1 | +152 % | overlap |
| loop stall ms/min | 5088 | 2848 | -44 % | overlap |
| longest stall ms | 2983.67 | 317.75 | -89 % | overlap |
| healthz p99 ms | 236.5 | 144.3 | -39 % | overlap |
| ELU | 0.23 | 0.2 | -13 % | overlap |
| server CPU s/min | 12.46 | 13.94 | +12 % | overlap |
| ffmpeg cores | 1.62 | 1.36 | -16 % | overlap |
| store writes KB/min | 5260.5 | 10.6 | -100 % | **better** (no overlap) |
| data/ grew MB | 1792.2 | 1632.8 | -9 % | overlap |
| sync fs ms/min | 2952 | 1095 | -63 % | **better** (no overlap) |
| viewer stalls | 6 | 7 | +17 % | overlap |
| TTFF p50 ms | 416 | 212 | -49 % | overlap |
| 429s | 0 | 0 |  | overlap |

**srv-eventloop (cf404a3) vs master (4862136)** — evening n=16; PC CPU during the runs 100/99/100/100/98/99 %

| metric | master (median) | branch (median) | change | call |
| --- | --- | --- | --- | --- |
| browse p99 ms | 4942.4 | 3820.7 | -23 % | overlap |
| pictures p95 ms | 4428.4 | 2572 | -42 % | overlap |
| loop stall ms/min | 4295 | 1765 | -59 % | **better** (no overlap) |
| longest stall ms | 1417.12 | 893.08 | -37 % | overlap |
| healthz p99 ms | 299.6 | 74.8 | -75 % | **better** (no overlap) |
| ELU | 0.21 | 0.17 | -16 % | **better** (no overlap) |
| server CPU s/min | 14.28 | 14.4 | +1 % | overlap |
| ffmpeg cores | 1.96 | 2.48 | +26 % | overlap |
| store writes KB/min | 6389.3 | 6825.4 | +7 % | overlap |
| data/ grew MB | 2186.8 | 2498.2 | +14 % | overlap |
| sync fs ms/min | 2707 | 1537 | -43 % | **better** (no overlap) |
| viewer stalls | 0 | 0 |  | overlap |
| TTFF p50 ms | 536 | 589 | +10 % | overlap |
| 429s | 0 | 0 |  | overlap |

**srv-streaming (d5a23cc) vs master (4862136)** — evening n=16; PC CPU during the runs 99/97/69/86/54/75 %

| metric | master (median) | branch (median) | change | call |
| --- | --- | --- | --- | --- |
| browse p99 ms | 680.3 | 595.1 | -13 % | overlap |
| API p99 ms | 115.1 | 197.6 | +72 % | overlap |
| pictures p95 ms | 619.6 | 560 | -10 % | overlap |
| loop stall ms/min | 1363 | 965 | -29 % | overlap |
| longest stall ms | 345.75 | 437.27 | +26 % | overlap |
| healthz p99 ms | 63.6 | 57.5 | -10 % | overlap |
| ELU | 0.12 | 0.11 | -8 % | overlap |
| server CPU s/min | 12.64 | 8.66 | -31 % | **better** (no overlap) |
| ffmpeg cores | 2.22 | 0.73 | -67 % | **better** (no overlap) |
| store writes KB/min | 5536.9 | 6278.8 | +13 % | overlap |
| data/ grew MB | 3498.5 | 171.2 | -95 % | **better** (no overlap) |
| sync fs ms/min | 967 | 489 | -49 % | **better** (no overlap) |
| viewer stalls | 0 | 0 |  | overlap |
| TTFF p50 ms | 266 | 185 | -30 % | overlap |
| 429s | 0 | 0 |  | overlap |

**srv-resilience (0e21d1c→5ac0ea2) vs master (4862136)** — evening n=16; PC CPU during the runs 100/100/100/100/100/100 %

| metric | master (median) | branch (median) | change | call |
| --- | --- | --- | --- | --- |
| browse p99 ms | 10524.8 | 15205.6 | +44 % | overlap |
| pictures p95 ms | 7345.2 | 14287.5 | +95 % | overlap |
| loop stall ms/min | 4262 | 3803 | -11 % | overlap |
| longest stall ms | 1064.52 | 904.6 | -15 % | overlap |
| healthz p99 ms | 196.2 | 176.2 | -10 % | overlap |
| ELU | 0.2 | 0.21 | +3 % | overlap |
| server CPU s/min | 13.34 | 11.97 | -10 % | overlap |
| ffmpeg cores | 1.46 | 0.89 | -39 % | **better** (no overlap) |
| store writes KB/min | 5388.1 | 5320.7 | -1 % | overlap |
| data/ grew MB | 1726.8 | 1113.9 | -35 % | overlap |
| sync fs ms/min | 2147 | 1437 | -33 % | overlap |
| viewer stalls | 2 | 7 | +250 % | overlap |
| TTFF p50 ms | 320 | 603 | +88 % | overlap |
| 429s | 0 | 0 |  | overlap |

**e6a8021 (e6a8021) vs master (4862136)** — evening n=16; PC CPU during the runs 100/97/98/100/100/100 %

| metric | master (median) | branch (median) | change | call |
| --- | --- | --- | --- | --- |
| browse p99 ms | 4284.1 | 2956.4 | -31 % | overlap |
| API p99 ms | 435.9 | 170.5 | -61 % | **better** (no overlap) |
| pictures p95 ms | 3780 | 2001.1 | -47 % | overlap |
| loop stall ms/min | 2901 | 1450 | -50 % | overlap |
| longest stall ms | 854.48 | 739 | -14 % | overlap |
| healthz p99 ms | 136.8 | 74.3 | -46 % | overlap |
| ELU | 0.2 | 0.17 | -16 % | overlap |
| server CPU s/min | 13.67 | 13.57 | -1 % | overlap |
| ffmpeg cores | 2.27 | 2.36 | +4 % | overlap |
| store writes KB/min | 7007.1 | 6576.7 | -6 % | overlap |
| data/ grew MB | 2168.3 | 2267.1 | +5 % | overlap |
| sync fs ms/min | 829 | 759 | -8 % | overlap |
| viewer stalls | 0 | 0 |  | overlap |
| TTFF p50 ms | 300 | 209 | -30 % | overlap |
| 429s | 0 | 0 |  | overlap |

**srv-storage (35f9788) vs master (4862136)** — evening n=8, machine small; PC CPU during the runs 77/74/98/98/95/92 %

| metric | master (median) | branch (median) | change | call |
| --- | --- | --- | --- | --- |
| browse p99 ms | 36183.9 | 23101.8 | -36 % | overlap |
| API p99 ms | 4995.5 | 3451.9 | -31 % | overlap |
| pictures p95 ms | 34194.7 | 19248.7 | -44 % | overlap |
| loop stall ms/min | 14919 | 19340 | +30 % | overlap |
| longest stall ms | 6016.03 | 3761.06 | -37 % | overlap |
| healthz p99 ms | 1097.5 | 1207.6 | +10 % | overlap |
| ELU | 0.33 | 0.45 | +36 % | overlap |
| server CPU s/min | 5.35 | 6.61 | +24 % | overlap |
| ffmpeg cores | 0.16 | 0.23 | +41 % | overlap |
| store writes KB/min | 2499.8 | 6 | -100 % | **better** (no overlap) |
| data/ grew MB | 281.4 | 520.6 | +85 % | overlap |
| sync fs ms/min | 2462 | 1151 | -53 % | **better** (no overlap) |
| viewer stalls | 1 | 0 | -100 % | overlap |
| TTFF p50 ms | 2273 | 126 | -94 % | overlap |
| 429s | 0 | 0 |  | overlap |

## 6. Findings for the other workstreams (master 1.7.1)

1. **Synchronous fs on the event loop is the first ungraceful limit** (srv-storage, srv-eventloop).
   - `jsonstore` saves call `fsyncSync`, `openSync`, `writeSync` and `renameSync` on the loop. They cost 100 ms to 10 s each whenever the disk is busy: other programs, the server's own segment writing, possibly Windows Defender scanning each new `.tmp`.
   - With viewers, `profiles.json` and `watch-sessions.json` are each saved about every 2.5 s.
   - On Linux too, `fsyncSync` was the largest synchronous cost (1–10 s per 2 minutes).
   - srv-storage removes 99.8 % of these bytes.
2. **Stream caches are written far ahead of the viewer and deleted synchronously** (srv-streaming).
   - The TV offset job (`remux.js`, `v=copy`) has no "ahead of the reader" limit and copies the whole film into `cache/hls` at about 20× real time.
   - jit copy filled `cache/jit` at a similar rate.
   - Together that is 2.8–4.1 GB per 4 minutes at n=16.
   - The clean-up runs `fs.rmSync(dir, {recursive: true})` on the loop (`remux.js:61`): 12.8 s once, 610 stalls in one soak window.
   - srv-streaming cuts the growth by 95 %.
3. **jit declines a real file mid-play** (srv-streaming).
   - Log line: `[jit] e0e114cb5d37: segment 2: next keyframe at 30.072s, playlist says 19.645s — declining this file`. The file is Inception (2010).mkv, HEVC 10-bit.
   - After that, `tableFor` returns null and every viewer's segment requests get **409 "Playlist first"**: 103 of them at n=48. A browser player treats that as fatal.
4. **Picture variants are the browse tail on a server seeing pictures for the first time.**
   - Variants are made by ffmpeg two at a time, with no queue bound.
   - Picture p95 was 2–20 s in the early (unwarmed) runs, against an API p95 of 50–500 ms.
   - With pictures warmed, picture p95 drops to 0.3–1.7 s.
5. **The encoder gate looks at the whole machine's CPU** (encbudget).
   - Log line: "falling behind real time … CPUs 87 % busy — no new encodes for 30 s".
   - On a box that also runs other things, viewers are refused because of other programs' load: 14–24 refusals at n=24–48 on this busy PC.
6. **Affinity is not detected.** A server pinned to 2 CPUs still printed "Automatic: 9 now, because 16 CPU threads × …". On Windows `os.cpus()` ignores the process's affinity, so encbudget sizes itself for the whole machine. A container or VM with a CPU quota is the Linux equivalent. Ties in with the owner's "detect, don't assume".
7. **Person sheet: 40 per minute per address** (`api.js:418-428`), with `req.ip` and no trust proxy. Behind nufurora.com's reverse proxy every remote user shares one bucket. The rig never reached it (0 × 429), but 40 households opening cast pages would.
8. **The rig has no internet.** Catalogue pictures the live server never fetched, people, X-Ray and discover pages for uncached titles fail fast. The harness counts these in groups of their own (`*-offline`), not as errors. `similar.json` (640 KB) is rewritten on every such failure (failures are cached too). It is real behaviour, but the rig sees more of it than a server with the internet.

## 7. Re-running it (for the orchestrator)

```
# the integrated tree against master, evening and streams, the full PC and a small box
node tools/loadtest/run.js ab --a master --b <integrated branch or C:\elia\aurora-int> --scenario evening --n 16 --minutes 4 --rounds 3
node tools/loadtest/run.js ab --a master --b <integrated> --scenario evening --n 8  --minutes 4 --rounds 3 --machine small
node tools/loadtest/run.js ab --a master --b <integrated> --scenario streams --n 12 --minutes 4 --rounds 3 --media gen
# capacity after the merge
node tools/loadtest/run.js ramp --ref <integrated> --scenario evening --steps 4,8,16,24,32,48 --step-min 2 --stop-after 99
# leaks
node tools/loadtest/run.js soak --ref <integrated> --scenario evening --n 8 --minutes 120
# Linux, Node 22 and 20 (README "Linux (WSL)")
```

Each A/B takes about 40 minutes (6 × boot, settle, warm, 4-minute window). Results land in `docs/qa/server-round/loadtest-results/` as `.json` + `.md`.

## 8. What this could not measure, and why

- **A quiet machine.** Other agents kept the PC at 65–100 % CPU, with free RAM dipping to 52 MB, so wall-clock latencies are pessimistic. CPU seconds, bytes, fs calls, memory and handles are not affected; the A/B calls rest on "no overlap" across interleaved runs.
- **True RAM starvation.** A working-set cap makes Windows trim the process to the standby list, which costs little. A machine-wide shortage would have hurt the other agents. On Linux a cgroup (`systemd-run --scope -p MemoryMax=`) would do it; WSL's systemd user session failed to start here.
- **Clock speed.** Not emulated, only CPU count. Smaller boxes are scaled by PassMark ratios (§3).
- **Streams beyond 12 on the household's HDD.** Spared on purpose. 24–32 streams were run on generated media on the SSD.
- **Linux with ffmpeg.** Ubuntu here has none, and installing packages was out of scope. Linux runs are direct play only, and their library is known from probes carried over from Windows.
- **Torrent viewers.** Built (`--torrent`, `--mix web-torrent`), not run: they need the internet and a real swarm.
- **GPU.** None is used by master; `--machine nogpu` sets the environment a detection switch would read (`AURORA_HWACCEL=off`, `AURORA_GPU=off`). Check the names against what srv-streaming/srv-eventloop adopt.
- **A run killed by another agent's clean-up at ~13:02 UTC.** None of mine ended early: each result's `exited` is null and no "THE SERVER EXITED" line was logged.
