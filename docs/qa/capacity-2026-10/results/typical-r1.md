### typical — 6638195@66381959 — 2026-10-27T01:09:31.973Z

typical (house-recorded): 30 % direct, 55 % repackaged (TV offset copy, web/phone jit copy), 10 % encoded (720p/480p rungs), 5 % torrent; TVs 55 %, phones 25 %, desktops 20 %. Steps of 4 min after a cold burst; 2 background downloads; host Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 threads, 32 GB).

| n viewers | browsing | burst TTFF p50/p95 ms | window TTFF p95 | late seg % | starved seg % | stall % of watch | API p95/p99 ms | pictures p95 | lag p99 ms | server cores | ffmpeg cores | GPU enc % (sessions) | encodes/limit (card/max) | RSS MB (+ffmpeg) | PC CPU % | egress Mbit/s | Mbit/viewer | refused | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 430/2144 |  | 0 | 0 | 0 | 7.1/8.6 | 5.2 | 1.6 | 0.023 | 0.022 | 0 (0) | 0/5 (0/6) | 159 (+93) | 17.3 | 18.4 | 3.67 | 0 | supported |
| 10 | 5 | 762/2258 |  | 0 | 0 | 0 | 7.3/10.5 | 4 | 1.6 | 0.052 | 0.089 | 2.4 (1) | 1/6 (1/6) | 153 (+131) | 17.7 | 37.6 | 3.76 | 0 | supported |
| 15 | 8 | 844/1582 |  | 0 | 0 | 0 | 6.4/8.5 | 5 | 1.6 | 0.062 | 0.192 | 1.2 (1) | 1/6 (1/6) | 173 (+129) | 19.2 | 48.3 | 3.22 | 0 | supported |
| 20 | 10 | 767/1256 |  | 0 | 0 | 0 | 5.2/8 | 6 | 1.8 | 0.084 | 0.172 | 1.3 (1) | 1/6 (1/6) | 202 (+203) | 18.8 | 59.3 | 2.97 | 0 | supported |
| 25 | 13 | 645/1766 |  | 0 | 0 | 0 | 6/8.4 | 5.4 | 2.5 | 0.115 | 0.236 | 3.6 (1) | 1/6 (1/6) | 233 (+558) | 20.5 | 83.7 | 3.35 | 0 | supported |
| 30 | 15 | 815/2414 |  | 0 | 0 | 0 | 6.8/11.9 | 69.2 | 2.5 | 0.139 | 0.314 | 1.6 (1) | 1/6 (1/6) | 246 (+302) | 21.1 | 115.1 | 3.84 | 0 | supported |
| 40 | 20 | 744/20726 |  | 0 | 0 | 0 | 6/8.5 | 12.1 | 2.8 | 0.195 | 0.424 | 1.2 (1) | 1/6 (1/6) | 287 (+447) | 22.7 | 136.8 | 3.42 | 0 | **no**: burst TTFF p95 20726 ms > 4000 |
