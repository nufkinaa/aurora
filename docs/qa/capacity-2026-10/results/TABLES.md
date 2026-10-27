## Knees

| run | mix | ref | PC busy before | knee | first step not supported (why) | knee, torrent starts not in the TTFF rule | largest step |
| --- | --- | --- | --- | --- | --- | --- | --- |
| direct-r1 | direct | 6638195@66381959 | 17 % | **200** | none | 200 | 200 |
| direct-r2 | direct | 6638195@66381959 | 16.2 % | **200** | none | 200 | 200 |
| typical-allfix-r1 | typical | 81d142b@81d142b9 | 16.6 % | **40** | 60: burst TTFF p95 5203 ms > 4000; 3.59 % late segments > 1; API p99 1067.6 ms > 300 | 40 | 60 |
| typical-allfix-r2 | typical | 81d142b@81d142b9 | 15.2 % | **30** | 40: 1.14 % late segments > 1; API p99 867.7 ms > 300 | 30 | 60 |
| typical-fixed | typical | 8639619@8639619e | 18.3 % | **15** | 20: burst TTFF p95 12833 ms > 4000 | 15 | 25 |
| typical-r1-uv4 | typical | 6638195@66381959 | 21.3 % | **20** | 25: burst TTFF p95 16523 ms > 4000; 1.23 % late segments > 1; API p99 14339.2 ms > 300 | 20 | 30 |
| typical-r1 | typical | 6638195@66381959 | 18 % | **30** | 40: burst TTFF p95 20726 ms > 4000 | 30 | 40 |
| typical-r2 | typical | 6638195@66381959 | 25 % | **25** (missed once at 20) | 30: burst TTFF p95 4584 ms > 4000 | 25 (missed once at 20) | 30 |
| typical-seeks | typical | 6638195@66381959 | 18 % | **25** | 30: burst TTFF p95 4526 ms > 4000 | 25 | 30 |
| typical-spread60 | typical | 6638195@66381959 | 25.5 % | **25** | 30: burst TTFF p95 13067 ms > 4000 | 25 | 40 |
| worst-allfix-r1 | worst | 81d142b@81d142b9 | 16.8 % | **30** (missed once at 10) | 40: burst TTFF p95 5602 ms > 4000 | 30 | 40 |
| worst-fixed | worst | 8639619@8639619e | 25.6 % | **10** (missed once at 5) | 15: burst TTFF p95 8601 ms > 4000 | 15 | 15 |
| worst-r1-uv4 | worst | 5dd310c@5dd310c2 | 17.8 % | **10** (missed once at 5) | 15: burst TTFF p95 15671 ms > 4000; API p99 6550.4 ms > 300 | 10 | 15 |
| worst-r1 | worst | 5dd310c@5dd310c2 | 16.2 % | **10** (missed once at 5) | 15: burst TTFF p95 8297 ms > 4000 | 15 | 15 |
| worst-r2 | worst | 5dd310c@5dd310c2 | 20.3 % | **15** (missed once at 10) | 20: burst TTFF p95 8030 ms > 4000 | 15 | 20 |

## Steps

