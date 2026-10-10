# Art format: JPEG today vs sized WebP — measured on the Mi TV

2026-10-10. Lab app `com.auroratv.lab` (9.9.9-lab, all-native: `impl=FCRHN`, `exp` off) on the
Mi TV MiTV-AFMU0 (Android 14, 1080p) against `http://192.168.50.108:4000` (1.6.82, `imgFmt:
["webp"]`). Profile "Claude QA", home trailers off. The plan and the PC bench are in
`ART-FORMAT-PLAN.md`; this is §4–§5 of it, run. Raw material: `art-format/` (logs, `.mem`,
`report.txt`, `shots.txt`, crops; the full screenshots are in the untracked `art-format/raw/`).

## Result

| | JPEG today | WebP (`artWebp`) | limit | verdict |
|---|---|---|---|---|
| hero blur 1 — bytes (median) | 128.0 KB | 47.5 KB (**−63 %**) | ≥ 50 % | pass |
| hero blur 1 — decode, median / p90 | 31 / 38 ms | 42 / 53 ms (**+12** / +15) | ≤ +15 / +30 ms | pass, close |
| hero blur 2 — bytes | 101.3 KB | 35.6 KB (**−65 %**) | ≥ 50 % | pass |
| hero blur 2 — decode, median / p90 | 22 / 29 ms | 28 / 43 ms (**+6** / +14) | ≤ +15 / +30 ms | pass |
| backdrop — bytes | 429.0 KB | 148.0 KB (**−66 %**) | ≥ 40 % | pass |
| backdrop — work to first draw (on-box re-encode + decode), median / p90 | 110 + 29 = 137 / 194 ms | 0 + 62 = 62 / 88 ms (**−75**) | ≤ +25 ms | pass |
| backdrop — request → bitmap, median | 359 ms | 179 ms | not higher | pass (see the caveat in §3) |
| picture | | | no visible difference | hero: none. Backdrop: none at 1:1; at 4× the WebP is slightly smoother (film grain) — §4 |
| title-page memory | | | ≤ +4 MB PSS | not resolved: the arms differ by −0.1 … +7 MB between passes, the runs of one arm by ±6 MB; the bitmap arithmetic says +1.1 MB — §5 |
| pacing (S5 janky %) | | | ≤ +1 point | not run (optional in the plan) |

Nothing fails a numeric limit. **The backdrop is the clear win** (a third of the bytes, less than
half the CPU work, because the 1920×1080 original no longer goes through Fresco's
`ResizeAndRotateProducer`). **The hero is a trade**: 63–65 % fewer bytes for +6…+12 ms of
decode per picture (≈ +10 ms of CPU on the blur-1 layer), inside the limit.

The plan's fallback (a lean 4:2:0 JPEG for the hero) is only called for when WebP fails the
decode limit; it does not. It also **cannot be tested without a server change** — the server
offers `fmt=webp` and nothing else — so it was not tried and `C:\elia\aurora` was not touched.

## 1. Method

Both arms are the same APK; the arm is the marker file `files/art-webp` (off = JPEG), the probe
is `files/art-probe`. Each launch logs `AuroraArt: flags webp=… probe=…` — checked in every log.
The markers are shell-writable on this Android 14 (`touch` works, no `setprop` fallback needed).

`tools/art-probe.sh <arm> -l <label>` per run: force-stop → cold start with the rotation running
(`freeze off`) → for each of the 8 heroes: blur-1 picture arrives → DOWN (first shelf: the
blur-2 picture is asked for) → UP, RIGHT → next rotation → then 8 title pages through the QA
receiver (`nav detail:tt…[:show]`, no key presses on the page) with `dumpsys meminfo` on each.
Six 1920×1080 originals and two 1280×720 ones.

Runs, in this order: `jpeg coldA`, `webp coldA`, `webp coldB`, `webp warm`, `jpeg coldB`,
`jpeg warm`. "cold" = the app's own image caches emptied at that launch (Fresco's `image_cache*`
and OkHttp's `http-cache`, 1–7 MB each time, by the app itself: marker `files/art-clear` —
the shell cannot reach `/data/data/<pkg>/cache`, and `pm clear` would sign the app out).
"warm" = the same pictures again from Fresco's disk cache (no network). The server's caches
were never cleared; by the time of the kept runs its WebP variants existed (see §3).

