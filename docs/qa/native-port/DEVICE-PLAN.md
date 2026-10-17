# Native port — the Mi TV pass (device plan)

Branch `tv-native-port` (from master 1.6.100 = TV 5.2.0). This port brings the native lab's measured
wins (`docs/qa/native-lab/1…7`) into the production TV app, **every one behind a switch that is OFF**.
Nothing in this branch has run on a TV yet. This file is what the agent that gets the Mi TV does, in
order, and what has to be true before any switch is turned on for anyone.

Device: Mi TV MiTV-AFMU0 (Android 14, 1920×1080 @ 320 dpi = 960×540 dp, 59.94 Hz), adb
`192.168.50.31:5555`, every adb call wrapped in `timeout`. After every install
`adb shell svc power stayon true` (never `false`). The Mi TV is a TEST TV: QA variant only, local
server first, never signed in to nufurora.com. Profile "Claude QA" only.

---

## 0. What the switches are

| key | kind | what it does | lab result (Mi TV) |
|---|---|---|---|
| `focusable` | component | focus ring + spring in AuroraFocusableView.kt | within noise alone; needed by `cardlayer`, `shadowcache` |
| `card` | component | a card's picture / shades / blur-up in AuroraCardView.kt | the largest single step (grid p90 36→30, PSS −18..−37 MB) |
| `row` | component | the shelf slide in AuroraRowView.kt (starts inside the focus change) | a few ms on Home p90 |
| `hero` | component | billboard art (AuroraHeroArtView) + Home's sliding column (AuroraSlideColumnView) | small |
| `rail` | component | the nav rail's drawing and slide (AuroraRailPanelView) | fixes the rail scenario |
| `cardlayer` | fix | a resting card = one hardware layer (with the props-reset fix: `syncLayer` compares the view's REAL layer type and runs after RN's `setLayerType(NONE)`) | RT work −28 %, the most impactful single fix |
| `cull` | fix | the shelf track / column skip children wholly off screen (+96 dp) | −16 % RT on S2 |
| `shadowcache` | fix | a box-shadow blurred once into a layered host | GPU caches 76→50 MB |
| `unstuff` | fix | holds one vsync when the pipeline runs a frame behind | S4 frames ≥2 refreshes late 44→4 % |
| `unstuffq` | fix | also for one queued buffer (latency trade) — **not in the preset** | S1 vsync→screen 46→31 ms |
| `pool` | fix | a shelf hands card views on (shelfPool.ts) instead of unmount/mount; needs `row` + `card` | lab: held key frames >32 ms 106→18 |
| `recommended` | preset | focusable, card, row, hero, rail, cardlayer, cull, shadowcache, unstuff, pool | lab "ccsu" + pool: janky S1 5.5→1.6 %, S2 10.1→3.5 %; p90 39→26 / 47→30 ms |

Not ported (the lab measured them and they lost or were never tried): the native grid (`G`),
`taglayer`, `gridfree`, `recycle`, `prepdraw`, the `x_…` attribution removals.

**Production differs from the lab, and these are the places the port had to adapt — check them first:**
1. The row window (rowWindow.ts) grows while a key is held and is cut back 700 ms after the remote
   rests; the lab's pool was built for a fixed 9-card window. The production pool (shelfPool.ts) keys
   slots by TITLE (so a Continue Watching re-read keeps every card in its slot), keeps the window
   exactly rowWindow.ts's, never moves the focused title, and keeps up to 3 cards that left the window
   mounted as spares (off screen, beyond the margins). Offline (row-native.test.tsx, a 40-card shelf held
   right and back): keyed 76 mounts / 68 unmounts, pooled 53 / 42. **Whether that is still a frame-time win
   under the production window is exactly what L1 below decides** — it may be neutral.
2. Home's column: production starts the page spring only for a NEW target (`slideTo` dedupe) and re-runs
   the slide when the column grows after the first commit (`settling`). The native column now does the
   same (`lastTarget`), and Home hands it its own target through a `slideTo` command on every toRow /
   toHero, which the view ignores when it is already heading there.