### direct-r1 — direct, 6638195@66381959, threadpool 4, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 107/212/212 | phone-direct 212 | 12.4 | 4 | 0.057 + 0 |  | 0 | 0 | 7.1/10.5 | 1.7 | 0.018 + 0.021 | 0 (0) | 0 | 130 (+25) | 12.1 | 2.42 | 0 | yes |
| 10 | 5 | 108/216/216 | phone-direct 216 | 11.8 | 3 | 0.105 + 0 |  | 0 | 0 | 7.3/8.9 | 1.7 | 0.029 + 0 | 0 (0) | 0 | 143 (+25) | 25.7 | 2.57 | 0 | yes |
| 20 | 10 | 107/215/216 | phone-direct 216 | 13.7 | 10 | 0.241 + 0.001 |  | 0 | 0 | 6.6/8.7 | 1.9 | 0.046 + 0 | 0 (0) | 0 | 160 (+25) | 50.3 | 2.51 | 0 | yes |
| 30 | 15 | 108/215/216 | phone-direct 216 | 10.6 | 8 | 0.344 + 0.001 |  | 0 | 0 | 5.6/7.8 | 2 | 0.062 + 0 | 0 (0) | 0 | 174 (+25) | 76.5 | 2.55 | 0 | yes |
| 40 | 20 | 108/215/216 | phone-direct 216 | 13.5 | 9 | 0.482 + 0 |  | 0 | 0 | 5.3/8 | 2.5 | 0.088 + 0 | 0 (0) | 0 | 201 (+25) | 101.6 | 2.54 | 0 | yes |
| 60 | 30 | 108/215/216 | phone-direct 216 | 12.7 | 10 | 0.665 + 0 |  | 0 | 0 | 5.4/7.6 | 3.8 | 0.117 + 0 | 0 (0) | 0 | 214 (+25) | 152.3 | 2.54 | 0 | yes |
| 80 | 40 | 108/215/221 | phone-direct 221 | 15.8 | 14 | 0.926 + 0 |  | 0 | 0 | 5.6/8.1 | 4.3 | 0.165 + 0 | 0 (0) | 0 | 219 (+25) | 203.5 | 2.54 | 0 | yes |
| 100 | 50 | 110/214/217 | phone-direct 217 | 19.1 | 19 | 1.04 + 0 |  | 0 | 0 | 5.7/8.1 | 4.9 | 0.211 + 0 | 0 (0) | 0 | 220 (+25) | 253 | 2.53 | 0 | yes |
| 120 | 60 | 111/213/237 | tv-direct 237 | 21.4 | 15 | 1.402 + 0 |  | 0 | 0 | 6.1/8.7 | 6.5 | 0.259 + 0 | 0 (0) | 0 | 231 (+25) | 304.8 | 2.54 | 0 | yes |
| 160 | 80 | 201/299/401 | phone-direct 401 | 47.8 | 28 | 1.554 + 0 |  | 0 | 0 | 6.9/10.8 | 7.7 | 0.382 + 0 | 0 (0) | 0 | 259 (+25) | 404.8 | 2.53 | 0 | yes |
| 200 | 100 | 259/364/407 | web-direct 407 | 63.9 | 36 | 1.051 + 0 |  | 0 | 0 | 8.3/13.5 | 12.7 | 0.483 + 0 | 0 (0) | 0 | 325 (+25) | 505.2 | 2.53 | 0 | yes |

### direct-r2 — direct, 6638195@66381959, threadpool 6, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 108/213/213 | phone-direct 213 | 10.8 | 4 | 0.082 + 0 | 5.4 (8.19) | 0 | 0 | 8.3/10.1 | 2.2 | 0.019 + 0 | 0 (0) | 0 | 123 (+25) | 12.1 | 2.42 | 0 | yes |
| 10 | 5 | 108/215/215 | phone-direct 215 | 16.1 | 9 | 0.113 + 0 | 0.9 (7.76) | 0 | 0 | 6.7/8.3 | 2 | 0.024 + 0 | 0 (0) | 0 | 155 (+25) | 26.3 | 2.63 | 0 | yes |
| 20 | 10 | 108/215/215 | phone-direct 215 | 11.1 | 3 | 0.232 + 0 | 0.8 (8.18) | 0 | 0 | 5.7/8.1 | 1.6 | 0.049 + 0 | 0 (0) | 0 | 162 (+25) | 49.7 | 2.49 | 0 | yes |
| 30 | 15 | 108/215/216 | phone-direct 216 | 10.1 | 8 | 0.331 + 0 | 0.6 (7.85) | 0 | 0 | 4.9/7.8 | 2.3 | 0.064 + 0 | 0 (0) | 0 | 200 (+25) | 76.5 | 2.55 | 0 | yes |
| 40 | 20 | 107/214/215 | phone-direct 215 | 12.2 | 9 | 0.493 + 0 | 0.7 (7.9) | 0 | 0 | 5.6/8.7 | 2.6 | 0.084 + 0 | 0 (0) | 0 | 194 (+25) | 102.1 | 2.55 | 0 | yes |
| 60 | 30 | 116/216/224 | phone-direct 224 | 14 | 7 | 0.669 + 0.001 | 2.9 (8.31) | 0 | 0 | 5.5/7.5 | 3.6 | 0.12 + 0 | 0 (0) | 0 | 213 (+25) | 151.7 | 2.53 | 0 | yes |
| 80 | 40 | 108/214/215 | phone-direct 215 | 15.9 | 13 | 0.792 + 0 | 0.5 (7.89) | 0 | 0 | 5.2/7.9 | 4.6 | 0.17 + 0 | 0 (0) | 0 | 221 (+25) | 203 | 2.54 | 0 | yes |
| 100 | 50 | 109/213/219 | phone-direct 219 | 22.3 | 11 | 1.174 + 0 | 0.2 (7.96) | 0 | 0 | 5.7/8.5 | 5.9 | 0.206 + 0 | 0 (0) | 0 | 229 (+25) | 253.5 | 2.54 | 0 | yes |
| 120 | 60 | 111/213/215 | phone-direct 215 | 24 | 23 | 1.382 + 0 | 0.7 (8.19) | 0 | 0 | 6.2/9.3 | 5.1 | 0.263 + 0 | 0 (0) | 0 | 236 (+25) | 304.6 | 2.54 | 0 | yes |
| 160 | 80 | 212/305/473 | tv-direct 473 | 58.4 | 38 | 1.57 + 0 | 90.9 (65.19) | 0 | 0 | 7/11.2 | 7.7 | 0.402 + 0 | 0 (0) | 0 | 256 (+26) | 404.8 | 2.53 | 0 | yes |
| 200 | 100 | 300/460/518 | phone-direct 518 | 75.3 | 45 | 1.123 + 0.002 | 13 (20.75) | 0 | 0 | 7.8/13.8 | 12.2 | 0.524 + 0 | 0 (0) | 0 | 322 (+26) | 505.3 | 2.53 | 0 | yes |

