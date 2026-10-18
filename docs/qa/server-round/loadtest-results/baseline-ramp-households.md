# ramp — master@4862136f — households

2026-10-18T13:18:11.527Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **full**, media real: 29 films, 8 shows. many households: n profiles, mostly idle (WebSocket, netprobe, usage, TV version/tuning polls), 25 % of browsers browsing, 2 streams

| window | hh | streams | browse req/s | browse p50/p95/p99 ms | API p95/p99 | pictures p95/p99 | Home p99 client/server | segment p95 | 1st seg p50 | TTFF p50/max | stalls (s) | loop stalls >50/>100/>250 ms | stall ms/min | longest stall ms | healthz p99 | ELU | server cores | ffmpeg cores | RSS MB | handles | fs calls/s | written KB/min | 5xx/net/429/503 | PC CPU % / free MB min | driver cores | library disk busy % / MB/s (whole PC) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| households n=15 | 15 | 2 | 0.9 | 18.7/319.3/457 | 61.1/132.5 | 379.3/722 | 19.8/19.77 |  |  | 100/118 | 0 (0) | 2/0/0 | 62 | 63.14 | 11.5 | 0.03407 | 0.05 | 0.002 | 154 | 370 | 25.2 | 2792.3 | 0/0/0/0 | 57.4/9349 | 0.021 | 3.8/7.5 | ok |
| households n=30 | 30 | 2 | 1.6 | 14.4/348.2/530.2 | 64.3/85 | 472.7/594.3 | 45.3/45.49 |  |  | 100/118 | 0 (0) | 9/1/0 | 292 | 102.06 | 16.2 | 0.05441 | 0.079 | 0.002 | 192 | 422 | 33.5 | 2913.6 | 0/0/0/0 | 67.1/9097 | 0.021 | 1.7/2.08 | ok |
| households n=45 | 45 | 2 | 2.6 | 16.1/269.2/644.6 | 47.1/69.5 | 583.9/1586.7 | 26.6/26.17 |  |  | 100/118 | 0 (0) | 14/4/0 | 732 | 205.28 | 32.5 | 0.07928 | 0.091 | 0.006 | 207 | 489 | 39.4 | 6038.2 | 0/0/0/0 | 86.7/8485 (PC starved) | 0.028 | 2/2.6 | ok |
| households n=60 | 60 | 2 | 3.3 | 11.4/193.9/318.5 | 29.5/63.2 | 297.1/340.2 | 25.9/25.2 |  |  | 100/118 | 0 (0) | 9/1/1 | 395 | 282.81 | 15.2 | 0.060950000000000004 | 0.085 | 0 | 189 | 554 | 62.8 | 5274.1 | 0/0/0/0 | 66.3/8648 | 0.019 | 4/8.06 | ok |

Requests in the last window (households n=60), as the devices saw them:

| group | n | req/s | p50 | p95 | p99 | max | KB avg | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| image-offline | 133 | 1.11 | 5.4 | 33.1 | 78.7 | 98.3 | 0 | 133 (502:133) |
| image | 125 | 1.04 | 27.8 | 297.1 | 340.2 | 348 | 54 | 0 |
| suggest | 56 | 0.47 | 9.2 | 29.2 | 87.4 | 87.4 | 0.9 | 0 |
| title | 55 | 0.46 | 7.2 | 30.7 | 41 | 41 | 2 | 0 |
| telemetry | 49 | 0.41 | 1.6 | 7.2 | 14 | 14 | 0 | 0 |
| progress | 48 | 0.4 | 1.6 | 4.6 | 12.4 | 12.4 | 0 | 0 |
| search | 48 | 0.4 | 17.7 | 35.2 | 89.4 | 89.4 | 7.1 | 0 |
| api-other | 39 | 0.32 | 10.8 | 53.1 | 56.9 | 56.9 | 0 | 0 |
| netprobe | 29 | 0.24 | 1.6 | 7.9 | 28.1 | 28.1 | 48 | 0 |
| title-offline | 19 | 0.16 | 3.7 | 26 | 26 | 26 | 0 | 19 (502:19) |
| grid | 18 | 0.15 | 8.4 | 18.5 | 18.5 | 18.5 | 0 | 0 |
| state | 14 | 0.12 | 1.4 | 22.7 | 22.7 | 22.7 | 0.1 | 0 |
| boot | 14 | 0.12 | 2.2 | 23.9 | 23.9 | 23.9 | 0.1 | 0 |
| home | 12 | 0.1 | 16.4 | 25.9 | 25.9 | 25.9 | 26.5 | 0 |
| library | 8 | 0.07 | 6.3 | 11.9 | 11.9 | 11.9 | 25.1 | 0 |
| person-offline | 6 | 0.05 | 1.8 | 4.9 | 4.9 | 4.9 | 0.1 | 6 (503:6) |
| tv | 2 | 0.02 | 1.4 | 4.6 | 4.6 | 4.6 | 0.1 | 0 |

Server side (request -> response finished):

| route group (server side) | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| image | 603 | 1.9 | 156.7 | 310.17 | 453.28 |
| health | 563 | 0.7 | 1.59 | 1.93 | 2.57 |
| api-other | 104 | 0.82 | 3.45 | 5.78 | 6.11 |
| title | 76 | 2.59 | 13.97 | 40.89 | 40.89 |
| suggest | 56 | 8.9 | 28.89 | 87.25 | 87.25 |
| telemetry | 49 | 1.02 | 2.35 | 2.81 | 2.81 |
| progress | 48 | 0.78 | 1.9 | 1.96 | 1.96 |
| search | 48 | 11.62 | 23.42 | 44.34 | 44.34 |
| state | 14 | 0.66 | 1.46 | 1.46 | 1.46 |
| home | 12 | 16.2 | 25.2 | 25.2 | 25.2 |
| library | 8 | 5.61 | 11.29 | 11.29 | 11.29 |
| tv | 2 | 1.02 | 1.15 | 1.15 | 1.15 |

Viewers:

| viewer | title | TTFF ms | stalls | stall ms | seeks (ms) | Mbit/s | seg fails | refused | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tv-direct | Greenland | 118 | 0 | 0 |  | 1.54 | 0 | 0 | playing |
| web-direct | Arrival | 100 | 0 | 0 |  | 2.11 | 0 | 0 | playing |

Largest writers to data/:

| data/ file | writes | KB |
| --- | --- | --- |
| data/cache/similar.json | 8 | 8621 |
| data/profiles.json | 27 | 809.2 |
| data/sessions.json | 12 | 360 |
| data/cache/xray.json | 2 | 306.7 |
| data/healer.json | 2 | 216.1 |
| data/healer.json.good1 | 1 | 108.6 |
| data/sessions.json.good1 | 1 | 30 |
| data/profiles.json.good1 | 1 | 30 |
| data/cache/trailers.json | 3 | 28.7 |
| data/usage/* | 50 | 17.8 |