# Verification — the method that proves 1:1

Three kinds of evidence, each for the thing it can actually prove:

| claim | evidence | why not the other kinds |
|---|---|---|
| it **looks** the same at rest | pixel diff of `adb screencap` pairs (JS vs native, same build, same fixture, same device) | screencap is not frame-exact, so it cannot judge mid-animation frames |
| it **moves** the same | per-frame value traces (`[anim]` log lines) compared numerically, plus `screenrecord` A/B for eyes | screenshots sample the compositor asynchronously |
| it **behaves** the same | the key-path table (`[focus]` log) and event timings from logcat | pixels do not show where focus *would* go next |
| it is **faster** | `dumpsys gfxinfo` histograms, PSS, and the app's own `perf` events in admin | |

Everything runs on the Mi TV (elia: real device only; no sandbox for TV checks).
The device at `192.168.50.31:5555` is **shared** — the harness must take a
lock file (`tools/tv-pixel-diff/.device.lock` with the PID and start time) and
refuse to run while another session holds it.

## 1. Same build, same data, same box

- **One APK** carries both implementations (`01 §4 AuroraImpl`). The harness
  flips the switch with a broadcast and restarts the app; it never installs a
  different build between the A and B captures.
- **One server**: a private instance from `scripts/ui-test-server.js` (a copy
  of the working tree with its own `config.json`, a tiny ffmpeg-built library,
  a made-up admin password, every outbound connection refused by
  `test/ui/support/server-preload.js`). It listens on all interfaces
  (`server.listen(config.PORT)`), so the TV reaches it at
  `http://<PC LAN IP>:<port>`; the harness passes `--port 4100` so the address
  is stable. The TV build points at it via the QA-variant recipe already used
  for every TV QA round: `sed -i '/^export const SERVER_CANDIDATES = \[/a\  "http://<PC ip>:4100",' tv-native/src/api.ts`
  (and the bundle check `grep -ac 192.168.50 …` before any release build).
  Alternative without touching `api.ts`: `adb reverse tcp:4100 tcp:4100` and a
  permanent `http://127.0.0.1:4100` candidate guarded by `BuildConfig.QA`.
- **One profile**: the harness creates "Claude QA" (`POST /api/profiles` with
  `realName`, admin-approve, set a password) on the private instance, signs in
  on the TV (`adb shell input text <pw>` + `KEYCODE_ENTER` — only after a
  screenshot confirms the prompt names the QA profile), deletes it at the end.