### typical-allfix-r1 — typical, 81d142b@81d142b9, threadpool 6, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 644/2033/2033 | phone-jit 2033 | 12.9 | 4 | 0.153 + 0.973 | 3.9 (17.7) | 0 | 0 | 7/8.6 | 1.8 | 0.03 + 0.08 | 0 (0) | 0 | 148 (+97) | 22.5 | 4.49 | 0 | yes |
| 10 | 5 | 960/1506/1506 | phone-jit 1506 | 36.6 | 17 | 0.245 + 1.751 | 2.4 (13.09) | 0 | 0 | 6.9/8.5 | 1.7 | 0.046 + 0.156 | 0 (0) | 2.5 | 176 (+131) | 36.9 | 3.69 | 0 | yes |
| 15 | 8 | 843/1505/1505 | phone-jit 1505 | 71.8 | 22 | 0.339 + 2.935 | 5.4 (21.49) | 0 | 0 | 6.5/8.5 | 2.1 | 0.063 + 0.192 | 1 (1) | 3.3 | 174 (+136) | 45 | 3 | 0 | yes |
| 20 | 10 | 645/2186/2334 | phone-jit 2334 | 19.7 | 31 | 0.69 + 4.258 | 8.1 (58.18) | 0 | 0 | 6.5/8.1 | 1.9 | 0.078 + 0.101 | 1 (1) | 0.6 | 207 (+197) | 70.2 | 3.51 | 0 | yes |
| 25 | 13 | 736/2149/2229 | phone-jit 2229 | 44.9 | 33 | 0.539 + 3.595 | 9.9 (50.85) | 0 | 0 | 6.4/8.2 | 1.9 | 0.113 + 0.205 | 1 (1) | 1.5 | 230 (+296) | 87.6 | 3.51 | 0 | yes |
| 30 | 15 | 854/2409/2442 | phone-jit 2442 | 73.7 | 46 | 0.813 + 1.918 | 10 (57.57) | 0 | 0 | 6.6/10.6 | 2.4 | 0.144 + 0.395 | 0 (0) | 1.3 | 242 (+716) | 109 | 3.63 | 0 | yes |
| 40 | 20 | 828/2113/2227 | phone-jit 2227 | 37.2 | 38 | 0.906 + 4.906 | 7 (31.17) | 0 | 0 | 9.3/71.6 | 33.3 | 0.258 + 1.338 | 2 (2) | 2.5 | 278 (+439) | 126.2 | 3.15 | 0 | yes |
| 60 | 30 | 1429/5203/5702 | tv-offset 5702 | 115.4 | 135 | 0.765 + 4.573 | 14.8 (101.09) | 3.59 | 0 | 242.5/1067.6 | 637.2 | 0.392 + 1.747 | 2 (2) | 5.8 | 328 (+628) | 236.2 | 3.94 | 0 | no: burst TTFF p95 5203 ms > 4000; 3.59 % late segments > 1; API p99 1067.6 ms > 300 |

