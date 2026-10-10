# `com.auroratv.QA` — the broadcast protocol the harness speaks

This fixes the parts that `docs/native-rewrite/02-verification.md §2` leaves open.
`tools/tv-pixel-diff/adb.py` implements the harness side **exactly** as written here;
`com.auroratv.ui.qa.QaReceiver` must implement the app side the same way. If the
receiver author needs to deviate, change this file and `adb.py` in the same commit.

## 1. The intent

```
adb -s <serial> shell am broadcast \
    -n <pkg>/com.auroratv.ui.qa.QaReceiver \
    -a com.auroratv.QA \
    --es token <token> \
    --es cmd <cmd> \
    --es arg "<arg>" \
    --es rid <rid>
```

| part | value | why |
|---|---|---|
| component `-n` | `<applicationId>/com.auroratv.ui.qa.QaReceiver` (`com.auroratv.lab/…` for the lab build, `com.auroratv/…` for the real one). The receiver class lives in the `com.auroratv.ui.qa` package regardless of the applicationId. | Android 8+ drops **implicit** broadcasts to manifest receivers; the explicit component makes it reach the app whether or not the process is running (a cold `impl` write before a launch is the common case). |
| action | `com.auroratv.QA` (also declared in the receiver's intent-filter) | as 02 §2 |
| `token` (string) | **sha256 hex, lower-case, of the signing certificate's SHA-256 fingerprint written as 64 lower-case hex chars without colons.** i.e. `token = sha256( hex(sha256(cert DER)) )`. App side: `MessageDigest("SHA-256")` over `PackageInfo.signingInfo` (or `signatures[0]`) → hex → `MessageDigest("SHA-256")` over that ASCII hex → hex. Harness side: `keytool -list -v -keystore ~/.android/debug.keystore -storepass android -alias androiddebugkey` → the `SHA256:` line → strip colons, lower → sha256 → hex. Override with `--token` / `AURORA_QA_TOKEN` (the receiver may additionally accept the value from `BuildConfig.QA_TOKEN` in lab builds). | the guard of 02 §2: a release on a user's TV with adb off ignores everything; with adb on, only the holder of the signing key talks to it |
| `cmd` (string) | one of the commands below | |
| `arg` (string) | the command's argument string, **one extra**, space/comma separated as listed below; absent or empty when the command takes none | the orchestrator fixed `--es cmd … --es arg …` |
| `rid` (string, optional) | a request id the harness makes up (`<pid>-<counter>`); the receiver echoes it in the result line | correlation without clearing logcat |

The receiver acts only when `Settings.Global.ADB_ENABLED == 1` **and** the token matches. A
wrong/missing token is **silent** (no log line at all — do not help a prober). Everything
else is answered.

## 2. The answer: one logcat line per broadcast

Tag **`AuroraQA`** (exactly this case; `adb logcat -s AuroraQA:V`), priority `I`, payload:

```
[qa] <cmd> ok rid=<rid> <detail>
[qa] <cmd> err rid=<rid> <detail>
```

`rid=` is omitted when the intent carried no `rid` (`[qa] <cmd> ok <detail>`); the harness
then takes the last `[qa] <cmd>` line since its own `logcat -c`. `<detail>` is free text
except where a command specifies it. The receiver answers **synchronously from `onReceive`**
(all commands are cheap; `layout` posts to the UI thread and waits ≤ 500 ms). The harness
waits up to 3 s for the line.

Note: 02 §2 wrote the tag as `AuroraQa`; this protocol settles on **`AuroraQA`** for command
results (the orchestrator's choice). The harness reads both spellings, so an early receiver
build using `AuroraQa` still works, but new code must use `AuroraQA`.

## 3. Commands

| `cmd` | `arg` | effect | `ok` detail |
|---|---|---|---|
| `impl` | `focusable=js\|native,card=…,row=…,hero=…,rail=…,grid=…` — any subset; unknown keys → `err` | writes `SharedPreferences("aurora_impl")` (01 §4); takes effect on the **next launch**. Must work with the app process not running (the broadcast starts it just for `onReceive`). | the full resulting map, same syntax |
| `exp` | `none` \| `key=0\|1,…` — any subset of `AuroraExp.KEYS` (`cull`, `cardlayer`, `taglayer`, `shadowcache`, `unstuff`, `unstuffq` — the last two hold one vsync back when the frame pipeline is stuffed, `docs/qa/native-bench/FOLLOWUP.md` — and the `x_…` attribution removals); `none` first clears everything; an unknown key or value → `err` | **LAB ONLY** (2026-10-10, `docs/qa/native-bench/RENDER.md`): writes `SharedPreferences("aurora_exp")`; like `impl`, read once per process, so it takes effect on the **next launch**. All off by default — the lab app is then the reference picture. `run.py --exp <arg>` runs BOTH sides with the native letters, A with `exp none`, B with `<arg>`; `strict.py <out>` counts every pixel that differs at all. | the resulting set as `a+b` (`-` when empty) |
| `freeze` | `on` \| `off` \| `on,trailer` \| `on,mid` | `on`: hero rotation timer skipped, no trailer starts, Skeleton/MiniSpinner/RailHues loops hold phase 0.37; `atTop`/`swap`/focus timings run normally. `on,trailer`: as `on` but a trailer **may** start (used with the fixture HLS of 02 §3.3 and `TrailerFrame` paused at t=0); a receiver that cannot do it answers `err unsupported`. `on,mid` (2026-10-10): as `on`, and three animations come to rest HALF WAY so their blended frames can be captured still — Home's `atTop` fade down stops at 0.5, Home's column stops at half the focused row's target, the rail's slide in stops at 0.5 (both implementations: Home.tsx / NavRail.tsx `isMid()`, AuroraHeroArtView / AuroraSlideColumnView / AuroraRailPanelView `AuroraQa.mid`). Emitted to JS as device event `AuroraQa {frozen, trailer, mid}`. | `frozen=1\|0 trailer=1\|0 mid=1\|0` |
| `trace` | `on` \| `off` | `[anim]` lines from RN's native drivers (JS wrapper attaches `Animated.Value.addListener` only while tracing) and from `AuroraClock`; also turns `[key]` lines on. **Never on during perf runs.** | `trace=1\|0` |
| `focuslog` | `on` \| `off` | `[focus]` lines on every focus change (both implementations) and `[ring]` lines on ring claim/release | `focuslog=1\|0` |
| `framestats` | (none) | logs `[frames] {…json…}` (DeviceModule's JankStats snapshot) and resets it | `frames=<n>` |
| `layout` | `<nativeId>` | locates the view with that `nativeId` (Fabric: `nativeID` prop → `ReactViewGroup.getTag(R.id.view_tag_native_id)`; AuroraFocusable/Card/Row/Hero/Rail expose the same ids natively) and logs its on-screen **px** rect (`getLocationOnScreen` + `width/height`) | `x=<px> y=<px> w=<px> h=<px>`; `err notfound` when no such view is mounted |
| `nav` | `home` \| `browse:movie` \| `browse:show` \| `detail:<id>` \| `mylist` \| `search` \| `ai` \| `settings` \| `qa:text` | navigates via the `aurora://open` deep link / `rootNav`, popping to the root first, so every run starts from a known route. `detail:<id>` takes the server's item id (the fixture's made-up IMDb id). | `route=<route>` |
| `ping` | (none) | nothing — used by the harness to check the receiver and token before a run | `v=<versionCode> impl=<letters of native components, "-" if none> exp=<experiments on, "-" if none>` |

Commands are independent; the harness sends one per broadcast.

## 4. Trace lines (read by the harness; tag **`AuroraAnim`**)

All on tag `AuroraAnim`, priority `D`, so the harness's idle poll (`adb logcat -d -s AuroraAnim:V`)
sees nothing else. Formats (01 §6, 02 §4.3, §5):

```
[anim] <frameTimeNanos> <id> <value>          one line per driver step; id = <nativeId>.<property>
                                              ids in use: row.tx focus.ring focus.spring focus.ring.out focus.spring.out card.fade hero.atTop hero.ty rail.slide rail.strip hero.swap
                                              (focus.ring/.spring: the element heading to LIT; .out: the one heading to dark — both implementations)
                                              <value> printed with %.6f (or shortest round-trip); the harness compares to 1e-3 x range
[key]  <uptimeMs> <KEYCODE_NAME>              on every key the activity receives (while trace is on)
[focus] <uptimeMs> gain tag=<nativeId|reactTag> impl=js|native edgeL=0|1 edgeR=0|1
[focus] <uptimeMs> loss tag=<…> impl=…
[ring]  <uptimeMs> claim|release <tag>
```

`frameTimeNanos` is the Choreographer's (CLOCK_MONOTONIC); `uptimeMs` is `SystemClock.uptimeMillis()`
— the same clock, so the harness aligns `[anim]` steps on the first step after the first `[key]`.

## 5. Impl letters

`F`=focusable, `C`=card, `R`=row, `H`=hero, `N`=rail, `G`=grid. `--impl FC` means
`focusable=native,card=native,row=js,hero=js,rail=js,grid=js`. The A capture always
runs with all six `=js`; the B capture with the state's letters `=native` and the rest `=js`.

## 6. Launch / restart

```
am force-stop <pkg>
am start -W -n <pkg>/com.auroratv.MainActivity [-d <aurora://open?...>] [--es k v …]
```

`MainActivity` is in package `com.auroratv` in every applicationId. The harness then waits
`launchWaitMs` (default 4000) and sends `nav`, which must also work on a freshly launched
app (the receiver queues a `nav` until the root navigator is ready, ≤ 10 s, and answers
`ok` only once the navigation was dispatched).

## 7. Receiver notes (as built, P1 — `tv-native/android/app/src/main/java/com/auroratv/ui/qa/QaReceiver.kt`)

- Token: the certificate-derived one of §1, **or** `BuildConfig.QA_TOKEN` (`-PqaToken=…` at build
  time; the lab build's default is `aurora-lab-qa`). Both are compared case-insensitively.
- `impl` also accepts `all=js|native`.
- `freeze` persists in `SharedPreferences("aurora_qa")` together with `trace`/`focuslog`, so the
  flags survive the force-stop between the A and B captures; the app re-reads them at launch.
- `nav ai` lands on the Search screen (the app has no separate AI route); `nav qa:text` answers
  `err unsupported` (no text QA screen exists yet — it belongs to the phase that ports text).
- `[focus] … loss` lines carry no `edgeL=`/`edgeR=` (as §4 shows); `tag=` is the view's `nativeID`,
  else its `testID`, else the react tag.
- `[anim]` ids of BOTH Focusables (2026-10-10): `focus.ring` / `focus.spring` while the element
  is heading to lit, `focus.ring.out` / `focus.spring.out` while heading to dark, so a focus
  move is two clean series per value instead of one interleaved one. The native lines carry
  the frame time; the JS lines are stamped on arrival at the native module (uptime clock), a
  few ms later and late under JS load — trace.py compares curves in time with that slack.
- The harness sends `freeze` / `trace` / `focuslog` with the process stopped, before `am start`.
- `nav` is answered only after `navigation.tsx` dispatched the route (queued ≤ 10 s on a fresh
  launch, `err timeout` after); the broadcast is held with `goAsync()` meanwhile.
