# Time to first frame

*2026-10-10/11 — branch `perf-ttff` (from master `d4d26cf`, server 1.6.85 / TV 5.1.31). Not pushed, no version bump.*

The question: how long from the press on Play to the first picture — on the
website, in the TV app, on a home network and on a thin far line — and how
much of it can go.

The short answer, for the website (median time from the press to the first
frame; "before" is master, "after" is this branch, a device that has played
here before, the title page open for a moment before the press):

| | LL-HB | HL-HB | HL-LB | LL-LB |
|---|--:|--:|--:|--:|
| an MP4, played as the file (`mp4-tail`) | 0.46 s → **0.24 s** | 1.84 s → **1.17 s** | 7.81 s → **7.54 s** | 7.09 s → **7.08 s** |
| an MKV, played as the file (`mkv-aac`) | 0.15 s → **0.11 s** | 0.99 s → **0.77 s** | 2.06 s → **1.81 s** | 1.68 s → **1.65 s** |
| a repackaged film (`mkv-ac3`) | 2.10 s → **0.30 s** | 3.75 s → **0.80 s** | 14.6 s → **1.52 s** | 13.4 s → **1.46 s** |
| a repackaged 8 Mbit/s film (`mkv-ac3-8m-g5`) | 2.33 s → **0.27 s** | 4.30 s → **0.90 s** | > 120 s → **0.71 s** | > 120 s → **1.49 s** |
| a repackaged HEVC film (`mkv-hevc10`) | 1.31 s → **0.27 s** | 3.03 s → **0.64 s** | 76.0 s → **0.74 s** | 74.0 s → **1.32 s** |
| an episode (`ep1`) | 1.75 s → **0.26 s** | 3.95 s → **0.98 s** | 54.1 s → **0.99 s** | 78.0 s → **0.50 s** |
| the next episode (`ep1`, Next) | 2.33 s → **0.74 s** | 3.85 s → **1.14 s** | 75.3 s → **1.51 s** | 68.6 s → **1.19 s** |
| a resume, repackaged (`mkv-ac3`) | 1.83 s → **0.79 s** | 3.41 s → **1.68 s** | 79.4 s → **4.22 s** | 52.8 s → **4.00 s** |

(LL-HB = home LAN · HL-HB = far server, fast line · HL-LB = far and 3 Mbit/s · LL-LB = near and 3 Mbit/s. §1 says what each is; §3 and §5 have every mode.)

Three things did most of it:

1. **A start that loops.** On a thin line, with the server's two encoders
   busy or just left behind by the previous title, the player restarted the
   same stream every ten seconds — and aborted its own first download five
   seconds into each try. That is where the 50–120 s starts came from. Both
   are bugs, both fixed (§5.1, §5.2).
2. **The first segment, whole.** hls.js waited for all 3–10 MB of a first
   segment before showing anything. It now plays a segment as it arrives: the
   first frame after ~170 kB (§5.5).
3. **Six requests in a row.** Progress, a playlist the player asked for just
   to see it was there, hls.js, the same playlist again, the rendition's
   playlist, the segment — each waiting for the one before. They now go out
   together, and the server starts making the segment while they travel
   (§5.3, §5.4).

Everything in this report can be measured again: `tools/ttff/README.md`.

---

## 1. Method

**The harness** (`tools/ttff/`). The website, in the Chrome on this machine
(headless, Playwright), on a private instance of the working tree
(`scripts/ui-test-server.js` — a throwaway data folder, no way out to the
internet, a library of generated files), through `tools/throttle-proxy.js`.
Per play it records the click, every request (start / first byte / end /
bytes / connection / `Server-Timing`), every `<video>` event, every presented
frame (`requestVideoFrameCallback`), what hls.js said, and whether the
picture stalled in the seconds after it started. **TTFF = the first frame
presented, counted from the page's own `click` event.**

**The lines.** The proxy shapes bandwidth and latency per direction, makes a
new connection cost a round trip, and — added for this work, because on a far
server it is the thing the first megabyte actually waits on — TCP slow start
(ten packets, doubling per round trip, starting over after a second of
silence).

| Name | Down / up | Round trip | Stands for |
|---|---|---|---|
| LL-HB | 100 / 40 Mbit/s | 5 ms | home LAN, good Wi-Fi |
| HL-HB | 50 / 20 Mbit/s | 180 ms | a far server on fibre |
| HL-LB | 3 / 1 Mbit/s | 200 ms | far and thin |
| LL-LB | 3 / 1 Mbit/s | 10 ms | throttled Wi-Fi |
| ML-MB | 8 / 3 Mbit/s | 80 ms | an ordinary line to a server elsewhere |
| HL-1.5 | 1.5 / 0.75 Mbit/s | 200 ms | |
| LOSS-2 | 20 / 5 Mbit/s, 2% loss | 60 ms | ≈ 1.7 Mbit/s per connection (Mathis) |

**The test library** (`tools/ttff/media.js`): synthetic pictures under film
grain, in the shapes the owner's library has. Its metadata was read (never
its content): 29 films at **1.7–3.0 Mbit/s** (one at 6.4), keyframes up to
**10 s** apart, 16 of 32 MP4s with their index **at the end of the file**,
MKVs with HEVC (8- and 10-bit) or H.264 and E-AC-3 / AC-3 / AAC.

| Key | File | Plays in Chrome as |
|---|---|---|
| `mp4-fast` | MP4 H.264 + AAC, 2.5 Mbit/s, 60 min, a 2.5 MB index at the front | the file |
| `mp4-tail` | the same film, index at the end | the file |
| `mkv-aac` | the same streams in MKV | the file |
| `mkv-ac3` | MKV H.264 + AC-3 5.1, 3 Mbit/s, 60 min, keyframes 10 s apart, a subtitle | repackaged ("jit": video copied, sound to AAC), through hls.js, with the quality ladder |
| `mkv-ac3-8m-g5` | MKV H.264 + AC-3, 8.5 Mbit/s, 3 min, keyframes 5 s apart | repackaged |
| `mkv-hevc10` | MKV HEVC Main10 + E-AC-3, 3 Mbit/s, 20 min | repackaged (this Chrome decodes HEVC; the ladder is HEVC on top, H.264 under it) |
| `ep1`–`ep3` | a show: MKV H.264 + E-AC-3, 2½ min each | repackaged |

**Cold, warm, resume, next.** *Cold*: the server has never been asked for the
file (no segment table, no probe, no segments) and the page was just reloaded
(player and hls.js not in memory; in the browser's HTTP cache, as for anyone
who has been here before). *Warm*: the same title again. *Resume*: 40% in, on
a fresh instance. *Next*: the Next episode button, in episode 1's player.
Titles are played one after the other in one instance, as a household does —
which matters: see §5.2.

**What the numbers are not.**

- *The machine was busy.* Other work ran on it throughout (and the harness's
  own headless Chrome decodes 1080p in software). Every row records how busy
  (`cpuBusy`); most were measured at 85–100%. The server's part of a cold
  start — ffmpeg making the first segment — read **0.3 s on the quiet runs
  and 0.7–1.3 s on the busy ones**, before and after alike. Line-bound
  numbers (the thin lines) are solid; the fast-line figures carry that noise,
  and quiet-machine waterfalls are quoted where it matters.
- *Plain HTTP/1.1.* Production is HTTPS and HTTP/2 through Caddy. Checked
  with a local TLS + HTTP/2 front (`tools/ttff/h2-front.js`): the picture is
  the same, a little better (§7).
- *Chrome only.* Safari on a Mac uses the same hls.js path; an iPhone plays
  HLS natively and was reasoned about, not measured.
- *The TV app was not run* (another task owns the device): §8 is analysis,
  code, and a measurement plan.
- *Torrent streams were not measured* (no swarm may be touched): §9.

---

## 2. The start, request by request (as it was)

### The file itself ("direct")

```
click
 └ #/play/<id> → the player's code (already warmed at idle) → api.item (cached 60 s by the title page)
    └ GET /api/profiles/<id>/state            the profile's progress — AWAITED            1 round trip
       └ the <video> element: GET /stream/video/<id>  bytes=0-
            MP4, index in front:  reads the index (2.5–9 MB) … then the first frames
            MP4, index at the end: gives the request up after 32 kB
               └ GET bytes=<end>-             the index                                   +1 round trip
                  └ GET bytes=32768-          the film                                    +1 round trip
            MKV: the header and the first cluster — 0.6 MB — and plays
```

An MP4 shows nothing until the browser has its **whole index**. Measured on
the owner's files: 3.6–9.3 MB for a 90–166 minute film. On a home network
that is nothing. At 3 Mbit/s it is 10–25 s of download before the first
frame, and no setting of the player changes it.

### Repackaged ("jit", the quality ladder)

