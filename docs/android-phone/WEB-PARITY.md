# Aurora for Android phones — parity with the mobile website (phone 1.0.1)

elia, 2026-10-29: *"The android mobile does not look really good, we need to work on getting it closer to how the website on mobile looks, dimensions and all, it looks a lot better this way."*

Branch `phone-web-look`. Pairs (website | app 1.0.0 | app 1.0.1) in [`docs/qa/phone-web-look/`](../qa/phone-web-look/), other phone sizes in [`docs/qa/phone-web-look/sizes/`](../qa/phone-web-look/sizes/).

## How it was measured

- **Website**: Chrome (playwright-core, channel `chrome`) in mobile emulation at the Pixel 9's own size — **411 × 923 css px, device scale 2.625**, touch, Android user agent — glass look, the "Glass" profile, on a private instance (`tools/mobile-perf/instance.js`: the UI tests' throwaway server with the 400-title made-up catalogue; never the live server). Every number below is a **computed style or a bounding box** read from the page (`getComputedStyle` / `getBoundingClientRect`), not read off a picture.
- **App**: the QA build (`tv-native/tools/build-phone-qa.sh`, `http://127.0.0.1:4000` only) on the Pixel 9 AVD (1080 × 2424, 420 dpi = 411 × 923 dp), `adb reverse tcp:4000` to the same private instance, the same profile. Screencaps with `adb -s emulator-5554 exec-out screencap`.
- **css px → dp 1:1**, then checked by eye side by side.
- Fonts: the site asks for `-apple-system, … Roboto`; on an Android phone that is Roboto, as in the app. The website captures were made on Windows Chrome, so they show Segoe UI — letter shapes differ a little, sizes do not.

## The biggest single difference: the sky

