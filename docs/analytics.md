# Aurora's usage stats — the contract

What the website and the TV app tell the server about how they are used and what goes wrong on them; what is never told; how long it is kept; how a person switches it off; and how to add to it. `test/tel-contract.test.js` fails when this document and the code disagree about a name.

Everything here goes to **this household's own server** and nowhere else. It is read on the admin page: **Insights → Analytics** (screens, features, plays) and **Insights → App health** (errors, timings, most used).

## The switch

One switch per person: **Settings → More settings → Privacy → "Usage stats to improve Aurora"** on the website, stored on the profile as `prefs.usageStats` (`false` = off; absent = on). The TV app also has a per-box switch under Settings → Privacy. It is enforced in three places:

| Where | What it does |
|---|---|
| The website (`public/js/usage.js`) | `enabled()` reads the profile's `prefs.usageStats`. Off: nothing is queued, and what was held is forgotten. No profile yet: reports are held (bounded) until one is chosen, never sent without one. |
| The TV app (`tv-native/src/usage.ts`) | **Both** the box's own switch **and** the profile's `prefs.usageStats` (read from the server each time a profile is entered) must say yes. Until the profile's choice has been read, events are held, not sent. |
| The server (`src/routes/usage.js` → `src/lib/tel/index.js` `verdict`) | Every batch names its profile. The server looks the profile up **itself**: switched off, or a profile it does not know → the whole batch is dropped, whatever the client believed, and the answer carries the header `X-Usage: off`. On that header both clients stop sending for that profile. While sign-in is required, the signed-in person's switch counts too. |

So a person who switches usage stats off on their phone has switched them off on every TV, and a client that ignores the switch (an old build, a bug) still contributes nothing.

One deliberate exception to "a session is required": while the server requires sign-in, `POST /api/usage` is reachable **without** a session — and then only the batch's *error reports* are kept, and only for a profile that exists and has the switch on. A device the sign-in wall is refusing is exactly the one worth hearing from (every TV picture answering 401 was invisible for two releases for this reason).

## Never collected

- **Titles** — not what was played, opened, searched for, downloaded, added to a list. `detail.play` says a Play button was pressed on a title page; it never says which title.
- **Search text**, or anything else a person typed.
- **Names** — profile names, people's names, device names a person chose.
- **Ids** — library ids, IMDb ids, session ids, tokens, cookies, passwords, PINs.
- **Addresses** — full URLs, host names, IP addresses. A request is reported by its *shape*: `GET /img/:id?w=256 → 401`.
- **File paths.**
- **The profile** — the batch carries a profile id so the server can check the switch; it is used for the "active profiles per day" count of the older usage events and is **not** stored with error reports, timings or control counts.
- **A device fingerprint** — the website sends its browser family and major version and the system's family (`chrome 141`, `android`); the TV its model and Android level. The "install id" is a random number made on the device, tied to nothing, hashed again with a server-side salt and cut to six characters before it is stored — enough to count "three different devices", useless for anything else.

How this is held, in order:

1. **No call site hands telemetry a title, a name or typed text** (the contract test reads every reporting call in both clients).
2. **Fixed vocabularies**: a control id, a timing name, an error kind, a screen pattern, a context key or an input that is not on the lists below is dropped by the server. Screen patterns allow no digits and no capitals, so an id cannot be one.
3. **The clients reduce every message before it leaves** (`telemetry-core.js` / `telemetryCore.ts` `normMessage`): first line only; URLs, e-mail addresses, IPs, paths, hex strings, long ids, IMDb ids, episode tags, numbers, quoted phrases and all non-Latin text are replaced by placeholders. `console.error("…", thing)` keeps only its first argument when it is a string, and the name and message of an `Error`; every other argument becomes `<object>` / `<string>`.
4. **The server does it again** (`src/lib/tel/scrub.js`) — a server must never trust a client to have removed a secret — and additionally replaces any **title in this library** and any **profile name** it finds with `<title>` / `<name>`. A string that still trips a detector is stored as `<scrubbed>`.

## What is sent

One `POST /api/usage` per batch, at most every 20 seconds while there is something to send, never while someone is moving about (2.5 s without input on the site, 3 s without a key on the TV) and never while a play is starting; when the page or app goes to the background it is sent at once.