### typical-allfix-r2 — typical, 81d142b@81d142b9, threadpool 6, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 537/1183/1183 | phone-jit 1183 | 20 | 11 | 0.108 + 0.836 | 3.1 (14.71) | 0 | 0 | 7/8.3 | 1.5 | 0.022 + 0 | 0 (0) | 0 | 156 (+94) | 14.4 | 2.88 | 0 | yes |
| 10 | 5 | 537/2233/2233 | phone-jit 2233 | 24.6 | 12 | 0.305 + 2.527 | 2.4 (9.87) | 0 | 0 | 6.6/7.7 | 1.6 | 0.044 + 0.156 | 0 (0) | 0 | 166 (+133) | 33 | 3.3 | 0 | yes |
| 15 | 8 | 738/2237/2237 | phone-jit 2237 | 13.4 | 11 | 0.37 + 2.652 | 6.8 (16.88) | 0 | 0 | 7/9 | 2.3 | 0.064 + 0.169 | 0 (0) | 1.2 | 181 (+127) | 59.2 | 3.95 | 0 | yes |
| 20 | 10 | 615/2041/2268 | phone-jit 2268 | 19.4 | 17 | 0.523 + 3.36 | 10.2 (60.59) | 0 | 0 | 5.8/7.9 | 1.8 | 0.079 + 0.179 | 0 (0) | 0.9 | 190 (+232) | 64.9 | 3.24 | 0 | yes |
| 25 | 13 | 837/1675/2321 | phone-jit 2321 | 19 | 8 | 0.625 + 3.398 | 11.3 (46.75) | 0 | 0 | 5.9/8.2 | 2.4 | 0.118 + 0.309 | 2 (2) | 4.2 | 233 (+244) | 87.8 | 3.51 | 0 | yes |
| 30 | 15 | 751/2189/2228 | phone-jit 2228 | 29.8 | 19 | 0.672 + 3.12 | 8.7 (26.54) | 0 | 0 | 6.3/9.4 | 2.3 | 0.132 + 0.368 | 1 (1) | 2.7 | 251 (+631) | 106.7 | 3.56 | 0 | yes |
| 40 | 20 | 742/2320/3346 | phone-jit 3346 | 58.2 | 37 | 0.864 + 2.47 | 14.6 (91.91) | 1.14 | 0 | 7.9/867.7 | 10.2 | 0.226 + 0.84 | 3 (3) | 4.9 | 267 (+382) | 143.6 | 3.59 | 0 | no: 1.14 % late segments > 1; API p99 867.7 ms > 300 |
| 60 | 30 | 1015/5945/8666 | tv-offset 8666 | 83.1 | 83 | 1.191 + 3.771 | 17.2 (108.94) | 6.18 | 0 | 361.5/1635.5 | 554.8 | 0.42 + 2.302 | 5 (5) | 12.3 | 341 (+586) | 214.9 | 3.58 | 0 | no: burst TTFF p95 5945 ms > 4000; 6.18 % late segments > 1; API p99 1635.5 ms > 300 |

### typical-fixed — typical, 8639619@8639619e, threadpool 6, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 637/1394/1394 | phone-jit 1394 | 11.9 | 4 | 0.09 + 0.486 |  | 0 | 0 | 8/11 | 2.3 | 0.03 + 0.091 | 0 (0) | 0 | 173 (+90) | 18.5 | 3.71 | 0 | yes |
| 10 | 5 | 738/1292/1292 | phone-jit 1292 | 26.4 | 13 | 0.215 + 2.131 |  | 0 | 0 | 7.3/9.8 | 1.6 | 0.047 + 0.105 | 0 (0) | 2.4 | 165 (+94) | 33.2 | 3.32 | 0 | yes |
| 15 | 8 | 539/2351/2351 | phone-jit 2351 | 13.5 | 83 | 0.454 + 3.125 |  | 0 | 0 | 7/8 | 2.1 | 0.058 + 0.166 | 1 (1) | 0.7 | 188 (+132) | 52.1 | 3.47 | 0 | yes |
| 20 | 10 | 6948/12833/13706 | tv-torrent 13706 | 1170.1 | 1218 | 0.319 + 2.662 |  | 0 | 0 | 5.9/11.3 | 2.6 | 0.111 + 0.264 | 1 (1) | 1.1 | 220 (+239) | 70.4 | 3.52 | 0 | no: burst TTFF p95 12833 ms > 4000 |
| 25 | 13 | 11430/18425/18668 | phone-jit 18668 | 11618.1 | 11464 | 0.283 + 1.492 |  | 0 | 0 | 7.1/8.8 | 7 | 0.112 + 0.316 | 0 (0) | 1.5 | 231 (+345) | 88.7 | 3.55 | 0 | no: burst TTFF p95 18425 ms > 4000 |

