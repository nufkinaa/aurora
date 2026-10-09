# 11a · 1:1 spec — playback/Player.tsx

Part of [11-spec-detail-player-pick.md](11-spec-detail-player-pick.md). HEAD `42bb208`. File: `tv-native/src/playback/Player.tsx` (4018 lines). Every number is `Player.tsx:line` unless another file is named.

ExoPlayer is already native (react-native-video 6.19, `android/`); the native rewrite keeps the player and **re-creates the chrome and the state machine around it**. Everything the chrome shows is derived from the refs/state listed in §1.

---

## 0. Constants (`:125-210`)
| name | value | line | meaning |
|---|---|---|---|
| `SPEEDS` | `[0.5, 0.75, 1, 1.25, 1.5, 2]` | 127 | speed menu |
| `SKIP_STEPS` | `[10,10,10,30,60,60,120,300]` s | 128 | accelerating skip |
| `SKIP_CHAIN_MS` | 900 | 129 | presses closer than this chain |
| `HIDE_MS` | **7000** | 135 | chrome auto-hide after last input |
| `SEEK_DEBOUNCE_MS` | 450 | 138 | scrubber moves instantly, network once |
| `MAX_RECOVERIES` / `RECOVERY_WINDOW_MS` | 4 / 30000 | 143-144 | HLS recovery budget per burst |
| `CUE_PX` | S 18 · M 24 · L 32 | 146 | subtitle sizes |
| `BUFFER_CONFIG` | min 50 s · max 120 s · forPlayback 2 s · afterRebuffer 8 s · backBuffer 30 s | 159-165 | ExoPlayer LoadControl |
| `BUFFER_CONFIG_LOW_RAM` | + backBuffer 10 s · `maxHeapAllocationPercent 0.3` · `minBufferMemoryReservePercent 0.1` | 175-182 | perfTier low-RAM boxes (total < 2.5 GB or memoryClass ≤ 192 MB, `perfTier.ts:77-88`) |
| `MIN_LOAD_RETRY` | 50 | 186 | `minLoadRetryCount` |
| `SLOW_START_MS` / `SLOW_BIG_MS` | 25000 / 90000 | 208-210 | slow-start card thresholds |
| toast | 4200 ms | 879 | player-local toast |
| resume card | 4000 ms | 1405 | auto-dismiss |
| progress save | every 5000 ms, only if moved ≥ 4 s, and on unmount | 2133-2142 | |
| activity report | immediately, +1500 ms, then every 5000 ms | 2116-2130 | "Watching <label>" |
| keep-alive | every 60000 ms | 2155-2171 | torrent status + playlist ping |
| stall mark | buffering ≥ 3000 ms after first frame | 2068-2090 | server playback mark |
| decode-stall watchdog | tick 2000 ms, 3 ticks with clock frozen & >3 s buffered → transcode | 2190-2206 | |
| re-buffer watchdog | tick 5000 ms, no progress for 25000 ms on a transcode → re-issue playlist | 2273-2294 | |
| far-seek probe timeout | 45000 ms | 1072 | |
| far-seek quick-refusal retry | up to 3 retries, 1500 ms apart, only if the refusal took < 20 s | 1810-1816 | |
| error back-off | `min(3000, 700 × recoveries)` | 2597 | |
| prefetch region | 2 MiB, 60 s abort | 981, 1000 | |
| torrent ready-gate | kick `Range: bytes=0-1`; poll 1500 ms; `ready+timeout` at 20 s; absolute open at **45 s** | 1277-1319 | |
| torrent "stalled" copy | no frame ever and > **60 s** since mount | 2692 | `Still trying…` |
| cue tick | 200 ms | 361 | JS cue layer |
| `progressUpdateInterval` | 1000 ms | 2808 | |
| Up-next countdown | 15 s, 1 s ticks | 2310-2319 | |
| Up-next window | credits start, else `max(30, min(90, dur×0.05))` s before the end | 2487-2488 | |
| party | echo mute 1500 ms; host sync every 5 s; join retry 12 × 600 ms; drift tolerance sync 8/2.5 s, event 3/1.2 s (heavy/light) | 1504-1511, 1558, 1581-1588 | |
| `closeMenu` focus return | `requestTVFocus` at 0 ms and again at 180 ms | 947-953 | |