```
click
 └ GET /api/profiles/<id>/state               progress — awaited                          1
    └ GET …/jit/master.m3u8                   asked by the PLAYER, to see it is there     2   server: reads the keyframe index, ffprobe (55 ms; 200 busy)
       └ GET /js/vendor/hls.min.js            149 kB (revalidated: a 304)                 3
          └ GET …/jit/master.m3u8             asked again, by hls.js                      4
             └ GET …/jit/index.m3u8?v=copy    the rendition's playlist (14–28 kB, uncompressed) 5
                └ GET …/jit/seg00000.ts       server: ffmpeg starts, makes one whole GOP  6   0.3 s (1 s busy)
                   … the WHOLE segment (6–10 s of film: 3–10 MB) … then the first frame
```

Six requests, each waiting for the one before: 1.1 s of nothing but round
trips at 180 ms. Then the segment: the player starts on the **top** rung
whatever the line (hls.js knows nothing about the line yet; the page's own
estimate, `net.js`, times small answers that arrive in one burst and read a
3 Mbit/s line as 65), and waits for all of it.

Beside those, not blocking: three `play-mark` POSTs, and — when subtitles are
on by default and the file carries a text track — `GET /stream/embedded/…`,
which runs ffmpeg over the **whole file** to pull the track out (cached per
file afterwards). It competes with the first segment for the disk.

A resume is the same chain; the first segment asked for is the one that
holds the resume point (the segment table is known up front, nothing before
it is made). A next episode is the same chain again, from a player that is
already open.

### The older "offset" jobs

`/stream/transcode/<id>/<ss>/index.m3u8?v=copy|h264[-720|-480]` (`remux.js`):
one ffmpeg per start offset writing a growing EVENT playlist. The request for
the playlist is answered when the first segment exists (2 s for an encode,
one GOP for a copy), so the chain is playlist → segment. The website only
reaches it now as a fallback (no keyframe index, no encoder for a ladder, an
iPhone's manual quality pick); **the TV uses it for every file whose sound it
cannot play** (§8).

### The marks

`player.js` `mark()` posts `mount`, `path`, `ladder`, `decision`,
`first-frame` … to `POST /api/play-mark/:id`; the server prints
`[play] <id> +<ms>ms <name> k=v…` (the admin's Logs tab) and folds them into
`lib/playmarks.js` for the healer's start-time statistics (p50 / p90 by
path). `first-frame` is the element's `playing` event, counted from the
player's mount — so it leaves out everything before the mount (the progress
round trip), and reads 0.2–0.4 s under the harness's click-to-frame on a far
line. The TV's `first-frame` came from a once-a-second progress tick: up to a
second late (§8).

---

## 3. Baseline

Median TTFF from the click; master `d4d26cf` (+ the harness and
`Server-Timing`, which change no behaviour). LL-HB and HL-HB: 5 runs. HL-LB
and LL-LB: 3 runs. "> 120 s" = no frame in the two minutes a play was given;
"(2/3)" = runs that got a picture.

| title | mode | LL-HB | HL-HB | HL-LB | LL-LB |
|---|---|--:|--:|--:|--:|
| mp4-fast | cold | 0.51 s | 1.32 s | 7.48 s | 7.08 s |
| mp4-fast | warm | 0.29 s | 1.26 s | 7.43 s | 7.08 s |
| mp4-fast | resume | 0.84 s | 2.37 s | 7.49 s | 7.08 s |
| mp4-tail | cold | 0.46 s | 1.84 s | 7.81 s | 7.09 s |
| mp4-tail | warm | 0.24 s | 1.31 s | 7.83 s | 7.07 s |
| mp4-tail | resume | 0.73 s | 2.72 s | 7.84 s | 7.08 s |
| mkv-aac | cold | 0.15 s | 0.99 s | 2.06 s | 1.68 s |
| mkv-aac | warm | 0.21 s | 0.98 s | 2.09 s | 1.67 s |
| mkv-aac | resume | 0.87 s | 2.21 s | 7.83 s (2/3) | 7.17 s (2/3) |
| mkv-ac3 | cold | 2.10 s | 3.75 s | 14.6 s | 13.4 s |
| mkv-ac3 | warm | 0.29 s | 1.15 s | 1.25 s | 0.31 s |
| mkv-ac3 | resume | 1.83 s | 3.41 s | 79.4 s | 52.8 s |
| mkv-ac3-8m-g5 | cold | 2.33 s | 4.30 s | > 120 s (0/3) | > 120 s (1/3) |
| mkv-ac3-8m-g5 | warm | 1.16 s | 3.17 s | 54.8 s (2/3) | 110.0 s (2/3) |
| mkv-ac3-8m-g5 | resume | 2.51 s | 4.61 s | 90.1 s (2/3) | > 120 s (1/3) |
| mkv-hevc10 | cold | 1.31 s | 3.03 s | 76.0 s | 74.0 s |
| mkv-hevc10 | warm | 0.31 s | 1.16 s | 1.27 s | 0.27 s |
| mkv-hevc10 | resume | 1.49 s | 2.90 s | 81.6 s | 83.8 s (2/3) |
| ep1 | cold | 1.75 s | 3.95 s | 54.1 s | 78.0 s |
| ep1 | warm | 0.43 s | 2.01 s | 1.42 s | 0.31 s |
| ep1 | resume | 2.62 s | 3.26 s | 55.3 s | 83.2 s |
| ep1 | next | 2.33 s | 3.85 s | 75.3 s | 68.6 s |

Per path, cold, what a start consisted of:

| | requests in a row before the first media byte | server's own time on them | media bytes by the first frame |
|---|---|---|---|
| the file (MP4) | 2 (+2 when the index is at the end) | 2–5 ms | 2.6–3.9 MB (the index, then a little) |
| the file (MKV) | 2 | 2 ms | 0.6–1.2 MB |
| repackaged | 6 (7 for an episode) | 0.7–1.4 s (quiet machine: 0.37 s) | one whole segment: 3.0 MB (`mkv-ac3`), 10.1 MB (`mkv-ac3-8m-g5`), 3.5 MB (`mkv-hevc10`) — and 15–30 MB where the start looped |

At 3 Mbit/s (375 kB/s): a 3.0 MB segment is 8 s of download, a 10.1 MB one
is 27 s, a 2.5 MB MP4 index 6.7 s, a 9.3 MB one 25 s.

No new connection is opened at a start: the page's keep-alive connections
are still there (0 new connections in every fast-line run).

### Waterfalls

`.` waiting for the first byte, `#` the body arriving; times in ms from the
click.

Typical — a repackaged film from a far server (HL-HB, cold):

```
mkv-ac3 · cold · HL-HB (far server on fibre: 50 Mbit/s, 180 ms) — run 3, first frame at 3751 ms
path ladder, starts on copy; 6 requests in a row before the first media byte (2716 ms); server 1367 ms of that; 3.0 MB of media by the first frame

 start 1st byte    end    bytes  |----------------------------------------------------------|  what
    20      235    235    14 kB  ....#                                                         playlist …/jit/index.m3u8 [server 22 ms, index 18 ms]
    21      237    236     0 kB  ....#                                                         api /api/profiles/…/state [server 1 ms]
   251      673    673     1 kB      ......#                                                   playlist …/jit/master.m3u8 [server 202 ms, probe 199 ms]
   674      918    877     0 kB            .....                                               script /js/vendor/hls.min.js
   930     1134   1133     1 kB                ...#                                            playlist …/jit/master.m3u8 [server 2 ms, probe 1 ms]
   935     2417   2416     3 kB                ......................#                         subtitle /stream/embedded/05685f552d2a/0 [server 281 ms]
  1140     1330   1330    14 kB                   ...#                                         playlist …/jit/index.m3u8?v=copy [server 5 ms]
  1340     2716   3581   3.0 MB                      .....................##############       segment …/jit/seg00000.ts?v=copy [server 1157 ms, segment made 1143 ms]
  3713     3900   4329     0 kB                                                          ..##  segment …/jit/seg00001.ts?v=copy [server 4 ms, segment ready 0 ms]
                                    M                                                   F     M player mounted 250 · L metadata 3707 · F first frame 3751
marks: mount@0  path:ladder@426  ladder:h264-480,h264-720,copy@890  first-frame@3518
```

An MP4 with its index at the end, same line:

```
mp4-tail · cold · HL-HB (far server on fibre: 50 Mbit/s, 180 ms) — run 4, first frame at 1839 ms
path direct; 2 requests in a row before the first media byte (410 ms); server 2 ms of that; 3.1 MB of media by the first frame

 start 1st byte    end    bytes  |----------------------------------------------------------|  what
    17      206    205     0 kB   .....#                                                       api /api/profiles/…/state [server 1 ms]
   217      410    496    32 kB         ......###                                              video /stream/video/… (bytes=0-) [server 1 ms]
   496      691   1504   2.5 MB                 ......##########################               video /stream/video/… (bytes=1124171776-) [server 1 ms]
  1549     1753      …   590 kB                                                 .......######  video /stream/video/… (bytes=32768-) [server 1 ms]
                                      M                                               L F     M player mounted 208 · L metadata 1780 · F first frame 1839
marks: mount@0  path:direct@1  first-frame@1647
```

