# Native deep — the Mi TV pass (device plan)

Branch `tv-native-deep` (from master 9b16dc4 = server 1.7.0, TV 5.2.0 / vc96). Four new render switches, built
offline after the native port (`docs/qa/native-port/DEVICE-PLAN.md`) to go after what the lab left: Home still ~23 ms
a frame on the Mi TV after the fixes, RenderThread work ≈ draw-op count, the cards about half of it, their words and
tags 3.0–3.4 ms (`docs/qa/native-lab/2-render-thread-and-fixes.md`, `6-followup-menu-bug-and-frame-delay.md`).

**Every switch is OFF by default and NOT in the `recommended` preset. None of them has run on a TV.** Nothing below
the "offline evidence" section is proven. This file is what the agent that gets the Mi TV does, in order, and what
has to be true before any of them is turned on for anyone.

Device, rules, QA variant, closed mode: exactly as `docs/qa/native-port/DEVICE-PLAN.md` §1 (QA variant only, the
local server first, never nufurora.com, profile "Claude QA", every adb call in `timeout`, `svc power stayon true`
after every install and never `false`).

---

## 0. The switches

| key | needs | what it does | where |
|---|---|---|---|
| `cardtext` | `card` | The native card draws its words, NEW and kind pills, progress bar, tile title and ✕ itself — one art view + one focus view per card instead of 8–16 RN views. Drawn by React Native's OWN TextView / View code used as detached stamps, recorded once per content into a RenderNode shared by every card showing the same thing. Falls back to the two-layer native card if the styles cannot be handed over. | `ui/card/CardDecor.kt`, `CardStamps.kt`, `CardGeometry.kt`, `ui/view/AuroraCardView.kt` (decor mode), `src/cardDecor.ts`, `Card.tsx` `DeepCard` |
| `ringshare` | `focusable` | One focus ring per screen moves to the focused Focusable (taken from a per-context pool on focus, given back when its fade-out reaches 0) instead of a ring view (+ a 2-view ShadowLayer with `shadowcache`) per Focusable, mounted for life at alpha 0. | `ui/view/SharedRing.kt`, `ui/focus/RingPool.kt`, `AuroraFocusableView.kt` |
| `keyrate` | — | A held D-pad key's hardware repeats no longer move focus; the activity moves focus itself at most once per frame, at a steady 15/s (66 ms − 6 ms slack, i.e. every 4th refresh at 59.94 Hz), only while the key is down and a repeat arrived since the last move. A press (repeatCount 0) is never touched. | `ui/input/KeyRepeatGate.kt`, `MainActivity.kt` |
| `herotext` | — | Home's billboard words (kicker, title, facts, synopsis) in one native container that holds a hardware layer while it is drawn whole (own and every ancestor's alpha 1, scale 1), so their blurred text shadows are rendered once; dropped during the slide's crossfade and on a scaled canvas. | `ui/view/AuroraTextLayerView.kt`, `src/specs/AuroraTextLayerNativeComponent.ts`, `Home.tsx` `HeroWords` |

Turned on like every other switch (port plan §5): `Q exp cardtext=1` (QA), the developer setting, or the server's
`"tvRender": {"models": {"MiTV-AFMU0": {"recommended": true, "cardtext": true}}}`. Telemetry letters in the `perf`
event's `exp`: keyrate `k`, cardtext `t`, ringshare `r`, herotext `h`.

**About `herotext` and the brief's "native text for the hero lockup".** What is built keeps the four Texts as RN
Text and puts them in a natively controlled layer. A native text renderer for the lockup was not built: the lockup's
height (1–2 title lines, 0–2 synopsis lines) decides where the buttons below it sit, and only a C++ Fabric shadow
node with a measure function can give Yoga that height — a much larger, riskier change. The layer gets the stated
goal (the 5.2.0 text shadow drawn once into a cached layer) with RN's own pixels.

**About `cardtext`'s "one view".** The card is the Focusable + the art view + the focus view (inside the overlay
wrapper the Focusable fades). The focus view exists because its alpha is the ring value: as a separate view the fade
is a RenderNode property (no re-record per fade step); folding it into the art view would re-record the card on
every frame of every focus fade.

## 1. Builds (made offline on this branch, not installed)