What the probe (`ui/art/ArtProbe.kt`, a Fresco `RequestListener`) logs per request:
`bytes` (the network fetcher's `image_size`; from the disk cache's `encodedImageSize` in the
warm pass), `decodeMs` (DecodeProducer start → finish, wall), `decodeCpuMs` (the decode
thread's own CPU time over the same span — added today, because wall time on this box swings
with whatever else runs), the `ResizeAndRotateProducer` stage (the on-box JPEG re-encode
`resizeMethod="resize"` asks for), `totalMs` (request start → bitmap, network included — the
wait the user sees before the fade-in starts).

Medians are over the two cold runs (16 pictures per kind and arm; 18 for WebP blur 2). Each
launch's first hero picture is left out of the timing medians — it decodes while the app is
starting (up to 175 ms of wall time for 22 ms of CPU, both arms) — its bytes count.
`node tools/art-probe-report.js docs/qa/native-bench/art-format [--images]` prints all of it
(`art-format/report.txt`).

## 2. Medians per arm

| kind | arm | cache | n | bitmap | KB | fetch ms | re-encode ms | decode ms | decode p90 | decode CPU ms | work ms | work p90 | total ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| hero-b1 | jpeg | cold | 16 | 1280×720 | 128.0 | 106 | 0 | 31 | 38 | 26.4 | 31 | 38 | 143 |
| hero-b1 | webp | cold | 16 | 1280×720 | 47.5 | 46 | 0 | 42 | 53 | 36.0 | 42 | 53 | 104 |
| hero-b1 | jpeg | warm disk | 8 | 1280×720 | 128.0 | – | 0 | 42 | 54 | 34.9 | 42 | 54 | 54 |
| hero-b1 | webp | warm disk | 8 | 1280×720 | 47.5 | – | 0 | 43 | 54 | 35.8 | 43 | 54 | 53 |
| hero-b2 | jpeg | cold | 16 | 1280×720 | 101.3 | 68 | 0 | 22 | 29 | 19.4 | 22 | 29 | 96 |
| hero-b2 | webp | cold | 18 | 1280×720 | 35.6 | 86 | 0 | 28 | 43 | 23.6 | 28 | 43 | 91 |
| hero-b2 | jpeg | warm disk | 8 | 1280×720 | 101.3 | – | 0 | 22 | 25 | 18.6 | 22 | 25 | 28 |
| hero-b2 | webp | warm disk | 9 | 1280×720 | 35.6 | – | 0 | 25 | 37 | 23.3 | 25 | 37 | 32 |
| backdrop | jpeg | cold | 16 | 1440×810 / 1280×720 | 429.0 | 185 | 110 | 29 | 53 | 24.9 | 137 | 194 | 359 |
| backdrop | webp | cold | 16 | 1600×900 / 1280×720 | 148.0 | 108 | 0 | 62 | 88 | 44.9 | 62 | 88 | 179 |
| backdrop | jpeg | warm disk | 8 | 1440×810 / 1280×720 | 429.0 | – | 121 | 31 | 51 | 24.9 | 161 | 174 | 174 |
| backdrop | webp | warm disk | 8 | 1600×900 / 1280×720 | 148.0 | – | 0 | 64 | 105 | 44.0 | 64 | 105 | 93 |

Reading it:

- **Hero.** A 1280×720 WebP costs the decoder about 10 ms more CPU than the 4:4:4 JPEG on the
  blur-1 layer (36 vs 26 ms) and 4 ms more on blur 2 (the more blurred picture is cheaper in
  both formats). The JPEG warm pass came out slower than its own cold passes (35 vs 26 ms CPU,
  the last run of the session) — the run-to-run spread on this box is as large as the effect,
  so "+12 ms" is an upper estimate, not a fine measurement. The bytes are exact: −63 % / −65 %.
  Request → bitmap is not worse (104 vs 143 ms, 91 vs 96 ms).
- **Backdrop.** Today a 1920×1080 original is fetched whole (228–971 KB), re-encoded on the
  box to 1440×810 (79–303 ms, median 110 over all sixteen, ~120 over the twelve that are
  re-encoded) and then decoded (19–54 ms). The WebP arrives at 1600×900, is decoded once
  (41–101 ms, 45 ms CPU) and that is all. Less work even though the WebP decode itself is
  twice the JPEG's. The disk cache keeps the ORIGINAL in the JPEG arm, so the re-encode is paid
  again on every later visit (warm: 174 ms to the bitmap, against 93 ms).
- The two 1280×720 originals are not re-encoded today, so there the WebP is the slower one to
  decode (+6…+14 ms) and saves less (41 % and 27 %); request → bitmap is still lower.

## 3. Per picture (cold runs, mean of the two)