**Not present at HEAD** (checked by grep, so the native spec must not invent them): there is **no 48 s stall constant** (the thresholds are 25 s / 60 s / 90 s above) and **no kids/403 toast** in the player — a kids-profile refusal of `/stream/*` surfaces through the generic `onError` ladder (§8) and ends in `This title can't be played on this device.`

---

## 1. Screens before the picture

All three use `center` (`:3551-3557`): flex 1, **black** background, centred, gap 20.

| state | content | lines |
|---|---|---|
| `loadErr` (item request failed) | `errorText` (18/`700` `text`, centred, ph 32) with `loadErr.title` = `Couldn't reach the server` / `Couldn't load this title`; optional `statusSub` detail; row gap 14 of two pills `Retry` (preferred focus) and `Back` (`exitBtn`: `surface`, pv 12 / ph 32; text 15/`700`) | 2702-2724, 3918-3926 |
| `error` | `errorText` + one `Back` pill (preferred focus) | 2725-2738 |
| `!uri` (arming / torrent gate) | `loadingTitle` = route title, 24/`900`, maxWidth 70 %, centred, mb 8; `ActivityIndicator large` `text`; for a torrent `statusTitle` (18/`800`) + `statusSub` (15/`600` `textDim`, mt −8, ph 32) from `torrentStatusCopy`; any pending `toastMsg` as a `statusSub`; a `Cancel` pill with preferred focus | 2739-2769, 3569-3591 |

`torrentStatusCopy` (`:225-270`): stalled → `Still trying…` / `Few or no seeders — try another source`; peers > 0 → title `Fetching that part of the stream…` (seek wait) / `Re-buffering…` (ever played) / `Preparing stream…` (transcode) / `Buffering…`, sub = `N peer(s) · 2.1 MB/s|downloaded · 12s of video ready|transcoding…|getting the first frames…` + ` · skipping to 1:02:03 (7s)`; else `Connecting to peers…` / `Fetching that part of the stream…` with `This can take a moment` / `waiting on the swarm`.

---

## 2. The playing tree (`:2795-3545`)
```
root (flex 1, black)                                       :3549
  <Video> absolute fill, resizeMode contain                :2797-2821, :3550
  <Subtitles> cue layer                                     :2826-2837
  buffering overlay (pointerEvents none)                    :2842-2852
  centre flash (Animated)                                   :2856-2868
  skip hint (Animated)                                      :2871-2883
  controls (absolute fill, space-between)  when `controls`  :2886-3127
     topBar … bottom
  Skip intro key                                            :3131-3142
  resume card                                               :3145-3170
  menu: cc | speed | settings | party                       :3174-3468
  Up next card                                              :3471-3499
  slow-start card                                           :3503-3535
  toast                                                     :3539-3543
```

### 2.1 Video
`paused`, `rate`, `volume = muted ? 0 : 1`, `muted`, `resizeMode="contain"`, `bufferingStrategy DEPENDING_ON_MEMORY` on low-RAM else `DEFAULT`, `selectedTextTrack = {type: DISABLED}` (ExoPlayer never draws text; `:276`, `:2812`), source = `{uri, headers: mediaHeaders(), bufferConfig, minLoadRetryCount: 50}` memoised on `uri` (`:1746-1759`). **Every `setUri` is a new source** and ExoPlayer re-prepares from zero; the code appends `&g=<gen>` so an identical playlist URL can be re-issued (`:730-734`).

### 2.2 Buffering overlay (`:2842-2852`, `:3558-3567`, `:3593`)
Absolute fill, centred, gap 14; `ActivityIndicator large white`; for a torrent also a wash `rgba(5,6,12,0.82)` behind it plus `statusTitle`/`statusSub` (same styles as §1). A library file gets only the spinner over the picture. Shown whenever `buffering` (set true on seek/probe/transcode start and by `onBuffer`).

### 2.3 Centre flash (`:917-940`, `:2856-2868`, `:3776-3788`)
104×104 circle `rgba(0,0,0,0.55)` at the exact centre (`top/left 50%`, margins −52); icon `pause`/`play` 44 white (**the icon shows the NEW state**, `flashPaused = next`). On every toggle: value reset to 0, `timing` to 1 over **500 ms** (linear); opacity maps `[0, 0.3, 1] → [0, 1, 0]`, scale `0.7 → 1.15`. Fires even with the chrome hidden.

