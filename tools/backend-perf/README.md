# Backend efficiency tools

The measurements behind `docs/qa/backend-efficiency/REPORT.md`: where the
server process spends CPU, memory, disk writes and wake-ups, on a normal
machine and on a "weak PC" profile. They change nothing in the product, never
contact the live server, and keep every scratch file outside the repository
(`EFF_WORK`, default `<tmp>/aurora-eff-work`, about 60 MB). Results are written
to `docs/qa/backend-efficiency/results/*.json`.

Needs: Node 20+, `ffmpeg`/`ffprobe` on PATH (libx264, aac, ac3, libwebp),
`npm install` done in the repository root.

## The weak-PC profile

`--weak` on any tool: the server process (and every child it starts) is pinned
to **two logical CPUs that are two different cores** (affinity mask 5 = CPUs 0
and 2; on an Intel with Hyper-Threading 0 and 1 are one core) and started with
`--max-old-space-size=512`. Clock speed is not emulated: an old two-core box is
slower per core than this, so every "weak" figure here is a floor.

## Run again

```
node tools/backend-perf/dataset.js                 # once: the library and the household (about 30 s)

node tools/backend-perf/boot.js      [--only weak]  # process start -> listening -> warm, medians of 5 boots
node tools/backend-perf/idle.js      --weak        # 20 minutes of nobody: CPU, wake-ups, fs calls, bytes written
node tools/backend-perf/idle.js      --weak --profile   # the same window as a CPU profile: which functions
node tools/backend-perf/endpoints.js --weak [--profile] # every request a client makes: CPU, loop time, allocations, blocking fs
node tools/backend-perf/requires.js  --weak        # require() calls inside request handlers, and what one costs
node tools/backend-perf/viewers.js   --weak        # 1 and 5 people watching: bytes written per viewer-hour, loop blocked by saves
node tools/backend-perf/viewers.js   --weak --rows today   # the same for a household the size of the live one today
node tools/backend-perf/storage.js   [--ref <commit>] [--viewers 1,5,20] [--idle 6]   # store writes: bytes, fsyncs, save time, loop delay (server round 2026-10-18)
node tools/backend-perf/storage-drill.js --data <a COPY-able data folder>        # watch-journal migration drill: kill -9 rounds, downgrade, upgrade
node tools/backend-perf/scan.js      --weak [--aftermath] [--cold 300]   # one library rescan; a first scan of 300 new files
node tools/backend-perf/memory.js    [--snapshot]  # heap by owner; a heap snapshot of the warm server, summarised
node tools/backend-perf/soak.js      --weak --minutes 150   # memory over hours of ordinary use
node tools/backend-perf/tonemap-cost.js --weak     # what the tone-map timing at boot costs

# before against after, in the same minutes (two instances, taking turns)
node tools/backend-perf/compare.js --weak --before 68e946a [--after <commit>] [--only home,library]
```

Every tool takes `--ref <commit>` (measure that commit's `server.js` + `src/`
instead of the working tree) and `--label <name>` (suffix of the result file).

## What is what

| File | What it does |
| --- | --- |
| `lib.js` | Scratch folder, the weak profile (pinning), medians, tables. |
| `dataset.js` | The household: 1,200 films + 60 shows x 10 episodes (hard links of one tiny file, plus one 60 s MKV with AC-3 for the repackaging path), 8 profiles with up to 1,500 history rows, and every cache at the size the live data folder has (read for sizes and shapes only: every value is synthetic). A SETTLED server: files probed, intros analysed, blur-up placeholders made, daily jobs done. |
| `instance.js` | A private server on its own port with that data, built like the UI tests' (`scripts/ui-test-server.js`): a throwaway folder, outbound network refused, dies with its parent. `--weak`, `--ref`, cold (unprobed) and first-run (no placeholders) variants. |
| `probe.js` | Preloaded into the instance. Counts module loads, blocking fs calls (with the call site), bytes written per file, timers (site, period, fires, time), child processes, outbound attempts, GC; takes CPU and allocation profiles of a window; runs a script inside the process. `EFF_PROBE=light` wraps nothing (for CPU-per-request figures). Also refuses to start aria2c. |
| `inproc/*.js` | Scripts run INSIDE the instance through the probe: `scan-bench` (rescans), `require-count`, `cache-sizes`, `warm-state`; `mem-steps` runs instead of the server (memory by owner). |
| `boot.js`, `idle.js`, `endpoints.js`, `requires.js`, `viewers.js`, `scan.js`, `memory.js`, `soak.js`, `tonemap-cost.js`, `compare.js` | The runs listed above. |

## Reading the numbers

- **CPU ms per request** is the server process's own user + system time over a
  window of identical requests on one connection, less what the idle server
  burns in the same time, divided by the requests. Two figures: the *best*
  window (the least a request was seen to cost — the steadier figure on a
  machine that is busy with other work) and the median.
- **loop ms** is event-loop active time per request: how long every other
  client waited.
- Requests are made as the real clients make them: signed in (`X-Session`, the
  sign-in wall closed), `Accept-Encoding: gzip, deflate, br`, and `X-Blur: 1`
  on every GET.
- **Wall-clock times** (boot seconds, save milliseconds) were taken on a
  machine running other agents' builds and encodes; they are upper bounds.
  CPU seconds, call counts and bytes do not move with the load.
- The probe has a cost of its own in `full` mode (a stack capture per blocking
  fs call and per timer): per-request CPU is always measured in `light` mode.
  An earlier version wrapped `require()` and by doing so added 140 ms to every
  Home request it measured; `probe.js` says how that was found and avoided.