- Normal: `cd tv-native/android && ./gradlew.bat assembleRelease` — BUILD SUCCESSFUL.
- QA variant (port plan §1 recipe): local edits only — `"http://192.168.50.108:4000", // QA VARIANT` first in
  `SERVER_CANDIDATES` (src/api.ts) and `versionCode` above the installed one (the TV had vc97 at the time of writing;
  98 was used) — then `./gradlew.bat assembleRelease -PqaReceiver=true -PqaToken=aurora-port-qa`, then both edits
  reverted and `grep -rn "QA VARIANT" tv-native/src` → 0 lines. Rebuild it the same way on the merged tree.

The QA receiver gained two things for this pass:
- `Q keyrate <ms>` / `Q keyrate clear` — the gate's interval (16–250 ms), next launch; `Q exp keyrate=1` turns it on.
- `Q views` → `views=<all Views in the window> texts=<TextViews> rings=<in use>/<most at once>/<made> decor=<recorded decors>`
  — the offline claims of `cardtext` and `ringshare`, read on the device.
- With `Q trace on` the activity also logs every D-pad release: `[keyup] <eventTime> KEYCODE_DPAD_… repeats=N`
  (tools/tv-bench/keyrate-parse.py reads it).

## 2. Smoke, by hand, per switch (real remote or tools/tv-bench/tv-keys-uinput.py)

Run each with the port's `recommended` set on and the one switch added (`Q render recommended`, then
`Q exp cardtext=1` etc. — `exp` merges into the QA set), force-stop, launch, `Q ping` → `exp=…+cardtext`. Logcat free
of `AndroidRuntime`, `ReactNativeJS` errors, `[row] behind`, `[home] behind`. Any failure stops the pass for that
switch: file it with logcat and screencaps.

