# ramp — master@4862136f — evening

2026-10-18T13:35:19.294Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **full**, media real: 29 films, 8 shows. evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | API p95/p99 | pictures p95/p99 | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evening n=4 | 4 | 3 | 0.4 | 57.5/631.5/1274.1 | 553/561.8 | 1274.1/1274.1 | 59/58.6 | 2481.1 |  | 128/1062 | 0 (0) | 45/18/3 | 4083 | 2415.82 | 177.5 | 0.11039 | 0.117 | 0.714 | 176 | 334 | 44.3 | 1510.3 | 0/0/0/0 | 93.5/5155 (PC starved) | 0.025 | 1.3/1.79 | **degraded**: browse p99 1274.1 ms > 1000; 1 event-loop stall(s) > 1 s; loop stalled 8166 ms (> 2 % of the window) |
| evening n=8 | 8 | 4 | 2.2 | 19.1/280.4/688 | 70.5/124.6 | 339.1/908.9 | 37.8/37.52 | 17.6 |  | 128/2267 | 0 (0) | 9/0/0 | 286 | 93.51 | 14.9 | 0.07535 | 0.134 | 1.391 | 177 | 369 | 54.7 | 2899.3 | 0/0/0/0 | 70.9/8893 | 0.023 | 12.6/18.51 | ok |
| evening n=16 | 16 | 8 | 3.2 | 17.1/848.6/1530.1 | 96.1/505.4 | 1437.5/1757.9 | 30.6/29.85 | 66.6 |  | 747/3932 | 0 (0) | 34/23/12 | 4907 | 1272.49 | 338.1 | 0.16756000000000001 | 0.128 | 1.405 | 195 | 413 | 80.3 | 6601.1 | 0/0/0/0 | 71.5/8871 | 0.036 | 5.2/9.51 | **degraded**: browse p99 1530.1 ms > 1000; 1 event-loop stall(s) > 1 s; loop stalled 9813 ms (> 2 % of the window) |
| evening n=24 | 24 | 12 | 5.5 | 15.8/306.6/532.8 | 67/98.3 | 477/972.1 | 87.7/45.05 | 122.6 |  | 791/3932 | 0 (0) | 30/9/1 | 1426 | 513.04 | 69.3 | 0.18503999999999998 | 0.283 | 2.019 | 213 | 488 | 182.2 | 9823.3 | 0/0/0/0 | 92.2/7487 (PC starved) | 0.06 | 10.3/17.23 | **degraded**: loop stalled 2852 ms (> 2 % of the window) |
| evening n=32 | 32 | 16 | 7.5 | 17.6/371.5/745.3 | 89.2/312.3 | 673.6/1952.5 | 661.5/78.04 | 309.5 |  | 815/3932 | 0 (0) | 42/28/11 | 4392 | 1058.03 | 285 | 0.2705 | 0.362 | 3.156 | 223 | 566 | 330.3 | 6913.8 | 0/0/0/0 | 99.2/7219 (PC starved) | 0.073 | 8.1/14.69 | **degraded**: 1 event-loop stall(s) > 1 s; loop stalled 8791 ms (> 2 % of the window) |
| evening n=48 | 48 | 24 | 9.8 | 30.5/871.5/2449.5 | 363.4/968.5 | 1733.6/3018.8 | 1052.6/99.81 | 1156.5 |  | 815/5187 | 1 (52.4) | 141/81/37 | 16121 | 1670.88 | 765.7 | 0.48573 | 0.403 | 4.194 | 247 | 696 | 235.7 | 22398.3 | 0/0/0/0 | 97.5/6655 (PC starved) | 0.087 | 16.3/22.01 | **degraded**: browse p99 2449.5 ms > 1000; 1 stall(s) in 24 viewers; 3 event-loop stall(s) > 1 s; loop stalled 32242 ms (> 2 % of the window) |

