# Backend efficiency: running Aurora well on a weak PC

2026-10-11. Code on branch `work-backend-efficiency` (14 commits, being merged onto 1.6.93). How to rerun every table: `tools/backend-perf/README.md` on that branch; raw results in `docs/qa/backend-efficiency/results/`.

## How it was measured

A "weak" profile: the server pinned to two physical cores, heap capped at 512 MB, a library of 1,261 titles / 1,801 files, 8 profiles with up to 1,500 history rows each, caches at live sizes. Requests were sent the way the apps send them (session, br/gzip, `X-Blur: 1`). The machine was close to 100 % busy with other work throughout, so wall-clock figures are upper bounds; CPU time, counts and bytes are not affected.

## Result, whole branch against 1.6.92

| | Before | After |
| --- | --- | --- |
| Home, CPU per request | 334 ms | 50 ms |
| Home for the TV (slim), CPU per request | 381 ms | 61 ms |
| Library list, CPU per request | 29–36 ms | under 0.1 ms |
| Saving progress | 1.55 ms | 0.97 ms |
| Start to listening | 4.63 s | 3.70 s |
| Idle CPU | 32.7 s per hour | 18.9 s per hour |
| Idle blocking file calls | 56,600 per hour | 34,500 per hour |
| Warm memory (RSS / heap) | 203 / 90 MB | 189 / 85 MB |
| Time to Home with 5 people watching, median | 329 ms | 112 ms |
| Same, 9 in 10 | 627 ms | 1.4 s |

The 9-in-10 figure did not improve: slow Home loads under load are store saves, which this branch does not touch (finding 3).

## Findings, ranked

1. **`require()` inside a function costs about 40 µs a call on Node 22.** Home did 1,771 of them per request (71 ms), every request in a household with a kids profile did 3, and the healer did 420 a minute: 21 of the 38 main-thread CPU-seconds an idle server used per hour. Fixed.
2. **Home was 334 ms of CPU per request and allocated 39 MB.** Besides finding 1: looking a title up by id walked the whole library about 3,000 times per request, and the title-matching maps were rebuilt 4–5 times. Fixed: 50 ms.
3. **The stores are the next wall.** One viewer rewrites `profiles.json` 720 times an hour and `watch-sessions.json` 732 times. On a grown household that is 3.2 GB written per viewer-hour, 5.7 % of the event loop blocked (11.7 % with five viewers) and single saves of 1.5–2.3 s. At today's sizes it is about 126 MB per viewer-hour. Not changed (needs a decision).
4. **SQLite for the same viewer-hour:** 3.9 MB written, 0.13 ms CPU and 0.29 ms blocked per save, against 34 ms and 89 ms for the JSON store. Measured with Node's built-in `node:sqlite`; nothing migrated.
5. **An idle server writes 27.5 MB an hour**, all of it `telemetry-hours.json` rewritten every 30 s, so the data disk never rests.
6. **Blur-up placeholders are made eagerly.** The first library request queued 2,523 pictures at two ffmpeg runs each: 1,262 ffmpeg starts in the first minute, the event loop 36 % busy. About 25 CPU-minutes for this library (estimated).
7. **The tone-map timing ran at every start:** 8 ffmpeg processes, 12 CPU-seconds, both cores saturated for 8.5 s. Fixed (remembered on disk).
8. **The 10-minute rescan blocked the loop for about 1.0 s of CPU** (6,846 blocking file calls). Halved.
9. **Every kept answer is keyed on the scan time, which moves on every scan**, so the next requests rebuild 215–490 ms of work, mostly the search index.
10. **The library list cost 29 ms per request**, 14 ms even to answer "unchanged". Fixed.
11. **A first scan of 300 new files blocked the loop for 17.6–29.8 s** in synchronous ffprobe. Fixed.
12. **Memory is not the limit:** 203 MB warm; a 150-minute soak grew the heap by 0.8 MB per hour.

## Implemented, each measured alone

| Change | Before → after |
| --- | --- |
| A rescan lists each folder once | file calls 6,842 → 3,182; scan CPU 1,047 → 547 ms |
| Title lookup by id from a map | Home 333 → 273 ms |
| In-function `require()` asked for once (`lib/lazy.js`, 44 sites) | Home 251 → 108 ms; a picture 1.3 → 0.9 ms; idle main thread 38.5 → 13.2 CPU-s per hour |
| ffmpeg, ffprobe, tesseract, aria2c, python located by one process at start | blocking child processes 6 → 2 |
| Library probes no longer block | loop blocked 17.6–29.8 s → 0 for 300 new files |
| Title-matching maps kept until the library changes | Home 100 → 56 ms; search 16.5 → 9.9 ms; My List 5.4 → 2.7 ms |
| Two stores no longer rewritten to say nothing new | 60 → 3 writes per hour idle |
| Tone-map speed remembered | 12 CPU-s per start → 0 |
| Library list made once per library change | 29–36 ms → under 0.1 ms |
| Dead source lists dropped from `torrent-streams.json` | 3.03 MB written per lookup → about 20 KB |

Two things to know: the fastest tone-map timing ever taken is now kept across starts, so a borderline HDR decision could differ from what one slow start would have decided; and a compressed library answer now carries a length instead of arriving in chunks.

## Plan for what is left

| # | Change | Gain | Effort | Needs the owner's decision |
| --- | --- | --- | --- | --- |
| 1 | Stores: a viewing session written on start, stop and once a minute; progress in a file per profile; then SQLite | 3.2 GB → about 4 MB per viewer-hour; loop blocked 5.7–11.7 % → under 0.1 % (measured) | S, then M, then L | yes: trade-off and a storage change |
| 2 | `telemetry-hours.json` written hourly and at exit | 27.5 → 0.24 MB per hour idle; the disk can sleep | S | yes: up to an hour of one chart lost on a hard kill |
| 3 | Blur-up only for what a screen draws; no still for unopened films | about 25 CPU-minutes and 2,523 process starts after first use | S–M | yes |
| 4 | An unchanged rescan keeps the index | 215–490 ms per scan not rebuilt | M | no |
| 5 | Title-page metadata: serve the old answer while refreshing, one request in flight, weekly warm | about 7,500 upstream requests a day → hundreds (estimated) | M | no |
| 6 | Intro pass: remember episodes that cannot be analysed | 14,400 blocking stats per hour idle → 0 | S | no |
| 7 | A low-power profile chosen from cores and RAM (smaller recommender, slower healer and rescan) | memory 174 → about 125 MB; idle CPU 19 → about 8 s per hour (estimated) | M | yes |
| 8 | Picture fast path without re-validation per request | 0.2–0.3 ms × 300 pictures per Home | S | no |
| 9 | Scan off the event loop | a 0.55 s freeze every 10 minutes → 0 | M | no |
| 10 | Bounds for caches that only grow | sizes stop growing with server age | S–M | no |
| 11 | Child-process hygiene (time limits, bounded error text) | one damaged file cannot cost a film's worth of memory | S–M | no |
| 12 | Small per-request things | 2–5 % of the cheapest requests | S | no |

## Not measured

A hard disk (the library is on NVMe and in the page cache; scan costs are call counts, not seek times); a genuinely slow CPU (two fast cores are not two old ones); per-film ffmpeg costs (test films are six seconds long); memory over days (the soak is 150 minutes); torrents, aria2, providers and notifications (read from code only).

## Tests

Windows `npm test` 1,162 of 1,162 (55 new); Linux 1,133 pass, 29 skipped (no ffmpeg there); UI 187 with two load failures that pass alone.
