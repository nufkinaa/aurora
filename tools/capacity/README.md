# Capacity tools

Measurement scripts behind `docs/qa/capacity/REPORT.md`. They change nothing in
the product, never contact the live server, and keep every scratch file
outside the repository (`CAP_WORK`, default `<tmp>/aurora-cap-work`; about
1 GB). Results are written to `docs/qa/capacity/results/*.json`.

Needs: Node 20+, `ffmpeg`/`ffprobe` on PATH (with libx264, libx265, zscale),
`npm install` done in the repository root.

## Run again

```
node tools/capacity/make-media.js                 # once: the test files (about 5 minutes)

# ffmpeg: speed and CPU cost of every job the server starts
node tools/capacity/ffmpeg-bench.js --emulate host   --repeat 3
node tools/capacity/ffmpeg-bench.js --emulate 10400  --repeat 3 --sweep 1,2,3,4,6    # 6C/12T of this machine
node tools/capacity/ffmpeg-bench.js --emulate 10210u --repeat 2 --sweep 1,2,3,4      # 4C/8T of this machine

# the Node process, against a private instance (each test starts and removes its own)
node tools/capacity/load.js endpoints      # every API call alone: requests/s, latency, CPU per request
node tools/capacity/load.js mix            # 1/5/20/50/100 devices doing the household mix
node tools/capacity/load.js direct         # direct play: CPU per Mbit, slow readers
node tools/capacity/load.js ws             # idle devices: memory per socket, the refetch storm
node tools/capacity/load.js overload       # more encodes than allowed: who is refused, how
node tools/capacity/load.js stampede       # many devices, one thing not made yet
node tools/capacity/load.js boot           # cold start by library size

node tools/capacity/store-bench.js         # what a JSON store save costs as history grows
node tools/capacity/soak.js --minutes 30   # the mix for a long time: memory, handles, lag
node tools/capacity/chaos.js all           # corrupt store, kills, big WebSocket message, guessing, floods
node tools/capacity/profile-endpoint.js    # V8 CPU profile of one request (default: Home)
node tools/capacity/instance.js            # the private instance by hand (CTRL-C removes it)
```

## What is what

| File | What it does |
| --- | --- |
| `lib.js` | Scratch folders, ffmpeg with `-benchmark` (CPU seconds and peak memory from the OS's own accounting of that process), CPU pinning. |
| `make-media.js` | H.264 1080p 8 Mbit (MKV with AC-3 5.1 + subtitles, and MP4), HEVC 10-bit 1080p, HEVC 10-bit 4K 25 Mbit, HEVC HDR10 4K 40 Mbit with DTS, two pictures. |
| `ffmpeg-bench.js` | Builds each command line with the server's own modules (`jit.js`, `ladder.js`, `remux.js`, `tonemap.js`, `offline.js`, `imgvariant.js`) and times it, alone and N at once. |
| `instance.js` | A private server: this worktree's code, a throwaway data folder, a library of the test files plus N small titles, a seeded catalogue, profiles with sessions, the sign-in wall closed. Built on `scripts/ui-test-server.js` (outbound network refused, dies with its parent). |
| `sim.js` | Simulated devices (idle, browsing, direct play, remux, transcode) at the clients' real intervals; a sampler for the server process; the event-loop lag probe. |
| `load.js`, `soak.js`, `chaos.js`, `store-bench.js`, `profile-endpoint.js` | The runs listed above. |

## Reading the numbers

- **cpu-s/film-s** — CPU seconds the job burns per second of film. On a
  machine with other work running this is the figure to trust; `speed` (film
  seconds per wall second) is only what was left over at that moment.
- **lag** — the wait of a request that needs no work (`GET /healthz`), asked
  five times a second on its own connection: what the event loop made
  everyone else wait.
- `--emulate` pins the bench to the first 12 (or 8) logical CPUs and uses the
  thread counts the server would compute on such a machine. Clock speed is not
  emulated; REPORT.md §2 has the factors.
