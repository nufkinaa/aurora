# A/B: master 4862136f (A) vs srv-storage 35f97888 (B) — evening n=8, 6 runs interleaved A B B A A B

| metric | A median | B median | B vs A | call | A runs | B runs |
| --- | --- | --- | --- | --- | --- | --- |
| browse p50 ms | 72 | 47.8 | -33.6 % | overlap | 71.9 / 72 / 86.2 | 31.6 / 249.8 / 47.8 |
| browse p95 ms | 19679.1 | 9095.1 | -53.8 % | overlap | 4087.9 / 19679.1 / 51157.2 | 785.2 / 9095.1 / 25867.4 |
| browse p99 ms | 36183.9 | 23101.8 | -36.2 % | overlap | 11186.5 / 36183.9 / 60010.7 | 1503 / 23101.8 / 31850.8 |
| API p95 ms (browse minus pictures) | 2579.5 | 1651.5 | -36 % | overlap | 2579.5 / 3144.5 / 917.6 | 233.9 / 2661.9 / 1651.5 |
| API p99 ms | 4995.5 | 3451.9 | -30.9 % | overlap | 4995.5 / 7210.2 / 2281.7 | 422.4 / 3451.9 / 4893.5 |
| pictures p95 ms | 34194.7 | 19248.7 | -43.7 % | overlap | 9003.5 / 34194.7 / 60009.5 | 1478.4 / 19248.7 / 31287.1 |
| pictures p99 ms | 45897.7 | 24116.1 | -47.5 % | overlap | 18737.7 / 45897.7 / 60017.9 | 2307.4 / 24116.1 / 33527 |
| Home p99 ms (client) | 2232 | 2661.9 | +19.3 % | overlap | 2232 / 3080.9 / 506 | 145.7 / 2661.9 / 4960.6 |
| Home p99 ms (server) | 1454.4 | 1727.8 | +18.8 % | overlap | 2035 / 1454.4 / 396.57 | 97.28 / 1727.8 / 3593.47 |
| segment p95 ms | 7619.6 | 4762.2 | -37.5 % | overlap | 340.4 / 7619.6 / 14811.5 | 647.8 / 4762.2 / 5423.8 |
| first segment p50 ms | 90151 | 52631 | -41.6 % | B better (no overlap) | 90151 | 52631 |
| TTFF p50 ms | 2273 | 126 | -94.5 % | overlap | 122 / 2273 / 12800 | 126 / 123 / 24099 |
| stalls | 1 | 0 | -100 % | overlap | 0 / 1 / 1 | 0 / 0 / 1 |
| loop stalls > 50 ms | 275 | 331 | +20.4 % | overlap | 136 / 355 / 275 | 92 / 336 / 331 |
| loop stalls > 100 ms | 153 | 197 | +28.8 % | overlap | 74 / 211 / 153 | 41 / 197 / 210 |
| loop stall ms/min | 14919 | 19340 | +29.6 % | overlap | 13470 / 26179 / 14919 | 2734 / 19340 / 27095 |
| longest stall ms | 6016.03 | 3761.06 | -37.5 % | overlap | 6016.03 / 7363.26 / 2425.79 | 665.66 / 3761.06 / 3936.07 |
| healthz p99 ms | 1097.5 | 1207.6 | +10 % | overlap | 1097.5 / 1935.9 / 964.4 | 162.8 / 1207.6 / 2103.6 |
| ELU | 0.32986 | 0.448 | +35.8 % | overlap | 0.32986 / 0.54198 / 0.32703 | 0.16879 / 0.448 / 0.54196 |
| server CPU s/min | 5.35 | 6.61 | +23.6 % | overlap | 7.12 / 5.35 / 4.38 | 7.75 / 6.61 / 5.64 |
| ffmpeg cores | 0.164 | 0.231 | +40.9 % | overlap | 0.605 / 0.164 / 0.119 | 0.94 / 0.212 / 0.231 |
| RSS MB | 181 | 187 | +3.3 % | overlap | 183 / 144 / 181 | 187 / 177 / 191 |
| heap MB | 71.3 | 70.6 | -1 % | overlap | 72.4 / 69.4 / 71.3 | 85.3 / 68.5 / 70.6 |
| handles | 387 | 364 | -5.9 % | overlap | 391 / 387 / 377 | 364 / 392 / 361 |
| fs calls/s | 47.9 | 51 | +6.5 % | overlap | 53.3 / 41.4 / 47.9 | 51 / 43.9 / 84.7 |
| written KB/min (server, data/) | 2499.8 | 6 | -99.8 % | B better (no overlap) | 3264.1 / 2499.8 / 1731.8 | 6.7 / 6 / 5.6 |
| browse 5xx | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| stream request errors | 2 | 0 | -100 % | overlap | 0 / 2 / 11 | 0 / 0 / 1 |
| 429 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 503 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| PC CPU % (noise) | 95.4 | 92.3 | -3.2 % |  | 76.8 / 98.4 / 95.4 | 74.3 / 97.8 / 92.3 |

Runs:
- A 4862136f758264cc93edb426e5ee839e6635ce7e@4862136f: degraded: browse p99 11186.5 ms > 1000; 9 event-loop stall(s) > 1 s; loop stalled 53878 ms (> 2 % of the window)
- B 35f9788845a25a77c524ea6f76078e7889eb8d68@35f97888: degraded: browse p99 1503 ms > 1000; loop stalled 10934 ms (> 2 % of the window)
- B 35f9788845a25a77c524ea6f76078e7889eb8d68@35f97888: degraded: browse p99 23101.8 ms > 1000; 12 event-loop stall(s) > 1 s; loop stalled 77361 ms (> 2 % of the window)
- A 4862136f758264cc93edb426e5ee839e6635ce7e@4862136f: degraded: browse p99 36183.9 ms > 1000; 1 stall(s) in 4 viewers; 1 stream refusal(s); 17 event-loop stall(s) > 1 s; loop stalled 104714 ms (> 2 % of the window)
- A 4862136f758264cc93edb426e5ee839e6635ce7e@4862136f: degraded: browse p99 60010.7 ms > 1000; browse errors 16/405; 1 stall(s) in 4 viewers; 1 viewer(s) never started; 4 stream refusal(s); 10 event-loop stall(s) > 1 s; loop stalled 59675 ms (> 2 % of the window)
- B 35f9788845a25a77c524ea6f76078e7889eb8d68@35f97888: degraded: browse p99 31850.8 ms > 1000; 1 stall(s) in 4 viewers; 26 event-loop stall(s) > 1 s; loop stalled 108379 ms (> 2 % of the window)