The app's background picture (`src/phone/assets/sky.png`) had been sampled from the mobile-perf harness's screenshots — and that harness (`shots.js`) **replaces the site's living sky with a fixed test gradient** (navy → green → violet). So the app wore a green-and-violet sky the real site never shows. The real site is a dark navy night (`#070811` under `aurora-sky.js` at 0.9 opacity): a violet glow at the top, a faint blue low on the left, stars. `tools/gen_phone_sky.py` now bakes the sky from a **capture of the real site's canvas** (540 × 1213, 185 KB; the profile wall / sign-in version under the site's `.ui-overlay` 0.55 dim and 18 px blur).

## The table (website value · app 1.0.0 · app 1.0.1)

All sizes in css px = dp. "—" = not there.

### Colours and glass

| Thing | Website | App 1.0.0 | App 1.0.1 |
|---|---|---|---|
| Page ground | `#070811` + the live sky | `#0b0c14` + a green/violet test-gradient picture | `#070811` + the site's sky, baked |
| Dim grey (`--text-dim`) | `#c2c7d6` | `#9aa1b5` (the classic look's) | `#c2c7d6` |
| Faint grey (`--text-faint`) | `#8c93a8` | `#616880` | `#8c93a8` |
| Glass fill (`--g-fill`) | `linear-gradient(135deg, rgba(255,255,255,.09), .025 55%, .06)` + `blur(7px) saturate(1.9) brightness(1.08)` | flat `rgba(255,255,255,.075)` | the same gradient over a faint violet tint; no blur (see "could not match") |
| Glass edge (`--g-edge`) | inset 1 px: top `.38`, left `.14`, bottom `.05`, ring `.06` | hairline ×2 all round `.16` | 1 dp border: top `.38`, left `.16`, right `.07`, bottom `.06` |
| Watch bar | 3 px (2.5 on a wide card), `#8b7bff → #a6c8ff`, glow `0 0 10px rgba(139,123,255,.6)`, a 7 px white head with a glow | 4 dp, `#6c58ff → #a99bff`, 10 dp head, no glow | 3 dp / 2.5 dp, the site's gradient, glow and 7 dp head |

### Top bar (`.nav-logo` · `.nav-gear` · `.nav-profile`)

| Thing | Website | App 1.0.0 | App 1.0.1 |
|---|---|---|---|
| Logo | glass pill 50 × 40, mark 26, padding 7 16 7 8, top `max(10, inset) + 4` | round 58 × 46, mark 30, dark fill | pill 50 × 40, mark 26, the glass |
| Settings | glass circle 42, line gear 19 (stroke 2) | dark circle 46, filled Material gear 23 | glass circle 42, the site's line gear 19 |
| You | glass circle 40, avatar 30, 10 right of settings | 46, avatar 38 | 40, avatar 30, 10 apart |
| Row top | `max(10, inset) + 2` | inset + 8 | `max(10, inset) + 2` |
| Once scrolled | no band — the pills float (`.nav.solid::after` is off on a phone) | a solid `#0c0d1a` app bar with a hairline | a soft page-coloured scrim (0.96 → 0) only behind the clock and pills |
| On a pushed page | the same three pills | Back + the page's name | Back as a 42 glass circle where the logo is, settings + you on the right, no name |

### Tab bar (`.nav-items`)

| Thing | Website | App 1.0.0 | App 1.0.1 |
|---|---|---|---|
| Island | 387 × 53.2, 12 from the sides, `bottom: max(10, inset − 14)`, padding 6, items 2 apart, pill radius | 56 tall, 10 from the sides, inset + 10 from the bottom, padding 5 | 53 tall, 12 from the sides, the site's bottom rule (inset + 10 above a 3-button bar) |
| Fill | glass over the sky — blue at the left (19,77,159), navy to the right (24,29,64) | violet gradient `rgba(120,92,235,.88) → rgba(56,40,130,.86)` | a still fill of those sampled colours, the glass edge |
| Item | 73.4 × 40.2, 12.16 / 700, `rgba(243,244,248,.82)`, lit one white | 15 / 800 white at 0.8 | 12.16 / 700 at .82, lit one white |
| Lit pill | `rgba(255,255,255,.14)`, inset top light `.35`, ring `.08` | `.16` with a `.18` ring | `.14`, top edge `.35`, ring `.08` |
| Search | line magnifier 18 (stroke 2.4) | filled 26 | line magnifier 18 |
| Sideways | the wide layout: the island at the top beside the logo | at the bottom, over the page | at the top, between the logo and the pills |

### Home

| Thing | Website | App 1.0.0 | App 1.0.1 |
|---|---|---|---|
| Billboard | 395 × 530 (`min(60vh, 530px)`), 8 from the sides and top, radius 24 | 554 tall (`min(60%, 1.45 × width)`), radius 26 | `min(60%, 530)`, 8 in, radius 24 |
| Billboard picture (upright) | the **poster**, large size (`heroShowsPoster`/`heroCover`) | the backdrop, cropped | the poster, large size |
| Fade | `to top: rgba(7,8,17,.95) 0%, .4 50%, 0 80%` | five-stop dark fade, 0.35 at the top | the site's |
| Words | 20 from the sides, 44 above the foot | 18 in, 40 above the foot | 20 in, 44 above |
| Kicker | 28.8 tall pill, white `.1` fill, `.12` ring, 11.2 / 800, spacing .9 | 28 tall, tinted border, 12 / 900, spacing 1.5 | the site's |
| Title | 33.6 / 900, line 33.6, spacing −1.0, 14 under the kicker | 34 / 900, line 38, spacing −0.5 | 33.6 / 900, spacing −1, 13 under |
| Facts | 14.4 / 600 `#c2c7d6`, ★ 14.4 / 800 `#f5c542`, 10 apart, 12 under the title | 15 / 600 white .86 | the site's |
| Buttons | 50 tall pills, 26 in, 12 apart; words 16 / 700, spacing .16 | 52 tall, 17 / 800 | the site's |
| Dots | 7 px, 18 apart, the lit one 22 wide with a glow, 19 above the foot | 7, 8 apart, 16 above the foot | the site's |
| Greeting | 14 under the billboard; 22.4 / 900 on 33.6, the name in the violet→blue gradient; the line 15.68 / 600 `#c2c7d6` | 26 under, 26 / 800, the line 16 dim | 22.4 / 900, the name in the gradient's middle violet (`#a68cff`), the line 15.68 / 600 |
| Row title | 17.6 / 800, line 26.4, spacing −.18, 18 under the row before (12 under the greeting) | 20 / 800, 22 apart | the site's |
| Row's small line | hidden on a phone (`.row-sub`) | shown | hidden |
| Title → cards | 18 | 12 | 18 |
| Poster card | 114 × 171, radius 12, fill `.05`, no edge, 9 apart | 116 × 174, radius 16, `.22` edge, 8 apart | the site's |
| Kind tag | 15 px dark disc 6 in from the corner, 9 px icon, `.14` ring | 24 disc, 13 icon, 7 in | the site's |
| NEW tag | 16 tall violet pill, 6 in, 8 px words | 22 tall, 11 px | the site's |
| Continue Watching card | 254 × 158.8 (16:10), radius 16, fade `to top .95 / .72 24% / .18 52% / 0 68%` | 256 × 160, radius 22, its own fade | the site's |
| Its words | 14 in, 21 above the foot; title 16.32 / 800, "S1 E1 · …" 11.84 / 600, "▶ 1 min left" 11.84 / 600 | 20 / 800, 14 / 600, 14 / 600 | the site's |
| Its ✕ | 24 dark disc 6 in, ✕ 11.2 / 800 | 34 disc, 18 icon, 8 in | 24 disc (48 dp touch area) |

### Movies · Shows · My List (`.browse-head`, `.grid`)

| Thing | Website | App 1.0.0 | App 1.0.1 |
|---|---|---|---|
| Heading | 24 / 900 on 36, spacing −.72, 98 under the pills | 32 / 900 | the site's |
| Count line | 16 / 600 `#8c93a8` — "2 downloaded · 50 to stream · more available" | "2 on the server", 16 dim | the site's words and look |
| Surprise me | glass pill 148 × 39.6, 🎲, 14.4 / 700 | — | the same (picks a title not started yet, as `surprise.js`) |
| Search the page | 58 tall glass pill, magnifier 22, words 20 / 600, "Search movies…" | — | the same (the server's titles at once, the catalogue's after, as `browse.js`) |
| Categories | pills 40.8 tall, 15.2 / 800; off `.07` + `.1` ring, on `.16` + top light | 40 tall chips, 14 / 700, the lit one solid white | the site's |
| Genre | "Genre  All ▾" — 13.6 / 600 faint + 13.6 / 700 + caret | "All genres" chip with a chevron | the site's |
| Grid | 3 columns (≥ 104 px) 12 apart, rows 14 apart, 22 under the filters; 136 px columns past 600, 160 past 900 | ≥ 104, 10 apart all round | the site's rule at every width |
| My List sort | "Sort  Recently listed ▾" on its own row, the filters under it | a chip with a chevron in the filter row | the site's |

### Title page (`.detail-head`, `.detail-actions-more`, `.season-bar`, `.episode`)

| Thing | Website | App 1.0.0 | App 1.0.1 |
|---|---|---|---|
| Cover | 52 % of the height (`min-height: 52vh`), the poster upright | 56 % (`min(56 %, 1.25 × width)`), the key art | 52 %, the large poster upright; sideways the whole screen, words low in the column |
| Fade | page colour .4 at the top, 0 at 24 %, .18 at 48 %, .82 at 82 %, 1 | its own | the site's |
| Kicker | tinted in the kind's colour `.14` with a `.35` ring, 11.84 / 800 | dark fill, tinted border, 12 / 900 | the site's |
| Title | 34.5 / 900, spacing −1.04, 14 under the kicker | 32 / 900, spacing −.4 | the site's |
| ★ and facts | 14.4 / 600, ★ in the film gold `#f0c67e`, "★ 9" (no ".0"); a show's facts without its runtime | ★ 16 / 800 `#f5c542` on its own line, "9.0", "· 34 min" on a show | the site's |
| Play | full width, 54.5 tall, **radius 16**, 16.32 / 700, 20 under the cover | pill, 56 tall, 17 / 800 | the site's |
| Action strip | 76 wide, 2 apart, reaching the screen edges; the icon in a 52 disc `rgba(255,255,255,.09)` + `.13` ring; words 11.2 / 600 at .8, line 13.4 | 82 wide, 56 disc, 12.5 / 600 | the site's |
| Synopsis | 15.68 on 24.3, `rgba(243,244,248,.82)`, 24 under the strip; More 13.76 / 800 | 16 / 24 white, More 15 / 800 | the site's |
| Cast / director | 13.76 on 20.6; "Cast" 700 `#8c93a8`, names `#c2c7d6` | 15 / 22 | the site's |
| Genres | small static pills 11.52 / 700, `.16` ring, after the cast | "Romance · Adventure · Thriller" in a line | pills |
| Seasons | one glass island (5 in, radius 25) holding 40 tall pills 14.72 / 700, the lit one `.14` + top light; "Mark season watched" a pill of its own under it | a row of chips, the lit one white, under an "Episodes" heading | the site's, no heading |
| Episodes | cards **264 wide in a row that scrolls sideways**: still 16:9 on top, EPISODE n 10.24 / 800, name 16 / 800, three lines of story 12.8 / 17.9, the date 12.16, a round button in the corner | a vertical list of rows, 136 × 77 still | the site's cards |
| More like this | row title 17.6 / 800, posters 114 × 171, 9 apart | 20 / 800, 116 × 174 | the site's |

### Search

| Thing | Website | App 1.0.0 | App 1.0.1 |
|---|---|---|---|
| Field | 58 tall glass pill, 98 under the pills, the mic (40 disc `.08`) inside it, "Search movies and shows…" | 54 tall field + a separate 54 mic circle, "Films, shows, people, genres", no top bar | the site's, with the top bar |
| Clear | 36 disc `.08`, ✕ 15.2 / 800 | an icon | the site's |
| Section titles | 17.6 / 800 | 18 / 800 | 17.6 / 800 |

### Settings (`.pref-section`)

| Thing | Website | App 1.0.0 | App 1.0.1 |
|---|---|---|---|
| Heading | "Settings" 24 / 900, "for Glass" 16 / 600 faint | 34 / 900, 17 dim | the site's |
| Card | glass, radius 20, 18 / 20 inside, 16 apart | flat veil, radius 22 | the site's |
| Card head | 34 icon tile (radius 10, `.06`), 17.6 / 800 | 40 tile (radius 12), 19 / 800 | the site's |
| Row | 14 above and below, 34 icon tile, 12 apart; label 16 / 700 on 24; note 13.6 on 19.7 `#c2c7d6`; "›" 24 faint | 40 tile, 14 apart, note 14 | the site's |
| You | 56 avatar (radius 14), name 16.8 / 800, "No password set" 13.44 | 64 avatar, 18 / 800 | the site's |

### Profile menu (`.nav-menu`)

| Thing | Website | App 1.0.0 | App 1.0.1 |
|---|---|---|---|
| Shape | a 220 wide glass panel under the avatar (right 18, top = pills + 52), radius 20, the page dimmed behind | a bottom sheet | the panel |
| Lines | name 16 / 800 over a hairline; lines 44 tall, 14.88 / 400 at .9 | 16 / 700 rows | the site's |
| Words | Switch profile · Settings · My downloads · On this device · What's new · Get the apps · Report a problem · Join a watch party | Settings · Downloads · Your TVs · Switch profile | Switch profile · Settings · My downloads · Your TVs · Report a problem · Join a watch party |

### Profile wall and sign-in

| Thing | Website | App 1.0.0 | App 1.0.1 |
|---|---|---|---|
| Wall heading | "Who's watching?" 28.8 / 900 on 43.2, no logo | the logo above, 30 / 800 | the site's |
| Tiles | 104 wide, 10 inside, radius 24, 14 apart; avatar 84 radius 20 (the lit one a step larger), name 14.4 / 700 | 112–124 wide, radius 22, avatar 84–96 radius 22 % | the site's |
| Sign-in | the gradient "aurora" wordmark + "YOUR LIVING-ROOM CINEMA"; a glass card (radius 30, 28 inside) — "Welcome back", 50 tall fields (radius 13) with icons and the eye, the mint→violet "Sign in" | logo, "Sign in to Aurora", bare fields, a white pill, a glass "Use a code instead" | the site's card; "Use a code instead" as the card's foot link |

**Phone 1.0.2 (sign-in round, docs/auth-round.md section 3).** The sign-in, request-access, Google sign-up, set / new password and reset screens, and the wall's password door, are one panel in the website's new sign-in look:

| Thing | Website (auth-round) | App 1.0.2 |
|---|---|---|
| Ground | the night sky with the aurora, calmer | the sky picture (`sky-dim.png`), a status-bar scrim when the form scrolls under the clock |
| Panel | one glass panel, the app's radius | glass (`rgba(16,18,36,0.72)` + the site's sheen and edge light), radius 24, 24 inside (18 under 360 dp), at most 440 wide, centred |
| Head | the Beam mark + "Aurora", small | Beam 22 dp + "Aurora" 17 / 800 |
| Switch | Sign in · Request access | a segmented control, 40 tall, radius 12 / 9 |
| Title / line | 24 / 800, left-aligned, one short line | 24 / 800 on 31, the line 15 on 22 |
| Labels / help / errors | above / under / in place of the help | label 14 / 600, field 50 tall radius 12, help 13.5 on 19, error `#ffb4ab` in place of the help, the field's edge in the same colour; focus: a 2 dp `#8fa8ff` edge |
| Password | Show / Hide, strength hint | "Show" / "Hide" with the eye; four bars + Too short · Weak · Okay · Good · Strong |
| Primary button | mint→violet, one per view | 50 tall, radius 12, the site's 115° sweep, dark words; busy: spinner + "Signing in…" |
| Google button | `#131314`, `#8E918F` 1 px, `#E3E3E3`, four-colour G | the same, 50 tall, radius 12, G 18 dp |
| Links | text buttons | `#a9c4ff` 14.5 / 600, 44 dp targets ("Forgot password?" on the label's line, its target made by hitSlop) |
| Reset ways | rows with a line each | rows 64 tall, radius 12, title 16 / 700 + line 13.5, chevron |

Differences kept on purpose: the site's form can sit beside the sky's glow on wide screens; the app keeps one column at every size (a tablet shows the same 440 dp panel in the middle). No blur behind the panel (the low-end budget, as everywhere in the app).

## Not matched, and why

- **The glass blur.** The site frosts its pills, tab bar and menus with `backdrop-filter: blur(7px) saturate(1.9) brightness(1.08)`. A live blur under every floating piece costs a weak phone every frame (the low-end budget is the rule), so the app paints the colour that glass shows over this sky (sampled) with the same edge light. Over a scrolling poster the site's bar is blurred colour; the app's is a darker, steadier glass.
- **Gradient text.** The greeting's name and the sign-in wordmark are gradient-filled text on the site; React Native cannot fill text with a gradient without a masked view. The name uses the gradient's middle violet; the wordmark is a picture of the site's (`src/phone/assets/wordmark.png`, made from a capture).
- **Features the site has and the phone app does not yet** (shape only, no new flows here): "Your rating" stars and the "on disk" line on title pages, the Sources list under a show's episodes (the app keeps its Sources sheet), "Add profile" / "Request access", "What's new", "Get the apps", "Edit profile & password", "Upload a photo", Wrapped, Swipe your taste, the Look picker. They are left out rather than drawn without a working screen behind them.
- **Landscape** — the site at 923 × 411 css px switches to its wide (tablet/desktop) layout: a top nav island with the words, a synopsis on the billboard, a full-screen cover. The app now puts the tab bar at the top, makes the billboard nearly the whole height (345 of 411) and the title cover the whole screen, but keeps its phone rows and no synopsis on the billboard.
- **Hebrew.** The site stays left-to-right in English on a Hebrew phone. On this emulator the app also stays left-to-right after the device language is switched (React Native's `I18nUtil` asks `Locale.getAvailableLocales()[0]`, which did not report Hebrew here — the 1.0.0 build behaves the same; not changed by this work). The pairs show the Hebrew device; the app's own mirroring rules are untouched.
- **Back.** The site leaves Back to the browser; the app keeps a Back pill (and the system back gesture) on pushed pages, styled as the site's pills.
- **Emoji.** Avatars are emoji; Android draws its own emoji, Windows Chrome draws Microsoft's.

## Performance (low-end AVD)

The previous round's budgets (PLAN.md, the low-end AVD `Aurora_LowEnd_API37`: 720 × 1280 @ 320, 2 cores, software GPU; the emulator raises it to 4 GB). Same machine, same hour, same private instance, `measure.sh` (cold start ×3, 12 flings down / 6 up on Home with `dumpsys gfxinfo`, the Movies grid, three title pages, PSS after ten screens).

| | 1.0.0 (before) | 1.0.1 (after) | Budget |
|---|---|---|---|
| Home scroll, janky frames | 36 / 1135 = **3.17 %** (p90 17 ms, p99 19) | 42 / 1149 = **3.66 %** (p90 21 ms, p99 30, > 32 ms: 3) | < 5 % |
| Movies grid, janky frames | 2.01 % | 2.07 % | — |
| Cold start: `am start` TotalTime | 293 / 299 / 293 ms | 385 / 277 / 290 ms | — |
| Cold start: tap → Home painted | 795 / 674 / 681 ms | 741 / 568 / 633 ms | < 3 s |
| Cold start: tap → fresh Home | 648 / 657 / 622 ms | 703 / 642 / 649 ms | — |
| Title page open → ready | 45 / 57 / 63 ms | 31 / 30 / 41 ms | — |
| PSS after 10 screens | 232 MB | 229 MB | — |

The previous round measured 3.76 % on the same AVD. The new sky is a 540 × 1213 picture (2.6 MB decoded, was 0.65 MB) drawn once; the glass fills are still gradients (no blur); the few glows (`boxShadow` on a watch bar head, the lit dot) are static.

## Sizes

Same app build on the Pixel 9 AVD with `adb shell wm size / wm density` (reset after), the website in Chrome at the same css size. Pictures: [`docs/qa/phone-web-look/sizes/`](../qa/phone-web-look/sizes/) — one strip per size: web Home · app Home · web show · app show · app episodes · web Movies · app Movies · app Settings.

| Size | dp (px @ dpi) | Result | What was fixed |
|---|---|---|---|
| Small phone | 360 × 640 (720 × 1280 @ 320) | pass | — (billboard `min(60 %, 530)` = 384 like the site's; 3 grid columns; tab labels fit) |
| Mid-range | 360 × 800 (1080 × 2400 @ 480) | pass | — |
| Modern | 393 × 851 (1080 × 2340 @ 440) | pass | — |
| Pixel 9 | 411 × 923 (1080 × 2424 @ 420) | pass | the reference size (all pairs) |
| Tall 20:9 | 411 × 914 (1080 × 2400 @ 420) | pass | — |
| Large | 480 × 1040 (1440 × 3120 @ 480) | pass | — |
| Foldable inner | 669 × 803 (1840 × 2208 @ 440) | pass after fix | the grid had 5 columns where the site has 4: the app now follows the site's whole grid rule (≥ 104 dp ≤ 600, 136 dp to 900, 160 dp past, 18 dp gaps past 900); the tab bar was capped at 560 dp where the site's spans the phone (now 696) |
| Largest font (1.3) + display size large | 360 × 808 (1080 × 2424 @ 480) | pass after fix | "Recommend" broke into "Recommen / d" under its action disc: those words and the tab labels now grow at most ×1.15 / ×1.2 and never break inside a word; everything else scales |
| Landscape, small phone | 640 × 360 | pass | tab bar at the top between the logo and the pills; the title cover fills the screen; the player's controls (top, centre, bottom rows) all on screen |
| 3-button navigation | 411 × 923, nav bar 48 dp | pass after fix | the tab bar used the site's home-indicator rule (`inset − 14`) and sat 14 dp into the buttons' strip; an inset of 40 dp or more (a 2/3-button bar) now puts it 10 dp above the bar, as the site sits above a browser's own bar |
| Gesture navigation + punch-hole cutout | Pixel 9 | pass | the pills start at `max(10, status inset) + 2`, the tab bar 10 above the gesture strip |

Every size: no clipping or overlap of the top pills and the status bar / cutout, the tab bar clear of the navigation bar, rows of the site's card sizes (the cards keep their dp size and more of them show on a wider phone, as on the site), long titles end in "…" on one line where the site's do.
