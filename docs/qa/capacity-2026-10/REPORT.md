# Capacity: how many people can one Aurora server carry (2026-10-26/27)

elia: "I want you simulating and coming with a number of how many users we can support."

## The answer

**This PC, Aurora 1.10.0, the house's own mix: about 25 people watching at once (20 to be safe), plus about 12 browsing and 12 devices open on Home.** With the three fixes on this branch: **about 35.**

- Test: everyone presses Play in the same 10 seconds ("9 pm"), private 1.10.0 instance, viewers stepped up, 4-minute windows, at least two rounds per mix. :4000 and nufurora.com were never contacted.
- Once everyone is watching, the server is nearly idle (30 viewers: 0.13 core + 0.3 core of ffmpeg). **The start of the evening breaks, not the evening.**
- **Upload is the real cap below about 85 Mbit/s** (25 viewers × 2.7 Mbit/s ≈ 68 Mbit/s).
- The PC: i7-10700K (8 cores / 16 threads), 32 GB, RTX 3090 (6 NVENC sessions); C: is an Intel 660p QLC NVMe, 92 % full, and holds `data/`.

**"Supported" means every one of:** 95 % of starts show a picture within 4 s (in the burst and later); under 1 % of segments slower than real time; viewers stalled under 0.5 % of watch time; API p99 under 300 ms; nothing refused (no turned-away stream, no 503, no 429).

**How sure:** fairly sure of the shape, less of the exact number — the typical knee moved between 20 and 30 across five runs of the same code, because C: stalls by itself and other programs used 15–25 % of the CPU before every run. Direct play is certain: 200 viewers, nothing broke.

## 1. What the house actually does (read-only from data/)

- Peak here: 1 watching, 5 devices connected; starts peak 19:00–23:00 (the household mostly uses nufurora.com, so these are shares).
- Play starts outside QA (39): TV offset copy 18, TV direct 9, TV jit 2, phone/tablet jit copy 8, desktop direct 2 → about 28 % direct, 72 % repackaged. Encodes ~2 %; ~20 quality changes to 720p/480p in ~120 plays; a few torrent starts on the TV.
- Devices: TV 82 %, phone 10 %, tablet 8 %.
- Library (61 files): median 2.5 Mbit/s, mean 2.7, p90 4.2, max 6.4; half HEVC (mostly 10-bit MKV), half H.264 MP4; AAC 31, E-AC-3 15, AC-3 15. No 4K/HDR.
- Busiest download hour: 16 GB (~36 Mbit/s).

| Mix | What it is |
|---|---|
| typical | 30 % direct, 55 % repackaged, 10 % encoded (720p desktop / 480p phone), 5 % torrent; TVs 55 %, phones 25 %, desktops 20 % |
| direct | 100 % the file as it is |
| worst | 40 % encoded, 30 % torrent, 30 % repackaged |

Beside every step: n/2 browsing, n/2 idle on Home, two background downloads at 4 MB/s each, 60 % load a subtitle, half resume mid-film; device links TV 80, phone 50, desktop 200 Mbit/s.

## 2. Method
Private loopback-only instance, synthetic profiles, keeper's libuv pool of 6. Library: five 30-minute 1080p masters shaped like the house's (2.1–7.0 Mbit/s), each hard-linked under 8 names with two subtitles. Torrents: local tracker + seeder capped at 10 MB/s. Each step: previous viewers leave; n start within 10 s (boot, Home, title, subtitle, Play); burst measured until all have a first frame or 90 s; 40 s pause; 4-minute window. Measured TTFF, every segment (late / starved), stalls, API latency per route, event-loop lag (/healthz 5×/s) and which sync file call caused each stall, CPU (server, ffmpeg, PC), GPU (nvidia-smi + server encoder count), disk busy/read/write/queue, RAM, refusals. Raw JSON in `results/`; tables: `node tools/loadtest/capacity-report.js docs/qa/capacity-2026-10/results/*.json` (→ `results/TABLES.md`).

## 3. Results per mix (knee = largest supported step, one earlier miss allowed)

