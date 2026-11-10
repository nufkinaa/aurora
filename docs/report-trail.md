# The report trail — what a problem report carries

elia, 2026-11-10: *"it would be helpful in report a problem to send all of the users last actions and what he did, just more information that would be sent with the problem."*

A problem report ("Report a problem", and "Problem with this copy?") now carries, besides the viewer's words:

| part | what | where it is made |
|---|---|---|
| `trail` | the viewer's last steps, oldest first (the last 10 minutes, 60 steps at most) | website `public/js/trail.js` · apps `tv-native/src/trail.ts` |
| `env` | facts about the device and the app, read when Send is pressed | website `public/js/report.js` · apps `tv-native/src/clientContext.ts` |
| `player` | what the player was doing at that moment (only when one is open) | website `screens/player.js` (`playerState`) · apps `playback/Player.tsx` |
| `reqs` | the last 10 requests to this server: method, path, status, time | the same files as `trail` |
| `srv` | what only the server knows, added at receipt | `src/lib/reporttrail.js` `serverFacts` |

The old fields (route, title, look, browser, viewport, net, version, the last 20 errors, play marks, start-up) are unchanged.

The trail is kept **in memory only**, on the device, and leaves it **only inside a report the viewer chose to send** — not with the usage stats, not anywhere else, whatever the usage-stats switch says. Another profile coming in empties it.

## A step

One format on all three clients (the website, the TV app, the phone app):

```
{ t, k, ...a few short fields }
  t   milliseconds BEFORE the report was sent (0 = the moment of sending) — no clocks to compare
  k   the kind (below)
  n   how many times in a row, when it repeated within 5 s (an arrow held, a poll)
```

