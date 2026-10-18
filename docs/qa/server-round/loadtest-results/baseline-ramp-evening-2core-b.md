# ramp — master@4862136f — evening

2026-10-18T14:02:31.136Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **2core** ({"affinity":"mask 5 (CPUs 0,2)"}), media real: 29 films, 8 shows. evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | API p95/p99 | pictures p95/p99 | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evening n=4 | 4 | 3 | 0.2 | 2713.1/21023.7/21023.7 | 9905.4/9905.4 | 21023.7/21023.7 | 63.1/63.45 | 9953.7 |  | 222/2408 | 0 (0) | 125/77/32 | 18376 | 5268.61 | 936.3 | 0.34364 | 0.062 | 0.126 | 142 | 323 | 27.9 | 1156.3 | 0/0/0/0 | 92.7/6458 (PC starved) | 0.025 | 1.3/1.82 | **degraded**: browse p99 21023.7 ms > 1000; 6 event-loop stall(s) > 1 s; loop stalled 36753 ms (> 2 % of the window) |
| evening n=8 | 8 | 4 | 2.7 | 26.7/12252.1/22931.5 | 476.4/785.7 | 21307.1/24027.6 | 131.9/118.88 | 2206.7 | 42872 | 222/52129 | 1 (1.8) | 132/66/23 | 10582 | 972.23 | 511.2 | 0.31912 | 0.149 | 0.812 | 189 | 382 | 172.2 | 3029.6 | 0/0/0/0 | 79.8/7936 | 0.028 | 9.4/13.43 | **degraded**: browse p99 22931.5 ms > 1000; 1 stall(s) in 4 viewers; loop stalled 21164 ms (> 2 % of the window) |
| evening n=16 | 16 | 8 | 3.6 | 118.3/41605.8/50583.2 | 724.3/10210.7 | 44508.4/51611.8 | 784/721.23 | 41300.7 | 66138 | 31765/66140 | 4 (91.6) | 291/155/63 | 26725 | 1915.51 | 900.4 | 0.6331 | 0.106 | 0.188 | 216 | 464 | 106.7 | 2254.8 | 0/0/0/0 | 99.9/6625 (PC starved) | 0.045 | 6.8/12.14 | **degraded**: browse p99 50583.2 ms > 1000; 4 stall(s) in 8 viewers; 4 event-loop stall(s) > 1 s; loop stalled 53449 ms (> 2 % of the window) |
| evening n=32 | 32 | 16 | 5.7 | 948.8/51968.8/60022.4 | 4497/10540.7 | 60009.5/60038.3 | 3696.8/577.64 | 39348.6 | 39356 | 31765/66140 | 15 (463.5) | 193/136/92 | 55359 | 5633.36 | 3841.6 | 0.99717 | 0.103 | 0.112 | 226 | 637 | 89.7 | 3600.6 | 0/25/0/0 | 99.8/6163 (PC starved) | 0.043 | 4.7/5.8 | **degraded**: browse p99 60022.4 ms > 1000; browse errors 25/679; 15 stall(s) in 16 viewers; 3 viewer(s) never started; 20 stream refusal(s); 33 event-loop stall(s) > 1 s; loop stalled 110717 ms (> 2 % of the window) |