### 2.4 Skip hint (`:1881-1932`, `:2871-2883`, `:3790-3807`)
Pill `rgba(0,0,0,0.45)`, pv 12 / ph 28, radius 999, at `top 46%`, `left 12%` (backwards) or `right 12%` (forwards). Text 32/`900` white with shadow `rgba(0,0,0,0.8)` offset (0,2) radius 20: `« 40s` / `1m 30s »` — the **accumulated** jump of the chain. Animation: opacity set to 1 instantly, then `timing` to 0 over 150 ms **after a 550 ms delay**; a new press restarts it.

---

## 3. The chrome

### 3.1 Show / hide (`:895-915`)
`showControls()` refreshes `current/buffered/duration` from refs, sets `controls=true`, (re)arms the **7 000 ms** hide timer; the timer does nothing while a menu is open, while paused, or while Up-next is up (`:909`). Called on mount, every key, pause toggle, seek, pref change, menu close.

### 3.2 Top bar (`topBar`, `:2890-2927`; styles `:3610-3659`)
- Row, `alignItems center`, gap 14, paddingHorizontal 48, paddingTop 24, paddingBottom 28. Behind it `player-top.png` stretched over the bar: a 4×512 RGBA bake of `rgba(0,0,0,0.75) → transparent` top→bottom with smoothstep (`tools/gen-gradients.js:94-103`; sampled alpha 191 → 95 at mid → 0).
- `PBtn back` (46 dp circle; §3.5) — the only focusable here, zone `top`.
- Party pill when in a party: row gap 8, `rgba(139,123,255,0.28)`, border 1 `rgba(139,123,255,0.5)`, pill, pv 6 / ph 14; `people` icon 16 white; text 13/`800` ls 1 white `3 · ABCD` (`:3928-3939`).
- `titleWrap` flex 1: title 18/`800` white, letterSpacing −0.3, shadow `rgba(0,0,0,0.6)` (0,1) r 10, one line — the **show** title for an episode, else the route title (`:2910-2912`); subtitle 13/`600` `textDim`, mt 1, same shadow: `S1 E4 · Episode name` or the year (`:2788-2793`); badge row (gap 8, mt 6) with `STREAM` (torrent) and/or `OPTIMIZED` (transcode): `#60a5fa` 12/`900` ls 1.4, border 1 `rgba(96,165,250,0.3)`, fill `rgba(96,165,250,0.12)`, ph 8 pv 2, radius 6 (`:3646-3659`).

### 3.3 Bottom band (`bottom`, `:2929-3125`; styles `:3664-3768`)
`paddingHorizontal 48, paddingTop 16, paddingBottom 22`; behind it `player-bottom.png` stretched (4×512: transparent at top → `0.45` at 45 % → `0.88` at the foot, smoothstep; `gen-gradients.js:120-131`; sampled 0 → 117 at mid → 224).

**Scrub row** (`TVFocusGuideView autoFocus trapFocusLeft trapFocusRight`, row, gap 12, `:2942-2992`):
- Left time `fmt(shown)`: 13/`700` `textDim`, minWidth 44, `tabular-nums` (`:3729`). `fmt` = `H:MM:SS` or `M:SS` (`:188-195`).
- Scrubber Focusable: `flex 1, height 22, justifyContent center, borderRadius 8`, `noScale`, white ring (3 dp, at inset 0 of the 22 dp box), press = play/pause, zone `scrub`; **takes focus whenever the chrome appears** unless a menu/Up-next is up (`:2947`).
- Track: height **6** (8 while the scrubber is focused), radius 3, `rgba(255,255,255,0.22)`, **not clipped** (`:3672-3677`).
- Buffered: absolute, `rgba(255,255,255,0.25)`, radius 3, width `bufPct%` (`:3696-3703`).
- Fill: absolute, width `pct%`, gradient `90deg #8b7bff → #7fd1e8 → #8cffbe`, glow `0 0 14px rgba(140,255,190,0.5)`, radius 3 (`:3705-3714`).
- Head bead: inside the fill at `right −7, top 50%, marginTop −7`, 14×14 white circle, shadow `0 0 0 4px rgba(255,255,255,0.22), 0 0 24px rgba(140,255,190,0.7)`; focused → 16×16 at −8 (`:3717-3728`).
- Intro band: absolute `top 0 / bottom 0`, `rgba(255,255,255,0.35)`, from `start/dur` for `(end−start)/dur` of the width (`:2962-2972`, `:3690-3695`).
- Marks: 3 dp wide white ticks, `top −3 / bottom −3`, marginLeft −1, radius 2, `boxShadow 0 0 0 1px rgba(0,0,0,0.55)` at intro start, intro end and credits start (`:2976-2986`, `:3679-3688`).
- Right time `-H:MM:SS` remaining (blank with no duration), right-aligned.
- `shown` = `seekPreview ?? current`; `pct = min(100, shown/duration×100)` (`:2773-2775`).

