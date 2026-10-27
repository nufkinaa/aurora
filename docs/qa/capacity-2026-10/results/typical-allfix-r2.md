### typical — 81d142b@81d142b9 — 2026-10-27T00:25:31.834Z

typical (house-recorded): 30 % direct, 55 % repackaged (TV offset copy, web/phone jit copy), 10 % encoded (720p/480p rungs), 5 % torrent; TVs 55 %, phones 25 %, desktops 20 %. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 537/1183 |  | 0 | 0 | 0 | 7/8.3 | 4.8 | 1.5 | 0.022 | 0 | 0 (0) | 0/6 (0/6) | 156 (+94) | 16.3 | 14.4 | 2.88 | 0 | supported |
| 10 | 5 | 537/2233 |  | 0 | 0 | 0 | 6.6/7.7 | 5.6 | 1.6 | 0.044 | 0.156 | 0 (0) | 0/6 (0/6) | 166 (+133) | 17.9 | 33 | 3.3 | 0 | supported |
| 15 | 8 | 738/2237 |  | 0 | 0 | 0 | 7/9 | 4.6 | 2.3 | 0.064 | 0.169 | 1.2 (1) | 0/6 (0/6) | 181 (+127) | 19.8 | 59.2 | 3.95 | 0 | supported |
| 20 | 10 | 615/2041 |  | 0 | 0 | 0 | 5.8/7.9 | 7 | 1.8 | 0.079 | 0.179 | 0.9 (1) | 0/6 (0/6) | 190 (+232) | 18.5 | 64.9 | 3.24 | 0 | supported |
| 25 | 13 | 837/1675 |  | 0 | 0 | 0 | 5.9/8.2 | 12.5 | 2.4 | 0.118 | 0.309 | 4.2 (2) | 2/6 (2/6) | 233 (+244) | 21 | 87.8 | 3.51 | 0 | supported |
| 30 | 15 | 751/2189 |  | 0 | 0 | 0 | 6.3/9.4 | 10.5 | 2.3 | 0.132 | 0.368 | 2.7 (1) | 1/6 (1/6) | 251 (+631) | 21.1 | 106.7 | 3.56 | 0 | supported |
| 40 | 20 | 742/2320 |  | 1.14 | 0 | 0 | 7.9/867.7 | 114.3 | 10.2 | 0.226 | 0.84 | 4.9 (3) | 3/6 (3/6) | 267 (+382) | 28.2 | 143.6 | 3.59 | 0 | **no**: 1.14 % late segments > 1; API p99 867.7 ms > 300 |
| 60 | 30 | 1015/5945 |  | 6.18 | 0 | 0 | 361.5/1635.5 | 2139.9 | 554.8 | 0.42 | 2.302 | 12.3 (5) | 5/6 (5/6) | 341 (+586) | 43.7 | 214.9 | 3.58 | 0 | **no**: burst TTFF p95 5945 ms > 4000; 6.18 % late segments > 1; API p99 1635.5 ms > 300 |
