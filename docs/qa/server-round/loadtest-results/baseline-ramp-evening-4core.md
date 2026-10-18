# ramp — master@4862136f — evening

2026-10-18T12:19:43.305Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **4core** ({"affinity":"mask 85 (CPUs 0,2,4,6)"}), media real: 29 films, 8 shows. evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evening n=4 | 4 | 3 | 0.1 | 43.3/656.6/656.6 | 656.6/720.08 | 1205.7 |  | 2161/2532 | 0 (0) | 95/40/11 | 6021 | 892.18 | 268.3 | 0.13147999999999999 | 0.044 | 0.179 | 152 | 317 | 23 | 842.4 | 0/0/0/0 | 98.2/5784 (PC starved) | 0.028 | 13.4/11.47 | **degraded**: loop stalled 12043 ms (> 2 % of the window) |
| evening n=8 | 8 | 4 | 1.2 | 169/6070.9/27847.3 | 1276.2/508.07 | 7328.9 | 35346 | 2161/40984 | 0 (0) | 183/109/48 | 25068 | 2620 | 1392.6 | 0.47505000000000003 | 0.093 | 0.2 | 220 | 388 | 47.9 | 2466.5 | 0/0/0/0 | 98.9/6771 (PC starved) | 0.029 | 8.5/15.52 | **degraded**: browse p99 27847.3 ms > 1000; 8 event-loop stall(s) > 1 s; loop stalled 50136 ms (> 2 % of the window) |
| evening n=16 | 16 | 8 | 4.1 | 25.7/16270.8/35639 | 621.8/572.2 | 33469.6 | 29115 | 1354/40984 | 4 (114.1) | 193/112/40 | 20474 | 2881.86 | 928.4 | 0.5448200000000001 | 0.193 | 0.465 | 230 | 428 | 282.3 | 3905 | 0/0/0/0 | 97.7/5823 (PC starved) | 0.04 | 5.1/6.97 | **degraded**: browse p99 35639 ms > 1000; 4 stall(s) in 8 viewers; 4 event-loop stall(s) > 1 s; loop stalled 40947 ms (> 2 % of the window) |
| evening n=32 | 32 | 16 | 3.5 | 627.9/60011.1/60018.4 | 1603/291 | 18789.1 |  | 1693/40984 | 4 (400.5) | 293/194/98 | 50502 | 3670.83 | 2614.1 | 0.9870599999999999 | 0.147 | 0.154 | 239 | 552 | 142.9 | 6039.6 | 0/33/0/0 | 100/5530 (PC starved) | 0.046 | 13.2/13.62 | **degraded**: browse p99 60018.4 ms > 1000; browse errors 33/421; 4 stall(s) in 16 viewers; 3 viewer(s) never started; 23 stream refusal(s); 24 event-loop stall(s) > 1 s; loop stalled 101003 ms (> 2 % of the window) |

