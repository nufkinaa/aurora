# Art format: the TV's remaining JPEGs as sized WebP — bench and device plan

Lab: `C:\elia\aurora-lab`, branch `native-lab`, app `com.auroratv.lab`. Prepared 2026-10-10
without the TV. **Run on the Mi TV the same day: the results are in `ART-FORMAT.md`** (the script and the
key sequences of §4 changed there — its §6); the text below is the plan as it was written.

## 1. What is behind the switch

| picture | today | with `artWebp` on |
|---|---|---|
| home hero, both layers (`?w=1280&blur=1` / `blur=2`) | 4:4:4 JPEG q2 from our server | the same address + `&fmt=webp` → WebP q78 |
| title-page backdrop | the catalogue's original JPEG, straight from `images.metahub.space` (up to 1920×1080, re-encoded on the box by `resizeMethod="resize"`) | `/img/ext?u=…&w=1600` on a 1080p set (the ladder step that covers the 0.70 × 0.76 art box with a 16:9 picture; 1920 on a denser screen), WebP q84, with the session headers `imgSrc` adds |
| stills / scrubber frames | JPEG | **unchanged** — see §2 C |
| a 1920 hero | — | **not added** (measured earlier: the blur hides it) |

Server (default unchanged, so every cached file stays valid): `?blur=N&fmt=webp` on `/img/ext`,
`/img/poster/…`, `/img/meta/…`, `/img/:id`; the WebP has its own cache key and name
(`<md5(…|bN|webp)>-w1280-bN.webp`); any other `fmt` is ignored; `fmt` without `blur` is ignored
(unblurred variants were WebP already). `/api/ping` says `imgFmt: ["webp"]`; the TV asks for
neither thing from a server that does not say so.

TV: `tv-native/src/artFormat.ts` (switch), `api.ts` `artPath` / `backdropSrc`,
`android/…/ui/art/` (switch reader, JS module, probe).

## 2. The bench (PC) — `node tools/art-format-bench.js`

Ten backdrops from the running server's `/api/home` (five from the hero rotation, five across
the rows; six are 1920×1080, four 1280×720; 95–971 KB). The server's own filter chain
(`imgvariant.blurChain`), blur 1 and 2, 1280 wide. Each row is judged against the **unencoded**
blurred picture, both stretched bilinear to 1920×1080 (what the TV draws). ffmpeg 6.0, libwebp.
Decode ms: single thread, PC — a proxy, not the box.

### A. Hero (blurred)

```
option                      KB med  KB min  KB max  SSIM mean  SSIM min  PSNR mean  PSNR min  worst px  mean err  enc ms  dec ms
--------------------------  ------  ------  ------  ---------  --------  ---------  --------  --------  --------  ------  ------
jpeg 4:4:4 q2 (today)        127.3    48.6   185.1     0.9882    0.9780       47.8      45.7        14      0.74     194     3.5
jpeg 4:2:0 q2                 92.9    39.1   147.9     0.9815    0.9563       46.0      42.7        39      0.90     181     1.9
jpeg 4:2:0 q4                 59.9    25.9    85.6     0.9702    0.9364       43.1      39.8        41      1.28     180     1.6
jpeg 4:2:0 q6                 47.8    21.8    65.5     0.9612    0.9225       41.3      38.2        54      1.55     181     1.4
webp q70 bgra                 31.7    12.4    54.9     0.9589    0.9239       40.0      37.6        49      1.79     243     3.9
webp q78 bgra                 38.2    14.8    65.8     0.9653    0.9368       41.1      38.7        45      1.59     243     4.5
webp q78 yuv420p              38.2    14.7    66.1     0.9652    0.9358       41.1      38.6        43      1.59     231     4.5
webp q84 bgra                 49.0    18.3    83.7     0.9723    0.9468       42.5      40.2        41      1.35     247     5.3
webp q84 yuv420p              48.8    18.2    85.3     0.9720    0.9455       42.5      40.0        39      1.35     233     5.2
webp q84 bgra preset photo    51.0    18.0    96.3     0.9722    0.9525       42.2      39.9        34      1.37     250     5.5
webp q84 bgra cl6             48.9    18.2    83.6     0.9723    0.9472       42.5      40.2        41      1.35     275     5.3
webp q90 bgra                 69.1    26.6   120.6     0.9800    0.9616       44.5      42.1        31      1.08     252     6.5
webp q90 yuv420p              69.3    26.3   120.7     0.9797    0.9610       44.5      42.0        34      1.08     239     6.5
webp q95 bgra                109.2    41.6   187.3     0.9866    0.9746       46.8      44.3        33      0.81     258     8.1
webp lossless                564.7   268.7   811.6     1.0000    1.0000       99.0      99.0         0      0.00     563    21.9
```

