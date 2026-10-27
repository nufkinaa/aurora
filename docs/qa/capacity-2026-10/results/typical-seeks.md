### typical — 6638195@66381959 — 2026-10-27T02:05:40.974Z

typical (house-recorded): 30 % direct, 55 % repackaged (TV offset copy, web/phone jit copy), 10 % encoded (720p/480p rungs), 5 % torrent; TVs 55 %, phones 25 %, desktops 20 %. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 672/1288 |  | 0 | 0 | 0 | 7.7/9.4 | 3.8 | 2.1 | 0.034 | 0.121 | 0 (0) | 0/5 (0/6) | 146 (+92) | 18.1 | 22.9 | 4.58 | 0 | supported |
| 10 | 5 | 553/1375 | 964 | 0 | 0 | 0 | 7.5/14 | 3.5 | 1.8 | 0.053 | 0.365 | 0 (0) | 0/6 (0/6) | 176 (+126) | 19.9 | 36.7 | 3.67 | 0 | supported |
| 15 | 8 | 951/1399 | 107 | 0 | 0 | 0 | 6.9/9.4 | 4.3 | 2.4 | 0.09 | 0.264 | 0.6 (1) | 0/6 (0/6) | 177 (+168) | 20.1 | 67.8 | 4.52 | 0 | supported |
| 20 | 10 | 646/2133 |  | 0 | 0 | 0 | 6.3/10 | 44.2 | 1.9 | 0.107 | 0.31 | 0.6 (1) | 0/6 (0/6) | 210 (+200) | 19.9 | 88.4 | 4.42 | 0 | supported |
| 25 | 13 | 752/2784 |  | 0 | 0 | 0 | 5.6/8 | 10.6 | 2.2 | 0.123 | 0.392 | 0.9 (1) | 0/6 (0/6) | 221 (+303) | 21.3 | 98.2 | 3.93 | 0 | supported |
| 30 | 15 | 941/4526 | 1070 | 0 | 0 | 0.012 | 6.2/9.1 | 8.1 | 2.7 | 0.157 | 0.646 | 0.9 (1) | 1/6 (1/6) | 235 (+342) | 24.1 | 130 | 4.33 | 0 | **no**: burst TTFF p95 4526 ms > 4000 |
