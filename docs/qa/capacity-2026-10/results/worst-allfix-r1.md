### worst — 81d142b@81d142b9 — 2026-10-26T23:52:19.822Z

worst case: 40 % encoded (720p/480p rungs), 30 % torrent (TV file + web repackaged), 30 % repackaged. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 1304/3097 |  | 0 | 0 | 0 | 12.4/18.2 | 2.2 | 2.1 | 0.03 | 0.102 | 4.5 (2) | 2/5 (2/6) | 167 (+60) | 17.9 | 14.6 | 2.93 | 0 | supported |
| 10 | 5 | 768/8388 |  | 0 | 0 | 0 | 7.6/10.1 | 5 | 2 | 0.079 | 0.154 | 1.5 (2) | 0/6 (0/6) | 225 (+99) | 19.1 | 29.3 | 2.93 | 0 | **no**: burst TTFF p95 8388 ms > 4000 |
| 15 | 8 | 751/2566 |  | 0 | 0 | 0 | 7/13.6 | 10.4 | 2.9 | 0.097 | 0.164 | 4.3 (4) | 3/6 (3/6) | 251 (+682) | 19.4 | 39.8 | 2.65 | 0 | supported |
| 20 | 10 | 951/2112 |  | 0 | 0 | 0 | 6.5/7.9 | 6.7 | 3.3 | 0.126 | 0.249 | 6.9 (3) | 3/6 (3/6) | 299 (+166) | 20.3 | 53 | 2.65 | 0 | supported |
| 30 | 15 | 1160/3408 |  | 0 | 0 | 0 | 7.5/12.2 | 5.2 | 4.9 | 0.172 | 1.687 | 7.2 (6) | 8/6 (6/6) | 305 (+237) | 32.6 | 84.3 | 2.81 | 0 | supported |
| 40 | 20 | 963/5602 |  | 0.19 | 0 | 0 | 12.3/277.2 | 663.7 | 122.1 | 0.238 | 2.521 | 11 (6) | 9/6 (6/6) | 317 (+309) | 41.5 | 105.3 | 2.63 | 0 | **no**: burst TTFF p95 5602 ms > 4000 |