(`worst px` / `mean err`: levels of 255 on one channel. `enc ms` carries ffmpeg's start, the
source decode and the blur — the same on every row. Two full runs gave the same numbers to the
last digit except timings, ±1 ms. `bgra` = libwebp does RGB→YUV; `yuv420p` = swscale does.
Lossy WebP is 4:2:0 only, and this ffmpeg's libwebp has no `sharp_yuv`, so there is no
full-chroma WebP short of lossless.)

**Setting chosen: WebP quality 78, compression_level 4, input `bgra`, no preset** — the one
the unblurred variants already use.

- 38 KB against 127 KB: **−70 %**. q84 is 49 KB (−62 %).
- q78 → q84 buys +0.007 SSIM / +1.4 dB for +28 % bytes and +18 % decode; every step above
  costs about twice the bytes per SSIM point of the one before (q84→90: +20 KB for +0.008;
  q90→95: +40 KB for +0.007).
- Mean error 1.6 levels, drawn under the hero's 0.45 / 0.42 black scrim: under one level on
  screen. The worst single pixel (45) is 4:2:0 chroma on an isolated colour edge — the 4:2:0
  JPEG shows the same (39–54).
- `bgra` vs `yuv420p`: no measurable difference (SSIM within 0.001; 12 ms of one-off encode).
- `preset photo`: a better worst picture (min SSIM 0.9525 vs 0.9468) but a worse worst file
  (96 vs 84 KB) and the same mean — no. `compression_level 6`: nothing, 11 % slower encode.
- If the device screenshots show a difference at q78, q84 is the fallback: one constant,
  `BLUR_WEBP_CODEC` in `src/lib/imgvariant.js` (and delete the `-b?.webp` files in
  `data/cache/img-variants`).

**What the bench says against WebP, and the device must settle:** on this PC the WebP does
**not** decode faster than today's JPEG — 4.5 ms against 3.5 ms (+29 %), and a 4:2:0 JPEG
decodes in 1.4–1.9 ms. A 4:2:0 JPEG at q4 is 60 KB (−53 %) at q84-WebP quality with less
than half today's decode time. The server does not offer that format; if the box's decode
numbers in §4 come out against WebP, a lean 4:2:0 JPEG is the arm to add next
(`fmt=` already has a place for it).

### B. Title-page backdrop (sharp), the server's existing variants vs the original

```
option                 KB med  KB min  KB max  SSIM mean  SSIM min  PSNR mean  worst px  enc ms  dec ms
---------------------  ------  ------  ------  ---------  --------  ---------  --------  ------  ------
original jpeg (today)   410.4    95.5   971.3     1.0000    1.0000          -         0       -     7.5
webp w1280               81.3    29.4   174.8     0.8909    0.7666       35.2       141     163     6.7
webp w1600              150.5    49.1   327.4     0.9270    0.8696       37.1       131     210    11.3
webp w1920              213.7    49.1   475.8     0.9527    0.9071       39.2        97     210    15.4
```

(SSIM here is against the 1920×1080 original at full screen, which is harsher than the page:
the art box draws the picture about 1460 px wide on a 1080p set, so the 1600 step is not
upscaled there.)

- 1600 (what the TV will ask for at 1080p): 150 KB against 410 KB median, **−63 %**
  (the four 1280×720 sources are not upscaled; they come back at their own size).
