# Aurora: how many viewers and devices one i5 / 16 GB box carries, and what to harden

Research only. No product code was changed. Server 1.6.85 (`7b6877d`), measured 2026-10-10 on a private instance; scripts in `tools/capacity/`, raw numbers in `docs/qa/capacity/results/`.

Every figure is marked **measured** (on the development PC, by the scripts here), **scaled** (measured, then moved to the target CPU by the factors in §2) or **estimated** (from reading the code or from published figures, with the source).

---

## 0. The answer

Target: Intel Core i5-10400 (6 cores / 12 threads), 16 GB, library on an SSD, gigabit LAN, software encoding (the only kind the code has). The laptop-class i5-10210U is given beside it where it differs.

| What everyone is doing | Viewers at once, today's code | What stops it | What the CPU alone would carry | With Quick Sync (estimated, code does not have it) |
| --- | --- | --- | --- | --- |
| Direct play, 8 Mbit | about 100 on the LAN; remote = uplink ÷ 10 Mbit (20 Mbit up: 2, 100 Mbit up: 10) | Network. The server spends 0.5 core on 1.25 Gbit (measured) | same | same |
| Direct play, 25 Mbit (4K) | about 30 on the LAN; remote = uplink ÷ 31 Mbit | Network; on one hard disk about 6–8 (estimated) | same | same |
| Remux only (video copied, sound to AAC) | 30+ | Disk and network. One remux costs 0.05 of a thread (measured) and its segments are shared by everyone on that title | same | same |
| Household mix: 70 % direct, 20 % remux, 10 % transcode | **20** (14 direct, 4 remux, 2 transcodes) | **A hard-coded cap of 2 encoders** (`MAX_ENCODES` in `jit.js`, `remux.js`, `torrent-transcode.js`). The CPU is then about a quarter used | 50–60 (5–6 transcodes) | 80+ |
| Everyone transcoding 1080p HEVC → H.264 | **2** | The same cap | 5–6 with headroom, 8 at the edge (10210U: 2–3, 4 at the edge) | about 8 |
| Everyone transcoding 4K HEVC SDR → 1080p | **2** | The same cap | 3 (10210U: 1) | 3–4 |
| 4K HDR, tone-mapped to SDR | **1 at 720p, and only while nothing else encodes. At 1080p: 0** — the server's own speed gate predicts 1.24× real time, needs 1.5×, and sends the picture out without tone mapping (washed out) | CPU. One such encode eats 4.2 threads (measured) | 1 (10210U: none; not real time) | 2–3 |

**Signed-in devices.** An idle device is one WebSocket and one small probe every 5 minutes: 2,000 were held open in under 200 MB (measured). The ceiling is not memory. It is what happens when the library changes: every web client refetches Home at once, Home is the heaviest request the server has (20–50 ms of the one event-loop thread each, measured), and nothing else is answered meanwhile. Measured: 100 devices, a 4–8 s stall; 500 devices, refused connections and memory up to 1 GB. On the i5-10400 that puts the comfortable ceiling at **about 50 connected devices, 100–150 before a library change is a visible freeze**. A household of 20 sees a 1–2 s hiccup.

**What breaks first, and how.**

1. **The third different transcode is refused, at once and politely**: `503 Server is busy` in 4–90 ms (measured), so the player falls to another rendition or says so. This is graceful. Two flaws: the older single-rendition route answers `500` for the same thing, and a lower "slow line" rung may never take the last slot, so in practice one slow-line viewer gets one.
2. **The event loop is the first thing that fails badly.** Everything (API, segments, pictures, WebSocket) runs on one thread, and four things block it: Home (20–50 ms), a JSON store save (7 ms today, 64 ms at 3.6 MB, 440 ms at 18 MB; measured), a library probe (45–120 ms per new file; measured), and intro fingerprinting. When it is blocked every viewer waits, including the ones whose next segment is already on disk. Under pm2 a 6 s stall three checks running restarts the server, which drops everyone.
3. **Remote direct play runs out of uplink**, long before the box runs out of anything.

RAM is not a limit: the server process sat at 75–250 MB under every load here, an encoder takes 0.3–0.5 GB (1.1 GB from a 4K source), and two of them plus everything else stay under 4 GB.

**Top failure risks** (§5 has all of them)

- **No supervisor on the home PC.** It runs as bare `node server.js`; the watchdog there says "no pm2: log only". A crash or a hang lasts until somebody notices.
- **A damaged `profiles.json` boots as an empty house.** Measured: the server starts with the single default profile, sets the broken file aside, raises no alert in the first seconds and does not reach for last night's backup. Saves are not fsynced, so a power cut can produce exactly that file.
- **One request type can freeze everybody** (item 2 above), and nothing limits it: one signed-in device asking for Home on 64 connections made every other request wait 6.4 s (measured).
- **Background encodes outrank viewers.** The play-ready copy made after a download runs at normal priority on all threads and is not counted in the two slots; viewers' encoders run below normal. On a busy machine a viewer's 10-second segment took 85 s (measured, with other work at normal priority).
- **The admin password can be guessed at about 900 tries a second** with no slow-down or lock-out (measured), and a device that is not signed in can open 3,000 WebSockets and send a 32 MB message that stalls the loop for 160 ms (measured).

**The ten changes worth most** (§8 has every finding with files, risk and reference)

