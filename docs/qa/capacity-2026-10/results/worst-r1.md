### worst — 5dd310c@5dd310c2 — 2026-10-26T16:57:04.613Z

worst case: 40 % encoded (720p/480p rungs), 30 % torrent (TV file + web repackaged), 30 % repackaged. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 1288/6854 |  | 0 | 0 | 0 | 19.7/199 | 2.3 | 3.5 | 0.034 | 0.32 | 0 (0) | 1/5 (0/6) | 197 (+269) | 38.2 | 15 | 2.99 | 1 | **no**: burst TTFF p95 6854 ms > 4000; refused: 0 never started, 1 stream refusals, 0 × 429 |
| 10 | 5 | 3460/23840 |  | 0 | 0 | 0 | 9.6/22.4 | 52.7 | 3.1 | 0.046 | 1.039 | 0 (0) | 3/5 (0/6) | 235 (+101) | 39.4 | 23 | 2.3 | 1 | **no**: burst TTFF p95 23840 ms > 4000; refused: 0 never started, 1 stream refusals, 0 × 429 |