- The 50–115 KB that was expected for 1920 is not what these ten give: 49–476 KB, median 214.
- PC decode is **slower** for the WebP (11.3 ms at 1600 against 7.5 ms for the 1920 JPEG).
  On the box the JPEG also pays `ResizeAndRotateProducer` (the on-box re-encode
  `resizeMethod="resize"` asks for) and the WebP does not — the probe logs both; that sum is
  what §5 judges.

### C. Stills / scrubber frames — not converted

```
option                      KB med  SSIM mean  total ms  scale+encode ms
--------------------------  ------  ---------  --------  ---------------
still 1280 jpeg q3 (today)   181.4     0.9717       112               65
still 1280 webp q78 cl4       81.3     0.9448       161              114
still 1280 webp q78 cl1       91.4     0.9421       121               74
still 1280 webp q78 cl0       94.4     0.9418       118               71
frame 640 jpeg q4 (today)     44.6     0.9480       105               58
frame 640 webp q78 cl4        24.4     0.9272       116               69
frame 640 webp q78 cl1        28.0     0.9241       103               56
frame 640 webp q78 cl0        29.0     0.9238       103               56
```

(a backdrop stands in for the decoded video frame; the seek and video decode are the same
either way.) At the server's WebP setting generation is slower: +49 ms for a still, +11 ms
for a frame. Only at compression_level 0–1 does it come level (+6…9 ms / −2 ms), for half
the bytes at a lower SSIM. The rule was "only if generation does not get worse": it does at
1280, so `/img/still` and `/img/frame` are **left as JPEG**. Worth revisiting only for the
640 scrubber frames at cl 0–1, and only if bytes there matter.

## 3. The switches

All three are marker files in the app's external files dir, read once per process start
(`ui/art/ArtFormat.kt`). No broadcast, no receiver, no manifest entry.

```
D=/sdcard/Android/data/com.auroratv.lab/files
adb shell touch $D/art-webp        # artWebp ON   (rm -f … = OFF, the default)
adb shell touch $D/art-probe       # decode probe ON → logcat tag AuroraArt
adb shell "echo http://192.168.50.108:4100 > $D/art-server"   # optional: a lab server first
adb shell am force-stop com.auroratv.lab                       # takes effect at next launch
```

Fallback if the shell cannot write there on this Android: `adb shell setprop
debug.aurora.artwebp 1` / `debug.aurora.artprobe 1` / `debug.aurora.artserver <url>`
(lost at reboot). Each launch logs one line saying what it read:
`AuroraArt: flags webp=1 probe=1 server=- dir=…`. A build-time override is
`FORCE` in `tv-native/src/artFormat.ts`.

## 4. On the TV, when it is free

**0. A server that knows `fmt=webp`.** The lab app talks to `192.168.50.108:4000`, which is the
production tree — it does not have this change. Either

- (a) put the server part on the real server: `src/lib/imgvariant.js`, `src/routes/stream.js`,
  `src/routes/auth.js` (opt-in; without `fmt` nothing changes) and restart it — elia's call; or
- (b) run the lab tree's server on another port (`config.json` with `"port": 4100`, its own
  `data/`) and point the app at it with the `art-server` marker. Its data dir has no profiles
  or library; the hero and the title pages come from the catalogue and work without them.

Check: `curl -s http://192.168.50.108:<port>/api/ping` must contain `"imgFmt":["webp"]`.
Without it the `webp` arm silently asks for exactly what the `jpeg` arm does.

**1. Build and install the lab app once** (it contains the probe; both arms use the same APK).

**2. Run both arms, interleaved** (`tools/art-probe.sh`, not yet run on a device — on the first
run watch that DOWN / CENTER / BACK land where the comments say):

```
CLEAR_CACHE=1 tools/art-probe.sh jpeg -n 3
CLEAR_CACHE=1 tools/art-probe.sh webp -n 3
tools/art-probe.sh jpeg -n 3          # second pass, warm disk cache: decode without the network
tools/art-probe.sh webp -n 3
node tools/art-probe-report.js docs/qa/native-bench/art-format
tools/art-probe.sh off
```

