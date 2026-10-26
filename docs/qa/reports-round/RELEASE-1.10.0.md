# Release 1.10.0 / TV 5.5.0 — 2026-10-26

Released and pushed (master 0ee97e5, tag server-1.10.0-stable). The house server runs 1.10.0. Phones, computers and TVs get it once nufurora.com pulls (`git pull`; no new dependencies).

| From the reports | What changed | Website | TV | Mi TV |
|---|---|---|---|---|
| A film with burned-in subtitles, and only admin could swap it | **Get another version**: anyone grown-up picks a reason and another copy; the old one plays until the new one is in, then it takes its place (progress, My List, ratings kept). The bad release is never picked again. Admin sees every swap. | ✅ | ✅ | ✅ |
| My List downloaded films that weren't out yet (CAM) | **My List only adds** — no download. | ✅ | ✅ | ✅ |
| Same | **Cinema copies are never picked for you**: CAM / TS / screener copies are last, marked, and ask first; burned-in copies after clean ones; a cinema-only film says "Not out in good quality yet" with its dates. | ✅ | ✅ | ✅ |
| Search said "not found", then found it on the next try (La Cocina) | Late catalogue answers aren't "no results" any more: "Still searching…", one retry, then "Couldn't reach the catalogue — try again". Typing can't shut the catalogue off. | ✅ | ✅ | ✅ (voice not checkable) |
| "Slow connection" message on entering the site | Measured right (overlapping downloads together, after the page settles, 20 s of proof); no message at entry, only when a film really starts lower. | ✅ | (never had it) | — |
| Matan: AirPlay from iPhone plays only sound, and it gets stuck | The iPhone hands the Apple TV a signed address before AirPlay starts; "No picture there?" button; no needless quality drops, retries in place, stalls recover. | ✅ | — | needs an iPhone + Apple TV |

| Tests (final tree) | Result |
|---|---|
| Server + website unit tests | 1975/1975 (three runs on the final tree) |
| Full browser suite | 393 pass, 0 fail, twice |
| TV logic / type check / release build | 711/711 · clean · OK |
| Mi TV | 31 of 32 checks pass after 4 TV fixes, also with sign-in required; voice search can't be spoken by a script |

## Please check
1. **AirPlay** (iPhone + Apple TV, on nufurora.com): start an episode, AirPlay from the player's button — the TV should show the picture at the same minute. With a subtitle on, it shows or the phone says it couldn't. If only sound: press "No picture there?" and tell me the Apple TV model.
2. **An incident on the Mi TV:** during the TV checks, stray key presses opened the old lab app (`com.auroratv.lab`), which started "Night Hunter" at 58:41 on a real server under the profile it remembers, maybe paused it and switched subtitles to "English 2". It was stopped within about a minute; no password was typed. Please check that profile's Night Hunter position and subtitle choice. I'd also suggest removing the lab app from the Mi TV — say the word and I'll do it.
3. **Network:** this PC moved to another Wi-Fi (172.16.0.x) and the Mi TV (192.168.50.x) can't reach it directly. The Mi TV now runs a test build (5.5.0, vc128) that reaches the house server through the debugging link and never nufurora. If household devices rely on reaching this PC on the home network, check its Wi-Fi.

## Still open
- Your item "a select option when suggestion detection is used (admin)" — I need to know what it means.
- Earlier decisions: keeping profile unlocks across server restarts; "Start over" on the phone remote; Dolby first unless night mode is turned on in the player (recorded, not built yet).
