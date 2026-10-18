# A/B: master 4862136f (A) vs e6a8021 e6a80215 (B) — evening n=16, 6 runs interleaved A B B A A B

| metric | A median | B median | B vs A | call | A runs | B runs |
| --- | --- | --- | --- | --- | --- | --- |
| browse p50 ms | 28.2 | 18.9 | -33 % | B better (no overlap) | 20.1 / 28.2 / 31.8 | 19 / 18.9 / 18.7 |
| browse p95 ms | 2309.5 | 794.2 | -65.6 % | overlap | 2416.7 / 930.4 / 2309.5 | 1333.4 / 794.2 / 670.6 |
| browse p99 ms | 4284.1 | 2956.4 | -31 % | overlap | 4284.1 / 1804.7 / 6916.1 | 2956.4 / 2996.9 / 2315 |
| API p95 ms (browse minus pictures) | 140 | 86.8 | -38 % | overlap | 82.9 / 152.8 / 140 | 86.8 / 73.8 / 100.5 |
| API p99 ms | 435.9 | 170.5 | -60.9 % | B better (no overlap) | 270.3 / 435.9 / 677.2 | 165.6 / 259 / 170.5 |
| pictures p95 ms | 3780 | 2001.1 | -47.1 % | overlap | 3780 / 1683.9 / 6353 | 2566.5 / 1766.4 / 2001.1 |
| pictures p99 ms | 5621 | 4933.7 | -12.2 % | overlap | 5621 / 2419.4 / 7324.1 | 4755 / 5102.7 / 4933.7 |
| Home p99 ms (client) | 378.2 | 148 | -60.9 % | B better (no overlap) | 270.3 / 378.2 / 601.4 | 165.6 / 49.5 / 148 |
| Home p99 ms (server) | 221.2 | 113.63 | -48.6 % | overlap | 42.75 / 221.2 / 312.43 | 113.63 / 44.18 / 147.77 |
| segment p95 ms | 1419.8 | 2094.3 | +47.5 % | overlap | 14664.6 / 441.4 / 1419.8 | 442.5 / 2094.3 / 2140.9 |
| first segment p50 ms |  | 49866 |  |  |  | 49866 |
| TTFF p50 ms | 300 | 209 | -30.3 % | overlap | 117 / 538 / 300 | 111 / 316 / 209 |
| stalls | 0 | 0 |  | overlap | 3 / 0 / 0 | 0 / 1 / 0 |
| loop stalls > 50 ms | 79 | 53 | -32.9 % | overlap | 51 / 79 / 130 | 57 / 47 / 53 |
| loop stalls > 100 ms | 22 | 22 | 0 % | overlap | 13 / 22 / 43 | 17 / 25 / 22 |
| loop stall ms/min | 2901 | 1450 | -50 % | overlap | 1515 / 2901 / 3773 | 1450 / 1894 / 1323 |
| longest stall ms | 854.48 | 739 | -13.5 % | overlap | 854.48 / 1407.71 / 827.83 | 739 / 1124.78 / 250.45 |
| healthz p99 ms | 136.8 | 74.3 | -45.7 % | overlap | 96.5 / 136.8 / 160.7 | 71.5 / 100 / 74.3 |
| ELU | 0.20374 | 0.17048 | -16.3 % | overlap | 0.17 / 0.20374 / 0.22663999999999998 | 0.17432 / 0.17048 / 0.15882 |
| server CPU s/min | 13.67 | 13.57 | -0.7 % | overlap | 12.93 / 13.67 / 15.09 | 11.64 / 15.02 / 13.57 |
| ffmpeg cores | 2.265 | 2.357 | +4.1 % | overlap | 1.518 / 2.411 / 2.265 | 1.624 / 2.357 / 2.357 |
| RSS MB | 209 | 207 | -1 % | overlap | 209 / 211 / 208 | 199 / 213 / 207 |
| heap MB | 70.9 | 70.9 | 0 % | overlap | 70.9 / 74.3 / 70.6 | 76.4 / 70.9 / 70.8 |
| handles | 436 | 434 | -0.5 % | overlap | 436 / 427 / 438 | 417 / 434 / 437 |
| fs calls/s | 111.4 | 112 | +0.5 % | overlap | 114.1 / 102.6 / 111.4 | 157 / 112 / 99.5 |
| written KB/min (server, data/) | 7007.1 | 6576.7 | -6.1 % | overlap | 5894.2 / 7007.1 / 8736.2 | 6576.7 / 7827.7 / 5365.2 |
| data/ grew MB (incl. stream caches) | 2168.3 | 2267.1 | +4.6 % | overlap | 2168.3 / 2258.4 / 2064.5 | 1472.6 / 2903.7 / 2267.1 |
| sync fs ms/min | 829 | 759 | -8.4 % | overlap | 804 / 2103 / 829 | 759 / 1033 / 609 |
| browse 5xx | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| stream request errors | 0 | 0 |  | overlap | 1 / 0 / 0 | 0 / 1 / 0 |
| 429 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 503 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| PC CPU % (noise) | 99.9 | 98.1 | -1.8 % |  | 99.9 / 99.9 / 99.9 | 97.3 / 98.1 / 99.9 |

Runs:
- A 4862136f758264cc93edb426e5ee839e6635ce7e@4862136f: degraded: browse p99 4284.1 ms > 1000; 3 stall(s) in 8 viewers; loop stalled 6060 ms (> 2 % of the window)
- B e6a802159bd7d04cc1800f9345f4d0422c0ffcc2@e6a80215: degraded: browse p99 2956.4 ms > 1000; loop stalled 5801 ms (> 2 % of the window)
- B e6a802159bd7d04cc1800f9345f4d0422c0ffcc2@e6a80215: degraded: browse p99 2996.9 ms > 1000; 1 stall(s) in 8 viewers; 1 event-loop stall(s) > 1 s; loop stalled 7577 ms (> 2 % of the window)
- A 4862136f758264cc93edb426e5ee839e6635ce7e@4862136f: degraded: browse p99 1804.7 ms > 1000; 3 event-loop stall(s) > 1 s; loop stalled 11602 ms (> 2 % of the window)
- A 4862136f758264cc93edb426e5ee839e6635ce7e@4862136f: degraded: browse p99 6916.1 ms > 1000; loop stalled 15096 ms (> 2 % of the window)
- B e6a802159bd7d04cc1800f9345f4d0422c0ffcc2@e6a80215: degraded: browse p99 2315 ms > 1000; loop stalled 5293 ms (> 2 % of the window)