| # | Change | Gain | Effort |
| --- | --- | --- | --- |
| 1 | Run under a supervisor on both hosts (pm2 or systemd `Restart=on-failure`), with back-off | A crash or hang heals in seconds instead of when somebody notices | S |
| 2 | On a damaged store: restore that file from the newest verified backup (or refuse to start and alert); fsync before rename; default the backup folder to another disk | Removes "the house's profiles are gone" as an outcome; recovery point from 24 h to the last backup, automatically | S–M |
| 3 | Coalesce `library_updated`, add jitter to the clients' refetch and reconnect, and memoise Home per profile | The 4–8 s freeze at 100 devices becomes a few hundred ms; Home drops from 20–50 ms to under 1 ms on a repeat | M |
| 4 | Background encodes at below-normal priority, counted against the encode slots, paused while a viewer encodes | Viewers stop losing the CPU to a play-ready copy (1.4 threads' worth, measured) | S |
| 5 | Make the encoder cap a setting sized from the CPU (2 → 4 on an i5-10400) | Twice the transcoding viewers at measured cost; the box is a quarter used today | S |
| 6 | Limits on the open doors: WebSocket payload and per-address count, admin-password attempts, `trust proxy` done properly, a queue cap on picture variants | Closes the three measured abuse paths | S |
| 7 | Stop rewriting whole files every 1.5 s: save the hourly telemetry hourly, viewing sessions on start/stop, progress every 5–10 s; then move progress, sessions and history to SQLite (WAL) | Today about 120 MB/h of rewrites per viewer; at 3.6 MB of history 8 GB/h and 4 % of the event loop. SQLite makes a progress save a row | S, then L |
| 8 | A `/healthz` that knows the loop is healthy, and a `/metrics` page (request times per route, loop delay, encodes running/refused, save times) | "It is slow" becomes a number with a cause | S–M |
| 9 | Probe files without blocking (async ffprobe, 2–4 at a time) and stop replaying the usage log synchronously at boot | Cold start of 1,087 files: 142 s of 45–120 ms freezes → background; boot no longer stalls 2.7 s on a full usage log | S–M |
| 10 | Hardware transcoding (Quick Sync / VAAPI) behind a probe, software as the fallback | About 8 transcodes instead of 2–5, and 4K HDR tone mapping becomes possible at all (estimated) | L |

**Not measured, and why** (§9): Quick Sync (this PC's Intel graphics is switched off; ffmpeg reports `Error creating a MFX session`), a hard disk (the PC's library disk is NVMe and the test files sat in the page cache), real uplinks and the VPS, torrents and aria2 under load (the brief forbids real swarms), film content (synthetic test pictures), clean wall-clock speeds (the PC was 85–100 % busy with other work throughout, so capacity is derived from CPU seconds, which hold), and anything longer than a 35-minute soak.

---

## 1. Method and its limits

**The instance.** `tools/capacity/instance.js` starts this worktree's code as a private server through the UI tests' harness: a throwaway data folder, a free port, outbound network refused, the sign-in wall closed with a seeded session per profile. Its library is five generated files (H.264 1080p 8 Mbit as MKV with AC-3 5.1 and subtitles, the same as MP4, HEVC 10-bit 1080p, HEVC 10-bit 4K 25 Mbit, HEVC HDR10 4K 40 Mbit with DTS) plus 150 small films and 30 shows of 8 episodes, and a seeded catalogue of 198 films and 200 shows (the size of the live cache). The live server on port 4000 was never loaded: it received a handful of GETs to learn the size of its answers (`/api/home` 91–164 KB, 25–32 ms).

**ffmpeg.** `ffmpeg-bench.js` does not retype command lines. It asks the server's own modules for them (`jit._internals.producerArgs`, `ladder.encFor`, `remux._internals.videoArgsFor`, `tonemap`, `offline._internals.argsFor`, `imgvariant.filterFor`) and runs each with `-benchmark`, which prints the process's own CPU seconds and peak memory.

**The Node process.** `load.js` and `sim.js` drive simulated devices at the clients' real intervals (§3a) and read the server from outside: CPU seconds and memory of its pid, and the latency of `GET /healthz` asked five times a second on its own connection, which is the wait the event loop imposed on everyone.

**Limits to keep in mind.**

- **The PC was busy.** Other agents' builds, tests and encodes held 8–14 of its 16 threads the whole time. Wall-clock speeds here are what was left over; they are lower bounds. CPU seconds per second of film did not move with the load (1.21–1.31 across one to six simultaneous jobs), so capacity is computed from them.
- **CPU seconds were measured with Hyper-Threading siblings busy.** That is the right cost for the question "how many at once", where every thread is busy by definition. It overstates the cost of a single job on an idle box by perhaps 30 %.
- **The pictures are synthetic** (`testsrc2` with temporal noise, 24 fps). Grainy film costs about this; clean animation less; 60 fps content 2.5 times more.
- **The private instance cannot reach the internet**, so each Home request retried a few refused lookups, and intro detection was fingerprinting the test shows in the background during the endpoint runs. The CPU profile separates these: about 16–20 ms of a Home request is Home; the rest of the 42–54 ms observed is the rig.
- **Clock speed is not emulated**, only core count (§2).

---

## 2. This machine and the target

| | CPU | Cores / threads | PassMark CPU Mark | Single thread | RAM | Disk |
| --- | --- | --- | --- | --- | --- | --- |
| This PC (measured on) | i7-10700K | 8 / 16 | 18,485 | 3,034 | 32 GB DDR4-3200 | NVMe SSD (96 % full), 1 TB HDD |
| **Target, desktop (assumed)** | **i5-10400**, UHD 630 | 6 / 12 | 11,960 | 2,556 | 16 GB | — |
| Target, laptop | i5-10210U | 4 / 8 | 6,009 | 2,091 | 16 GB | — |
| Target, laptop (Ice Lake) | i5-1035G1 | 4 / 8 | 7,111 | 2,163 | 16 GB | — |

PassMark figures as published on cpubenchmark.net on 2026-10-10 ([10700K](https://www.cpubenchmark.net/cpu.php?cpu=Intel+Core+i7-10700K+%40+3.80GHz&id=3733), [10400](https://www.cpubenchmark.net/cpu.php?cpu=Intel+Core+i5-10400+%40+2.90GHz&id=3737), [10210U](https://www.cpubenchmark.net/cpu.php?cpu=Intel+Core+i5-10210U+%40+1.60GHz&id=3542), [1035G1](https://www.cpubenchmark.net/cpu.php?cpu=Intel+Core+i5-1035G1+%40+1.00GHz&id=3558)).

"i5 10th gen" is taken to mean the desktop i5-10400. The laptop parts are half of it for encoding, so both are given.

**How measurements are moved to the target.**

- The 10400 is the same core as this PC's 10700K, six of them instead of eight, at a lower clock. The bench was pinned to 12 logical CPUs (6 cores) with the thread counts the server would compute there (`ENC_THREADS` 6, legacy 10). What remains is clock: 11,960 ÷ 18,485 = 0.647 = 6/8 × **0.86**.
- The 10210U: pinned to 8 logical CPUs, threads 4 and 6; 6,009 ÷ 18,485 = 0.325 = 4/8 × **0.65** (a 15 W laptop does not hold its turbo).
- One unit of work is a **thread-second**: one logical CPU of this PC for one second, siblings busy. Budgets: i5-10400 = 12 × 0.86 = **10.3 per second**; i5-10210U = 8 × 0.65 = **5.2**; i5-1035G1 = 8 × 0.77 = 6.2.
- "With headroom" means 70 % of that budget: the server, downloads and the OS keep the rest and every encode stays above 1.2× real time.
- The Node process is one thread: its times are divided by the single-thread ratio, so 1.19× longer on the 10400 and 1.45× on the 10210U.

**Cross-check.** Plex's own rule is about 2,000 PassMark per 1080p software transcode, 12,000 for 4K SDR and 17,000 for 4K HDR ([Plex support, seen as a search summary; the page itself refused the fetch](https://support.plex.tv/articles/201774043-what-kind-of-cpu-do-i-need-for-my-server/)). For the i5-10400 that is 6 × 1080p. This report's measured figure is 5–6 with headroom. Aurora's 4K figure is better than Plex's (3 against 1) because it encodes with `superfast` and folds 4K to 1080p first.

---

## 3. What each kind of use costs

### a. A signed-in device doing nothing

What a client really sends, read from the code (web `public/js`, TV `tv-native/src`):

| | Web | TV |
| --- | --- | --- |
| WebSocket | one, `hello` on connect; **no ping in either direction** (`ws.js:90`, `realtime.js`) | same (`realtime.ts:61`) |
| Reconnect | 1 s doubling to 30 s, **no jitter** (`ws.js:98-103`) | same formula (`realtime.ts:86-88`) |
| Idle on Home | `/api/netprobe?kb=48` every 300 s while visible (`net.js:293`) | `/tv-version.json` every 30 min (`update.ts:32`) |
| Usage | a batch 20 s after the first event, or at 25 events (`usage.js:17`) | same, plus a `perf` event every 120 s |
| On `library_updated` | refetch `/api/library` + `/api/profiles/:id/state`, and Home if it is showing (`ws.js:35`, `home.js:587`) | forget its cache; refetch Home 2.5 s later if it is the live screen (`Home.tsx:210`) |
| Playing | progress POST every 5 s, WebSocket `activity` every 5 s (`player.js:5018`) | same (`Player.tsx:2098`) |

So an idle web device is 0.2 requests a minute and an idle TV 0.03. Measured:

| Idle WebSockets held | Server memory | Handles | Notes |
| --- | --- | --- | --- |
| 100 | 92–95 MB | 371 | |
| 500 | 139–165 MB | 1,092–1,372 | |
| 2,000 | under 200 MB once settled | 2,827 | 60–170 KB per socket across runs |
| 3,000 from one address, none signed in | 120 MB | 3,275 | all accepted: there is no per-address limit |

Memory and sockets are not the ceiling. The reaction to a broadcast is:

| One library change (`POST /api/admin/rescan`) reaching… | Requests it caused | Stall of the event loop | Outcome |
| --- | --- | --- | --- |
| 100 devices | 600 (each device refetches twice: the route and the scanner both broadcast) | 4.4–7.7 s | all answered `200`, Home p50 5.2–7.5 s |
| 500 devices | 2,232 attempted | 4.0 s | **2,168 refused at the socket**, 64 answered; memory 407 MB, and 978 MB a moment later |

(measured; the PC's other load makes the times pessimistic by perhaps 2×.) The refusals are the listen backlog (Node's default 511) overflowing when 3,000 connections arrive in one instant. The memory is thousands of compressed responses in flight; 978 MB is under the watchdog's 1,000 MB soft line by luck.

### b. Browsing

One request, alone, closed loop (measured on the private instance: 157 films, 30 shows, 398 catalogue titles; `load.js endpoints`):

| Request | Answer | CPU per request | Requests/s one process manages | p50 alone |
| --- | --- | --- | --- | --- |
| `GET /healthz` (no work: the floor) | 0 KB | 0.7–0.8 ms | 1,000–1,200 | 0.9 ms |
| `GET /api/item/:id` | 0.7 KB | 0.45 ms | 2,000–2,260 | 0.6 ms |
| `GET /api/profiles` | 0.2 KB | 0.6–0.9 ms | 700–1,590 | 0.6 ms |
| `POST /api/profiles/:id/progress` | — | 1.1 ms | 760 | 1.0 ms |
| `POST /api/usage` | — | 0.5–0.8 ms | 890–2,000 | 0.7 ms |
| `GET /img/:id?w=256`, variant already made | 4.5 KB | 1.5–2.3 ms | 280–680 | 2.8 ms |
| `GET /api/profiles/:id/state` | 0.6 KB | 2.7–3.1 ms | 170–450 | 3.7 ms |
| `GET /api/search/suggest` | 0.4 KB | 1.8–3.0 ms | 220–700 | 3.2 ms |
| `GET /` (app shell) | 3.6 KB | 3.2–4.3 ms | 70–345 | 11.9 ms |
| `GET /api/library?profile` | 7.5 KB compressed | 5.6–7.8 ms | 100–290 | 9.0 ms |
| `GET /api/search?q=` | 4.1 KB | 6.9–11.6 ms | 46–117 | 7.9 ms |
| `GET /css/aurora.css` (compressed again on every request) | 35 KB | 11.6–16.2 ms | 68–213 | 13.3 ms |
| **`GET /api/home?profile`** (web) | 129 KB raw, 8 KB compressed | **42–54 ms observed; 16–20 ms of it is Home itself** | **12–23** | 49 ms |
| `GET /api/home?…&slim=1` (TV) | 9.9 KB compressed | 48–66 ms observed | 14–18 | 64 ms |

Home is ten times heavier than anything else a device asks for. Where its time goes (V8 profile, `profile-endpoint.js`): `hero.js` 15 % (`recencyTerm` alone 10.7 %), `identity.js` 8.5 % (title normalising and library maps rebuilt per request), `imdb.js` 4.4 %, compression about 12 %, and the rest is the rig (§1). Nothing about a Home answer is kept between requests: the rows are recomposed, re-stringified, re-hashed for the ETag and recompressed each time, including when the client already has that exact answer.

At 20 Home requests arriving together the p50 was 2.7 s and the lag probe saw 2.9 s; at 100, 4.6 s.

**Pictures.** A variant that does not exist yet starts an ffmpeg: 0.05 CPU-seconds for a poster at 256 px, 0.2 for a 1280 px backdrop, 0.2–0.3 and 190–240 MB for a blurred one (measured). At most two run at once (`imgvariant.js MAX_CONCURRENT`), requests for the same variant share one job, and widths snap to a 12-step ladder: 60 arbitrary `?w=` values on one picture cost 0.34 CPU-seconds in all (measured). The queue behind those two has no length limit and no timeout: 40 blurred variants took 22.6 s to drain, each request holding its connection (measured). 12 widths × 9 blur levels × 2 formats per picture can be asked for.

**The household mix** (`load.js mix`; 50 % idle, 30 % browsing with a screen change every 20 s, 20 % playing of which 70 % direct, 20 % remux, 10 % an encoded rung; every device's page load is inside the window):

| Devices | Requests/s | API p50 | p95 | p99 | Loop lag p50 / p99 | Server CPU (cores) | Memory | Handles |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.4 | 25 ms | 689 | 689 | 1.4 / 41 ms | 0.21 | 107 MB | 268 |
| 5 | 1.6 | 22 ms | 197 | 199 | 1.4 / 19 ms | 0.04 | 111 MB | 293 |
| 20 | 5.8 | 160 ms | 1,808 | 2,049 | 1.5 / 248 ms | 0.13 | 116 MB | 383 |
| 50 | 14.0 | 132 ms | 893 | 1,592 | 2.1 / 267 ms | 0.20 | 133 MB | 567 |
| 100 | 28.4 | 270 ms | 2,804 | 3,329 | 1.8 / 665 ms | 0.28 | 186 MB | 874 |

No request failed at any level. The server used a quarter of one core at 100 devices: the average is nowhere near a limit. The tail is Home and the library list queuing behind each other (at 100 devices Home's own p50 was 1.3 s, because all 100 loaded their first page inside the same seconds), on a machine where the process was getting about half a core. On a quiet i5-10400 expect the p50 column to shrink and the p99 column to keep its shape: a burst of Home requests is a queue on any CPU.

### c. Direct play

`load.js direct` (loopback, so the network is not in the way; 4 libuv threads):

| Streams | Total | Server CPU (cores) | CPU per Mbit | Loop lag max |
| --- | --- | --- | --- | --- |
| 10 × 8 Mbit | 80 Mbit | 0.08 | 0.9 ms | 33 ms |
| 50 × 8 Mbit | 400 Mbit | 0.24 | 0.6 ms | 104 ms |
| 10 × 25 Mbit | 250 Mbit | 0.17 | 0.7 ms | 50 ms |
| 50 × 25 Mbit | 1,250 Mbit | 0.47 | 0.4 ms | 40 ms |
| flat out, 16 connections | 5,054 Mbit | 1.63 | 0.3 ms | 33 ms |

Twenty clients that asked for a 198 MB file and never read a byte moved server memory from 86 to 93 MB: backpressure works, nothing is buffered. The process is not the limit; these are:

| Ceiling | 8 Mbit streams | 25 Mbit streams | Basis |
| --- | --- | --- | --- |
| Gigabit LAN | about 100 | about 30 | 80 % of the link |
| Wi-Fi 5 access point, real throughput 200–400 Mbit | 25–50 | 8–15 | estimated |
| Home uplink 20 Mbit | 2 | 0 | uplink × 0.8 ÷ bitrate |
| Home uplink 50 Mbit | 5 | 1 | |
| Home uplink 100 Mbit | 10 | 3 | |
| Home uplink 500 Mbit | 50 | 16 | |
| VPS, 1 Gbit port | about 100 | about 30 | but check the monthly quota: one 8 Mbit stream is 3.6 GB an hour, and a torrent stream relayed through the VPS counts in and out |
| One 7,200 rpm hard disk | 15–20 | 6–8 | **estimated, not measured**: sequential reads are 150 MB/s, but N films read at once are N seeks per round |
| SSD | not a limit | not a limit | |

One thing to fix before a hard disk is trusted with many streams: `/stream/video` reads through `fs.createReadStream` with Node's default 64 KB chunks, and every read occupies one of libuv's 4 pool threads (6 under pm2, `ecosystem.config.js`). On a seeking disk at about 10 ms a read that is 4 × 64 KB ÷ 10 ms = 25 MB/s for the whole server, and every other file operation (segments, pictures, stats) waits in the same pool. Estimated from the code; larger chunks remove it (§8, N12).

### d. Remux (video copied, sound re-encoded)

| Job (jit producer) | Speed here | CPU per second of film | Memory |
| --- | --- | --- | --- |
| H.264 1080p 8 Mbit, AC-3 5.1 → AAC | 17–25× | 0.04 thread-s | 21 MB |
| HEVC 4K 25 Mbit, E-AC-3 → AAC | 16–21× | 0.05 thread-s | 19 MB |

A remux is one twentieth of a thread per viewer and it runs 20× faster than the film, so it finishes far ahead and stops. Copies are not counted against the encoder cap. Thirty viewers asking for the same segment that did not exist started one producer and were all answered in 0.9 s (measured). Second and third producers for viewers far apart in one film are capped at 4 across the server (`MAX_EXTRA_PRODUCERS`).

### e. Transcoding

Every encode is libx264 `superfast`, `crf 18`, High profile, under a bitrate ceiling (10 Mbit at 1080p, 2.2 Mbit at 720p, 1.0 Mbit at 480p), keyframes forced onto the source's own, AAC stereo. Threads: half the logical CPUs for a ladder rendition (`ladder.js ENC_THREADS`), all but two for the older single-rendition jobs (`remux.js`, `torrent-transcode.js FFMPEG_THREADS`). Encoders are started at below-normal priority. There is no hardware path of any kind in the code (no `qsv`, `vaapi`, `nvenc` or `-hwaccel` anywhere under `src/`).

**Cost of one job** (measured; the smallest CPU figure of 2–3 runs; speeds are lower bounds because the PC was busy):

| Job | CPU per second of film (thread-s) | Speed, pinned to 6C/12T | Speed, pinned to 4C/8T | Peak memory |
| --- | --- | --- | --- | --- |
| 1080p H.264 → 480p rung | 0.44 | 8.5× | 6.2× | 200 MB |
| 1080p H.264 → 720p rung | 0.60 | 6.5× | 3.8× | 263 MB |
| 1080p HEVC 10-bit → 720p | 0.73 | 4.8× | 2.2× | 315 MB |
| **1080p HEVC 10-bit → 1080p H.264** (a device that cannot decode HEVC) | **1.23** | 2.8–4.0× | 1.7–3.1× | 456 MB |
| the same through the older route (`remux.js`, hls muxer) | 1.30 | 3.0× | 2.2× | 578 MB |
| 4K HEVC SDR → 720p | 1.9 | 2.8× | 1.2× | 784 MB |
| **4K HEVC SDR → 1080p** | **2.3–2.5** | 1.9× | 0.73× | 926 MB |
| 4K HDR10 → 1080p, no tone mapping | 2.5–2.6 | 1.8× | 1.3× | 934 MB |
| 4K HDR10 → 720p, tone-mapped | 2.7–2.9 | 1.2× | 1.2× | 823 MB |
| **4K HDR10 → 1080p, tone-mapped** | **3.7–4.2** | 1.2× | 0.67× | 999 MB |

**How many at once.** N copies of the same job, pinned to 6C/12T, while other work held about half of those CPUs (measured):

| 1080p HEVC → 1080p H.264, N at once | Slowest job | CPU per film-second, each |
| --- | --- | --- |
| 1 | 4.0× | 1.23 |
| 2 | 2.1× | 1.28 |
| 3 | 1.05× | 1.30 |
| 4 | 1.07× | 1.27 |
| 6 | 0.81× | 1.31 |

Four held real time on six shared cores of which they were getting 5.5 threads; six fell to 0.81×. The cost per job did not change with N, so the ceiling is budget ÷ cost:

| Target, software | 1080p HEVC → H.264 | 720p rung | 4K SDR → 1080p | 4K HDR tone-mapped → 1080p |
| --- | --- | --- | --- | --- |
| i5-10400, at the edge (100 %, 1.0×) | 8 | 17 | 4 | 2 |
| **i5-10400, with headroom** | **5–6** | 12 | **3** | **1** |
| i5-10210U, at the edge | 4 | 8 | 2 | 1, below real time |
| **i5-10210U, with headroom** | **2–3** | 6 | **1** | **0** |

(scaled.) **Today's code stops at 2 in every column**: `MAX_ENCODES = 2` (`jit.js:524`), `MAX_ACTIVE_TRANSCODES = 2` (`remux.js:22`), `MAX_ACTIVE = 2` (`torrent-transcode.js:25`), counted together. On an i5-10400 two 1080p encodes use about 2.9 of 10.3 thread-seconds.

**What happens at the cap** (`load.js overload`, measured):

| Request while two encodes run | Answer |
| --- | --- |
| a third title, master playlist needing an encoder | `503 Server is busy transcoding other streams` in 87 ms |
| its segment or rendition playlist | `503 … that rendition isn't available right now` in 4–7 ms |
| the same through the older route | **`500`** `Server is busy transcoding other streams — try again in a moment` |
| a second viewer of a title already being encoded, same rendition | `200` in 101 ms: the segments are shared |
| the same title, far ahead in the film | `200` after 32 s: it waited for the one encoder |
| a remux of another title | `200` in 0.5 s: copies are not capped |
| a 720p rung under a copy (a slow line) | `503`: a courtesy rung never takes the last slot |

So the scheduler refuses rather than queues or degrades, and refuses fast. An encoder that gets 20 segments (about 2 minutes) ahead of its reader is parked, one nobody asks for is killed after 150 s, and thirty viewers asking for the same missing encoded segment started one encoder (measured). That part is as good as Plex's throttle. What is missing is everything outside the two slots: see f.

**HDR.** The tone-map filter measured 116–166 MP/s here under load; `tonemap.js` records 235 MP/s on this PC idle. On an i5-10400 that is about 152 MP/s, and the server's own `predictSpeed` then gives 1.24× for 4K → 1080p at 24 fps. The gate needs 1.5× (3.0× when another encode runs), so on the target **a 4K HDR title sent to a device that needs H.264 goes out at 1080p without tone mapping**: grey and washed out, by design ("a stream that falls behind is worse than a grey one"). At 720p the prediction is 1.9×, which passes only while no other encode is running. On the laptop CPU nothing HDR passes.

**Quick Sync.** Not in the code, and not measurable here (§9). From published material: UHD 630 decodes and encodes H.264 and HEVC 8/10-bit and tone-maps in hardware; there is no session limit on Intel graphics; UHD 630 has one video engine ([Jellyfin, Intel hardware acceleration](https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/intel/)). Community single-stream figures for `h264_qsv` at 1080p on UHD 630 are 143–221 fps ([egpu.io thread](https://egpu.io/forums/pro-applications/easy-video-encoding-benchmark-test-your-gpu-within-seconds/)), which is 6–9 films at 24 fps; a hosting vendor's planning figure is 8–15 × 1080p or 2–4 × 4K HEVC ([valebyte](https://valebyte.com/en/blog/plexjellyfin-hardware-how-many-4k-transcodes-can-it-handle/); a vendor blog, not a benchmark). This report uses **about 8 × 1080p and 2–3 × 4K HDR tone-mapped** as the estimate, with the CPU left to do sound and packaging (about 0.05–0.15 thread-s per stream). On Windows QSV is the only Intel method; hardware tone mapping through VPP is Linux-only per the same Jellyfin page.

### f. Background work that competes with viewers

| Job | When | Cost (measured unless said) | Does it yield to viewers? |
| --- | --- | --- | --- |
| Play-ready copy after a download (`preconvert.js` → `offline.js`), libx264 `veryfast` crf 23 | when a download lands; one at a time | **1.37 thread-s per film-second, 0.6–0.8 GB, all threads, normal priority** | **No.** Not counted in the two slots, and it outranks the viewers' below-normal encoders |
| Phone copy on request (`offline.js`) | on request; same queue | same | No |
| Library probe (`metadata.probe`: `execFileSync ffprobe`) | every new or changed file, at boot and at each 10-minute scan | **45–123 ms of blocked event loop per file**; 1,087 files = 142 s | No. It is the event loop |
| Library scan (`scanner.scan`: `readdirSync`/`statSync` over every folder) | boot and every 10 minutes | not timed alone; on a sleeping disk or a NAS it is the spin-up time, on the event loop | No |
| Intro and credits detection (`introdetect.js`) | after a scan; one run at a time | audio decode 0.005 thread-s per film-second; black-frame scan 0.22; **the fingerprint maths runs on the event loop in 32-frame slices** (4.4 % of a profile taken while it ran) | No. While it runs the watchdog also stops judging lag (`busyWithWork`) |
| Bitmap-subtitle OCR (`ocr.js`: Python + tesseract) | after enrichment; one at a time | not measured | No |
| Embedded subtitle → WebVTT | on first request | 0.001 thread-s per film-second | n/a |
| Picture variants / stills | on first request; 2 + 2 at once | 0.05–0.3 CPU-s each; a still costs 0.7–1.1 CPU-s | n/a (they are viewer requests) |
| Daily round (skip timestamps, metadata, backup, My List) | hourly check, tasks one after another, 3 minutes after boot | network-bound | n/a |
| Healer (30 checks) / health / watchdog / telemetry | every 60 s / 60 s / 20 s / 30 s | small; telemetry rewrites a 105 KB file every 30 s | n/a |

There is no single place that knows how much CPU work is running. Two viewer encodes, a play-ready copy, an OCR run, intro detection, two picture jobs and two stills can all run together.

### g. Downloads and torrent streaming

Read, not measured (§9).

- **aria2** is its own process (`aria2.js`): 1–6 downloads at once (default 4), 360 peer connections in total, `--seed-time=0`, no preallocation, admin-set speed caps. **While anyone is watching, at most 2 downloads are started** (`dlslots.js WATCH_HOLD`); running ones are not slowed. Its disk writes land on the library disk and compete with direct play on a hard disk.
- **WebTorrent runs inside the server process** (`torrent.js`): at most 12 torrents, 40 connections each, idle ones evicted after 30 minutes. The wire protocol and the piece picker share the event loop with the API, and a throw inside it is the reason `server.js` swallows every uncaught exception (see §5). A torrent stream that needs an encode also takes one of the two slots.
- A torrent stream relayed through the VPS uses its bandwidth twice.

### h. The JSON stores

Thirty-three stores (`new JsonStore(...)`), each held whole in memory and written whole (`jsonstore.js`): `JSON.stringify` + `writeFileSync` to `.tmp` + `renameSync`, debounced 1.5 s, on the event loop, no fsync. Flushed on SIGINT/SIGTERM.

What one viewer causes: a progress POST every 5 s dirties `profiles.json`; the WebSocket `activity` every 5 s dirties `watch-sessions.json`. Each is rewritten within 1.5 s, so 720 times an hour for one viewer and up to 2,400 times an hour for four or more out of step. `telemetry-hours.json` is rewritten every 30 s whether anyone is watching or not. `sessions.json` is touched every 5 minutes per device.

`store-bench.js`, with the server's own `JsonStore` (measured on the NVMe disk, PC busy):

| Store, at a size | File | Event loop blocked per save | Saves/h | Written per hour | Loop blocked per hour |
| --- | --- | --- | --- | --- | --- |
| `profiles.json`, live today | 62 KB | about 2 ms (scaled from the next row) | 720–2,400 | 43–145 MB | 1–5 s |
| `profiles.json`, 5 profiles × 150 titles | 226 KB | 7 ms | 720 | 159 MB | 5 s |
| `profiles.json`, 8 profiles × 1,500 titles (a year or two on) | 3.6 MB | **64 ms** | 2,400 | **8.4 GB** | 154 s (4 %) |
| `profiles.json`, 20 profiles × 3,000 titles | 18 MB | **443 ms** | 2,400 | 42 GB | 1,063 s (30 %) |
| `watch-sessions.json`, live today | 93 KB | 6 ms | 720 | 80 MB | 4 s |
| `watch-sessions.json` at its cap (8,000 sessions) | 3.0 MB | 35 ms | 2,400 | 7.1 GB | 84 s |
| `telemetry-hours.json` at its cap (90 days) | 230 KB | 6 ms | 120, always | 27 MB | 0.7 s |

Each played item adds about 300–700 bytes per profile (a progress row, a title row, sometimes the stream's metadata) and nothing prunes them. The healer already warns when a store passes 25 MB (`DATA_FILE_WARN_BYTES`); the pain starts well before that, at a few MB.

**Safety.** Killing a process 40 times while it saved a 1.3 MB store flat out never left an unreadable file and never lost a completed save (measured, Windows/NTFS; 4 leftover `.tmp` files). So the atomic rename does what the comment says for a crash. It does not for a power cut: without an fsync the rename can reach the disk before the data does. And when a store is unreadable at boot the server copies it to `<name>.corrupt-<time>` and **starts from defaults**: with `profiles.json` cut off at 60 % and `sessions.json` empty, the instance came up with the one default profile "Watcher", everyone signed out, and its next save wrote that over `profiles.json` (measured). The healer has a `store-corrupt` signature that reads the log line, so the admin page will say so within a minute or two, but nothing restores anything.

**Usage log.** Appended, not rewritten (good), capped at 30 MB a month and three months. At boot the whole month is read and replayed synchronously (`usage.boot()` at `require` time): at the cap that is **2.7 s before the server answers and about 430 MB of heap** (measured). The live file is 0.4 MB.

**Other growth.** `data/cache` on the live server is 700 MB, 605 MB of it the poster cache (capped at 4,000 files of up to 6 MB each, so up to 24 GB in theory); picture variants are capped at 6,000 files; jit, hls and torrent-hls segments are deleted after 150 s idle and at boot; the in-memory log is 1,500 lines. The module-level maps that were checked are bounded (the catalogue search cache at 60, probes at 500, jit tables at 100).

### i. The Node process itself

One process, one event-loop thread, libuv's pool of 4 (6 under pm2) for file reads, DNS and scrypt. The floor for any request is 0.7 ms (Express, the sign-in wall, a session lookup). Work that runs on the loop and should not:

| On the event loop | Cost | Where |
| --- | --- | --- |
| Composing Home | 16–20 ms (42–54 observed), per request, never cached | `routes/api.js:671`, `media/hero.js`, `media/identity.js` |
| Compressing the same static CSS on every request | 12–16 ms | `server.js` (`compression`), `/css/aurora.css` |
| Saving a store | 2 ms → 64 ms → 443 ms as it grows | `lib/jsonstore.js` |
| Probing a file | 45–123 ms each | `media/metadata.js:51` (`execFileSync`) |
| Scanning the library | every 10 minutes, synchronous | `media/scanner.js:151-159` |
| Fingerprinting intros | slices, for minutes after a scan | `media/introdetect.js` |
| Replaying the usage log | up to 2.7 s at boot | `lib/usage.js boot` |
| Reading a sidecar subtitle | `readFileSync` per request | `media/subtitles.js:46` |
| Rewriting a playlist | `readFileSync` per request on the older routes | `routes/stream.js:546` |
| The torrent client | unmeasured | `media/torrent.js` |
| A WebSocket message of any size, parsed before the sender is checked | 158 ms for 32 MB | `realtime.js` (`JSON.parse(raw)` in the `message` handler) |

The watchdog samples lag with one 500 ms timer per 20 s tick (`watchdog.js probeLag`), so it sees a stall only if it happens to straddle that half second. Soft heal at 1.5 s, restart at 6 s three ticks running, and only under pm2.

---

## 4. Capacity, in full

Target i5-10400 / 16 GB, SSD library, gigabit LAN. "Today" is the code as it is. Laptop figures in brackets where they differ.

| Mix | Viewers today | First limit | If the cap followed the CPU | With Quick Sync (est.) | How it fails |
| --- | --- | --- | --- | --- | --- |
| All direct play, 8 Mbit, on the LAN | ~100 | LAN | ~100 | ~100 | players rebuffer |
| All direct play, 8 Mbit, remote | uplink ÷ 10 Mbit | uplink | same | same | players rebuffer; a lower rung needs an encoder, of which one is available to slow lines |
| All direct play, 25 Mbit | ~30 LAN; 6–8 on one hard disk (est.) | LAN, then disk | same | same | rebuffer |
| All remux | 30+ | disk, LAN | same | same | — |
| 70 % direct / 20 % remux / 10 % transcode | 20 | encoder cap (2) | 50–60 [20–30] | 80+ | the 3rd transcoding viewer is told "busy" at once |
| All 1080p transcodes | 2 | encoder cap | 5–6 [2–3] | ~8 | same |
| All 4K SDR → 1080p | 2 [1] | encoder cap [CPU] | 3 [1] | 3–4 | same |
| 4K HDR tone-mapped | 1 at 720p alone; 0 at 1080p [0] | CPU, via the speed gate | 1 [0] | 2–3 | the picture goes out untone-mapped (washed out), not stalled |
| Signed-in devices, idle | 2,000+ held | — | | | |
| Signed-in web devices, when the library changes | ~50 unnoticed, 100–150 with a visible freeze, 500 = refusals | event loop (Home), listen backlog | | | everyone's requests wait; at 500, connections refused and memory near the watchdog's line |

Assumptions: 24 fps sources; `superfast` as shipped; 70 % CPU for encodes; no background encode running; uplink figures leave 20 % for everything else; hard-disk figures are estimates.

---

## 5. What can go wrong

Likelihood and impact are judgements. "Seen" says whether it was reproduced here.

| # | Failure | What happens | Likely | Bad | Detected today | Recovered today | Seen |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | The process dies on the home PC | Nothing restarts it: it is bare `node server.js` (`start-aurora.cmd` runs at login only). Down until somebody starts it | medium | high | only by an outside monitor on `/healthz` or the dead-man ping, if configured | no | read: the live process is not under pm2 |
| F2 | The process hangs (loop stuck) on the home PC | Watchdog logs "hard heal skipped … not under pm2" | low–medium | high | logged; `/healthz` stops answering | no | read |
| F3 | An exception escapes anywhere | `server.js` catches every `uncaughtException` and `unhandledRejection`, logs, and carries on. The "Timed out finding peers" rejection is one of these. Good for uptime; the process continues in whatever state the throw left, which Node's documentation says is not safe ([process docs](https://nodejs.org/api/process.html)) | certain (it happens daily) | low each time, unbounded in principle | healer's `crash` signature counts them | n/a | read |
| F4 | A store file is damaged (power cut mid-save, full disk, bad sector) | Boots from defaults: one profile "Watcher", everyone signed out; broken copy kept beside it; first save overwrites the store | low | **very high** | log line; healer `store-corrupt` on its next round | **no**; by hand from the daily backup (up to 24 h lost) | **yes** |
| F5 | Power cut during a save | Saves are not fsynced; the rename can land before the data → F4 | low | very high | as F4 | as F4 | not reproducible here; a process kill is safe (40/40) |
| F6 | The data disk dies | Backups default to `data/backups` on the same disk | low | very high | health alert only about backup age | no, unless `backupDir` points elsewhere | read |
| F7 | Disk full | Saves fail and are logged ("Failed to save"); the store lives on in memory and is lost at restart. Streams refuse with 503 below 2 GB free. Health alerts at 10 % / 5 % | medium (this PC's disk is 96 % full) | high | yes (health, healer forecast) | partly (temp sweeps) | read |
| F8 | An encoder crashes | The next request starts another, up to 3 per waiting request; a file whose index lies is remembered and sent down the older path | medium | low | logged; healer `ffmpeg-failed` | **yes** | **yes**: killed under a viewer, next segments answered 200 |
| F9 | Encoders left behind | On idle they are killed (150 s). If the server dies: under pm2 or systemd the whole tree goes; a bare process on Windows can leave them. `bootSweep` clears their folders; the healer looks for stuck helpers | low | low | yes | mostly | read |
| F10 | A burst of Home requests (many devices loading, or a library change) | Loop blocked for seconds; every viewer's next segment waits; over 6 s three ticks running, pm2 restarts the server | medium at 50+ devices, low in a household | medium–high | watchdog, if its half-second probe lands in it | soft heal drops caches, which does not help | **yes** |
| F11 | One client hammers an expensive request | No rate limit on anything but sign-in: one signed-in device on 64 connections held everyone else's requests for 6.4 s | low in a household | high | no | no | **yes** |
| F12 | A background encode starts while people watch | It takes the CPU at higher priority than their encoders; segments arrive late, players stall | medium | medium | healer counts slow segments (`seg-wait`) | no | **yes**, in effect: a below-normal encoder took 85 s for a 10 s segment on a busy machine |
| F13 | The server restarts with many devices connected | All reconnect on the same 1-2-4 s steps (no jitter), then all refetch. Same shape as F10 | certain on every deploy | low in a household | no | yes, by itself | measured as the storm in §3a |
| F14 | A slow or stalled client | Nothing buffered (measured). Sockets idle 75 s are closed. A WebSocket peer that vanished without closing is never noticed: there is no ping | low | low | no | no | **yes** for backpressure |
| F15 | WebSocket abuse | No payload limit (ws default 100 MiB), no per-address cap, parsed before the sender is checked: a 32 MB message from a socket with no session stalled the loop 158 ms and added 126 MB; 3,000 sockets from one address were accepted | low | medium | healer `ws-flood` | no | **yes** |
| F16 | Admin password guessing | No delay or lock-out: about 900 guesses a second. The password also rides in `?pw=`, which proxies log | low | very high (the admin can delete the library) | healer `signin-burst` counts | no | **yes** |
| F17 | Address spoofing | `clientIp` trusts the first `X-Forwarded-For` from anyone: a direct client can dodge the per-address sign-in limit and its ban. And the HTTP ban check uses `req.ip` with no `trust proxy`, which behind Caddy is always 127.0.0.1: a ban does not ban, and banning that address would ban everyone | low | medium | no | no | read |
| F18 | Picture-variant flood | Unbounded queue behind 2 workers; each waiting request holds a connection; up to 216 variants per picture | low | medium | no | no | **yes** (40 variants, 22.6 s) |
| F19 | The open proxy | `/proxy` fetches any public URL for anyone who can reach it (signed-in only when the wall is closed). Private addresses are refused properly. `/img/ext` is tight: exact host list, https, redirects checked hop by hop, size and type checked | low | medium | no | — | read |
| F20 | A catalogue or metadata provider is down | Timeouts of 12–15 s; failed pictures are remembered for 5 minutes. But when the catalogue cache is over a day old, every Home request starts a fresh set of fetches (`discover.trending` has no in-flight guard) | medium | low–medium | healer `provider-down`, `metadata` | yes, when the provider returns | read |
| F21 | A big library on first boot, or a sleeping disk | Seconds to minutes of 45–120 ms freezes (probes), or one long freeze (scan), with the server already listening | certain on first boot | medium | watchdog deliberately looks away while enriching | yes | **yes** (142 s for 1,087 files) |
| F22 | A deploy goes wrong | `git pull` + restart from the admin page: 3–50 s down (a scan), no check that the new code boots before the old one stops, no stored schema version, rollback by hand with git | medium | medium | update card shows the running commit | by hand | read |
| F23 | Log growth | Under pm2 the log files grow without rotation unless `pm2-logrotate` is installed; in memory, 1,500 lines | certain, slow | low | healer data-growth check covers `data/`, not `~/.pm2/logs` | no | read |
| F24 | Memory grows over days | Watchdog: soft heal at 1,000 MB, restart at 1,300 MB (pm2 only); pm2 kills at 1,500 MB | unknown | medium | yes | under pm2 | soak: see below |
| F25 | Clock jumps | Session expiry and cache ages use wall time; a jump forward expires things early, a jump back delays them. The lag probe needs three bad ticks, so one jump does not restart anything. The healer has a clock check | low | low | yes | n/a | read |
| F26 | Jobs overlapping | Daily tasks, OCR, intro detection and the copy queue are each serial; nothing stops them all running together with two viewer encodes | medium | medium | no | no | read |
| F27 | A store's save is refused for a moment (Windows: a scanner or indexer holding the file) | `renameSync` throws `EPERM`; the save is logged as failed and **not retried**: the change stays in memory until that store happens to be saved again, and is lost if the server stops first. `jit.js` already retries exactly this error for segments (`renameRetry`); `jsonstore.js` does not | medium on Windows | low–medium | log line; healer `store-save` | no | **yes**, once in the soak |

**The soak.** `soak.js`: 20 devices on the household mix (3 direct, 1 remux, 1 encoded rung, 6 browsing with a screen change every 8 s, 9 idle), a fifth of them replaced every minute, 35 minutes, 13,229 requests (measured). Resident memory by quarter of the run: 123, 129, 125, 130 MB; heap 23, 23, 22, 23 MB; handles 336, 329, 328, 327. After every device left and the reapers ran: 123 MB, 255 handles (the starting figure), no ffmpeg alive. No growth can be told apart from the ±5 MB jitter, and nothing was left open. Thirty-five minutes cannot rule out a slow leak; days of the live server's own watchdog history can, and the healer's `memtrend` check already reads it. Errors: one encoded segment answered `504` after 90 s (the starved below-normal encoder of F12); the other 26 were the test's own devices being unplugged mid-request. One real fault showed in the log: `Failed to save …imdb-map.json: EPERM … rename` (F27).

**Backups, judged.** `lib/backup.js` is good work: a daily snapshot of everything that cannot be rebuilt, checksummed in a manifest, verified after writing, 7 daily / 4 weekly / 3 monthly kept, restore only ever into an empty folder, the steps written down. Three gaps: it lands on the same disk unless told otherwise (F6); nothing ever tests a restore; and the one moment it is needed automatically (F4) it is not used. Recovery point today: up to 24 hours, by hand. Recovery time: the eight written steps, perhaps ten minutes for someone who has read them.

**What an operator can see when it is slow.** The admin Server tab (watchdog history of memory, lag samples and ffmpeg count; the healer's 30 checks; alerts), the in-memory log, `/healthz` (answers "the process is up", not "it is healthy"), ntfy/Telegram alerts, a dead-man ping. What is missing: how long requests take, by route; the loop's real delay distribution; how many requests were refused or queued; how long store saves take; the server's CPU; anything an outside tool can scrape.

**Security posture, as far as it bears on staying up.** Sign-in wall with hashed session ids, scrypt passwords, per-address and per-name limits on sign-in and PINs, constant-time admin comparison, a careful SSRF guard: sound. Missing: the limits in F15–F18, any security response headers (no `X-Content-Type-Options`, no CSP, no HSTS; Caddy can add them), and CORS is `*` on `/proxy` only.

---

## 6. Where work is wasted today

| # | Waste | Evidence | Size |
| --- | --- | --- | --- |
| E1 | Home is recomposed, re-stringified and recompressed for every request, including when the client's copy is current | profile; Express sends the `304` only after doing all the work | 20–50 ms of the one thread per Home; the root of F10, F11, F13 |
| E2 | The CSS bundle is recompressed on every request | 12–16 ms CPU each | small per household (the URL is immutable-cached), free to fix |
| E3 | Whole-file store rewrites | §3h | about 120 MB/h per viewer today, GB/h later; SSD wear; seeks on a hard disk |
| E4 | `telemetry-hours.json` rewritten every 30 s to add one sample | `telemetry.js` | 2,880 rewrites a day, idle or not |
| E5 | Encoded segments are thrown away 150 s after the last request, and all of them at boot | `jit.js IDLE_MS`, `jobFor` | a paused film, tomorrow's second viewer and every restart re-encode what was already made: 1.2–4.2 thread-s per film-second, again |
| E6 | Three places hold the same "2" and the box is a quarter used at the cap | §3e | half or more of the CPU's transcoding capacity unused |
| E7 | A full encode where a cheaper one would do: the top rung for a device that cannot decode HEVC is always 1080p crf 18 up to 10 Mbit, even for a phone on a 3 Mbit line; and 4K HDR is decoded in software though the box's own graphics could do it | `ladder.js topCeiling`; no hwaccel | 1.23 against 0.73 thread-s (720p) per viewer |
| E8 | The older single-rendition route still exists beside jit and costs more memory per job (578 against 456 MB) with more threads | bench | consolidation, not speed |
| E9 | Polling that could be push | torrent status every 1.5–5 s per viewer; Downloads every 15 s when the socket is down | small |
| E10 | Node copies every byte of direct play | 0.4–0.9 ms CPU per Mbit | small: 0.5 core at 1.25 Gbit. Worth doing for the hard-disk and thread-pool reasons, not for CPU |
| E11 | Progress is posted every 5 s and also reported over the WebSocket every 5 s | two messages, two stores dirtied, for one fact | halves the write traffic if merged |
| E12 | Pictures: the poster cache has no size budget in bytes | 605 MB live, cap is a file count | disk |

Already right, and worth keeping: allow-listed compression with Brotli at a measured quality; immutable caching of hashed assets; the service worker's cache-first pictures; one producer per rendition shared by every viewer; parking an encoder that runs ahead; in-flight de-duplication on pictures, probes and segments; width snapping; the 2 GB free-space guard; downloads holding back while people watch.

---

## 7. What comparable servers do, and what to copy

| Practice | Who, and what exactly | Source | Aurora today |
| --- | --- | --- | --- |
| Decide per stream: direct play, then remux, then transcode only what the client cannot take | Jellyfin names four: Direct Play, Remux (container only), Direct Stream (audio transcoded, video untouched), Transcode. Plex: direct play when "container, codecs, bitrate and resolution are all compatible"; direct stream "uses very little processing power" | [Jellyfin transcoding](https://jellyfin.org/docs/general/post-install/transcoding/); [Plex direct play/stream](https://support.plex.tv/articles/200250387-streaming-media-direct-play-and-direct-stream/) (summary only; page refused the fetch) | has it, and well: copy, remux with AAC, encode only when the device cannot decode |
| Size the server by a CPU budget per transcode | Plex: about 2,000 PassMark per 1080p transcode, 12,000 for 4K SDR, 17,000 for 4K HDR; multiply by streams | [Plex CPU guide](https://support.plex.tv/articles/201774043-what-kind-of-cpu-do-i-need-for-my-server/) (summary only) | a fixed "2" regardless of the CPU |
| Throttle the transcoder to the reader | Plex "transcoder default throttle buffer": seconds to buffer before throttling (forum posts say 60). Jellyfin: `EnableThrottling`, `ThrottleDelaySeconds` 180, segment deletion with `SegmentKeepSeconds` | [Plex transcoder settings](https://support.plex.tv/articles/200250347-transcoder/) (summary); [Jellyfin EncodingOptions](https://typescript-sdk.jellyfin.org/interfaces/generated-client.EncodingOptions.html) (summary) | has it: parks at 20 segments ahead |
| Use the graphics chip | Jellyfin on Intel: HEVC 10-bit from Kaby Lake up; "Hardware accelerated HDR/DV to SDR tone-mapping is supported on all Intel GPUs with HEVC 10-bit decoding"; "no concurrent encoding sessions limit on Intel iGPU"; software 4K60 Dolby Vision tone mapping "requires a Ryzen 9 5950X" | [Jellyfin Intel](https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/intel/); [hardware selection](https://jellyfin.org/docs/general/administration/hardware-selection/) | none |
| Cap streams and say "busy" | Emby: a server-wide simultaneous-stream limit and a per-user one. Plex: the "server is not powerful enough" message; a session cap that refuses further ones | [Emby forum](https://emby.media/community/topic/108325-max-simultaneous-video-streams); [Plex message](https://support.plex.tv/articles/205002628-why-do-i-get-the-this-server-is-not-powerful-enough-to-convert-video-message/) (summaries) | has the cap and a clear 503 for encodes; nothing for any other kind of work |
| Shed load by priority, not first come first served | Google SRE: criticality classes (`CRITICAL_PLUS` … `SHEDDABLE`), reject early, a retry budget. Netflix: requests bucketed and the least important shed first | [SRE book, Handling Overload](https://sre.google/sre-book/handling-overload/); [InfoQ on Netflix load shedding](https://www.infoq.com/news/2020/11/netflix-load-shedding/) | background encodes outrank viewers |
| Keep the event loop for small work | Node's own guide: "Node.js is fast when the work associated with each client at any given time is 'small'"; avoid synchronous fs, zlib and child_process calls in a server; `JSON.stringify` of large objects is named as a blocker | [Don't block the event loop](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop) | several blockers (§3i) |
| Workers and queues for heavy work | `piscina` (worker-thread pool with a queue limit), `p-queue` (in-process, concurrency and per-task priority), BullMQ (Redis-backed; Immich uses it) | [piscina](https://github.com/piscinajs/piscina); [p-queue](https://github.com/sindresorhus/p-queue); [Immich architecture](https://docs.immich.app/developer/architecture/) | hand-rolled serial queues, each separate |
| A real database for state | SQLite: "competes with fopen()"; WAL: "readers do not block writers and a writer does not block readers". Jellyfin is on SQLite (10.11 moved to EF Core); Navidrome is one binary plus SQLite with built-in backup; Immich uses Postgres. Node 22.13+ ships `node:sqlite` without a flag (release candidate); `better-sqlite3` is the established module | [SQLite: appropriate uses](https://www.sqlite.org/whentouse.html); [WAL](https://www.sqlite.org/wal.html); [Jellyfin 10.11](https://jellyfin.org/posts/jellyfin-release-10.11.0/); [Navidrome backup](https://navidrome.org/docs/usage/admin/cli/backup/); [node:sqlite](https://nodejs.org/api/sqlite.html); [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 33 whole-file JSON stores |
| Supervise the process; exit on the unknown | Node: "It is not safe to resume normal operation after 'uncaughtException'… an external monitor should be employed". pm2: `max_memory_restart`, `exp_backoff_restart_delay` up to 15 s. Docker: `on-failure`, `unless-stopped`, `HEALTHCHECK`. systemd: `Restart=on-failure`, `WatchdogSec` (not fetched; from memory) | [Node process](https://nodejs.org/api/process.html); [pm2 restart strategies](https://pm2.keymetrics.io/docs/usage/restart-strategies/); [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/); [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) | pm2 config exists; the home PC does not use it; exceptions are swallowed |
| Let the proxy serve bytes | nginx `X-Accel-Redirect`; Caddy documents the same with `handle_response` + `file_server` inside `reverse_proxy`; `encode zstd gzip`; HTTP/1.1, 2 and 3 on by default; rate limiting is a plugin (`caddy-ratelimit`) | [nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html); [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy); [encode](https://caddyserver.com/docs/caddyfile/directives/encode); [options](https://caddyserver.com/docs/caddyfile/options); [caddy-ratelimit](https://github.com/mholt/caddy-ratelimit) | Caddy only terminates TLS |
| Back off with jitter | AWS: full jitter, `sleep = random(0, min(cap, base × 2^attempt))`; it more than halves the work at 100 contending clients | [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) | doubling, no jitter, on web and TV |
| 3-2-1 backups, restores tested | "three copies of your data on two different media with one copy off-site" | [Backblaze](https://www.backblaze.com/blog/the-3-2-1-backup-strategy/) | one copy, same disk by default, never restore-tested |
| Measure | `prom-client` default metrics include event-loop lag; Node `perf_hooks.monitorEventLoopDelay`; RED (rate, errors, duration) per route | [prom-client](https://github.com/siimon/prom-client); [perf_hooks](https://nodejs.org/api/perf_hooks.html); [RED method](https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/) | none of it |
| HLS shape | Apple: 6-second targets, fMP4 required for HEVC | [HLS authoring specification](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices) | matches |
| Share a transcode between viewers | Plex transcodes once per device even when the output is identical (a forum feature request); no source found for Jellyfin sharing (inference: per session) | [Plex forum](https://forums.plex.tv/t/transcoding-cache/889015) | **Aurora is ahead here**: one producer per rendition, shared |

---

## 8. The plan

Every finding has a change. Effort: S = hours to a day, M = days, L = weeks. Gains are **measured** where the number came from §3–§5, otherwise **estimated**.

### Do now (cheap, safe)

| ID | Change | Files | Why | Expected gain | Effort | Risk | Practice |
| --- | --- | --- | --- | --- | --- | --- | --- |
| N1 | Supervise the server on both hosts. Home PC: pm2 with `pm2-windows-startup`, or a Windows service. VPS: a systemd unit (`Restart=on-failure`, `RestartSec=3`) or the existing pm2 file. Add `exp_backoff_restart_delay`. Install `pm2-logrotate` | `ecosystem.config.js`, new `deploy/aurora.service`, `SETUP.md` | F1, F2, F23: nothing restarts the home server, and its watchdog can only log | Recovery from a crash or hang: seconds instead of open-ended (estimated) | S | low | Node process docs; pm2 restart strategies |
| N2 | Background encodes behave: start `offline.js` jobs at below-normal priority with `-threads` capped at half the CPU, count them in `remux.encodeLoad()`, and do not start one (or suspend it) while a viewer encode runs | `media/offline.js`, `media/preconvert.js`, `media/remux.js` | F12: 1.37 thread-s per film-second at a higher priority than viewers (measured) | Viewer encodes keep their speed while a copy is made (estimated from the measured cost) | S | low | SRE: shed the sheddable first |
| N3 | A damaged store never boots as an empty house: on a parse failure, restore that one file from the newest verified backup and say so loudly; if there is no backup, refuse to start with a clear message for `profiles.json` and `sessions.json`. Fsync the temp file before the rename; retry a refused rename a few times and keep the store marked unsaved until one succeeds (F27); delete stale `.tmp` files at boot | `lib/jsonstore.js`, `lib/backup.js` (a `restoreFile(name)`), `lib/health.js` (an alert) | F4, F5, F27: measured, the house's profiles are replaced by "Watcher" | Removes the worst outcome found; recovery point becomes "last backup", automatically | S–M | medium: a wrong restore is also data loss, so only for unreadable files, keeping the broken copy | SQLite's durability model; tested restores |
| N4 | Backups leave the disk: at first run ask for, and afterwards warn daily about, a `backupDir` on another disk; add `node src/lib/backup.js drill`, which restores the newest snapshot into a temp folder, boots a private instance on it and checks the profiles are there | `lib/backup.js`, `lib/health.js`, `scripts/` | F6; restores never tested | A disk loss stops being a total loss (estimated) | S | low | 3-2-1 |
| N5 | One broadcast per change, and clients that do not all answer at once: debounce `library_updated` in `realtime.js` (2 s, trailing), remove the second broadcast in the rescan route, add a random 0–3 s delay before the clients' refetch, and full jitter to both reconnect loops | `realtime.js`, `routes/admin.js:787`, `public/js/ws.js`, `tv-native/src/realtime.ts` | F10, F13: 600 requests and a 4–8 s freeze at 100 devices; refusals at 500 (measured) | Half the requests, spread over 3 s instead of one instant (estimated) | S | low | AWS full jitter |
| N6 | `503` with `Retry-After` on the older route's "busy" (today `500`) | `routes/stream.js:336,571`, `routes/torrent.js` | §3e: a monitor and a client both read 500 as a fault | Correct signal; clients can retry sensibly | S | low | Emby/Plex "busy" behaviour |
| N7 | WebSocket limits: `maxPayload: 64 * 1024`, at most N sockets per address (say 30), a 30 s server ping that drops sockets that do not answer, and check the socket's right to speak before `JSON.parse` | `realtime.js` | F14, F15: 32 MB message, 158 ms stall, +126 MB; 3,000 sockets accepted (measured) | Closes both paths | S | low: check the TV's largest real message first | ws documentation |
| N8 | Admin password: reuse the sign-in limiter (10 failures per address per 15 minutes), stop accepting `?pw=` | `realtime.js isAdmin`, `routes/admin.js`, `routes/auth.js` (export `tooMany`/`recordFail`) | F16: about 900 guesses a second (measured) | Brute force stops being practical | S | low: confirm nothing still uses `?pw=` | — |
| N9 | Trust the proxy and nobody else: `app.set("trust proxy", "loopback")` (or a configured list), make `clientIp` return `req.ip`, read `X-Forwarded-For` only then; same rule on the WebSocket upgrade | `server.js`, `realtime.js clientIp` | F17 (read) | Bans and per-address limits mean what they say, behind Caddy and without it | S | medium: test behind Caddy and on the LAN | Express "behind proxies" |
| N10 | Store diet, part one: write `telemetry-hours.json` once an hour and on exit; write `watch-sessions.json` on session start and stop and at most once a minute; raise the progress debounce to 5–10 s (the flush on exit already exists); stop sending progress twice (E11) | `telemetry.js`, `lib/jsonstore.js` (per-store debounce), `profiles.js` | E3, E4: about 120 MB/h per viewer today (measured sizes × code frequencies) | About 10× fewer rewrites; up to 10 s of progress at risk on a hard kill instead of 1.5 s | S | low | — |
| N11 | Picture-variant queue: a length cap (say 200) beyond which the original is served; refuse blur without one of the widths the TV really asks for; workers = 2 on 4 cores, 3 above | `lib/imgvariant.js` | F18: unbounded queue (measured 22.6 s for 40) | A flood degrades to originals instead of holding connections | S | low | bounded queues |
| N12 | Direct play reads in 1 MB chunks (`highWaterMark`), and `UV_THREADPOOL_SIZE` is set where the server is actually started (`start-aurora.cmd`, the systemd unit), not only in the pm2 file | `routes/stream.js:67,77`, `start-aurora.cmd` | §3c: 64 KB reads through 4 pool threads cap a seeking disk at about 25 MB/s for everything (estimated) | 16× fewer pool round trips per stream; matters on a hard disk | S | low | — |
| N13 | Probe files without blocking: `execFile` with 2–4 in flight instead of `execFileSync`; yield during `scan` (async `readdir`, or a worker) | `media/metadata.js`, `media/scanner.js` | F21: 45–123 ms freezes, 142 s for 1,087 files (measured) | First boot and every new download stop freezing the loop | S–M | medium: `probe` has synchronous callers to follow through | Node event-loop guide |
| N14 | Read the usage log at boot as a stream, off the request path (or keep a small aggregate snapshot and replay only the tail) | `lib/usage.js boot` | 2.7 s and about 430 MB at the 30 MB cap (measured) | Boot no longer scales with the log | S | low | — |
| N15 | Serve the CSS bundle precompressed (compress once per hash, keep the Brotli and gzip buffers) | `server.js`, `lib/cssbundle.js` | E2: 12–16 ms per request (measured) | under 1 ms | S | low | — |
| N16 | One in-flight catalogue refresh at a time, with a back-off after a failure | `media/discover.js trending` | F20 (read) | An outage upstream stops multiplying by the number of Home requests | S | low | — |
| N17 | Response headers from Caddy (`X-Content-Type-Options`, `Referrer-Policy`, HSTS) and `encode zstd gzip` there | Caddyfile on the VPS | §5 security | hygiene | S | low | Caddy docs |
| N18 | Move the watchdog's lag measure to `perf_hooks.monitorEventLoopDelay` (continuous, percentiles) and stop exempting intro detection from judgement | `lib/watchdog.js` | it sees a stall only inside one half-second window per 20 s | The watchdog sees what the viewers feel | S | low | Node perf_hooks |

### Next

| ID | Change | Files | Why | Expected gain | Effort | Risk | Practice |
| --- | --- | --- | --- | --- | --- | --- | --- |
| X1 | Memoise Home: keep the composed answer per (profile, slim, kids) with a version that changes on a library scan, a catalogue refresh or that profile's own writes; answer `304` from the version without composing; hoist the per-request rebuilding in `hero.js` (`recencyTerm`) and `identity.js` (normalised titles, library maps) into caches invalidated the same way | `routes/api.js`, `media/hero.js`, `media/identity.js`, `profiles.js` (a per-profile version counter) | E1, F10, F11: 20–50 ms per request, the heaviest thing on the loop (measured) | Repeat Home requests under 1 ms; the first after a change still 20 ms. The device ceiling moves from about 50–150 to the thousands (estimated) | M | medium: stale personal rows if an invalidation is missed; a short maximum age (15 s) bounds it | HTTP validators; the TV branch's 304 |
| X2 | The encoder cap becomes a setting sized from the machine: `maxEncodes` in config, default from the logical CPU count (i5-10400: 4; i5-10210U: 2; never below 2, never above 6), one definition shared by `jit.js`, `remux.js`, `torrent-transcode.js`; thread count per encode = logical ÷ cap | those three files, `media/ladder.js ENC_THREADS`, `config.js` | E6: the cap, not the CPU, is the limit; two encodes use 28 % of an i5-10400 (scaled) | 2 → 4 transcoding viewers on the desktop i5 (scaled from measured cost); mix capacity 20 → 40 | S–M | medium: more encodes means less headroom for the loop; ship with N2 and N18, verify with `ffmpeg-bench.js --sweep` on the real box | Plex's PassMark budget |
| X3 | One scheduler for CPU work: every ffmpeg and helper is started through one module that knows its class (viewer encode > viewer remux > picture/still/subtitle > play-ready copy > intro detection, OCR) and a CPU budget; lower classes wait or are suspended while higher ones run; refusals are uniform (`503` + `Retry-After`) | new `media/sched.js`; call sites in `jit.js`, `remux.js`, `torrent-transcode.js`, `offline.js`, `ocr.js`, `introdetect.js`, `stills.js`, `imgvariant.js` | F12, F26: nothing has the whole picture | Background work can no longer stall a viewer; the cap can be raised safely | M | medium | job queues with priority (p-queue); SRE criticality |
| X4 | Keep encoded segments: a byte-budgeted LRU (say 10–20 GB, configurable) instead of delete-after-150-s and delete-at-boot; a job's folder is trusted again when its key (file id + mtime + rendition + algorithm version) matches | `media/jit.js` (`IDLE_MS` reaper, `jobFor`), `media/remux.js bootSweep` | E5: every pause, restart and second viewing re-encodes | Repeat viewing of a transcoded title costs nothing; restarts stop interrupting transcodes (estimated) | M | medium: a half-written segment must never be served, which the rename-on-publish rule already ensures | Jellyfin segment keep; Plex transcode cache request |
| X5 | Rate limits on the expensive requests per session and per address (token bucket in-process, or `caddy-ratelimit` on the VPS): Home, search, picture variants, `/proxy` | `server.js` (a small middleware), Caddyfile | F11, F18, F19 | One client cannot hold the loop (measured 6.4 s) | S–M | low | SRE: reject early |
| X6 | Metrics: `/metrics` (admin-gated or loopback only) in Prometheus text: request count and duration histogram per route, event-loop delay percentiles, encodes running / refused / parked, segment wait, store save duration and size, WebSocket clients, process CPU and memory. `/healthz` gains `loopDelayP99Ms` and turns `503` when the loop has been over a threshold for a minute, so a supervisor's health check means something | new `lib/metrics.js`, `server.js`, `lib/health.js` | §5: nothing says where time goes | Diagnosis by number; a health check a supervisor can act on | S–M | low | RED; prom-client |
| X7 | Take intro fingerprinting and other heavy JS off the loop: a worker thread for the FFT/correlation, and for stringify of large stores until L1 lands | `media/introdetect.js`, new `lib/worker.js` | §3i | Removes minutes of sliced blocking after each scan | M | low | Node worker threads; piscina |
| X8 | Deploys that cannot take the house down: before restarting, boot the new code on a spare port against a copy of the data folder and require `/healthz` and `/api/library` to answer; keep the previous commit and offer "roll back"; put a `schema` number in each store and refuse to open a newer one | `lib/updatecheck.js`, `routes/admin.js`, `lib/jsonstore.js` | F22 | A bad pull is caught before viewers see it (estimated) | M | low | canary and rollback |
| X9 | Caddy serves the bytes: static files and finished segments straight from disk; direct play handed back with an `X-Accel-Redirect`-style header (`handle_response` + `file_server`) so the kernel sends the file | Caddyfile; `routes/stream.js` (emit the header when a trusted proxy asks) | E10; the thread-pool concern in §3c | Node's 0.4–0.9 ms per Mbit goes to zero; hard-disk reads stop competing with the API for the pool (estimated) | M | medium: range requests and the sign-in wall must still be enforced by Node first | nginx X-Accel; Caddy `handle_response` |
| X10 | Lower the cost of the "device cannot decode it" encode when the client is small or slow: let the client's `max=` height and measured line choose 720p as the top rung | `media/ladder.js`, clients | E7: 1.23 against 0.73 thread-s (measured) | 40 % less CPU for phone viewers | S–M | low | "transcode only what the client needs" |

### Larger projects

| ID | Project | Why | Expected gain | Effort | Risk | Practice |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | **SQLite (WAL) for the state that changes while people watch**: progress and titles, sessions, viewing sessions and history, telemetry hours, usage events. Keep small, rarely-written settings as JSON. Order: (1) a `db.js` on `node:sqlite` (Node 22.13+) or `better-sqlite3`; (2) migrate `watch-sessions`, `telemetry-hours`, `usage` first (append-shaped, low risk); (3) `profiles.json` progress/titles tables with a one-time import and a JSON export kept in the daily backup; (4) sessions | §3h: whole-file rewrites grow from 2 ms to hundreds; crash safety without fsync is by luck | A progress save is one row (microseconds, off the critical path); no size cliff; real durability; queries for the admin pages instead of scans | L | medium–high: the heart of the household's data; needs the restore drill (N4) first | SQLite appropriate uses; WAL; Jellyfin, Navidrome |
| L2 | **Hardware transcoding** (Quick Sync / VAAPI): detect at boot by actually running a short encode (the pattern `tonemap.probeSupport` already uses); build a second argument set (`-hwaccel qsv -hwaccel_output_format qsv`, `scale_qsv`/`vpp_qsv`, `h264_qsv` with forced IDR on the source's keyframes, hardware tone mapping); prove jit's exact-boundary contract holds for it with the existing `jit-exact` tests; fall back to software per job on any failure (the `veto` pattern) | §3e: software HDR tone mapping does not fit the target; the cap of 2–5 is CPU | About 8 × 1080p and 2–3 × 4K HDR (estimated from published figures); CPU freed for everything else | L | high: drivers differ between Windows and Linux, and keyframe placement is the part jit cannot compromise on | Jellyfin hardware acceleration |
| L3 | **Two processes**: the API (profiles, catalogue, pictures, WebSocket) and a media worker (ffmpeg orchestration and the torrent client), talking over a local socket | F3: the torrent client's throws are why every exception is swallowed; its work shares the API's thread | A torrent fault or stall cannot freeze browsing; the worker can crash and restart honestly; the API can exit on a real uncaught exception | L | medium | process isolation; Node's guidance on `uncaughtException` |
| L4 | **A container image** with `HEALTHCHECK` and `restart: unless-stopped`, ffmpeg pinned to one version on every platform | CI already broke once on a Windows/Linux difference; two hosts run two ffmpeg builds | The same ffmpeg everywhere; supervision by default | M | low | Docker restart policies |

### The ten, ranked

1. **N1** supervisor on both hosts → crashes and hangs heal in seconds → S
2. **N3 + N4** damaged store restores itself from backup; fsync; backups off the disk, restore drilled → removes "profiles gone" and "disk gone" → S–M
3. **N5 + X1** one debounced broadcast, jittered clients, memoised Home → 4–8 s freeze at 100 devices becomes milliseconds; Home 20–50 ms → under 1 ms → S + M
4. **N2** (then **X3**) background encodes below viewers and inside the slots → viewers keep their encoders' speed → S (M)
5. **X2** encoder cap from the CPU → 2 → 4 transcoding viewers on an i5-10400 → S–M
6. **N7 + N8 + N9 + N11** limits on WebSockets, admin guesses, proxy trust, picture queue → closes the measured abuse paths → S
7. **N10**, then **L1** store diet, then SQLite → 10× fewer rewrites now; no size cliff later → S, then L
8. **X6 + N18** metrics, a health check that knows the loop, a watchdog that sees stalls → slow becomes diagnosable → S–M
9. **N13 + N14** non-blocking probes, streamed usage replay → first boot and big libraries stop freezing → S–M
10. **L2** Quick Sync / VAAPI → about 8 transcodes and working 4K HDR tone mapping (estimated) → L

---

## 9. What was not measured

| Not measured | Why | What stands in for it |
| --- | --- | --- |
| Quick Sync / VAAPI | This PC's Intel graphics is disabled (only the NVIDIA card is present; `ffmpeg -init_hw_device qsv` fails with "Error creating a MFX session"). The code has no hardware path to run anyway | Published figures, marked estimated (§3e) |
| The target CPU itself | Not available | Core count emulated by pinning; clock by PassMark ratio (§2) |
| Clean wall-clock speeds | The PC was 85–100 % busy with other agents' work for the whole session, and the brief rules out raising priority over the live server | CPU seconds per film-second (stable across load); wall speeds given as lower bounds; `tonemap.js`'s own idle figures for this PC as a cross-check |
| A hard disk under many streams | The test files were on NVMe and in the page cache | An estimate from seek arithmetic (§3c) |
| Real uplinks, Wi-Fi, the VPS | Loopback only; the VPS is another machine and was not touched | Arithmetic from bitrates |
| Torrent streaming and aria2 under load | No real torrents or trackers allowed | Reading the code (§3g) |
| Real film content | Test media had to be generated | Synthetic picture with temporal noise; costs for grainy film should be close, 60 fps content 2.5× |
| OCR cost | Needs a file with bitmap subtitles and Python/tesseract in the fenced instance | Not estimated |
| Memory over days | One 35-minute soak | The soak's slope (§5) |
| Power loss mid-save | Cannot be done to this PC | Process kills (safe, 40/40) and the absence of fsync in the code |
| How the VPS and the home PC are actually supervised | Only this PC is visible: its live server is a bare `node server.js` | `ecosystem.config.js` exists; whether the VPS uses it was not verified |
| Linux | Everything ran on Windows 11 | ffmpeg's cost is the same code; process priorities and file renames behave differently and should be re-checked there |