```jsonc
{
  "profile": "…", "sid": "a1b2c3d4",             // whose switch to check · this tab / this run
  "device": "tv", "look": "tv",                  // phone | tablet | desktop | tv · glass | legacy | tv
  "iid": "9f3c…", "app": "tv", "v": "5.1.31",    // random install id · web | tv · app version
  "model": "Xiaomi MiTV-MSSP3", "os": "android 30", // web: "chrome 141", "android"
  "net": "ok", "auth": "closed",                 // slow | ok | fast · open | transition | closed (the sign-in mode the client saw)
  "flags": ["lite", "lowram"],                   // ≤ 6: look:glass, installed, sw, lite, lowram, impl:…, exp:…
  "events": [ { "n": "route", "t": 1760000000000, "p": { "r": "/movie/:id", "ms": 412 } } ],
  "tel": {
    "s": 1,                                      // this session's first batch
    "e": [ { "k": "img", "l": "error", "m": "/img/:id?w=256", "n": 37, "t0": …, "t1": …, "r": "tv:home", "c": { "status": 401 } } ],
    "t": [ ["play_first_frame", 2100, "direct"], ["nav_paint", 420, "tv:detail"] ],
    "u": [ ["tv:detail", "detail.play", "remote", 2, 1] ]   // screen, control, input, presses, first-time-this-session
  }
}
```

### Usage events (`events`, as before)

| `n` | Fields | Meaning |
|---|---|---|
| `route` | `r` pattern, `ms` | a screen was shown; `ms` = navigation start → content painted on both clients (the same measurement as `nav_paint`; absent on the TV for a return to a mounted screen) |
| `feat` | `f` name, sometimes `hits`, `s`, `st`, `w` | a feature was used (`peek`, `skip_intro`, `quality_720` …) |
| `nav` | `to` | a nav tab was tapped (website) |
| `play` | `kind`, `path`, `ms` | a play reached its first frame |
| `error` | `m` | the reduced first line of an uncaught error (5 per run) — superseded by the reports below, kept for the Analytics tab |
| `net` | `tier`, `src`, `kbps`, `rtt` | the connection as the app measured it |
| `perf` | `screen`, frame numbers, the box | the TV's frame monitor |
| `app` | `v` | the TV app was opened |

50 events a batch, names `^[a-z][a-z0-9_]{0,31}$`, 10 props each, strings cut at 120.

### Error and warning reports (`tel.e`)

One entry per **kind of thing that went wrong**, with a count — forty failed pictures are one entry that says 40.

| Field | Meaning |
|---|---|
| `k` | the kind: `js` uncaught error · `promise` unhandled rejection · `console` console.error / console.warn · `http` a request answered ≥ 400 or not at all · `img` a picture that would not load · `media` the video element, hls.js or ExoPlayer · `sw` service worker · `stall` the main/JS thread or the player stood still · `crash` the last run ended while on screen · `mem` the system asked for memory back · `ws` the live socket · `update` the TV's self-update |
| `l` | `error` or `warn` |
| `m` | the reduced message. For `http` and `img`: the method and the address's shape — the server builds the sentence (`GET /api/item/:id → 404`) itself |
| `s` | where, website only: the first two frames in the app's own files as `screens/player.js:onStall` — no line, column, host or version stamp. The TV sends none (Hermes stacks are byte offsets) |
| `r` | the screen pattern on show |
| `n`, `t0`, `t1` | occurrences in this batch, first and last time |
| `c` | a few numbers, from this list only: `status`, `code`, `ms`, `level`, `attempt`, `online`, `fatal` |

The fingerprint — the id a kind is known by — is made **on the server**: `sha1(app | kind | reduced message | reduced location)`, ten characters. Because numbers, ids, hosts, paths and line numbers are gone before it is computed, the same fault from any device in any week is the same fingerprint, and a new release does not make every error "new".

| Before (what the device saw) | After (what is stored) |
|---|---|
| `GET http://10.0.0.5:4000/img/3f9a2c1b7d4e?w=256` answered 401, 37 times | `image /img/:id?w=256 → 401` ×37, status 401 |
| `Cannot read properties of undefined (reading 'duration')` at `http://10.0.0.5:4000/js/screens/player.js?v=ab12:onStall:120:33` | `Cannot read properties of undefined (reading 'duration')` @ `screens/player.js:onStall` |
| `Could not open "The Example Film (1999)" from D:\Movies\The Example Film (1999)\The Example Film.mkv` | `Could not open '…' from <path>` |
| `Request timed out after 30000 ms (attempt 3)` | `Request timed out after N ms (attempt N)` |
| `token=abc123def456 rejected for anna@example.com` | `token=<redacted> rejected for <email>` |
| `console.warn("[player] stalled", item.title)` | `[player] stalled <string>` |