| Mix | Code | Knees (runs) | What failed first |
|---|---|---|---|
| direct | 1.10.0 | 200, 200 (not reached) | nothing; at 200: 505 Mbit/s out, server 0.48 core, burst TTFF p95 0.36 s, API p99 14 ms |
| typical | 1.10.0 | 20 (pool 4), 30, 25, 25 (60 s spread), 25 (seek-heavy) | at 25–40 the event loop blocked 3–22 s on sync file calls while C: was 88–98 % busy; burst TTFF p95 5–21 s |
| typical | 1.10.0 + 3 fixes | 40, 30 | at 40–60: remaining sync existsSync/statSync (0.5–0.8 s each), PC CPU 100 % at moments, 1–6 % late segments, API p99 0.9–1.6 s |
| worst | 1.10.0 + torrent pass | 10, 15, 10 | at 15–20: disk loop stalls; torrent starts 4–8 s |
| worst | 1.10.0 + 3 fixes | 30 | at 40: all 6 NVENC sessions busy, CPU 76 %, TV offset start 7.4 s |

| Typical | 5 viewers | 20–25 | 30 | 40 (with fixes) |
|---|---|---|---|---|
| Burst TTFF p50 / p95 | 0.6 / 1.5–2 s | 0.7 / 2.4 s, or 12–16 s in a disk stall | 0.8 / 2.4–4.6 s | 0.8 / 2.1 s |
| Server cores, burst / steady | 0.12 / 0.02 | 0.3–0.7 / 0.09–0.12 | 0.8 / 0.14 | 0.9 / 0.26 |
| ffmpeg cores, burst / steady | 0.3–0.9 / 0.1 | 2–5 / 0.2–0.3 | 2–5 / 0.3–0.4 | 4.9 / 1.3 |

Seeks p50 140–690 ms, p95 1.0–2.1 s. Subtitles p95 25–170 ms outside disk stalls. RAM never a limit (server ≤330 MB, ffmpeg ≤720 MB, 4–9 GB free). GPU ≤6 sessions, encoder ≤11 % average.

## 4. Bandwidth (streams at 80 % of the upload)

| Upload | House 2.7 Mbit/s | Test typical 3.5 | 4.2 | 8 | 25 |
|---|---|---|---|---|---|
| 20 Mbit/s | 5 | 4 | 3 | 2 | 0 |
| 50 Mbit/s | 14 | 11 | 9 | 5 | 1 |
| 100 Mbit/s | 29 | 22 | 19 | 10 | 3 |
| 500 Mbit/s | 148 | 113 | 95 | 50 | 16 |
| 1000 Mbit/s | 296 | 226 | 190 | 100 | 32 |

Below ~85 Mbit/s the line fills before the PC does; above it, the burst start is the limit. Home-LAN viewers don't use the upload. The 9 pm burst pulls ~300 Mbit/s for ~15 s at 20–25 viewers (470 at 40) while players fill buffers; on a thinner line starts are just slower (a first frame needs 2–2.5 s of buffer).

## 5. What breaks first
1. **The start of the evening → the system disk → the event loop.** Each repackaged/encoded start runs ffmpeg ~20× real time until 40–50 segments ahead; ~20 at once write 60–190 MB/s into `data/cache` on C: (QLC, 8 % free → ~30 MB/s at 98 % busy, queue 17). Every sync file call on the loop then waits, and every request with it: `fs.statfsSync` disk guard on every playlist 12–22 s; torrent bitfield save 6–13 s; `mkdirSync` of a job folder up to 10 s; `statSync`/`existsSync` of films and segments 0.2–1.3 s each. Not CPU (server 0.3 core; ~95 % of stall time waiting on disk).
2. **Then CPU during the burst:** 4–6 cores of ffmpeg for ~15 s.
3. **Then encodes (worst mix):** 6 NVENC sessions, then CPU (limit 5–8).
4. **Not limits:** RAM, the loop's own CPU (0.5 core at 200 viewers), direct play, browsing (API p95 6–12 ms in steady windows).