### typical-r1-uv4 — typical, 6638195@66381959, threadpool 4, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 536/1290/1290 | tv-offset 1290 | 20.3 | 4 | 0.133 + 0.853 |  | 0 | 0 | 6.6/9.5 | 2.6 | 0.025 + 0.033 | 0 (0) | 0 | 159 (+93) | 17.3 | 3.47 | 0 | yes |
| 10 | 5 | 655/3112/3112 | tv-offset 3112 | 1242 | 865 | 0.121 + 0.836 |  | 0 | 0 | 7.4/9.7 | 2.4 | 0.046 + 0.186 | 1 (1) | 3.1 | 166 (+128) | 32.2 | 3.22 | 0 | yes |
| 15 | 8 | 756/1796/1796 | phone-transcode 1796 | 234.7 | 202 | 0.302 + 1.775 |  | 0 | 0 | 7.1/8.7 | 2.2 | 0.054 + 0.122 | 1 (1) | 1.4 | 191 (+166) | 45.9 | 3.06 | 0 | yes |
| 20 | 10 | 737/2427/3379 | phone-jit 3379 | 60.4 | 85 | 0.599 + 4.323 |  | 0 | 0 | 6.5/9.3 | 2.1 | 0.086 + 0.172 | 1 (1) | 3.5 | 193 (+238) | 77.3 | 3.87 | 0 | yes |
| 25 | 13 | 12183/16523/16984 | web-transcode 16984 | 12667.2 | 12681 | 0.309 + 1.829 |  | 1.23 | 0 | 636.6/14339.2 | 384.2 | 0.115 + 0.405 | 1 (1) | 2.8 | 214 (+304) | 85.3 | 3.41 | 0 | no: burst TTFF p95 16523 ms > 4000; 1.23 % late segments > 1; API p99 14339.2 ms > 300 |
| 30 | 15 | 3962/7875/8230 | phone-jit 8230 | 4113.8 | 3664 | 0.583 + 1.948 |  | 0.63 | 0 | 129.5/1277.7 | 301.3 | 0.161 + 0.675 | 1 (1) | 1.2 | 248 (+373) | 112.4 | 3.75 | 0 | no: burst TTFF p95 7875 ms > 4000; API p99 1277.7 ms > 300 |

### typical-r1 — typical, 6638195@66381959, threadpool 6, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 430/2144/2144 | phone-jit 2144 | 18.2 | 5 | 0.1 + 0.425 | 1.9 (13.92) | 0 | 0 | 7.1/8.6 | 1.6 | 0.023 + 0.022 | 0 (0) | 0 | 159 (+93) | 18.4 | 3.67 | 0 | yes |
| 10 | 5 | 762/2258/2258 | phone-jit 2258 | 33.9 | 10 | 0.273 + 2.232 | 5.8 (16.7) | 0 | 0 | 7.3/10.5 | 1.6 | 0.052 + 0.089 | 1 (1) | 2.4 | 153 (+131) | 37.6 | 3.76 | 0 | yes |
| 15 | 8 | 844/1582/1582 | phone-transcode 1582 | 18.9 | 64 | 0.322 + 2.545 | 3.5 (14.47) | 0 | 0 | 6.4/8.5 | 1.6 | 0.062 + 0.192 | 1 (1) | 1.2 | 173 (+129) | 48.3 | 3.22 | 0 | yes |
| 20 | 10 | 767/1256/1452 | phone-jit 1452 | 68.7 | 34 | 0.447 + 3.716 | 6.5 (54.8) | 0 | 0 | 5.2/8 | 1.8 | 0.084 + 0.172 | 1 (1) | 1.3 | 202 (+203) | 59.3 | 2.97 | 0 | yes |
| 25 | 13 | 645/1766/2380 | phone-jit 2380 | 25.2 | 32 | 0.576 + 3.755 | 9.9 (47.08) | 0 | 0 | 6/8.4 | 2.5 | 0.115 + 0.236 | 1 (1) | 3.6 | 233 (+558) | 83.7 | 3.35 | 0 | yes |
| 30 | 15 | 815/2414/11827 | tv-offset 11827 | 23.5 | 47 | 0.932 + 5.946 | 17.3 (98.01) | 0 | 0 | 6.8/11.9 | 2.5 | 0.139 + 0.314 | 1 (1) | 1.6 | 246 (+302) | 115.1 | 3.84 | 0 | yes |
| 40 | 20 | 744/20726/25642 | tv-offset 25642 | 70.9 | 21 | 0.989 + 6.471 | 17.6 (111.38) | 0 | 0 | 6/8.5 | 2.8 | 0.195 + 0.424 | 1 (1) | 1.2 | 287 (+447) | 136.8 | 3.42 | 0 | no: burst TTFF p95 20726 ms > 4000 |