### cardtext
| # | check | expected |
|---|---|---|
| T1 | Home cold start, Continue Watching | frame cards: show name large, `S1 E2 · …` under it, `▶  N min left`, the bar with its glow and bead |
| T2 | a mixed shelf (film + series) | the kind pills at the top right, film gold / series blue icon, sharp at rest and on the lit card |
| T3 | Shows grid (`new-tag` state) | the NEW pill (violet, white `NEW`), quieter than the kind pill |
| T4 | hold OK on a CW card → focus a CW card | the ✕ circle appears only on the focused removable card, fades with the ring |
| T5 | a long title on a wide card, an episode with no show name | ends in `…`; an empty first line keeps its height (the S/E line sits where the JS card puts it) |
| T6 | a Hebrew-titled item in Continue Watching (play any Hebrew title 20 s as Claude QA first) | right-to-left glyphs, left-aligned in the label like the JS card (TextLayoutManager's ALIGN_OPPOSITE → Gravity.LEFT), ellipsized on the left end of the run as RN does |
| T7 | `broken-tile` (server `artFail: 1`) | the gradient tile WITH the title centred, 3 lines max, under the label's shade |
| T8 | closed mode (port plan §2 #10) | pictures draw; words unaffected |
| T9 | `Q views` on Home at rest, `cardtext` off then on (same shelves) | `views` drops by roughly 6–12 per mounted card; `texts` drops by every card label; `decor` > 0 |
| T10 | hold RIGHT along the 4th shelf to the end and back (pool on) | no card shows another card's words (recycled slots re-record or reuse the right decor) |
| T11 | Settings → developer panel | `cardtext` row with its line; `needs card` when card is off |

### ringshare
| # | check | expected |
|---|---|---|
| R1 | every focus surface: shelves, the hero buttons (light rings: NOT shared — unchanged), Movies grid, Settings rows, Sources rows, X-Ray faces, the rail | the ring appears on the focused element exactly as before, fades in 160 ms, fades out on the one left |
| R2 | `Q views` at rest after moving around | `rings=1/…` (one in use at rest), `made` ≤ 4 after a held key, never growing with time |
| R3 | hold RIGHT 3 s on a shelf | the trailing rings fade out behind the lit one as before; `rings` peak ≤ 4 |
| R4 | BACK from Detail onto the card it opened | the card is lit again with its ring (no ghost ring left on Detail's last button) |
| R5 | a list re-render while lit (Continue Watching → Remove a card) | the ring stays on the card that took focus; no ring left over the removed slot |

### keyrate
| # | check | expected |
|---|---|---|
| K1 | single taps, 20 of them, along a shelf | one card per tap, none lost, none doubled (the 110 ms double-press filter still works: a touchpad swipe moves one) |
| K2 | hold RIGHT 3 s along the 4th shelf, release | the shelf moves steadily (~15 cards/s) and **stops on release** — focus is where it was when the key came up |
| K3 | hold DOWN through Home, hold UP back | the column steps steadily, one shelf per move, stops on release |
| K4 | hold LEFT along a shelf into card 0, release, then one tap LEFT | the hold stops at card 0 and does NOT open the rail; the tap opens it |
| K5 | 20 × UP from shelf 1 (real presses 30–350 ms, uinput) | lands on the hero every time, the rail never opens by itself (6-followup's case) |
| K6 | Movies grid: hold DOWN, hold RIGHT into the filter panel edge | steady, stops on release; RIGHT at the last column still opens the panel only on a separate tap |
| K7 | Player: hold RIGHT/LEFT on the scrubber, and in the subtitle / audio menus | seeking repeats as before (at the gate's pace), stops on release; menus step one row per move |
| K8 | Search keyboard, the sign-in fields | unchanged (the IME is another window; the gate never sees its keys) |
| K9 | `Q keyrate 50`, relaunch, K2 again; `Q keyrate clear` | 20/s like the system's own repeat, still no overshoot — the device agent picks the interval that feels right (§4 numbers decide) |

### herotext
| # | check | expected |
|---|---|---|
| H1 | Home cold start, rest 10 s (rotation on) | the lockup reads exactly as before; each slide crossfades as before (no darker halo around the letters mid-fade) |
| H2 | DOWN to shelf 1 and back up | the lockup slides with the column, sharp, no shimmer at rest |
| H3 | trailers ON for Claude QA, rest on the hero | the trailer plays under the scrims and the lockup; words unchanged |
| H4 | `adb shell wm density 160` (the scaled-canvas case), relaunch; then `wm density reset` | the lockup is drawn without a layer (sharp, same as off) |

## 3. Pixels — every switch against the same build without it

Harness `tools/tv-bench/tv-pixel-diff/` (rules unchanged: run.py PASS = 0 differing px by pixelmatch YIQ 0.1;
`strict.py` counts every pixel that differs at all). Profile Claude QA, billboard trailers OFF, `freeze on` set by
run.py. Both sides run `--impl FCRHN` with the port's fixes; B adds the switch.

```bash
cd tools/tv-bench/tv-pixel-diff
P="python run.py --serial 192.168.50.31:5555 --pkg com.auroratv --token $AURORA_QA_TOKEN --impl FCRHN"
REC=cardlayer=1,cull=1,shadowcache=1,unstuff=1,pool=1
# 3t. cardtext: every card state, the shelves with labels / bars / ✕, the render rest states — 2 runs
$P --states card,row,states/render.json --exp-a $REC --exp $REC,cardtext=1 --runs 2 --out ../../../docs/qa/native-deep/pixels/3t
python strict.py ../../../docs/qa/native-deep/pixels/3t
#     and the strongest form: all JS (today's app) against all native + cardtext, no fixes either side
$P --states card,row --impl-a - --exp cardtext=1 --runs 1 --out ../../../docs/qa/native-deep/pixels/3t-js
#     server fixtures: broken-tile (artFail 1) and blur-up (artDelay 600000) on a private instance, as the lab ran them
$P --states card --only broken-tile,blur-up --server artFail --exp-a $REC --exp $REC,cardtext=1 --out ../../../docs/qa/native-deep/pixels/3t-fixtures
# 3r. ringshare: the focus states (a ring on every kind of Focusable) + render + the row walks — 2 runs
$P --states focusable,states/render.json,row --exp-a $REC --exp $REC,ringshare=1 --runs 2 --out ../../../docs/qa/native-deep/pixels/3r
python strict.py ../../../docs/qa/native-deep/pixels/3r
# 3k. keyrate: the held-key states (each state's own keys; adb taps are presses, so these must be 0 px by construction)
$P --states states/app.json,row --only home-down-hold-8,home-row-hold,movies-grid-hold,hold-right-12,hold-right-end,hold-right-left,left-at-0,left-at-0-return \
   --exp-a $REC --exp $REC,keyrate=1 --runs 2 --out ../../../docs/qa/native-deep/pixels/3k
# 3h. herotext: every hero state + the render rest states — 2 runs
$P --states hero,states/render.json --exp-a $REC --exp $REC,herotext=1 --runs 2 --out ../../../docs/qa/native-deep/pixels/3h
python strict.py ../../../docs/qa/native-deep/pixels/3h
# 3h-motion: the slide's crossfade (not frozen by `freeze`): screenrecord both sides of first-slide, compare by eye frame by frame
$P --states hero --only first-slide,slide-then-scrolled --exp-a $REC --exp $REC,herotext=1 --screenrecord --out ../../../docs/qa/native-deep/pixels/3h-motion
# 3n. the noise floor of this build (REC vs REC), for the strict.py ranges — 3 runs
$P --states states/render.json --exp-a $REC --exp $REC --runs 3 --out ../../../docs/qa/native-deep/pixels/3n-null
python strict.py ../../../docs/qa/native-deep/pixels/3n-null
Q render clear
```

**Pass, per switch:**
- run.py PASS on every state both sides reach deterministically (the port plan's known flaky states are retaken ×3 and
  accepted at ≥ 2 of 3, or when they fail js-vs-js the same way).
- `strict.py`: no pixel more than 8/255 off, max ≤ 7/255, and the count of pixels off by > 1/255 inside the 3n noise
  floor's range — for `cardtext` and `ringshare` the goal is the noise floor itself (the same draw ops, by
  construction); `herotext` may add the cardlayer-like ≤ 2/255 of a layer composited at a fractional offset (lab:
  cardlayer ≤ 40 px by 2/255) and nothing more.
- 3t-js (JS against native+cardtext): the card states at 0 differing px by run.py, like the port's 3a.
- `keyrate` (3k): 0 differing px — adb's `input keyevent` makes presses, never repeats, so the gate never acts there;
  any difference is a bug in the pass-through.
- Where `cardtext` differs, `strict.py`'s diff images say which piece: the first places to look are the text box
  heights (CardStamps measure vs TextLayoutManager.measureText) and the ✕/tile centring (Yoga rounding, CardGeometry).

## 4. Frames — interleaved, cold start per run

Never two benches at once (`ps -ef | grep -E "tv-bench|run.py"` empty). Trailers OFF, the TV idle 5 min, **4 rounds**,
every configuration once per round in the same order. `rec` = the port's recommended set
(`cardlayer=1,cull=1,shadowcache=1,unstuff=1,pool=1`, five components native).

```bash
REC=cardlayer=1,cull=1,shadowcache=1,unstuff=1,pool=1
IMPL=all=js,focusable=native,card=native,row=native,hero=native,rail=native
# 4a. cardtext + ringshare + herotext, on the frame bench (S1 row taps, S2 row steps, S3 grid, S4 rail)
IMPL=$IMPL KEEP=1 tools/tv-bench/tv-present-bench.sh docs/qa/native-deep/bench/present 4 \
  rec=$REC  t=$REC,cardtext=1  r=$REC,ringshare=1  h=$REC,herotext=1  trh=$REC,cardtext=1,ringshare=1,herotext=1
# 4b. the same where cardlayer CANNOT be used (a scaled-canvas TV): components only, no layers
IMPL=$IMPL tools/tv-bench/tv-present-bench.sh docs/qa/native-deep/bench/nolayer 4 \
  nat=none  natT=cardtext=1  natTR=cardtext=1,ringshare=1
# 4c. held keys (uinput real holds): L1 shelf hold, G1 grid hold — every switch, and keyrate
SCENARIOS="L1 G1" IMPL=$IMPL tools/tv-bench/tv-pool-bench.sh docs/qa/native-deep/bench/hold 4 \
  rec=$REC  k=$REC,keyrate=1  t=$REC,cardtext=1  r=$REC,ringshare=1  all=$REC,keyrate=1,cardtext=1,ringshare=1,herotext=1
# 4d. keyrate's own numbers: the same holds with the focus log, parsed for overshoot and steadiness
#     (per configuration, per round: Q trace on; Q focuslog on; run L1/G1 as 4c does; then)
timeout 30 $ADB -s 192.168.50.31:5555 logcat -d -s AuroraAnim:D AuroraRender:I > docs/qa/native-deep/bench/keyrate/<label>-<round>.txt
python tools/tv-bench/keyrate-parse.py docs/qa/native-deep/bench/keyrate/rec-*.txt | tail -1
python tools/tv-bench/keyrate-parse.py docs/qa/native-deep/bench/keyrate/k-*.txt | tail -1
# 4e. under load (the weak-box case): three of four cores busy, 3 rounds of rec against k and all
timeout 20 $ADB -s 192.168.50.31:5555 shell "for i in 1 2 3; do nohup timeout 3000 sh -c 'while :; do :; done' >/dev/null 2>&1 & done"
SCENARIOS="S1 S2 L1" IMPL=$IMPL tools/tv-bench/tv-pool-bench.sh docs/qa/native-deep/bench/load3 3 rec=$REC k=$REC,keyrate=1 all=$REC,keyrate=1,cardtext=1,ringshare=1,herotext=1
timeout 20 $ADB -s 192.168.50.31:5555 shell "pkill -f 'while :'"
# 4f. Q views on Home at rest, once per configuration (cold start, 10 s, then `Q views`) → views / texts / rings / decor
Q render clear
python tools/tv-bench/present-report.py docs/qa/native-deep/bench/present/rec.jsonl 'docs/qa/native-deep/bench/present/*.jsonl' > docs/qa/native-deep/bench/present/table.md
python tools/tv-bench/present-report.py docs/qa/native-deep/bench/nolayer/nat.jsonl 'docs/qa/native-deep/bench/nolayer/*.jsonl' > docs/qa/native-deep/bench/nolayer/table.md
python tools/tv-bench/pool-report.py docs/qa/native-deep/bench/hold rec k t r all > docs/qa/native-deep/bench/hold/table.md
python tools/tv-bench/present-report.py docs/qa/native-deep/bench/load3/rec.jsonl 'docs/qa/native-deep/bench/load3/*.jsonl' > docs/qa/native-deep/bench/load3/table.md
```

Metrics as the port's: presented fps while moving, refreshes without a new frame /1000, vsync→screen p50/p90, gfx
p50/p90/p99, janky %, frames > 32 / > 64 ms, RT CPU ms/frame, UI CPU ms, PSS; plus `Q views`, and for 4d: moves,
overshoot, late_ms, max_in_frame, held_ms_sd.

**Pass (medians of the rounds; "not worse" = within the lab's run-to-run spread):**
- **Everywhere** (every scenario of 4a, 4b, 4c, each switch against its baseline): janky % not higher by more than
  0.3 pt, gfx p90 not higher by more than 1 ms, frames > 64 ms (sum over rounds) not more, PSS not higher by more than
  20 MB.
- **`cardtext`**: better on Home scrolling — S1 and S2 (4a `t` vs `rec`, and 4b `natT` vs `nat`): RT CPU ms/frame
  lower in ≥ 3 of 4 rounds and the median lower; janky % or p90 lower in ≥ 3 of 4 rounds; L1 (4c) frames > 32 ms not
  more and UI CPU not higher by more than 5 %. `Q views` on Home at least 100 views fewer.
- **`ringshare`**: `Q views` on Home at least 30 fewer (rings at rest: 1); S1/S2 RT CPU not higher; L1 not worse.
  It earns a place only with a measurable sync/RT or UI-thread gain somewhere (else it stays off: its value is mostly
  for weaker boxes and the 4b column).
- **`keyrate`**: 4d — overshoot 0 in every hold of `k` (against today's count in `rec`), max_in_frame 1, held_ms_sd ≤ 2
  ms (a steady rate); 4c/4e — L1 and G1 frames > 32 ms lower in ≥ 3 of 4 rounds, janky % not higher; S1–S4 within
  noise (taps pass untouched). K1–K9 of §2 all pass by hand. The interval stays 66 ms unless the device agent's eye
  and 4d say 50 ms is as clean (then change `INTERVAL_MS` in KeyRepeatGate.kt and the compat test's pinned value).
- **`herotext`**: 3h strict within the layer allowance; S1/S2 RT CPU lower or equal (the hero is on screen in S1's
  first frames and in every frame of S4 with the rail over it), H1–H4 by eye.
- A switch that fails any "everywhere" line stays OFF; the device agent writes the numbers into this file and does
  not add it to `RECOMMENDED`. One that passes may be proposed for the preset in one commit with the data (renderRules.ts
  RECOMMENDED, AuroraRender.kt RECOMMENDED, render-rules test, port plan §0) — the owner decides.

## 5. Expected gains, with the reasoning (to be replaced by the measured numbers)

- **`cardtext`** — the lab found RenderThread work ≈ the number of draw operations and nodes, the cards about half of it,
  their tags and words 3.0–3.4 ms, prepareTree 14 % and the tree walk 13 % of the thread, every react-native-svg icon a
  mutable bitmap re-pinned each frame (4 %). Per card the switch removes 6–12 RenderNodes (label View, 1–3 Texts, NEW
  View + Text, kind View + SvgView + G + Path/Rects, progress 3 Views, ✕ View + Text); Home holds ~30–40 cards of its
  ~350 views. Expected with the fixes on (`rec`): sync −0.4…−1.0 ms and tree walk −0.3…−0.7 ms per frame on S1/S2
  (cards resting in a cardlayer are already one quad, so the drawing itself barely changes there; the lit card and
  every layer re-render get cheaper), icon pinning ≈ 0. Without layers (4b — the scaled-canvas TVs `cardlayer` must
  not touch) the same plus most of the tags' per-node cost: −1.5…−3 ms. UI thread: Fabric creates 6–12 fewer views per
  mounted card on a held key, but the text is now measured and laid out on the UI thread when a card's content is first
  recorded (cached by content afterwards; RN measured it on the JS thread) — about 0.2–0.5 ms per new card. Whether L1
  gets better or slightly worse on the UI thread is what 4c decides.
- **`ringshare`** — 1 view per Focusable (3 with `shadowcache`) gone for every element but the lit one: on Home ~40–120
  fewer nodes in prepareTree (−0.1…−0.4 ms sync), fewer views to create per card mount. Small alone; it adds to
  `cardtext`.
- **`keyrate`** — no draw cost changes; the held key makes 25 % fewer moves (15/s instead of 20/s), never two in one
  frame, and nothing after the release. The KeyRepeatSimTest model (a weak box: 60 ms per move): today 3 moves after the
  release and up to 22 in one frame interval after a stall, gated 0 and 1. On the device: L1/G1 frames > 32 ms down
  (less work per second, no bursts), the shelf's spring closer to focus (rowWindow.ts measured it 5–7 cards behind at
  15–20 presses/s), overshoot gone. Cost: a held key scrolls 25 % slower; `Q keyrate 50` is the knob.
- **`herotext`** — the lockup's four text runs with blurred shadows (radius 6–16) replayed every frame the hero is on
  screen; the lab measured the whole lockup (with buttons and dots) at 0.5–0.8 ms and text shadows on the cards at 0.3
  ms. Expected −0.2…−0.5 ms RT on frames with the hero on screen, for one layer of ~880 × 300 px (~1 MB of GPU memory).

## 6. Offline evidence in this branch

- `cd tv-native && npx jest -c jest.logic.config.js`:
  - `card-decor.test.tsx` — for 11 card shapes (posters with kind, NEW, landscape, Hebrew, episodes with and without a
    show name, Continue Watching with progress and ✕, frame cards film / episode, up-next) what DeepCard hands the
    native views equals what JsCard writes as RN children; no RN Text left; the decor JSON is Card.tsx's own StyleSheet
    values; every piece is read by CardDecor.kt; the kind glyphs CardStamps.kt draws are Icon.tsx's; with no decor the
    card falls back to the two-layer native card.
  - `keyrate-compat.test.ts` — the gate's pace keeps a hold one run for rowWindow.ts (HELD_GAP_MS) at 60/59.94/50/30/24 Hz.
  - `keyrate-focus.test.tsx` — synthetic streams through the real focus.ts: a hold never opens the rail by itself; a
    gated hold stops at the edge and the next tap there opens it; nothing moves after a gated release; today's backlog
    (a weak box) runs on past the release and swallows the next tap; a tap is untouched (UP from shelf 1).
  - `render-rules.test.ts` — key lists agree (TS / Kotlin / server), the deeper switches are not in the preset,
    `needs card` / `needs focusable`.
- `./gradlew.bat testReleaseUnitTest`: `KeyRepeatGateTest` (the rule event by event), `KeyRepeatSimTest` (a timing
  model of the UI thread: taps never lost or delayed, a light box at 1 move/frame and 66.7 ± 0 ms, a jittery remote
  made steady, a slow remote never outrun, a weak box and a 320 ms stall without overshoot), `CardGeometryTest` (Yoga's
  rounding of every box, by hand at density 2 and 1.5), `RingPoolTest`.
- `./gradlew.bat assembleRelease` (normal and the QA variant, vc98 local-only, `192.168.50.108` first): BUILD SUCCESSFUL;
  the normal bundle carries 0 copies of the QA address, `grep -rn "QA VARIANT" tv-native/src` → 0.
- Totals at commit time: TV logic 41 suites / 451 tests (twice), Kotlin 70 tests, `tsc --noEmit` clean.

What none of that proves: any pixel (text through detached stamps into a shared RenderNode is RN's own drawing code,
but the box heights and positions are this branch's emulation of Yoga and TextLayoutManager), any frame time, that a
RenderNode shared by many parents behaves on this HWUI exactly like one per view, the hero layer's drop at the start of
each crossfade, the gate's feel and its interplay with the player's scrubber, and every gain in §5.
