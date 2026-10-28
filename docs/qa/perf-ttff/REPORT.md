# Start-up time and mid-play loading (1.13.1–1.13.7), 2026-10-28

Measured on private instances only (nufurora.com never contacted), modelled on nufurora: 8 real cores, no GPU (hwEncode off), sign-in closed; old and new builds interleaved case by case. Tools: tools/ttff/vps.js (TTFF timeline per path), tools/ttff/party.js (4-person party), tools/ttff/seam.js (fast-segment handover), tools/stall-rig/run.js (30–130 min real-Chrome sessions with per-minute samples), tools/loadtest/capacity.js --machine 8core --hw off. Base 4190d34 (1.13.0). Torrents left out on purpose.

## Causes, most harm first

| # | Cause | Evidence | Fixed |
|---|---|---|---|
| 1 | A showing `<track>` still loading holds the element at HAVE_CURRENT_DATA; an embedded subtitle was a whole-file ffmpeg read → picture still until it finished | 14.8–17.3 s Knives Out, 28.7 s Silo; 2.5 h rig with 4 starts on 4 cores: 1.13.0 first frame at 2 s, moving at ~94 s; 1.13.5 all moving within 3.7 s. **The "90 s start".** | 1.13.1 |
| 2 | All 22–43 embedded tracks fetched at every start/rebuild | Silo E2: 22 at once | 1.13.1 |
| 3 | hls.js counted server encode time as a slow line → 1080/720/480 see-saw | 2 CPUs: 11 switches + 12.2 s freeze → 0 / 0 | 1.13.1 |
| 4 | Linux encodes stuck at nice 10 (can't be raised without root) | nice-10 encode got 11.8 % of a neighbour's CPU | 1.13.1 |
| 5 | A quality drop landed at 0:00 | 1.13.0 on the rig: 40 stalls, 304 s frozen after one drop | 1.13.1 web, 1.13.3 TV |
| 6 | Seek on a CPU encode started a second encoder; hls.js gave up a segment 58 ms after its first byte | 1080p seek 3.02 → 1.75 s, rebuffer 1.9 → 1.0 s | 1.13.2 |
| 7 | Fast first segment was Constrained Baseline vs the ladder's High → decoder restart at handover | party guest: 120–140 ms hitch ~9 s after each jump, 4–12 dropped frames → 0 | 1.13.5 |
| 8 | Healthy direct play dropped to 480p when Chrome fetched just in time (~2.5 s ahead) | same spot of Arrival in both builds; after fix 0 stalls | 1.13.6 |
| 9 | Broken media pipeline left a still picture for minutes (element error read as codec refusal, unbounded recoverMediaError, card waiting, self-pause read as the viewer's) | rig: still > 5 min; forced: 267 non-fatal errors in 30 s, no card | 1.13.7 |
| 10 | Smaller: stills/probes competing with the start (probe 5.1 s; now kept on disk), TV encode 1 thread on 2 vCPU, false decode stall after seek, tail-index MP4 read on the loop, black page while waiting, nginx buffering a stream | | 1.13.1 |

## Before / after, 8 cores, no GPU (TTFF p50 / p95, s)

| Path | 1.13.0 | After |
|--:|--:|--:|
| direct mp4 | 0.39 / 0.44 | 0.37 / 0.40 |
| repackaged copy (hls.js) | 0.34 / 0.79 | 0.34 / 0.38 |
| copy, resume | 0.48 | 0.37 |
| copy, seek | 1.13 | 0.72 |
| 1080p CPU encode | ~0.4 | ~0.4 |
| encode, resume | p95 4.33 | p95 0.52 |
| encode, seek | 3.02, rebuffer 1.9 | 1.75, rebuffer 1.0 |
| subtitles on, direct | 3 rebuffers, 2.9 s mean (13.2 s in another run) | 0 |
| subtitles on, episode | 0.51 / 1.48 | 0.32 / 0.39 |
| iPhone | 0.20 | 0.18 |
| TV direct | 0.12 | 0.07 |
| TV offset, resume | 0.56 / 1.72 | 0.36 / 0.39 |
| TV encode | 0.60 | 0.58 |
| next episode, direct / CPU encode | 0.9 / 1.9 | 1.0 / 1.9 |

Dropped frames 0–0.3 % on every path. Party (4 people, 8 cores): joins ~1 s, everyone moving within 1.82 s after each jump (harness floor). Long sessions (2.5 h): page heap flat (max 38 MB), DOM steady, server memory 157 → 137 MB, dropped frames 0.00–0.03 % per 10 min.

## Simultaneous starts on 8 cores ("supported" = TTFF p95 ≤ 4 s, nothing refused, late segments ≤ 1 %, stalls ≤ 0.5 %, API p99 ≤ 300 ms)

| Path, all at once | Supported | Measured |
|---|---|---|
| direct file | ≥ 40 | 40: p50 0.11 s, p95 0.21 s |
| repackaged copy | 16 always; 24 when the PC is quiet | 16: p95 2.2–2.4 s; 24: 1.6–2.6 s (PC < 55 % busy), 4.6–6.6 s (60–75 % busy) |
| 1080p CPU encode | 2 always; 3 mostly; 4 borderline | new: 3 at once p95 2.3–7.1 s (median ~3.6), 4 at once 3.6–11.2 s (median ~6), almost never refused. 1.13.0: 2 of 3 runs refused one viewer 10–30× (started after 57–69 s). 6 at once: both refuse (4 slots). |

Experiments: without the fast first segment, 3–4 CPU encodes at once p95 5.4–58 s (keep it). Lowering every running encoder once under way gave p95 1.5–2.5 s at 3–4 at once — the current rule keeps an encoder at normal while its viewer is close behind (stops mid-play starvation) but makes simultaneous starts compete ~2× harder.

## Needs nufurora data
nginx `proxy_buffering`/`proxy_read_timeout` for /stream/ (and no `proxy_ignore_headers` undoing `X-Accel-Buffering: no`); storage type (cause 1 scales with one whole-file read); whether the server runs as root; real Slow starts / Report a problem marks.

## Still open
- TV (ExoPlayer) error path: bounded tries at the same spot, then the card with Try again.
- Simultaneous CPU-encode starts on Linux (all encoders at the same priority without root → 3–4 at once 4–7 s): pause encoders already 2+ segments ahead of their viewer while someone waits on a first segment (SIGSTOP/SIGCONT on Linux, lower priority on Windows), resume after the segment or ~10 s.
- Real trigger of cause 9 (seen once, not reproduced in 10 tries; recovery is bounded now).
- `encbudget.presetNow` plain-ultrafast encodes can meet cause 7's header change across encodes — add the 1.13.5 parameters.
- Chrome with an iPhone UA keeps the whole film buffered (Chrome's own HLS; says nothing about a real iPhone).
