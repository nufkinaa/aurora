# A/B: master 4862136f (A) vs srv-eventloop cf404a33 (B) — evening n=16, 6 runs interleaved A B B A A B

| metric | A median | B median | B vs A | call | A runs | B runs |
| --- | --- | --- | --- | --- | --- | --- |
| browse p50 ms | 25.4 | 24.1 | -5.1 % | overlap | 25.4 / 23.5 / 32.8 | 24.1 / 25.1 / 23.4 |
| browse p95 ms | 1701.3 | 1218.5 | -28.4 % | overlap | 1050.8 / 1701.3 / 2055.5 | 690 / 1294.4 / 1218.5 |
| browse p99 ms | 4942.4 | 3820.7 | -22.7 % | overlap | 2167.5 / 4942.4 / 5496 | 1435 / 3820.7 / 4319.6 |
| API p95 ms (browse minus pictures) |  |  |  |  |  |  |
| API p99 ms |  |  |  |  |  |  |
| pictures p95 ms | 4428.4 | 2572 | -41.9 % | overlap | 1782.1 / 4693.3 / 4428.4 | 1399.2 / 2572 / 3469.3 |
| pictures p99 ms | 5586.6 | 4651.7 | -16.7 % | overlap | 2423.7 / 5586.6 / 9794.1 | 2430.3 / 4651.7 / 4889.4 |
| Home p99 ms (client) | 668.7 | 92.3 | -86.2 % | B better (no overlap) | 635.3 / 668.7 / 2975.9 | 97.2 / 86.8 / 92.3 |
| Home p99 ms (server) | 109.21 | 62.21 | -43 % | overlap | 109.21 / 52.61 / 212.4 | 93 / 49.55 / 62.21 |
| segment p95 ms | 479.4 | 3899.7 | +713.5 % | overlap | 479.4 / 258.6 / 3272.9 | 4177.4 / 79.2 / 3899.7 |
| first segment p50 ms |  |  |  |  |  |  |
| TTFF p50 ms | 536 | 589 | +9.9 % | overlap | 115 / 536 / 721 | 1282 / 589 / 402 |
| stalls | 0 | 0 |  | overlap | 0 / 0 / 0 | 2 / 0 / 0 |
| loop stalls > 50 ms | 107 | 57 | -46.7 % | overlap | 78 / 107 / 115 | 57 / 53 / 96 |
| loop stalls > 100 ms | 43 | 24 | -44.2 % | B better (no overlap) | 37 / 43 / 69 | 18 / 24 / 32 |
| loop stall ms/min | 4295 | 1765 | -58.9 % | B better (no overlap) | 3394 / 4295 / 11043 | 1765 / 1720 / 3247 |
| longest stall ms | 1417.12 | 893.08 | -37 % | overlap | 1074.37 / 1417.12 / 6197.75 | 893.08 / 699.59 / 3044.76 |
| healthz p99 ms | 299.6 | 74.8 | -75 % | B better (no overlap) | 216 / 299.6 / 897.1 | 74.8 / 62.5 / 135.9 |
| ELU | 0.20835 | 0.17482 | -16.1 % | B better (no overlap) | 0.20765999999999998 / 0.20835 / 0.32825 | 0.17482 / 0.16666 / 0.20236 |
| server CPU s/min | 14.28 | 14.4 | +0.8 % | overlap | 15.3 / 13.52 / 14.28 | 14.4 / 13.86 / 14.78 |
| ffmpeg cores | 1.96 | 2.477 | +26.4 % | overlap | 2.445 / 1.951 / 1.96 | 2.477 / 2.145 / 2.522 |
| RSS MB | 205 | 199 | -2.9 % | overlap | 205 / 191 / 206 | 199 / 203 / 194 |
| heap MB | 71.7 | 69.5 | -3.1 % | overlap | 74.3 / 69.9 / 71.7 | 69.3 / 76.2 / 69.5 |
| handles | 435 | 427 | -1.8 % | overlap | 435 / 427 / 439 | 423 / 447 / 427 |
| fs calls/s | 108.6 | 110 | +1.3 % | overlap | 108.6 / 104.4 / 109.9 | 112.3 / 110 / 106 |
| written KB/min (server, data/) | 6389.3 | 6825.4 | +6.8 % | overlap | 6389.3 / 6000.4 / 7259.8 | 7345.3 / 6825.4 / 5903 |
| data/ grew MB (incl. stream caches) | 2186.8 | 2498.2 | +14.2 % | overlap | 2519.9 / 2186.8 / 2183.2 | 2311.8 / 2610 / 2498.2 |
| sync fs ms/min | 2707 | 1537 | -43.2 % | B better (no overlap) | 2524 / 2707 / 9877 | 1537 / 1293 / 1909 |
| browse 5xx | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| stream request errors | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 429 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 503 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| PC CPU % (noise) | 99.6 | 99.4 | -0.2 % |  | 99.6 / 99.8 / 97.9 | 99.4 / 99.6 / 99.1 |

Runs:
- A 4862136f758264cc93edb426e5ee839e6635ce7e@4862136f: degraded: browse p99 2167.5 ms > 1000; 1 event-loop stall(s) > 1 s; loop stalled 13576 ms (> 2 % of the window)
- B cf404a33db3cc52175b3fa52bd05562739c3d6ee@cf404a33: degraded: browse p99 1435 ms > 1000; 2 stall(s) in 8 viewers; loop stalled 7060 ms (> 2 % of the window)
- B cf404a33db3cc52175b3fa52bd05562739c3d6ee@cf404a33: degraded: browse p99 3820.7 ms > 1000; loop stalled 6881 ms (> 2 % of the window)
- A 4862136f758264cc93edb426e5ee839e6635ce7e@4862136f: degraded: browse p99 4942.4 ms > 1000; 2 event-loop stall(s) > 1 s; loop stalled 17180 ms (> 2 % of the window)
- A 4862136f758264cc93edb426e5ee839e6635ce7e@4862136f: degraded: browse p99 5496 ms > 1000; 9 event-loop stall(s) > 1 s; loop stalled 44170 ms (> 2 % of the window)
- B cf404a33db3cc52175b3fa52bd05562739c3d6ee@cf404a33: degraded: browse p99 4319.6 ms > 1000; 1 event-loop stall(s) > 1 s; loop stalled 12987 ms (> 2 % of the window)
