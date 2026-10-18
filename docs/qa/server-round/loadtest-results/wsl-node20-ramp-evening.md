# ramp — master@4862136f — evening

2026-10-18T11:13:04.051Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 16 GB), Node v20.18.1, machine profile **full**, media /home/elia/aurora-lt/media: 303 films, 10 shows. evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evening n=4 | 4 | 3 | 0.1 | 42.6/223.5/223.5 | 223.5/49.55 |  |  | 3687/5559 | 0 (0) | 99/76/53 | 26842 | 4121.03 | 1779.2 | 0.52932 | 0.375 | 0 | 125 | 42 | 143.7 | 337.5 | 0/0/0/0 | 1.1/15175 | 0.057 |  | **degraded**: 14 event-loop stall(s) > 1 s; loop stalled 53685 ms (> 2 % of the window) |
| evening n=8 | 8 | 4 | 1.3 | 9.8/234.5/1222.5 | 51/51.04 |  |  | 2692/5559 | 0 (0) | 73/52/32 | 12381 | 2353.33 | 711.8 | 0.27805 | 0.285 | 0 | 142 | 68 | 110.5 | 522.6 | 0/0/0/0 | 1.3/15060 | 0.046 |  | **degraded**: browse p99 1222.5 ms > 1000; 5 event-loop stall(s) > 1 s; loop stalled 24762 ms (> 2 % of the window) |
| evening n=16 | 16 | 8 | 2.9 | 6.3/61.6/228.2 | 55.9/55.93 |  |  | 205/5559 | 0 (0) | 56/27/12 | 4401 | 545.36 | 224.3 | 0.19681 | 0.414 | 0 | 179 | 116 | 232 | 543.4 | 0/0/0/0 | 2.2/15040 | 0.09 |  | **degraded**: loop stalled 8803 ms (> 2 % of the window) |
| evening n=32 | 32 | 16 | 5.7 | 5.4/145.3/267.3 | 321.5/81.26 |  |  | 206/5559 | 0 (0) | 98/59/17 | 8841 | 1516.52 | 325.6 | 0.34267000000000003 | 0.644 | 0 | 212 | 211 | 579.9 | 1114.9 | 0/0/0/0 | 3.7/14925 | 0.173 |  | **degraded**: 1 event-loop stall(s) > 1 s; loop stalled 17683 ms (> 2 % of the window) |
| evening n=48 | 48 | 24 | 8.3 | 4/38.6/146.9 | 60.8/59.24 |  |  | 209/816 | 0 (0) | 22/7/4 | 2272 | 1166.98 | 122.6 | 0.25404 | 0.393 | 0 | 218 | 306 | 726.5 | 1362.5 | 0/0/0/0 | 3.3/14831 | 0.188 |  | **degraded**: 1 event-loop stall(s) > 1 s; loop stalled 4544 ms (> 2 % of the window) |

