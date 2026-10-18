# ramp — master@4862136f — evening

2026-10-18T13:48:58.422Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **4core** ({"affinity":"mask 85 (CPUs 0,2,4,6)"}), media real: 29 films, 8 shows. evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | API p95/p99 | pictures p95/p99 | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evening n=4 | 4 | 3 | 1 | 9.7/17995.9/19333.2 | 141.2/1140.7 | 19333/19420.3 | 1140.7/1152.21 | 9752.3 |  | 7876/18742 | 0 (0) | 150/101/33 | 15578 | 3634.06 | 560 | 0.30547 | 0.049 | 0.138 | 148 | 333 | 34 | 1895.4 | 0/0/0/0 | 99.1/4069 (PC starved) | 0.032 | 1.6/2.17 | **degraded**: browse p99 19333.2 ms > 1000; 2 event-loop stall(s) > 1 s; loop stalled 31156 ms (> 2 % of the window) |
| evening n=8 | 8 | 4 | 1.3 | 262.2/25016.7/29437 | 1125.2/3712 | 26421.1/31224.5 | 850.6/747 | 1117.7 | 89844 | 7876/89914 | 1 (0.3) | 156/92/34 | 18808 | 4388.01 | 937.1 | 0.41811000000000004 | 0.111 | 0.291 | 204 | 370 | 156 | 1987.5 | 0/0/0/0 | 98.6/4717 (PC starved) | 0.027 | 1.8/2.9 | **degraded**: browse p99 29437 ms > 1000; 1 stall(s) in 4 viewers; 1 stream refusal(s); 6 event-loop stall(s) > 1 s; loop stalled 37615 ms (> 2 % of the window) |
| evening n=16 | 16 | 8 | 1.5 | 3510.6/43057.4/46502.7 | 14606.4/16555.7 | 45281.6/47157.8 | 41.2/34.28 | 23319.1 |  | 6540/89914 | 1 (112.9) | 181/119/63 | 39821 | 4725.58 | 4371.8 | 0.77064 | 0.099 | 0.178 | 201 | 443 | 72.4 | 2790.9 | 0/0/10/0 | 99.2/4920 (PC starved) | 0.035 | 1.6/2.21 | **degraded**: browse p99 46502.7 ms > 1000; 10 × 429; 1 stall(s) in 8 viewers; 21 event-loop stall(s) > 1 s; loop stalled 79641 ms (> 2 % of the window) |
| evening n=32 | 32 | 16 | 4.9 | 36.1/5068.6/17533.7 | 8095.8/17671.5 | 2857.2/4594.4 | 17533.7/13522.85 | 2267.3 | 68 | 1695/89914 | 8 (387.1) | 86/42/18 | 22356 | 8864.17 | 4009.8 | 0.53596 | 0.166 | 1.087 | 253 | 614 | 168.1 | 9438.6 | 0/0/4/0 | 93.5/5552 (PC starved) | 0.044 | 4.9/8.22 | **degraded**: browse p99 17533.7 ms > 1000; 4 × 429; 8 stall(s) in 16 viewers; 5 stream refusal(s); 8 event-loop stall(s) > 1 s; loop stalled 44712 ms (> 2 % of the window) |