| picture | title | JPEG KB | WebP KB | saved | JPEG bitmap | WebP bitmap | JPEG re-encode + decode = work ms | WebP work ms | decode CPU ms J / W | total ms J / W |
|---|---|---|---|---|---|---|---|---|---|---|
| hero-b1 | tt15677150 | 72.0 | 18.7 | 74% | 1280x720 | 1280x720 | 0 + 32 = 32 | 28 | 26 / 24 | 105 / 106 |
| hero-b1 | tt27714581 | 190.9 | 68.3 | 64% | 1280x720 | 1280x720 | 0 + 36 = 36 | 47 | 31 / 41 | 161 / 118 |
| hero-b1 | tt31510819 | 74.0 | 22.9 | 69% | 1280x720 | 1280x720 | 0 + 30 = 30 | 40 | 29 / 36 | 130 / 80 |
| hero-b1 | tt33100314 | 148.0 | 51.1 | 65% | 1280x720 | 1280x720 | 0 + 28 = 28 | 46 | 24 / 39 | 132 / 132 |
| hero-b1 | tt33204276 | 120.4 | 44.0 | 63% | 1280x720 | 1280x720 | 0 + 36 = 36 | 49 | 31 / 40 | 147 / 108 |
| hero-b1 | tt34809853 | 135.5 | 52.1 | 62% | 1280x720 | 1280x720 | 0 + 25 = 25 | 41 | 23 / 32 | 198 / 104 |
| hero-b1 | tt36981462 (first picture of the launch) | 74.5 | 18.4 | 75% | 1280x720 | 1280x720 | 0 + 144 = 144 | 86 | 22 / 22 | 318 / 238 |
| hero-b1 | tt9362722 | 169.7 | 53.8 | 68% | 1280x720 | 1280x720 | 0 + 31 = 31 | 44 | 29 / 38 | 153 / 99 |
| hero-b2 | tt15677150 | 53.9 | 15.2 | 72% | 1280x720 | 1280x720 | 0 + 18 = 18 | 22 | 16 / 20 | 65 / 218 |
| hero-b2 | tt27714581 | 145.7 | 52.8 | 64% | 1280x720 | 1280x720 | 0 + 25 = 25 | 31 | 22 / 27 | 145 / 216 |
| hero-b2 | tt31510819 | 61.3 | 19.6 | 68% | 1280x720 | 1280x720 | 0 + 23 = 23 | 22 | 18 / 20 | 78 / 55 |
| hero-b2 | tt33100314 | 121.8 | 41.2 | 66% | 1280x720 | 1280x720 | 0 + 22 = 22 | 28 | 20 / 25 | 186 / 147 |
| hero-b2 | tt33204276 | 91.6 | 31.8 | 65% | 1280x720 | 1280x720 | 0 + 19 = 19 | 30 | 18 / 24 | 86 / 162 |
| hero-b2 | tt34809853 | 111.1 | 39.5 | 64% | 1280x720 | 1280x720 | 0 + 28 = 28 | 35 | 22 / 25 | 180 / 110 |
| hero-b2 | tt36981462 | 61.8 | 15.8 | 74% | 1280x720 | 1280x720 | 0 + 20 = 20 | 24 | 18 / 20 | 74 / 58 |
| hero-b2 | tt9362722 | 133.5 | 41.6 | 69% | 1280x720 | 1280x720 | 0 + 25 = 25 | 29 | 23 / 24 | 269 / 264 |
| backdrop | tt0903747 Breaking Bad | 546.7 | 327.4 | 40% | 1440x810 | 1600x900 | 136 + 48 = 184 | 88 | 31 / 69 | 380 / 282 |
| backdrop | tt1375666 Inception | 679.4 | 209.4 | 69% | 1440x810 | 1600x900 | 110 + 28 = 138 | 77 | 26 / 57 | 334 / 232 |
| backdrop | tt15239678 Dune: Part Two | 971.3 | 133.0 | 86% | 1440x810 | 1600x900 | 110 + 26 = 136 | 67 | 24 / 48 | 922 / 252 |
| backdrop | tt22526100 The Love Hypothesis (1280×720 original) | 178.9 | 105.3 | 41% | 1280x720 | 1280x720 | 0 + 32 = 32 | 46 | 21 / 34 | 246 / 130 |
| backdrop | tt26657236 Backrooms | 311.3 | 46.1 | 85% | 1440x810 | 1600x900 | 130 + 19 = 148 | 51 | 17 / 35 | 288 / 98 |
| backdrop | tt2788316 Shogun | 646.7 | 198.3 | 69% | 1440x810 | 1600x900 | 230 + 45 = 275 | 78 | 26 / 56 | 464 / 202 |
| backdrop | tt31938062 The Pitt | 228.1 | 52.1 | 77% | 1440x810 | 1600x900 | 82 + 19 = 100 | 54 | 18 / 36 | 248 / 112 |
| backdrop | tt36583977 Forgotten Island (1280×720 original) | 221.7 | 162.9 | 27% | 1280x720 | 1280x720 | 0 + 47 = 47 | 53 | 45 / 41 | 688 / 170 |