Requests in the last window (evening n=48), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress | 567 | 4.72 | 7.4 | 418.8 | 519 | 793.8 | 0 | 0 |
| image-offline | 452 | 3.77 | 9.6 | 426.5 | 988.1 | 1440.3 | 0 | 452 (502:452) |
| image | 406 | 3.38 | 101.5 | 1733.6 | 3018.8 | 5696.2 | 34.8 | 0 |
| segment | 344 | 2.87 | 17.3 | 1156.5 | 2688.3 | 7007.7 | 1182.9 | 83 (409:83) |
| telemetry | 161 | 1.34 | 3 | 406.5 | 729.5 | 902.2 | 0 | 0 |
| suggest | 161 | 1.34 | 21 | 184.1 | 718.9 | 1204.7 | 1 | 0 |
| title | 147 | 1.22 | 13.5 | 306.7 | 934.4 | 1630.9 | 2.2 | 0 |
| search | 143 | 1.19 | 39.1 | 297.8 | 968.5 | 1205.2 | 7.1 | 0 |
| api-other | 89 | 0.74 | 15.7 | 467.4 | 1467.8 | 1467.8 | 0.1 | 0 |
| grid | 85 | 0.71 | 17.4 | 520.3 | 1384.6 | 1384.6 | 0 | 0 |
| title-offline | 68 | 0.57 | 5.4 | 102.1 | 429.5 | 429.5 | 0 | 68 (502:68) |
| state | 35 | 0.29 | 3.2 | 32 | 34.1 | 34.1 | 0.1 | 0 |
| boot | 35 | 0.29 | 4.2 | 38 | 53.2 | 53.2 | 0.1 | 0 |
| home | 32 | 0.27 | 34.9 | 528.9 | 1052.6 | 1052.6 | 24.6 | 0 |
| library | 31 | 0.26 | 13.1 | 510.3 | 541.3 | 541.3 | 25.1 | 0 |
| tv | 14 | 0.12 | 3.6 | 796.8 | 796.8 | 796.8 | 0.1 | 0 |
| playlist | 13 | 0.11 | 3.7 | 1478 | 1478 | 1478 | 11.4 | 0 |
| netprobe | 13 | 0.11 | 120.1 | 556.2 | 556.2 | 556.2 | 48 | 0 |
| person-offline | 10 | 0.08 | 3.1 | 483.4 | 483.4 | 483.4 | 0.1 | 10 (503:10) |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| image | 1549 | 2.32 | 593.95 | 2141.83 | 5649.64 |
| progress | 567 | 0.84 | 3.01 | 7.21 | 25.72 |
| health | 473 | 0.79 | 2.04 | 4.74 | 7.65 |
| segment | 344 | 10.74 | 1043.73 | 2661.39 | 6676.88 |
| api-other | 232 | 1.42 | 8.73 | 19.39 | 23.27 |
| title | 215 | 4.19 | 116.48 | 370.77 | 584.3 |
| suggest | 202 | 18.84 | 140.98 | 567.05 | 1380.25 |
| telemetry | 161 | 1 | 3.53 | 6.34 | 8.49 |
| search | 160 | 29.34 | 178.66 | 559.35 | 753.52 |
| state | 35 | 0.86 | 12.45 | 13.07 | 13.07 |
| home | 32 | 23.11 | 82.5 | 99.81 | 99.81 |
| library | 31 | 9.39 | 23.86 | 36.88 | 36.88 |
| tv | 14 | 1.14 | 2.29 | 2.29 | 2.29 |
| playlist | 13 | 2.71 | 1434.52 | 1434.52 | 1434.52 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| web-direct | Arrival | 106 | 0 | 0 |  | 2.13 | 0 | 0 | playing |
| web-jit | Caught Stealing | 1062 | 0 | 0 |  | 3.98 | 0 | 0 | playing |
| tv-direct | Greenland | 128 | 0 | 0 |  | 3.25 | 0 | 0 | playing |
| tv-offset | Inception | 2267 | 0 | 0 |  | 2.02 | 0 | 0 | seeking |
| web-direct | Palmer | 321 | 0 | 0 |  | 2.73 | 0 | 0 | playing |
| web-direct | The Amateur | 1255 | 0 | 0 |  | 2.62 | 0 | 0 | playing |
| tv-direct | Eternity | 747 | 0 | 0 |  | 5.36 | 0 | 0 | playing |
| web-transcode | Disclosure Day | 3932 | 0 | 0 |  | 2.63 | 0 | 0 | playing |
| web-transcode | Palmer | 1691 | 0 | 0 |  | 2.37 | 0 | 0 | playing |
| web-direct | Fountain of Youth | 103 | 0 | 0 |  | 2.66 | 0 | 0 | playing |
| web-jit | The Ministry of Ungentlemanl | 958 | 0 | 0 |  | 2.92 | 0 | 0 | playing |
| tv-offset | Night Hunter | 791 | 0 | 0 |  | 2.3 | 0 | 0 | playing |
| web-jit | Inception | 3271 | 1 | 52384 |  | 0.29 | 83 | 0 | stalled |
| tv-offset | The Ministry of Ungentlemanl | 2901 | 0 | 0 |  | 0.86 | 0 | 0 | playing |
| web-direct | Dracula A Love Tale | 815 | 0 | 0 |  | 2.67 | 0 | 0 | playing |
| tv-direct | Avatar Movie | 543 | 0 | 0 |  | 2.57 | 0 | 0 | playing |
| web-direct | Jolt | 110 | 0 | 0 |  | 2.82 | 0 | 0 | playing |
| web-direct | The Curious Case of Benjamin | 100 | 0 | 0 |  | 2.8 | 0 | 0 | playing |
| web-direct | The Voyeurs | 200 | 0 | 0 |  | 2.79 | 0 | 0 | playing |
| web-transcode | Dracula A Love Tale | 1243 | 0 | 0 |  | 3.04 | 0 | 0 | playing |
| web-jit | The Thursday Murder Club | 1229 | 0 | 0 |  | 1.39 | 0 | 0 | playing |
| web-transcode | Predator Badlands | 1270 | 0 | 0 |  | 2.98 | 0 | 0 | playing |
| tv-direct | The Voyeurs | 213 | 0 | 0 |  | 3.1 | 0 | 0 | playing |
| tv-offset | About Time | 5187 | 0 | 0 |  | 2.99 | 0 | 0 | playing |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/cache/similar.json | 23 | 42187.4 |
| data/profiles.json | 33 | 995.6 |
| data/cache/xray.json | 5 | 770.5 |
| data/sessions.json | 15 | 360 |
| data/healer.json | 2 | 218.4 |
| data/watch-sessions.json | 25 | 193.3 |
| data/usage/* | 62 | 36.9 |
| data/cache/trailers.json | 3 | 28.9 |
| data/cache/blur/* | 19 | 5 |
| data/telemetry-hours.json | 4 | 0.4 |