Requests in the last window (evening n=32), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress | 305 | 2.54 | 6.3 | 6294.7 | 9424.5 | 9765.1 | 0 | 0 |
| image-offline | 232 | 1.93 | 12.2 | 3328.9 | 4783.6 | 6122.9 | 0 | 232 (502:232) |
| image | 196 | 1.63 | 106.9 | 2857.2 | 4594.4 | 36280.5 | 40.7 | 0 |
| segment | 160 | 1.33 | 17.5 | 2267.3 | 37349.6 | 45204.3 | 952 | 93 (409:93) |
| title | 95 | 0.79 | 20.8 | 9782.1 | 14986.5 | 14986.5 | 2.1 | 0 |
| telemetry | 88 | 0.73 | 3.3 | 4909.5 | 9801.7 | 9801.7 | 0 | 0 |
| playlist | 85 | 0.71 | 4.9 | 3819.4 | 8815.4 | 8815.4 | 1.7 | 5 (503:5) |
| api-other | 57 | 0.47 | 19.5 | 2642.7 | 3521.7 | 3521.7 | 0.1 | 0 |
| search | 52 | 0.43 | 34.4 | 19231.2 | 20472.8 | 20472.8 | 5.2 | 2 (429:2) |
| grid | 44 | 0.37 | 20.4 | 4569.6 | 6833.1 | 6833.1 | 0 | 0 |
| suggest | 44 | 0.37 | 27.1 | 9224.8 | 10526.3 | 10526.3 | 0.9 | 0 |
| title-offline | 40 | 0.33 | 6.1 | 2650.1 | 6136.3 | 6136.3 | 0 | 40 (502:40) |
| home | 28 | 0.23 | 32.3 | 16335.6 | 17533.7 | 17533.7 | 23.3 | 2 (429:2) |
| state | 23 | 0.19 | 3 | 2522.5 | 4587.2 | 4587.2 | 0.2 | 0 |
| boot | 23 | 0.19 | 6.3 | 2529.9 | 4595.6 | 4595.6 | 0.1 | 0 |
| library | 14 | 0.12 | 15.6 | 4550.4 | 4550.4 | 4550.4 | 25.1 | 0 |
| tv | 6 | 0.05 | 45.5 | 4143.9 | 4143.9 | 4143.9 | 0.1 | 0 |
| person-offline | 2 | 0.02 | 1.8 | 5.9 | 5.9 | 5.9 | 0.1 | 2 (503:2) |
| first-segment | 1 | 0.01 | 68 | 68 | 68 | 68 | 0 | 0 |
| direct | 1 | 0.01 | 4146.1 | 4146.1 | 4146.1 | 4146.1 | 226816 | 1 (0:1) |
| direct-first-byte | 1 | 0.01 | 13311 | 13311 | 13311 | 13311 | 0 | 0 |
| netprobe | 1 | 0.01 | 1355.4 | 1355.4 | 1355.4 | 1355.4 | 48 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| image | 1104 | 2.52 | 652.92 | 2481.32 | 36279.34 |
| health | 387 | 0.82 | 4.11 | 59.57 | 98.91 |
| progress | 305 | 1.09 | 57.94 | 176.93 | 542.68 |
| segment | 160 | 2.8 | 764.09 | 37349.29 | 45203.96 |
| api-other | 136 | 1.88 | 89.89 | 214.6 | 333.07 |
| title | 127 | 7.25 | 5474.79 | 11134.64 | 11923.51 |
| telemetry | 87 | 1.11 | 14.85 | 177.28 | 177.28 |
| playlist | 85 | 2.28 | 31.93 | 466.21 | 466.21 |
| suggest | 80 | 86.54 | 4309.79 | 6689.04 | 6689.04 |
| search | 72 | 67.19 | 8920.04 | 10839.97 | 10839.97 |
| home | 28 | 32.17 | 12478.43 | 13522.85 | 13522.85 |
| state | 23 | 1.01 | 5.91 | 46.41 | 46.41 |
| library | 14 | 5.13 | 72.25 | 72.25 | 72.25 |
| tv | 6 | 1.82 | 20.39 | 20.39 | 20.39 |
| direct | 1 | 608759.71 | 608759.71 | 608759.71 | 608759.71 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-direct | Greenland | 7876 | 0 | 0 |  | 3.19 | 0 | 0 | seeking |
| web-jit | Caught Stealing | 18742 | 0 | 0 |  | 1.65 | 0 | 0 | playing |
| web-direct | Arrival | 6540 | 0 | 0 |  | 1.11 | 0 | 0 | playing |
| tv-offset | Inception | 89914 | 0 | 0 |  | 1.11 | 0 | 0 | playing |
| web-direct | The Amateur | 104 | 0 | 0 |  | 2.64 | 0 | 0 | playing |
| tv-direct | Eternity | 119 | 0 | 0 |  | 3.91 | 0 | 0 | playing |
| web-direct | Palmer | 1605 | 0 | 0 |  | 2.74 | 0 | 0 | playing |
| web-transcode | Disclosure Day | 24176 | 3 | 95000 |  | 0.64 | 0 | 0 | stalled |
| web-jit | The Ministry of Ungentlemanl | 1695 | 0 | 0 |  | 2.43 | 0 | 0 | playing |
| web-direct | Dracula A Love Tale | 107 | 0 | 0 |  | 1.42 | 0 | 0 | playing |
| tv-direct | Avatar Movie | 137 | 0 | 0 |  | 1.31 | 0 | 0 | playing |
| web-jit | Inception | 948 | 0 | 126159 |  | 0 | 93 | 0 | stalled |
| web-direct | Fountain of Youth | 311 | 0 | 0 |  | 1.45 | 0 | 0 | playing |
| web-transcode | Palmer | 57159 | 0 | 0 |  | 2.96 | 0 | 5 | playing |
| tv-offset | The Ministry of Ungentlemanl | 12113 | 2 | 79408 |  | 1.21 | 0 | 0 | stalled |
| tv-offset | Night Hunter | 13279 | 3 | 86574 |  | 0.39 | 0 | 0 | stalled |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/cache/similar.json | 15 | 16596.9 |
| data/profiles.json | 44 | 838.6 |
| data/cache/xray.json | 4 | 607.9 |
| data/watch-sessions.json | 43 | 221.1 |
| data/healer.json | 2 | 196.6 |
| data/sessions.json | 12 | 192 |
| data/healer.json.good1 | 1 | 108.7 |
| data/cache/trailers.json | 4 | 38.7 |
| data/usage/* | 56 | 27.9 |
| data/profiles.json.good1 | 1 | 18.8 |