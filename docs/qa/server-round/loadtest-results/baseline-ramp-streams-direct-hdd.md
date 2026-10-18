# ramp — master@4862136f — streams

2026-10-18T12:53:00.685Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **full**, media real: 29 films, 8 shows. streams heavy: n streams on devices of their own (10 % encoded), 4 households browsing beside them

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | API p95/p99 | pictures p95/p99 | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| streams n=2 | 4 | 2 | 1.3 | 32.9/1182.9/1918.3 | 151.5/319.3 | 1909/2527.6 | 33.2/31.08 |  |  | 102/121 | 0 (0) | 18/7/1 | 969 | 311.27 | 79 | 0.07775 | 0.077 | 0.011 | 177 | 336 | 33.7 | 2621.5 | 0/0/0/0 | 98.3/8634 (PC starved) | 0.021 | 9.4/14.73 | **degraded**: browse p99 1918.3 ms > 1000 |
| streams n=4 | 4 | 4 | 0.7 | 26.5/885.8/1450.7 | 69.6/124 | 1314.4/1450.7 | 46.3/46.22 |  |  | 105/121 | 0 (0) | 10/1/0 | 332 | 104.04 | 19.8 | 0.05129 | 0.057 | 0.001 | 156 | 343 | 35.4 | 1208.4 | 0/0/0/0 | 91.8/6225 (PC starved) | 0.028 | 3.6/4.16 | **degraded**: browse p99 1450.7 ms > 1000 |
| streams n=8 | 4 | 8 | 1.1 | 22.6/374.9/627.9 | 120.7/151.6 | 627.9/936.1 | 57.2/56.8 |  |  | 106/250 | 0 (0) | 13/4/1 | 902 | 790.18 | 38.2 | 0.09562999999999999 | 0.1 | 0.004 | 169 | 362 | 62.9 | 2161.2 | 0/0/0/0 | 99.7/6943 (PC starved) | 0.035 | 2.5/4.39 | ok |
| streams n=12 | 4 | 12 | 0.8 | 14.9/278.6/747.8 | 75/90.1 | 655.2/747.8 | 90.1/89.69 |  |  | 106/250 | 0 (0) | 8/2/0 | 383 | 235.72 | 27 | 0.06531 | 0.087 | 0.002 | 186 | 371 | 101.8 | 1158.8 | 0/0/0/0 | 89/9310 (PC starved) | 0.039 | 5.6/5.34 | ok |

Requests in the last window (streams n=12), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| progress | 288 | 2.4 | 3 | 15.8 | 93.8 | 167.7 | 0 | 0 |
| image | 27 | 0.22 | 44.6 | 655.2 | 747.8 | 747.8 | 32.2 | 0 |
| suggest | 13 | 0.11 | 12.2 | 84.3 | 84.3 | 84.3 | 0.9 | 0 |
| search | 13 | 0.11 | 26.7 | 76.3 | 76.3 | 76.3 | 6.7 | 0 |
| image-offline | 11 | 0.09 | 12.3 | 71.5 | 71.5 | 71.5 | 0 | 11 (502:11) |
| telemetry | 11 | 0.09 | 2.3 | 94.2 | 94.2 | 94.2 | 0 | 0 |
| grid | 10 | 0.08 | 8.3 | 25.1 | 25.1 | 25.1 | 0 | 0 |
| api-other | 10 | 0.08 | 3.8 | 25.9 | 25.9 | 25.9 | 0.2 | 0 |
| title | 6 | 0.05 | 20.6 | 40.5 | 40.5 | 40.5 | 1.3 | 0 |
| home | 5 | 0.04 | 47.5 | 90.1 | 90.1 | 90.1 | 33.5 | 0 |
| netprobe | 4 | 0.03 | 1.7 | 2.7 | 2.7 | 2.7 | 48 | 0 |
| library | 3 | 0.02 | 11 | 11.2 | 11.2 | 11.2 | 25.1 | 0 |
| tv | 3 | 0.02 | 4.3 | 5.2 | 5.2 | 5.2 | 0.1 | 0 |
| state | 2 | 0.02 | 2 | 2.7 | 2.7 | 2.7 | 0.5 | 0 |
| boot | 2 | 0.02 | 4.7 | 4.7 | 4.7 | 4.7 | 0.1 | 0 |
| title-offline | 2 | 0.02 | 6.7 | 9 | 9 | 9 | 0 | 2 (502:2) |
| person-offline | 1 | 0.01 | 2.1 | 2.1 | 2.1 | 2.1 | 0.1 | 1 (503:1) |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| health | 564 | 0.84 | 1.81 | 3.72 | 13.09 |
| progress | 288 | 0.91 | 1.81 | 3.13 | 7.64 |
| image | 72 | 3.56 | 649.88 | 922.91 | 922.91 |
| api-other | 26 | 1.67 | 3.63 | 11.02 | 11.02 |
| suggest | 13 | 11.69 | 83.98 | 83.98 | 83.98 |
| search | 13 | 17.41 | 28.3 | 28.3 | 28.3 |
| telemetry | 11 | 1.19 | 2.68 | 2.68 | 2.68 |
| title | 9 | 5.5 | 30.18 | 30.18 | 30.18 |
| home | 5 | 47.27 | 89.69 | 89.69 | 89.69 |
| library | 3 | 9.91 | 10.38 | 10.38 | 10.38 |
| tv | 3 | 1.72 | 3.67 | 3.67 | 3.67 |
| state | 2 | 1.11 | 2.06 | 2.06 | 2.06 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-direct | Greenland | 121 | 0 | 0 |  | 3.1 | 0 | 0 | playing |
| web-direct | Arrival | 102 | 0 | 0 |  | 2.12 | 0 | 0 | playing |
| tv-direct | Troy | 112 | 0 | 0 |  | 2.46 | 0 | 0 | playing |
| web-direct | The Voyeurs | 105 | 0 | 0 |  | 2.67 | 0 | 0 | playing |
| tv-direct | Fountain of Youth | 238 | 0 | 0 |  | 3.15 | 0 | 0 | playing |
| web-direct | The Curious Case of Benjamin | 103 | 0 | 0 |  | 2.66 | 0 | 0 | playing |
| web-direct | Predator Badlands | 106 | 0 | 0 |  | 2.4 | 0 | 0 | playing |
| tv-direct | Project Hail Mary | 250 | 0 | 0 |  | 2.95 | 0 | 0 | playing |
| tv-direct | Predator Badlands | 111 | 0 | 0 |  | 2.8 | 0 | 0 | playing |
| web-direct | My Oxford Year | 100 | 0 | 0 |  | 2.7 | 0 | 0 | playing |
| web-direct | Honey Don't! | 100 | 0 | 0 |  | 2.7 | 0 | 0 | playing |
| tv-direct | The Voyeurs | 114 | 0 | 0 |  | 3.09 | 0 | 0 | playing |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/cache/similar.json | 2 | 1669.2 |
| data/profiles.json | 58 | 254.4 |
| data/watch-sessions.json | 57 | 220.7 |
| data/healer.json | 2 | 143.2 |
| data/sessions.json | 6 | 12 |
| data/usage/* | 18 | 6.8 |
| data/profiles.json.good1 | 1 | 4.4 |
| data/watch-sessions.json.good1 | 1 | 3.9 |
| data/sessions.json.good1 | 1 | 2 |
| data/cache/blur/* | 2 | 0.5 |