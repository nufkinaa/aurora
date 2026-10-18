# ramp — master@4862136f — evening

2026-10-18T10:43:43.196Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **2core** ({"affinity":"mask 5 (CPUs 0,2)"}), media real: 29 films, 8 shows. evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evening n=4 | 4 | 3 | 1.5 | 319.5/16245.6/24879.6 | 782.3/769.38 | 7242.3 |  | 2400/20233 | 0 (0) | 96/47/12 | 9554 | 2919.91 | 599.4 | 0.27834 | 0.08 | 0.21 | 171 | 330 | 36.2 | 1246.8 | 0/0/0/0 | 99.6/8526 (PC starved) | 0.029 | 1.9/2.81 | **degraded**: browse p99 24879.6 ms > 1000; 4 event-loop stall(s) > 1 s; loop stalled 19107 ms (> 2 % of the window) |
| evening n=8 | 8 | 4 | 1.6 | 84.9/4817.3/8823.8 | 1855.7/1142.23 | 5434.6 | 55108 | 2400/57872 | 1 (89.1) | 199/93/28 | 15494 | 1560.09 | 907.5 | 0.45042000000000004 | 0.142 | 0.22 | 176 | 375 | 144.8 | 2165.7 | 0/0/0/0 | 99.8/7558 (PC starved) | 0.034 | 2/2.96 | **degraded**: browse p99 8823.8 ms > 1000; 1 stall(s) in 4 viewers; 3 event-loop stall(s) > 1 s; loop stalled 30987 ms (> 2 % of the window) |
| evening n=16 | 16 | 8 | 3.9 | 119.4/35468.5/40279.3 | 867.3/201.63 | 60011.8 | 37466 | 1904/57872 | 1 (229.3) | 263/132/43 | 22555 | 1678.1 | 838.7 | 0.58811 | 0.158 | 0.191 | 211 | 451 | 79.1 | 3950.5 | 0/0/0/0 | 99.9/7016 (PC starved) | 0.042 | 3.2/4.03 | **degraded**: browse p99 40279.3 ms > 1000; 1 stall(s) in 8 viewers; 4 event-loop stall(s) > 1 s; loop stalled 45110 ms (> 2 % of the window) |
| evening n=24 | 24 | 12 | 3.7 | 491.6/45532.4/50857.4 | 3815.4/1058.13 | 60005.2 | 60776 | 2400/60835 | 2 (278.2) | 315/217/81 | 47051 | 7148.11 | 2302.8 | 0.87361 | 0.14 | 0.135 | 187 | 515 | 128.2 | 4108.9 | 0/0/0/0 | 98.9/7328 (PC starved) | 0.048 | 8.1/13.01 | **degraded**: browse p99 50857.4 ms > 1000; 2 stall(s) in 12 viewers; 2 viewer(s) never started; 22 stream refusal(s); 19 event-loop stall(s) > 1 s; loop stalled 94102 ms (> 2 % of the window) |
| evening n=32 | 32 | 16 | 5.1 | 550.3/26805.7/40204.3 | 5610.8/3252.95 | 13068.4 | 29370 | 2400/60835 | 1 (364) | 368/230/94 | 46563 | 2974.76 | 1596.9 | 0.9846699999999999 | 0.165 | 0.186 | 222 | 583 | 187.3 | 5997.5 | 0/0/0/0 | 99/7413 (PC starved) | 0.054 | 4.4/6.57 | **degraded**: browse p99 40204.3 ms > 1000; 1 stall(s) in 16 viewers; 3 viewer(s) never started; 24 stream refusal(s); 18 event-loop stall(s) > 1 s; loop stalled 93126 ms (> 2 % of the window) |