- **Box state pinned** before every run and restored after:
  `settings put global animator_duration_scale 1.0` (and `transition_`/
  `window_animation_scale` 1.0), `settings put system font_scale 1.0`,
  `wm density reset`, `wm size reset`, display mode 1080p60 (`dumpsys
  SurfaceFlinger | grep -i "active mode"` recorded), `svc power stayon true`
  (and **left on** — elia's rule), screensaver off (`settings put secure
  screensaver_enabled 0`), locale `en-US` and time zone recorded (dates in
  cards use `toLocaleDateString`), HDR/tone-mapping irrelevant for UI but
  recorded. Any difference between the A and B capture environments voids the
  pair.

## 2. App-side hooks (QA only, compiled in every build, inert until asked)

`com.auroratv.ui.qa.QaReceiver`, a `BroadcastReceiver` registered in the
manifest with `android:exported="false"` is not reachable from adb; so it is
`exported="true"` **but** guarded: it acts only when `Settings.Global.adb_enabled
== 1` **and** the intent carries `--es token <sha256 of the debug keystore
fingerprint>`; a release on a user's TV with adb off ignores it. Commands
(`adb shell am broadcast -a com.auroratv.QA --es token … --es cmd <cmd> …`):

| cmd | effect |
|---|---|
| `impl focusable=native,card=js` | writes `aurora_impl` prefs (`01 §4`); takes effect on next launch |
| `freeze on\|off` | `AuroraQa.frozen = true`: hero rotation timer skips, trailers never start (as if `heroTrailers=false`), Skeleton/MiniSpinner/RailHues loops hold at phase 0.37 (a fixed, mid-way value so the gradient is visible but still), `atTop`/`swap` timings run normally. Also emitted to JS as device event `AuroraQa {frozen}` which `Home.tsx` and the loops read through a tiny `qa.ts` (`isFrozen()`), gated so a release without the broadcast never sees it |
| `trace on\|off` | `[anim]` lines from both RN's native drivers (via a `NativeAnimatedNodesManager` listener is not public — instead the JS wrapper attaches `Animated.Value.addListener` **only when tracing**, which forces a JS round-trip per frame and is therefore never on during perf runs) and from `AuroraClock` (native, free). Also `[focus]` lines (§5) |
| `focuslog on\|off` | `[focus] <uptimeMs> gain tag=<nativeId or reactTag> impl=js\|native edgeL=… edgeR=…` on every focus change, from `ReactViewGroup`-level hook in both implementations |
| `framestats` | logs `DeviceModule`'s per-screen JankStats snapshot as one JSON line `[frames] {...}` (same numbers the `perf` event carries) and resets |
| `layout <nativeId>` | logs the on-screen px rect of the view with that `nativeId` (`getLocationOnScreen` + size) — the harness crops with it |
| `nav home\|browse:movie\|detail:<id>\|…` | uses the existing `aurora://open?a=…` deep link (`HomeScreenRows.kt`) or a `rootNav` navigate so every run starts from a known route |

All hooks log under tag `AuroraQa`; the harness reads `adb logcat -s AuroraQa:V`.

## 3. Deterministic fixtures

### 3.1 Library and rows

`ui-test-server` builds `media/movies` and `media/shows` with ffmpeg (60 s
films, 45 s episodes, made-up IMDb ids filed in `data/imdb-map.json`). For
the pixel suite it also seeds, through the public API as the QA profile:

- progress on two films (positions 300 s / 1 500 s of a 3 600 s "duration" —
  the server's `progress` object drives `pct`, `"N min left"`, the frame
  still `/img/frame/<id>?t=<pos>`) and on one episode (→ an episode card with
  `showTitle` + `S1 E2 · title`, and an **up next** entry);
- `addedAt` within the last 7 days on three titles (NEW badge) and older on
  the rest — the fixture writes `addedAt` relative to the seed time;
- My List with four titles; one follow;
- a kids profile is **not** seeded (kids changes the gate, not the components).

The result is a `/api/home` with: a hero of ≥ 2 picks (rotation exists but is
frozen), `continue` (frame cards, one episode, one up-next), `recent`
(NEW), mixed rows with `showKind` (film + series), and enough items for Row's
window to matter (≥ 12 per row; the fixture pads with duplicate-free titles —
the generator writes 16 films and 3 shows × 2 seasons × 5 episodes).

### 3.2 Artwork

The instance is offline, so TMDB/metahub art never arrives and every card
would show the title tile. The suite needs real pictures, deterministic across
runs:

- A **fixture art pack** under `test/ui/fixtures/art/` (committed, small):
  16 posters 2:3 and 4 backdrops 16:9, generated once by a script (PIL,
  gradient + large numerals + a fine checker so blur-up and `cover` cropping
  are visible), WebP, ~20 KB each.
- The pack is served by the instance under the **same routes** the cards ask
  for (`/img/<id>?w=…`, `/img/ext?u=…&w=…`): `ui-test-server` gets a
  `--fixture-art <dir>` option that pre-populates the server's variant cache
  (`src/lib/imgvariant.js`'s cache directory) and the library covers
  (`data/…` covers for the scanned ids — the exact seam is for the harness
  author to find; **open question 1 in `03-inventory.md`**). Blur-up
  placeholders (`src/lib/blurup.js`) are then produced by the server itself
  from the same files, so `_blur` is deterministic too.

### 3.3 Time-varying content and how it is frozen

| source of change | frozen by |
|---|---|
| hero rotation (9 s) and the 15 s hold | `freeze on` |
| billboard trailer (4.5 s after a pick holds) | `freeze on` (no trailer starts); for the trailer *layer* tests, a fixture Apple-style HLS of a static colour frame served by the instance (`/fixture/trailer.m3u8`) and `TrailerFrame` paused at t=0 |
| blur-up (placeholder until `onLoad`) | capture only after the picture has loaded (§4.1 idle rule); the **mid-load** state is captured with the server throttled (`--art-delay 600000` holds `/img` responses) so the placeholder is the steady state |
| Skeleton shimmer, MiniSpinner, RailHues | `freeze on` holds phase 0.37 |
| focus animations (160 ms / spring ≈ 320 ms) | wait ≥ 600 ms after the last key before a rest capture |
| rail slide / filter panel (280 ms) | wait ≥ 400 ms |
| screen fade (260 ms, react-native-screens) | wait ≥ 500 ms after a route change |
| `NEW` (7-day window), `"N min left"`, air dates | fixture-relative seeding; locale pinned |
| clock in the player, buffering spinner | player is out of scope for A; captured only as "chrome at t=0 paused" if ever |
| toasts, update sheet, "Press again" arm (4 s) | the private instance publishes **no** APK (`public/aurora-tv.apk` absent → `checkForUpdate` finds nothing); profile switch is not in any pixel state |
| the Continue Watching frame still (`/img/frame`) | ffmpeg output for the same file + `t` is deterministic |
| ambient canvas (`ambient.png`) | static |

### 3.4 Text (for the phase that ports it)

Before any component draws its own text natively (P3 full, or B), run the text
procedure once per type style in the app: a QA screen (`qa:text`, reachable
by the `nav` hook) lays out the same strings with the RN `Text` and with the
native `StaticLayout` helper side by side in the exact styles used
(`theme.fontSize` 30/24/18/15/13 and the card's 17/14/13/11, weights
600/700/800/900, `letterSpacing` 0.16/0.4/1.2/1.68/−0.2, `lineHeight` 20/22/19,
`numberOfLines 1` + tail ellipsis, `textShadow` 0/1/6 and 0/1/10). Each pair
is cropped and diffed with **zero** tolerance; a single differing pixel fails
that style and the component keeps RN `Text` for it. Known traps to check
explicitly: `includeFontPadding` (RN default **true**), weight → `Typeface`
mapping on API < 28 (`nearestStyle` NORMAL/BOLD) vs ≥ 28
(`Typeface.create(tf, weight, italic)`), `setUseLineSpacingFromFallbacks(true)`
(API 28+), break strategy / hyphenation defaults, the ellipsis glyph.

## 4. The screencap harness — `tools/tv-pixel-diff/` (design; not written)

Node (the repo already runs node ≥ 22 and `playwright-core` for web tests; no
new runtime). Files:

```
tools/tv-pixel-diff/
  diff.js            CLI entry: run a suite → report
  lib/adb.js         exec/shell/screencap/logcat tail, the device lock
  lib/app.js         QaReceiver commands, restart (am force-stop + am start -n com.auroratv/.MainActivity), wait-for-idle
  lib/server.js      start/stop the private instance (wraps scripts/ui-test-server.js start()), seed the fixture (§3.1)
  lib/states.js      the state DSL loader
  lib/compare.js     pixelmatch + masks + edge dilation + report
  lib/trace.js       [anim] / [focus] parsing and comparison
  suites/*.json      one per component (focusable.json, card.json, row.json, hero.json, rail.json)
  README.md
```

### 4.1 A suite

```json
{
  "component": "card",
  "switch": "card",
  "start": {"nav": "home", "freeze": true},
  "crop": {"nativeId": "qa-row-continue"},
  "idle": {"quietMs": 600, "gfxFramesStable": 3},
  "tolerance": {"threshold": 0.1, "maxDiffFraction": 0.0005, "edgeDilate": 1},
  "states": [
    {"name": "rest",            "keys": []},
    {"name": "focused-0",       "keys": ["DPAD_DOWN"], "settleMs": 700},
    {"name": "focused-3",       "keys": ["DPAD_RIGHT","DPAD_RIGHT","DPAD_RIGHT"], "settleMs": 700},
    {"name": "hold-right-12",   "keys": ["DPAD_RIGHT*12@50ms"], "settleMs": 900, "trace": ["row.tx", "focus.ring", "focus.spring"]},
    {"name": "blur-up",         "server": {"artDelay": 600000}, "restart": true, "keys": ["DPAD_DOWN"], "settleMs": 700, "mask": ["qa-card-label"]}
  ]
}
```

Per state the runner: (1) restarts the app with `impl <component>=js`, runs
`start` + `keys`, waits for idle, `screencap -p` → `A.png`, reads
`layout <nativeId>` → crop rect; (2) the same with `=native` → `B.png`; (3)
compares. `keys` uses `adb shell input keyevent`; a hold is `KEY*N@ms`
(N presses `ms` apart — Android's own auto-repeat cannot be produced by
`input keyevent`, so the hold is approximated at 50 ms, the measured repeat
interval). **Idle** = no `[anim]` line for `quietMs` **and** the
`dumpsys gfxinfo com.auroratv` total frame count unchanged across
`gfxFramesStable` polls 100 ms apart (RN keeps drawing while anything
animates; a still app draws no frames — idle is 0 frames, measured).

### 4.2 Comparison rules

- `pixelmatch(A, B, {threshold: 0.1, includeAA: false})` over the crop; AA
  detection off because we apply our own edge rule.
- **Edge mask**: Sobel on A at > 40/255, dilated by `edgeDilate` px. Differing
  pixels **inside** the mask count toward `maxDiffFraction` (default 0.05 %);
  any differing pixel **outside** the mask fails the state outright (a flat
  area that differs is a colour, alpha or shift error, never anti-aliasing).
- **Gradient dithering**: Android dithers large gradients (the hero scrim,
  the baked shades are PNGs so no dithering; `experimental_backgroundImage`
  surfaces may dither). For regions declared `"dither": true` in the suite a
  per-channel tolerance of 2/255 is allowed outside edges. Used sparingly and
  listed in the report.
- **Masks** (`mask: [nativeId…]`) blank out regions that cannot be frozen; the
  report lists every mask so a reviewer sees what was not compared.
- Output per state: `A.png`, `B.png`, `diff.png` (pixelmatch's red overlay),
  a triptych, and `result.json` {diffPixels, fraction, outsideEdge, masks}.
  Suite output: `docs/qa/native-diff/<yyyy-mm-dd>/<component>/index.html` with
  the triptychs and the pass/fail table; exit code 1 on any failure.

### 4.3 Motion traces

`[anim] <frameTimeNanos> <id> <value>` lines, one per driver step, `id` from
`nativeId` + property (`row.tx`, `focus.ring`, `focus.spring`, `hero.atTop`,
`rail.slide`). For a traced state the harness collects both runs' lines,
aligns on the first step after the triggering key's `[key]` line (the
receiver logs the `input keyevent` arrival), and asserts per aligned frame
`|vA − vB| ≤ 1e-3 × range` and total step count within ±1. Retarget states
(the hold) additionally compare the **final** rest frame time within 16.7 ms.
JS-side traces cost a bridge hop per frame, so traced states are never used
for perf numbers (§6) — only for equality.

A `screenrecord` of each state (`adb shell screenrecord --time-limit 4
--bit-rate 8000000`) for A and B is saved beside the PNGs; the report shows
them side by side for the human pass (acceptance rule 6).

## 5. Behaviour checklist per component

Captured from `[focus]` lines (focus target after each key) and `[key]`/`[anim]`
timestamps. The runner produces a table per component and diffs A vs B as
text; any row differing fails.

**Focusable** (on Card, Btn primary/secondary, Chip, NavItem, source row):
gain/loss emits once; one lit ring at any time after `RIGHT, RIGHT, LEFT`
(count `[ring]` claims vs releases); `edgeLeft` reported true only on the
row's first card; `holdLeft` keeps focus (LEFT from Detail's Play → still
Play, then the rail opens); `preferredFocus` claims once and never yanks back
after a prop re-apply (force a re-render by `nav` away and back);
`focusDisabled` views are skipped by `FocusFinder`; long-press OK opens the
peek sheet without changing the lit ring; ring timing: lit at +160 ms (±1
frame), spring rest ≤ 330 ms.

**Row**: focus on card 0 → `tx = 0`; card k → `tx = −max(0,(k−1)·step)`; LEFT at
card 0 → no `[focus]` line (trap) and the rail opens on the *next* LEFT (not
this one — `focusJustMoved`); RIGHT at the last card → no move; UP/DOWN leave
the row to the neighbouring row's card nearest in x (FocusFinder) — record
which; window `[from,to)` after a 12-press hold identical; no card unmount of
the focused card across the hold; `onItemFocus` count = presses.

**Card**: `onPress` → Detail route in `[route]`; long-press → peek; image
error path: `--art-fail 1` serves a 404 once → `retryUri` at +1.5 s, backup at
once, tile after; `welcome` un-parks (restart the instance's socket).

**Hero/Column**: focus down to row 0 → `atTop → 0` over 280 ms and `ty` to
`−(rowY[0] − 27)`; back up → `atTop → 1`, `ty → 0`; artFade = f(ty) per frame
(trace); the scrolled layer mounts only after focus leaves the hero;
rotation frozen; RIGHT on the last hero button turns the slide (`swap` 280 ms).

**NavRail**: LEFT at the edge opens (strip alpha 1→0, panel −288→0 over 280
ms); focus lands on the active section; UP at item 0 wraps to the profile pill
**unless** the press moved focus (`focusJustMoved`); RIGHT closes and focus
returns to the captured element; BACK closes; a press on an item navigates and
the rail closes instantly (no slide); hues frozen.

## 6. Performance measurements

### 6.1 Scenarios (scripted, no tracing on)

| id | script | metric window |
|---|---|---|
| S1 home-hold | from hero: DOWN, then `DPAD_RIGHT*20@50ms`, 1 s, `DPAD_LEFT*20@50ms` | `gfxinfo reset` before, read after |
| S2 home-rows | `DPAD_DOWN*8@400ms`, `DPAD_UP*8@400ms` | same |
| S3 browse-grid | `nav browse:movie`, `DPAD_DOWN*12@300ms`, `DPAD_RIGHT*5@50ms` | same |
| S4 rail | `DPAD_LEFT` (open) ×5 with RIGHT between, 600 ms apart | same |
| S5 idle | 30 s on Home, frozen off (rotation on) | frames drawn (expect 0 between rotations) |

### 6.2 Commands and fields

- `adb shell dumpsys gfxinfo com.auroratv reset`, run, `adb shell dumpsys
  gfxinfo com.auroratv framestats` → parse `Total frames rendered`, `Janky
  frames (%)`, `50th/90th/95th/99th percentile`, the `HISTOGRAM` line, and
  the per-frame `FRAME_STATS` table (`INTENDED_VSYNC … FRAME_COMPLETED`;
  per-frame duration = `FRAME_COMPLETED − INTENDED_VSYNC`; input latency =
  `HANDLE_INPUT_START − INTENDED_VSYNC`). The 50 ms key cadence gives ~1 200
  frames per S1 — enough for p99.
- `adb shell dumpsys meminfo com.auroratv` → `TOTAL PSS`, `Graphics`, `Native
  Heap`, `Dalvik Heap`, `Views`/`ViewRootImpl` counts (the `Objects` block —
  the view-count target of `01 §9` is read here).
- `framestats` hook → the app's JankStats numbers per screen (what the field
  `perf` events carry), so lab and field use one definition (JankStats' jank =
  frame > deadline; the whole frame incl. GPU on API 31+).
- Three runs per scenario per implementation, same session, interleaved
  (J N J N J N) to cancel thermal drift; report medians and the spread.
- CPU: `adb shell top -n 1 -b | grep auroratv` before/after (sanity only).

### 6.3 The admin aggregation (P0 — does not exist yet)

`src/lib/usage.js apply()` gets a `perf` branch; the event shapes come from
`perfTier.ts`:

```
screen event: {screen, p50, p90, jank, frames, low, lite, v, impl}       (v, impl are new)
device event: {screen:'device', mem_mb, heap_mb, lowram, sdk, model, gpu, low}
trim event:   {screen:'trim', level}
```

Aggregate (bounded like everything else in the file — reservoir `SAMPLE`
400 per key):

```js
agg.perf = {
  screens: {},   // `${screen}|${v}|${impl}` -> { n, frames, p50: [], p90: [], jank: [], low: 0, lite: 0 }
  devices: {},   // model -> { n, sdk: {}, mem_mb, heap_mb, gpu, lowram: 0, low: {no, android, mem, heap, frames, trim} }
  trims: {},     // level -> n
};
```

Rules: `screen` ∈ `[a-z]{1,24}`; `p50/p90` sampled only when `0 < x < 1000`;
`jank` when `0 ≤ x ≤ 100`; weight by `frames` when forming medians is **not**
done (keep it simple; show `n` and `frames` beside). `summary().perf` returns
`screens` as rows `{screen, v, impl, n, frames, p50: pct(50), p90: pct(50 of p90 samples), p90hi: pct(90 of p90), jank: pct(50)}`
sorted by `frames`, `devices` as rows sorted by `n`. `text()` adds:

```
TV frames (per screen, median of sessions · p90 of p90s · jank%)
  home   v92 -    412 sess · 29 / 41 ms · 3.4%   low 18%  lite 4%
  home   v93 F    120 sess · 24 / 33 ms · 1.1%
  browse …
TV boxes
  MiTV-AFMU0     sdk34  2048MB heap256  Mali-G31  low: frames 12, mem 0 …
```

`public/admin.html` (usage tab, next to `#usage-routes`): a "TV frames" table
with those rows and a "TV boxes" table; the existing Copy button already
copies `text()`. A `before/after` read is then one glance: same screen, two
`v`/`impl` rows.

Field acceptance (rule 5 of `00 §4`): for the component's screen, the `impl`
row with the native letter has `p90` and `jank` ≤ the JS row's over ≥ 50
sessions and no new `error` events naming the component.

## 7. Run protocol and the record

1. Take the device lock; pin the box (§1); start the private instance with
   the fixture; create the QA profile; install the QA-variant APK (already
   built, versionCode noted).
2. `impl` all `js` → run every suite's **A** captures and S1–S5 (3×).
3. `impl <component>=native` → **B** captures, traces, S1–S5 (3×).
4. Build the report; open the triptychs; watch the A/B `screenrecord`s.
5. File under `docs/qa/native-diff/<date>/` with `summary.md`: APK versionCode,
   commit, device fingerprint, display mode, locale, the pass/fail table,
   the perf medians table (JS vs native), masks used, anything waived and why.
6. Delete the QA profile; stop the instance; release the lock; leave
   stay-awake **on**.

A phase is "passed" only by a `summary.md` that elia has seen.