Every run of every picture: `art-format/report.txt`.

**Caveats on `total ms` (request → bitmap).**

- The two arms fetch the backdrop from different places: the JPEG from `images.metahub.space`
  over the internet, the WebP from the server on the same LAN. With the real server on the far
  side of the internet (nufurora.com) the WebP's fetch will not be 108 ms; the bytes (a third)
  and the on-box work (less than half) carry over, the fetch times do not.
- These are a server with the variant already made. In the very first WebP run of the session
  (discarded: its hero walk was broken, §6) the server made each variant on request: hero
  fetches 233–340 ms instead of 27–114, backdrop fetches 185–485 ms (it downloads the original
  and encodes it) instead of 31–206 — a title's first visitor still got it in 270–585 ms total,
  against 242–948 ms for the direct JPEGs.

## 4. Screenshots

`tools/art-probe.sh <arm> -m shots`: `freeze on` (slide 0 pinned — tt36981462 in all six
launches), three launches per arm, interleaved. Home at rest, Home scrolled, two title pages
(Dune: Part Two, Breaking Bad). Counted with `tools/tv-pixel-diff/strict.py` (every pixel that
differs at all) by `tools/art-shots-diff.py` → `art-format/shots.txt`.

Noise floor (the same arm, launch A vs B and A vs C): **0 differing pixels** in every state,
both arms (one exception: `home-scrolled`, JPEG A vs C: 15 531 pixels by 1 level).

| state | differing pixels | > 1 level | > 8 | > 16 | largest | mean (levels of 255) | PSNR | worst 240×135 window |
|---|---|---|---|---|---|---|---|---|
| Home at rest (hero blur 1) | 1 094 159 (52.8 %) | 293 864 | 20 | 0 | 10 | 0.38 | 50.6 dB | mean 1.9, max 9 |
| Home half-scrolled (`freeze on,mid`: both hero layers blended) | 832 147 (40.1 %) | 209 614 | 4 | 0 | 9 | 0.27 | – | – |
| Home scrolled | 0 | 0 | 0 | 0 | 0 | 0 | – | the hero has left the screen in this state |
| title page 1 (Dune: Part Two) | 787 114 (38.0 %) | 421 906 | 21 627 | 1 380 | 41 | 0.53 | 45.1 dB | mean 5.5, max 41 |
| title page 2 (Breaking Bad) | 757 502 (36.5 %) | 435 038 | 32 215 | 2 920 | 44 | 0.76 | 42.8 dB | mean 6.5, max 44 |

All under the plan's "look closer" marks (mean > 2 levels, SSIM < 0.97).

- **Hero: no visible difference**, at 1:1 or 4×. Nothing differs by more than 10 levels on a
  blurred picture under a 0.45 scrim. Worst window, 4×, JPEG left / WebP right:
  `art-format/home-rest-worst.png`.
- **Backdrop: no difference I can see at 1:1** (`art-format/detail2-1to1-jpeg.png` /
  `-webp.png`, a 720×405 cut of the Breaking Bad page). **At 4× the WebP is slightly smoother**:
  the film grain and the cloth texture are a little softer (`art-format/detail2-worst.png`,
  `detail1-worst.png`). The two pictures are not the same pixels to begin with — the JPEG arm
  shows the original after the box's own 1440×810 re-encode, scaled up to the 1344 px box; the
  WebP arm shows the server's 1600×900 q84, scaled down — so some of the 44-level worst case is
  resampling, not codec. If the grain matters, the server's `w≥1600` quality is the knob.

## 5. Memory

`dumpsys meminfo com.auroratv.lab` on the title page, MB.

| pass | arm | PSS | Graphics |
|---|---|---|---|
| fresh launch → Dune page (3 launches each, median; all three) | jpeg | 324 (323, 335, 324) | 146 (146, 155, 145) |
| | webp | 330 (320, 332, 330) | 152 (144, 152, 154) |
| … → Breaking Bad page (the second page) | jpeg | 366 (366, 370, 360) | 166 (166, 168, 157) |
| | webp | 370 (370, 372, 354) | 166 (166, 171, 162) |
| after 8 heroes, mean over the 8 title pages, cold runs (2) | jpeg | 447.5 | 183.4 |
| | webp | 454.7 | 196.1 |
| the same, warm run (1) | jpeg | 448.4 | 187.3 |
| | webp | 448.3 | 187.7 |