Requests in the last window (evening n=32), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| image | 262 | 2.18 | 1492.5 | 30965.3 | 44080.2 | 44920 | 38.2 | 0 |
| progress | 242 | 2.02 | 342 | 1681.1 | 1762.4 | 1829.5 | 0 | 0 |
| image-offline | 199 | 1.66 | 135.9 | 1034 | 2681.3 | 2681.7 | 0 | 199 (502:199) |
| segment | 126 | 1.05 | 357.5 | 13068.4 | 60005.6 | 60014.9 | 734.6 | 91 (0:2 409:89) |
| grid | 89 | 0.74 | 224.7 | 1878.7 | 2498.1 | 2498.1 | 0 | 0 |
| playlist | 77 | 0.64 | 421.9 | 21395.2 | 22846.7 | 22846.7 | 0.3 | 30 (500:10 503:20) |
| telemetry | 71 | 0.59 | 301.7 | 1668.6 | 2538 | 2538 | 0 | 0 |
| api-other | 53 | 0.44 | 170.8 | 1240.2 | 1509.4 | 1509.4 | 0.1 | 0 |
| title | 52 | 0.43 | 455.4 | 5282.5 | 5453.3 | 5453.3 | 1.7 | 0 |
| search | 38 | 0.32 | 1205.3 | 9657.7 | 9880.8 | 9880.8 | 5.4 | 0 |
| boot | 29 | 0.24 | 57.5 | 1177.7 | 1786.9 | 1786.9 | 0.1 | 0 |
| library | 26 | 0.22 | 177.7 | 1070.2 | 1588.2 | 1588.2 | 25.1 | 0 |
| suggest | 20 | 0.17 | 727.7 | 2818.3 | 5796.4 | 5796.4 | 0.7 | 0 |
| tv | 18 | 0.15 | 137.1 | 1279.3 | 1279.3 | 1279.3 | 0.1 | 7 (404:7) |
| home | 11 | 0.09 | 476.4 | 5610.8 | 5610.8 | 5610.8 | 28.8 | 0 |
| state | 11 | 0.09 | 256.3 | 1785.3 | 1785.3 | 1785.3 | 0.2 | 0 |
| netprobe | 10 | 0.08 | 110.4 | 423.5 | 423.5 | 423.5 | 48 | 0 |
| title-offline | 7 | 0.06 | 336 | 760.7 | 760.7 | 760.7 | 0 | 7 (502:7) |
| person-offline | 4 | 0.03 | 2 | 128 | 128 | 128 | 0.1 | 4 (503:4) |
| first-segment | 1 | 0.01 | 29370 | 29370 | 29370 | 29370 | 0 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| image | 701 | 7.87 | 23466.44 | 37387.86 | 44906.46 |
| health | 247 | 1.11 | 26.72 | 58.55 | 113.17 |
| progress | 242 | 1.2 | 22.34 | 78.65 | 186.38 |
| api-other | 183 | 2.52 | 40 | 136.57 | 179.84 |
| segment | 126 | 2.93 | 11817.47 | 59293.36 | 61050.4 |
| suggest | 91 | 127.39 | 1906.44 | 3584.19 | 3584.19 |
| search | 83 | 454.33 | 4620.66 | 8188.42 | 8188.42 |
| playlist | 77 | 93.94 | 20406.87 | 20748.18 | 20748.18 |
| telemetry | 70 | 1.54 | 87.1 | 237.67 | 237.67 |
| title | 60 | 129.6 | 4026.36 | 4119.53 | 4119.53 |
| library | 26 | 9.88 | 242.23 | 281.62 | 281.62 |
| tv | 18 | 1.19 | 61.09 | 61.09 | 61.09 |
| home | 11 | 159.88 | 3252.95 | 3252.95 | 3252.95 |
| state | 11 | 1.26 | 24.96 | 24.96 | 24.96 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-direct | Greenland | 2400 | 0 | 0 |  | 3.07 | 0 | 0 | playing |
| web-direct | Arrival | 1904 | 0 | 0 |  | 1.47 | 0 | 0 | playing |
| web-jit | Caught Stealing | 20233 | 0 | 0 |  | 3.14 | 0 | 0 | playing |
| tv-offset | Inception | 57872 | 0 | 124653 |  | 0 | 0 | 0 | stalled |
| tv-direct | Eternity | 919 | 0 | 0 |  | 7.86 | 0 | 0 | playing |
| web-direct | The Amateur | 634 | 0 | 0 |  | 3.78 | 0 | 0 | playing |
| web-direct | Palmer | 648 | 0 | 0 |  | 3.1 | 0 | 0 | playing |
| web-transcode | Disclosure Day | 37531 | 0 | 124653 |  | 0 | 2 | 0 | stalled |
| tv-offset | Night Hunter |  | 0 | 0 |  | 0 | 0 | 2 | starting |
| web-jit | The Ministry of Ungentlemanl | 60835 | 0 | 0 |  | 3.02 | 0 | 0 | playing |
| web-transcode | Palmer |  | 0 | 0 |  | 0 | 0 | 20 | starting |
| web-direct | Fountain of Youth | 7406 | 0 | 0 |  | 3.35 | 0 | 0 | playing |
| tv-offset | The Ministry of Ungentlemanl |  | 0 | 0 |  | 0 | 0 | 2 | starting |
| tv-direct | Avatar Movie | 1636 | 0 | 0 |  | 3.32 | 0 | 0 | playing |
| web-jit | Inception | 29452 | 1 | 111362 |  | 0.16 | 89 | 0 | stalled |
| web-direct | Dracula A Love Tale | 1200 | 0 | 3351 |  | 3.97 | 0 | 0 | playing |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/cache/similar.json | 10 | 10427 |
| data/profiles.json | 33 | 623.3 |
| data/cache/xray.json | 3 | 457.4 |
| data/watch-sessions.json | 42 | 216.1 |
| data/healer.json | 2 | 163.1 |
| data/sessions.json | 5 | 80 |
| data/usage/* | 60 | 26.6 |
| data/cache/blur/* | 4 | 1 |
| data/telemetry-hours.json | 4 | 0.4 |