Client limits: one entry per kind (repeats count up), 40 kinds a session, 120 kinds a device a day, 20 entries a batch; a batch that did not get through keeps its reports for the next one; nothing is sent offline; everything held is forgotten when the switch is off.

### Timings (`tel.t`)

`[name, milliseconds, split]`. The same names and the same definitions on the website and the TV, so the two compare.

| Name | From → to | Split |
|---|---|---|
| `app_start_home` | the page's navigation start / the TV bundle starting to run → **Home usable**: the first row's cards are in the layout and one frame has been drawn. Only when the app opened straight onto Home (no profile wall), in the foreground | – |
| `gate_home` | a profile accepted at the wall (password and PIN already answered) → Home usable | – |
| `nav_paint` | **navigation start → first content painted**: the route change is dispatched → the first frame after the destination screen has rendered its content. Website: the router's own clock around the screen's render. TV: ONE clock, `tv-native/src/routeTiming.ts` — the press that asked for the screen (or the navigator's state change when nothing was pressed) → the screen says its content is on (`useRouteShown`: its first list has arrived and is committed). The same number is the `route` event's `ms`, as on the website; a return to a screen that is still mounted is counted (`route` without `ms`) and not timed. **Not** the previous screen's dwell time — before 5.1.32 the TV's `route` event reported that as `ms` | screen pattern |
| `title_content` | a title page asked for → its hero block (title, buttons) laid out, plus a frame | `library` `catalogue` |
| `title_backdrop` | a title page asked for → its backdrop picture loaded | `library` `catalogue` |
| `grid_first_poster` | a screen with a grid or shelves asked for → the first card poster loaded | screen pattern |
| `search_results` | the **last** keystroke → results on the screen; once for the library's answer, once for the catalogue's | `library` `catalogue` |
| `play_first_frame` | the player mounted (Play pressed) → the first frame — the same clock as the play marks in the server log | `direct` `remux` `transcode` `torrent` `offline` |
| `seek_resume` | a seek committed → the picture moving again at the new place | the play's path |
| `ws_reconnect` | the live socket lost → open again | – |
| `update_check` | TV: asking the server for a newer build → the answer | – |
| `update_download` | TV: the update's download | – |
| `update_installed` | TV: an update first offered → the new build running (across the restart) | – |
| `srv_home` `srv_search` `srv_suggest` `srv_item` `srv_library` `srv_catalog` `srv_discover` | measured **in the server**: request in → response finished (refusals are not counted) | – |
| `srv_img` | the same for `/img/*` | `variant` `original` |
| `dl_wait_approval` | server: a download asked for → approved | `auto` `asked` |
| `dl_wait_slot` | server: approved → started | – |
| `dl_transfer` | server: started → in the library | – |
| `dl_total` | server: asked for → in the library | – |

A client cannot send a `srv_*` or `dl_*` value. A value outside its metric's range, or with a split that is not one of the metric's own, is dropped (or counted under `other` / `?`).

### Control counts (`tel.u`)

`[screen, control, input, presses, first]` — how many times a tagged control was pressed since the last batch. Inputs: `remote`, `touch`, `mouse`, `keyboard`, `pen`. `first` is 1 the first time a session reports a control (for "share of sessions that used it").

A control is tagged where it is built:

- website: `"data-ui": "detail.play"` on the element (one delegated click listener reads it; nothing is ever guessed from a control's text). A control that is not a click on an element — a keyboard shortcut, a tap zone — calls `uiHit("player.seek.fwd")`.
- TV: `uiId="detail.play"` on a `Focusable`, `Btn` or `Chip` (and the small wrappers that pass it through). Without it nothing happens.

The vocabulary (`src/lib/tel/controls-vocab.js`) — 166 ids: 115 on the website, 112 on the TV, 61 on both.

| Area | Website only | TV app only | Both |
|---|---|---|---|
| actions | – | `actions.pick` | – |
| browse | `browse.chip.pick` `browse.filter.clear` `browse.genre.open` `browse.loadmore` `browse.option.pick` `browse.sort.open` | `browse.retry` | `browse.category.pick` `browse.surprise` `browse.unwatched` |
| card | `card.remove` | – | `card.open` |
| detail | `detail.download.device` `detail.episode.download` `detail.episode.watched` `detail.offline` `detail.offline.season` `detail.rollagain` `detail.save` `detail.season.open` `detail.sources.fold` `detail.sources.more` `detail.sources.retry` `detail.synopsis.more` `detail.trailer.close` `detail.trailer.pick` | `detail.season.pick` `detail.season.watched` `detail.similar` `detail.source.pick` | `detail.episode.play` `detail.follow` `detail.mylist` `detail.play` `detail.restart` `detail.source.download` `detail.source.play` `detail.sources` `detail.trailer` `detail.watched` `detail.xray` |
| downloadpicker | `downloadpicker.confirm` | – | – |
| downloads | `downloads.cancel` `downloads.open` `downloads.play` `downloads.remove` `downloads.retry` | `downloads.row` | – |
| home | `home.hero.pick` | `home.hero.party` `home.switchprofile` | `home.hero.details` `home.hero.mute` `home.hero.play` `home.retry` |
| mylist | – | `mylist.filter` | – |
| nav | `nav.downloads` `nav.new` `nav.saved` | – | `nav.ai` `nav.home` `nav.movies` `nav.mylist` `nav.profile` `nav.search` `nav.settings` `nav.shows` |
| newpassword | – | `newpassword.signout` `newpassword.submit` | – |
| party | – | `party.join` | – |
| peek | `peek.close` `peek.remove` | – | `peek.details` `peek.mylist` `peek.play` |
| pick | – | `pick.retry` `pick.unfold` | `pick.example` `pick.go` `pick.option` |
| picker | – | `picker.open` `picker.pick` | – |
| player | `player.airplay` `player.fullscreen` `player.pip` `player.quality.pick` | `player.autoplay` `player.back` `player.slowstart.lower` `player.slowstart.wait` `player.stall.lower` `player.stall.retry` `player.subtitles.resync` | `player.audio.pick` `player.mute` `player.next` `player.party` `player.party.start` `player.playpause` `player.retry` `player.scrub` `player.seek.back` `player.seek.fwd` `player.settings.open` `player.skipintro` `player.speed.open` `player.speed.pick` `player.startover` `player.stillwatching.done` `player.stillwatching.keep` `player.subtitles.open` `player.subtitles.pick` `player.upnext.dismiss` `player.upnext.play` `player.xray` |
| profile | `profile.add` `profile.gate.close` `profile.save` | `profile.pin.submit` | `profile.pick` `profile.unlock` |
| rating | `rating.star` | – | – |
| report | – | – | `report.send` |
| row | `row.arrow` | – | – |
| saved | `saved.play` `saved.remove` | – | – |
| search | `search.clear` `search.retry` | – | `search.recent.pick` `search.suggestion.pick` |
| settings | `settings.accent` `settings.done` `settings.link` `settings.look` `settings.rows.hide` `settings.theme` `settings.toggle` | `settings.autoplay` `settings.downloads` `settings.genre` `settings.notices` `settings.party` `settings.report` `settings.signout` `settings.subs.auto` `settings.subs.bg` `settings.subs.lang` `settings.subs.size` `settings.trailers` `settings.update` `settings.usagestats` `settings.whatsnew` | – |
| signin | – | `signin.mode.google` `signin.mode.qr` `signin.mode.typed` `signin.request` `signin.submit` | – |
| state | – | `state.action` | – |
| update | – | `update.install` `update.later` `update.restart` `update.retry` | – |
| whatsnew | – | `whatsnew.log` | `whatsnew.go` |
| xray | `xray.more` | – | – |

## What the server keeps (Retention)

Aggregates, not logs. Nothing below grows with use beyond its cap.

| Store (under `data/usage/`) | Holds | Bounds |
|---|---|---|
| `events-YYYY-MM.jsonl` | the older usage events, one line per batch (no `tel`) | 30 MB a month, 3 months |
| `tel-errors.json` | per fingerprint: message, where, counts, versions, models, screens, sign-in mode, connection, context numbers, per-day and per-hour counts, hashed device ids per day, first seen / first version, known-or-ignored | 300 fingerprints (the stalest goes first), 30 days of days, 48 h of hours, 40 device ids a day, 12 values per breakdown; a fingerprint unseen for 30 days is dropped |
| `tel-timings.json` | one histogram per metric × app × version × device class × connection × split: 140 buckets, each 15 % wider than the last (a percentile is within ±7 %) | 3000 histograms, the 4 newest versions per app, 45 days untouched |
| `tel-controls.json` | per day × app × control: presses, sessions that used it, by screen, by input | 30 days |

Per device per day the server accepts at most 3000 batches, 400 error reports, 3000 timings and 4000 control rows; one address may post 60 batches a minute.

## Alerts

The healer's check "Errors on people's devices" (`src/lib/healer-checks/clients.js`) raises **one** alert — through the healer's own alert path (`lib/notify.js`: ntfy / Telegram) — when:

- a **new** kind (first seen in the last day, not marked known or ignored) shows up on **2 devices** or **20 times** within **30 minutes**; or
- an existing kind is **spiking**: at least **5×** its own usual hour (its mean over the last week) and at least **20** in the hour.

One alert carries everything that qualified since the last one; at most one per **30 minutes** and **6 a day**; a kind is announced as new once, and as spiking at most every six hours; what had to wait goes with the next alert. The numbers are for a household of five to thirty devices: two devices with the same brand-new error inside half an hour is a release that broke something; one device repeating itself twenty times is a loop. Change them in the admin (App health → Alert rules — kept in `data/settings.json` as `clientErrorAlerts`) or in `config.json`:

```json
{ "healer": { "clientErrors": { "alert": true, "newDevices": 2, "newCount": 20, "windowMin": 30, "spikeFactor": 5, "spikeMin": 20, "cooldownMin": 30, "maxPerDay": 6 } } }
```

"Mark as known" keeps a kind in the lists and stops it being announced as new; "Ignore" keeps counting it but takes it out of the lists and the alerts. A few kinds are born ignored (`BENIGN` in `src/lib/tel/vocab.js`): the browser's "ResizeObserver loop" notice, "Script error." from another origin, aborted requests, refused autoplay, a cut-short page cross-fade, React Native's development notices, and a 401 / 403 / 429 answer to a password, PIN or code (somebody's slip, not a fault — still counted, and visible under Ignored, where a sign-in that broke for everyone would show as a very large number).

## What it costs

`node scripts/tel-bench.js` prints these on the machine it runs on (a TV box's CPU is roughly 10–30× slower than the laptop these are from):

| | |
|---|---|
| a key press | one assignment (`lastInput = now`) — about 80 ns |
| a press on a tagged control | two property reads and an increment, nothing allocated — about 20 ns; a million presses grow the heap by ~30 KB |
| a repeat of a known error | a map lookup and an increment — about 0.4 µs |
| a new error message | reduced and counted — about 6 µs, once per kind per session |
| a batch on the wire | ~340 bytes ordinary, ~1.6 KB busy; an evening of browsing is a few dozen batches, ~20 KB |
| a batch on the server | ~130 µs for a busy one (scrub, fingerprint, count) — thirty devices sending three a minute is 0.02 % of one core |
| the timing middleware | ~0.2 µs on a request it does not watch, ~0.35 µs on one it does |
| on disk | 30 devices × 30 days: ~170 KB in all, and it stops there — every store is a fixed-size aggregate |

Nothing is written to storage per event on either client: the website writes one small `localStorage` entry when a batch with error reports goes out; the TV writes to AsyncStorage when the app comes to the front or leaves it, and when a batch with error reports goes out. Nothing is sent during a key-repeat burst or between a player's mount and its first frame: the sender asks `quiet()` first and tries again in 1.5 s.

## How to add

**A control.** Tag it (`"data-ui": "area.thing"` / `uiId="area.thing"`), add the id to `src/lib/tel/controls-vocab.js` with `"w"`, `"t"` or `"wt"`, add it to the table above. `npm test` fails until all three agree. Use an existing id when the other app already has the same control.

**A timing.** Add it to `TIMINGS` in `src/lib/tel/vocab.js` (label, longest value kept, the split if any) and to the table above with its exact from → to; then one line where it ends: `tmStart("x")` … `tmEnd("x", split)` for a span, `sinceNav("x", split)` for "since this screen was asked for", `tmValue("x", ms, split)` for a value measured elsewhere. Define it once and use the same definition on both apps — a timing that means two things compares nothing.

**An error source.** `reportError(kind, message, { ctx })` with a kind from the list and a message **written in the code** — never a title, a name, or text from the page. Numbers go in `ctx` under a whitelisted key.

**A path word.** A new server route's static path words go in `SEGMENTS` (`src/lib/tel/vocab.js`), or a failing request to it is reported as `/:id` (the contract test says which).
