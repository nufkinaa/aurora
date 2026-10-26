# Load + soak harness

How many households, viewers and streams one Aurora server carries, and whether
a change made that better or worse — measured on a PRIVATE instance built from
any git ref. Results and the method: `docs/qa/server-round/LOADTEST.md`.

Needs Node 20+, git, ffmpeg on PATH (only for `--media gen`), `npm ci` done
in this worktree (the harness uses its `ws`). Windows or Linux.

## Commands

```
# one run: a scenario at one size, measured for a window
node tools/loadtest/run.js once  --ref master --scenario evening --n 8 --minutes 5

# capacity: the same scenario at growing sizes on one instance, until it degrades twice
node tools/loadtest/run.js ramp  --ref master --scenario evening    --steps 4,8,16,24,32,48 --step-min 2
node tools/loadtest/run.js ramp  --ref master --scenario streams    --steps 2,4,6,8,12      --step-min 3
node tools/loadtest/run.js ramp  --ref master --scenario households --steps 15,30,45,60     --step-min 3

# leaks: hours of evening load, one measured window every 10 minutes (partial JSON after each)
node tools/loadtest/run.js soak  --ref master --scenario evening --n 8 --minutes 120

# A/B: fresh instances taking turns A B B A A B …, same scenario and size
node tools/loadtest/run.js ab    --a master --b srv-storage --scenario evening --n 16 --minutes 4 --rounds 3

# the tables again, or two runs side by side
node tools/loadtest/report.js docs/qa/server-round/loadtest-results/<name>.json [--vs <other>.json]

# just the instance, to poke at by hand (CTRL-C tears it down)
node tools/loadtest/instance.js --ref master --profiles 8
```

Common options:

