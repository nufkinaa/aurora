# A/B: f465c38 f465c383 (A) vs 5f7f5f6 5f7f5f67 (B) — households n=30, 6 runs interleaved A B B A A B

| metric | A median | B median | B vs A | call | A runs | B runs |
| --- | --- | --- | --- | --- | --- | --- |
| browse p50 ms | 11.6 | 9.1 | -21.6 % | overlap | 12.7 / 11.6 / 10.4 | 11.5 / 9.1 / 8.6 |
| browse p95 ms | 241.2 | 187.8 | -22.1 % | overlap | 241.2 / 262.5 / 189.5 | 180.8 / 206.9 / 187.8 |
| browse p99 ms | 337.4 | 354.1 | +4.9 % | overlap | 418.9 / 337.4 / 278.4 | 253.3 / 354.1 / 368.9 |
| API p95 ms (browse minus pictures) | 56 | 35 | -37.5 % | overlap | 56 / 59.6 / 25.1 | 33 / 39.6 / 35 |
| API p99 ms | 129 | 102.9 | -20.2 % | overlap | 129 / 224.3 / 94.2 | 69.4 / 140.1 / 102.9 |
| pictures p95 ms | 321.2 | 323.8 | +0.8 % | overlap | 346.1 / 321.2 / 259.6 | 245.7 / 323.8 / 327.2 |
| pictures p99 ms | 454.5 | 403.5 | -11.2 % | overlap | 595.4 / 375.5 / 454.5 | 356.8 / 403.5 / 460.2 |
| Home p99 ms (client) | 40.6 | 26.3 | -35.2 % | overlap | 53.5 / 24.1 / 40.6 | 26.3 / 30.4 / 20 |
| Home p99 ms (server) | 39.39 | 23.2 | -41.1 % | overlap | 51.03 / 23.79 / 39.39 | 23.2 / 29.93 / 19.35 |
| segment p95 ms |  |  |  |  |  |  |
| first segment p50 ms |  |  |  |  |  |  |
| TTFF p50 ms | 104 | 106 | +1.9 % | overlap | 105 / 104 / 101 | 105 / 106 / 106 |
| stalls | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| loop stalls > 50 ms | 9 | 2 | -77.8 % | B better (no overlap) | 9 / 9 / 6 | 2 / 2 / 0 |
| loop stalls > 100 ms | 2 | 0 | -100 % | overlap | 2 / 3 / 1 | 0 / 2 / 0 |
| loop stall ms/min | 176 | 27 | -84.7 % | B better (no overlap) | 176 / 226 / 131 | 27 / 67 / 0 |
| longest stall ms | 204.25 | 54.32 | -73.4 % | overlap | 115.76 / 204.25 / 204.97 | 54.32 / 158 / 43.42 |
| healthz p99 ms | 14.7 | 4.2 | -71.4 % | overlap | 25.7 / 14.7 / 4.9 | 4.2 / 5 / 2.4 |
| ELU | 0.040740000000000005 | 0.02947 | -27.7 % | B better (no overlap) | 0.040740000000000005 / 0.05097 / 0.03569 | 0.030989999999999997 / 0.02947 / 0.02175 |
| server CPU s/min | 3.45 | 3.27 | -5.2 % | overlap | 3.45 / 4.14 / 3.16 | 3.61 / 3.27 / 2.71 |
| ffmpeg cores | 0.002 | 0.002 | 0 % | overlap | 0.004 / 0.002 / 0 | 0.002 / 0.002 / 0.001 |
| RSS MB | 199 | 227 | +14.1 % | B worse (no overlap) | 212 / 177 / 199 | 220 / 228 / 227 |
| heap MB | 69 | 70.8 | +2.6 % | B worse (no overlap) | 69.7 / 69 / 67.9 | 70.8 / 78.2 / 70.7 |
| handles | 405 | 417 | +3 % | B worse (no overlap) | 403 / 405 / 413 | 430 / 417 / 415 |
| fs calls/s | 33.7 | 21.5 | -36.2 % | B better (no overlap) | 33.7 / 36.1 / 28.4 | 23 / 21.5 / 19.2 |
| written KB/min (server, data/) | 2888 | 6.1 | -99.8 % | B better (no overlap) | 3904.8 / 2888 / 2645 | 6.5 / 6.1 / 5.6 |
| data/ grew MB (incl. stream caches) | 4.7 | 3.8 | -19.1 % | overlap | 5.6 / 4.7 / 2.4 | 3.6 / 4.6 / 3.8 |
| sync fs ms/min | 199 | 54 | -72.9 % | B better (no overlap) | 313 / 199 / 170 | 56 / 54 / 44 |
| browse 5xx | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| stream request errors | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 429 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 503 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| PC CPU % (noise) | 28.7 | 29 | +1 % |  | 29.8 / 28.7 / 27.2 | 31 / 29 / 14.2 |

Runs:
- A f465c383edd1fe6e5052d4d78a0f386c2c9405f0@f465c383: ok
- B 5f7f5f67195bb9bdf3fe89a4c10fabdfa07a448a@5f7f5f67: ok
- B 5f7f5f67195bb9bdf3fe89a4c10fabdfa07a448a@5f7f5f67: ok
- A f465c383edd1fe6e5052d4d78a0f386c2c9405f0@f465c383: ok
- A f465c383edd1fe6e5052d4d78a0f386c2c9405f0@f465c383: ok
- B 5f7f5f67195bb9bdf3fe89a4c10fabdfa07a448a@5f7f5f67: ok