### typical-r2 — typical, 6638195@66381959, threadpool 6, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 645/2018/2018 | phone-jit 2018 | 19.1 | 4 | 0.118 + 0.276 | 2.1 (13.88) | 0 | 0 | 7.3/8.6 | 2.1 | 0.024 + 0.112 | 0 (0) | 0 | 157 (+100) | 20 | 4 | 0 | yes |
| 10 | 5 | 652/2470/2470 | phone-jit 2470 | 165.5 | 390 | 0.187 + 1.668 | 73.2 (26.95) | 0 | 0 | 7.3/9.2 | 2.3 | 0.04 + 0.059 | 0 (0) | 0 | 169 (+129) | 38.6 | 3.86 | 0 | yes |
| 15 | 8 | 752/1696/1696 | phone-transcode 1696 | 15.3 | 21 | 0.355 + 2.975 | 2.3 (10.41) | 0 | 0 | 7.6/153.8 | 20 | 0.065 + 0.231 | 1 (1) | 1.2 | 186 (+234) | 49.7 | 3.31 | 0 | yes |
| 20 | 10 | 1193/12291/15217 | tv-torrent 15217 | 5366.1 | 5660 | 0.262 + 2.256 | 97.6 (29.58) | 0 | 0 | 7.5/179.4 | 101.8 | 0.11 + 0.336 | 1 (1) | 1.6 | 220 (+243) | 72.9 | 3.64 | 0 | no: burst TTFF p95 12291 ms > 4000 |
| 25 | 13 | 950/1826/2117 | phone-jit 2117 | 26 | 29 | 0.696 + 4.997 | 10 (74.11) | 0 | 0 | 6.6/11.8 | 2.6 | 0.095 + 0.106 | 1 (1) | 1.2 | 229 (+255) | 84 | 3.36 | 0 | yes |
| 30 | 15 | 750/4584/5624 | tv-offset 5624 | 132.9 | 293 | 0.799 + 4.922 | 13.9 (64.18) | 0 | 0 | 7.7/199.5 | 118 | 0.134 + 0.291 | 0 (0) | 2.8 | 247 (+274) | 99.4 | 3.31 | 0 | no: burst TTFF p95 4584 ms > 4000 |

### typical-seeks — typical, 6638195@66381959, threadpool 6, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 672/1288/1288 | phone-jit 1288 | 20.4 | 4 | 0.072 + 0.224 | 1 (11.9) | 0 | 0 | 7.7/9.4 | 2.1 | 0.034 + 0.121 | 0 (0) | 0 | 146 (+92) | 22.9 | 4.58 | 0 | yes |
| 10 | 5 | 553/1375/1375 | phone-jit 1375 | 14.6 | 18 | 0.136 + 0.941 | 3.8 (7.82) | 0 | 0 | 7.5/14 | 1.8 | 0.053 + 0.365 | 0 (0) | 0 | 176 (+126) | 36.7 | 3.67 | 0 | yes |
| 15 | 8 | 951/1399/1399 | phone-jit 1399 | 12.1 | 7 | 0.407 + 3.076 | 7.1 (43.87) | 0 | 0 | 6.9/9.4 | 2.4 | 0.09 + 0.264 | 0 (0) | 0.6 | 177 (+168) | 67.8 | 4.52 | 0 | yes |
| 20 | 10 | 646/2133/2133 | phone-jit 2133 | 22.7 | 34 | 0.555 + 3.194 | 10.4 (61.41) | 0 | 0 | 6.3/10 | 1.9 | 0.107 + 0.31 | 0 (0) | 0.6 | 210 (+200) | 88.4 | 4.42 | 0 | yes |
| 25 | 13 | 752/2784/3795 | phone-jit 3795 | 14.8 | 10 | 0.615 + 3.969 | 9.5 (25.21) | 0 | 0 | 5.6/8 | 2.2 | 0.123 + 0.392 | 0 (0) | 0.9 | 221 (+303) | 98.2 | 3.93 | 0 | yes |
| 30 | 15 | 941/4526/5793 | web-transcode 5793 | 30.3 | 87 | 0.888 + 5.002 | 11.6 (68.53) | 0 | 0.012 | 6.2/9.1 | 2.7 | 0.157 + 0.646 | 1 (1) | 0.9 | 235 (+342) | 130 | 4.33 | 0 | no: burst TTFF p95 4526 ms > 4000 |

### typical-spread60 — typical, 6638195@66381959, threadpool 6, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 551/1503/1503 | phone-jit 1503 | 16.2 | 8 | 0.075 + 0.695 | 2.5 (13.07) | 0 | 0 | 7.8/8.9 | 1.9 | 0.028 + 0.063 | 0 (0) | 0 | 157 (+94) | 16.7 | 3.34 | 0 | yes |
| 10 | 5 | 645/2360/2360 | phone-jit 2360 | 14.1 | 13 | 0.15 + 1.028 | 4.1 (23.71) | 0 | 0 | 8/17.1 | 1.7 | 0.042 + 0.079 | 0 (0) | 0 | 174 (+125) | 36.7 | 3.67 | 0 | yes |
| 15 | 8 | 644/2147/2147 | phone-jit 2147 | 16.3 | 4 | 0.205 + 1.541 | 3.1 (31.15) | 0 | 0 | 6.5/8.8 | 1.9 | 0.066 + 0.273 | 1 (1) | 3.7 | 179 (+232) | 53.9 | 3.59 | 0 | yes |
| 20 | 10 | 644/2668/3221 | phone-jit 3221 | 323.1 | 502 | 0.206 + 1.856 | 41.6 (36.33) | 0 | 0 | 7.4/52.9 | 5.7 | 0.088 + 0.274 | 1 (1) | 3.7 | 202 (+240) | 68.8 | 3.44 | 0 | yes |
| 25 | 13 | 537/2557/3764 | phone-jit 3764 | 16.7 | 798 | 0.432 + 2.785 | 12 (55.95) | 0 | 0 | 6/9 | 2.3 | 0.098 + 0.265 | 1 (1) | 1 | 223 (+340) | 80.5 | 3.22 | 0 | yes |
| 30 | 15 | 1073/13067/13511 | tv-offset 13511 | 10816 | 10657 | 0.331 + 2.252 | 38.1 (44.93) | 0 | 0 | 6.9/11.2 | 2.5 | 0.132 + 0.435 | 1 (1) | 3.9 | 241 (+343) | 99.8 | 3.33 | 0 | no: burst TTFF p95 13067 ms > 4000 |
| 40 | 20 | 1165/12338/24409 | tv-torrent 24409 | 6056.6 | 9328 | 0.556 + 4.233 | 42.7 (66.37) | 0 | 0 | 10/88.6 | 100.5 | 0.216 + 0.534 | 3 (3) | 6.5 | 276 (+418) | 139 | 3.47 | 0 | no: burst TTFF p95 12338 ms > 4000 |