The worst — a 3 Mbit/s line (LL-LB, cold, HEVC film): the first frame at 74 s.
The same segment is asked for fourteen times; none of the downloads is
allowed to finish (only the first twenty requests are shown).

```
mkv-hevc10 · cold · LL-LB (throttled Wi-Fi: 3 Mbit/s, 10 ms) — run 1, first frame at 74005 ms
path ladder, starts on copy; 6 requests in a row before the first media byte (1182 ms); server 1006 ms of that; 27.1 MB of media by the first frame

 start 1st byte    end    bytes  |----------------------------------------------------------|  what
     8       29     29     5 kB  #                                                             playlist …/jit/index.m3u8 [server 5 ms, index 3 ms]
     9       34     34     0 kB  #                                                             api /api/profiles/…/state [server 3 ms]
    39      241    241     1 kB  #                                                             playlist …/jit/master.m3u8 [server 187 ms, probe 183 ms]
   242      300    265     0 kB  #                                                             script /js/vendor/hls.min.js
   306      325    323     1 kB  #                                                             playlist …/jit/master.m3u8 [server 4 ms, probe 1 ms]
   309      838    837     1 kB  .#                                                            subtitle /stream/embedded/c3f19db557eb/0 [server 146 ms]
   327      355    353     5 kB  #                                                             playlist …/jit/index.m3u8?v=copy [server 3 ms]
   357     1182   5312   1.6 MB  .####                                                         segment …/jit/seg00000.ts?v=copy [server 809 ms, segment made 792 ms]
  5311     5344   9530   1.6 MB      ####                                                      segment …/jit/seg00000.ts?v=copy [server 7 ms, segment ready 0 ms]
  9259     9524   9523     1 kB         #                                                      playlist …/jit/master.m3u8 [server 2 ms, probe 1 ms]
  9528     9549   9548     0 kB         #                                                      playlist …/jit/master.m3u8 [server 2 ms, probe 0 ms]
  9550     9628   9627     0 kB         #                                                      playlist …/jit/index.m3u8?v=copy [server 1 ms]
  9629     9656  14535   1.9 MB         #####                                                  segment …/jit/seg00000.ts?v=copy [server 5 ms, segment ready 0 ms]
 14534    14571  19459   1.8 MB             #####                                              segment …/jit/seg00000.ts?v=copy [server 3 ms, segment ready 0 ms]
 19256    19451  19445     1 kB                 #                                              playlist …/jit/master.m3u8 [server 2 ms, probe 1 ms]
 19456    19508  19506     0 kB                 #                                              playlist …/jit/master.m3u8 [server 2 ms, probe 1 ms]
 19508    19524  19523     0 kB                 #                                              playlist …/jit/index.m3u8?v=copy [server 1 ms]
 19525    19607  24461   1.9 MB                 #####                                          segment …/jit/seg00000.ts?v=copy [server 46 ms, segment ready 0 ms]
 24459    24479  29534   1.9 MB                     ####                                       segment …/jit/seg00000.ts?v=copy [server 3 ms, segment ready 0 ms]
 29256    29528  29528     1 kB                        #                                       playlist …/jit/master.m3u8 [server 2 ms, probe 0 ms]
 29532    29562  29561     0 kB                        #                                       playlist …/jit/master.m3u8 +new connection [server 2 ms, probe 0 ms]
 29563    29578  29577     0 kB                        #                                       playlist …/jit/index.m3u8?v=copy [server 1 ms]
                                … (22 more requests, the same six over and over)
                                M                                                       F     M player mounted 36 · L metadata 73960 · F first frame 74005
marks: mount@0  decision:hevc-in-mkv → copy first@1  path:ladder@205  path:ladder@9487  path:ladder@19415  path:ladder@29492  path:ladder@39415  path:ladder@49507  path:ladder@59427  path:ladder@69553  first-frame@73988  path:ladd
```

---

## 4. Where the time goes (ranked)

1. **A start that never finishes on a thin line** (50–120 s). Two bugs
   feeding each other — §5.1 and §5.2. Not "slow": broken.
2. **Bytes that must arrive before the first frame.** A whole first segment
   (3–10 MB: 8–28 s at 3 Mbit/s) on the repackaged path; a whole MP4 index
   (2.5–9 MB: 7–25 s at 3 Mbit/s) on the direct path. Dominant on any line
   under ~10 Mbit/s, and still 0.5–1 s of a far fast line (slow start).
3. **Round trips in a row** before any media: 6 on the repackaged path, 2–4
   on the direct one. 1.1 s at 180 ms; nothing on a LAN.
4. **The server making the first segment**: 0.3 s on an idle machine, 1 s+
   on a busy one — and 9–52 s for an *encoded* rung on a saturated one
   (§5.7). Almost all of it is the audio: the AAC encoder runs at 17–23×
   real time, the video copy at 300× (§6).
5. **The player before the first request**: 30–60 ms. Not a factor.
6. **The decoder**: first frame 20–80 ms after enough data is there. Not a
   factor.

---

## 5. What was changed, and what it bought

The branch was measured in two stages. **"after"** in the tables of this
section is the build at commit `37b12c1` — everything in §5.1–§5.7 — on a
device that has played here before (it remembers what its line carried,
§5.6), Play pressed the moment the title page is idle; medians of 3 runs.
Three later changes have their own tables: the MP4 index served in front
(§5.8), the title page's warm-up (§5.9) and the resume playhead (§5.10). The
table at the top of this report is the branch as it ends.

Cold starts:

| title | mode | LL-HB before | LL-HB after | HL-HB before | HL-HB after | HL-LB before | HL-LB after | LL-LB before | LL-LB after |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| mp4-fast | cold | 0.51 s | 0.34 s | 1.32 s | 1.19 s | 7.48 s | 7.31 s | 7.08 s | 7.04 s |
| mp4-tail | cold | 0.46 s | 0.33 s | 1.84 s | 1.51 s | 7.81 s | 7.54 s | 7.09 s | 7.08 s |
| mkv-aac | cold | 0.15 s | 0.11 s | 0.99 s | 0.77 s | 2.06 s | 1.81 s | 1.68 s | 1.65 s |
| mkv-ac3 | cold | 2.10 s | 0.84 s | 3.75 s | 1.02 s | 14.6 s | 5.10 s | 13.4 s | 5.08 s |
| mkv-ac3-8m-g5 | cold | 2.33 s | 1.68 s | 4.30 s | 1.23 s | > 120 s (0/3) | 3.58 s | > 120 s (1/3) | 5.81 s |
| mkv-hevc10 | cold | 1.31 s | 0.94 s | 3.03 s | 0.92 s | 76.0 s | 2.65 s | 74.0 s | 4.70 s |
| ep1 | cold | 1.75 s | 0.81 s | 3.95 s | 1.31 s | 54.1 s | 1.86 s | 78.0 s | 3.36 s |

All modes:

| title | mode | LL-HB before | LL-HB after | HL-HB before | HL-HB after | HL-LB before | HL-LB after | LL-LB before | LL-LB after |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| mp4-fast | warm | 0.29 s | 0.20 s | 1.26 s | 1.04 s | 7.43 s | 6.74 s | 7.08 s | 6.55 s |
| mp4-fast | resume | 0.84 s | 0.68 s | 2.37 s | 2.04 s | 7.49 s | 7.24 s | 7.08 s | 7.05 s |
| mp4-tail | warm | 0.24 s | 0.21 s | 1.31 s | 1.06 s | 7.83 s | 6.89 s | 7.07 s | 6.58 s |
| mp4-tail | resume | 0.73 s | 0.70 s | 2.72 s | 2.53 s | 7.84 s | 7.52 s | 7.08 s | 7.06 s |
| mkv-aac | warm | 0.21 s | 0.11 s | 0.98 s | 0.78 s | 2.09 s | 1.80 s | 1.67 s | 1.63 s |
| mkv-aac | resume | 0.87 s | 0.56 s | 2.21 s | 1.87 s | 7.83 s (2/3) | 8.43 s | 7.17 s (2/3) | 4.07 s |
| mkv-ac3 | warm | 0.29 s | 0.21 s | 1.15 s | 0.71 s | 1.25 s | 0.98 s | 0.31 s | 0.44 s |
| mkv-ac3 | resume | 1.83 s | 1.55 s | 3.41 s | 2.27 s | 79.4 s | 13.9 s | 52.8 s | 5.54 s |
| mkv-ac3-8m-g5 | warm | 1.16 s | 0.29 s | 3.17 s | 1.15 s | 54.8 s (2/3) | 0.74 s | 110.0 s (2/3) | 0.28 s |
| mkv-ac3-8m-g5 | resume | 2.51 s | 1.62 s | 4.61 s | 3.08 s | 90.1 s (2/3) | 10.1 s | > 120 s (1/3) | 5.20 s |
| mkv-hevc10 | warm | 0.31 s | 0.20 s | 1.16 s | 0.72 s | 1.27 s | 0.78 s | 0.27 s | 0.44 s |
| mkv-hevc10 | resume | 1.49 s | 0.91 s | 2.90 s | 2.09 s | 81.6 s | 6.73 s | 83.8 s (2/3) | 5.97 s |
| ep1 | warm | 0.43 s | 0.17 s | 2.01 s | 1.05 s | 1.42 s | 0.73 s | 0.31 s | 0.16 s |
| ep1 | resume | 2.62 s | 1.72 s | 3.26 s | 1.79 s | 55.3 s | 14.1 s | 83.2 s | 5.88 s |
| ep1 | next | 2.33 s | 0.58 s | 3.85 s | 1.23 s | 75.3 s | 1.75 s | 68.6 s | 3.76 s |

