### typical — 6638195@66381959 — 2026-10-26T20:34:58.802Z

typical (house-recorded): 30 % direct, 55 % repackaged (TV offset copy, web/phone jit copy), 10 % encoded (720p/480p rungs), 5 % torrent; TVs 55 %, phones 25 %, desktops 20 %. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 645/2018 |  | 0 | 0 | 0 | 7.3/8.6 | 5.2 | 2.1 | 0.024 | 0.112 | 0 (0) | 0/5 (0/6) | 157 (+100) | 22.5 | 20 | 4 | 0 | supported |
| 10 | 5 | 652/2470 |  | 0 | 0 | 0 | 7.3/9.2 | 73.9 | 2.3 | 0.04 | 0.059 | 0 (0) | 0/5 (0/6) | 169 (+129) | 23.1 | 38.6 | 3.86 | 0 | supported |
| 15 | 8 | 752/1696 |  | 0 | 0 | 0 | 7.6/153.8 | 69.7 | 20 | 0.065 | 0.231 | 1.2 (1) | 1/5 (1/6) | 186 (+234) | 20.2 | 49.7 | 3.31 | 0 | supported |
| 20 | 10 | 1193/12291 |  | 0 | 0 | 0 | 7.5/179.4 | 267.4 | 101.8 | 0.11 | 0.336 | 1.6 (1) | 1/6 (1/6) | 220 (+243) | 21.4 | 72.9 | 3.64 | 0 | **no**: burst TTFF p95 12291 ms > 4000 |
| 25 | 13 | 950/1826 |  | 0 | 0 | 0 | 6.6/11.8 | 64.3 | 2.6 | 0.095 | 0.106 | 1.2 (1) | 1/6 (1/6) | 229 (+255) | 18.9 | 84 | 3.36 | 0 | supported |
| 30 | 15 | 750/4584 |  | 0 | 0 | 0 | 7.7/199.5 | 53.5 | 118 | 0.134 | 0.291 | 2.8 (1) | 0/6 (0/6) | 247 (+274) | 23.7 | 99.4 | 3.31 | 0 | **no**: burst TTFF p95 4584 ms > 4000 |
