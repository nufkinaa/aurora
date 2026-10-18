# ramp — master@4862136f — evening

2026-10-18T12:31:52.791Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **lowmem** ({"workingSetMaxMb":320}), media real: 29 films, 8 shows. evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | API p95/p99 | pictures p95/p99 | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evening n=4 | 4 | 3 | 0.3 | 24.3/2378/3092.6 | 131.1/152.3 | 3092.6/3092.6 | 52.8/45.62 | 817.9 |  | 119/1029 | 0 (0) | 16/3/0 | 719 | 238.4 | 36.9 | 0.05778 | 0.09 | 0.742 | 166 | 331 | 40.8 | 1605.8 | 0/0/0/0 | 100/7057 (PC starved) | 0.028 | 16.4/17.14 | **degraded**: browse p99 3092.6 ms > 1000 |
| evening n=8 | 8 | 4 | 1.7 | 41.8/3929/5506 | 184.1/362 | 5384.6/7147 | 201.4/182.54 | 264.2 |  | 119/13768 | 0 (0) | 53/30/12 | 5325 | 1254.99 | 411.9 | 0.21802000000000002 | 0.207 | 0.906 | 187 | 363 | 175.3 | 3075.4 | 0/0/0/0 | 99.8/6115 (PC starved) | 0.027 | 7.7/13.34 | **degraded**: browse p99 5506 ms > 1000; 1 event-loop stall(s) > 1 s; loop stalled 10649 ms (> 2 % of the window) |
| evening n=16 | 16 | 8 | 3.4 | 24.6/947.8/1488.3 | 61.8/113.1 | 1275.5/2320.3 | 40.7/39.25 | 7702.5 |  | 316/13768 | 1 (4.3) | 24/5/1 | 1145 | 370.8 | 79.5 | 0.16183 | 0.17 | 1.582 | 203 | 428 | 97.8 | 7575.3 | 0/0/0/0 | 99.9/5606 (PC starved) | 0.04 | 6.9/8.02 | **degraded**: browse p99 1488.3 ms > 1000; 1 stall(s) in 8 viewers |
| evening n=32 | 32 | 16 | 7.1 | 23.2/1447.3/10285.4 | 1132/3338.8 | 4805.1/12065.5 | 4107/396.37 | 1315.7 |  | 490/13768 | 0 (125.9) | 70/45/28 | 18860 | 6762.19 | 1841.9 | 0.47352999999999995 | 0.26 | 2.159 | 209 | 570 | 189 | 8394.8 | 0/0/0/0 | 97.4/5410 (PC starved) | 0.061 | 12.6/19.59 | **degraded**: browse p99 10285.4 ms > 1000; 1 viewer(s) never started; 21 stream refusal(s); 8 event-loop stall(s) > 1 s; loop stalled 37721 ms (> 2 % of the window) |

