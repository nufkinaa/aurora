### worst — 5dd310c@5dd310c2 — 2026-10-27T01:48:13.258Z

worst case: 40 % encoded (720p/480p rungs), 30 % torrent (TV file + web repackaged), 30 % repackaged. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 982/4949 |  | 0 | 0 | 0 | 8.1/9.7 | 4.9 | 2.1 | 0.025 | 0.027 | 0.6 (1) | 0/5 (0/6) | 161 (+25) | 19.3 | 14.5 | 2.89 | 0 | **no**: burst TTFF p95 4949 ms > 4000 |
| 10 | 5 | 1075/2366 |  | 0 | 0 | 0 | 7.7/9.5 | 5.8 | 1.6 | 0.046 | 0.157 | 6.6 (2) | 1/6 (1/6) | 201 (+362) | 19.6 | 27.2 | 2.72 | 0 | supported |
| 15 | 8 | 959/8297 |  | 0 | 0 | 0 | 7.3/11.7 | 7.8 | 3.7 | 0.133 | 0.223 | 6.1 (2) | 2/6 (2/6) | 252 (+394) | 20.8 | 37.1 | 2.47 | 0 | **no**: burst TTFF p95 8297 ms > 4000 |