The picture after the start (the same runs): seconds the clock stood still
in the 15–20 s watched after the first frame.

| title | mode | HL-LB before | HL-LB after | LL-LB before | LL-LB after |
|---|---|--:|--:|--:|--:|
| mp4-fast | cold | 0 | 0 | 0 | 0 |
| mp4-tail | cold | 0 | 0 | 0 | 0 |
| mkv-aac | cold | 0 | 0 | 0 | 0 |
| mkv-ac3 | cold | 10.4 s | 0 | 10.4 s | 0.30 s |
| mkv-ac3-8m-g5 | cold | — | 0 | 0 (1/3) | 15.9 s |
| mkv-hevc10 | cold | 0.80 s | 0 | 0 | 5.20 s |
| ep1 | cold | 0 | 0 | 0 | 0 |

### 5.1 The five-second "kick" no longer throws the first download away

`startHls` had a safety net for a rare attach race: five seconds after start,
if nothing is buffered, `stopLoad()` / `startLoad()`. On a thin line the
first segment is still arriving at five seconds, the buffer is rightly empty —
and the kick aborted the download and began it again. Now it only acts on a
loader that is idle (no request out, nothing in the last three seconds).
**HL-LB `mkv-ac3` cold, this fix and §5.3 alone: 14.3 s → 9.7 s** — and the
difference between "9 s" and "never" for anything whose first segment takes
over five seconds twice.

### 5.2 A step-down that cannot happen no longer restarts the stream every ten seconds

On a thin line the old line-watcher asks for a lighter stream. With no
encoder free the ladder's master playlist comes back with one rung — the same
stream — and the player "switched" to it: the same first segment, from byte
0. Ten seconds later the watcher, still starving, asked again. For as long as
the encoders stayed busy.

And they stayed busy because of two things on the server:

- a request the client had hung up on (the kick, a level change, the player
  closing) kept waiting server-side — up to 90 s — and for that long its
  producer counted as "somebody is waiting on this": not re-aimed, not
  parked, its encoder slot held;
- the **previous title's** encoder kept its slot until it had run 20
  segments ahead or been found idle (2.5 min). Playing episode 1 on a thin
  line and pressing Next was enough.

Fixed on both sides: the player treats a master without the rung it asked
for as "no"; the segment route stops waiting when the client hangs up
(`jit.ensureSegment({ gone })`); an encoder nobody has asked anything of in
20 s no longer counts against the next title and is parked when the slot is
wanted; the player says goodbye when it closes (`POST …/jit/bye`, a beacon —
on page hide too) and the title's producers stop at once.

**Next episode on a thin line: HL-LB 75.3 s → 1.75 s, LL-LB 68.6 s → 3.76 s.**

### 5.3 The start's requests go out together

`prestart(item)`: the moment the title is known, the master playlist, the
rendition playlist it names, and hls.js itself are asked for — beside the
progress read, not after it — and handed to hls.js when it asks (a playlist
loader that takes what was asked ahead, once). The progress read itself is
skipped when the title page read it within the last 30 s (it is the answer
the viewer just acted on). Playlists are gzip-compressed (28 kB → 3 kB for a
two-hour film: one round trip instead of two on a fresh connection).

Requests in a row before the first media byte: **6 → 3** (master → rendition
playlist → segment), **1** once a hover or the title page has warmed it
(§5.9). The direct path: **2 → 1** (2–4 → 1 for a tail-index MP4, §5.8).

### 5.4 The server starts the first segment before it is asked for

The first playlist request carries a hint — `X-Aurora-Start: at=<seconds>;
kbps=<what the line carried>` — and the server begins making that segment as
it answers (`jit.warmSegment`). Two round trips later, when hls.js asks, it
is made or well on its way. Bounded so a hint can never cost a viewer
anything: never a second producer for a job, an *encoded* rendition only
while no encoder is running anywhere, eight starts a minute across the
server, and the producer stops by itself three segments on unless a real
request arrives.

