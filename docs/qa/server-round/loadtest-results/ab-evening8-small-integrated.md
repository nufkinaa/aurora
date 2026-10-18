# A/B: f465c38 f465c383 (A) vs 6eb89b1 6eb89b13 (B) — evening n=8, 6 runs interleaved A B B A A B

| metric | A median | B median | B vs A | call | A runs | B runs |
| --- | --- | --- | --- | --- | --- | --- |
| browse p50 ms | 12.7 | 9.4 | -26 % | B better (no overlap) | 12.7 / 15.8 / 11.9 | 9.5 / 9.4 / 7.8 |
| browse p95 ms | 305 | 227.9 | -25.3 % | B better (no overlap) | 305 / 396.8 / 243.5 | 227.9 / 204 / 228.5 |
| browse p99 ms | 444.3 | 415.5 | -6.5 % | overlap | 444.3 / 558.3 / 438.3 | 502.1 / 353.9 / 415.5 |
| API p95 ms (browse minus pictures) | 56.7 | 58.3 | +2.8 % | overlap | 69.4 / 56.7 / 50.7 | 77 / 58.3 / 32 |
| API p99 ms | 235.4 | 168.8 | -28.3 % | overlap | 235.4 / 327.5 / 215.1 | 259.3 / 168.8 / 106.3 |
| pictures p95 ms | 414.7 | 352.9 | -14.9 % | overlap | 402.7 / 552.3 / 414.7 | 483.3 / 295.4 / 352.9 |
| pictures p99 ms | 681.4 | 737.8 | +8.3 % | overlap | 635.1 / 1013.6 / 681.4 | 843.9 / 737.8 / 532.7 |
| Home p99 ms (client) | 198.7 | 76.1 | -61.7 % | overlap | 295.8 / 39.7 / 198.7 | 135.6 / 76.1 / 36.6 |
| Home p99 ms (server) | 173 | 80.39 | -53.5 % | overlap | 308.28 / 39.08 / 173 | 121.26 / 80.39 / 36.33 |
| segment p95 ms | 77.1 | 57 | -26.1 % | B better (no overlap) | 73.3 / 77.1 / 129.6 | 59 / 57 / 12.3 |
| first segment p50 ms |  |  |  |  |  |  |
| TTFF p50 ms | 106 | 110 | +3.8 % | overlap | 108 / 106 / 105 | 108 / 110 / 143 |
| stalls | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| loop stalls > 50 ms | 23 | 9 | -60.9 % | B better (no overlap) | 23 / 13 / 27 | 9 / 9 / 2 |
| loop stalls > 100 ms | 6 | 3 | -50 % | B better (no overlap) | 6 / 4 / 17 | 3 / 3 / 0 |
| loop stall ms/min | 602 | 210 | -65.1 % | B better (no overlap) | 602 / 382 / 1539 | 210 / 309 / 29 |
| longest stall ms | 421.47 | 142.87 | -66.1 % | overlap | 421.47 / 332.76 / 1532.67 | 142.87 / 398.63 / 65.12 |
| healthz p99 ms | 29.2 | 12.5 | -57.2 % | B better (no overlap) | 29.2 / 27.5 / 108.9 | 12.5 / 22.9 / 5.9 |
| ELU | 0.08911 | 0.046 | -48.4 % | B better (no overlap) | 0.08911 / 0.08687 / 0.10256 | 0.046 / 0.05126 / 0.03312 |
| server CPU s/min | 6.77 | 3.46 | -48.9 % | B better (no overlap) | 6.84 / 6.77 / 6.25 | 3.28 / 3.93 / 3.46 |
| ffmpeg cores | 1.264 | 0.025 | -98 % | B better (no overlap) | 1.285 / 1.264 / 1.163 | 0.034 / 0.025 / 0.002 |
| RSS MB | 185 | 200 | +8.1 % | B worse (no overlap) | 184 / 185 / 193 | 198 / 200 / 200 |
| heap MB | 71.1 | 63.6 | -10.5 % | B better (no overlap) | 67.8 / 86.5 / 71.1 | 63.4 / 64.3 / 63.6 |
| handles | 365 | 376 | +3 % | B worse (no overlap) | 365 / 365 / 360 | 376 / 380 / 375 |
| fs calls/s | 61.2 | 38.2 | -37.6 % | B better (no overlap) | 62.7 / 61.2 / 59 | 30.7 / 42.1 / 38.2 |
| written KB/min (server, data/) | 3222.9 | 8.1 | -99.7 % | B better (no overlap) | 3222.9 / 3770.4 / 3029.4 | 6 / 8.3 / 8.1 |
| data/ grew MB (incl. stream caches) | 4035.4 | 106.4 | -97.4 % | B better (no overlap) | 4076.5 / 4035.4 / 3682.8 | 106.4 / 121 / 6.6 |
| sync fs ms/min | 402 | 124 | -69.2 % | B better (no overlap) | 348 / 402 / 1422 | 124 / 156 / 108 |
| browse 5xx | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| stream request errors | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 429 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 503 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| PC CPU % (noise) | 39.3 | 30.3 | -22.9 % |  | 39.3 / 40.6 / 37.8 | 30.9 / 30.3 / 16 |

Runs:
- A f465c383edd1fe6e5052d4d78a0f386c2c9405f0@f465c383: ok
- B 6eb89b13c39fe3d1919d37d287a64ed388279577@6eb89b13: ok
- B 6eb89b13c39fe3d1919d37d287a64ed388279577@6eb89b13: ok
- A f465c383edd1fe6e5052d4d78a0f386c2c9405f0@f465c383: ok
- A f465c383edd1fe6e5052d4d78a0f386c2c9405f0@f465c383: degraded: 1 event-loop stall(s) > 1 s; loop stalled 6155 ms (> 2 % of the window)
- B 6eb89b13c39fe3d1919d37d287a64ed388279577@6eb89b13: ok