The arms differ by −0.1 to +7 MB of PSS depending on the pass, and two launches of the SAME arm
differ by up to 12 MB (Graphics alone moved 176–206 MB inside one JPEG run). The 4 MB limit
cannot be decided at this spread. What is certain is the bitmap: 1600×900 ARGB = 5.76 MB
against 1440×810 = 4.67 MB, **+1.1 MB per 1080p-source backdrop** in the decoded cache, and
equal for 720p sources and for the hero (1280×720 both arms).

## 6. What had to be fixed to run it

`tools/art-probe.sh` (rewritten around what the box actually does):

- **Cache clearing did not work**: the shell cannot write `/data/data/<pkg>/cache`, and there
  is no external cache dir. Now a marker `files/art-clear`, read by the app at launch
  (`ArtProbe.clearIfAsked`: empties `image_cache*` and `http-cache`, removes the marker, logs
  `cleared files=… bytes=…`).
- **The key sequence would have started playback**: DOWN, CENTER lands on a Continue Watching
  card. Title pages are now opened with the QA receiver (`nav detail:tt…[:show]` — extended in
  `navigation.tsx` to open a catalogue title by its imdb id; it only knew library ids), and no
  CENTER is ever sent.
- **One fixed 75 s wait gave no blur-2 pictures** (the hero does not rotate while the focus is
  in the shelves, and blur 2 is only asked for on the way down). Now per hero: wait for its
  blur-1 `done` line, DOWN, wait for blur 2, UP — polling logcat instead of sleeping.
- **The rail opens by itself** now and then right after UP lands back on the hero (focus log:
  Stream gains focus, 40 ms later the rail's Home item gains it, no key in between; seen four
  times, each in the first 30 s after a cold-cache start). The first runs lost their hero
  walk to it. The script sends RIGHT after every UP, which closes the rail or moves to
  Details — DOWN reaches the shelf from both. **This is an app bug worth its own look**
  (1.6.80 / TV 5.1.30 fixed "the menu opens by itself at a cold start"; this is a second way in).
- `MSYS_NO_PATHCONV=1` (Git Bash rewrote `/sdcard/…`), the device serial, `-m shots`
  (frozen screenshots + memory), `-l label`.

`tools/art-probe-report.js`: the on-box re-encode was never added to `work` — the
`ResizeAndRotateProducer` line carries `Transcoder id=NativeJpegTranscoder` before the request's
own `id=`, and the parser took the first; bytes now also come from the disk cache's count in
a warm pass; the launch's first picture is kept out of the timing medians; `decodeCpuMs`, p90
of work, the backdrop's "total not higher" limit and the hero's p90 limit are applied;
`--images` prints every picture; warm logs are reported apart.

`ArtProbe.kt`: `clearIfAsked`, and `decodeCpuMs` (thread CPU time across the decode).
New: `tools/art-qa.sh` (one QA broadcast and its answer), `tools/art-shots-diff.py`.

## 7. Recommendation

- **Backdrop: ship it.** A third of the bytes, 62 ms of work instead of 137, no re-encode on
  every revisit, nothing visible at 1:1. Before the switch defaults to on: a look at the picture
  on a second TV if grain at 4× matters to anyone, and the first-visit cost on the real server
  (it has to fetch the original and encode — 185–485 ms here on the LAN machine).
- **Hero: ship it for the bytes, knowing the price** — about 10 ms more decode per picture, on
  a decode thread, for a picture that fades in over 260 ms every 9 s; 80 KB less per slide and
  layer. If the +10 ms is unwelcome, the lean 4:2:0 JPEG (60 KB, the fastest decode on the PC)
  is the arm to add — that needs a server option (`fmt=` has the place for it) and a run of this
  same script; it was not measurable today.
- Not done: the S5 pacing run (optional), a memory figure tighter than ±6 MB.

## 8. State the TV was left in

Art switches off (`flags webp=0 probe=0`, no marker files, debug props 0 / empty), `impl`
all-native (`FCRHN`), `exp` none, `freeze` off, `trace` / `focuslog` off, stay-awake on, the lab
app running on Home. The installed lab build is this commit's (it adds `art-clear`,
`decodeCpuMs` and the `nav detail:tt…` form; nothing else changed).
