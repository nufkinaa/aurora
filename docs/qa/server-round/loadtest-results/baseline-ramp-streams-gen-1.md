# ramp — master@4862136f — streams

2026-10-18T09:59:41.235Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **full**, media gen: 303 films, 10 shows. streams heavy: n streams (10 % encoded), a few people browsing

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| streams n=4 | 3 | 4 | 0 | null/null/null | / | 671.7 |  | 110/545 | 0 (0) | 43/18/2 | 4279 | 3615.39 | 247.5 | 0.09469 | 0.048 | 0.028 | 102 | 307 | 90.3 | 93.6 | 0/0/0/0 | 88.7/7130 (PC starved) | 0.029 | 7.2/5.85 | **degraded**: 1 event-loop stall(s) > 1 s; loop stalled 8558 ms (> 2 % of the window) |
| streams n=8 | 3 | 8 | 0 | 12.2/14.2/14.2 | / | 3327.3 |  | 114/12256 | 2 (68.4) | 86/44/17 | 16170 | 6432.84 | 2259 | 0.38047000000000003 | 0.082 | 0.173 | 107 | 323 | 227.6 | 99.4 | 0/0/0/0 | 84.7/5421 | 0.055 | 54.3/17.38 | **degraded**: 2 stall(s) in 9 viewers; 7 event-loop stall(s) > 1 s; loop stalled 32421 ms (> 2 % of the window) |
| streams n=12 | 4 | 12 | 0 | null/null/null | / | 61.9 | 59 | 114/12256 | 0 (0) | 7/4/2 | 757 | 533.56 | 23.3 | 0.10976000000000001 | 0.126 | 0.576 | 121 | 332 | 346.9 | 164.4 | 0/0/0/0 | 88.5/6977 (PC starved) | 0.081 | 28.7/12.56 | ok |
| streams n=16 | 6 | 16 | 0 | 7.1/8.2/8.2 | / | 503.9 | 1804 | 109/12256 | 0 (0) | 49/17/5 | 3387 | 1149.11 | 207.7 | 0.2728 | 0.203 | 0.33 | 115 | 352 | 546.7 | 287.7 | 0/0/0/0 | 97.7/5937 (PC starved) | 0.118 | 13.4/12.44 | **degraded**: 1 event-loop stall(s) > 1 s; loop stalled 6773 ms (> 2 % of the window) |
| streams n=24 | 6 | 24 | 0 | 16.1/26.8/26.8 | / | 1095.7 | 1135 | 500/12256 | 3 (38.8) | 280/60/2 | 12876 | 1510.54 | 206.2 | 0.58947 | 0.269 | 0.082 | 140 | 375 | 728.5 | 245.5 | 0/0/0/0 | 100/4020 (PC starved) | 0.167 | 11.4/20.03 | **degraded**: 3 stall(s) in 29 viewers; 1 event-loop stall(s) > 1 s; loop stalled 25751 ms (> 2 % of the window) |
| streams n=32 | 6 | 32 | 0 | 8.1/9.9/9.9 | / | 252.1 | 20 | 302/12256 | 0 (0) | 27/14/3 | 2058 | 778.24 | 175.9 | 0.29111000000000004 | 0.326 | 0.047 | 146 | 380 | 818.9 | 343.9 | 0/0/0/0 | 100/2027 (PC starved) | 0.192 | 34/25.47 | **degraded**: loop stalled 4116 ms (> 2 % of the window) |

