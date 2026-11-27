# The stream rig — playback under shaped, real-TCP lines

Real Chrome plays real (library-shaped) films on a **private** instance of this
working tree, through a line shaped **inside WSL2 with Linux netem**, so the
TCP that carries the film is a real Linux TCP stack whose congestion control
(CUBIC as on nufurora.com today, or BBR) is the one being measured. Every play
becomes one JSON row: time to first frame, stalls, picture height over time,
bytes that crossed the line, rendition changes, whether it was still playing
at the end. Findings: [`docs/qa/streaming-efficiency/REPORT.md`](../../docs/qa/streaming-efficiency/REPORT.md).

```
sh tools/stream-net-rig/batch.sh base                       # today's code, the whole matrix (~90 min)
node tools/stream-net-rig/run.js --label x --profiles 3M,drop --titles direct,jit --watch 150
node tools/stream-net-rig/run.js --label x --cc bbr --profiles 20M-L1 --titles jit
node tools/stream-net-rig/run.js --label x --set aurora-ladder-first=1 --config ladderLow=true ...
node tools/stream-net-rig/run.js --label x --hls '{"maxBufferLength":120}' ...
node tools/stream-net-rig/report.js base                    # one table
node tools/stream-net-rig/report.js base x                  # before -> after, cell by cell
node tools/stream-net-rig/clipstats.js <film> --limit 1800  # a file's bitrate peaks and keyframe spacing
node tools/stream-net-rig/encbench.js --src <film>          # VMAF + speed of the ladder's encodes
wsl.exe -d Ubuntu -u root -e /home/elia/node22/bin/node tools/stream-net-rig/tcp-bench.js   # CUBIC vs BBR, raw TCP
python tools/stream-net-rig/charts.py                       # the report's PNGs
```

Needs: Node 22, `npm ci`, Chrome, ffmpeg/ffprobe on PATH, WSL2 with an Ubuntu
distro that has `tc`, `ip`, `ethtool` and a Linux node (`/home/elia/node22/bin/node`),
and `wsl.exe -u root` (no password: WSL's own root). Git Bash: `export MSYS_NO_PATHCONV=1`.

## The path of one play

```
Chrome (Windows) ─► 127.0.0.1:<port>  (WSL's localhost forwarding)
  ─► relay A   root namespace, 0.0.0.0:<port>
  ─► [ra<slot> ⇄ sa<slot>]  THE SHAPED LINK: netem delay RTT/2 each way, rate, loss (server → viewer)
  ─► relay B   namespace auranet<slot>: its TCP sends the film → its congestion control is measured
  ─► [rb<slot> ⇄ sb<slot>]  a plain link
  ─► relay C   root namespace ─► the Windows host ─► the private Aurora instance
```

`netctl.js` builds it (one namespace per listening port, so one run's teardown
never touches the next), takes `shape` / `cc` / `ssai` commands on stdin for
mid-play changes, and takes everything down when its stdin closes.
`wsl-net.sh` is the shell side (namespace, veths, netem, sysctls) — nothing
outside the namespace and its veths is changed. `--net proxy` uses
`tools/throttle-proxy.js` instead (a model: loss there is a per-connection
Mathis cap, not real TCP).

## What a row says

| Field | Meaning |
|---|---|
| `ttff` | ms from the click on Play to the first presented frame (requestVideoFrameCallback) |
| `stalls`, `stallMs`, `longestStallMs` | after the first frame: the clock not moving for ≥ 500 ms while not paused (250 ms samples) |
| `avgHeight`, `shareTop`, `share720`, `shareLow` | picture height while playing, time-weighted; share at the film's own height (≥ 790 here), ~720, below 700 |
| `switches` | changes of picture height while playing |
| `mediaBytes`, `mediaMbit` | segment + file + playlist bytes off the wire after the click, and that over the watch time |
| `levelsUsed`, `segLevelChanges` | the renditions whose segments were fetched (`?v=`), and how often that changed |
| `pathMarks`, `marks` | the player's own marks (direct / ladder / jit, step-downs, decisions) |
| `endPlaying` | the clock moved ≥ 8 s in the last 15 s of the watch |
| `timeline` | every 5 s: [s, height, seconds buffered ahead, frozen?] |

## The lines (`PROFILES` in run.js)

All 70 ms round trip (Israel ⇄ Germany is 72 ms, measured to nufurora.com).
`1.5M`, `3M`, `5M`, `8M`, `25M`: that many Mbit/s down. `3M-L1`, `8M-L1`,
`20M-L1`, `8M-L2`: with 1 % / 2 % of the server's packets lost. `drop`: 10 Mbit/s,
2 Mbit/s from 45 s, 10 again from 105 s (`drop-L1` with 1 % loss).

## The films (`TITLES` in run.js)

12-minute stream copies (from minute 20) of four of the household's films, in
`E:/aurora-agents/research-stream-efficiency/media` (`--media` to change): `direct`
(MP4 H.264 + AAC 5.1, plays as the file in Chrome), `jit` (MKV H.264 + AC-3 →
repackaged, H.264 ladder), `hevc` (MKV HEVC 10-bit + E-AC-3 → repackaged, HEVC
top + H.264 rungs), `uhd` (4K HEVC + AAC, plays as the file). The instance is held
to the 8 real cores of this i7-10700K (affinity 0x5555) with `hwEncode: "off"`,
like the 8-core VPS without a graphics card.

## Limits

- Chrome only (desktop and its phone emulation). `--flavour iphone` drives the
  player's native-HLS path through **Chrome's** HLS player, not Safari's.
- One play per cell unless `--runs`: the machine is shared; repeat a cell
  before believing a small difference.
- WSL's own virtual NIC and the relays add < 1 ms; the netem link is the line.
