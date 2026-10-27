### typical — 81d142b@81d142b9 — 2026-10-26T23:08:18.772Z

typical (house-recorded): 30 % direct, 55 % repackaged (TV offset copy, web/phone jit copy), 10 % encoded (720p/480p rungs), 5 % torrent; TVs 55 %, phones 25 %, desktops 20 %. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 644/2033 |  | 0 | 0 | 0 | 7/8.6 | 5.3 | 1.8 | 0.03 | 0.08 | 0 (0) | 0/5 (0/6) | 148 (+97) | 17.8 | 22.5 | 4.49 | 0 | supported |
| 10 | 5 | 960/1506 |  | 0 | 0 | 0 | 6.9/8.5 | 5.6 | 1.7 | 0.046 | 0.156 | 2.5 (1) | 0/6 (0/6) | 176 (+131) | 18.5 | 36.9 | 3.69 | 0 | supported |
| 15 | 8 | 843/1505 |  | 0 | 0 | 0 | 6.5/8.5 | 6.1 | 2.1 | 0.063 | 0.192 | 3.3 (1) | 1/6 (1/6) | 174 (+136) | 19.6 | 45 | 3 | 0 | supported |
| 20 | 10 | 645/2186 |  | 0 | 0 | 0 | 6.5/8.1 | 9.1 | 1.9 | 0.078 | 0.101 | 0.6 (1) | 1/6 (1/6) | 207 (+197) | 18.1 | 70.2 | 3.51 | 0 | supported |
| 25 | 13 | 736/2149 |  | 0 | 0 | 0 | 6.4/8.2 | 94 | 1.9 | 0.113 | 0.205 | 1.5 (1) | 1/6 (1/6) | 230 (+296) | 19.6 | 87.6 | 3.51 | 0 | supported |
| 30 | 15 | 854/2409 |  | 0 | 0 | 0 | 6.6/10.6 | 23.9 | 2.4 | 0.144 | 0.395 | 1.3 (1) | 0/6 (0/6) | 242 (+716) | 22.2 | 109 | 3.63 | 0 | supported |
| 40 | 20 | 828/2113 |  | 0 | 0 | 0 | 9.3/71.6 | 106.7 | 33.3 | 0.258 | 1.338 | 2.5 (2) | 2/6 (2/6) | 278 (+439) | 30.5 | 126.2 | 3.15 | 0 | supported |
| 60 | 30 | 1429/5203 |  | 3.59 | 0 | 0 | 242.5/1067.6 | 2284.3 | 637.2 | 0.392 | 1.747 | 5.8 (4) | 2/6 (2/6) | 328 (+628) | 37.2 | 236.2 | 3.94 | 0 | **no**: burst TTFF p95 5203 ms > 4000; 3.59 % late segments > 1; API p99 1067.6 ms > 300 |