| Option | Meaning |
| --- | --- |
| `--ref <ref>` | branch, tag, sha, **or a directory** (another worktree, uncommitted work included) |
| `--media real\|gen` | `real` (default): the live config's `libraries` (read only); `gen`: a generated library in the scratch folder (10-minute 1080p files at 6/8/25 Mbit + 300 small films) for machines without the real one, or to keep the HDD out of a streaming test |
| `--warm <s>` | seconds between "everyone has arrived" and the window (default 30–60) |
| `--seek-min <m>` | a viewer seeks about every m minutes, half the time (default 12) |
| `--play-min <m>` | (soak) a viewer starts the next title after m minutes (default 30) |
| `--stop-after <k>` | (ramp) stop after k degraded steps (default 2) |
| `--machine <p>` | the server on a smaller box: `2core`, `4core` (CPU affinity on the server and every ffmpeg it starts), `lowmem` (256 MB heap + a 320 MB hard working-set cap on Windows), `starved` (192 MB heap, 140 MB working set: it pages), `small` (= 2core + lowmem), `nogpu`; comma-combinable (`2core,lowmem`) |
| `--mix <kinds>` | the streams' kinds instead of the scenario's: `web-direct`, `tv-direct`, `web-jit`, `tv-offset`, `web-transcode`, `web-torrent` |
| `--node <path>` | the Node binary for the SERVER (e.g. Node 20 beside a Node 22 driver) |
| `--media <dir>` | a library folder of one's own (`<dir>/movies`, `<dir>/shows`), e.g. inside WSL |
| `--torrent` | torrent viewers (`--mix web-torrent`): the instance gets the internet and its torrent engine (no network fence, `prewarmStreams` off). Plays real swarms — off by default, not part of any baseline, not run in this round |
| `--no-settle` | measure from the boot on (default: wait until the boot's own background work is done) |
| `--config '<json>'` | extra config.json keys for the instance |
| `--out <name>` | result file name (default `<cmd>-<scenario>-<time>`) |
| `--verbose` | echo the server's output |

Environment: `LT_WORK` (scratch, default `%TEMP%/aurora-agents/srv-loadtest`),
`LT_OUT` (results, default `docs/qa/server-round/loadtest-results/`),
`LT_LIVE_ROOT` (where the live tree is, default `C:\elia\aurora`; only its
`config.json` `libraries`/`scanIntervalMinutes` and the safe caches in `data/`
are read).

## Capacity: how many people (capacity.js)

`capacity.js` answers "how many people at once" for one machine: a household
evening stepped up (`--steps`), every step a cold **9 pm burst** (each viewer
opens the app, Home, the title page, the subtitle, then Play — the viewers of
the step before leave first), n/2 people browsing and n/2 devices idle beside
them, background downloads writing to the media disk, then a measured window.
Results and the method: `docs/qa/capacity-2026-10/REPORT.md`.

```
node tools/loadtest/capacity.js --ref <ref> --mix typical --steps 5,10,15,20,30,40 --step-min 4 --out typical-r1
node tools/loadtest/capacity.js --ref <ref> --mix direct  --steps 5,10,20,30,40,60,80,100,120
node tools/loadtest/capacity.js --ref <ref> --mix worst   --steps 5,10,15,20,30
node tools/loadtest/capacity-report.js docs/qa/capacity-2026-10/results/*.json   # knees + streams per upload
```

| Option | Meaning |
| --- | --- |
| `--mix typical\|direct\|worst` | the viewers' paths, a cycle in `MIXES` (typical = what the house recorded; worst = 40 % encoded, 30 % torrents) |
| `--link tv=80,phone=50,desktop=200` | each device's own network in Mbit/s (`http.js` `linkMbit`); `off` = loopback speed, which no real device has |
| `--downloads k` | background downloads: k writers at 4 MB/s on the media disk (default 2) |
| `--spread s` | the burst's spread: everyone presses Play within s seconds (default 10) |
| `--stop-after k` | stop after k steps that are not supported (default 2) |

- Library: media `cap` (`instance.js` `genMediaCap`), shaped like the house's: five 30-minute 1080p masters at 2–7 Mbit/s (H.264 MP4 AAC / AC-3, HEVC 10-bit MKV E-AC-3, HEVC MKV AAC), each under 8 names, two subtitle sidecars each.
- Torrent viewers play from `swarm.js`: a tracker and a seeder on 127.0.0.1; the instance keeps its network fence and finds the swarm through the `.torrent` dropped into its metadata cache.
- Phones: the website with an iPhone user agent, Apple's fMP4 HLS (`seg=fmp4`), the 480p rung when encoded.
- "Supported" (`RULE` in `capacity.js`): burst and in-window TTFF p95 ≤ 4 s, late segments ≤ 1 %, stalled ≤ 0.5 % of watch time, API p99 ≤ 300 ms, nothing refused.
- Measured besides: segments late (slower than real time) / starved (after the buffer ran dry), event-loop lag during the burst and the window, server and ffmpeg cores, the graphics card (`lib.js` `gpuSampler`: nvidia-smi), the server's own encoder count (`/api/admin/encoding`, the instance's own admin password), disk, RAM, the PC.

## Linux (WSL)

```
# once: a clone of the repo and the generated media inside WSL, and a settled seed for them
wsl -d Ubuntu -e bash -lc 'mkdir -p ~/aurora-lt && cd ~/aurora-lt && git clone /mnt/c/elia/aurora repo && cd repo && git checkout srv-loadtest && PATH=~/node22/bin:$PATH npm ci --omit=dev'
wsl -d Ubuntu -e bash -lc 'cp -a /mnt/c/Users/<you>/AppData/Local/Temp/aurora-agents/srv-loadtest/media-gen-v1-300 ~/aurora-lt/media'
wsl -d Ubuntu -e bash -lc 'cd ~/aurora-lt && LT_WORK=~/aurora-lt/work ~/node22/bin/node repo/tools/loadtest/wsl-seed.js --from /mnt/c/Users/<you>/AppData/Local/Temp/aurora-agents/srv-loadtest/seed-gen-v1 --win-media "C:\\Users\\<you>\\AppData\\Local\\Temp\\aurora-agents\\srv-loadtest\\media-gen-v1-300" --media ~/aurora-lt/media'
# a ramp (keep the wsl command attached: WSL ends background processes with the session)
wsl -d Ubuntu -e bash -lc 'cd ~/aurora-lt && PATH=~/node22/bin:$PATH LT_WORK=~/aurora-lt/work LT_OUT=/mnt/c/elia/aurora-srv-load/docs/qa/server-round/loadtest-results node repo/tools/loadtest/run.js ramp --ref master --scenario evening --steps 4,8,16,32,48 --media /home/elia/aurora-lt/media --mix web-direct,tv-direct'
```

