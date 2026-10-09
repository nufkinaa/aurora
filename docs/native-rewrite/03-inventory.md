# Inventory — every JS-drawn surface today

"Native today" means: what already runs outside the JS thread for this
surface (Yoga layout and Fabric mounting are native for everything, so they are
not repeated; `native driver` = `Animated` with `useNativeDriver: true`).
Phases are `00-plan.md §3`. Risk is for the **1:1** obligation, not for
building it.

Line counts are from the tree at TV 5.1.29.

## 1. Components (`tv-native/src/components/`)

| surface | file (lines) | native today | proposed | risk | notes |
|---|---|---|---|---|---|
| Focusable — ring, light ring, highlight wash, focus overlay fade, scale + lift spring, one-lit-ring registry, `hasTVPreferredFocus` disarm, `holdLeft`, `focusDisabled`, long-press | `Focusable.tsx` (527) | animations on the native driver; focus moves by Android `FocusFinder`; `topFocus/topBlur` events | **P1 → `AuroraFocusable`** | low | ~5 native calls after a JS hop per move today; the first component and the one every other uses |
| Card — poster/wide/compact/frame, Fresco image, blur-up, baked shades, brighten, NEW/kind tags, ✕, progress ramp + bead, retry/backup/park | `Card.tsx` (609) | Fresco decode; shade PNGs | **P2 → `AuroraCard`**, text as RN children | medium-high | 12–15 views → 2; retry state machine moves to Kotlin with the same constants |
| Row — sliding track (retargetable spring), coarse window 5/3/3, absolute slots, left fade strip, traps | `Row.tsx` (232) | spring on the native driver; traps in `ReactViewGroup.focusSearch` | **P3 → `AuroraRow`** (P3-lite first: native slide, JS cards as children) | medium | removes React commits from the hold path |
| NavRail — strip (scrim, mark, dots), panel slide, feather, hues loops, items (invert on focus), profile pill, LEFT/RIGHT/UP/DOWN/BACK logic, `focusJustMoved` | `NavRail.tsx` (736) | slide + hues on the native driver; SVG scrim/feather (react-native-svg, native) | **P5 → `AuroraNavRail`** (drawing + containment); key logic stays JS | low-medium | the scrim/feather gradients failed to draw on the Mi TV in other contexts (QA memory) — bake them like `nav-scrim.png` already exists for |
| Btn (primary/secondary/small) | `Btn.tsx` (146) | — | P1 via Focusable; the pill fill stays RN | low | `light` + violet ring on primary |
| Chip | `Chip.tsx` (120) | — | P1 via Focusable | low | |
| Icon — the site's SVG paths | `Icon.tsx` (192) | react-native-svg (native renderer) | none | — | stays; used as a child inside native cards |
| Ambient — baked canvas, window-background drop | `Ambient.tsx` (76) | `DeviceModule.dropWindowBackground` | none | — | one Image, static |
| Skeleton shimmer | `Skeleton.tsx` (77) | native-driver loop; SVG gradient | none (freeze hook only) | — | loading state only |
| MiniSpinner | `MiniSpinner.tsx` (39) | native-driver rotate loop | none (freeze hook only) | — | |
| Sheet (modal frame + trap) | `Sheet.tsx` (92) | focus guide traps | none | — | |
| Overlays — Toasts, PeekSheet, ReportSheet, JoinSheet, UpdateSheet, UpdateReadySheet, XraySheet (spring rise), ActionsSheet, TrailerModal | `Overlays.tsx` (983) | XraySheet spring/timing on the native driver; traps | none | — | rare, not on the input-hold path |
| Picker | `Picker.tsx` (199) | — | none | — | |
| States (ErrorState etc.) | `States.tsx` (93) | — | none | — | |
| Trailer — ExoPlayer via react-native-video | `Trailer.tsx` (172) | **ExoPlayer**, `TrailersModule.kt` (NewPipe resolve) | none; hosted as a child of `AuroraHeroArt` in P4 | low | the SurfaceView follows the canvas matrix (verified on the Mi TV) |

## 2. Screens (`tv-native/src/screens/`, `playback/`)

