### typical — 8639619@8639619e — 2026-10-26T19:44:33.862Z

typical (house-recorded): 30 % direct, 55 % repackaged (TV offset copy, web/phone jit copy), 10 % encoded (720p/480p rungs), 5 % torrent; TVs 55 %, phones 25 %, desktops 20 %. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 637/1394 |  | 0 | 0 | 0 | 8/11 | 5.5 | 2.3 | 0.03 | 0.091 | 0 (0) | 0/5 (0/6) | 173 (+90) | 18 | 18.5 | 3.71 | 0 | supported |
| 10 | 5 | 738/1292 |  | 0 | 0 | 0 | 7.3/9.8 | 9.1 | 1.6 | 0.047 | 0.105 | 2.4 (1) | 0/6 (0/6) | 165 (+94) | 19.6 | 33.2 | 3.32 | 0 | supported |
| 15 | 8 | 539/2351 |  | 0 | 0 | 0 | 7/8 | 41 | 2.1 | 0.058 | 0.166 | 0.7 (1) | 1/6 (1/6) | 188 (+132) | 20.3 | 52.1 | 3.47 | 0 | supported |
| 20 | 10 | 6948/12833 |  | 0 | 0 | 0 | 5.9/11.3 | 103 | 2.6 | 0.111 | 0.264 | 1.1 (1) | 1/6 (1/6) | 220 (+239) | 21 | 70.4 | 3.52 | 0 | **no**: burst TTFF p95 12833 ms > 4000 |
| 25 | 13 | 11430/18425 |  | 0 | 0 | 0 | 7.1/8.8 | 66.7 | 7 | 0.112 | 0.316 | 1.5 (1) | 0/6 (0/6) | 231 (+345) | 23.2 | 88.7 | 3.55 | 0 | **no**: burst TTFF p95 18425 ms > 4000 |
