### worst — 5dd310c@5dd310c2 — 2026-10-26T20:12:31.772Z

worst case: 40 % encoded (720p/480p rungs), 30 % torrent (TV file + web repackaged), 30 % repackaged. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 1077/2055 |  | 0 | 0 | 0 | 8.4/18.2 | 5 | 2.3 | 0.028 | 0.121 | 3.7 (1) | 0/5 (0/6) | 168 (+63) | 23.9 | 12.3 | 2.45 | 0 | supported |
| 10 | 5 | 1071/4770 |  | 0 | 0 | 0 | 7.9/15.7 | 5.3 | 2.8 | 0.08 | 0.17 | 5 (2) | 1/5 (1/6) | 232 (+94) | 25.4 | 27.7 | 2.77 | 0 | **no**: burst TTFF p95 4770 ms > 4000 |
| 15 | 8 | 1076/2249 |  | 0 | 0 | 0 | 7.3/11.5 | 45.3 | 3.5 | 0.099 | 0.186 | 2 (3) | 2/5 (2/6) | 246 (+168) | 24.1 | 40 | 2.67 | 0 | supported |
| 20 | 10 | 2860/8030 |  | 0 | 0 | 0 | 7/104.3 | 200.8 | 3.9 | 0.122 | 0.203 | 5.3 (3) | 3/5 (3/6) | 293 (+162) | 23.8 | 46.7 | 2.34 | 0 | **no**: burst TTFF p95 8030 ms > 4000 |
