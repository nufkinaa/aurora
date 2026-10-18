# A/B: master (A) vs srv-storage (B) — evening n=16, 6 runs interleaved A B B A A B

| metric | A median | B median | B vs A | call | A runs | B runs |
| --- | --- | --- | --- | --- | --- | --- |
| browse p50 ms | 30.5 | 24.2 | -20.7 % | overlap | 35.6 / 19.5 / 30.5 | 21 / 118.1 / 24.2 |
| browse p95 ms | 3268.3 | 28383.3 | +768.4 % | overlap | 3268.3 / 12991.5 / 3150 | 2880.8 / 52217.5 / 28383.3 |
| browse p99 ms | 17163.1 | 36513.3 | +112.7 % | overlap | 17163.1 / 20451.7 / 8146 | 17331.9 / 63151 / 36513.3 |
| API p95 ms (browse minus pictures) |  |  |  |  |  |  |
| API p99 ms |  |  |  |  |  |  |
| pictures p95 ms | 14045.8 | 35415.1 | +152.1 % | overlap | 14045.8 / 20180.1 / 7392.4 | 15715 / 62324.9 / 35415.1 |
| pictures p99 ms | 21317.7 | 37627.4 | +76.5 % | B worse (no overlap) | 21317.7 / 22521.3 / 9732.4 | 22900 / 63243.7 / 37627.4 |
| Home p99 ms (client) | 1402.3 | 262.6 | -81.3 % | overlap | 1402.3 / 1977.5 / 180.3 | 99.1 / 3080.1 / 262.6 |
| Home p99 ms (server) | 145.58 | 163.98 | +12.6 % | overlap | 314.17 / 127.71 / 145.58 | 98.08 / 1145.06 / 163.98 |
| segment p95 ms | 10991.7 | 17765.5 | +61.6 % | overlap | 22068.6 / 10991.7 / 489.9 | 17765.5 / 60003.7 / 12602 |
| first segment p50 ms |  |  |  |  |  |  |
| TTFF p50 ms | 416 | 212 | -49 % | overlap | 217 / 1705 / 416 | 202 / 212 / 347 |
| stalls | 6 | 7 | +16.7 % | overlap | 8 / 6 / 0 | 7 / 3 / 7 |
| loop stalls > 50 ms | 112 | 104 | -7.1 % | overlap | 244 / 112 / 104 | 91 / 491 / 104 |
| loop stalls > 100 ms | 50 | 42 | -16 % | overlap | 85 / 50 / 41 | 32 / 270 / 42 |
| loop stall ms/min | 5088 | 2848 | -44 % | overlap | 8880 / 5088 / 3996 | 2286 / 28226 / 2848 |
| longest stall ms | 2983.67 | 317.75 | -89.4 % | overlap | 2983.67 / 3527.27 / 1316.62 | 280.43 / 9578.52 / 317.75 |
| healthz p99 ms | 236.5 | 144.3 | -39 % | overlap | 464.3 / 236.5 / 221.3 | 87.1 / 3067.3 / 144.3 |
| ELU | 0.23302 | 0.2035 | -12.7 % | overlap | 0.27367 / 0.23302 / 0.21750999999999998 | 0.19676 / 0.50636 / 0.2035 |
| server CPU s/min | 12.46 | 13.94 | +11.9 % | overlap | 11.58 / 12.46 / 13.75 | 14.93 / 7.02 / 13.94 |
| ffmpeg cores | 1.619 | 1.358 | -16.1 % | overlap | 0.81 / 1.619 / 1.818 | 1.393 / 0.478 / 1.358 |
| RSS MB | 182 | 198 | +8.8 % | overlap | 176 / 182 / 183 | 205 / 198 / 177 |
| heap MB | 70.1 | 71.3 | +1.7 % | B worse (no overlap) | 69.8 / 70.2 / 70.1 | 71.3 / 72.9 / 71.3 |
| handles | 444 | 434 | -2.3 % | overlap | 444 / 444 / 431 | 428 / 440 / 434 |
| fs calls/s | 100.7 | 107.9 | +7.1 % | overlap | 100.7 / 105.9 / 97.5 | 107.9 / 69.8 / 157.5 |
| written KB/min (server, data/) | 5260.5 | 10.6 | -99.8 % | B better (no overlap) | 5260.5 / 5059.1 / 6143.7 | 12.8 / 4.5 / 10.6 |
| data/ grew MB (incl. stream caches) | 1792.2 | 1632.8 | -8.9 % | overlap | 1117.7 / 1792.2 / 2023.4 | 1906.7 / 596.2 / 1632.8 |
| sync fs ms/min | 2952 | 1095 | -62.9 % | B better (no overlap) | 2952 / 3793 / 2323 | 1095 / 2102 / 523 |
| browse 5xx | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| stream request errors | 1 | 1 | 0 % | overlap | 1 / 1 / 0 | 1 / 3 / 0 |
| 429 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 503 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| PC CPU % (noise) | 99.3 | 100 | +0.7 % |  | 100 / 99.3 / 99 | 100 / 100 / 100 |

Runs:
- A master@4862136f: degraded: browse p99 17163.1 ms > 1000; 8 stall(s) in 8 viewers; 3 event-loop stall(s) > 1 s; loop stalled 35521 ms (> 2 % of the window)
- B srv-storage@cd867e8b: degraded: browse p99 17331.9 ms > 1000; 7 stall(s) in 8 viewers; loop stalled 9142 ms (> 2 % of the window)
- B srv-storage@cd867e8b: degraded: browse p99 63151 ms > 1000; browse errors 17/369; 3 stall(s) in 8 viewers; 16 event-loop stall(s) > 1 s; loop stalled 113515 ms (> 2 % of the window)
- A master@4862136f: degraded: browse p99 20451.7 ms > 1000; 6 stall(s) in 8 viewers; 2 event-loop stall(s) > 1 s; loop stalled 20351 ms (> 2 % of the window)
- A master@4862136f: degraded: browse p99 8146 ms > 1000; 2 event-loop stall(s) > 1 s; loop stalled 15983 ms (> 2 % of the window)
- B srv-storage@9b69e2b8: degraded: browse p99 36513.3 ms > 1000; 7 stall(s) in 8 viewers; loop stalled 11391 ms (> 2 % of the window)