3. The hero look of 5.2.0 (dim 0.18 both states, text shadows, gold star / silver score) — the dims are
   props, the text is RN in both; the native art is gated off if `HERO_TRAILER_COVER` is ever turned on.
4. Card art comes from cardArt.ts (the prefetcher's address); a resume frame is drawn unresized
   (`sized = sizedPath || canFrame`), `uiId="card.open"`, `noPeek`, `firstPoster()` on load.
5. Native Focusable counts `uiId` presses like the JS one.

## 1. Build the QA variant (do NOT commit any of this)

```bash
cd /c/elia/aurora-native   # or the merged tree the orchestrator names
# a) the local server first in the candidates (memory: aurora-tv-qa-mitv recipe), marked QA VARIANT
# b) versionCode above the installed one (the Mi TV has vc97 at the time of writing) — local edit only
cd tv-native/android
./gradlew.bat assembleRelease -PqaReceiver=true -PqaToken=aurora-port-qa
timeout 120 adb -s 192.168.50.31:5555 install -r app/build/outputs/apk/release/app-release.apk
timeout 20 adb -s 192.168.50.31:5555 shell svc power stayon true
# then revert a) and b) and assert: grep -rn "QA VARIANT" tv-native/src  → 0 lines
```

Check the door works and is shut by default:

```bash
export AURORA_QA_TOKEN=aurora-port-qa ADB=/c/elia/android-tools/sdk/platform-tools/adb.exe
Q() { timeout 20 $ADB -s 192.168.50.31:5555 shell am broadcast -n com.auroratv/com.auroratv.ui.qa.QaReceiver \
      -a com.auroratv.QA --es token $AURORA_QA_TOKEN --es cmd "$1" --es arg "$2" --es rid $RANDOM >/dev/null;
      sleep 0.5; timeout 20 $ADB -s 192.168.50.31:5555 logcat -d -s AuroraQA:I | tail -1; }
Q ping ""            # → [qa] ping ok … impl=- exp=- src=build|saved
```
- **Release-build guard** (one time, on the PC): build WITHOUT `-PqaReceiver` and check
  `aapt2 dump xmltree --file AndroidManifest.xml app-release.apk | grep -A3 QaReceiver` shows
  `android:enabled=false` and `exported=false`; `apkanalyzer`/`unzip -p … classes*.dex | strings | grep QA_RECEIVER`
  is not needed — `BuildConfig.QA_RECEIVER=false` is a compile-time constant. Do not install that one.

## 2. Smoke, all switches on, by hand (real remote or tools/tv-bench/tv-keys-uinput.py)

`Q render recommended`, force-stop, launch. `Q ping` → `impl=FCRHN exp=cardlayer+cull+shadowcache+unstuff+pool src=qa`.
Logcat must stay free of `AndroidRuntime` / `ReactNativeJS` errors and of `[row] behind` / `[home] behind`.

| # | check | expected |
|---|---|---|
| 1 | cold start | hero lit on Play, rail shut; billboard art with the 5.2.0 look (gold ★, silver score, text shadow) |
| 2 | DOWN through every shelf, UP back | page slides to each shelf heading, art fades out by 0.9·heroH, back on the hero the art cross-fades back |
| 3 | hold RIGHT along the 4th shelf (24 cards) to the end, hold LEFT back | the shelf stays full while held (production row window), no title appears on the wrong card, no blank card at rest |
| 4 | shelf re-entry from above/below | lands on the last focused card, no slide |
| 5 | LEFT at card 0 / LEFT on Play / UP on the hero | rail opens; RIGHT / BACK close it onto the element that had focus; the rail never opens by itself after UP from shelf 1 (20 real presses) |
| 6 | Continue Watching: hold OK on a card → Remove | card leaves, toast, focus stays in the shelf; the remaining cards keep their pictures |
| 7 | OK on a card → Detail → BACK | Detail opens; back on the same card, page where it was |
| 8 | trailers ON in Settings for this profile, rest on the hero 5 s | the trailer fades in UNDER the scrims and the lockup; DOWN stops it; the rail over it stops it |
| 9 | Movies grid walk, Search, Settings, person sheet (X-Ray), My List, Downloads | unchanged (the grid stays JS; cards are native) |
| 10 | **closed mode** (server `authMode: closed` on a private instance, or the recipe in memory aurora-tv-image-headers) | every card and the billboard draw (the native views send `headersJson`) — no grey tiles |
| 11 | hidden developer setting: Settings → hold OK on "Aurora TV x.y.z" | "Rendering (developer)" appears; it says `Now: … (qa)` and "A QA override decides the next launch" |
| 12 | `Q render clear`, restart, Settings → dev panel: `recommended` → On, restart | `Q ping` → `src=saved`, impl FCRHN; set it back to Server, restart → `impl=-` |
| 13 | lite / low-RAM tier (`perf` event `low`, admin TV boxes) | unchanged by the switches (they are read independently) |

Any failure here stops the pass: file it with logcat and screencaps, do not bench.

## 3. Pixels — every native component against its JS twin, same build

Harness: `tools/tv-bench/tv-pixel-diff/` (rules unchanged from the lab: pixelmatch YIQ 0.1, any off-edge
pixel fails, on-edge ≤ 0.05 %; trace rule ±25 ms / same rest / settle within 50 ms). Profile Claude QA,
billboard trailers OFF in its Settings, `freeze on` is set by run.py itself.

```bash
cd tools/tv-bench/tv-pixel-diff
P="python run.py --serial 192.168.50.31:5555 --pkg com.auroratv --token $AURORA_QA_TOKEN"
# 3a. components, all JS (A) vs all five native (B), no fixes — 117 states
$P --impl FCRHN --states focusable,card,row,hero,navrail,browse --runs 1 --out ../../../docs/qa/native-port/pixels/3a
$P --impl FCRHN --states states/app.json --runs 1 --out ../../../docs/qa/native-port/pixels/3a-app
# 3b. the render fixes, both sides all native, A no fix, B recommended minus pool — 11 rest states
$P --impl FCRHN --states states/render.json --exp cardlayer=1,cull=1,shadowcache=1,unstuff=1 --out ../../../docs/qa/native-port/pixels/3b
python strict.py ../../../docs/qa/native-port/pixels/3b
# 3c. the pool, A = recommended minus pool, B = recommended — the 22 row states + render
$P --impl FCRHN --states row,states/render.json --exp-a cardlayer=1,cull=1,shadowcache=1,unstuff=1 \
   --exp cardlayer=1,cull=1,shadowcache=1,unstuff=1,pool=1 --runs 2 --out ../../../docs/qa/native-port/pixels/3c
python strict.py ../../../docs/qa/native-port/pixels/3c
# 3d. the noise floor: the same config both sides (recommended vs recommended), 8 render states x 3
$P --impl FCRHN --states states/render.json --exp-a cardlayer=1,cull=1,shadowcache=1,unstuff=1,pool=1 \
   --exp cardlayer=1,cull=1,shadowcache=1,unstuff=1,pool=1 --runs 3 --out ../../../docs/qa/native-port/pixels/3d-null
python strict.py ../../../docs/qa/native-port/pixels/3d-null
Q render clear
```

**Pass (all of):**
- 3a: every state both implementations reach deterministically at **0 differing px** (run.py PASS). The
  lab's known non-native failures may repeat and are retaken ×3, not waived: `hero/down-burst-4`,
  `app/home-down-hold-8` (the JS clamp on DOWN bursts), `app/movies-grid-hold` (grid burst, js-vs-js too),
  `app/rail-to-settings` (Settings' first-focus race), the 8 `navrail/*` trace-only fails with 0 px. A state is
  accepted only if it passes in ≥ 2 of 3 retakes, or fails js-vs-js the same way (`--impl -` both sides).
- 3b/3c: run.py PASS on all states; `strict.py`: **no pixel more than 8/255 off, max ≤ 7/255**, and the
  count of pixels off by > 1/255 within the 3d noise floor's range (lab: ≤ 994 px per screen).
- 3c specifically: `pool-wrap-shadow` 0 px (the cardlayer props-reset fix), the four `pool-*` states pass.
- Retake rule for harness errors (adb "closed", nav timeout): re-run that state alone; not a fail.

## 4. Frames — interleaved, cold start per run

Never two benches at once (the scripts refuse to start beside one; also `ps -ef | grep -E "tv-bench|run.py"`
must be empty — orphaned key senders ruined the lab's first round). Trailers OFF, no other app, the TV idle
5 min before. **4 rounds**, every configuration once per round, in the same order (thermal and server drift
hit all alike).

```bash
cd /c/elia/aurora-native
# 4a. the headline: today's app (all JS) against the native set with and without the fixes
IMPL=all=js,focusable=native,card=native,row=native,hero=native,rail=native KEEP=1 \
tools/tv-bench/tv-present-bench.sh docs/qa/native-port/bench/present 4 \
  js=none@all=js  nat=none  ccsu=cardlayer=1,cull=1,shadowcache=1,unstuff=1  rec=cardlayer=1,cull=1,shadowcache=1,unstuff=1,pool=1
# 4b. the shelf pool where it can act: real held keys along the 24-card shelf, and the grid
SCENARIOS="L1 S1 G1" tools/tv-bench/tv-pool-bench.sh docs/qa/native-port/bench/pool 4 \
  js=none@all=js  ccsu=cardlayer=1,cull=1,shadowcache=1,unstuff=1  rec=cardlayer=1,cull=1,shadowcache=1,unstuff=1,pool=1
# 4c. under load (the weak-box case): three of four cores busy, 3 rounds of 4a's js and rec
timeout 20 $ADB -s 192.168.50.31:5555 shell "for i in 1 2 3; do nohup timeout 3000 sh -c 'while :; do :; done' >/dev/null 2>&1 & done"
SCENARIOS="S1 S2 S4" tools/tv-bench/tv-present-bench.sh docs/qa/native-port/bench/load3 3 js=none@all=js rec=cardlayer=1,cull=1,shadowcache=1,unstuff=1,pool=1
timeout 20 $ADB -s 192.168.50.31:5555 shell "pkill -f 'while :'"
Q render clear
python tools/tv-bench/present-report.py docs/qa/native-port/bench/present/js.jsonl 'docs/qa/native-port/bench/present/*.jsonl' > docs/qa/native-port/bench/present/table.md
python tools/tv-bench/pool-report.py docs/qa/native-port/bench/pool js ccsu rec > docs/qa/native-port/bench/pool/table.md
python tools/tv-bench/present-report.py docs/qa/native-port/bench/load3/js.jsonl 'docs/qa/native-port/bench/load3/*.jsonl' > docs/qa/native-port/bench/load3/table.md
```

Scenarios (tv-bench.sh / tv-present-bench.sh / tv-pool-bench.sh): S1 hold along a Home row (DOWN, RIGHT ×20
@50 ms, LEFT ×20), S2 step DOWN ×8 / UP ×8 @400 ms through the rows, S3 Movies grid (DOWN ×12 @300 ms,
RIGHT ×5), S4 open/close the rail ×5, L1 the 4th shelf held RIGHT to the end and LEFT back ×2 (uinput real
holds), G1 the Movies grid DOWN/UP held ×2. Metrics per run: presented fps while moving, refreshes without a
new frame /1000, vsync→screen p50/p90, gfx p50/p90/p99, janky %, frames > 32 / > 64 ms, RT CPU ms/frame,
PSS, held vsyncs (`unstuff` skips, logcat tag AuroraRender).

**Pass (medians of the rounds; "not worse" allows the lab's measured run-to-run spread):**
- In **every** scenario of 4a and 4b, `rec` against `js`: janky % not higher by more than 0.3 pt, and gfx
  p90 not higher by more than 1 ms. Same for `ccsu` against `js`.
- **Home scrolling better** — S1 and S2 (and L1): `rec` janky % AND p90 lower than `js` in at least 3 of 4
  rounds, and the medians lower. The lab's figures to compare with: S1 5.5→1.6 %, 39→26 ms; S2 10.1→3.5 %,
  47→30 ms.
- No new long frames: 4b frames > 64 ms (sum over rounds) for `rec` ≤ `js`; the longest frame not above `js`'s
  by more than one vsync (17 ms).
- PSS not higher than `js` by more than 20 MB (the lab: cold-start PSS varies ±20 MB; the set was −40..−110).
- `pool` earns its place only if L1 (`rec` vs `ccsu`) shows frames > 32 ms lower in ≥ 3 of 4 rounds and p99
  not worse by 1 ms, with S1/G1 not worse. Otherwise it stays OFF in the shipped preset (the device agent then
  removes it from `RECOMMENDED` in renderRules.ts and AuroraRender.kt, in one commit, with the data).
- 4c is reported, not gated (the lab: under load the gap widens in native's favour).
- `unstuffq` is not benched as a candidate; if wanted, a separate `ccsq` column in 4a and an eye on the TV.

## 5. Turning it on (after 2–4 pass)

Order: the Mi TV first, one model at a time, through the server — no new APK.

1. **Per TV model, from the server** — config.json on the server the TV uses (the orchestrator / elia edits
   it; agents never edit production config.json), then restart the server:
   ```json
   "tvRender": { "models": { "MiTV-AFMU0": { "recommended": true } } }
   ```
   The TV reads it with `GET /api/tv/tuning?model=<Build.MODEL>` a few seconds after Home (prefetch.ts →
   tuning.ts → render.ts) and applies it at its NEXT launch. Turn one switch off for everyone:
   `"tvRender": { "pool": false, "models": { … } }` — a model's own keys win key by key. Remove the section
   and every TV goes back to all-JS at its next launch.
2. **On one box, by hand** — Settings → hold OK on the "Aurora TV x.y.z" row → "Rendering (developer)":
   each switch cycles Server → On → Off (On/Off beat the server on this box), then reopen Aurora.
3. **QA variant only** — `Q render recommended` / `Q impl …` / `Q exp …` (exact set, beats both), `Q render clear`.
4. Build default (test builds only): `-PrenderDefaults=recommended`.

Read the field afterwards: the admin page's "TV frames" table splits by `impl` (FCRHN vs -); the `perf`
event also carries `exp` (fix letters: l c s u q p) and `v` (versionCode).

**Other TVs:** the layer fixes assume the canvas is drawn 1:1 (960 dp at density 2, as on the Mi TV). On a
panel where `src/canvas.tsx` scales the canvas, a hardware layer is drawn at the logical size and stretched
(soft text in a resting card) — never turn `cardlayer`/`shadowcache` on for a model before a screencap of a
resting shelf on that model. `unstuff`'s thresholds were chosen on this TV's timings.

## 6. Offline evidence already in this branch

- `npx jest -c jest.logic.config.js` (tv-native): render-rules (switch grammar, precedence, the TS / Kotlin /
  server key lists agree, the native column's targets = toRow's), render-glue (constants, storing once,
  QA override), shelf-pool (slot rules over real rowWindow walks), row-native (native track gets the
  geometry, JS starts no slide, same cards on show, fewer mounts, reorder keeps slots), plus every existing
  test with the switches off.
- `./gradlew.bat assembleRelease testReleaseUnitTest` (AnimMath, CardImageLadder, HomeMath, PoolMath,
  RailMath, RowMath fixtures from the lab; AuroraRenderTest).
- Root `npm test`: tvtuning (sanitize, per-model renderFor, the answer) and tvtuning-server (a private server
  instance answering `/api/tv/tuning?model=` from its config).

What none of that proves: any pixel, any frame, focus behaviour on the device, closed-mode pictures through the
native views, the trailer under the native art, and the pool under production's row window. That is sections 2–4.