Per run: cold start → 10 s → screenshot (hero 1, blur 1) → 75 s (all eight heroes, 9 s each)
→ DOWN → screenshot (blur 2) → CENTER → screenshot (title page) → two more title pages →
`adb logcat -d -s AuroraArt:I` to `<arm>-<run>.log`.

**3. What to read** (the report prints it per kind `hero-b1`, `hero-b2`, `backdrop`, per arm):

- `decodeMs` — Fresco's DecodeProducer, start → finish, around the decode alone. Median, p90.
- `work` — decode + `ResizeAndRotateProducer` for that request (the title page's JPEG).
- `bytes` — the network fetcher's `image_size`; −1 from the disk cache (hence `CLEAR_CACHE=1`
  on the first pass; if the cache dir is not shell-writable, read bytes with
  `curl -so /dev/null -w '%{size_download}\n' '<url from the done line>'`).
- `fmt` / `bitmap` — must read `WEBP_SIMPLE` in the webp arm; `bitmap` shows whether the
  title page's decoded size changed (JPEG after the on-box resize vs WebP 1600×900 =
  5.8 MB of ARGB) — if it grew, compare `adb shell dumpsys meminfo com.auroratv.lab` on the
  title page in both arms.
- `totalMs` — request → bitmap, the user-visible wait (network included).

**4. Screenshots** — `jpeg-home-rest.png` vs `webp-home-rest.png`, `…-home-scrolled.png`,
`…-detail.png` (same hero / title in both arms: check the title text before comparing).
Look at 1:1 and at 4× on gradients, skin, saturated edges, dark areas; numeric guard:

```
ffmpeg -i jpeg-home-rest.png -i webp-home-rest.png -lavfi "[0:v][1:v]ssim;[0:v][1:v]psnr" -f null -
```

**5. Frame pacing during the rotation** (optional, the decode is off the UI thread):
`tools/tv-bench.sh -l art-jpeg S5` / `-l art-webp S5` with the switch set — janky % and p90.

## 5. Pass / fail

| | pass |
|---|---|
| hero decode (`hero-b1`, `hero-b2`) | WebP median `decodeMs` ≤ JPEG median **+15 ms**, p90 ≤ +30 ms |
| title-page work (`backdrop`) | WebP median (decode + on-box re-encode) ≤ JPEG median **+25 ms**, and median `totalMs` not higher |
| bytes | hero ≥ **50 %** saved, backdrop ≥ **40 %** saved (bench says 70 % / 63 %) |
| picture | no difference visible at 1:1 or 4× in the three screenshot pairs; flag for a closer look if a pair's SSIM < 0.97 or its mean difference > 2 levels (the hero rotates and the clock ticks — crop to the art before trusting a low number) |
| pacing | S5 janky % not higher than the JPEG arm by more than 1 point |
| memory | title-page PSS not higher by more than 4 MB |

15 ms = one frame at 60 Hz, on a picture that fades in over 260 ms every 9 s; 25 ms for a
picture that today waits ~1 s for the network. `tools/art-probe-report.js` applies the decode
and byte limits and exits 1 on a fail.

Outcomes: all pass → ship both (server change to master, switch default on, `ART_LADDER`
comment updated). Hero decode fails, bytes pass → bench says try the lean 4:2:0 JPEG arm
(§2 A) before giving up the bytes. Picture fails at q78 → q84 and repeat §4.4 only.

## 6. Not measured yet

- Everything in §4: decode ms on the Mi TV for JPEG vs WebP (hero both layers, backdrop),
  the on-box re-encode time the backdrop's JPEG pays today, bytes over the wire, bitmap size
  and memory on the title page, the three screenshot pairs.
- Whether `adb shell touch` can write the marker on the Mi TV's Android 14 (the `setprop`
  fallback is there if not).
- The Kotlin in `ui/art/` compiled standalone against Fresco 3.6.0 / react-android 0.86 /
  android-36 with kotlinc 2.1.20, but **the app has not been built or launched with it**
  (no gradle run, by instruction).
- `tools/art-probe.sh` key sequences.