| surface | file (lines) | native today | proposed | risk | notes |
|---|---|---|---|---|---|
| Home — fixed hero art (rest/scrolled layers, dim, scrim, artFade), trailer layer, lockup + buttons + dots + parties, sliding column (`ty` spring), rows, rotation/hold/trailer choreography, update offer | `Home.tsx` (1 117) | `atTop`/`swap`/`trailerFade`/`ty`/`artFade` on the native driver; JankStats tag `home` | **P4 → `AuroraHeroArt` + `AuroraSlideColumn`**; lockup stays RN; **B candidate** (`00 §5`) | medium | the only screen where B is on the table |
| Browse — FlatList grid (`numColumns`, `windowSize 3`, `removeClippedSubviews`), filter panel slide, genre picker, Surprise me | `Browse.tsx` (854) | panel slide native driver; FlatList cells are RN views | **P6 → `AuroraGrid`** | high | FlatList semantics (paging, `scrollToOffset`, focus scroll-into-view) |
| MyList — grid + sorts | `MyList.tsx` (346) | — | P6 (same grid) | high | |
| Search — TextInput + grid | `Search.tsx` (236) | keyboard native | P6 (grid only) | medium | |
| Pick (AI) — mood field, dials, folded line, compact-card grid | `Pick.tsx` (670) | — | P6 (grid only) | medium | |
| ProfileGate — tiles grid, password | `ProfileGate.tsx` (539) | — | none | — | outside the navigator; not a perf complaint |
| SignIn | `SignIn.tsx` (453) | QR via react-native-qrcode-svg | none | — | |
| Detail — DetailHero/HeroArt (art box + baked masks), lockup, button row, synopsis, season pills, EpisodeCard list (FlatList), More-like-this (FlatList), SourcesPanel, download state machine, actions sheet | `Detail.tsx` (3 023) | Fresco; no `Animated` at all | none in A; EpisodeCard/More-like-this reuse `AuroraCard`/`AuroraFocusable` by construction | — | 0 `Animated.` uses; its cost is layout on open, not input hold |
| Sources — FlatList of source rows, DlRing | `Sources.tsx` (882) | — | none (Focusable via P1) | — | |
| Settings — ScrollView of rows | `Settings.tsx` (423) | — | none (Focusable via P1) | — | |
| Downloads | `Downloads.tsx` (258) | — | none | — | |
| WhatsNew | `WhatsNew.tsx` (209) | — | none | — | |
| Player — ExoPlayer, chrome (fade 8 `Animated.`), scrubber row (guide), menus, subtitles cue layer, flash, skip hint, up-next, party | `playback/Player.tsx` (~3 500) | **ExoPlayer** (react-native-video, patched), chrome fades on the native driver | none | — | playback is already native; the chrome is not an input-hold path |

## 3. Cross-cutting JS that the native layer must keep honest

| module | file | what native must feed or respect |
|---|---|---|
| focus facts (`held`, edge flags, `focusJustMoved`, traps count, rail open, fallbacks, 120 ms rescue, `acceptTvEvent`) | `focus.ts` (291) | `onFocusChange` events from every native focusable (`01 §5`) |
| motion (`useSlide` retarget, `defer`, `EASE`, `useScreenIn`) | `motion.ts` (94) | the spring/timing math (`01 §6`) |
| theme tokens | `theme.ts` (212) | every dp/colour constant is passed as props or duplicated **by generated code** (a `ThemeTokens.kt` written by a script from `theme.ts`, never by hand) |
| perf tier | `perfTier.ts` (268) | `AuroraTier` (`01 §9`); `impl`/`v` tags on `perf` events (P0) |
| usage | `usage.ts` (52) | unchanged |
| canvas (960-dp logical width) | `canvas.tsx` (69) | native views inherit the matrix; no window reads natively |
| blur-up map | `blur.ts` (40) | `blurUri`/`blurSkip` props |
| art ladder, `imgSrc` headers | `api.ts` (1 144) | the request helper mirrors RN's `ReactImageView` (`01 §7`) |
| navigation (native-stack `fade` 260 ms, `freezeOnBlur`, `frameScreen`) | `navigation.tsx` (127) | react-native-screens is already native; untouched |
| realtime (`welcome` un-park, `library_updated`) | `realtime.ts` (133) | the card's `retry` command |

