# ramp — master@4862136f — evening

2026-10-18T09:41:14.290Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **full**, media real: 29 films, 8 shows. evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evening n=4 | 4 | 3 | 0.4 | 77.5/590.7/1091.1 | 471.9/98.42 | 1510.4 |  | 1164/7294 | 0 (0) | 41/28/11 | 6285 | 3150.55 | 526.5 | 0.15461000000000003 | 0.089 | 0.433 | 183 | 331 | 37.4 | 1712 | 1/0/0/0 | 64.2/1457 |  | 80.8/50.71 | **degraded**: browse p99 1091.1 ms > 1000; browse errors 1/50; 2 event-loop stall(s) > 1 s; loop stalled 12570 ms (> 2 % of the window) |
| evening n=8 | 8 | 4 | 2.1 | 37.5/2259.8/8352.6 | 6475.9/54.09 | 10532.6 |  | 1164/7294 | 1 (0.5) | 59/44/19 | 14282 | 10128.41 | 1005.5 | 0.31662 | 0.134 | 0.644 | 178 | 365 | 166 | 2026.6 | 2/0/0/3 | 65.6/581 (PC starved) |  | 30.2/11.04 | **degraded**: browse p99 8352.6 ms > 1000; browse errors 5/246; 1 stall(s) in 4 viewers; 5 event-loop stall(s) > 1 s; loop stalled 28563 ms (> 2 % of the window) |
| evening n=16 | 16 | 8 | 2.8 | 63.2/4001.2/21043.9 | 16881.7/655.81 | 3540.4 |  | 1089/7294 | 3 (2.6) | 39/21/7 | 17159 | 26718.57 | 381.3 | 0.36732 | 0.116 | 0.165 | 192 | 467 | 86.3 | 3242.9 | 6/0/0/3 | 74.2/1665 |  | 8/5.26 | **degraded**: browse p99 21043.9 ms > 1000; browse errors 9/341; 3 stall(s) in 8 viewers; 2 event-loop stall(s) > 1 s; loop stalled 34318 ms (> 2 % of the window) |
| evening n=24 | 24 | 12 | 4 | 158.4/12602.6/35580.8 | 11682.3/366.05 | 10792.1 | 62358 | 1164/62456 | 6 (114.1) | 180/102/47 | 34650 | 12809.19 | 4744.9 | 0.7443099999999999 | 0.21 | 80.766 | 211 | 531 | 188.2 | 6175.1 | 11/0/0/6 | 86.3/113 (PC starved) |  | 33.4/14.81 | **degraded**: browse p99 35580.8 ms > 1000; browse errors 17/484; 6 stall(s) in 12 viewers; 12 event-loop stall(s) > 1 s; loop stalled 69299 ms (> 2 % of the window) |
| evening n=32 | 32 | 16 | 6.9 | 29.8/6570.1/26573.3 | 623/303.14 | 1799.5 |  | 1497/62456 | 4 (171.5) | 161/65/22 | 12056 | 1691.94 | 444.5 | 0.37307 | 0.262 | 2.411 | 185 | 560 | 186.8 | 10384.3 | 13/0/0/10 | 99.9/2605 (PC starved) |  | 16.1/11.89 | **degraded**: browse p99 26573.3 ms > 1000; browse errors 23/833; 4 stall(s) in 16 viewers; 1 event-loop stall(s) > 1 s; loop stalled 24112 ms (> 2 % of the window) |
| evening n=48 | 48 | 24 | 10.2 | 18.1/1698.3/7884.5 | 8913/277.09 | 6471.6 | 7840 | 1497/82816 | 1 (131.5) | 61/34/23 | 15191 | 10703.39 | 1065.9 | 0.43727 | 0.328 | 4.966 | 202 | 693 | 227.5 | 18070.8 | 28/0/0/9 | 88.5/4518 (PC starved) |  | 14.6/15.68 | **degraded**: browse p99 7884.5 ms > 1000; browse errors 37/1221; 1 stall(s) in 24 viewers; 14 stream refusal(s); 6 event-loop stall(s) > 1 s; loop stalled 30381 ms (> 2 % of the window) |

