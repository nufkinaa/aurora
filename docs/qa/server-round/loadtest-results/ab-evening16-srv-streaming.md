# A/B: master 4862136f (A) vs srv-streaming d5a23cc1 (B) — evening n=16, 6 runs interleaved A B B A A B

| metric | A median | B median | B vs A | call | A runs | B runs |
| --- | --- | --- | --- | --- | --- | --- |
| browse p50 ms | 17.8 | 19 | +6.7 % | overlap | 23.3 / 17.8 / 12.3 | 23 / 19 / 16.9 |
| browse p95 ms | 366.5 | 340.9 | -7 % | overlap | 1031 / 366.5 / 235.9 | 461.7 / 288 / 340.9 |
| browse p99 ms | 680.3 | 595.1 | -12.5 % | overlap | 1853.2 / 680.3 / 500.2 | 1611.1 / 447.3 / 595.1 |
| API p95 ms (browse minus pictures) | 57.2 | 68.6 | +19.9 % | overlap | 86.4 / 57.2 / 42.9 | 124.5 / 68.6 / 62.5 |
| API p99 ms | 115.1 | 197.6 | +71.7 % | overlap | 115.1 / 110.7 / 194 | 341.4 / 197.6 / 127.2 |
| pictures p95 ms | 619.6 | 560 | -9.6 % | overlap | 1752 / 619.6 / 374.1 | 1134.3 / 407 / 560 |
| pictures p99 ms | 1096.5 | 816.3 | -25.6 % | overlap | 2773.3 / 1096.5 / 937 | 2593.2 / 511.3 / 816.3 |
| Home p99 ms (client) | 106.1 | 68.5 | -35.4 % | overlap | 106.1 / 86 / 498.1 | 269.1 / 68.5 / 64.4 |
| Home p99 ms (server) | 71 | 68.99 | -2.8 % | overlap | 100.38 / 71 / 41.23 | 105.79 / 68.99 / 59.38 |
| segment p95 ms | 54.2 | 65.7 | +21.2 % | overlap | 137.3 / 54.2 / 31.9 | 316.4 / 58 / 65.7 |
| first segment p50 ms |  |  |  |  |  |  |
| TTFF p50 ms | 266 | 185 | -30.5 % | overlap | 1488 / 122 / 266 | 217 / 185 / 148 |
| stalls | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| loop stalls > 50 ms | 34 | 45 | +32.4 % | overlap | 53 / 34 / 26 | 64 / 36 / 45 |
| loop stalls > 100 ms | 14 | 10 | -28.6 % | overlap | 19 / 6 / 14 | 22 / 10 / 9 |
| loop stall ms/min | 1363 | 965 | -29.2 % | overlap | 1363 / 695 / 2165 | 2344 / 897 / 965 |
| longest stall ms | 345.75 | 437.27 | +26.5 % | overlap | 345.75 / 188.36 / 1119.22 | 2720.82 / 437.27 / 203.79 |
| healthz p99 ms | 63.6 | 57.5 | -9.6 % | overlap | 63.6 / 36.2 / 116.5 | 97.2 / 39 / 57.5 |
| ELU | 0.12373 | 0.11331000000000001 | -8.4 % | overlap | 0.17593999999999999 / 0.12373 / 0.12168000000000001 | 0.15224000000000001 / 0.11331000000000001 / 0.10983 |
| server CPU s/min | 12.64 | 8.66 | -31.5 % | B better (no overlap) | 13.66 / 12.64 / 10.14 | 8.79 / 8.66 / 8.16 |
| ffmpeg cores | 2.222 | 0.73 | -67.1 % | B better (no overlap) | 2.222 / 2.764 / 2.031 | 1.289 / 0.73 / 0.09 |
| RSS MB | 199 | 208 | +4.5 % | overlap | 222 / 190 / 199 | 208 / 208 / 221 |
| heap MB | 72 | 72 | 0 % | overlap | 72 / 71.4 / 73.7 | 83.5 / 72 / 70.5 |
| handles | 430 | 422 | -1.9 % | overlap | 430 / 431 / 402 | 421 / 422 / 432 |
| fs calls/s | 98.1 | 61 | -37.8 % | B better (no overlap) | 110.5 / 98.1 / 97.9 | 59.7 / 63.9 / 61 |
| written KB/min (server, data/) | 5536.9 | 6278.8 | +13.4 % | overlap | 6614.8 / 5536.9 / 5447.7 | 4694.1 / 7161.7 / 6278.8 |
| data/ grew MB (incl. stream caches) | 3498.5 | 171.2 | -95.1 % | B better (no overlap) | 2772.3 / 3498.5 / 4106.3 | 213.1 / 171.2 / 155.3 |
| sync fs ms/min | 967 | 489 | -49.4 % | B better (no overlap) | 967 / 534 / 2321 | 499 / 489 / 453 |
| browse 5xx | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| stream request errors | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 429 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 503 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| PC CPU % (noise) | 85.8 | 74.7 | -12.9 % |  | 98.8 / 85.8 / 53.5 | 97.1 / 68.7 / 74.7 |

Runs:
- A 4862136f758264cc93edb426e5ee839e6635ce7e@4862136f: degraded: browse p99 1853.2 ms > 1000; loop stalled 5453 ms (> 2 % of the window)
- B d5a23cc1e2fbce9c77383a4be7bcbea662a96365@d5a23cc1: degraded: browse p99 1611.1 ms > 1000; 1 event-loop stall(s) > 1 s; loop stalled 9377 ms (> 2 % of the window)
- B d5a23cc1e2fbce9c77383a4be7bcbea662a96365@d5a23cc1: ok
- A 4862136f758264cc93edb426e5ee839e6635ce7e@4862136f: ok
- A 4862136f758264cc93edb426e5ee839e6635ce7e@4862136f: degraded: 3 event-loop stall(s) > 1 s; loop stalled 8658 ms (> 2 % of the window)
- B d5a23cc1e2fbce9c77383a4be7bcbea662a96365@d5a23cc1: ok
