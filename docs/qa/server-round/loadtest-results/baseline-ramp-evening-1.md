# ramp — master@4862136f — evening

2026-10-18T09:20:51.404Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **full**, media real: 29 films, 8 shows. evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evening n=4 | 4 | 3 | 0.7 | 40.5/465.2/644.8 | 62.2/61.84 | 9652.5 |  | 756/1409 | 0 (0) | 26/22/14 | 10267 | 12526.1 | 525.6 | 0.2175 | 0.087 | 0.32 | 146 | 349 | 39.4 | 1961.7 | 2/0/0/0 | 59.7/4136 |  | 100/38.64 | **degraded**: browse errors 2/81; 1 event-loop stall(s) > 1 s; loop stalled 20534 ms (> 2 % of the window) |
| evening n=8 | 8 | 4 | 1.8 | 18.3/363.5/494.3 | 494.3/40.94 | 1197.9 |  | 756/3935 | 0 (0) | 56/41/15 | 6847 | 1086.99 | 463 | 0.17707 | 0.141 | 1.145 | 193 | 371 | 61.9 | 3176.3 | 3/0/0/1 | 43.2/4509 |  | 99.3/24.87 | **degraded**: browse errors 4/210; 2 event-loop stall(s) > 1 s; loop stalled 13695 ms (> 2 % of the window) |

Requests in the last window (evening n=8), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress | 96 | 0.8 | 1.3 | 421.6 | 661.5 | 661.5 | 0 | 0 |
| image-offline | 75 | 0.62 | 10.6 | 192.8 | 246.9 | 246.9 | 0 | 75 (502:75) |
| image | 53 | 0.44 | 247.9 | 438.5 | 920.5 | 920.5 | 32.8 | 0 |
| title | 31 | 0.26 | 8.5 | 49.4 | 271.9 | 271.9 | 1.5 | 3 (502:3) |
| search | 29 | 0.24 | 26 | 253.6 | 392 | 392 | 6.3 | 0 |
| suggest | 28 | 0.23 | 25.9 | 193.1 | 388 | 388 | 0.9 | 0 |
| segment | 25 | 0.21 | 9.2 | 1197.9 | 1823.1 | 1823.1 | 2113.6 | 0 |
| telemetry | 25 | 0.21 | 1.3 | 77.2 | 210.8 | 210.8 | 0 | 0 |
| api-other | 22 | 0.18 | 8.7 | 29.2 | 30.1 | 30.1 | 0 | 0 |
| grid | 14 | 0.12 | 8.7 | 13.8 | 13.8 | 13.8 | 0 | 0 |
| home | 11 | 0.09 | 19.8 | 494.3 | 494.3 | 494.3 | 30.3 | 0 |
| library | 6 | 0.05 | 6.2 | 10.1 | 10.1 | 10.1 | 25.1 | 0 |
| state | 6 | 0.05 | 0.9 | 4.8 | 4.8 | 4.8 | 0.1 | 0 |
| boot | 6 | 0.05 | 1.6 | 8.3 | 8.3 | 8.3 | 0.1 | 0 |
| tv | 3 | 0.02 | 1.8 | 2 | 2 | 2 | 0.1 | 0 |
| netprobe | 2 | 0.02 | 1.9 | 152.9 | 152.9 | 152.9 | 48 | 0 |
| person | 1 | 0.01 | 1.8 | 1.8 | 1.8 | 1.8 | 0.1 | 1 (503:1) |
| playlist | 1 | 0.01 | 8.9 | 8.9 | 8.9 | 8.9 | 11.7 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| image | 680 | 1.84 | 220.93 | 527.83 | 1329.06 |
| health | 540 | 0.56 | 0.99 | 1.38 | 1.63 |
| progress | 96 | 0.72 | 1.15 | 1.67 | 1.67 |
| api-other | 45 | 1.06 | 2.46 | 2.71 | 2.71 |
| title | 31 | 3.17 | 20.76 | 269.07 | 269.07 |
| search | 31 | 19.42 | 181.28 | 1329.44 | 1329.44 |
| suggest | 29 | 21.16 | 97.88 | 184.05 | 184.05 |
| segment | 25 | 8.87 | 1146.26 | 1822.9 | 1822.9 |
| telemetry | 25 | 0.79 | 1.53 | 1.64 | 1.64 |
| home | 11 | 19.16 | 40.94 | 40.94 | 40.94 |
| library | 6 | 5.47 | 9.41 | 9.41 | 9.41 |
| state | 6 | 0.53 | 1.69 | 1.69 | 1.69 |
| tv | 3 | 0.78 | 1.39 | 1.39 | 1.39 |
| playlist | 1 | 8.39 | 8.39 | 8.39 | 8.39 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-direct | Greenland | 220 | 0 | 0 |  | 1.59 | 0 | 0 | playing |
| web-jit | Caught Stealing | 1409 | 0 | 0 |  | 2.72 | 0 | 0 | playing |
| web-direct | Arrival | 756 | 0 | 0 |  | 2.19 | 0 | 0 | playing |
| tv-offset | Inception | 3935 | 0 | 0 |  | 0.88 | 0 | 0 | playing |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/cache/similar.json | 7 | 5060.1 |
| data/profiles.json | 48 | 833.8 |
| data/cache/xray.json | 1 | 151.5 |
| data/sessions.json | 6 | 144 |
| data/healer.json | 2 | 74.4 |
| data/watch-sessions.json | 48 | 61.2 |
| data/usage/* | 30 | 10.7 |
| data/cache/trailers.json | 1 | 9.9 |
| data/cache/blur/* | 25 | 6.5 |
| data/telemetry-hours.json | 4 | 0.4 |