The generated media and its seed come from one Windows run with `--media gen`.
Ubuntu here has no ffmpeg (nor has CI): the library is known from the seed's
probes, so only direct play is driven (`--mix web-direct,tv-direct`). Use
`--node ~/node20/bin/node` for a Node 20 server. Refs in the clone are
`master` or `origin/<branch>` (`git -C ~/aurora-lt/repo fetch` first).

## Scenarios

`n` is households for `evening` and `households`, streams for `streams`. A
household is one profile with a browser AND a TV, each with its own session,
connections, WebSocket and picture cache.

| Scenario | Browsing | Streams |
| --- | --- | --- |
| `evening` | 60 % of browsers (a screen every ~20 s), 40 % of TVs (~35 s); the rest idle on Home | max(3, n/2): web direct, TV direct, web jit (copy), TV offset (copy), web direct, web 720p encode — in that order |
| `streams` | a few households | n, 10 % encoded |
| `households` | 25 % of browsers (~45 s), 10 % of TVs; the rest idle (WebSocket, netprobe every 5 min, usage, TV version/tuning polls) | 2 |

## What a device does (read off the client code)

- **Website boot** (`public/index.html:84-115`, `main.js:731-895`, `prefetch.js:151-177`): me, server-info, profiles, state, Home (`X-Early`); WebSocket + `hello`; downloads, changelog, ai/status; 2.5 s later watchlist, library, catalog trending + genres for films and shows, 500 ms apart. Netprobe (`?kb=48`) at 1.2 s and every 5 min while not playing. Usage batches every 20 s.
- **TV boot** (`App.tsx`, `SessionWiring.tsx`, `prefetch.ts`): ping, me, profile-token, WebSocket + `hello` (app/build/model), profiles, Home `slim=1` with `If-None-Match`, party; `tv-version.json` at 1.5 s and every 30 min; prefetch library, catalogs, genres, `/api/tv/tuning`.
- **Browsing** (one screen per think time): Home 25 % (hero backdrop at 1920/1280, the cards in view at w=360/256), grids 18 % (`/api/catalog` pages, genres, library), title pages 35 % + 4 % (`/api/item`, `discover/meta`, `discover/similar`, collection or trailer, state, server-info; X-Ray one visit in five; the person sheet one in three), search 15 % (suggest per keystroke after the client's debounce, aborting the older ask; results; `commit=1`; the `wait=1&pin=` follow-up; saved search), My List 3 %. A picture is fetched once per device.
- **Playing** (`player.js`, `Player.tsx`): play marks; progress POST every 5 s (TV: when moved ≥ 4 s); WebSocket `activity` every 5 s; last save + `Browsing` + `jit/bye` on exit.
  - web direct: `/stream/video/:id` by `Range: bytes=N-`, reading paused above 120 s buffered and resumed under 60 s (TCP backpressure, as a media element does);
  - TV direct: the same with ExoPlayer's 50/120 s (`Player.tsx:205-208`), start at 2 s buffered, 8 s after a stall;
  - web jit: `master.m3u8` (with `X-Aurora-Start`), the `v=copy` rendition (or `v=h264-720` for the encoded viewer), segments while under 45 s buffered (hls.js `maxBufferLength`);
  - TV offset: `/<ss>/index.m3u8?v=copy&seek=1` claim, the growing playlist polled, segments to 120 s buffered;
  - seeks: about every `--seek-min` minutes, half the time, ±1–20 min; a direct viewer opens a new range, a jit viewer jumps in the segment list, the TV offset viewer claims a new `<ss>`.
- Clients' manners: a 429 is retried after Retry-After + up to 1.5 s, twice. WebSocket reconnects with 50–100 % of a backoff doubling from 1 s to 30 s. `library_updated` makes the website refetch library + state (+ Home on Home), the TV its Home.

## What is measured

Client side (the devices): latency per route group (p50/p95/p99/max), errors split into 5xx / transport / 429 / 503, time to first frame and to first segment, seeks, and **stalls per viewer** from a simulated player buffer (`buffer.js`: playback starts once 2–2.5 s is buffered, a stall is the playhead reaching the end of what has arrived, it resumes at 5–8 s). A `/healthz` request five times a second on its own connection (the wait anyone would meet).

Server side, from inside (`probe.js`, preloaded; changes nothing): event-loop delay histogram, **loop stalls** (> 50/100/250/1000 ms, their total; on Windows timers tick at 15.6 ms so the histogram's median reads ~14 ms on an idle server — the stall counts and ELU are what compare), event-loop utilisation, CPU, RSS/heap/GC, handles, fs calls per function (counted, not timed), **bytes written per data/ file**, server-side time per route group. From outside (`lib.js treeSampler`): CPU of the server AND of every child (ffmpeg), handles, threads, RSS. The data folder's size and file count per window. The whole PC's CPU and the library disk's busy % (other agents share this PC: context for every wall-clock number).

**Degraded** (the ramp's yardstick): browse p99 > 1 s, browse errors > 0.5 %, any 429, any stall, a viewer that never started, a refused stream, a loop stall > 1 s, or the loop stalled > 2 % of the window.

## Safety

- The instance is a copy of the ref's code in `LT_WORK/deps-<lock>/i-*`, its own port, its own data folder, its own TEMP; `test/ui/support/server-preload.js` (of this worktree) refuses every outbound connection and kills the instance when the harness dies. **No junctions or symlinks**: dependencies are `npm ci`'d once per package-lock in `LT_WORK/deps-<lock>/` and found by Node walking up from the instance folder; the big picture caches are hard links to the scratch seed copy.
- The live data folder is only READ, once a day, and only the caches of public catalogue facts and of what the server worked out about the files (probes, intros, subtitle languages, pictures) — never profiles, sessions, history, usage, downloads, logs, backups, push, avatars, settings. Profiles and sessions are synthetic (`Load 1…n`).
- The library is never written: `torrents: false` (no downloads, so no landing in the library and no smart clean-up), `autoOcrSubtitles: false` (OCR writes `.srt` next to videos), `preconvert: false`, `backups: false`, `healer.autoRepair: false`, My List downloads/auto-delete off, the daily round never due, `downloads.json` empty, every profile `prefs.smartCleanup: false`, and no client route that saves subtitles is driven. The probe lists any write outside `data/` (`writesOutsideData`).
- The live server on :4000 is never contacted. Notifications are empty.
- The library disk is the household's: stream-heavy runs on `--media real` read it at real-time rates; use `--media gen` (scratch, on the SSD) to go past ~10 streams.

## Files

| File | What it does |
| --- | --- |
| `run.js` | scenarios, the load (households, viewers), windows, verdicts; `once`, `ramp`, `soak`, `ab` |
| `devices.js` | the website and the TV, request by request |
| `buffer.js` | the simulated player buffer (stalls, time to first frame, seeks) |
| `http.js` | a keep-alive HTTP client per device that never throws |
| `instance.js` | a private instance from any ref; the seed; generated media |
| `probe.js` | preloaded into the instance: loop, CPU, memory, fs, writes, server-side times |
| `lib.js` | stats, samplers (process tree, PC, library disk), tables |
| `report.js` | the markdown tables; `--vs` |
| `capacity.js` | people at once: mixes, the 9 pm burst, the "supported" rule |
| `capacity-report.js` | knees per run, streams per upload speed |
| `swarm.js` | a torrent swarm on 127.0.0.1 for torrent viewers |

Tests of the harness's own arithmetic: `node --test test/loadtest-harness.test.js` (part of `npm test`, milliseconds).
