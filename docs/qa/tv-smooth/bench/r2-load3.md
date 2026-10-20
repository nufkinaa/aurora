| scn | config | runs | frames | p50 / p90 / p99 ms | p99 per run | longest frame ms: median (worst run) | frames > 32 ms: median (total) | frames > 64 ms: median (total) | janky % | presented fps | refreshes without a new frame /1000 | UI thread held a frame > 32 / > 64 ms (total) | longest UI hold ms: median (worst) | RT CPU ms/frame | UI CPU ms/frame | PSS MB | GPU MB | views |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | rec | 2 | 536 | 12 / 25 / 36 | 31 42 | 46 (57) | 12 (23) | 0 (0) | 2.2 | 57.9 | 33.6 (29–38) | 3 / 0 (last 120 frames of each run) | 33 (44) | 5.4 | 4.4 | 262 | 66 | 566 |
| L1 | k | 2 | 604 | 12 / 24 / 36 | 34 38 | 47 (48) | 9 (18) | 0 (0) | 1.6 | 58.3 | 27.5 (26–29) | 2 / 0 (last 120 frames of each run) | 34 (35) | 5.6 | 4.1 | 265 | 66 | 566 |
| L1 | tk | 2 | 605 | 12 / 21 / 29 | 31 27 | 35 (36) | 2 (3) | 0 (0) | 0.9 | 58.5 | 24.4 (24–24) | 0 / 0 (last 120 frames of each run) | 22 (24) | 5.1 | 3.8 | 255 | 65 | 325 |
| G1 | rec | 2 | 458 | 14 / 26 / 52 | 57 46 | 157 (215) | 35 (70) | 2 (4) | 3.7 | 56.4 | 58.9 (49–69) | 13 / 3 | 123 (162) | 4.6 | 5.1 | 288 | 80 | 113 |
| G1 | k | 2 | 472 | 10 / 20 / 47 | 48 46 | 90 (126) | 20 (39) | 0 (1) | 3.0 | 57.6 | 39.9 (29–51) | 9 / 1 | 78 (112) | 4.5 | 4.6 | 280 | 73 | 113 |
| G1 | tk | 2 | 474 | 10 / 24 / 50 | 48 53 | 90 (113) | 25 (50) | 2 (5) | 3.2 | 57.1 | 46.6 (44–49) | 10 / 1 | 82 (104) | 4.5 | 4.6 | 276 | 72 | 113 |

Worst frame of each run (ms): whole = vsync → GPU done; then where it went.

| scn | config | run | whole | UI thread started late | input | animation (Fabric mounts run here) | layout | record | waits for RenderThread | sync | issue | swap → done |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | rec | 1 | 41 | 3 | 0 | 1 | 0 | 5 | 5 | 16 | 4 | 7 |
| L1 | rec | 2 | 58 | 6 | 0 | 35 | 2 | 1 | 0 | 1 | 8 | 5 |
| L1 | k | 1 | 48 | 6 | 0 | 9 | 2 | 1 | 6 | 14 | 5 | 6 |
| L1 | k | 2 | 50 | 17 | 0 | 15 | 2 | 1 | 0 | 2 | 6 | 6 |
| L1 | tk | 1 | 37 | 0 | 0 | 20 | 2 | 1 | 0 | 1 | 6 | 6 |
| L1 | tk | 2 | 35 | 0 | 0 | 16 | 3 | 1 | 0 | 1 | 6 | 7 |
| G1 | rec | 1 | 100 | 0 | 0 | 72 | 0 | 11 | 0 | 3 | 10 | 4 |
| G1 | rec | 2 | 215 | 0 | 0 | 148 | 0 | 13 | 0 | 35 | 11 | 8 |
| G1 | k | 1 | 126 | 0 | 0 | 109 | 0 | 2 | 0 | 0 | 4 | 10 |
| G1 | k | 2 | 55 | 0 | 0 | 43 | 0 | 1 | 0 | 0 | 4 | 6 |
| G1 | tk | 1 | 113 | 0 | 0 | 102 | 0 | 2 | 0 | 0 | 3 | 5 |
| G1 | tk | 2 | 68 | 13 | 0 | 1 | 0 | 26 | 0 | 9 | 14 | 4 |
