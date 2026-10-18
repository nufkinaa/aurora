# ramp — master@4862136f — evening

2026-10-18T10:58:20.268Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **full**, media gen: 303 films, 10 shows. evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evening n=4 | 4 | 3 | 0.2 | 11.5/31.5/81.8 | 31.5/31.4 |  |  | 311/466 | 0 (0) | 13/5/3 | 1779 | 1966.62 | 89.1 | 0.10876999999999999 | 0.061 | 0.042 | 119 | 319 | 102.9 | 419.4 | 0/0/0/0 | 100/8518 (PC starved) | 0.033 | 28.5/23.48 | **degraded**: 1 event-loop stall(s) > 1 s; loop stalled 3558 ms (> 2 % of the window) |
| evening n=8 | 8 | 4 | 1.3 | 7.5/482.9/1392.6 | 376.5/169.52 |  |  | 309/466 | 0 (0) | 269/73/9 | 15869 | 4735.93 | 1029.2 | 0.25556 | 0.064 | 0.007 | 119 | 342 | 112.6 | 514.9 | 0/0/0/0 | 99.9/6195 (PC starved) | 0.032 | 16.4/10.09 | **degraded**: browse p99 1392.6 ms > 1000; 2 event-loop stall(s) > 1 s; loop stalled 32056 ms (> 2 % of the window) |
| evening n=16 | 16 | 8 | 2 | 10.3/57.4/140.4 | 124.3/95.15 |  |  | 114/466 | 0 (0) | 38/8/1 | 1935 | 1094.01 | 68.1 | 0.24980000000000002 | 0.163 | 0.015 | 135 | 385 | 293.7 | 554.8 | 0/0/0/0 | 100/10499 (PC starved) | 0.089 | 6.2/7.73 | **degraded**: 1 event-loop stall(s) > 1 s; loop stalled 3870 ms (> 2 % of the window) |
| evening n=32 | 32 | 16 | 7.1 | 10.2/67.8/152.1 | 53/36.16 |  |  | 202/677 | 0 (0) | 39/16/5 | 2903 | 673.64 | 164.1 | 0.38124 | 0.297 | 0.015 | 172 | 486 | 596.5 | 1141 | 0/0/0/0 | 100/10570 (PC starved) | 0.164 | 33.9/2.15 | **degraded**: loop stalled 5806 ms (> 2 % of the window) |
| evening n=48 | 48 | 24 | 10.2 | 5.8/31.4/101.6 | 82.8/68.61 |  |  | 202/677 | 0 (0) | 18/6/0 | 795 | 209.84 | 49.6 | 0.29043 | 0.35 | 0.013 | 182 | 576 | 657.5 | 1491.1 | 0/0/0/0 | 97.8/6758 (PC starved) | 0.174 | 9.8/6.44 | ok |

Requests in the last window (evening n=48), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress | 576 | 4.8 | 2 | 17.8 | 49.5 | 336.7 | 0 | 0 |
| suggest | 335 | 2.79 | 4 | 18.9 | 38.5 | 64.5 | 0.4 | 0 |
| search | 291 | 2.42 | 8.1 | 31.8 | 102.7 | 269.4 | 1.3 | 0 |
| image | 166 | 1.38 | 11.9 | 31.4 | 75.7 | 118.6 | 44.2 | 0 |
| telemetry | 162 | 1.35 | 2.2 | 20 | 52 | 67.6 | 0 | 0 |
| api-other | 143 | 1.19 | 4.8 | 66.4 | 270 | 302.8 | 0.1 | 0 |
| grid | 69 | 0.57 | 7 | 56.4 | 162.1 | 162.1 | 0 | 0 |
| title | 63 | 0.52 | 2.8 | 13.6 | 341.1 | 341.1 | 0.5 | 0 |
| home | 46 | 0.38 | 18.8 | 73.4 | 82.8 | 82.8 | 4.9 | 0 |
| state | 37 | 0.31 | 1.3 | 6 | 8 | 8 | 0.1 | 0 |
| boot | 37 | 0.31 | 2.4 | 7.5 | 9.9 | 9.9 | 0.1 | 0 |
| title-offline | 26 | 0.22 | 3 | 11 | 67.9 | 67.9 | 0 | 26 (502:26) |
| library | 25 | 0.21 | 2.6 | 37.5 | 143 | 143 | 10.1 | 0 |
| netprobe | 14 | 0.12 | 2.7 | 14.9 | 14.9 | 14.9 | 48 | 0 |
| tv | 9 | 0.07 | 4.3 | 93.3 | 93.3 | 93.3 | 0.1 | 0 |
| direct | 1 | 0.01 | 22.2 | 22.2 | 22.2 | 22.2 | 478805.8 | 0 |
| direct-first-byte | 1 | 0.01 | 12 | 12 | 12 | 12 | 0 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| progress | 575 | 1.09 | 2.5 | 7.56 | 19.82 |
| health | 570 | 0.9 | 2.59 | 4.84 | 39.21 |
| suggest | 335 | 2.48 | 11.03 | 23.58 | 32.22 |
| search | 291 | 5.53 | 21.8 | 71.34 | 118.95 |
| api-other | 266 | 1.36 | 8.55 | 17.88 | 28.26 |
| image | 166 | 7.84 | 20.88 | 40.37 | 51.17 |
| telemetry | 159 | 1.21 | 2.79 | 6.21 | 10.85 |
| title | 89 | 2.17 | 4.75 | 32.78 | 32.78 |
| home | 46 | 18.47 | 42.27 | 68.61 | 68.61 |
| state | 37 | 0.73 | 1.18 | 1.2 | 1.2 |
| library | 25 | 0.99 | 10.84 | 19.13 | 19.13 |
| tv | 9 | 1.42 | 13.97 | 13.97 | 13.97 |
| direct | 1 | 431409.41 | 431409.41 | 431409.41 | 431409.41 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-direct | Lt Direct Eight | 110 | 0 | 0 |  | 9.37 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 101 | 0 | 0 |  | 4.27 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 107 | 0 | 0 |  | 15.01 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 329 | 0 | 0 |  | 15.11 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 219 | 0 | 0 |  | 9.45 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 309 | 0 | 0 |  | 25.55 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 115 | 0 | 0 |  | 9.48 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 514 | 0 | 0 |  | 25.49 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 329 | 0 | 0 |  | 8.01 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 677 | 0 | 0 |  | 15.11 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 424 | 0 | 0 |  | 8 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 202 | 0 | 0 |  | 16.01 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 105 | 0 | 0 |  | 8.02 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 201 | 0 | 0 |  | 25.69 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 118 | 0 | 0 |  | 9.42 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 114 | 0 | 0 |  | 15.11 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 102 | 0 | 0 |  | 25.42 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 167 | 0 | 0 |  | 8.14 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 245 | 0 | 0 |  | 4.7 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 302 | 0 | 0 |  | 25.38 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 357 | 0 | 0 |  | 15.13 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 252 | 0 | 0 |  | 4.69 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 200 | 0 | 0 |  | 8.16 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 550 | 0 | 0 |  | 15.13 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 101 | 0 | 0 |  | 8.29 | 0 | 0 | playing |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/profiles.json | 72 | 1968.5 |
| data/watch-sessions.json | 72 | 710.2 |
| data/intro-auto.json | 12 | 166.9 |
| data/sessions.json | 4 | 96 |
| data/usage/* | 64 | 37.2 |
| data/healer.json | 2 | 2.5 |
| data/watch-history.json | 1 | 0.5 |
| data/telemetry-hours.json | 4 | 0.4 |
