# ramp — master@4862136f — streams

2026-10-18T13:06:51.020Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **full**, media gen: 303 films, 10 shows. streams heavy: n streams on devices of their own (10 % encoded), 4 households browsing beside them

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | API p95/p99 | pictures p95/p99 | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| streams n=2 | 4 | 2 | 0.7 | 3.6/16.4/25.1 | 16.4/25.1 | 17.3/17.3 | 25.1/25.07 |  |  | 102/120 | 0 (0) | 0/0/0 | 0 | 39.1 | 7.4 | 0.02705 | 0.039 | 0 | 96 | 316 | 76.2 | 39.5 | 0/0/0/0 | 63.5/9125 | 0.02 | 4.9/4.93 | ok |
| streams n=4 | 4 | 4 | 1.2 | 8.3/20.4/26.9 | 15.2/20 | 26.9/27.7 | 14.9/14.32 |  |  | 106/202 | 0 (0) | 0/0/0 | 0 | 49.82 | 11.3 | 0.054340000000000006 | 0.065 | 0.009 | 125 | 331 | 149.8 | 58.1 | 0/0/0/0 | 75.5/8767 | 0.039 | 4.6/5.51 | ok |
| streams n=8 | 4 | 8 | 0.5 | 7.3/25.7/27.2 | 25.7/27.2 | 20.5/20.5 | 27.1/26.84 |  |  | 108/202 | 0 (0) | 5/0/0 | 134 | 61.75 | 29.7 | 0.11 | 0.105 | 0 | 132 | 343 | 302.1 | 131 | 0/0/0/0 | 78.5/8341 | 0.069 | 6.7/6.71 | ok |
| streams n=12 | 4 | 12 | 1 | 5.2/18.8/63.6 | 29.7/63.6 | 8/8 | 51.1/52.35 |  |  | 103/202 | 0 (0) | 2/2/0 | 108 | 115.61 | 14.5 | 0.15269 | 0.186 | 0 | 145 | 359 | 555.2 | 287.2 | 0/0/0/0 | 74.9/7960 | 0.111 | 5.6/6.94 | ok |
| streams n=24 | 4 | 24 | 0.6 | 3/271.5/332.2 | 264.6/315.7 | 332.2/332.2 | 16.7/16.89 |  |  | 111/214 | 0 (0) | 13/13/11 | 3482 | 1165.62 | 385.1 | 0.15422 | 0.189 | 0 | 153 | 407 | 849.3 | 444.8 | 0/0/0/0 | 49.6/9329 | 0.12 | 24.9/1.81 | **degraded**: 1 event-loop stall(s) > 1 s; loop stalled 6963 ms (> 2 % of the window) |

Requests in the last window (streams n=24), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress | 576 | 4.8 | 1.1 | 122 | 800.2 | 1179.8 | 0 | 0 |
| suggest | 20 | 0.17 | 1.7 | 264.6 | 313 | 313 | 0.5 | 0 |
| search | 18 | 0.15 | 4.3 | 315.7 | 315.7 | 315.7 | 1.3 | 0 |
| telemetry | 13 | 0.11 | 1.4 | 7.7 | 7.7 | 7.7 | 0 | 0 |
| grid | 8 | 0.07 | 4 | 19.9 | 19.9 | 19.9 | 0 | 0 |
| api-other | 6 | 0.05 | 1.1 | 11.7 | 11.7 | 11.7 | 0.2 | 0 |
| title | 5 | 0.04 | 1.9 | 8.9 | 8.9 | 8.9 | 0.6 | 0 |
| image | 5 | 0.04 | 3.2 | 332.2 | 332.2 | 332.2 | 44 | 0 |
| library | 4 | 0.03 | 1.5 | 10.4 | 10.4 | 10.4 | 10.1 | 0 |
| state | 2 | 0.02 | 0.9 | 1.2 | 1.2 | 1.2 | 0.2 | 0 |
| boot | 2 | 0.02 | 1.7 | 2.4 | 2.4 | 2.4 | 0.1 | 0 |
| title-offline | 2 | 0.02 | 2.2 | 4 | 4 | 4 | 0 | 2 (502:2) |
| tv | 2 | 0.02 | 5.2 | 9.5 | 9.5 | 9.5 | 0.1 | 0 |
| home | 1 | 0.01 | 16.7 | 16.7 | 16.7 | 16.7 | 6.3 | 0 |
| direct | 1 | 0.01 | 4 | 4 | 4 | 4 | 244722.9 | 0 |
| direct-first-byte | 1 | 0.01 | 2 | 2 | 2 | 2 | 0 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| progress | 576 | 0.63 | 1.29 | 2.04 | 2.45 |
| health | 544 | 0.54 | 1.37 | 1.81 | 3.46 |
| suggest | 20 | 0.74 | 4.06 | 4.12 | 4.12 |
| api-other | 18 | 0.96 | 4.21 | 4.21 | 4.21 |
| search | 18 | 3.05 | 7.04 | 7.04 | 7.04 |
| telemetry | 11 | 0.93 | 1.43 | 1.43 | 1.43 |
| title | 7 | 1.35 | 3.22 | 3.22 | 3.22 |
| image | 5 | 2.87 | 331.99 | 331.99 | 331.99 |
| library | 4 | 0.74 | 9.63 | 9.63 | 9.63 |
| state | 2 | 0.61 | 0.95 | 0.95 | 0.95 |
| tv | 2 | 0.73 | 1.95 | 1.95 | 1.95 |
| home | 1 | 16.89 | 16.89 | 16.89 | 16.89 |
| direct | 1 | 141417.06 | 141417.06 | 141417.06 | 141417.06 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-direct | Lt Direct Eight | 116 | 0 | 0 |  | 9.28 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 125 | 0 | 0 |  | 29.24 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 108 | 0 | 0 |  | 9.28 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 100 | 0 | 0 |  | 7.96 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 109 | 0 | 0 |  | 9.3 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 111 | 0 | 0 |  | 29.31 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 103 | 0 | 0 |  | 25.17 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 100 | 0 | 0 |  | 7.96 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 101 | 0 | 0 |  | 25.1 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 119 | 0 | 0 |  | 29.31 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 100 | 0 | 0 |  | 25.12 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 100 | 0 | 0 |  | 7.96 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 111 | 0 | 0 |  | 29.32 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 111 | 0 | 0 |  | 8.76 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 111 | 0 | 0 |  | 9.28 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 118 | 0 | 0 |  | 29.24 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 101 | 0 | 0 |  | 7.96 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 100 | 0 | 0 |  | 7.98 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 115 | 0 | 0 |  | 29.28 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 118 | 0 | 0 |  | 9.28 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 201 | 0 | 0 |  | 25.26 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 214 | 0 | 0 |  | 25.24 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 201 | 0 | 0 |  | 25.23 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 99 | 0 | 0 |  | 7.97 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 110 | 0 | 0 |  | 7.93 | 0 | 0 | playing |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/watch-sessions.json | 69 | 674.9 |
| data/profiles.json | 69 | 206.8 |
| data/usage/* | 17 | 4.4 |
| data/healer.json | 2 | 2.5 |
| data/telemetry-hours.json | 4 | 0.9 |