Also warmed when a title's record is asked for (the title page opened): the
keyframe table and the one ffprobe the master playlist needs (60–190 ms of a
cold start's first request).

**Server's own time on the chain of requests before the first media byte,
cold: HL-HB `mkv-ac3` 1367 ms → 10 ms; LL-HB `mkv-ac3` 1304 ms → 8 ms.**

### 5.5 Segments are played as they arrive

hls.js "progressive" (its fetch loader + streaming demux), on by default;
`localStorage["aurora-hls-progressive"] = "0"` turns it off. The first frame
needs the first ~170 kB of a segment, not all 3–10 MB of it. The same build
with it switched off and on (cold):

| title | mode | LL-HB off | LL-HB on | HL-HB off | HL-HB on | HL-LB off | HL-LB on | LL-LB off | LL-LB on |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| mkv-ac3 | cold | 0.91 s | 0.84 s | 1.83 s | 1.02 s | 9.35 s | 5.10 s | 5.88 s | 5.08 s |
| mkv-ac3-8m-g5 | cold | 1.61 s | 1.68 s | 3.00 s | 1.23 s | 5.89 s | 3.58 s | 5.44 s | 5.81 s |
| mkv-hevc10 | cold | 0.77 s | 0.94 s | 1.78 s | 0.92 s | 5.80 s | 2.65 s | 9.49 s | 4.70 s |
| ep1 | cold | 0.78 s | 0.81 s | 2.22 s | 1.31 s | 5.69 s | 1.86 s | 5.47 s | 3.36 s |

hls.js still labels the mode experimental. What was done about that: the
repackaged-stream and episode browser suites (seeking, embedded subtitles,
audio switch, resume, stall recovery, Next episode, Up next — 24 tests) pass
with it; the harness watched 15–30 s after every start for stalls and for
hls.js errors; and it is one `localStorage` key to turn off.

### 5.6 A thin line starts on a rung it can carry

Two mechanisms, because the page's own line estimate cannot be used (§2):

- **What the line carried last time** (`aurora-line-kbps`, on the device):
  hls.js's own estimate, saved while a film plays — and, for a file played
  directly, the rate its index arrived at. The next start begins on the
  highest rung that fits in 80% of it, and hls.js's estimator starts from it
  instead of from its stock 0.5 Mbit/s.
- **The start watch**, for a device that knows nothing yet: the first
  segment is watched as it arrives. 1.5 s after its first byte (sooner would
  read TCP slow start as a slow line) the recent rate says how long the rest
  will take; when that is long and a lighter rung the line can carry would be
  here in well under the time, the load is given up for it — once, by the
  same means hls.js uses mid-film (its emergency switch), which at a start
  stands down.

A first-ever play on a device (nothing remembered), cold:

| title | mode | HL-LB before | HL-LB first play | HL-LB known line | LL-LB before | LL-LB first play | LL-LB known line |
|---|---|--:|--:|--:|--:|--:|--:|
| mp4-fast | cold | 7.48 s | 7.26 s | 7.31 s | 7.08 s | 7.02 s | 7.04 s |
| mp4-tail | cold | 7.81 s | 7.55 s | 7.54 s | 7.09 s | 7.06 s | 7.08 s |
| mkv-aac | cold | 2.06 s | 1.82 s | 1.81 s | 1.68 s | 1.62 s | 1.65 s |
| mkv-ac3 | cold | 14.6 s | 1.51 s | 5.10 s | 13.4 s | 0.99 s | 5.08 s |
| mkv-ac3-8m-g5 | cold | > 120 s (0/3) | 3.18 s | 3.58 s | > 120 s (1/3) | 3.20 s | 5.81 s |
| mkv-hevc10 | cold | 76.0 s | 1.16 s | 2.65 s | 74.0 s | 0.99 s | 4.70 s |
| ep1 | cold | 54.1 s | 1.35 s | 1.86 s | 78.0 s | 1.04 s | 3.36 s |

A first play is on the film's own video (nothing says not to), and with
segments played as they arrive its first frame is early on any line. What a
thin line then pays is a stall while the rest of that segment arrives and the
player comes down a rung — time stalled in the seconds watched after the
first frame:

| title | mode | HL-LB before | HL-LB first play | LL-LB before | LL-LB first play |
|---|---|--:|--:|--:|--:|
| mkv-ac3 | cold | 10.4 s | 4.36 s | 10.4 s | 2.50 s |
| mkv-ac3-8m-g5 | cold | — | 0 | 0 (1/3) | 0.30 s |
| mkv-hevc10 | cold | 0.80 s | 5.60 s | 0 | 4.75 s |
| ep1 | cold | 0 | 3.74 s | 0 | 3.20 s |

That happens once per device: the play itself teaches it the line.
`mkv-ac3-8m-g5` shows the start watch at work (it is the only one heavy enough
to trip it): given up for 480p at ~2.4 s, no stall.

And the other way — a device that remembers a thin line and is now on a fast
one (HL-HB, told "3000 kbit/s"): `mkv-ac3`: first frame 1.91 s, on 480p; the file's own video asked for 2.20 s after the click, ends on 1080p; `mkv-ac3-8m-g5`: first frame 1.85 s, on 480p; the file's own video asked for 4.95 s after the click, ends on 1080p; `ep1`: first frame 1.99 s, on 480p; the file's own video asked for 2.36 s after the click, ends on 1080p.

### 5.7 An encoder a viewer is waiting on is not starved

Ladder encoders ran at below-normal priority from their first instruction. On
a machine with every core busy that is a process that may not run: **9–52 s**
for ten seconds of 480p that take one second when the encoder gets its turn
(measured here, on the first build of §5.6 — which made it matter, by
starting thin lines on an encoded rung). Now an encoder runs at normal
priority until the segment it was started for is out, then yields; a warm-up
yields from the start. And the player does not wait on one for ever: an
encoded rung whose first segment the server has not begun to send after 3 s
is given up for the file's own video — a copy, made at the speed of the disk.

Not on a line **known** to be too thin for that video, though. The slow-line
"after" rows of this section were measured with every core of the machine
taken by other work (97–100% busy), the 480p encoder often past its three
seconds, and the player then went up to video the line cannot carry: a frame
at 6.6 s and then 16 s of nothing, in the worst run (an 8 Mbit/s film on
3 Mbit/s). On such a line the encoder is now waited for twelve seconds
(commit `ecebcf1`); the copy stays the way out of an encode that never
comes. Slow lines with that rule, the title page open for a moment before
the press:

| title | mode | HL-LB before | HL-LB 3 s rule (37b12c1…d0b74e7) | HL-LB 12 s rule | LL-LB before | LL-LB 3 s rule (37b12c1…d0b74e7) | LL-LB 12 s rule |
|---|---|--:|--:|--:|--:|--:|--:|
| mkv-ac3 | cold | 14.6 s | 1.69 s | 1.52 s | 13.4 s | 2.49 s | 1.46 s |
| mkv-ac3 | warm | 1.25 s |  |  | 0.31 s |  |  |
| mkv-ac3 | resume | 79.4 s | 5.28 s | 4.22 s | 52.8 s | 6.97 s | 4.00 s |
| mkv-ac3-8m-g5 | cold | > 120 s (0/3) | 0.73 s | 0.71 s | > 120 s (1/3) | 1.38 s | 1.49 s |
| mkv-ac3-8m-g5 | warm | 54.8 s (2/3) |  |  | 110.0 s (2/3) |  |  |
| mkv-ac3-8m-g5 | resume | 90.1 s (2/3) | 5.00 s | 3.91 s | > 120 s (1/3) | 4.34 s | 4.22 s |
| mkv-hevc10 | cold | 76.0 s | 0.73 s | 0.74 s | 74.0 s | 2.62 s | 1.32 s |
| mkv-hevc10 | warm | 1.27 s |  |  | 0.27 s |  |  |
| mkv-hevc10 | resume | 81.6 s | 3.42 s | 3.17 s | 83.8 s (2/3) | 3.36 s | 3.26 s |
| ep1 | cold | 54.1 s | 0.94 s | 0.99 s | 78.0 s | 0.64 s | 0.50 s |
| ep1 | warm | 1.42 s |  |  | 0.31 s |  |  |
| ep1 | resume | 55.3 s | 3.41 s | 3.35 s | 83.2 s | 2.97 s | 2.99 s |
| ep1 | next | 75.3 s | 3.73 s | 1.51 s | 68.6 s | 2.02 s | 1.19 s |

Time stalled after the first frame, same runs:

| title | mode | HL-LB before | HL-LB 3 s rule | HL-LB 12 s rule | LL-LB before | LL-LB 3 s rule | LL-LB 12 s rule |
|---|---|--:|--:|--:|--:|--:|--:|
| mkv-ac3 | cold | 10.4 s | 0 | 0 | 10.4 s | 4.39 s | 0 |
| mkv-ac3-8m-g5 | cold | — | 0 | 0 | 0 (1/3) | 3.35 s | 0 |
| mkv-hevc10 | cold | 0.80 s | 0 | 0 | 0 | 3.05 s | 0 |
| ep1 | cold | 0 | 0 | 0 | 0 | 0.15 s | 0 |

### 5.8 MP4s

**The index at the end → served in front** (`media/faststart.js`). What
qt-faststart does to a file, done to the bytes on the wire: the moov box goes
out right after `ftyp` with every chunk offset moved by its size; the rest is
the file's own bytes. Nothing on disk changes; the patched index is held in
memory for six titles. ffprobe and ffmpeg read the served file as the same
film, packet for packet; all 16 tail-index MP4s of the owner's library get a
plan (checked read-only). The TV benefits too — ExoPlayer does the same
end-of-file dance.

| title | mode | HL-HB before | HL-HB after, as on disk | HL-HB after, index served in front | LL-HB before | LL-HB after, as on disk | LL-HB after, index served in front |
|---|---|--:|--:|--:|--:|--:|--:|
| mp4-tail | cold | 1.84 s | 1.51 s | 1.17 s | 0.46 s | 0.33 s | 0.24 s |
| mp4-tail | warm | 1.31 s | 1.06 s | 1.06 s | 0.24 s | 0.21 s | 0.21 s |
| mp4-tail | resume | 2.72 s | 2.53 s | 2.13 s | 0.73 s | 0.70 s | 0.67 s |
| mp4-fast | cold | 1.32 s | 1.19 s | 1.04 s | 0.51 s | 0.34 s | 0.18 s |
| mp4-fast | warm | 1.26 s | 1.04 s | 1.06 s | 0.29 s | 0.20 s | 0.17 s |
| mp4-fast | resume | 2.37 s | 2.04 s | 2.07 s | 0.84 s | 0.68 s | 0.59 s |

**A long index on a known line → the stream instead of the file**
(`media/mp4index.js`, `playstart.js` `streamSaves`). jit can now serve an
MP4: its keyframe map is read from the moov box (exact against ffprobe on 15
of the owner's films and on MP4s written six different ways; jit's own check
of every segment boundary still applies). When this device knows its line,
the film's index alone would take more than 1.5 s longer than a stream's
start, **and the line carries the film with room to spare (1.3× its
bitrate)**, the player opens the single-rendition jit stream — the file's own
video, its index never downloaded.

| title | mode | ML-MB before | ML-MB after |
|---|---|--:|--:|
| mp4-fast | cold | 2.79 s | 0.67 s |
| mp4-fast | resume | 4.75 s | 3.47 s |
| mp4-tail | cold | 2.87 s | 0.42 s |
| mp4-tail | resume | 4.91 s | 2.97 s |
| mkv-ac3 | cold | 4.17 s | 0.41 s |
| mkv-ac3 | resume | 5.01 s | 2.98 s |
| mkv-ac3-8m-g5 | cold | 16.0 s | 3.69 s |
| mkv-ac3-8m-g5 | resume | 16.3 s | 3.00 s |

The room-to-spare rule is why the 3 Mbit/s rows for `mp4-*` did not move: a
2.5 Mbit/s film on a 3 Mbit/s line plays as a file and starves as a stream
(the stream's container and re-encoded sound weigh a few percent more —
measured, on the first build of this: a resume at 22–32 s). There the index
is waited for, as before; a 480p start would be quick, but it would not be
the picture the file gives.

### 5.9 Before the press

A title page now makes its film's start ready when it has painted and the
browser is idle — not only when a pointer reaches Play (a finger gives a
tenth of a second's notice; a remote none). Two small playlists go out, and
the server makes the first seconds (bounded as in §5.4). Up next and the Next
episode button do the same for the next episode while the card counts down.
Not on a slow line or under Data saver.

| title | mode | LL-HB before | LL-HB after, pressed at once | LL-HB after, page had a moment | HL-HB before | HL-HB after, pressed at once | HL-HB after, page had a moment | HL-LB before | HL-LB after, pressed at once | HL-LB after, page had a moment | LL-LB before | LL-LB after, pressed at once | LL-LB after, page had a moment |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| mkv-ac3 | cold | 2.10 s | 0.84 s | 0.30 s | 3.75 s | 1.02 s | 0.80 s | 14.6 s | 5.10 s | 1.69 s | 13.4 s | 5.08 s | 2.49 s |
| mkv-ac3 | resume | 1.83 s | 1.55 s | 0.79 s | 3.41 s | 2.27 s | 1.68 s | 79.4 s | 13.9 s | 5.28 s | 52.8 s | 5.54 s | 6.97 s |
| mkv-ac3-8m-g5 | cold | 2.33 s | 1.68 s | 0.27 s | 4.30 s | 1.23 s | 0.90 s | > 120 s (0/3) | 3.58 s | 0.73 s | > 120 s (1/3) | 5.81 s | 1.38 s |
| mkv-ac3-8m-g5 | resume | 2.51 s | 1.62 s | 0.92 s | 4.61 s | 3.08 s | 2.35 s | 90.1 s (2/3) | 10.1 s | 5.00 s | > 120 s (1/3) | 5.20 s | 4.34 s |
| mkv-hevc10 | cold | 1.31 s | 0.94 s | 0.27 s | 3.03 s | 0.92 s | 0.64 s | 76.0 s | 2.65 s | 0.73 s | 74.0 s | 4.70 s | 2.62 s |
| mkv-hevc10 | resume | 1.49 s | 0.91 s | 0.36 s | 2.90 s | 2.09 s | 1.15 s | 81.6 s | 6.73 s | 3.42 s | 83.8 s (2/3) | 5.97 s | 3.36 s |
| ep1 | cold | 1.75 s | 0.81 s | 0.26 s | 3.95 s | 1.31 s | 0.98 s | 54.1 s | 1.86 s | 0.94 s | 78.0 s | 3.36 s | 0.64 s |
| ep1 | next | 2.33 s | 0.58 s | 0.74 s | 3.85 s | 1.23 s | 1.14 s | 75.3 s | 1.75 s | 3.73 s | 68.6 s | 3.76 s | 2.02 s |
| ep1 | resume | 2.62 s | 1.72 s | 0.38 s | 3.26 s | 1.79 s | 1.47 s | 55.3 s | 14.1 s | 3.41 s | 83.2 s | 5.88 s | 2.97 s |

### 5.10 A resume

With segments played as they arrive, hls.js still moves the playhead to a
start position only when the first segment is buffered **whole** — so a
resume waited for all of a segment where a start from the top needs its
first chunk (seen in the "after" rows: the first frame at the very moment the
segment's last byte arrived). The player now puts the playhead there as soon
as the buffer covers the point. The resume rows of the table in §5.9 are with
this; what remains is the distance from the keyframe to the resume point
(§6).

### 5.11 Other lines

| title | mode | HL-1.5 before | HL-1.5 after | LOSS-2 before | LOSS-2 after |
|---|---|--:|--:|--:|--:|
| mp4-fast | cold | 15.1 s | 13.0 s | 12.3 s | 11.3 s |
| mkv-ac3 | cold | 83.8 s | 1.75 s | 80.2 s | 3.88 s |
| mkv-ac3-8m-g5 | cold | 49.8 s | 1.69 s | 54.6 s | 4.68 s |
| ep1 | cold | 23.1 s | 2.44 s | 20.4 s | 3.97 s |

### 5.12 Keyframes 2, 5 and 10 s apart

An 8 Mbit/s film cut three ways, far fast line (HL-HB, cold). A segment is
at least six seconds and ends on a keyframe, so the first one weighs 6–10 MB
whatever the spacing; before, all of it stood between the press and the
picture.

| title | mode | HL-HB before | HL-HB after |
|---|---|--:|--:|
| mkv-ac3-8m-g2 | cold | 3.66 s | 1.08 s |
| mkv-ac3-8m-g5 | cold | 3.70 s | 0.91 s |
| mkv-ac3-8m-g10 | cold | 3.61 s | 0.94 s |

### 5.13 An episode that starts by itself

Up next counts down and the next episode begins (HL-HB; time from the
address change to the first frame). While the card is up the next episode's
record, playlists and first segment are now made ready.

| title | mode | HL-HB before | HL-HB after |
|---|---|--:|--:|
| ep1 | autonext | 2.62 s | 0.81 s |

### 5.14 Smaller things

- hls.js is loaded once however many callers ask (two `<script>`s could be
  added); the ladder's own Auto for a two-codec ladder waits for a segment
  before it judges the line (it stepped down mid-first-segment on hls.js's
  stock estimate); the old line watcher leaves an hls.js stream alone until
  it has shown a frame.
- `Server-Timing` on every `/api` and `/stream` answer (`app`, and `table`,
  `ladder`, `seg`, `job` where a route names them): DevTools shows it, and it
  is how this report splits server from line.

### Waterfalls, after

The same far-server start as in §3 (HL-HB, `mkv-ac3`, cold):

```
mkv-ac3 · cold · HL-HB (far server on fibre: 50 Mbit/s, 180 ms) — run 1, first frame at 1021 ms
path ladder, starts on copy; 3 requests in a row before the first media byte (567 ms); server 5 ms of that; 354 kB of media by the first frame

 start 1st byte    end    bytes  |----------------------------------------------------------|  what
    12      222    210     0 kB   ...........#                                                 script /js/vendor/hls.min.js
    12      197    196     1 kB   ..........#                                                  playlist …/jit/master.m3u8 [server 3 ms, probe 1 ms]
   198      383    382     1 kB             ..........#                                        playlist …/jit/index.m3u8?v=copy [server 1 ms]
   237     1221   1220     0 kB               ..............................................#  subtitle /stream/embedded/05685f552d2a/0 [server 58 ms]
   384      567    567     0 kB                       ..........#                              segment …/jit/seg00000.ts?v=copy&warm=1 [server 1 ms]
   392      576   1424   352 kB                        ..........############################  segment …/jit/seg00000.ts?v=copy [server 2 ms, segment ready 1 ms]
                                 M                                                    L F     M player mounted 13 · L metadata 975 · F first frame 1021
marks: mount@0  path:ladder@184  ladder:h264-480,h264-720,copy@221  first-frame@1212
```

A thin far line (HL-LB, `mkv-ac3`, cold) — 14.6 s before:

```
mkv-ac3 · cold · HL-LB (far and thin: 3 Mbit/s, 200 ms) — run 2, first frame at 5101 ms
path ladder, starts on h264-480; 3 requests in a row before the first media byte (670 ms); server 19 ms of that; 281 kB of media by the first frame

 start 1st byte    end    bytes  |----------------------------------------------------------|  what
    19      313    278     0 kB  ...#                                                          script /js/vendor/hls.min.js
    19      242    239     1 kB  ...#                                                          playlist …/jit/master.m3u8 [server 11 ms, probe 8 ms]
   243      459    458     1 kB     ..#                                                        playlist …/jit/index.m3u8?v=h264-480 [server 6 ms]
   339     1848   1846     3 kB      ................#                                         subtitle /stream/embedded/05685f552d2a/0 [server 115 ms]
   460      670    671     0 kB       ..#                                                      segment …/jit/seg00000.ts?v=h264-480&warm=1 [server 2 ms]
   474        —   3481     0 kB       .......................................................  segment …/jit/seg00000.ts?v=h264-480
  3479     3694   3692     1 kB                                        ...#                    playlist …/jit/index.m3u8?v=copy [server 6 ms]
  3697     4454  12386   279 kB                                           ........###########  segment …/jit/seg00000.ts?v=copy [server 553 ms, segment made 542 ms]
                                M                                                       F     M player mounted 20 · L metadata 5058 · F first frame 5101
marks: mount@0  path:ladder@223  start-rung@312  ladder:h264-480,h264-720,copy@314  start-up@3457  first-frame@5076  abr:h264-480@16523
```

---

## 6. What did not help, and what was left alone

- **`-probesize` / `-analyzeduration` on the producer.** First segment done
  in 300–560 ms with or without (four files, three settings, inside the
  noise). The container is not what ffmpeg spends the time on.
- **What it does spend it on: the sound.** Measured: AAC (ffmpeg's default
  `twoloop` coder) encodes at 17–23× real time; the video copy runs at 300×.
  Ten seconds of film is 0.45–0.6 s of audio encoding — the whole
  first-segment cost. `-aac_coder fast` does it in 0.2 s (and would take 60%
  off the CPU of every repackaged film), and an AAC source could be copied
  outright (6 of the library's MKVs, every MP4-as-stream). **Not done**: both
  change what is heard, and that needs ears, not a harness. Proposed.
- **A shorter first segment.** The copy can only be cut on the file's own
  keyframes (up to 10 s apart), and every rung shares one segment table by
  design. Progressive loading gets the same result from the client's side.
- **hls.js `startFragPrefetch`, `lowLatencyMode`, `maxBufferLength`,
  `testBandwidth`.** No effect on a start as this player makes one (the
  first is for a source loaded before the element is attached; the second is
  for LL-HLS parts; the third is about how far ahead to fetch; the fourth
  would download and throw away a whole lowest-rung segment — an *encode* —
  just to measure the line).
- **The page's line estimate (`net.js`) as the start rung.** Reads a
  3 Mbit/s line as 65 and a 1.5 as 2.4. Replaced for this purpose by what
  hls.js itself measured (§5.6). `net.js` is untouched.
- **Preconnect, 103 Early Hints, HTTP/2 priorities.** The page's connections
  are open when Play is pressed; nothing new is dialled (0 new connections).
- **Inlining the playlists in the item's record.** Would save the last two
  round trips for everyone, at the price of an index read and an ffprobe on
  every `/api/item` and 15–30 kB in every answer. The page-open warm-up
  (§5.9) gets the same result only where a film is about to be played.
- **Immutable caching of segments.** A segment's URL does not name the
  file's version (its mtime is server-side), so it cannot be promised for
  ever. Replays revalidate (a 304 each) — as before.
- **Deferring the embedded-subtitle extraction** until after the first frame:
  it only moves a whole-file read by a second. The real fix is to extract
  text tracks when a file is scanned. Proposed.
- **Resume inside a long GOP.** A resume point lands on average 5 s into a
  10 s GOP, and everything from the keyframe has to be there before the
  frame can be shown (0.8–1.7 MB): 5–6 s at 3 Mbit/s, where a start from the
  top takes 1.5. Starting at the keyframe would show up to 14 s the viewer
  has already seen. Left as it is.

---

## 7. HTTPS and HTTP/2 (production)

Clients reach nufurora.com through Caddy: TLS, HTTP/2 (HTTP/3 where the
client takes it). Caddy is not installed on this machine; a local stand-in
was written (`tools/ttff/h2-front.js`). What it changes for a start:

- **Nothing is dialled at a start either way** — under HTTP/1.1 the page's
  six keep-alive connections are reused (measured: 0 new connections), under
  HTTP/2 there is one. TLS's extra round trip is paid when the page loads,
  not when Play is pressed.
- **One connection keeps its congestion window.** Under HTTP/1.1 the segment
  may land on a connection that has been silent for seconds and starts slow
  again; under HTTP/2 the playlists that precede it have just used the same
  connection. A little better for the first megabyte on a far line.
- **Caddy's upstream is this server**: `Server-Timing`, gzip of playlists
  and the client hanging up all pass through (Caddy cancels the upstream
  request when the client goes — which is what §5.2's "stops waiting" needs.
  Worth one look in production: `[jit] parked … (its viewer left)` in the
  log after leaving a repackaged film).

Through the local front (HL-HB, cold, 2 runs each):

| title | mode | HL-HB before, HTTP/2 | HL-HB after, HTTP/2 | HL-HB before, HTTP/1.1 | HL-HB after, HTTP/1.1 |
|---|---|--:|--:|--:|--:|
| mp4-tail | cold | 1.46 s | 1.69 s | 1.84 s | 1.51 s |
| mkv-ac3 | cold | 2.81 s | 1.93 s | 3.75 s | 1.02 s |

(Warm starts are not comparable there: Chrome caches nothing from a site
with a self-signed certificate, so hls.js and every segment are downloaded
again.)

---

## 8. The TV app (analysis and code — not run on a device)

### The start, as `Player.tsx` makes it

```
Player mounts                               mark('mount')
 └ api.state(profileId)                     the history — AWAITED (retried once after 1 s)         1 round trip
    └ api.item(id)                          memoised 45 s: free when Detail just fetched it, else  +1
       └ arming: which track, which path
            the file itself                 setUri(/stream/video/<id>)
            sound the TV cannot play        startTranscode(base, resume, 'copy')
               └ fetch(…/<ss>/index.m3u8?v=copy&seek=1)   the claim, not awaited
               └ setUri(…/<ss>/index.m3u8?v=copy)
          └ ExoPlayer opens the source
               offset job: the playlist answers when ffmpeg has written its first segment
                           (one GOP; 0.3–1 s), then the segment
               MKV file:   header, then (cues at the end) a seek to read them
               MP4 file:   the whole index; at the end of the file → +2 round trips (now served in front, §5.8)
             └ buffers bufferForPlaybackMs = 2000 ms of film → READY → first frame
                └ resume, direct play: onLoad → seek(resume) → opens again at the new offset, buffers 2 s again
```

`react-native-video` settings that govern it (`BUFFER_CONFIG`): `minBufferMs`
50 000, `maxBufferMs` 120 000, **`bufferForPlaybackMs` 2000**,
`bufferForPlaybackAfterRebufferMs` 8000, `minLoadRetryCount` 50. The first
two do not touch a start. The third is two seconds of *film* that must be in
hand before the first frame: nothing on a line that carries the file many
times over, but `2 s × bitrate ÷ line` otherwise — 1.7 s for a 2.5 Mbit/s
film on a 3 Mbit/s line. There is no bitrate estimate to set (the TV never
plays a multi-rendition stream) and no `startPosition` (resume is a seek
after load).

### What was changed (in `tv-native/`, type-checked, not built into an APK)

**On by default — no judgement call in them:**

- `api.item` goes out **beside** `api.state`, not after it; and a state the
  title page read within the last 30 s (and nothing has written to since —
  `saveProgress` forgets it) is used as it is. One round trip off every
  start, two when the item was not memoised.
- `first-frame` is marked on `onReadyForDisplay` (ExoPlayer reaching READY)
  instead of the first `onProgress` tick. `progressUpdateInterval` is
  1000 ms: every TV start has been stamped **up to a second late**. The mark
  now also carries `meta` (ms until the item and history were in), `armed`
  (ms until the source was handed to ExoPlayer) and `buf` (the start buffer
  in force), so one log line splits a start into app / player.

  This means TV start times in the log and in the healer's statistics will
  read ~0.5 s lower from this build on without anything having become
  faster. Compare like with like.

**Off unless the server says otherwise** — `GET /api/tv/tuning` returns
config.json's `"tvPlayer"` (checked and clamped: `src/lib/tvtuning.js`); the
app asks once a minute at most and uses what it is told; `{}` (the default)
is today's behaviour exactly:

| key | default | what it does | why it needs the device |
|---|---|---|---|
| `startBufferMs` | 2000 | `bufferForPlaybackMs` | a smaller buffer starts sooner and may stall sooner on a jittery Wi-Fi |
| `rebufferMs` | 8000 | `bufferForPlaybackAfterRebufferMs` | |
| `resumeAtSource` | false | a direct-play file is opened AT the resume point (`source.startPosition`) instead of at 0:00 and then sought | saves a seek and the film's first megabytes on every resume; changes when `onLoad` fires relative to the position |

**Server-side, already helping the TV:** the tail-index MP4 served in front
(§5.8); the client hanging up ends a wait (§5.2).

### Proposed, not written: the TV on the jit path

The TV's repackaged path is still the offset job
(`/stream/transcode/<id>/<ss>/index.m3u8`): a growing EVENT playlist that
only exists once ffmpeg has written a segment, restarted from scratch for any
seek outside what has been made. Moving it to the jit stream the website uses
would give it a complete VOD playlist (every seek native), the start hint,
`bye`, and — for H.264 sources — the ladder on a thin line. What it needs:
`streamOffset` becomes 0 and stays there (the player's clock arithmetic
assumes an offset), resume becomes `startPosition`, the keep-alive ping
goes, and ExoPlayer must be told not to treat the two-codec ladder (HEVC on
top, H.264 below) as adaptive, or to take the single playlist there. It is a
rewrite of the transcode half of a 4000-line player that cannot be seen
running from here. It should be done on the device.

### Device measurement plan

*What to read.* The server log (admin → Logs, or the process's stdout):

```
[play] <id> +0ms mount app=tv
[play] <id> +<ms>ms first-frame transcode=<bool> v=<direct|copy|h264> app=tv meta=<ms> armed=<ms> buf=<ms>
```

`first-frame` ms = mount → ExoPlayer READY. `meta` = the app waiting for the
server; `armed − meta` ≈ 0; `first-frame − armed` = ExoPlayer opening the
source and filling its start buffer. (`slow-start`, `stall`, `stall-end` and
`error` marks are unchanged.) Add the navigation from Detail yourself if you
want press-to-picture: film the screen, or accept that it is ~50–150 ms.

*The server.* A dev instance of this branch on this PC with real-shaped
files — a private instance with `tools/ttff/.media` as its library (as
`tools/ttff/lib.js startInstance` starts one), or the branch checked out
beside production on another port with its own data folder. Not the
production server.

*The line.* `node tools/throttle-proxy.js --listen 4010 --to <port> --down D --up U --latency L --handshake 1 --slowstart 1`
and a QA build of the app pointed at `http://<this PC's LAN address>:4010`
(the QA-variant recipe is in the project memory). The four corners:

| | `--down` | `--up` | `--latency` (each way) |
|---|---|---|---|
| LL-HB | 100000 | 40000 | 2 |
| HL-HB | 50000 | 20000 | 90 |
| HL-LB | 3000 | 1000 | 100 |
| LL-LB | 3000 | 1000 | 5 |

(The TV's own Wi-Fi adds its real latency on top; note it once with a ping.)

*The files.* One of each: an MKV the TV plays itself (HEVC + AAC — the common
case); an MP4 with its index at the end (`mp4-tail`); a file whose sound it
cannot play (`mkv-ac3` or an E-AC-3 5.1 — the offset job); a resume at 40%
of each.

*The runs.* Per file × line: 5 cold (restart the dev server between them, or
use five different episodes) and 5 warm, reading `first-frame`. Then:

1. **This build against 5.1.31**, same files, same lines — expect
   `first-frame` lower by the round trip(s) saved *and* by the ~0.5 s the
   stamp used to add; `meta` tells the two apart.
2. **`"tvPlayer": { "startBufferMs": 1000 }`** in the dev server's
   config.json (restart it; the app picks it up within a minute — check
   `buf=1000` in the mark). Expect nothing on LL-HB / HL-HB and up to −0.9 s
   on the 3 Mbit/s lines. Then watch ten minutes of a film on LL-LB and on
   the real home Wi-Fi and count `stall` marks against the same ten minutes
   at 2000. If stalls do not rise, try 500.
3. **`"resumeAtSource": true`**, the resume runs only. Expect one seek and
   2 s of buffering less; check that the resume card shows, the scrubber
   starts at the resume point, subtitles are in time, and that a resume of a
   file with sound the TV cannot play (the offset path — not touched by the
   switch) is unchanged.
4. Whatever wins goes into production's config.json — no new APK needed.

---

## 9. Torrent streams (read, not measured)

Pressing play on a source: the player first asks whether the title is owned
(`/api/library/for`) — **before** anything may touch the swarm, by design —
then `GET /api/torrents/probe/<hash>/<idx>` (the file's real codecs, read
from its first pieces) and waits up to **1.5 s** for it; then direct
(`/stream/torrent/<hash>/<idx>`, range reads through WebTorrent) or the
torrent's own transcode / jit routes. Everything is bounded by the swarm:
metadata, peers, the first pieces. The server already pre-warms the best
source while the sources list is on screen (`prewarmStreams`).

Of this work, a torrent start gets: the progress read skipped when fresh,
the kick fix, progressive loading on its hls.js paths, the start watch and
line memory on a ladder. Its playlists are deliberately *not* asked ahead or
kept (their answer depends on the swarm), and MP4 torrents do not get a jit
table (an MP4's index is megabytes at the far end of a file that is still
downloading). The 1.5 s probe wait is the one fixed cost that could be
looked at — it is only paid in full when the swarm is cold, where the start
is tens of seconds anyway. **Unmeasured; nothing here was run against a
swarm.**

---

## 10. On, off, proposed

**On**

| | where |
|---|---|
| the kick only on an idle loader; no "switch" to a stream that is the same stream | `public/js/screens/player.js` |
| a hung-up request stops waiting; abandoned encoders free their slot; `bye` | `src/media/jit.js`, `src/routes/stream.js`, player |
| requests together (`prestart`), progress not re-read within 30 s, playlists gzipped | player, `state.js`, `src/lib/compressible.js` |
| the start hint and `&warm=1`; table + probe warmed with the item | `stream.js`, `jit.js`, `ladder.js`, `src/lib/playprep.js` |
| progressive loading (`aurora-hls-progressive=0` to turn off) | player |
| line memory, start rung, start watch | player, `public/js/playstart.js` |
| encoders at normal priority until their first segment; 3 s patience for an encoded start (12 s on a line known to be thin) | `jit.js`, player |
| tail-index MP4s served index-first (`"serveFaststart": false` to turn off) | `src/media/faststart.js` |
| MP4 → stream on a known line with room to spare; jit reads MP4 indexes | `src/media/mp4index.js`, player |
| a resume's playhead set when the buffer covers the point | player |
| title page / Up next / Next button make the start ready | `discover-detail.js`, `prefetch.js`, player |
| `Server-Timing` | `src/lib/servertiming.js` |
| TV: item beside state, fresh state reused, exact `first-frame` with `meta` / `armed` / `buf` | `tv-native/src/playback/Player.tsx`, `api.ts` |

**Implemented, off until the device says so**

| | switch |
|---|---|
| TV start buffer 2000 → lower | config.json `"tvPlayer": { "startBufferMs": … }` |
| TV rebuffer threshold | `"tvPlayer": { "rebufferMs": … }` |
| TV resume at the source | `"tvPlayer": { "resumeAtSource": true }` |

**Proposed**

- `-aac_coder fast`, and copying AAC sound instead of re-encoding it (§6) —
  the first segment's whole server cost; needs a listening check.
- Text subtitle tracks extracted when a file is scanned, not on first play.
- The TV on the jit path (§8).
- A copy producer that parks itself when it is far ahead of its reader, as an
  encoder does (today it writes the whole film to the cache — 1.3 GB for an
  hour — every time a film is started; `bye` now stops it when the player
  closes).
- `net.js`'s line estimate, which reads thin lines as fast, deserves its own
  look: the capped stream it guards (under 1.5 Mbit/s) rarely triggers.

---

## 11. Risks

- **Progressive loading** is the change with the least history behind it.
  Signs it is misbehaving: frames then a freeze right at a start, `[play] …
  stall` marks within the first seconds of repackaged films, `hls` errors in
  a client's console. One key turns it off per device; `PROGRESSIVE_DEFAULT`
  turns it off for everyone.
- **A first play on a thin line** shows its frame early and then stalls for
  a few seconds (§5.6) — less in total than before, but a frame-then-freeze
  where there used to be a spinner. Once per device.
- **Line memory can be wrong** for the line a device is on today. Too high:
  the start watch catches it within ~2 s. Too low: one segment (6–10 s) of a
  lighter rung, then hls.js climbs.
- **A warm replay confuses hls.js's own estimate.** Segments the browser has
  cached "arrive" instantly; hls.js then reaches for the top rung, finds the
  real line, and steps back down (seen in the warm rows on thin lines — it
  was so before this work too). Harmless on a line that carries the film.
- **Encoders at normal priority for their first segment** take CPU from the
  server for about a second per start of an encoded rung. If the server ever
  feels it, the old behaviour is one line (`jit.js` `startProducer`).
- **The served-in-front MP4** holds up to six patched indexes in memory
  (≤ 9 MB each on this library, 48 MB cap per file). Anything unusual about a
  file → served as it is on disk.
- **The stream-instead-of-file rule** puts an ffmpeg copy on the server for
  an MP4 that used to cost it nothing — only on a device with a known line
  between "carries the film with room" and "carries the index in a moment".
- **More requests before the press**: a title page now asks for two
  playlists and may start a three-segment warm-up (10–30 MB in the cache for
  2.5 minutes). Bounded at eight a minute; never on a slow line.
- **Not exercised by anything here**: iPhone / Safari native HLS (the code
  paths were kept as they were: no hls.js, no progressive, no ladder), watch
  parties, kids gating (the routes go through the same wall as before; `bye`
  and `warm` only ever stop or start producers of a file the caller can
  already stream), HDR tone-mapped encodes at a start.

---

## 12. Tests

- `npm test`: **923 tests, 923 pass** (843 on master + new: `servertiming`,
  `compressible`, `playstart`, `starthint`, `jit-warm`, `mp4index`,
  `playprep`, `faststart`, `tvtuning`). The CI way too — a clean clone under
  WSL (Linux, Node 22, no ffmpeg): 922 run, 896 pass, 26 skip for want of
  ffmpeg, 0 fail.
- The browser suites (`npm run test:ui`, all sixteen files, on the last
  commit, progressive loading on): **130 tests, 129 pass, 1 skipped, 0 fail**
  (an earlier run lost six `player-hls` tests to `page.goto` timeouts while
  the machine was saturated; the same file passed three times afterwards).
- `tv-native`: `tsc --noEmit` clean. No APK was built.
