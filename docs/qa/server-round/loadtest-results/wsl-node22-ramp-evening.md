# ramp — master@4862136f — evening

2026-10-18T10:42:13.809Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 16 GB), Node v22.13.1, machine profile **full**, media /home/elia/aurora-lt/media: 303 films, 10 shows. evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evening n=4 | 4 | 3 | 0.3 | 5.1/46.9/47.8 | 47.8/48.83 |  |  | 111/217 | 0 (0) | 6/3/0 | 292 | 174.97 | 15.5 | 0.07651999999999999 | 0.162 | 0 | 156 | 46 | 98.5 | 216.2 | 0/0/0/0 | 1.1/15100 | 0.039 |  | ok |
| evening n=8 | 8 | 4 | 1 | 3.1/58.4/108.9 | 51.3/50.49 |  |  | 111/217 | 0 (0) | 21/15/5 | 2755 | 1335.09 | 122 | 0.13491 | 0.164 | 0 | 177 | 71 | 152.6 | 506.7 | 0/0/0/0 | 1.2/15061 | 0.049 |  | **degraded**: 1 event-loop stall(s) > 1 s; loop stalled 5509 ms (> 2 % of the window) |
| evening n=16 | 16 | 8 | 2.5 | 5.7/56.8/103.2 | 83.3/83.12 |  |  | 143/238 | 0 (0) | 53/19/3 | 2945 | 469.33 | 105 | 0.20544 | 0.364 | 0 | 192 | 118 | 308.1 | 524.4 | 0/0/0/0 | 2.2/15005 | 0.103 |  | **degraded**: loop stalled 5891 ms (> 2 % of the window) |
| evening n=32 | 32 | 16 | 5.1 | 5.6/55.1/129.1 | 129.1/71.72 |  |  | 205/509 | 0 (0) | 77/30/2 | 4798 | 2080.83 | 131.2 | 0.3328 | 0.563 | 0 | 225 | 205 | 569 | 1147.9 | 0/0/0/0 | 3.5/14872 | 0.191 |  | **degraded**: 1 event-loop stall(s) > 1 s; loop stalled 9596 ms (> 2 % of the window) |
| evening n=48 | 48 | 24 | 7.6 | 4.1/38.3/206.1 | 338.9/29.46 |  |  | 205/509 | 0 (0) | 28/15/7 | 2622 | 603.85 | 184.6 | 0.32786000000000004 | 0.472 | 0 | 236 | 294 | 836.2 | 1372.8 | 0/2/0/0 | 3.8/14779 | 0.231 |  | **degraded**: loop stalled 5244 ms (> 2 % of the window) |

Requests in the last window (evening n=48), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress | 575 | 4.79 | 1.9 | 37.2 | 205.9 | 448 | 0 | 0 |
| suggest | 200 | 1.67 | 3.7 | 31.5 | 118.9 | 440.9 | 0.3 | 0 |
| telemetry | 168 | 1.4 | 2.4 | 41.9 | 184.4 | 326.4 | 0 | 0 |
| search | 161 | 1.34 | 6.4 | 55.6 | 285.1 | 443.9 | 1 | 0 |
| api-other | 110 | 0.92 | 3.4 | 46.3 | 50.5 | 273.6 | 0.1 | 0 |
| grid | 103 | 0.86 | 7.2 | 42.8 | 216.7 | 274.2 | 0 | 2 (0:2) |
| image | 89 | 0.74 | 1.7 | 12.2 | 34.5 | 34.5 | 0 | 89 (404:89) |
| title | 73 | 0.61 | 2.1 | 27.8 | 155.5 | 155.5 | 0.4 | 0 |
| state | 42 | 0.35 | 1.4 | 11.5 | 14.1 | 14.1 | 0.2 | 0 |
| boot | 42 | 0.35 | 2.2 | 12.9 | 14.9 | 14.9 | 0.1 | 0 |
| home | 41 | 0.34 | 20.1 | 43.5 | 338.9 | 338.9 | 3.9 | 0 |
| library | 33 | 0.28 | 2.1 | 20.6 | 204.6 | 204.6 | 9.3 | 0 |
| title-offline | 28 | 0.23 | 3.5 | 15.8 | 22.1 | 22.1 | 0 | 28 (502:28) |
| tv | 16 | 0.13 | 2.1 | 64.8 | 64.8 | 64.8 | 0.1 | 0 |
| netprobe | 14 | 0.12 | 1.6 | 18.1 | 18.1 | 18.1 | 48 | 0 |
| direct | 5 | 0.04 | 9.5 | 18.7 | 18.7 | 18.7 | 864463.9 | 0 |
| direct-first-byte | 5 | 0.04 | 3 | 11 | 11 | 11 | 0 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| health | 575 | 0.99 | 1.93 | 9.64 | 15.08 |
| progress | 575 | 1.13 | 2.15 | 4.56 | 11.94 |
| api-other | 282 | 1.41 | 12.27 | 32.83 | 41.79 |
| suggest | 203 | 2.48 | 11.02 | 20.72 | 52.03 |
| search | 161 | 3.24 | 19.12 | 34.15 | 53.61 |
| telemetry | 153 | 1.34 | 5.91 | 12.47 | 14.04 |
| title | 101 | 1.79 | 4.28 | 12.55 | 17.35 |
| image | 89 | 0.64 | 1.35 | 8.08 | 8.08 |
| state | 42 | 0.85 | 1.24 | 12.58 | 12.58 |
| home | 41 | 17.52 | 24.55 | 29.46 | 29.46 |
| library | 33 | 0.98 | 7.04 | 7.06 | 7.06 |
| tv | 16 | 1.04 | 11.41 | 11.41 | 11.41 |
| direct | 5 | 426634.63 | 499667.9 | 499667.9 | 499667.9 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-direct | Lt Direct Eight | 114 | 0 | 0 |  | 3.36 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 101 | 0 | 0 |  | 16.71 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 238 | 0 | 0 |  | 8.69 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 229 | 0 | 0 |  | 7.98 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 219 | 0 | 0 |  | 17.37 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 408 | 0 | 0 |  | 29.71 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 201 | 0 | 0 |  | 7.98 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 509 | 0 | 0 |  | 1.45 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 119 | 0 | 0 |  | 9.34 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 224 | 0 | 0 |  | 9.3 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 333 | 0 | 0 |  | 25.08 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 205 | 0 | 0 |  | 7.98 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 311 | 0 | 0 |  | 25.38 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 102 | 0 | 0 |  | 7.98 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 101 | 0 | 0 |  | 23.86 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 121 | 0 | 0 |  | 16.3 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 270 | 0 | 0 |  | 7.93 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 309 | 0 | 0 |  | 25.32 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 137 | 0 | 0 |  | 4.67 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 398 | 0 | 0 |  | 14.84 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 502 | 0 | 0 |  | 23.53 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 349 | 0 | 0 |  | 14.85 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 208 | 0 | 0 |  | 8 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 204 | 0 | 0 |  | 8 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 106 | 0 | 0 |  | 8.38 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 106 | 0 | 0 |  | 38.12 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 166 | 0 | 0 |  | 7.96 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 106 | 0 | 0 |  | 25.26 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 99 | 0 | 0 |  | 25.55 | 0 | 0 | playing |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/profiles.json | 71 | 1900.8 |
| data/watch-sessions.json | 72 | 710.6 |
| data/sessions.json | 4 | 96 |
| data/usage/* | 64 | 32.9 |
| data/watch-history.json | 5 | 2.3 |
| data/healer.json | 2 | 2.3 |
| data/telemetry-hours.json | 4 | 0.4 |
