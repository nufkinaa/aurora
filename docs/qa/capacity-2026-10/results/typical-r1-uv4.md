### typical — 6638195@66381959 — 2026-10-26T17:54:29.847Z

typical (house-recorded): 30 % direct, 55 % repackaged (TV offset copy, web/phone jit copy), 10 % encoded (720p/480p rungs), 5 % torrent; TVs 55 %, phones 25 %, desktops 20 %. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 536/1290 |  | 0 | 0 | 0 | 6.6/9.5 | 5.3 | 2.6 | 0.025 | 0.033 | 0 (0) | 0/5 (0/6) | 159 (+93) | 17.7 | 17.3 | 3.47 | 0 | supported |
| 10 | 5 | 655/3112 |  | 0 | 0 | 0 | 7.4/9.7 | 5.1 | 2.4 | 0.046 | 0.186 | 3.1 (1) | 1/6 (1/6) | 166 (+128) | 19.9 | 32.2 | 3.22 | 0 | supported |
| 15 | 8 | 756/1796 |  | 0 | 0 | 0 | 7.1/8.7 | 18.8 | 2.2 | 0.054 | 0.122 | 1.4 (1) | 1/6 (1/6) | 191 (+166) | 19.8 | 45.9 | 3.06 | 0 | supported |
| 20 | 10 | 737/2427 |  | 0 | 0 | 0 | 6.5/9.3 | 129.4 | 2.1 | 0.086 | 0.172 | 3.5 (1) | 1/6 (1/6) | 193 (+238) | 19.9 | 77.3 | 3.87 | 0 | supported |
| 25 | 13 | 12183/16523 |  | 1.23 | 0 | 0 | 636.6/14339.2 | 1305.6 | 384.2 | 0.115 | 0.405 | 2.8 (1) | 1/6 (1/6) | 214 (+304) | 22 | 85.3 | 3.41 | 0 | **no**: burst TTFF p95 16523 ms > 4000; 1.23 % late segments > 1; API p99 14339.2 ms > 300 |
| 30 | 15 | 3962/7875 |  | 0.63 | 0 | 0 | 129.5/1277.7 | 212.6 | 301.3 | 0.161 | 0.675 | 1.2 (1) | 1/6 (1/6) | 248 (+373) | 25.8 | 112.4 | 3.75 | 0 | **no**: burst TTFF p95 7875 ms > 4000; API p99 1277.7 ms > 300 |