Requests in the last window (evening n=48), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress | 580 | 4.83 | 1.7 | 34.6 | 671.4 | 1167.1 | 0 | 0 |
| suggest | 207 | 1.72 | 3 | 16.8 | 129.5 | 150.4 | 0.4 | 0 |
| search | 187 | 1.56 | 5 | 30.6 | 150.4 | 268.9 | 1.1 | 0 |
| telemetry | 166 | 1.38 | 2 | 37.6 | 664 | 793.1 | 0 | 0 |
| image | 148 | 1.23 | 2.5 | 16.8 | 35.1 | 49.8 | 0 | 148 (404:148) |
| api-other | 113 | 0.94 | 5.5 | 56.7 | 93.7 | 582.3 | 0.1 | 0 |
| grid | 100 | 0.83 | 7.2 | 61.3 | 148.8 | 216.6 | 0 | 0 |
| title | 69 | 0.57 | 2 | 20.9 | 886 | 886 | 0.4 | 0 |
| home | 42 | 0.35 | 22 | 38.9 | 60.8 | 60.8 | 4.3 | 0 |
| state | 40 | 0.33 | 1.4 | 9.6 | 16.1 | 16.1 | 0.1 | 0 |
| boot | 40 | 0.33 | 2.3 | 10.1 | 16.1 | 16.1 | 0.1 | 0 |
| library | 37 | 0.31 | 2 | 76.6 | 144.9 | 144.9 | 9.3 | 0 |
| title-offline | 28 | 0.23 | 3.3 | 61 | 72.5 | 72.5 | 0 | 28 (502:28) |
| netprobe | 14 | 0.12 | 1.4 | 11.9 | 11.9 | 11.9 | 48 | 0 |
| tv | 8 | 0.07 | 5.7 | 52.5 | 52.5 | 52.5 | 0.1 | 0 |
| direct | 2 | 0.02 | 6.2 | 6.7 | 6.7 | 6.7 | 597225.3 | 1 (0:1) |
| direct-first-byte | 2 | 0.02 | 3 | 5 | 5 | 5 | 0 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| health | 576 | 0.93 | 1.78 | 7.8 | 10.28 |
| progress | 576 | 1.06 | 1.92 | 7.38 | 10.88 |
| api-other | 266 | 1.46 | 9.59 | 17.97 | 32.18 |
| suggest | 213 | 2.02 | 11.52 | 24.59 | 943.5 |
| search | 191 | 2.84 | 15.72 | 108.95 | 949.09 |
| telemetry | 160 | 1.17 | 1.92 | 10.14 | 14.78 |
| image | 148 | 0.68 | 1.62 | 4.84 | 7.85 |
| title | 96 | 1.58 | 3.52 | 14.53 | 14.53 |
| home | 42 | 21.42 | 46.02 | 59.24 | 59.24 |
| state | 39 | 0.85 | 1.85 | 8.65 | 8.65 |
| library | 36 | 0.95 | 7.33 | 7.45 | 7.45 |
| tv | 8 | 1.41 | 6.46 | 6.46 | 6.46 |
| direct | 2 | 106941.22 | 523059.3 | 523059.3 | 523059.3 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-direct | Lt Direct Eight | 232 | 0 | 0 |  | 1.84 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 100 | 0 | 0 |  | 7.98 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 645 | 0 | 0 |  | 14.82 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 205 | 0 | 0 |  | 25.38 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 107 | 0 | 0 |  | 7.99 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 108 | 0 | 0 |  | 9.32 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 223 | 0 | 0 |  | 9.33 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 140 | 0 | 0 |  | 9.34 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 320 | 0 | 0 |  | 29.47 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 100 | 0 | 0 |  | 8 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 658 | 0 | 0 |  | 24.47 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 401 | 0 | 0 |  | 35.97 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 500 | 0 | 0 |  | 24.27 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 206 | 0 | 0 |  | 8.01 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 100 | 0 | 0 |  | 14.83 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 134 | 0 | 0 |  | 15.42 | 1 | 0 | playing |
| tv-direct | Lt Direct Heavy | 118 | 0 | 0 |  | 24.41 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 123 | 0 | 0 |  | 5.08 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 214 | 0 | 0 |  | 13.17 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 676 | 0 | 0 |  | 9.29 | 0 | 0 | playing |
| web-direct | Lt Direct Heavy | 816 | 0 | 0 |  | 25.36 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 219 | 0 | 0 |  | 8.03 | 0 | 0 | playing |
| web-direct | Lt Direct Eight | 209 | 0 | 0 |  | 8.02 | 0 | 0 | playing |
| tv-direct | Lt Direct Heavy | 341 | 0 | 0 |  | 24.38 | 0 | 0 | playing |
| tv-direct | Lt Direct Eight | 107 | 0 | 0 |  | 8.38 | 0 | 0 | playing |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/profiles.json | 71 | 1931.3 |
| data/watch-sessions.json | 70 | 631.1 |
| data/sessions.json | 5 | 120 |
| data/usage/* | 70 | 38.9 |
| data/healer.json | 2 | 2.3 |
| data/telemetry-hours.json | 4 | 0.8 |
| data/watch-history.json | 1 | 0.5 |
