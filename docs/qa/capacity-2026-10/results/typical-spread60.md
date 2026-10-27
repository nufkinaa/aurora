### typical — 6638195@66381959 — 2026-10-26T22:07:19.701Z

typical (house-recorded): 30 % direct, 55 % repackaged (TV offset copy, web/phone jit copy), 10 % encoded (720p/480p rungs), 5 % torrent; TVs 55 %, phones 25 %, desktops 20 %. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 551/1503 |  | 0 | 0 | 0 | 7.8/8.9 | 2.9 | 1.9 | 0.028 | 0.063 | 0 (0) | 0/5 (0/6) | 157 (+94) | 23.4 | 16.7 | 3.34 | 0 | supported |
| 10 | 5 | 645/2360 |  | 0 | 0 | 0 | 8/17.1 | 2.8 | 1.7 | 0.042 | 0.079 | 0 (0) | 0/5 (0/6) | 174 (+125) | 18.1 | 36.7 | 3.67 | 0 | supported |
| 15 | 8 | 644/2147 |  | 0 | 0 | 0 | 6.5/8.8 | 4 | 1.9 | 0.066 | 0.273 | 3.7 (1) | 1/6 (1/6) | 179 (+232) | 20.4 | 53.9 | 3.59 | 0 | supported |
| 20 | 10 | 644/2668 |  | 0 | 0 | 0 | 7.4/52.9 | 56.2 | 5.7 | 0.088 | 0.274 | 3.7 (1) | 1/6 (1/6) | 202 (+240) | 20.5 | 68.8 | 3.44 | 0 | supported |
| 25 | 13 | 537/2557 |  | 0 | 0 | 0 | 6/9 | 9.1 | 2.3 | 0.098 | 0.265 | 1 (1) | 1/6 (1/6) | 223 (+340) | 20.9 | 80.5 | 3.22 | 0 | supported |
| 30 | 15 | 1073/13067 |  | 0 | 0 | 0 | 6.9/11.2 | 34 | 2.5 | 0.132 | 0.435 | 3.9 (1) | 1/6 (1/6) | 241 (+343) | 23.7 | 99.8 | 3.33 | 0 | **no**: burst TTFF p95 13067 ms > 4000 |
| 40 | 20 | 1165/12338 |  | 0 | 0 | 0 | 10/88.6 | 104.5 | 100.5 | 0.216 | 0.534 | 6.5 (3) | 3/5 (3/6) | 276 (+418) | 25.6 | 139 | 3.47 | 0 | **no**: burst TTFF p95 12338 ms > 4000 |
