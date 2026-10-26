### typical — 6638195@66381959 — 2026-10-26T14:28:12.354Z

typical (house-recorded): 30 % direct, 55 % repackaged (TV offset copy, web/phone jit copy), 10 % encoded (720p/480p rungs), 5 % torrent; TVs 55 %, phones 25 %, desktops 20 %. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 416/538 |  | 0 | 0 | 0 | 11.1/13.6 | 4.6 | 3.8 | 0.027 | 0.039 | 0 (4) | 0/3 (0/6) | 144 (+94) | 44.3 | 18.5 | 3.71 | 0 | supported |
| 10 | 5 | 525/858 |  | 0 | 0 | 0 | 8.4/11.5 | 15 | 4.3 | 0.054 | 0.143 | 0.1 (0) | 0/4 (0/6) | 156 (+135) | 44.7 | 36.3 | 3.63 | 0 | supported |
| 15 | 8 | 539/1590 |  | 0 | 0 | 0 | 10/17.8 | 9 | 3.6 | 0.074 | 0.27 | 1.1 (1) | 1/4 (1/6) | 175 (+163) | 48 | 60.4 | 4.03 | 0 | supported |
| 20 | 10 | 2757/6364 |  | 0 | 0 | 0 | 8.6/13.2 | 31.1 | 4.3 | 0.098 | 0.41 | 0 (1) | 1/4 (0/6) | 227 (+198) | 50.5 | 70.8 | 3.54 | 1 | **no**: burst TTFF p95 6364 ms > 4000; refused: 0 never started, 1 stream refusals, 0 × 429 |
| 30 | 15 | 4266/33272 |  | 0 | 0 | 0 | 8.1/13 | 171.7 | 4.9 | 0.135 | 0.328 | 1 (7) | 0/4 (0/6) | 256 (+271) | 39 | 93.9 | 3.13 | 0 | **no**: burst TTFF p95 33272 ms > 4000 |