## 4. Already native (Kotlin) — reused as is

| file | role |
|---|---|
| `DeviceModule.kt` (286) | JankStats per-screen frame histograms, trim events, GL renderer, window background; gains `setTier` and the `impl` constants |
| `MainApplication.kt` (117) | RN's Fresco config + trim registry; `AuroraUiPackage` registers here |
| `MainActivity.kt` (89) | `dispatchKeyEvent` 110 ms same-key dedupe |
| `A11yServices.kt` (64) + `build.gradle` ASM rewrite | no per-update accessibility binder call |
| `TrailersModule.kt` (264), `TrailersPackage.kt` | YouTube resolve on the box |
| `HomeScreenRows.kt` (633), `HomeScreenModule.kt`, `HomeScreenJob.kt`, `ArtProvider.kt`, `DownloadNotices.kt` | launcher rows, notifications |
| `UpdaterModule.kt` (311), `RelaunchReceiver.kt`, `UpdateResultReceiver.kt` | in-app update |

## 5. Numbers to fill in during P0

- Mi TV `memoryClass` / `largeMemoryClass` / `totalMem` (from the first
  `device` perf event once the admin table exists).
- The Android 13 reporter's box model, SDK, RAM, GPU (same source).
- Home view count today (`dumpsys meminfo` `Views:`), to set the P2 target.
- Home `perf` p50/p90/jank by model for ≥ 50 sessions (the field baseline).

## 6. Open questions for elia (each with the default the plan assumes)

1. **Fixture artwork seam.** The private test instance is offline; real
   posters need a committed art pack served under the app's own `/img` routes
   (`02 §3.2`). *Default:* add `--fixture-art` to `scripts/ui-test-server.js`
   that pre-populates the variant cache and library covers; commit ~20 small
   WebPs under `test/ui/fixtures/art/`.
2. **QA receiver in release builds.** The A/B switch and hooks are most
   useful on the shipping APK; the receiver is guarded (adb enabled + token).
   *Default:* compiled into release, guarded; nothing in it can change what a
   viewer sees unless adb is on.
3. **Row first or Card first after Focusable.** *Default:* P3-lite (native
   slide hosting JS cards) before Card, to measure mount cost in isolation.
4. **Text stays on RN `Text` throughout option A.** A native card with RN
   text children is invisible to the viewer and avoids the hardest 1:1
   problem. *Default:* yes; text ports only in B, after the `02 §3.4`
   procedure.
5. **If B is reached: Views, not Compose for TV.** Compose's focus and text
   pipelines are not RN's; 1:1 would not survive. *Default:* Views. Compose
   only if the requirement becomes "a new app" (option C).
6. **Rail key logic (LEFT-at-edge, wrap, `focusJustMoved`) stays JS in P5.**
   *Default:* yes; a native twin of `focus.ts` is a P6 option, decided by the
   P5 traces.
7. **Server kill switch.** `/api/home` may carry `_impl` to turn a native
   component off for every TV for the next launch, without an APK. *Default:*
   yes; one optional field, ignored by the web.
8. **Field rollout rule.** Flip a component to native-by-default after one
   week of `perf` events where its screen is not worse (admin table split by
   `impl`), keep the JS path in the APK one more release, then delete.
   *Default:* yes.
9. **Which boxes first.** *Default:* all TVs once the Mi TV passes the gates;
   the Android 13 reporter is asked for a `device` event (install the P0
   build) before P1 so the fleet's weakest box is known.
10. **Where reports live.** This package was moved out of the gitignored
    `docs/dev-plan/` into the committed `docs/native-rewrite/`; `docs/qa/`
    is committed with photos. *Default:* `docs/qa/native-diff/<date>/` with
    `summary.md` and a handful of triptychs committed, raw PNGs and
    `screenrecord`s kept out via `.gitignore` (`docs/qa/native-diff/**/raw/`).