Requests in the last window (evening n=48), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress | 529 | 4.41 | 8.1 | 3191.5 | 8089.1 | 9493.8 | 0 | 0 |
| image | 440 | 3.67 | 30.1 | 1800.3 | 5790 | 12407 | 43.4 | 0 |
| image-offline | 384 | 3.2 | 8 | 523.8 | 1202.4 | 1348.7 | 0 | 384 (502:384) |
| segment | 329 | 2.74 | 7.6 | 6471.6 | 14452.9 | 22744.1 | 1178.2 | 103 (409:103) |
| title | 239 | 1.99 | 9.5 | 522.2 | 6656.1 | 10421.8 | 1.8 | 28 (502:28) |
| telemetry | 149 | 1.24 | 2.6 | 3876.3 | 9186.7 | 9977.9 | 0 | 0 |
| suggest | 110 | 0.92 | 22.2 | 259.2 | 1174.1 | 2472.7 | 0.9 | 0 |
| search | 100 | 0.83 | 28.3 | 552.4 | 2295 | 2482.1 | 5.9 | 0 |
| api-other | 88 | 0.73 | 15 | 446.3 | 10056.3 | 10056.3 | 0.1 | 0 |
| grid | 68 | 0.57 | 15.4 | 9049.3 | 10147 | 10147 | 0 | 0 |
| state | 45 | 0.37 | 2.1 | 33.9 | 423.7 | 423.7 | 0.2 | 0 |
| boot | 45 | 0.37 | 3.3 | 35.2 | 424.8 | 424.8 | 0.1 | 0 |
| home | 38 | 0.32 | 32.7 | 3571.5 | 8913 | 8913 | 24.4 | 0 |
| playlist | 38 | 0.32 | 9 | 7018.8 | 7026.1 | 7026.1 | 3.4 | 14 (503:14) |
| library | 27 | 0.22 | 10.6 | 9047.9 | 10142.8 | 10142.8 | 25.1 | 0 |
| tv | 11 | 0.09 | 1.9 | 572.8 | 572.8 | 572.8 | 0.1 | 0 |
| person | 10 | 0.08 | 2.6 | 589.7 | 589.7 | 589.7 | 0.5 | 9 (503:9) |
| netprobe | 9 | 0.07 | 6.4 | 4108.4 | 4108.4 | 4108.4 | 48 | 0 |
| first-segment | 2 | 0.02 | 7840 | 8644 | 8644 | 8644 | 0 | 0 |
| direct | 1 | 0.01 | 13 | 13 | 13 | 13 | 577088 | 1 (0:1) |
| direct-first-byte | 1 | 0.01 | 15 | 15 | 15 | 15 | 0 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| image | 1230 | 2.5 | 563.96 | 4059.54 | 12523.94 |
| progress | 529 | 0.91 | 2.14 | 5.07 | 14.28 |
| health | 454 | 0.93 | 2.26 | 4.88 | 10.14 |
| segment | 329 | 5.28 | 5494.38 | 14452.68 | 19802.99 |
| title | 234 | 5.19 | 458.85 | 549.22 | 632.98 |
| api-other | 227 | 1.31 | 7.03 | 10.28 | 11.43 |
| telemetry | 147 | 1.16 | 3.24 | 4.16 | 6.49 |
| suggest | 133 | 21.6 | 303.52 | 1312.67 | 2841.63 |
| search | 124 | 25.19 | 331.87 | 1302.18 | 2841.65 |
| state | 45 | 0.84 | 1.31 | 1.85 | 1.85 |
| home | 38 | 27.73 | 193.96 | 277.09 | 277.09 |
| playlist | 38 | 4.33 | 102.87 | 381.36 | 381.36 |
| library | 27 | 1 | 17.85 | 19.23 | 19.23 |
| tv | 11 | 1 | 1.29 | 1.29 | 1.29 |
| direct | 1 | 684801.84 | 684801.84 | 684801.84 | 684801.84 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-direct | Greenland | 1089 | 0 | 0 |  | 3.1 | 0 | 0 | playing |
| web-direct | Arrival | 1164 | 0 | 0 |  | 2.56 | 0 | 0 | playing |
| web-jit | Caught Stealing | 7294 | 0 | 0 |  | 6.13 | 0 | 0 | playing |
| tv-offset | Inception | 4350 | 0 | 0 |  | 1.66 | 0 | 0 | playing |
| tv-direct | Eternity | 116 | 0 | 0 | 123 | 10.24 | 0 | 0 | playing |
| web-direct | The Amateur | 218 | 0 | 0 |  | 3.03 | 0 | 0 | playing |
| web-transcode | Disclosure Day | 3006 | 0 | 0 |  | 2.48 | 0 | 0 | playing |
| web-direct | Palmer | 100 | 0 | 0 |  | 3.18 | 0 | 0 | playing |
| tv-offset | Night Hunter | 62456 | 0 | 0 |  | 2.45 | 0 | 0 | playing |
| web-direct | Fountain of Youth | 313 | 0 | 0 |  | 3.16 | 0 | 0 | playing |
| web-jit | The Ministry of Ungentlemanl | 1198 | 0 | 0 |  | 2.32 | 0 | 0 | playing |
| web-transcode | Palmer | 12289 | 0 | 0 |  | 2.62 | 0 | 0 | playing |
| web-direct | Dracula A Love Tale | 1497 | 0 | 0 |  | 3.15 | 0 | 0 | playing |
| tv-direct | Avatar Movie | 2070 | 0 | 0 |  | 2.48 | 0 | 0 | playing |
| web-jit | Inception | 3170 | 0 | 125785 |  | 0 | 103 | 0 | stalled |
| tv-offset | The Ministry of Ungentlemanl | 10542 | 0 | 0 |  | 0.86 | 0 | 0 | playing |
| tv-offset | About Time | 10052 | 0 | 0 |  | 1.5 | 0 | 0 | playing |
| web-direct | The Curious Case of Benjamin | 202 | 0 | 0 |  | 3.16 | 0 | 0 | playing |
| tv-direct | The Voyeurs | 229 | 0 | 0 |  | 1.8 | 0 | 0 | playing |
| web-transcode | Predator Badlands | 82787 | 1 | 5693 |  | 2.2 | 0 | 7 | playing |
| web-transcode | Dracula A Love Tale | 82816 | 0 | 0 |  | 1.83 | 0 | 7 | playing |
| web-direct | Jolt | 632 | 0 | 0 |  | 3.14 | 0 | 0 | playing |
| web-jit | The Thursday Murder Club | 1838 | 0 | 0 |  | 2.42 | 0 | 0 | playing |
| web-direct | The Voyeurs | 202 | 0 | 0 |  | 3.13 | 0 | 0 | playing |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/cache/similar.json | 19 | 33470.5 |
| data/profiles.json | 45 | 1326.3 |
| data/cache/xray.json | 4 | 611.8 |
| data/watch-sessions.json | 43 | 332.6 |
| data/healer.json | 2 | 218.6 |
| data/sessions.json | 5 | 120 |
| data/usage/* | 50 | 36.4 |
| data/cache/trailers.json | 2 | 19.6 |
| data/cache/blur/* | 20 | 5.2 |
| data/telemetry-hours.json | 4 | 0.4 |