### worst-allfix-r1 — worst, 81d142b@81d142b9, threadpool 6, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 1304/3097/3097 | web-tjit 3097 | 24.3 | 17 | 0.253 + 0.518 | 2.8 (41.66) | 0 | 0 | 12.4/18.2 | 2.1 | 0.03 + 0.102 | 2 (2) | 4.5 | 167 (+60) | 14.6 | 2.93 | 0 | yes |
| 10 | 5 | 768/8388/8388 | web-tjit 8388 | 33.9 | 19 | 0.457 + 3.158 | 9.5 (78.73) | 0 | 0 | 7.6/10.1 | 2 | 0.079 + 0.154 | 0 (0) | 1.5 | 225 (+99) | 29.3 | 2.93 | 0 | no: burst TTFF p95 8388 ms > 4000 |
| 15 | 8 | 751/2566/2566 | phone-transcode 2566 | 30.9 | 55 | 0.426 + 2.861 | 12 (72.42) | 0 | 0 | 7/13.6 | 2.9 | 0.097 + 0.164 | 3 (3) | 4.3 | 251 (+682) | 39.8 | 2.65 | 0 | yes |
| 20 | 10 | 951/2112/3377 | web-transcode 3377 | 30.7 | 29 | 0.545 + 2.846 | 6.9 (68.53) | 0 | 0 | 6.5/7.9 | 3.3 | 0.126 + 0.249 | 3 (3) | 6.9 | 299 (+166) | 53 | 2.65 | 0 | yes |
| 30 | 15 | 1160/3408/4114 | tv-offset 4114 | 188.3 | 103 | 0.731 + 5.305 | 8 (23.98) | 0 | 0 | 7.5/12.2 | 4.9 | 0.172 + 1.687 | 8 (6) | 7.2 | 305 (+237) | 84.3 | 2.81 | 0 | yes |
| 40 | 20 | 963/5602/7415 | tv-offset 7415 | 45.5 | 54 | 0.869 + 6.221 | 9.5 (30.99) | 0.19 | 0 | 12.3/277.2 | 122.1 | 0.238 + 2.521 | 9 (6) | 11 | 317 (+309) | 105.3 | 2.63 | 0 | no: burst TTFF p95 5602 ms > 4000 |

### worst-fixed — worst, 8639619@8639619e, threadpool 6, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 977/4405/4405 | web-tjit 4405 | 18.1 | 40 | 0.303 + 1.309 | 5.5 (41.75) | 0 | 0 | 8.4/12.6 | 2 | 0.027 + 0.091 | 1 (1) | 3.1 | 180 (+60) | 14.6 | 2.93 | 0 | no: burst TTFF p95 4405 ms > 4000 |
| 10 | 5 | 1070/2871/2871 | web-tjit 2871 | 19.5 | 19 | 0.389 + 2.346 | 5.6 (52.5) | 0 | 0 | 9.2/12.2 | 1.7 | 0.053 + 0.225 | 3 (3) | 5.2 | 225 (+654) | 29.4 | 2.94 | 0 | yes |
| 15 | 8 | 939/8601/8601 | web-tjit 8601 | 75 | 93 | 0.698 + 4.682 | 9.5 (91.38) | 0 | 0 | 6.8/8.6 | 3.3 | 0.129 + 0.18 | 1 (1) | 5.5 | 254 (+132) | 35.5 | 2.37 | 0 | no: burst TTFF p95 8601 ms > 4000 |