Requests in the last window (streams n=32), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress | 767 | 6.39 | 4.2 | 101.4 | 226.5 | 725.3 | 0 | 0 |
| segment | 423 | 3.52 | 16.6 | 252.1 | 959.2 | 1443.2 | 3419.4 | 0 |
| telemetry | 6 | 0.05 | 3.9 | 6.2 | 6.2 | 6.2 | 0 | 0 |
| playlist | 2 | 0.02 | 2.9 | 4.1 | 4.1 | 4.1 | 11 | 0 |
| stream-other | 1 | 0.01 | 2.1 | 2.1 | 2.1 | 2.1 | 0 | 0 |
| title | 1 | 0.01 | 8.1 | 8.1 | 8.1 | 8.1 | 0.9 | 0 |
| tv | 1 | 0.01 | 9.9 | 9.9 | 9.9 | 9.9 | 0.1 | 0 |
| first-segment | 1 | 0.01 | 20 | 20 | 20 | 20 | 0 | 0 |
| direct | 1 | 0.01 | 24.7 | 24.7 | 24.7 | 24.7 | 580370.6 | 0 |
| direct-first-byte | 1 | 0.01 | 10 | 10 | 10 | 10 | 0 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| progress | 766 | 0.94 | 2.41 | 6.03 | 60.11 |
| health | 561 | 0.87 | 2.47 | 4.77 | 8.95 |
| segment | 423 | 16.34 | 242.82 | 939.6 | 1404.54 |
| api-other | 6 | 1.62 | 2.08 | 2.08 | 2.08 |
| playlist | 2 | 2.6 | 3.77 | 3.77 | 3.77 |
| stream-other | 1 | 1.44 | 1.44 | 1.44 | 1.44 |
| title | 1 | 2.19 | 2.19 | 2.19 | 2.19 |
| tv | 1 | 1.44 | 1.44 | 1.44 | 1.44 |
| direct | 1 | 497059.84 | 497059.84 | 497059.84 | 497059.84 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-offset | Lt Remux Ac3 | 12256 | 0 | 0 |  | 0.11 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 102 | 0 | 0 |  | 2.87 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 100 | 0 | 0 |  | 7.98 | 0 | 0 | playing |
| tv-offset | Lt Remux Ac3 | 106 | 0 | 0 |  | 7.65 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 107 | 0 | 0 |  | 29.48 | 0 | 0 | playing |
| web-jit | Lt Remux Ac3 | 500 | 0 | 0 |  | 6.4 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 109 | 0 | 0 |  | 29.49 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 99 | 0 | 0 |  | 13.89 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 348 | 0 | 0 |  | 4.11 | 0 | 0 | playing |
| web-jit | Lt Remux Ac3 | 2358 | 0 | 0 |  | 6.4 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 2257 | 0 | 0 |  | 8.13 | 0 | 0 | playing |
| web-jit | Lt Remux Ac3 | 3412 | 0 | 0 |  | 6.4 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 2133 | 0 | 0 |  | 8.12 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 3043 | 0 | 0 |  | 14.06 | 0 | 0 | playing |
| web-transcode | Lt Remux Ac3 | 2544 | 0 | 0 |  | 6.4 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 1741 | 0 | 0 |  | 8.12 | 0 | 0 | playing |
| web-jit | Lt Remux Ac3 | 2329 | 0 | 0 |  | 6.4 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 1676 | 0 | 0 |  | 14.02 | 0 | 0 | playing |
| web-jit | Lt Remux Ac3 | 1169 | 0 | 0 |  | 6.41 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 839 | 0 | 0 |  | 25.37 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 139 | 0 | 0 |  | 9.38 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 119 | 0 | 0 |  | 9.44 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 432 | 0 | 0 |  | 25.41 | 0 | 0 | playing |
| web-transcode | Lt Direct Heavy | 1324 | 0 | 0 |  | 25.57 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 100 | 0 | 0 |  | 25.34 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 100 | 0 | 0 |  | 8.08 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 201 | 0 | 0 |  | 25.41 | 0 | 0 | playing |
| web-offset | Lt Remux Ac3 | 200 | 0 | 0 |  | 7.66 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 201 | 0 | 0 |  | 8.07 | 0 | 0 | playing |
| web-jit | Lt Remux Ac3 | 414 | 0 | 0 |  | 6.4 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 302 | 0 | 0 |  | 25.32 | 0 | 0 | playing |
| web-transcode | Lt Direct Eight | 208 | 0 | 0 |  | 2.59 | 0 | 0 | playing |
| tv-offset | Lt Remux Ac3 | 112 | 0 | 0 |  | 10.33 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 107 | 0 | 0 |  | 12.19 | 0 | 0 | playing |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/watch-sessions.json | 48 | 363.6 |
| data/profiles.json | 70 | 309.9 |
| data/sessions.json | 3 | 9 |
| data/healer.json | 2 | 3.3 |
| data/usage/* | 1 | 0.8 |
| data/watch-history.json | 1 | 0.7 |
| data/telemetry-hours.json | 4 | 0.4 |
