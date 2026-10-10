# Time to first frame — the harness

How long from the press on Play to the first picture, measured: the website,
on a private instance of **this working tree**, through a shaped line, in the
Chrome already on this machine. Nothing of the owner's is touched — not the
live server, not its library, not its data.

The findings, the tables and every change that came out of them are in
[`docs/qa/ttff/REPORT.md`](../../docs/qa/ttff/REPORT.md). This page is how to
run it again.

```
node tools/ttff/media.js                      # once: the test library (≈ 5 GB, 8 minutes)
node tools/ttff/run.js --label mine           # the four corners × 7 titles × cold/warm/resume × 5 runs
node tools/ttff/report.js mine                # the table
node tools/ttff/report.js baseline mine       # before → after
node tools/ttff/report.js mine --waterfall HL-LB:mkv-ac3:cold
```

Needs: Node 20+, `npm install`, Chrome or Edge, `ffmpeg` + `ffprobe` on `PATH`
with libx264, libx265, aac, ac3 and eac3.

## What is measured

One row per play. Times are milliseconds from **the click** (the page's own
trusted `click` event) on the title page's main button — or from the address
change, for an episode that started by itself.

| Field | What it is |
|---|---|
| `ttff` | the first frame **presented** (`requestVideoFrameCallback`) — at a resume, the first frame at the resume point |
| `ttplay` | the first of six frames in a row, each later in the film, inside 600 ms: the picture is moving |
| `mount`, `loadedmetadata`, `canplay`, `playing` | the player on screen; the `<video>` element's own events |
| `firstMediaByte` | the first byte of a segment or of the file |
| `roundTrips`, `chain` | the requests that had to finish, one after the other, before the first media request could be sent |
| `serverMs` | what the server itself took over those (their `Server-Timing: app`) |
| `mediaBytesBeforeFF` | playlist + segment + file bytes that had arrived by the first frame |
| `rebufferMs`, `rebuffers` | after playback began, for as long as it was watched: time the clock stood still while not paused |
| `startHitchMs` | the longest gap between two of the first 60 frames |
| `path`, `firstLevel`, `levels`, `marks` | which way it played (`direct` / `jit` / `ladder`), the rendition of the first segment, every rendition used, the player's own marks |
| `hls` | what hls.js said: errors, level changes, loads it gave up, rebuilds |
| `waterfall` | every request up to the first frame: start, first byte, end, bytes, connection, `Server-Timing`, who asked |
| `cpuBusy` | how busy this machine was meanwhile (a row measured at 100% says so) |

Network numbers come from the browser's own network layer (CDP `Network.*`),
frame and event times from a probe injected into the page; both are on the
wall clock, so they line up.

## Cold, warm, resume, next

- **cold** — the server has never been asked for this file since it started
  (no segment table, no probe, no segments) and the page was just reloaded
  (the player and hls.js not in memory; in the browser's HTTP cache, as for a
  returning visitor — `--first-visit` for one who has never been here).
- **warm** — the same title again, a moment later.
- **resume** — 40% into the film, on a fresh instance (a server that has just
  played a file from the top has every segment of it on disk: that would not
  be a cold resume).
- **next** — in the player of episode 1, the Next episode button.
- **autonext** — the episode runs out; Up next counts down and starts the next.

One instance and one browser profile per (line × run × pass). Titles are
played one after the other in it, as a household does.

## The lines

`tools/throttle-proxy.js` between the browser and the instance (`lib.js`
`CONDITIONS`). Latency is each way; every line has a real connect (one round
trip) and TCP slow start, restarted after a second of silence.

| Name | Down / up | Round trip | Stands for |
|---|---|---|---|
| `LL-HB` | 100 / 40 Mbit/s | 5 ms | home LAN, good Wi-Fi |
| `HL-HB` | 50 / 20 Mbit/s | 180 ms | a far server on fibre |
| `HL-LB` | 3 / 1 Mbit/s | 200 ms | far and thin |
| `LL-LB` | 3 / 1 Mbit/s | 10 ms | throttled Wi-Fi |
| `ML-MB` | 8 / 3 Mbit/s | 80 ms | an ordinary line to a server elsewhere |
| `HL-1.5` | 1.5 / 0.75 Mbit/s | 200 ms | |
| `LOSS-2` | 20 / 5 Mbit/s, 2% packets lost | 60 ms | ≈ 1.7 Mbit/s per connection |