Requests in the last window (evening n=32), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| image | 301 | 2.51 | 2922.1 | 60009.5 | 60038.3 | 60152.3 | 31.4 | 25 (0:25) |
| progress | 223 | 1.86 | 1051.5 | 3726.6 | 4524.8 | 6707.2 | 0 | 0 |
| image-offline | 183 | 1.52 | 261.6 | 2222.5 | 3730.6 | 4673.1 | 0 | 183 (502:183) |
| grid | 163 | 1.36 | 516.1 | 3086.9 | 6445.2 | 6748.8 | 0 | 0 |
| segment | 97 | 0.81 | 1112.2 | 39348.6 | 60016.5 | 60016.5 | 641.7 | 60 (0:2 409:58) |
| telemetry | 56 | 0.47 | 1352.5 | 3465.6 | 4904.8 | 4904.8 | 0 | 0 |
| playlist | 56 | 0.47 | 764.1 | 22787.8 | 25748 | 25748 | 1.7 | 28 (500:10 503:18) |
| boot | 48 | 0.4 | 465.9 | 3167.2 | 3167.3 | 3167.3 | 0 | 0 |
| api-other | 46 | 0.38 | 121.1 | 2931.2 | 4216.5 | 4216.5 | 0.1 | 0 |
| library | 43 | 0.36 | 638 | 4018.3 | 5574.8 | 5574.8 | 25.1 | 0 |
| tv | 30 | 0.25 | 280.9 | 1691.2 | 2031 | 2031 | 0.1 | 15 (404:15) |
| title | 23 | 0.19 | 1638.6 | 7261 | 8171.7 | 8171.7 | 2 | 0 |
| netprobe | 16 | 0.13 | 310.3 | 1477.4 | 1477.4 | 1477.4 | 48 | 0 |
| search | 10 | 0.08 | 8463.8 | 13128.2 | 13128.2 | 13128.2 | 5.5 | 0 |
| title-offline | 9 | 0.07 | 561.8 | 3432 | 3432 | 3432 | 0 | 9 (502:9) |
| state | 6 | 0.05 | 387 | 2299.5 | 2299.5 | 2299.5 | 0.2 | 0 |
| home | 5 | 0.04 | 144.9 | 3696.8 | 3696.8 | 3696.8 | 26.7 | 0 |
| suggest | 4 | 0.03 | 4227 | 7710.3 | 7710.3 | 7710.3 | 0.6 | 0 |
| first-segment | 2 | 0.02 | 39356 | 55713 | 55713 | 55713 | 0 | 0 |
| person-offline | 1 | 0.01 | 147.9 | 147.9 | 147.9 | 147.9 | 0.1 | 1 (503:1) |
| direct | 1 | 0.01 | 25.6 | 25.6 | 25.6 | 25.6 | 167552 | 0 |
| direct-first-byte | 1 | 0.01 | 197 | 197 | 197 | 197 | 0 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| image | 663 | 21.57 | 51076.68 | 64260.9 | 66372.5 |
| api-other | 269 | 3.36 | 90.84 | 279.56 | 321.6 |
| progress | 221 | 1.53 | 73.43 | 116.57 | 139.66 |
| health | 133 | 1.21 | 39.46 | 59.1 | 105.42 |
| segment | 96 | 24.24 | 38690.03 | 63406.55 | 63406.55 |
| playlist | 54 | 255.67 | 21077.42 | 22819.41 | 22819.41 |
| telemetry | 50 | 2.82 | 209.76 | 220.53 | 220.53 |
| library | 43 | 1.54 | 101.17 | 2303.46 | 2303.46 |
| title | 32 | 102.6 | 4909.26 | 5185.48 | 5185.48 |
| tv | 30 | 1.14 | 28.45 | 71.46 | 71.46 |
| search | 28 | 1582.73 | 6659.65 | 7107.96 | 7107.96 |
| suggest | 25 | 935.45 | 3753.29 | 4246.89 | 4246.89 |
| state | 6 | 1.07 | 122.7 | 122.7 | 122.7 |
| home | 4 | 8.83 | 577.64 | 577.64 | 577.64 |
| direct | 1 | 593061.78 | 593061.78 | 593061.78 | 593061.78 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-direct | Greenland | 222 | 0 | 0 |  | 1.94 | 0 | 0 | playing |
| web-jit | Caught Stealing | 2408 | 3 | 41840 | 6150 | 1.79 | 0 | 0 | playing |
| web-direct | Arrival | 102 | 1 | 18615 | 563 | 2.06 | 0 | 0 | playing |
| tv-offset | Inception | 52129 | 0 | 0 |  | 1.41 | 0 | 0 | playing |
| web-transcode | Disclosure Day | 66140 | 0 | 127212 |  | 0 | 2 | 0 | stalled |
| web-direct | The Amateur | 32540 | 0 | 0 |  | 2.07 | 0 | 0 | playing |
| web-direct | Palmer | 31765 | 0 | 0 |  | 2 | 0 | 0 | playing |
| tv-direct | Eternity | 36113 | 1 | 27828 |  | 1.56 | 0 | 0 | stalled |
| web-jit | Inception | 39457 | 1 | 105303 |  | 0.16 | 58 | 0 | stalled |
| web-jit | The Ministry of Ungentlemanl | 55816 | 3 | 36026 |  | 0.89 | 0 | 0 | stalled |
| web-direct | Fountain of Youth | 20562 | 2 | 41451 |  | 2.04 | 0 | 0 | playing |
| tv-offset | Night Hunter |  | 0 | 0 |  | 0 | 0 | 1 | starting |
| tv-offset | The Ministry of Ungentlemanl |  | 0 | 0 |  | 0 | 0 | 1 | starting |
| web-direct | Dracula A Love Tale | 28969 | 2 | 36046 |  | 2.05 | 0 | 0 | playing |
| tv-direct | Avatar Movie | 28288 | 2 | 29158 |  | 2.03 | 0 | 0 | playing |
| web-transcode | Palmer |  | 0 | 0 |  | 0 | 0 | 18 | starting |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/cache/similar.json | 7 | 6233.5 |
| data/profiles.json | 31 | 567 |
| data/watch-sessions.json | 33 | 169.6 |
| data/sessions.json | 5 | 80 |
| data/healer.json | 1 | 65 |
| data/healer.json.good1 | 1 | 65 |
| data/usage/* | 50 | 20.1 |
| data/telemetry-hours.json | 4 | 0.8 |