### worst-r1-uv4 — worst, 5dd310c@5dd310c2, threadpool 4, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 1290/4834/4834 | web-tjit 4834 | 793.5 | 1220 | 0.227 + 1.237 |  | 0 | 0 | 7.8/10.9 | 2.1 | 0.03 + 0.088 | 1 (1) | 3.8 | 159 (+25) | 14.6 | 2.93 | 0 | no: burst TTFF p95 4834 ms > 4000 |
| 10 | 5 | 1075/3951/3951 | web-tjit 3951 | 49.6 | 169 | 0.494 + 3.3 |  | 0 | 0 | 9.5/12.1 | 2.5 | 0.072 + 0.132 | 1 (1) | 3.4 | 204 (+468) | 25.9 | 2.59 | 0 | yes |
| 15 | 8 | 10583/15671/15671 | tv-torrent 15671 | 6905.8 | 854 | 0.414 + 2.477 |  | 0.23 | 0 | 8.5/6550.4 | 4.1 | 0.133 + 0.157 | 2 (2) | 4.8 | 273 (+132) | 44.8 | 2.98 | 0 | no: burst TTFF p95 15671 ms > 4000; API p99 6550.4 ms > 300 |

### worst-r1 — worst, 5dd310c@5dd310c2, threadpool 6, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 982/4949/4949 | web-tjit 4949 | 15.5 | 11 | 0.22 + 0.994 | 2.3 (34.35) | 0 | 0 | 8.1/9.7 | 2.1 | 0.025 + 0.027 | 0 (0) | 0.6 | 161 (+25) | 14.5 | 2.89 | 0 | no: burst TTFF p95 4949 ms > 4000 |
| 10 | 5 | 1075/2366/2366 | web-transcode 2366 | 33.4 | 25 | 0.23 + 0.768 | 63.8 (25.11) | 0 | 0 | 7.7/9.5 | 1.6 | 0.046 + 0.157 | 1 (1) | 6.6 | 201 (+362) | 27.2 | 2.72 | 0 | yes |
| 15 | 8 | 959/8297/8297 | web-tjit 8297 | 39.9 | 51 | 0.541 + 3.993 | 14 (100.69) | 0 | 0 | 7.3/11.7 | 3.7 | 0.133 + 0.223 | 2 (2) | 6.1 | 252 (+394) | 37.1 | 2.47 | 0 | no: burst TTFF p95 8297 ms > 4000 |

### worst-r2 — worst, 5dd310c@5dd310c2, threadpool 6, links tv=80,phone=50,desktop=200

| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 1077/2055/2055 | tv-torrent 2055 | 14 | 21 | 0.239 + 0.704 |  | 0 | 0 | 8.4/18.2 | 2.3 | 0.028 + 0.121 | 0 (0) | 3.7 | 168 (+63) | 12.3 | 2.45 | 0 | yes |
| 10 | 5 | 1071/4770/4770 | web-tjit 4770 | 32.9 | 13 | 0.43 + 2.461 |  | 0 | 0 | 7.9/15.7 | 2.8 | 0.08 + 0.17 | 1 (1) | 5 | 232 (+94) | 27.7 | 2.77 | 0 | no: burst TTFF p95 4770 ms > 4000 |
| 15 | 8 | 1076/2249/2249 | phone-jit 2249 | 70.5 | 14 | 0.55 + 3.066 |  | 0 | 0 | 7.3/11.5 | 3.5 | 0.099 + 0.186 | 2 (2) | 2 | 246 (+168) | 40 | 2.67 | 0 | yes |
| 20 | 10 | 2860/8030/8634 | tv-torrent 8634 | 721.3 | 357 | 0.381 + 2.135 |  | 0 | 0 | 7/104.3 | 3.9 | 0.122 + 0.203 | 3 (3) | 5.3 | 293 (+162) | 46.7 | 2.34 | 0 | no: burst TTFF p95 8030 ms > 4000 |

## Bandwidth

Per viewer: the files' own bitrate averaged over each mix (direct 2.58 Mbit/s, typical 3.53 Mbit/s, worst 2.71 Mbit/s); measured over the windows, read-ahead included: direct 2.53, typical 3.57, worst 2.66. Streams that fit, at 80 % of the upload:

| upload Mbit/s | direct (2.58 Mbit/s) | typical (3.53 Mbit/s) | worst (2.71 Mbit/s) | house library mean (2.7) | house p90 file (4.2) | Blu-ray-class (8) | 4K remux (25) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20 | 6 | 4 | 5 | 5 | 3 | 2 | 0 |
| 50 | 15 | 11 | 14 | 14 | 9 | 5 | 1 |
| 100 | 31 | 22 | 29 | 29 | 19 | 10 | 3 |
| 500 | 155 | 113 | 147 | 148 | 95 | 50 | 16 |
| 1000 | 310 | 226 | 295 | 296 | 190 | 100 | 32 |