**Button row** (`buttons`: row, `alignItems center`, gap 4, marginTop 6, `:3731`), left to right: `back10` · **pause/play big** · `forward10` · `skip` "Next episode" (only when a next library episode is known, `:3014-3021`) · mute (`volume`/`volumeOff`) with the level indicator · *spacer* · `cc` (only when tracks exist; badge `off` when none selected) · `speed` (badge `1.5x` when ≠ 1) · `xray` · `people` (badge = member count in a party) · `gear`.

### 3.4 Volume group (`:3032-3054`, `:3758-3767`)
`volWrap` width **0**, height 46, opacity 0 → when the mute button is focused: width 96, opacity 1, ph 6, marginRight 8 (an instant style swap, no animation). Track height 5, radius 3, `rgba(255,255,255,0.28)`, clipped; fill white, width `muted ? 0 : 100%`. **Indicator only** — the volume value is a constant 1 (`:668`); the remote's own volume keys set the TV level. **[KEEP-AS-IS?]** the bar always reads full or empty.

### 3.5 `PBtn` — the transport button (`:544-590`, `:3734-3754`)
46×46 (big 54×54) transparent circle; Focusable `round ring="none" highlightColor={white}` → focus fills the disc white over 160 ms and flips the icon to `bg`; icon 21 (big 28) white; optional badge text 10/`900` white at `bottom 4` (`bg` when focused). `accessibilityLabel` = the label.

### 3.6 Menus (`styles.menu`, `:3819-3838`)
Absolute `right 48, bottom 124, maxHeight 62%`, `minWidth 280, maxWidth 400`, radius 18, padding 14, fill `rgba(16,15,30,0.97)` + gradient `140deg rgba(104,86,226,0.30) 0% → rgba(16,15,30,0) 48% → rgba(70,200,150,0.20) 100%`, border 1 `rgba(255,255,255,0.10)` with top `rgba(255,255,255,0.20)`. `TVFocusGuideView` with all four traps; the global key handler ignores everything but media keys while a menu is open (`:1958`).

- `MenuTitle` (`:410-415`, `:3840-3846`): row gap 8, marginBottom 8, marginLeft 12, optional marginTop 14 (`gap`); icon 13 `textDim`; text 12/`800` letterSpacing 2 `textDim`, upper-case labels.
- `MenuItem` (`:417-448`, `:3848-3898`): Focusable `round noScale ring="none" highlightColor={surfaceHover}`; row gap 8, pv 8 / ph 12, marginBottom 1; a `✓` column width 18, 13/`800`, opacity 0 when not `on`; optional icon 14 (`text` when on else `textDim`); label 13/`700` `textDim` → `text` when on, one line, `flexShrink 1`; tag 12/`700` `textFaint` `marginLeft auto`.

**Subtitles menu** (`:3174-3284`): title `SUBTITLES`; scrollable list: `⟲  Resync subtitles` (only when a track is on), `Off` (icon close, on when none, preferred focus when none), every track (tag `Embedded` for in-container tracks; the current track takes preferred focus and its `onLayout` scrolls the list to `y − 160`), then — when a track is on — `SUBTITLE TIMING` (icon forward10, gapped) and the sync row: `−5s`, `−0.5s`, the current delay `+0.0s`, `+0.5s`, `+5s`, `Reset`. Sync row: wrap, gap 4, mb 8; buttons `flexGrow 1, flexShrink 0, minWidth 52, ph 8, pv 10, surface`, text 13/`800`; value `minWidth 62` 13/`800` centred (`:3866-3890`). Picking a track or Off closes the menu; nudges keep it open.

**Speed menu** (`:3287-3306`): `SPEED`; items `Normal` / `0.5×` … `2×`; the current rate has `✓` and focus; picking closes.