Requests in the last window (evening n=32), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress | 240 | 2 | 501.9 | 2831.8 | 3679 | 4191.1 | 0 | 0 |
| image-offline | 192 | 1.6 | 198.7 | 2251.8 | 4160.6 | 4162.6 | 0 | 192 (502:192) |
| image | 149 | 1.24 | 5358.9 | 60013.3 | 60024.2 | 60024.3 | 15.6 | 33 (0:33) |
| segment | 109 | 0.91 | 617.5 | 18789.1 | 60003.7 | 60005.9 | 779.7 | 79 (0:2 409:77) |
| grid | 86 | 0.72 | 298.6 | 1920.5 | 3872.2 | 3872.2 | 0 | 0 |
| playlist | 74 | 0.62 | 511.9 | 20981.2 | 22462.4 | 22462.4 | 0.8 | 29 (500:10 503:19) |
| telemetry | 45 | 0.37 | 392.8 | 3720.8 | 4464.1 | 4464.1 | 0 | 0 |
| title | 40 | 0.33 | 1271.9 | 4408.2 | 6450.9 | 6450.9 | 2 | 0 |
| api-other | 32 | 0.27 | 199.3 | 1266.6 | 3238.4 | 3238.4 | 0 | 0 |
| boot | 28 | 0.23 | 206.7 | 1799.6 | 1799.9 | 1799.9 | 0 | 0 |
| tv | 25 | 0.21 | 283.8 | 1757.5 | 3720.1 | 3720.1 | 0.1 | 11 (404:11) |
| library | 22 | 0.18 | 612.2 | 1352.2 | 1481.8 | 1481.8 | 25.1 | 0 |
| title-offline | 18 | 0.15 | 221.6 | 3872.4 | 3872.4 | 3872.4 | 0 | 18 (502:18) |
| search | 14 | 0.12 | 1080.9 | 5639.7 | 5639.7 | 5639.7 | 4.7 | 0 |
| state | 10 | 0.08 | 194.2 | 1724.2 | 1724.2 | 1724.2 | 0.2 | 0 |
| suggest | 9 | 0.07 | 263.4 | 4078 | 4078 | 4078 | 0.5 | 0 |
| netprobe | 8 | 0.07 | 185.9 | 1081.3 | 1081.3 | 1081.3 | 48 | 0 |
| home | 6 | 0.05 | 245 | 1603 | 1603 | 1603 | 16 | 0 |
| direct | 1 | 0.01 | 10.5 | 10.5 | 10.5 | 10.5 | 194624 | 0 |
| direct-first-byte | 1 | 0.01 | 3125 | 3125 | 3125 | 3125 | 0 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| image | 495 | 8.41 | 60019.84 | 61597.16 | 64020.65 |
| progress | 232 | 1.35 | 38.08 | 240.55 | 314.73 |
| health | 206 | 1.22 | 40.19 | 68.59 | 111.64 |
| api-other | 157 | 3.51 | 67.37 | 151.32 | 203.34 |
| segment | 108 | 6.93 | 18055.7 | 59890.52 | 60213.59 |
| playlist | 72 | 60.67 | 20579.45 | 20736.18 | 20736.18 |
| title | 53 | 113.71 | 3925.25 | 5128.23 | 5128.23 |
| telemetry | 42 | 2.06 | 34.25 | 86.77 | 86.77 |
| suggest | 40 | 71.07 | 2278.58 | 2347.65 | 2347.65 |
| search | 35 | 696.99 | 2318.86 | 3949.25 | 3949.25 |
| tv | 25 | 1.84 | 18.82 | 94.76 | 94.76 |
| library | 22 | 2.94 | 207.62 | 491.99 | 491.99 |
| state | 10 | 1.14 | 6.7 | 6.7 | 6.7 |
| home | 6 | 100.17 | 291 | 291 | 291 |
| direct | 1 | 553341.32 | 553341.32 | 553341.32 | 553341.32 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| web-direct | Arrival | 2161 | 0 | 0 |  | 2.97 | 0 | 0 | playing |
| web-jit | Caught Stealing | 2532 | 0 | 0 |  | 2.22 | 0 | 0 | playing |
| tv-direct | Greenland | 1354 | 1 | 15783 | 16313 | 3.66 | 0 | 0 | playing |
| tv-offset | Inception | 40984 | 1 | 114242 |  | 0.17 | 0 | 0 | stalled |
| tv-direct | Eternity | 659 | 1 | 11841 |  | 7.67 | 0 | 0 | playing |
| web-transcode | Disclosure Day | 29196 | 0 | 124691 |  | 0 | 2 | 0 | stalled |
| web-direct | Palmer | 520 | 0 | 0 |  | 3.22 | 0 | 0 | playing |
| web-direct | The Amateur | 208 | 0 | 0 |  | 3.29 | 0 | 0 | playing |
| web-jit | The Ministry of Ungentlemanl | 5409 | 1 | 9214 |  | 3.41 | 0 | 0 | playing |
| web-transcode | Palmer |  | 0 | 0 |  | 0 | 0 | 19 | starting |
| web-direct | Dracula A Love Tale | 105 | 0 | 0 |  | 3.01 | 0 | 0 | playing |
| web-direct | Fountain of Youth | 528 | 0 | 0 |  | 3.54 | 0 | 0 | playing |
| tv-offset | The Ministry of Ungentlemanl |  | 0 | 0 |  | 0 | 0 | 2 | starting |
| tv-direct | Avatar Movie | 1693 | 0 | 0 |  | 2.8 | 0 | 0 | playing |
| web-jit | Inception | 3275 | 0 | 124692 |  | 0 | 77 | 0 | stalled |
| tv-offset | Night Hunter |  | 0 | 0 |  | 0 | 0 | 2 | starting |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/cache/similar.json | 11 | 10580 |
| data/profiles.json | 33 | 608.5 |
| data/watch-sessions.json | 42 | 216.1 |
| data/sessions.json | 13 | 208 |
| data/cache/xray.json | 1 | 151.7 |
| data/healer.json | 2 | 144.3 |
| data/healer.json.good1 | 1 | 74.3 |
| data/cache/trailers.json | 4 | 37.6 |
| data/usage/* | 50 | 18.5 |
| data/profiles.json.good1 | 1 | 18.4 |