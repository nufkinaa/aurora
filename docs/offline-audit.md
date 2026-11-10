# Offline watching on the website — audit (2026-11-10, agent `offline-web`)

"Offline watching" = a copy of a film or episode saved INSIDE the browser
(service worker + Cache API + IndexedDB) that plays with no server in reach.
This file is the measured state of master `d38464d0` (server 1.15.27) before
any change, then what was changed (bottom).

## How it was measured

- A private instance from the worktree (`scripts/ui-test-server.js start()`)
  with real files made by ffmpeg on E: (deleted afterwards):
  - Offline Short (2020) — 2 min H.264/AAC MP4, 39 MB, English .srt
  - Offline Mix (2021) — 5 min 1080p HEVC MKV, two AC-3 tracks (eng, heb),
    embedded English + Hebrew subtitles, an external Hebrew .srt, 130 MB
  - Offline Show — 4 episodes, H.264 + AC-3 MKV, English .srt each
  - Offline Big (2019) — 15 min 1080p H.264/AAC MP4 at 24 Mbit/s, **2.71 GB**
- Real Chrome (playwright-core, channel "chrome") in PERSISTENT profiles on
  E: (a real profile's storage quota, not an incognito one), as a desktop
  (1366×820), an Android phone (412×915, touch, Android UA) and an
  iPhone-sized phone (390×844, touch, iOS UA — still Chrome's engine).
- Everything went through a small TCP front (rig/proxy.js) that can throttle
  the line, cut every open connection ("server gone") and come back.
- Memory: the working set of every Chrome process of that profile, sampled
  every 3 s, plus the page's JS heap (CDP Performance.getMetrics).

Real iOS Safari cannot be run here. What depends on it is listed under
"Unverified" with the rules the code was read against.

## The journey, step by step (before)

| Step | Desktop | Phone browser | Verdict |
|---|---|---|---|
| Find "save" on a film | 48 px icon-only 📱 in the round-button row, no word (tooltip only) | a tile "Save offline" under the icon | works; weak on desktop (an unlabeled icon among five) |
| Find "save" on an episode | not on the episode card (the card offers the raw file); only "Save 3 offline" (icon) or the sources sheet's rail | 📱 on every episode card + "Save season offline (N)" pill | works on phones; **desktop has no per-episode save** except inside the sources sheet |
| From the player | no | no | missing (nowhere to save what you are watching) |
| From My downloads | no (only a link to On this device) | same | missing — the screen people go to after downloading has no "save to this device" |
| "On this device" in the nav | hidden until something is saved | same | works (by design) |
| Plain http address | the button is simply absent; the explanation exists only on #/saved, which the nav hides on http | same | works badly — nobody finds the reason |
| Quality sheet | sizes shown, real for Original (file size), "≈" for encodes (720p of Mix: shown 79.7 MB, real 50.9 MB); "LAST TIME" marked; "Always use the size I pick" | same | works |
| Taps for one film | 2 (button + size) | 2 | works |
| Taps for 4 episodes one by one | — | 8 (the sheet every time) | works badly; the season pill does it in 2 |
| Original of an MP4 | served as the file, nothing prepared: 2 s for 39 MB | same | works |
| Original of an MKV (HEVC + AC-3) | "repackaged in seconds" — took **18–21 s for a 5-min film**: the video copy is 0.4 s, converting the AC-3 sound to AAC is ~20× real time on this (loaded) PC → about **6 min for a 2-hour film** while the sheet promised seconds | same | works badly (dishonest note) |
| 720p re-encode | 90 s for 5 min (≈ 36 min for 2 h); waits behind somebody's stream and says so | same | works |
| While another prepare runs | "Waiting for the server · another copy is being made" + Cancel; the server is told on Cancel | same | works |
| Transfer speed, 2.71 GB, local line | 25 MB/s while bytes arrive (plain fetch of the same file: 114 MB/s), then **"Saving 99%" for ~3 minutes** while Chrome commits the one giant cache entry: 294 s in all (9 MB/s) | same engine | works badly — the last 3 minutes look frozen |
| Memory while saving 2.71 GB | Chrome 595 → 746 MB peak, JS heap 4–7 MB: streamed, never in RAM | same | works |
| Reload / tab closed at 20 % | everything lost; the row says "Interrupted — Resume starts it again" (from zero) | same; on a phone a discarded tab or a killed browser is the same | **broken** for big files: no resume |
| Network drop of 8 s at 20 % (connection cut, line back) | the save fails at once: "Couldn't save: Failed to execute 'put' on 'Cache': Cache.put() encountered a network error"; all bytes thrown away | same | **broken** (and the message is a programmer's) |
| Server restart mid-save | same as a drop (the server's prepared file survives; the device's bytes do not) | same | **broken** |
| Tab in the background 60 s | carries on (20 % → 31 %) | Chrome emulation carries on; a real Android tab is frozen/discarded after minutes, iOS at once | works on desktop; on phones only while on screen |
| Phone screen lock | cannot be emulated faithfully; any freeze long enough to drop the connection = the "drop" row | | broken by extension |
| Quota exceeded part-way | "this browser ran out of storage for the copy — try a smaller size"; the partial copy is removed | same | works |
| Space pre-check | uses `navigator.storage.estimate()`; refuses honestly when the estimate says no | same | works |
| Storage persistence | `persist()` is asked silently and was not granted (`persisted() = false`); nothing tells the person their films can be evicted with the site's data | same | works badly |
| Several episodes at once | each tap runs its own save; the server prepares one at a time in the copy lane and the rows say why they wait | same | works |
| Offline, cold start (line cut AND server gone) | the shell loads from the worker in 3.7 s, lands on "On this device" with "Can't reach the Aurora server" | same | works |
| Play, seek far and back (Range from the cache) | 28–150 ms per seek, 1080p HEVC plays (this PC decodes HEVC) | same | works |
| Subtitles | external + embedded text tracks kept (Mix: Hebrew, English, Hebrew 2), styles as online | same | works (at most 6 tracks are taken) |
| Audio tracks | only the FIRST audio track is kept (`-map 0:a:0`); Mix's Hebrew dub is gone | same | works badly (by design; see plan) |
| Next episode offline | the next SAVED episode plays (E1 → E2) | same | works |
| **Progress made offline** | on a cold offline start the app has **no profile** (`state.profile = null`: `/api/profiles` was never kept by the worker when the page was only opened once before saving), so the player saves nothing — the resume point and "watched" are lost; queue empty, server empty | same | **broken** |
| Resume position offline | same cause: no history offline → starts at 0 | same | broken (same cause) |
| Kids profile | "On this device" lists every title saved on the device by anyone; a kids profile can play a grown-up's saved film (no rating check offline or online) | same | **broken** (kids rule) |
| Space used | "N titles · X · Y of Z used on this device" on On this device; a line on My downloads | same | works |
| Remove | one press on On this device (no undo); a toast with Remove on the episode button | same | works |
| Site update (worker update) | the worker deletes every cache but its own four; the media cache is unversioned and kept | same | works (now covered by a test) |
| Sign-out / profile switch | saved copies stay on the device and stay visible to whoever uses it next | same | works badly (no per-profile view) |
| Title replaced/deleted on the server | the saved copy keeps playing (it is the device's own); nothing says it is gone from the server | same | works |
| Expiry | none (elia: nothing is deleted automatically) | same | works |
| Background Fetch (Chrome) | available, permission granted, **accepts Range requests** (two 1 MB parts came back as 206s) | same (Android Chrome shows its own download notification) | not used yet |

## Faults, worst first

1. **No resume** — any interruption (reload, closed tab, a phone that froze or
   discarded the tab, a network blip of a few seconds, a server restart)
   throws away every byte; a 3 GB film on a phone line is a coin toss.
2. **A blip kills the save** — the transfer has no retry at all, and says so
   in a programmer's words.
3. **Progress made offline is lost** on a cold offline start (no profile), so
   the resume point and "watched" never reach the server.
4. **Kids see everything saved on the device.**
5. **The frozen 99 %** — 3 minutes of nothing at the end of a big save (one
   giant cache entry being committed), exactly when a person gives up.
6. **The "seconds" promise** for Original of an MKV — minutes for a film.
7. Desktop discoverability: no per-episode save, an unlabeled icon on a
   film, nothing on My downloads or in the player.
8. Persistence not explained; the browser may evict the films silently.
9. Only the first audio language kept.
10. http: the feature is invisible with no reason given where people look.

## Unverified: iOS Safari (cannot run here)

Read against Safari's known rules:
- Storage: Safari gives an origin up to ~60 % of the disk (iOS 17+), but
  **script-written storage of a site NOT added to the Home Screen is deleted
  after 7 days without a visit** (ITP). Saved films in a Safari tab can vanish
  after a week; added to the Home Screen they are kept.
- No Background Fetch, no background work: a save runs only while the page is
  on screen; locking the phone suspends it within seconds.
- Range from the Cache API: Safari's `<video>` asks `bytes=0-1` first and
  insists on exact 206 answers — the worker's answers are exact.
- `Blob.slice` of a cached response: in Safari this may read the entry into
  memory; with the part format (below) a seek touches at most a few 16 MB
  parts instead of a multi-GB blob.
- HEVC: Safari plays HEVC in MP4 (`hvc1`), so Original stays a repackaging.

## After (what changed) — see the bottom of this file once filled in