**Settings (gear) menu** (`:3314-3431`): sections in order — `AUDIO` (only with > 1 audio track; label `audioLabel`: `English · Commentary` / `Track 3`; tag `Original · EAC3 · 6ch`), `PLAYBACK` (episodes only: `Autoplay next episode` tag On/Off), `SKIP INTRO` (when an intro key exists: `Ignore the detected intro` with the range as tag; `Mark intro start (now)` or `Intro ends here (save)` + `Cancel marking`), `SUBTITLE STYLE` (`Size` tag Small/Medium/Large cycling S→M→L; `Background` tag On/Off). Preferred focus: the current audio row, else Autoplay, else Size (`:3327`, `:3343`, `:3417`). Toggles keep the menu open; audio/intro actions close it.

**Watch together menu** (`:3434-3468`): `WATCH TOGETHER`; in a party: the code letter-spaced (`A B C D`) 40/`900` ls 6 mb 8, a hint paragraph 13/lh 20 `textDim` mb 14, `End party` / `Leave party` (preferred focus), `Close`; not in one: hint paragraph, `Start a party` (preferred focus), `Close`.

### 3.7 Skip intro key (`:3131-3142`, `:3943-3953`)
Shown while `inIntro && uri` and no menu/Up-next: absolute `right 48`, `bottom 144` with the chrome up else **56**; white pill, row gap 8, pv 11 / ph 22; text `Skip intro` 15/`800` `bg` + `skip` icon 18 `bg`. `light` (white ring with bg gap, default white ring colour), **takes focus as it appears** (`hasTVPreferredFocus`), zone `skip`. OK seeks to `range.end`. `inIntro` = content time inside `[start, end−1)` and not paused (`:2477-2482`).

### 3.8 Resume card (`:3145-3170`, `:3955-3977`)
Library files only (a stream gets the toast `Resuming from 12:34`, `:1401`). Absolute `left 48`, `bottom 144`/56 like the key; row gap 14, fill `rgba(13,14,24,0.72)`, radius 18, border 1 `line`, padding 6 (right 8), **opacity 0.92**. Frame `/img/frame/<id>?t=<sec>` 80×45 radius 8 `bgRaised` fade 200; text column minWidth 70: `RESUMING FROM` 9/`800` ls 1.4 `textDim`, time 15/`800` mt 1; `Start over` pill `surface` pv 7 / ph 14, text 13/`700` `textDim`, zone `card`, **not** auto-focused. Auto-dismiss **4 000 ms** (`:1405`); Start over seeks to 0 and toasts `From the top`.

### 3.9 Up next (`:3471-3499`, `:3899-3917`)
Absolute `right 48, bottom 60`, fill `rgba(13,14,24,0.97)`, radius 18, padding 20, maxWidth 460, border 1 `line`; four-way trap. `UP NEXT` 13/`900` ls 2 `accent`; title `S2 E5 · Name` 18/`800` mv 8, one line; actions row gap 14 mt 8: `▶  Play now` (`btnPrimary`: white pv 12 / ph 30, text 15/`800` `bg`, `light ring="violet"`, preferred focus) and `Dismiss (15)` / `Dismiss` (`btn`: `surface` pv 12 / ph 22, text 15/`700`). Countdown only when `prefs.autoplayNext`; reaching 0 plays. Showing it forces the chrome on and blocks auto-hide (`:2311`, `:909`). Dismiss returns focus to the pause button (`:960`).

### 3.10 Slow-start card (`:3503-3535`)
Same box style as Up next (no kicker): `Still loading… this connection is slow` (25 s) / `This file may be too big for this connection` (90 s); `Keep waiting` (primary, focused; snoozes 25 s), `Lower quality` (only when a transcode route exists and not already capped; starts `h264-480` at the resume/current point, toasts `Lower quality — 480p`), `Back`.

### 3.11 Player toast (`:876-880`, `:3539-3543`, `:3979-3991`)
Absolute `bottom 24`, `alignSelf center`, maxWidth 70 %, fill `rgba(13,14,24,0.94)`, pill, border 1 `line`, pv 10 / ph 22; text 15/`700` centred. One at a time, **4 200 ms**, replaced by the next. (This is separate from the app-wide glass toasts in 11b; the player never uses those.)

