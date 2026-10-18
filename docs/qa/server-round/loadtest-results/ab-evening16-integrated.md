# A/B: f465c38 f465c383 (A) vs bc75e0d bc75e0d8 (B) — evening n=16, 6 runs interleaved A B B A A B

| metric | A median | B median | B vs A | call | A runs | B runs |
| --- | --- | --- | --- | --- | --- | --- |
| browse p50 ms | 12 | 8.2 | -31.7 % | B better (no overlap) | 11.4 / 12 / 12.7 | 10.3 / 8.2 / 7.7 |
| browse p95 ms | 207.8 | 191.2 | -8 % | B better (no overlap) | 202.8 / 258.9 / 207.8 | 197.5 / 191.2 / 178.6 |
| browse p99 ms | 389.8 | 359.9 | -7.7 % | overlap | 337.1 / 389.8 / 397.9 | 372.4 / 288.6 / 359.9 |
| API p95 ms (browse minus pictures) | 42.3 | 29.2 | -31 % | B better (no overlap) | 42.3 / 39.7 / 43.3 | 38.3 / 23 / 29.2 |
| API p99 ms | 95.4 | 61.6 | -35.4 % | B better (no overlap) | 95.4 / 98.1 / 80.2 | 70.3 / 61.4 / 61.6 |
| pictures p95 ms | 357.9 | 288.6 | -19.4 % | overlap | 310.6 / 357.9 / 375.6 | 360.4 / 272.6 / 288.6 |
| pictures p99 ms | 599.6 | 483.7 | -19.3 % | B better (no overlap) | 560.2 / 599.6 / 675.5 | 483.7 / 450.2 / 506.3 |
| Home p99 ms (client) | 46.2 | 27.4 | -40.7 % | overlap | 45.3 / 46.2 / 50.5 | 62.1 / 21.6 / 27.4 |
| Home p99 ms (server) | 47.12 | 26.95 | -42.8 % | overlap | 47.12 / 45.69 / 50.19 | 61.6 / 21.19 / 26.95 |
| segment p95 ms | 35.2 | 24.2 | -31.3 % | B better (no overlap) | 28.9 / 35.2 / 35.2 | 27 / 24.2 / 23.4 |
| first segment p50 ms |  |  |  |  |  |  |
| TTFF p50 ms | 119 | 119 | 0 % | overlap | 119 / 105 / 136 | 120 / 119 / 106 |
| stalls | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| loop stalls > 50 ms | 17 | 0 | -100 % | B better (no overlap) | 16 / 17 / 21 | 3 / 0 / 0 |
| loop stalls > 100 ms | 2 | 0 | -100 % | B better (no overlap) | 3 / 2 / 1 | 0 / 0 / 0 |
| loop stall ms/min | 369 | 0 | -100 % | B better (no overlap) | 331 / 383 / 369 | 56 / 0 / 0 |
| longest stall ms | 193.86 | 49.66 | -74.4 % | B better (no overlap) | 193.86 / 279.22 / 118.59 | 88.28 / 38.68 / 49.66 |
| healthz p99 ms | 26.6 | 9.4 | -64.7 % | B better (no overlap) | 27.2 / 26.5 / 26.6 | 9.4 / 9 / 11.1 |
| ELU | 0.09748 | 0.04962 | -49.1 % | B better (no overlap) | 0.09605 / 0.09748 / 0.099 | 0.06182 / 0.04591 / 0.04962 |
| server CPU s/min | 10.51 | 6.3 | -40.1 % | B better (no overlap) | 10.57 / 10.51 / 10 | 6.88 / 5.63 / 6.3 |
| ffmpeg cores | 2.03 | 0.477 | -76.5 % | B better (no overlap) | 1.347 / 2.098 / 2.03 | 0.466 / 0.477 / 0.488 |
| RSS MB | 196 | 243 | +24 % | B worse (no overlap) | 196 / 172 / 211 | 243 / 229 / 252 |
| heap MB | 71 | 75.4 | +6.2 % | overlap | 71 / 70.6 / 81.7 | 72.7 / 75.4 / 83 |
| handles | 423 | 436 | +3.1 % | overlap | 431 / 404 / 423 | 436 / 439 / 431 |
| fs calls/s | 104.4 | 59.6 | -42.9 % | B better (no overlap) | 106.7 / 104.4 / 102.4 | 59.6 / 58.1 / 60.1 |
| written KB/min (server, data/) | 6287.8 | 12.3 | -99.8 % | B better (no overlap) | 6287.8 / 6567 / 5786.2 | 12.3 / 11.3 / 12.6 |
| data/ grew MB (incl. stream caches) | 4107.3 | 144.1 | -96.5 % | B better (no overlap) | 3043.1 / 4563.4 / 4107.3 | 129.8 / 144.1 / 237.5 |
| sync fs ms/min | 471 | 117 | -75.2 % | B better (no overlap) | 519 / 471 / 464 | 139 / 104 / 117 |
| browse 5xx | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| stream request errors | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 429 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 503 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| PC CPU % (noise) | 47.9 | 34.6 | -27.8 % |  | 42.9 / 49.3 / 47.9 | 37.1 / 34.6 / 25.2 |

Runs:
- A f465c383edd1fe6e5052d4d78a0f386c2c9405f0@f465c383: ok
- B bc75e0d8bd35491dd446ac3870aa90d1d9e5f9b2@bc75e0d8: ok
- B bc75e0d8bd35491dd446ac3870aa90d1d9e5f9b2@bc75e0d8: ok
- A f465c383edd1fe6e5052d4d78a0f386c2c9405f0@f465c383: ok
- A f465c383edd1fe6e5052d4d78a0f386c2c9405f0@f465c383: ok
- B bc75e0d8bd35491dd446ac3870aa90d1d9e5f9b2@bc75e0d8: ok