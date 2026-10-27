### worst — 5dd310c@5dd310c2 — 2026-10-26T18:28:03.235Z

worst case: 40 % encoded (720p/480p rungs), 30 % torrent (TV file + web repackaged), 30 % repackaged. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 1290/4834 |  | 0 | 0 | 0 | 7.8/10.9 | 6.2 | 2.1 | 0.03 | 0.088 | 3.8 (1) | 1/5 (1/6) | 159 (+25) | 20.8 | 14.6 | 2.93 | 0 | **no**: burst TTFF p95 4834 ms > 4000 |
| 10 | 5 | 1075/3951 |  | 0 | 0 | 0 | 9.5/12.1 | 6.9 | 2.5 | 0.072 | 0.132 | 3.4 (2) | 1/6 (1/6) | 204 (+468) | 20.1 | 25.9 | 2.59 | 0 | supported |
| 15 | 8 | 10583/15671 |  | 0.23 | 0 | 0 | 8.5/6550.4 | 201 | 4.1 | 0.133 | 0.157 | 4.8 (3) | 2/6 (2/6) | 273 (+132) | 22.2 | 44.8 | 2.98 | 0 | **no**: burst TTFF p95 15671 ms > 4000; API p99 6550.4 ms > 300 |
