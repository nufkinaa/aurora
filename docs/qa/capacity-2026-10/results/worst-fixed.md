### worst — 8639619@8639619e — 2026-10-26T22:50:59.951Z

worst case: 40 % encoded (720p/480p rungs), 30 % torrent (TV file + web repackaged), 30 % repackaged. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 977/4405 |  | 0 | 0 | 0 | 8.4/12.6 | 4.8 | 2 | 0.027 | 0.091 | 3.1 (1) | 1/5 (1/6) | 180 (+60) | 18.2 | 14.6 | 2.93 | 0 | **no**: burst TTFF p95 4405 ms > 4000 |
| 10 | 5 | 1070/2871 |  | 0 | 0 | 0 | 9.2/12.2 | 2.8 | 1.7 | 0.053 | 0.225 | 5.2 (3) | 3/6 (3/6) | 225 (+654) | 19.6 | 29.4 | 2.94 | 0 | supported |
| 15 | 8 | 939/8601 |  | 0 | 0 | 0 | 6.8/8.6 | 3.5 | 3.3 | 0.129 | 0.18 | 5.5 (2) | 1/6 (1/6) | 254 (+132) | 20.6 | 35.5 | 2.37 | 0 | **no**: burst TTFF p95 8601 ms > 4000 |