## 6. Three cheapest ways to raise the number
1. **Give `data/` a disk that isn't nearly full, or free 100+ GB on C:.** No code. A TLC NVMe or a second SSD for `data/` should remove most start failures. Excluding `data\cache` from Defender's real-time scan would also help (security setting — elia's call).
2. **Take the remaining sync file calls off the event loop** (small code): `existsSync`/`statSync` in `src/routes/stream.js` (~12 places), `mkdirSync` in `jit.js`/`remux.js`, `loadStartupBitfield` in `torrent.js`. These limit 60 viewers even with the fixes.
3. **Pace the run-ahead** (small code, own test round): a copy needs nothing like 20× once a minute ahead — ffmpeg `-readrate` above a lead, or park earlier than 40 segments.

## 7. Other machines (nufurora.com not contacted)
`/api/server-info` exposes no CPU details; the public RIPE record says netcup KVM virtual server in Germany (shared vCPUs, no GPU), size unknown.

| Cost (i7-10700K; one core ≈ 1.19× an i5-10400 core) | |
|---|---|
| direct viewer, steady | 0.0025 core |
| repackaged viewer, steady | ~0.004 core server + 0.01–0.02 core ffmpeg |
| encoded on CPU | 0.4–0.7 core while running ahead (0.82 CPU-s per 1080p second) |
| encoded on NVENC | ~0.02 core; 6 at once on this GeForce |
| one non-direct start | ~5 core-seconds of ffmpeg within 15 s + 80–100 MB written to data/cache |
| browsing | not a limit up to 100 people |

**Viewers ≈ the smallest of:** upload: 0.8 × upload ÷ 2.7 · burst CPU: (cores × 0.8 − other load) × 15 ÷ (5 × non-direct share; typical 0.7) · burst disk: write MB/s × 15 ÷ (90 × non-direct share) · encodes: (NVENC sessions + CPU encode limit from admin Encoding) ÷ encoded share.

| Machine (typical mix, estimates) | Burst CPU | Encodes | Disk |
|---|---|---|---|
| this PC | ~42 | ~120 | ~25 with C: at its worst, ~60 healthy |
| i5-10400, TLC NVMe, no GPU | ~35 | 5–6 at once → ~55 | — |
| 4-vCPU VPS, no GPU (nufurora-like) | **~10** | 1–2 at once → 10–20 | — |

On the VPS the burst CPU decides; starts spread over a minute raised the knee ~25 % here. The harness runs anywhere: `node tools/loadtest/capacity.js --mix typical`.

## 8. Code changes on this branch (separate commits)

| Commit | Change | Measured reason |
|---|---|---|
| 5dd310c | Torrents on a sign-in-required server: ffmpeg/ffprobe carry the internal pass when reading the server's own `/stream/torrent/…` (`internalpass.ffArgs` in streamprobe.js, tonemap.js, torrent-transcode.js, routes/torrent.js) | In `authMode: "closed"` (nufurora's) those reads got 401: `/api/torrents/probe` 504, no encoded rungs, repackaged torrent streams failed until the download finished. Test: test/internalpass.test.js |
| 8639619 | Lead priority (Windows): a producer 6+ segments ahead drops to lowest priority, back up under 3 (lib/leadprio.js) | Burst TTFF p95 at 20–30 viewers 7.2–18.0 s → 5.2–6.3 s. Test: test/leadprio.test.js |
| 8f86808 | Torrent bitfield save asynchronous (torrent.js) | Its statSync + writeFileSync waited 6–13 s. Test: test/torrent-metadata-cache.test.js |
| 81d142b | Disk-nearly-full guard reads cached free space, refreshed every 5 s (lib/disk.js freeBytesCached, 6 call sites) | One statfsSync per playlist waited 12–22 s. Test: test/disk-free-cached.test.js |

With all: typical 25 → ~35, worst 10–15 → 30. Root npm test twice: 1951 pass, 0 fail.

**Open findings, not changed:** one file the GPU decoder rejects turns hardware encoding off for everyone for 60 s (hwenc.js; decline per file instead); the first torrent after boot loads webtorrent on the loop (1.7 s, once); torrent first frames are mostly the swarm's (0.2–8 s here; TV reports 29 s p50 on real swarms).

## 9. Not done
No runs on an i5-10400 or nufurora's VPS (§7 scales from here); nothing streamed from the house HDD (server round measured ~45 direct viewers at 12 Mbit/s from it); real networks and the upload line not emulated; PC shared the whole time (each run records its load). Superseded runs in `results/superseded/`.

## 10. Files
`results/TABLES.md`; `results/*.json`, `*.md`; new `tools/loadtest/capacity.js`, `swarm.js`, `capacity-report.js`; extended `instance.js`, `devices.js`, `http.js`, `lib.js`, `run.js`, `README.md`.
