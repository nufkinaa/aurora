# Server round 2026-10-18 — the integrated tree

Branch `srv-integrate` (worktree `C:\elia\aurora-srv-int`), from master `f465c38` (server 1.7.2). The five branches were merged one at a time, with root `npm test` and the UI files each branch touched run after every merge. Nothing is pushed and the version is not bumped.

| Order | Branch @ commit | Merge | Conflicts |
| --- | --- | --- | --- |
| 1 | srv-storage @ `03734a6` | `b3019e6` | none |
| 2 | srv-eventloop @ `3b0dcf5` | `4ab7e78` | none (textual) |
| 3 | srv-streaming @ `ecca18c` | `bfa44d0` | `src/media/cpuwork.js`, `src/routes/admin.js` |
| 4 | srv-resilience @ `20f9f81` (the `f937a84` report + one doc line) | `4197d27` | `server.js`, `src/media/discover.js` |
| 5 | srv-loadtest @ `c0d5dac` | `fab1f5f` | none |

After the merges came `bc75e0d` (admin CSS), `6eb89b1` (leaks UI test), `ba98c04` (torrents: no cap) and `5f7f5f6` (web settings race).

## Conflicts and overlaps, and how each was resolved

**`src/media/cpuwork.js:73,96-100`.** The thread budget (eventloop) now takes its count from `lib/cpucount.js` `count()` (streaming). That count covers the affinity mask, the cpuset and the Linux cgroup quota. The module is loaded through `lib/lazy` because `budget()` runs on every drain. The low-power hook from eventloop is kept.
- **Also changed:** `src/lib/power.js:47-53` (the low-power profile's thread count) uses the same `cpucount.count()`, so every budget reads one CPU number.
- **Admin tuning list:** `src/routes/admin.js:403` adds "CPUs this server may use" with its reason.

**`src/routes/admin.js:431-457`.** The eventloop report (caches, scan, power, tuning) and the streaming report (disks, direct play, removals) are both kept. The streaming report also gains `pauses` (procpause counters).

**`server.js:692-709`.** Both start-ups are kept: the hwenc probe (streaming) and the resources check plus maxConnections (resilience).

**`src/media/discover.js`, title metadata: one cache layer.** The cache is eventloop's `metaCache`: meta.json, stale-while-revalidate, one request per title, failures remembered. `lib/upstream.js` is only the transport for this URL: timeout, fair share per host, breaker and retry. It is called with no `ttlMs` and `negativeMs: 0` (`discover.js:867`), so a 404 is remembered once, in `metaFails`.
- **A page that waits.** A route that passes `{ waiting: true }` (`discover.js:812-827`) waits for the in-flight request through the new `upstream.within(url, promise, 2500)` (`src/lib/upstream.js:617`). At 2.5 s that page gets `UpstreamError("deadline")`, and the host's breaker takes one strike for the call. The request runs on to its full answer and lands in `metaCache`. When it lands, `lateFills` is counted.
- **Not a title's fault.** A breaker that is `open` or a host queue that is `busy` is not recorded against the title (`discover.js:840`).
- **Other discover calls.** Catalogue pages, genres and search keep resilience's PAGE_ASK. discover's own caches stay the cache for them; upstream's 10-minute entry only carries a late answer to the next ask.
- **No other overlaps.** person.js, xray.js and similar.js were only changed by resilience (similar.js also got storage's write cadence), so they had no competing cache.
- **Tests.** `test/upstream-callsites.test.js`, `test/discover-meta-swr.test.js` and `test/upstream.test.js` all pass.

**Image routes in `src/routes/stream.js`.** These merged with no conflict:
- eventloop's asynchronous sweep and write, and no `existsSync` before `/img/:id`;
- resilience's 4 s wait for a picture plus its rate limit on misses only;
- streaming's Range/ETag through `lib/rangeserve.js`, which covers `/stream/video`.

**`torrent.js`.** The pack-ranking lines from master 1.7.2 are unchanged: no line removed from master is pack-related. Streaming's upload setting, memnudge and bounded `sourcesByHash` merged cleanly, and so did resilience's `fetchJson` through upstream.

**Other shared files.** admin.html, realtime.js, healer checks, the `similar.json` cadence (storage) and keeper.js merged cleanly. Checked:
- `realtime.js`: storage's "pause means write the journal now" sits beside resilience's single `send()` path.
- `subaudio.js` / `sublang.js`: eventloop's asynchronous reads sit beside storage's 30 s store cadence.
- `profiles.js`: eventloop's `index.version` sits beside storage's journal.

**Fixed while integrating** (each one is found only when the branches run together):
1. **`src/lib/jsonstore.js:728-734`.** A save on a long cadence held a timer that kept the process alive. The hourly chart (storage) can be due an hour away, so `test/ws-hygiene.test.js` (resilience) hung for an hour. That timer is now unref'd. `beforeExit` still flushes it, and the server is kept alive by its port anyway.
2. **`src/lib/configcheck.js:92,102-108` and `test/configcheck.test.js`.** Resilience's config check did not know six settings from the other lanes: `powerProfile`, `diskTypes`, `hwEncode`, `hwEncodeSessions`, `torrentUploadKBps` and `jitCacheGB`. They would have been warned as unknown. They are in the schema now, and a new test fails if `config.js` ever reads a key the schema lacks. The `rateLimits` default text now says "enforce". The production config.json was checked read-only, keys only: no problems.
3. **`src/lib/procpause.js` (rewritten) and `src/media/remux.js:254-293`, park-ahead on Windows.** Measured: one pause or resume is one PowerShell plus an Add-Type compile, **~340–450 ms** wall on this PC.
   - **How often:** it is NOT per segment. It runs once per 50→20-segment cycle, which is about one suspend and one resume per ~3 minutes of film per TV offset stream.
   - **Two unbounded cases found:**
     - a suspend the OS refused was retried every 5 s, forever, per job;
     - a failed resume was forgotten (`paused = false` anyway), so ffmpeg stayed suspended.
   - **Bounds now:**
     - at most 2 PowerShells at once;
     - at most 12 suspends a minute (past that the job runs on, as before);
     - 3 failed suspends in a row switch suspending off for 30 min;
     - a resume is never refused;
     - remux does not ask again for a refused pause for 60 s;
     - a failed resume stays "paused" and is retried every 5 s, not on every segment request.
   - **Visibility:** the counters are in the admin streams report. Tested in `test/procpause.test.js`.
4. **`public/admin.html:378-379`.** At 1280 px the Health card's column heads split mid-word ("CALL S", "FAILE D") because of the page-wide `overflow-wrap: anywhere`. They no longer split.
5. **`public/js/state.js:186-200`, a web race the settings UI test caught** (1 in 6 alone on the integrated tree, 0 in 4 on master's timing). A switch flipped while an earlier `profile_updated` re-read was on its way was turned back by that older read. The read is now laid down only when nothing changed the prefs locally meanwhile. The flip's own save brings the next read. After the fix: 6 of 6 alone, and signin, wall and storage-sync all pass.
6. **`test/ui/leaks.test.js`.** The first count is now taken after the same settle as the second, and the test fails on what GREW. On a fresh server the first count sometimes still held a listener that let go later, so the "after" count came out lower than "before": a failure with nothing leaked. It was 2 of 7 on the integrated tree and 0 of 6 on master's timing. After the change: 5 of 5.

## Owner decisions applied

- **Per-device rate limits: ENFORCED,** as resilience built them. `"rateLimits": "log"` is the off-switch.
- **Progress journal window: 30 s,** as storage built it.
- **NVENC: "auto",** as streaming built it.
- **Torrents (final, 2026-10-18): "No cap on downloads at all".**
  - `torrentUploadKBps` defaults to **-1 (off)**. `config.js:248`, `torrent.js:207-219` and the config-check text say so. A cap applies only when the admin sets one.
  - Streaming's torrent changes were checked: this round added **no download-speed and no connection limit**.
    - webtorrent `maxConns: 40` is 1.7.2's own;
    - the upload limit is conditional;
    - memnudge is a garbage collection, not a cap.
  - The admin's existing speed-limit settings and 1.7.2's "3 downloads at once per account" are untouched.
  - `test/torrent-nocap.test.js` holds both rules.
  - (The torrent *source lookups* go through upstream's per-host fair share. Those are provider API calls, not the download.)
- **Sign-in, PIN and pairing attempt limits: left exactly as they are.** `routes/auth.js` only had its Google calls moved onto `upstream.fetch`. `routes/profiles.js` only changed one memo key. `realtime.clientIp` is unchanged.

## Tests on the integrated tree

**Root `npm test` (Windows, Node 22):**
- on `fab1f5f` (all five merged), twice: 1,822 pass / 1,838, 0 fail, 16 skipped both times;
- on `5f7f5f6`, twice: 1,824 / 1,840, 0 fail, 16 skipped both times.
- The two real-ffmpeg jit tests that are known to fail under load did not fail in these runs.

**Linux (WSL Ubuntu, a full clone from a git bundle of `srv-integrate`, `tv-native/` and `.git` included):**
- on `fab1f5f`: Node 22.13.1 gave 1,780 pass / 1,838, **0 fail**, 58 skipped (no ffmpeg there, as in CI); Node 20.18.1 gave the same;
- on `71404c3` (final): Node 22.13.1 gave 1,782 pass / 1,840, **0 fail**, 58 skipped; Node 20.18.1 gave the same.

**Whole `npm run test:ui` (Windows, real Chrome), 291 tests. Every failing file was rerun alone:**

| Run | Tree | Result | Failing file, and its reruns alone |
| --- | --- | --- | --- |
| 1 | `bc75e0d`, alongside a load test | 289 pass, 1 fail, 1 skipped | telemetry: the needle "4711" found in the stringified telemetry, plausibly a timing number containing those digits. 3 of 3 alone |
| 2 | `bc75e0d` | 289 pass, 1 fail | leaks: fixed above |
| 3 | `6eb89b1` | **290 pass, 0 fail**, 1 skipped | — |
| 4 | `6eb89b1` | 289 pass, 1 fail | settings: the race fixed above |
| 5 | `5f7f5f6` (final code) | **290 pass, 0 fail**, 1 skipped | — |
| 6 | `5f7f5f6` (final code) | **290 pass, 0 fail**, 1 skipped | — |

**UI files after each merge:**
- storage: admin-oldlog and storage-sync, 3 of 3;
- eventloop: admin, 31 of 31;
- streaming: admin and jit-withdrawn, 33 of 33;
- resilience: server-health and admin, 38 of 38.

**Real Chrome on the admin Server tab** (private instance, its own made-up password; 1280×900 and 390×844; screenshots looked at):
- Health card (resilience);
- Watchdog card with the power profile, the tuning list and "kept in memory" (eventloop);
- Encoding card (streaming);
- the old-log finding under Library & data → Data growth (storage), with a 60 MB sparse `server-stdout.log.1`.

The document width equals the screen at both sizes, no element is wider than the screen, there are no console errors, and no "[object Object]", "undefined" or "NaN" appears.

## The integrated load test (tools/loadtest, commits pinned)

`node tools/loadtest/run.js ab --a f465c38 --b bc75e0d --scenario evening --n 16 --minutes 4 --rounds 3`. That is A = master 1.7.2 and B = the integrated tree (product code equal to the final HEAD). It ran 6 times interleaved A B B A A B on the real library, with the PC at 25–49 % CPU from other work (quieter than the branch runs). "No overlap" means every B run beat every A run. Full table: `loadtest-results/ab-evening16-integrated.md`.

| metric | master 1.7.2 | integrated | change | call |
| --- | --- | --- | --- | --- |
| API p99 | 95.4 ms | 61.6 ms | −35 % | **better** (no overlap) |
| API p95 | 42.3 ms | 29.2 ms | −31 % | **better** |
| pictures p95 / p99 | 358 / 600 ms | 289 / 484 ms | −19 % / −19 % | overlap / **better** |
| browse p50 / p95 / p99 | 12.0 / 208 / 390 ms | 8.2 / 191 / 360 ms | −32 / −8 / −8 % | **better** / **better** / overlap |
| Home p99 (server) | 47 ms | 27 ms | −43 % | overlap |
| loop stall time | 369 ms/min | 0 ms/min | −100 % | **better** |
| loop stalls > 50 ms / > 100 ms | 17 / 2 | 0 / 0 | | **better** |
| longest stall | 194 ms | 50 ms | −74 % | **better** |
| healthz p99 | 26.6 ms | 9.4 ms | −65 % | **better** |
| ELU | 0.097 | 0.050 | −49 % | **better** |
| TTFF p50 | 119 ms | 119 ms | 0 | overlap |
| segment p95 | 35 ms | 24 ms | −31 % | **better** |
| writes to data/ (server) | 6,288 KB/min | 12.3 KB/min | −99.8 % | **better** |
| data/ growth incl. stream caches | 4,107 MB | 144 MB | −96.5 % | **better** |
| sync fs time | 471 ms/min | 117 ms/min | −75 % | **better** |
| fs calls/s | 104 | 60 | −43 % | **better** |
| ffmpeg CPU | 2.03 cores | 0.48 cores | −76.5 % | **better** |
| server CPU | 10.5 s/min | 6.3 s/min | −40 % | **better** |
| RSS | 196 MB | 243 MB | +24 % | **worse** (no overlap) |
| heap | 71 MB | 75 MB | +6 % | overlap |
| 429s / 503s / 5xx | 0 / 0 / 0 | 0 / 0 / 0 | | |
| viewer stalls | 0 | 0 | | |

**Small box** (`--machine small`: 2 CPUs by affinity + a 256 MB heap; evening n=8; B = `6eb89b1`): `ab-evening8-small-integrated.md`.

| metric | master | integrated | call |
| --- | --- | --- | --- |
| API p99 | 235 ms | 169 ms (−28 %) | overlap |
| pictures p95 | 415 ms | 353 ms (−15 %) | overlap |
| browse p95 / p99 | 305 / 444 ms | 228 / 416 ms | **better** / overlap |
| loop stall time | 602 ms/min | 210 ms/min (−65 %) | **better** |
| longest stall | 421 ms (one A run: 1.5 s, "degraded") | 143 ms | overlap |
| healthz p99 | 29 ms | 12.5 ms | **better** |
| ELU | 0.089 | 0.046 | **better** |
| TTFF p50 | 106 ms | 110 ms | overlap |
| writes to data/ | 3,223 KB/min | 8.1 KB/min | **better** |
| ffmpeg CPU | 1.26 cores | 0.025 cores | **better** |
| server CPU | 6.8 s/min | 3.5 s/min | **better** |
| RSS | 185 MB | 200 MB (+8 %) | worse (no overlap) |
| heap | 71 MB | 64 MB | **better** |
| 429 / 503 / viewer stalls | 0 / 0 / 0 | 0 / 0 / 0 | |

**Households** (`--scenario households --n 30`: 30 households, mostly browsing, 2 streams; B = `5f7f5f6`, the final code): `ab-households30-integrated.md`.

| metric | master | integrated | call |
| --- | --- | --- | --- |
| API p95 / p99 | 56 / 129 ms | 35 / 103 ms | overlap |
| browse p95 / p99 | 241 / 337 ms | 188 / 354 ms | overlap |
| pictures p95 | 321 ms | 324 ms | overlap |
| Home p99 (server) | 39 ms | 23 ms | overlap |
| loop stall time | 176 ms/min | 27 ms/min (−85 %) | **better** |
| loop stalls > 50 ms | 9 | 2 | **better** |
| healthz p99 | 14.7 ms | 4.2 ms | overlap |
| ELU | 0.041 | 0.029 | **better** |
| server CPU | 3.45 s/min | 3.27 s/min | overlap |
| writes to data/ | 2,888 KB/min | 6.1 KB/min | **better** |
| sync fs time | 199 ms/min | 54 ms/min | **better** |
| fs calls/s | 34 | 21.5 | **better** |
| RSS / heap | 199 / 69 MB | 227 / 71 MB | worse (no overlap; +14 % / +3 %) |
| TTFF p50, viewer stalls, 429 / 503 / 5xx | 104 ms, 0, 0 / 0 / 0 | 106 ms, 0, 0 / 0 / 0 | overlap |

Nothing measured got worse except memory. Mostly-idle households were already light on master; what remains is the disk writes and the loop stalls they caused.

**RSS +24 %.** The JavaScript heap is flat (+6 %, overlap; −10 % on the small box). The extra resident memory is outside the heap, which fits this round's new worker threads (library walk, folder removal, helper spawner, credits analysis), each carrying its own V8 isolate, plus upstream's JSON cache (≤ 24 MB). It was not measured per thread. +47 MB against 16 GB is not a limit; on a 4 GB box it is worth knowing.

## Before deploying: what the owner must know (all five reports, deduplicated)

**Data on disk (storage)**
1. **A hard kill now loses up to 30 s of resume position** for a title that was simply playing (it was ~1.5 s). Starts, seeks, pauses, finishes and stops are written within 1.5 s. A graceful stop or restart (keeper, Ctrl-C, admin restart) loses nothing.
2. **Rolling back to 1.7.2 after a HARD kill:** 1.7.2 does not read `watch-journal.json`, so it shows progress as of the last checkpoint (≤ 15 min old). The household itself is complete, and rolling forward merges the journal back. After a graceful stop, a rollback sees everything.
3. **New files in `data/`** (both are taken by the backups):
   - `watch-journal.json` (+ `.good1`/`.good2`): never delete it while the server runs;
   - `profile-states-orphaned.json`: the 20 ghost states moved out of profiles.json at the first boot (logged once); safe to delete by hand once looked at.
4. **`watch-sessions.json` and the hourly chart lag on disk** by up to a minute and an hour after a hard kill. Memory, and so the admin page, is live.
5. **The 891 MB `data/server-stdout.log.1` is never deleted by Aurora.** Server → Library & data → Data growth names it, with the command to delete it.

**Machine-dependent behaviour (eventloop, streaming)**

6. **Power profile.** The low-power profile switches itself on with ≤ 4 CPU threads, ≤ 6 GB of memory or a small heap. In that profile the rescan runs every 20 min, the healer every 3 min, and one heavy background decode runs at a time. One at a time also applies on ≤ 8 threads.
   - The i5-10400 house box has 12 threads: profile "normal", 2 background decodes.
   - nufurora.com's VPS will likely be "low".
   - The admin's Watchdog card says which profile, and why. `"powerProfile"` overrides it.
7. **CPU count.** Budgets count only the CPUs the process may use: affinity, cpuset, and on Linux the cgroup quota. A VPS with a CPU quota now gets fewer encoders, as it should.
8. **Hardware encoding "auto".** The graphics card is used for the jit ladder only where its picture was measured at least as good as x264 (NVENC on the house PC). On some ceiling-bound rungs PSNR is up to 1.3 dB lower, though VMAF is higher in 12 of 12. HDR, the TV's offset encodes and torrent transcodes stay on the CPU. `"hwEncode": "off"` switches it off.
9. **Direct-play read patterns.** A disk the OS reports as a spinning HDD is read 1 MB at a time, 2 reads at once per disk. SSDs are unchanged. Network shares, virtual disks and unknown disks get 512 KB × 4. WSL/VPS ext4 on a virtual disk reports "unknown". `"diskTypes"` overrides the detection.
10. **New disk use: the jit cache.** Idle jit segments are now kept and reused: up to 20 GB in `data/cache/jit`, and fewer when the disk has less than 5 GB free; anything unused for 6 h goes. `"jitCacheGB"` sets the cap. Overall, data/ growth fell 96 % because copies no longer run to the end of the film.
11. **Park-ahead on Windows.** A TV offset copy is suspended 50 segments ahead of its viewer and resumed at 20. Each pause or resume is a PowerShell (~350 ms), about once per 3 minutes of film per stream, bounded as described above.
12. **No saved library walk.** A server with no saved walk (a new install) makes its library requests wait for the first walk (≤ 20 s) after boot.
13. **Sidecar subtitles under heavy load.** Sidecar subtitle reads go through the libuv thread pool and can wait longer on a loaded box. The keeper sets `UV_THREADPOOL_SIZE=6`; without the keeper, Node's default is 4.

**Behind nufurora.com's reverse proxy (resilience, streaming)**

14. **`X-Forwarded-For` is believed only from this machine, or from `"trustProxy"`.**
    - If nufurora's proxy runs on the same box, nothing to do.
    - If it runs in another container or on another host (e.g. Docker's 172.17.0.1), set `"trustProxy"`. Otherwise every not-signed-in visitor shares the proxy's address for the rate limits and the WebSocket cap, and gets the LAN ×4 allowance if that address is private.
    - Signed-in devices are keyed by their session either way.
15. **Proxy settings.** `docs/operations.md` "Behind a reverse proxy" has the Caddy and nginx settings: no buffering on `/stream/`, `/air/` and `/offline/file/`; 120 s upstream reads; upstream keep-alive under Aurora's 75 s. Nothing was applied to nufurora.
16. **Connection cap on Linux.** maxConnections is set from the open-file limit (soft limit − 256). A VPS left at 1024 accepts ~768 connections, and the Health card warns under 4096. Raise LimitNOFILE in the unit.

**Limits clients can meet (resilience)**

17. **Rate limits are enforced**, only on endpoints that cost provider work or CPU: search, suggestions, catalogue, people, X-Ray and trailers, picture-host misses, Resync and the web proxy.
    - They are sized at least 3.5× a measured power user, and normal use is never refused.
    - `Retry-After` is ≤ 5 s; the website and the TV wait and ask again.
    - Off-switch: `"rateLimits": "log"`.
18. **HTTP and WebSocket limits:**
    - headers must arrive within 20 s and the whole request within 120 s (an avatar upload is the only body of note);
    - JSON bodies are capped at 100 kB, 16 kB for sign-in;
    - WebSocket messages are capped at 64 kB, with a 30 s heartbeat and 64 sockets per address (LAN ×4).
19. **First ask while a provider is slow.** When a provider takes more than 2.5 s, the first ask of a catalogue title page, a catalogue page, the genre chips, catalogue search, the person sheet, X-Ray, More like this or the player's web subtitles can come back empty or partial. The next ask is answered from the late answer. Home, the library, library title pages and playback do not depend on a provider.
20. **AI picks budget.** It is now per device. Before, `req.ip` behind the proxy made it one budget for the whole site. The amount itself is unchanged.
21. **The config check at boot** refuses a bad value (its default applies, and the key is named in the log and on the Health card) and never crashes the server. Production config.json has no problems.
22. **New:** `GET /api/admin/metrics` (admin only, `?fmt=prom`), `[slow]` log lines, and the Server → Health card.

**Owner decisions recorded here**

23. **Torrents:** no upload cap, and no new speed or connection limit, unless the admin sets one.
24. **Sign-in, PIN and pairing attempt limits:** unchanged. Resilience noted that they key on the first `X-Forwarded-For` hop, which a client can rotate. Per the owner, they are left exactly as they are.
25. **Nothing to configure.** No new setting needs a value and production config.json is not touched. It runs on Node 20 and 22, on Windows and Linux.

## What was not verified here

- **The Mi TV.** No adb was allowed, and no TV code changed in this round.
- **Linux with ffmpeg, and the load test on Linux.** The WSL box has no ffmpeg, so only the unit suites ran there.
- **Real torrent swarms, a real spinning-disk system disk, and a real network share.** The same as in the branch reports.
- **`tv-native` jest/tsc.** Not run: nothing under `tv-native/` changed. The root tests that read `tv-native/` ran on both Windows and the Linux clone.
