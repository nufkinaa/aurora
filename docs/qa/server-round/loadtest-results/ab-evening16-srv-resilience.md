# A/B: master (A) vs srv-resilience (B) — evening n=16, 6 runs interleaved A B B A A B

| metric | A median | B median | B vs A | call | A runs | B runs |
| --- | --- | --- | --- | --- | --- | --- |
| browse p50 ms | 27.8 | 31.4 | +12.9 % | overlap | 38.4 / 23.8 / 27.8 | 43.2 / 20.4 / 31.4 |
| browse p95 ms | 965 | 4568.7 | +373.4 % | B worse (no overlap) | 1938.2 / 909.8 / 965 | 11857.6 / 2058.2 / 4568.7 |
| browse p99 ms | 10524.8 | 15205.6 | +44.5 % | overlap | 12563.4 / 2287 / 10524.8 | 21299.4 / 15205.6 / 10843.8 |
| API p95 ms (browse minus pictures) |  |  |  |  |  |  |
| API p99 ms |  |  |  |  |  |  |
| pictures p95 ms | 7345.2 | 14287.5 | +94.5 % | overlap | 8069.1 / 1984.1 / 7345.2 | 20518.7 / 14287.5 / 7499.5 |
| pictures p99 ms | 10834.3 | 17510.2 | +61.6 % | overlap | 17309.7 / 2551.6 / 10834.3 | 22843.8 / 17510.2 / 11922.8 |
| Home p99 ms (client) | 308.7 | 184.6 | -40.2 % | overlap | 398 / 173.4 / 308.7 | 184.6 / 476.5 / 137.3 |
| Home p99 ms (server) | 73.84 | 117.19 | +58.7 % | overlap | 95.18 / 47.93 / 73.84 | 120.86 / 88.87 / 117.19 |
| segment p95 ms | 14185.2 | 17427.9 | +22.9 % | overlap | 14595.5 / 305.5 / 14185.2 | 52315.1 / 14416.1 / 17427.9 |
| first segment p50 ms |  |  |  |  |  |  |
| TTFF p50 ms | 320 | 603 | +88.4 % | overlap | 326 / 117 / 320 | 269 / 603 / 632 |
| stalls | 2 | 7 | +250 % | overlap | 2 / 0 / 8 | 7 / 9 / 7 |
| loop stalls > 50 ms | 85 | 132 | +55.3 % | overlap | 132 / 85 / 75 | 259 / 132 / 108 |
| loop stalls > 100 ms | 33 | 52 | +57.6 % | overlap | 58 / 33 / 33 | 90 / 52 / 44 |
| loop stall ms/min | 4262 | 3803 | -10.8 % | overlap | 4671 / 3346 / 4262 | 8240 / 3803 / 2828 |
| longest stall ms | 1064.52 | 904.6 | -15 % | overlap | 751.62 / 1064.52 / 6013.07 | 2017.74 / 904.6 / 385.53 |
| healthz p99 ms | 196.2 | 176.2 | -10.2 % | overlap | 288.4 / 196.2 / 170.2 | 396 / 176.2 / 152.6 |
| ELU | 0.20286 | 0.20831 | +2.7 % | overlap | 0.24114 / 0.2014 / 0.20286 | 0.29812 / 0.20831 / 0.1998 |
| server CPU s/min | 13.34 | 11.97 | -10.3 % | overlap | 13.84 / 13.34 / 12.5 | 11.97 / 13.44 / 11.57 |
| ffmpeg cores | 1.455 | 0.888 | -39 % | B better (no overlap) | 1.455 / 2.188 / 1.286 | 0.762 / 1.275 / 0.888 |
| RSS MB | 197 | 194 | -1.5 % | overlap | 197 / 193 / 207 | 194 / 205 / 193 |
| heap MB | 73.1 | 71.4 | -2.3 % | overlap | 80.5 / 69.4 / 73.1 | 71.2 / 83 / 71.4 |
| handles | 421 | 442 | +5 % | overlap | 443 / 421 / 419 | 444 / 432 / 442 |
| fs calls/s | 105.5 | 101.7 | -3.6 % | overlap | 107.3 / 105.3 / 105.5 | 99 / 108.9 / 101.7 |
| written KB/min (server, data/) | 5388.1 | 5320.7 | -1.3 % | overlap | 5311 / 8359.9 / 5388.1 | 4335.6 / 5320.7 / 5720.5 |
| data/ grew MB (incl. stream caches) | 1726.8 | 1113.9 | -35.5 % | overlap | 1726.8 / 1853.8 / 1620.9 | 1113.9 / 1723.9 / 960.7 |
| sync fs ms/min | 2147 | 1437 | -33.1 % | overlap | 2382 / 2147 / 1877 | 3076 / 1437 / 787 |
| browse 5xx | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| stream request errors | 0 | 1 |  | overlap | 1 / 0 / 0 | 1 / 0 / 1 |
| 429 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| 503 | 0 | 0 |  | overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| PC CPU % (noise) | 99.9 | 100 | +0.1 % |  | 99.9 / 99.6 / 100 | 100 / 100 / 100 |

Runs:
- A master@4862136f: degraded: browse p99 12563.4 ms > 1000; 2 stall(s) in 8 viewers; loop stalled 18682 ms (> 2 % of the window)
- B srv-resilience@0e21d1cd: degraded: browse p99 21299.4 ms > 1000; 7 stall(s) in 8 viewers; 2 event-loop stall(s) > 1 s; loop stalled 32962 ms (> 2 % of the window)
- B srv-resilience@0e21d1cd: degraded: browse p99 15205.6 ms > 1000; 9 stall(s) in 8 viewers; loop stalled 15216 ms (> 2 % of the window)
- A master@4862136f: degraded: browse p99 2287 ms > 1000; 1 event-loop stall(s) > 1 s; loop stalled 13384 ms (> 2 % of the window)
- A master@4862136f: degraded: browse p99 10524.8 ms > 1000; 8 stall(s) in 8 viewers; 2 event-loop stall(s) > 1 s; loop stalled 17049 ms (> 2 % of the window)
- B srv-resilience@5ac0ea28: degraded: browse p99 10843.8 ms > 1000; 7 stall(s) in 8 viewers; loop stalled 11312 ms (> 2 % of the window)