Production reaches the server over HTTPS and HTTP/2 through Caddy; the
instance speaks plain HTTP/1.1. `--front h2` puts a local TLS + HTTP/2 front
(`h2-front.js`, a self-signed certificate) between line and instance.

## The test library (`media.js`)

Synthetic pictures under film grain, in the shapes the owner's library has
(read off its metadata: 1080p at 2–3 Mbit/s, keyframes up to 10 s apart, MP4s
with the index at the front or at the end, MKVs with HEVC / H.264 and E-AC-3 /
AC-3 / AAC). `node tools/ttff/media.js --list` prints what is there. In
`tools/ttff/.media/` — git-ignored, never copied, handed to the instance as its
library.

| Key | What | Plays as |
|---|---|---|
| `mp4-fast` | MP4 H.264 + AAC, 2.5 Mbit/s, 60 min, a 2.5 MB index at the front | the file |
| `mp4-tail` | the same, index at the end | the file |
| `mkv-aac` | the same streams in MKV | the file (Chrome) |
| `mkv-ac3` | MKV H.264 + AC-3 5.1, 60 min, keyframes 10 s apart | repackaged (video copied, sound to AAC) |
| `mkv-ac3-8m-g2 / g5 / g10` | MKV H.264 + AC-3, 8 Mbit/s, 3 min, keyframes 2 / 5 / 10 s apart | repackaged |
| `mkv-hevc10` | MKV HEVC Main10 + E-AC-3, 20 min | repackaged, or encoded for a browser without HEVC (`--no-hevc`) |
| `ep1`–`ep3` | a show: MKV H.264 + E-AC-3, 2½ min each | repackaged |
| `ep1-mp4`, `ep2-mp4` | a show: MP4, direct play | the file |

## Options

```
--label <name>       results go to tools/ttff/.runs/<name>.jsonl (appended to)
--conditions a,b     lines (default: the four corners)
--titles a,b         media keys
--modes a,b          cold,warm,resume,next,autonext
--runs N             default 5
--watch S            seconds watched after the first frame on a thin line (default 30; 8 at most on a fast one)
--hover MS           the pointer rests on Play this long before the click (0: none)
--line forget|known|<kbps>   what the device remembers of its line before each play
--tree <name>        the app from a snapshot instead of the working tree (below)
--front h2           TLS + HTTP/2 in front of the instance
--no-hevc            a browser that cannot decode HEVC
--first-visit        nothing in the browser's HTTP cache
--set k=v            a localStorage key, set before the app starts (repeatable):
                       aurora-hls-progressive=0|1   segments played as they arrive
                       aurora-data-mode=saver       the app's own Data saver
                       ttff-hls={"…":…}             merged over the player's hls.js configuration
--headed  --verbose
```

## Before and after

```
node tools/ttff/snapshot.js base d4d26cf      # a frozen copy of the app at a commit
node tools/ttff/run.js --tree base --label baseline
node tools/ttff/run.js --label after
node tools/ttff/report.js baseline after --md
```

The harness is always the working tree's; only the app comes from the
snapshot, so both sides are measured by the same code and a long run is not
disturbed by edits made meanwhile.

## What to watch for

- **One run at a time.** Headless Chrome decodes 1080p in software: four
  harnesses side by side saturate sixteen cores, and the server's part of a
  start (ffmpeg making the first segment) reads two to three times longer than
  it is. `cpuBusy` is on every row; the fast lines want a quiet machine.
- **No `--mute-audio`.** With it Chrome's media clock starts about a second
  after the first frame, and hls.js answers the frozen clock with a seek (a
  frame, then 0.8 s of nothing). The probe mutes the element instead.
- **No request routing.** Playwright's `route()` switches the browser's HTTP
  cache off. The outside world is fenced by Chrome's own resolver rules.
- The page's line estimate (`net.js`) reads a 3 Mbit/s line as fast (it times
  answers that arrive in one burst); the player's own memory of the line
  (`aurora-line-kbps`) is what `--line` sets.