### 3.12 Subtitles — the cue layer (`Subtitles`, `:325-377`, `:3994-4017`)
Absolute `left 0 / right 0`, `alignItems center`, paddingHorizontal 10 %; `bottom = 150` with the chrome up, **48** otherwise (`:2836`). Text: white `700`, centred, `fontSize = CUE_PX[size]`, `lineHeight = round(size × 1.4)`, ph 12 pv 2, radius 4, clipped; background `rgba(0,0,0,0.75)` when `cueBackground`, else a shadow `rgba(0,0,0,0.95)` (0,2) r 8. Cues are matched against the **content clock** interpolated between 1 Hz progress events, frozen while paused or buffering, never extrapolated more than 1.5 s (`:762-774`); `(clock − offset)` where `offset` is the per-track nudge, rounded to 0.1 s (`:1720-1730`). Markup `<…>` and `{\…}` is stripped (`:311-312`). Defaults: `subsDefault true`, `subLang 'any'`, `cueSize 'M'`, `cueBackground true`, `autoplayNext true` (`storage.ts:150-163`).

---

## 4. Every key (`onTV`, `:1940-1988`; BACK `:1992-2020`)
Processed only after `acceptTvEvent` (one press, one event).

| key | menu / Up-next / slow-start up | chrome hidden | chrome up |
|---|---|---|---|
| `playPause` | toggle | toggle | toggle |
| `pause` / `play` (discrete media keys) | pause if playing / play if paused | same | same |
| `fastForward` / `rewind` | skip(+1) / skip(−1) | same | same |
| LEFT / RIGHT | *(ignored; the overlay's own focusables)* | **skip** −/+ | skip only while the **scrubber** holds focus (`zone === 'scrub'`); elsewhere the D-pad moves focus and `showControls()` re-arms the timer |
| `select` (OK) | ignored by this handler (the focused Pressable fires) | toggle play/pause — unless focus is on the Skip-intro key or the resume card, whose own press fires | the focused control's press; timer re-armed |
| UP / DOWN / anything else | ignored | `showControls()` | `showControls()` |
| BACK | menu → `closeMenu()`; Up-next → dismiss | *(falls through to navigation pop)* | **hides the chrome** and nothing else (only once `uri` is set and no error) |

Skip (`:1883-1934`): nothing happens before a source is armed; a press within 900 ms in the same direction advances the step index; the target chains from the pending/preview target; the scrubber moves immediately (`seekTo`, `:1866-1876`) and the network commit follows 450 ms after the last press (`commitSeek`, `:1764-1864`). Far seeks on a transcode (outside `[streamOffset, edge+4s]`) hold the destination on the bar as `seekPreview`, set buffering, toast `Downloading that part of the movie…` for a torrent, probe the new offset with `&seek=1`, retry quick refusals, and on final failure toast `That part can't be fetched right now — the source may be too slow` and re-issue the old playlist.

Blur of the screen pauses playback (`:965`). Leaving the player leaves the party unless handing over to Up next (`:1591-1596`).

---

## 5. Focus zones and traps
Each focusable writes its zone on focus: `scrub`, `row`, `menu`, `top`, `skip`, `card` (`:831-837`). Preferred focus: the scrubber whenever the chrome appears (`:2947`); the current item inside a menu; Play now on Up next; Keep waiting on slow-start; the Skip-intro key as it appears. Closing a menu returns focus to the button that opened it, asked twice (0 ms and 180 ms) (`:947-953`). The player registers a **no-op focus fallback** so the global 120 ms rescue cannot focus the frozen Detail page underneath; with the chrome up the fallback re-focuses the scrubber (`:789-795`).

---

## 6. Source selection, resume and transcodes (what the chrome must reflect)
- Arming (`:1332-1409`): audio track = remembered language match, else `original`; torrent with `needsTranscode` → transcode at the resume offset (probe, fallback to 0) else direct URL; library file with incompatible audio / no videoUrl / non-default audio track → `copy` (or `h264`) transcode at the resume offset; else direct. Resume applies when `position > 10 s` and `< duration − 20 s` and not finished and not `restart` (`:1189-1196`, `:1226-1233`).
- `transcodeUrl` = `<base>/<ss>/index.m3u8?v=<copy|h264|h264-720|h264-480>[&a=<idx>]` (`:1015-1021`); the viewer-chosen seek adds `&seek=1` (claim) once, ExoPlayer gets the URL without it (`:1029-1047`).
- `duration` = `max(streamOffset + playlist length, metadata runtime)` and **grows** with `seekableDuration` (`:2400-2406`, `:2453-2464`). Content time = `streamOffset + currentTime` (`:2440`).
- Audio switch restarts the transcode at the current second and toasts `Audio: <label>` (`:1102-1122`).

---

## 7. Subtitle selection rules (as they decide what the menu shows ticked)
Tracks are de-duplicated by URL and duplicate labels numbered `Hebrew (2)` (`:454-467`). On first availability (`:1622-1648`): a profile-remembered language or this TV's last hand-pick wins (`off` stays off); else, if `subsDefault`, the preferred language, then Hebrew, then the first track (`:475-542`). A track fetched by the server for the preferred language switches on when it lands and toasts `Hebrew subtitles found — switched on` unless it would overrule a pick. Hand picks persist to prefs and to the profile (`:1654-1677`). Loading a track with no cues toasts `That subtitle file has no cues — try another track`; a failed fetch toasts `That subtitle track couldn't be loaded`; Resync toasts `“<key>” re-downloaded, delay reset to 0.0s`.

---

## 8. Error ladder (`onError`, `:2548-2668`) and end (`onEnd`, `:2501-2546`)
- During a probe: swallow, keep buffering.
- Transient (playlist stuck / `Source error` / anything after the first frame) on a transcode: within the budget, re-issue the playlist after `min(3000, 700×n)` ms holding the position; budget spent and never played → try `h264` once; else toast `This source isn't responding — still trying, or pick another` and retry every 30 s.
- Already played, direct: switch to transcode (`fallbackToTranscode`, toast `This encode won't decode here — switching to transcode…`), else `Lost the stream. Press Back and pick the source again.`
- Never played: no base → `This title can't be played on this device.`; direct → `copy`; `copy` → `h264`; `h264` → the same error text.
- `onEnd`: a transcode ending > 90 s before the known duration within budget → toast `Stream ended early — recovering…` and restart at the current position; else save progress, play Up next if shown, else `goBack`.

Other toasts: `Couldn't read your watch history — resume and progress saving are off`, `Party ABCD — others join with that code`, `Joined <host>'s party`, `<name> paused` / `pressed play` / `jumped to 1:02:03`, `Party ended` / `Left the party`, `Skip intro is off for this show on this TV`, `Intro starts 0:42 — play to where it ends, then save`, `Saved — every episode of this show now offers Skip intro`, `The end has to come after the start`, `Lower quality isn't available right now`.

---

## 9. Native mapping notes — Player
- Keep ExoPlayer/media3 with the same `DefaultLoadControl` numbers (§0) and `DEPENDING_ON_MEMORY` semantics on low-RAM boxes; disable the text renderer (`TRACK_TYPE_TEXT` off) — cues are drawn by the chrome.
- Chrome = one `FrameLayout` over the `PlayerView`/`SurfaceView`, with the two scrim `ImageView`s (`fitXY`) behind the bars; **do not** re-derive the scrims as gradients (smoothstep bake).
- Scrubber: a custom `View` (not `SeekBar`) drawing track/buffer/fill/bead/band/ticks exactly as §3.3; focus grows the track 6→8 and the bead 14→16 instantly (no animation in RN — a style swap).
- The transport buttons' white-fill focus = `highlightColor` alpha fade 160 ms with the icon tint swapped at focus start (RN swaps the icon colour via React state on the same frame, so effectively instant).
- Menus: `GradientDrawable` cannot do the 140° three-stop gradient over a 97 % navy; use a `ShapeDrawable` with a `LinearGradient` shader (`ShaderFactory`) or bake a 9-patch.
- Animations: flash = `ObjectAnimator` 500 ms linear with a keyframe alpha (0→1 at 30 %→0) and scale 0.7→1.15; skip hint = alpha 1→0, 150 ms, `startDelay 550`; everything else in the player is an instant state swap.
- Timers map 1:1 to `Handler.postDelayed`; the cue clock interpolation (frozen while paused/buffering, ≤ 1.5 s extrapolation) must be re-implemented against `Player.getCurrentPosition()` sampled at 1 Hz — or, if sampled per frame natively, the "frozen while buffering" rule still applies so cues do not run ahead during a stall.
- **Cannot be identical**: `boxShadow` glows on the fill/bead/ticks (blurred coloured shadows) need `BlurMaskFilter` paints; Roboto `tabular-nums` is available via `fontFeatureSettings="tnum"`; the vignette is already an approximation (`bufferWash` flat fill, `:3592`), so a flat fill is correct, not a radial.