Requests in the last window (evening n=32), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress | 335 | 2.79 | 6.4 | 1958.4 | 3371.3 | 3378.4 | 0 | 0 |
| segment | 329 | 2.74 | 8.2 | 1315.7 | 6149 | 8896.9 | 790.6 | 100 (409:100) |
| image-offline | 262 | 2.18 | 9.8 | 290.9 | 2688.6 | 2691 | 0 | 262 (502:262) |
| image | 257 | 2.14 | 61 | 4805.1 | 12065.5 | 15269.2 | 42.1 | 0 |
| suggest | 127 | 1.06 | 19 | 144.9 | 1146.9 | 2503.8 | 1 | 0 |
| search | 118 | 0.98 | 25.9 | 862.8 | 2355.5 | 2612.4 | 7.8 | 0 |
| telemetry | 99 | 0.82 | 2.5 | 4465.5 | 6485.3 | 6485.3 | 0 | 0 |
| title | 92 | 0.77 | 21.9 | 2743 | 5601.7 | 5601.7 | 2 | 0 |
| api-other | 86 | 0.72 | 14.2 | 433.5 | 1401.2 | 1401.2 | 0 | 0 |
| playlist | 64 | 0.53 | 4.7 | 1063.7 | 6298.3 | 6298.3 | 1.2 | 21 (503:21) |
| grid | 60 | 0.5 | 16.5 | 1631.7 | 4069.2 | 4069.2 | 0 | 0 |
| title-offline | 34 | 0.28 | 10.8 | 1166 | 4782.7 | 4782.7 | 0 | 34 (502:34) |
| home | 30 | 0.25 | 37.9 | 2641.7 | 4107 | 4107 | 24.7 | 0 |
| state | 26 | 0.22 | 4.2 | 481.9 | 483.1 | 483.1 | 0.2 | 0 |
| boot | 26 | 0.22 | 8.6 | 483.7 | 484.2 | 484.2 | 0.1 | 0 |
| library | 21 | 0.17 | 11.9 | 1626.5 | 3318.9 | 3318.9 | 25.1 | 0 |
| tv | 6 | 0.05 | 1.5 | 1141.6 | 1141.6 | 1141.6 | 0.1 | 0 |
| person-offline | 6 | 0.05 | 3 | 17 | 17 | 17 | 0.1 | 6 (503:6) |
| netprobe | 2 | 0.02 | 2.4 | 4.8 | 4.8 | 4.8 | 48 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| image | 1093 | 2.5 | 441.44 | 6216.18 | 15201.67 |
| health | 419 | 0.83 | 1.56 | 2.69 | 5.44 |
| progress | 335 | 0.94 | 2.15 | 4.31 | 9.72 |
| segment | 329 | 5.66 | 292.26 | 5505.33 | 8896.11 |
| api-other | 180 | 1.42 | 8.98 | 18.15 | 35.18 |
| suggest | 149 | 18.32 | 144.65 | 1399.7 | 2945.49 |
| search | 134 | 19.07 | 138.03 | 575.63 | 2936.51 |
| title | 126 | 4.55 | 675.38 | 956.72 | 5175.18 |
| telemetry | 99 | 1.14 | 1.94 | 17.91 | 17.91 |
| playlist | 64 | 4.11 | 90.46 | 306.11 | 306.11 |
| home | 30 | 21.33 | 160.15 | 396.37 | 396.37 |
| state | 26 | 0.87 | 3.47 | 3.59 | 3.59 |
| library | 21 | 9.26 | 283.32 | 384.46 | 384.46 |
| tv | 6 | 1.09 | 1.54 | 1.54 | 1.54 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-direct | Greenland | 119 | 0 | 0 |  | 1.55 | 0 | 0 | playing |
| web-direct | Arrival | 103 | 0 | 0 |  | 2.12 | 0 | 0 | playing |
| web-jit | Caught Stealing | 1029 | 0 | 0 | 4970 | 4.13 | 0 | 0 | playing |
| tv-offset | Inception | 13768 | 0 | 0 |  | 0.93 | 0 | 0 | playing |
| web-transcode | Disclosure Day | 7617 | 0 | 0 |  | 2.52 | 0 | 0 | playing |
| tv-direct | Eternity | 490 | 0 | 0 |  | 7.69 | 0 | 0 | playing |
| web-direct | The Amateur | 316 | 0 | 0 |  | 2.59 | 0 | 0 | playing |
| web-direct | Palmer | 210 | 0 | 0 |  | 2.68 | 0 | 0 | playing |
| web-direct | Dracula A Love Tale | 100 | 0 | 0 |  | 2.84 | 0 | 0 | playing |
| tv-direct | Avatar Movie | 118 | 0 | 0 |  | 2.49 | 0 | 0 | playing |
| web-jit | Inception | 1150 | 0 | 125855 |  | 0 | 100 | 0 | stalled |
| web-transcode | Palmer |  | 0 | 0 |  | 0 | 0 | 21 | starting |
| web-direct | Fountain of Youth | 319 | 0 | 0 |  | 2.82 | 0 | 0 | playing |
| tv-offset | The Ministry of Ungentlemanl | 4180 | 0 | 0 |  | 3.85 | 0 | 0 | playing |
| web-jit | The Ministry of Ungentlemanl | 2179 | 0 | 0 |  | 1.69 | 0 | 0 | playing |
| tv-offset | Night Hunter | 6432 | 0 | 0 |  | 4.65 | 0 | 0 | playing |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/cache/similar.json | 13 | 15175.7 |
| data/profiles.json | 32 | 618.6 |
| data/cache/xray.json | 2 | 304.3 |
| data/healer.json | 2 | 191.7 |
| data/sessions.json | 11 | 176 |
| data/watch-sessions.json | 24 | 123.4 |
| data/healer.json.good1 | 1 | 101 |
| data/usage/* | 66 | 33.6 |
| data/cache/trailers.json | 2 | 20.3 |
| data/profiles.json.good1 | 1 | 19.1 |