| `k` | fields | from |
|---|---|---|
| `nav` | `s` screen (web: the route pattern `/movie/:id`; apps: `tv:detail`, `phone:browse/movie`), `id` the title id, `ty` the type | the router's `aurora-route-start` · the navigators' `onStateChange` |
| `tap` | `ui` the control's `data-ui`/`uiId` name — else `r` role + `l` its label (40 chars), `on` a checkbox's state, `v` a list's chosen option | one delegated click listener · `uiHit` (Focusable, Tap) · Btn and Tap labels |
| `key` | `key` by NAME (`ArrowDown`, `Enter`, `Escape`, `Space`, `MediaPlayPause`; TV: `up`, `select`, `back`, `playPause`…) | one keydown listener · telemetry.ts' one TVEventHandler listener |
| `sheet` | `s` its name, `on` opened / closed | `pushScope`/`popScope` (focus.js) · overlay.ts |
| `toast` | `m` the words shown | `toast()` (ui.js) · `showToast` (toast.ts) |
| `err` | `w` kind (js, promise, console, media, stall, img, card…), `lv` warn, `m` message, `st` status, `code` | telemetry's `note()` on both; the player's error card with its words |
| `req` | `m` method, `p` path, `s` status (0 = no answer), `ms` | a fetch wrapper · api.ts `send()` — every write, every failure, every answer slower than 2 s |
| `search` | `q` the words searched (refined as typed = one step) | the request that ran the search (`/api/search`, `/api/discover/search`; never the suggestions) |
| `play` | `e`: `start` (first picture, `ms`, `path`), `play`, `pause` (`at`), `seek` (`from`, `to`), `seeked` (`ms` to play again), `stall` (`ms`, `at`), `ended`, `rate`, `picture` (`w`×`h`), `error` (`code`), `audio`/`subtitles`/`quality` (`v`, `auto`), `next` (`to`), `mark` (`mk`: the player's own marks — path, decision, abr, media-error, stall stages…) | web: the `<video>` events captured at the document, `mark()`, `switchAudio`, `applyQuality`, `selectTrack`, `goNext` · apps: `mark()`, `togglePlay`, `commitSeek`, `goNext`, `onEnd`, `switchAudio`, the subtitle key |
| `net` | `on` online / offline, `ws` the live connection up / down, `type`/`mbps`/`rtt` | online/offline, `navigator.connection` · `wsUp`/`wsDown` |
| `app` | `e`: `start`, `profile`, `hidden`/`shown` (web), `background`/`foreground` (apps), `fullscreen-on/off`, `pip-on/off` | the page / AppState |
| `feat` | `f` the feature (`audio_track`, `quality_720`, `pip`, `still_watching_shown`…) | `track("feat")` (usage.js · usage.ts) |

Every string is one line, at most 160 characters, with `<` `>` written as `‹` `›`.

The same words on every client and in the admin: `trailLine`, `trailText` (public/js/trail-core.js = tv-native/src/trailCore.ts; test/report-trail.test.js runs both over the same cases).

## Never in it

- **Anything typed.** A key in a text field is never kept — only Enter, Escape and Tab are named there. Outside a field keys are kept by name only: no single character is ever kept (Space excepted), so a TV browser typing with its keys leaves nothing either. A field's value is never read; a control that holds a field is named by its `aria-label` only.
- Passwords, PINs, names, messages, sign-in fields — all of the above.
- Tokens and codes: an address keeps its path only (no origin, no query, no fragment); after a word that guards a secret (`auth`, `sessions`, `token`, `describe`, `pair`, `reset`, `claim`, `unlock`, `code`, `pin`, `google`, `link`…) only plain words stay, anything else is `…`. A party, group or pairing code in the screen's address is `…` — in `context.route` too.
- In any string: an address's query, a `key=` / `token:` / `password=` written out, an e-mail address (`redact`).
- **Other profiles' names**: replaced by "someone", whole words, any script — on the website before sending, and on the server for every client (the apps rely on that).
- The names of files from this device (Your files, a local film's subtitles).

**The one exception:** the search the viewer ran (the server sees it anyway, and "search found nothing" needs it).

Proved by `test/report-trail.test.js` (the rules, on the site's and the apps' copies side by side) and `test/ui/report-trail.test.js` (a real browser types a password, a name and a message into fields and a search into Search: the sheet's disclosure and the stored report carry the search and none of the rest, and not one single-character key).

## The facts (`env`)

Each only where the platform offers it; each read on its own, so a failure is only a missing line and never stops the report.

| | website | TV / phone app |
|---|---|---|
| `app`, `v` | web, the server's version | tv / phone, the app version |
| `build` | — | the APK's versionCode |
| `os`, `browser`, `model` | system family, browser + major (coarse) | `Android 9 (API 28)`, maker + model |
| `device` | phone / tablet / desktop / tv | — |
| `screen`, `viewport` | `1920×1080 @2x`, the window | pixels + scale (+ text scale), the window in dp |
| `lang`, `tz` | the first three languages, time zone | locale, time zone |
| `installed` | added to the home screen | — |
| `sw`, `cache` | the service worker's state and script, the cache names (their version) | — |
| `storage` | used of quota (estimate) | — (the phone's free space lives in the offline store: a follow-up) |
| `mem`, `cores`, `lowRam` | device memory, cores | the box's low-memory flag |
| `saveData`, `dataMode`, `motion`, `look` | data saver, the data mode, reduced motion, the look | — |
| `subLang`, `subsDefault`, `audioLang`, `autoplayNext`, `kids` | the profile's settings | in `player` (the player's own prefs) |
| `auth`, `signedIn` | sign-in mode, an account session | the same |
| `server` | the origin only | the origin only |
| `conn`, `socket`, `client` | connection type/speed/rtt, the live socket, its client id | the live socket |
| `up` | seconds since this page loaded | seconds since the app's JS started |

`player` — website: title id, position, length, buffered ahead, readyState, networkState, paused / ended / seeking, waiting for (ms), speed, picture size, dropped frames, path (direct / jit / ladder / transcode / offline), video (`v`), cap, the hls level, audio, subtitles, the stream's path, the element's error code, the socket's client id (the server finds the live viewing session by it), watch-party role, AirPlay. Apps: title id, position, length, buffered ahead, state (playing / paused / buffering), speed, path, audio index, subtitles, the stream's path, the subtitle and autoplay prefs.

## The server (`src/routes/reports.js`, `src/lib/reporttrail.js`)

At receipt every client field is cleaned as if hostile: known kinds only; flat values only (strings, numbers, booleans — no objects or arrays inside); keys `[A-Za-z][A-Za-z0-9]{0,11}`; strings one line, 160 characters (120 in `env` / `player`), no markup brackets, no control or line-separator characters; `t` clamped to 0…24 h; `n` a whole number above 0.

| cap | |
|---|---|
| trail | 80 steps, 14 000 bytes (oldest dropped) — the clients send 60 / 12 000 |
| env | 48 keys |
| player | 32 keys |
| reqs | 10 |
| the body | the existing 100 kB JSON limit |
| the store | 500 reports (as before); the trail, `srv` and `reqs` are kept on the newest **100** only |

A client from before this (no trail) is filed exactly as before (`trail: []`, `env: null`…). A new client against an old server: the old server ignores the new fields (it only ever copied the fields it knows), and the report stays far under its 100 kB limit.

`srv` — read-only, from what the server already keeps, nothing from the playback pipeline: the server version, uptime, sign-in mode; whose report it is (the signed-in session, else the `X-Profile` header, else the profile id or name the client names); that profile's last 5 viewing sessions (watch-time store), its screens connected now (realtime), its downloads still in flight; the live viewing session of the reporting screen (by its socket's client id); and the kinds of error the same app reported in the last 15 minutes (lib/tel — counted by kind, not by person). Plus, as before, the server's own start trace for the title being played.

## The sheet

The sheet's own sentence says it: *"A few words is enough. Where you are, what's playing, your last steps in the app and facts about this device come along by themselves — never anything you typed, except a search you ran."* — and a closed **See what will be sent** under the boxes (website: a disclosure; TV: a button that shows the newest 8 steps and the facts; phone: a link that opens a box that scrolls). It is gathered only when opened, and exactly what was shown is what goes. The sheet is as quick as it was: one box, Send. On a phone the card scrolls inside itself, so Send is never pushed off the screen.

## The admin

Inbox → Problem reports, inside each report: **what they did · N steps · K flagged** (a timeline, newest last, times as "−2:05" before sending, errors / stalls / failed requests in red, refusals and slow answers in amber), **device and app**, **the player at the time** (compact tables), **the server's side · last requests**, and a per-report **Copy for Claude**. The section's Copy for Claude (the open reports) carries the same text. The words come from the site's own `/js/trail-core.js` (imported by the admin page) — the same the viewer saw. Everything is escaped.

## Cost

A step is one small object pushed onto a 60-slot array; nothing is stored or sent until a report is. The web player's events are read off its `<video>` by capture listeners (no call sites); the apps' key listener was already there (one more call per key).
