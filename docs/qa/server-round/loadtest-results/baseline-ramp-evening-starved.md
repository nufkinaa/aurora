# ramp — master@4862136f — evening

2026-10-18T12:41:41.555Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **starved** ({"workingSetMaxMb":140}), media real: 29 films, 8 shows. evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | API p95/p99 | pictures p95/p99 | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evening n=4 | 4 | 3 | 0.6 | 67.9/981.8/2618.6 | 294.9/333.3 | 1524.7/2618.6 | / | 286 |  | 172/1675 | 0 (0) | 26/8/2 | 1306 | 312.13 | 109.8 | 0.08871 | 0.12 | 0.672 | 114 | 333 | 45.1 | 1470.3 | 0/0/0/0 | 100/5771 (PC starved) | 0.024 | 5.7/10.53 | **degraded**: browse p99 2618.6 ms > 1000; loop stalled 2611 ms (> 2 % of the window) |
| evening n=8 | 8 | 4 | 1.2 | 30.4/2421.9/7012 | 209.5/376.7 | 6978.8/7273.8 | 86.2/85.56 | 371.6 |  | 172/1675 | 0 (0) | 30/12/3 | 2121 | 829.27 | 194.9 | 0.13665 | 0.199 | 1.049 | 129 | 363 | 164.2 | 2641.5 | 0/0/0/0 | 99.9/6856 (PC starved) | 0.026 | 8.4/15.39 | **degraded**: browse p99 7012 ms > 1000; loop stalled 4242 ms (> 2 % of the window) |
| evening n=16 | 16 | 8 | 2.4 | 22.9/818.5/3616.9 | 116.9/301.3 | 3545/4485.5 | 101.8/98.27 | 2325 |  | 172/3510 | 0 (0) | 40/18/6 | 2811 | 718.78 | 162.4 | 0.14918 | 0.139 | 2.533 | 130 | 425 | 84.6 | 5811.2 | 0/0/0/0 | 97.4/7565 (PC starved) | 0.046 | 32.8/31.93 | **degraded**: browse p99 3616.9 ms > 1000; loop stalled 5623 ms (> 2 % of the window) |

Requests in the last window (evening n=16), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress | 192 | 1.6 | 2.2 | 47.1 | 100.3 | 106.1 | 0 | 0 |
| image-offline | 103 | 0.86 | 18.4 | 75.5 | 130.5 | 226.5 | 0 | 103 (502:103) |
| image | 97 | 0.81 | 296.5 | 3545 | 4485.5 | 4485.5 | 60.4 | 0 |
| segment | 57 | 0.47 | 15.1 | 2325 | 2949.4 | 2949.4 | 1822.1 | 0 |
| telemetry | 48 | 0.4 | 1.9 | 14.1 | 106.5 | 106.5 | 0 | 0 |
| title | 44 | 0.37 | 14.2 | 35 | 105.8 | 105.8 | 1.8 | 0 |
| grid | 40 | 0.33 | 12.5 | 27.5 | 71.6 | 71.6 | 0 | 0 |
| api-other | 27 | 0.22 | 25.5 | 47.2 | 58.2 | 58.2 | 0 | 0 |
| title-offline | 17 | 0.14 | 5.5 | 24.5 | 24.5 | 24.5 | 0 | 17 (502:17) |
| suggest | 16 | 0.13 | 40.2 | 301.3 | 301.3 | 301.3 | 0.9 | 0 |
| home | 15 | 0.12 | 30.7 | 101.8 | 101.8 | 101.8 | 32.1 | 0 |
| library | 14 | 0.12 | 10.1 | 15.3 | 15.3 | 15.3 | 25.1 | 0 |
| search | 13 | 0.11 | 122.8 | 305.1 | 305.1 | 305.1 | 5.8 | 0 |
| state | 12 | 0.1 | 1.6 | 7.4 | 7.4 | 7.4 | 0.2 | 0 |
| boot | 12 | 0.1 | 3.1 | 8.7 | 8.7 | 8.7 | 0.1 | 0 |
| tv | 3 | 0.02 | 2.7 | 24.4 | 24.4 | 24.4 | 0.1 | 0 |
| playlist | 2 | 0.02 | 4 | 6.1 | 6.1 | 6.1 | 14.5 | 0 |
| person-offline | 1 | 0.01 | 3 | 3 | 3 | 3 | 0.1 | 1 (503:1) |
| netprobe | 1 | 0.01 | 1.5 | 1.5 | 1.5 | 1.5 | 48 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| image | 591 | 2.72 | 572.89 | 3341.28 | 4298.92 |
| health | 549 | 0.95 | 1.87 | 3.45 | 8.76 |
| progress | 192 | 1.15 | 2.23 | 9.63 | 35.33 |
| api-other | 83 | 2.17 | 11.09 | 15.2 | 15.2 |
| title | 59 | 5.55 | 34.95 | 64.07 | 64.07 |
| segment | 57 | 14.88 | 2324.81 | 2949.33 | 2949.33 |
| telemetry | 48 | 1.28 | 3.14 | 10.23 | 10.23 |
| suggest | 20 | 39.18 | 215.29 | 298.58 | 298.58 |
| home | 15 | 27.11 | 98.27 | 98.27 | 98.27 |
| library | 14 | 9.33 | 13.66 | 13.66 | 13.66 |
| search | 14 | 59.17 | 287.73 | 287.73 | 287.73 |
| state | 12 | 1.08 | 1.75 | 1.75 | 1.75 |
| tv | 3 | 1.6 | 1.62 | 1.62 | 1.62 |
| playlist | 2 | 3.47 | 4.55 | 4.55 | 4.55 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-direct | Greenland | 172 | 0 | 0 |  | 3.25 | 0 | 0 | playing |
| web-jit | Caught Stealing | 1675 | 0 | 0 |  | 1.89 | 0 | 0 | playing |
| web-direct | Arrival | 103 | 0 | 0 |  | 2.11 | 0 | 0 | playing |
| tv-offset | Inception | 1642 | 0 | 0 |  | 2.15 | 0 | 0 | playing |
| web-transcode | Disclosure Day | 3510 | 0 | 0 |  | 3.05 | 0 | 0 | playing |
| web-direct | The Amateur | 104 | 0 | 0 |  | 2.55 | 0 | 0 | playing |
| web-direct | Palmer | 100 | 0 | 0 |  | 2.66 | 0 | 0 | playing |
| tv-direct | Eternity | 478 | 0 | 0 |  | 7.61 | 0 | 0 | playing |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/cache/similar.json | 12 | 10561.6 |
| data/profiles.json | 48 | 455.6 |
| data/cache/xray.json | 2 | 304 |
| data/healer.json | 2 | 125.2 |
| data/watch-sessions.json | 48 | 121.7 |
| data/cache/trailers.json | 3 | 29.3 |
| data/usage/* | 58 | 18 |
| data/cache/blur/* | 26 | 6.6 |
| data/telemetry-hours.json | 4 | 0.4 |