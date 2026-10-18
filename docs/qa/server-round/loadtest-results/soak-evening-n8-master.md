# soak — master@4862136f — evening

2026-10-18T12:06:56.165Z, Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB), Node v22.13.1, machine profile **full**, media real: 29 films, 8 shows. evening peak: n households (browser + TV each), 60 % of browsers and 40 % of TVs browsing, max(3, n/2) streams (direct, TV direct, jit copy, TV offset copy, one encode in six)

| min | RSS MB | heap MB | handles | data MB | data files | data grew KB | written KB/min | browse p50/p99 | loop stalls >100 ms / longest | ELU | server CPU s/min | ffmpeg cores | stalls | errors 5xx/net | PC CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10.1 | 157 | 77.9 | 369 | 4378.4 | 14429 | 2762949.8 | 4182.9 | 32.9/10763.6 | 212/26096.7 | 0.41228 | 6.1 | 0.427 | 0 | 0/0 | 76.3 |
| 20.2 | 198 | 77.1 | 362 | 4385.4 | 14669 | 7189.1 | 3919.9 | 19.2/2531 | 47/1384.27 | 0.09036 | 5.06 | 0.007 | 0 | 0/0 | 99.8 |
| 30.3 | 185 | 73 | 386 | 4748.6 | 14941 | 371882.4 | 2666.4 | 17/3611.4 | 37/1246.8 | 0.09598999999999999 | 5.36 | 0.071 | 1 | 0/0 | 99.8 |
| 40.4 | 177 | 77.4 | 364 | 5717.2 | 15673 | 976906.3 | 2954.8 | 15.7/2506.5 | 29/748.21 | 0.07116 | 4.62 | 0.509 | 1 | 0/0 | 99.5 |
| 50.5 | 187 | 74.2 | 351 | 6291 | 16125 | 580478.1 | 1272 | 15.2/970 | 74/822.47 | 0.07718000000000001 | 3.83 | 0.141 | 0 | 0/0 | 99.5 |
| 60.7 | 166 | 71.1 | 364 | 4950.1 | 15183 | -1374611.2 | 1999.5 | 51.6/10346.8 | 610/8241.49 | 0.38117 | 4.76 | 0.03 | 1 | 0/2 | 100 |
| 70.9 | 140 | 74.4 | 352 | 5903.9 | 15957 | 976646.9 | 1636.8 | 17.3/612.9 | 42/1000.04 | 0.0917 | 4.38 | 0.222 | 5 | 0/2 | 97.8 |
| 81 | 184 | 77.6 | 345 | 6748 | 16564 | 860953.1 | 2632.4 | 15.2/1618.1 | 41/1036.41 | 0.08389 | 4.15 | 0.16 | 0 | 0/0 | 98 |
| 91.1 | 166 | 78.6 | 357 | 3239.8 | 14090 | -3594271.8 | 1788.4 | 19.8/1361.1 | 62/2321.92 | 0.11201 | 4.36 | 0.087 | 1 | 0/0 | 99.7 |
| 101.2 | 170 | 77.5 | 365 | 3869.7 | 14595 | 640742.1 | 1342.6 | 13.7/610.9 | 22/2199.22 | 0.07205 | 3.85 | 0.163 | 0 | 0/0 | 99.4 |
| 111.2 | 172 | 78.3 | 364 | 4937.1 | 15370 | 1089438.8 | 3244.5 | 16/259 | 31/945.09 | 0.07483 | 4.25 | 0.213 | 0 | 0/0 | 98.8 |
| 120.1 | 172 | 76.1 | 365 | 3611.5 | 14437 | -1370444.9 | 1581.9 | 11.8/1105.8 | 19/1951.92 | 0.05928 | 3.82 | 0.153 | 1 | 0/0 | 99.8 |

Largest writers in the last window:

| data/ file | writes | KB |
| --- | --- | --- |
| data/cache/similar.json | 4 | 11118.4 |
| data/healer.json | 9 | 989.8 |
| data/profiles.json | 111 | 754.4 |
| data/watch-sessions.json | 107 | 584.7 |
| data/cache/xray.json | 1 | 155.2 |
| data/healer.json.good1 | 1 | 110.4 |
| data/sessions.json | 18 | 72 |
| data/usage/* | 166 | 61 |
| data/profiles.json.good1 | 1 | 6.8 |
| data/watch-sessions.json.good1 | 1 | 5.4 |

Data folder growth by entry (last window):

```
{
 "cache/hls": -1403523533,
 "cache/img-variants": 108266,
 "cache/similar.json": 58533,
 "usage": 18248,
 "watch-sessions.json": 1038,
 "healer.json": 629,
 "healer.json.good1": 597,
 "cache/blur": 263,
 "cache/xray.json": 199,
 "telemetry-hours.json": 108
}
```
