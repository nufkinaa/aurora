### typical — 6638195@66381959 — 2026-10-26T15:42:58.708Z

typical (house-recorded): 30 % direct, 55 % repackaged (TV offset copy, web/phone jit copy), 10 % encoded (720p/480p rungs), 5 % torrent; TVs 55 %, phones 25 %, desktops 20 %. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 875/1396 |  | 0 | 0 | 0 | 9.5/15.5 | 2.7 | 2.8 | 0.029 | 0.091 | 0 (0) | 0/4 (0/6) | 148 (+98) | 27.4 | 20.7 | 4.15 | 0 | supported |
| 10 | 5 | 639/2163 |  | 0 | 0 | 0 | 6.6/8.5 | 4.1 | 1.5 | 0.032 | 0.053 | 0 (0) | 0/5 (0/6) | 147 (+123) | 20.4 | 27.8 | 2.78 | 0 | supported |
| 15 | 8 | 751/6849 |  | 0 | 0 | 0 | 7/8.5 | 9.2 | 2.5 | 0.061 | 0.442 | 0 (0) | 1/6 (0/6) | 167 (+168) | 23.8 | 51.3 | 3.42 | 1 | **no**: burst TTFF p95 6849 ms > 4000; refused: 0 never started, 1 stream refusals, 0 × 429 |
| 20 | 10 | 2769/6560 |  | 0 | 0 | 0 | 6.6/8.6 | 6.9 | 2.5 | 0.083 | 0.496 | 0 (0) | 1/6 (0/6) | 232 (+200) | 24.5 | 63.5 | 3.18 | 1 | **no**: burst TTFF p95 6560 ms > 4000; refused: 0 never started, 1 stream refusals, 0 × 429 |
