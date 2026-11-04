# Watch time and presence

elia, 2026-11-04: *"currently if a person stops the playback, leaves the TV or computer with the movie or episode paused, or just closes the laptop while a movie is paused or playing we for some reason consider this watch time, that's the only way to explain watch time of 71 hours for one 40 min episode only 1 person has seen… make sure who we consider connected still is someone that answers a ping."*

This page has six parts. Part 1 is the short answer. Parts 2–5 cover how Aurora worked before this change (the map and the cause of the 71 hours), the watch-time rules now, the presence rules and the admin's Activity section. Part 6 is the research the rules come from: what Netflix, YouTube, Plex, Jellyfin, Emby, Mux, Conviva and GA4 do.

## 1. In short
- **Watch time = media that really played.** Each report counts at most what the server's own clock allowed, 60 s at a time. A session is held to 2× the media's length + 5 min.
- **Sessions end when their player goes quiet** (45 s), stands paused (30 min) or leaves. They end at the last moment of real play.
- **Connected = a socket that keeps answering:** the socket ping every 30 s, and a heartbeat every 60 s that the server answers. A client silent for 150 s is gone.
- **Old records were held to what they could have been.** A one-off repair runs once, at startup, with a backup first.

## 2. How Aurora worked until now (1.15.10, TV 5.8.3, phone 1.0.3)

### What each client sent
| Client | Message | When | What it carried |
|---|---|---|---|
| Web player (`public/js/screens/player.js`) | `activity` "Watching" over the WebSocket | at open, then every 5 s **paused or not** | title label, `position`, `duration`, `streamDuration`, `streamReady` |
| Web player | `activity` "Browsing" | on the player's own Back only | — |
| TV and phone streaming player (`tv-native/src/playback/Player.tsx`) | `activity` "Watching" | at mount, 1.5 s later, then every 5 s **paused or not** | label, `position`, `duration` |
| TV / phone (`tv-native/src/realtime.ts`) | `hello` + the last activity again | on every socket open | profile, device |
| Phone offline player (`OfflinePlayer.tsx`) | nothing over the socket; `POST /progress` every 15 s, queued while offline (`offline/store.ts`) | — | position only: **no watch time at all** |
| All | `src/lib/tel` usage / timings / errors | batches | not used for watch time |

### How the server turned it into numbers
- `src/realtime.js` kept one in-memory `clients` entry per socket (activity, details, position). "Connected now" = sockets open; "watching now" = `activity === "Watching"`, paused included.
- `src/telemetry.js` opened a session on a socket's first "Watching" report. On every report it set **`watchedSec = updatedAt − startedAt`**, the wall clock.
- A session ended only when the activity changed, the content changed or the socket closed (`endedAt = now`). At a restart, live sessions were closed at their last update.
- **Admin Home's Activity (1.15.8)** read three routes:
  - `/api/admin/overview`: watch time "24 h", the summed `watchedSec` of sessions started in the last 24 h;
  - `/api/admin/clients`: every socket, the admin's own included;
  - `/api/admin/analytics?days=7`: top titles by summed `watchedSec`.

  The page fetched again on `client_*` socket events and every 30 s. `lib/adminsummary.js`'s Playback line counted "watching now" the same way.
- **The same `watchedSec`** also feeds the Insights charts, Wrapped, the "you've been at this a while" nudge (`/api/profiles/:id/today`) and the healer's session check.

### Where 71 hours for one 40-minute episode came from
Wall-clock time was counted as watch time, so every way of leaving a player open counted:
1. **Paused and left.** The players report "Watching" every 5 s while paused.
   - A TV left paused keeps its socket alive (the Mi TV never sleeps: stay-awake is on), so one session grows 12 hours every 12 hours. Three days paused = 71 h.
   - `test/watch-time.test.js` "THE 71 HOURS" replays it: one 40-minute episode played once, then 70 h 20 min of paused reports. The old rule gives 71 h; the new one gives 40 min.
2. **The end screen.** The data on this PC shows it happening: elia's phone, *Only Murders in the Building* S2E10 (38 min), with the position stuck at the end for 12.8 hours, all counted (`watch-sessions.json`, 2026-08-21).
3. **Leaving the web player by the browser's Back (or a link)** sent nothing. The server heard "Watching" until the tab closed, so a laptop left on Home after a film counted for as long as the tab stayed open.
4. A laptop lid closed mid-film cost at most a minute, because the socket ping notices a sleeping peer. But nothing in the rules would have stopped it costing more.
5. Two tabs, or a TV and a phone, on the same title were simply added up.

## 3. Real watch time now

**One rule for every client:** a report credits the time the media really played since the report before it, and never more than the server's own clock let pass (`src/lib/watchtime.js`).

- **New clients say what played** (web 1.15.11+, TV 5.8.4+, phone 1.0.4+). Each report carries `played`, `state` (playing, paused, buffering or ended), `rate` and `visible`.
  - `played` comes from a watch clock (`public/js/watchclock.js`, `tv-native/src/watchClock.ts`, same rules). It adds a stretch only while the player is really playing (not paused, not seeking, has data) and the position moved forward by about what the clock allows.
  - It divides by the speed, so 10 minutes at 2× are 10 minutes of someone's time (Mux's Watch Time works the same way).
  - It never counts a jump (a seek, a new stream landing), a stall (ticks more than 5 s apart) or a sleep (the clock moved, the film did not).
- **Old clients are read by position** (TV 5.8.3, phone 1.0.3, a web tab opened before the update).
  - A position that moved forward by no more than 2.5× the wall time is play.
  - Standing still is a pause or the end screen.
  - Going back, or jumping ahead further than that, is a seek and counts nothing.
- **Every credit is bounded by the bank**, kept per person and per title.
  - Wall time accrues in it on the server's clock, up to 60 s, so a device's wrong clock changes nothing. Each credit is taken out of it.
  - A gap (sleep, a TV switched off, Wi-Fi gone) never counts: afterwards only what really moved is credited, and never more than 60 s.
  - Reports that arrive bunched together after a frozen socket still credit what was played.
  - Two tabs, or a TV and a phone, of one person on one title share one bank, so the time counts once. Two people count twice. One person playing two *different* titles at once counts both, which is rare but real.
- **Caps:** at most 60 s per report, and at most 2× the media's length + 5 min per session.
- **Sessions close on the server:**
  - a session that hears nothing for **45 s** (nine missed 5-second reports) closes at its last report ("silent");
  - one that stands paused for **30 min** closes at the moment it last played ("paused"). Playing again opens a new sitting, and paused reports alone never open one;
  - a restart closes live sessions where they last played.

  `endedAt` is always the last moment of real play, not when the server noticed.
- **Plays:** a session opened and closed within 5 s that never played is dropped, as before. The admin's lists also leave out sessions with under 5 s of play.
- **The phone's saved copies now count.** The offline player measures real play.
  - With the server there, it reports over the socket like the streaming player.
  - Without it, the seconds are kept on the phone per sitting and sent to `POST /api/profiles/:id/watched` when the server answers again: at start, on return to the front, and on leaving the player.
  - The server records one closed session per report id, so a retry counts once. Time is bounded by the span the phone measured (+60 s), by 2× the length + 5 min, and by 6 h. The date is the phone's own, held between 30 days ago and now.
- **Leaving the web player by any route** (Back in the browser, a link, the next episode) now sends the last seconds played and then "Browsing".

### The repair of old records (`src/lib/watchfix.js`)
Real play was never stored, so it can't be recomputed. What can be said for sure is what an old session could not have exceeded. Each old session (no `acct: 2`) is held to:
1. its own wall span;
2. the media's length + 10 % when known, else 3 h;
3. per person, per title, per day: 1.5× the length in all (the day's sessions are scaled down together).

The value before is kept on the record (`watchedSecRaw`), and the repair always starts from it, so running it twice changes nothing.

- **On the server:** it runs once at startup. It first copies `watch-sessions.json` to the backups folder, then writes the marker `data/watch-time-fix.json`. On nufurora, a restart after the update is all it takes.
- **By hand:** `node scripts/fix-watch-time.js [--file <copy>]` is a dry run; `--apply` backs the file up beside itself first.

**Dry run against a copy of this PC's live data** (read-only, 2026-11-04):
- 296 sessions on record; 1 would change.
- Total watch time: 33.6 h → 21.5 h.
- The one change: elia, 2026-08-21, *Only Murders in the Building* S2E10 (38 min), 12.8 h → 42 min.
- The 71-hour record is not in this PC's data, so it must be on nufurora. The same rule caps it to the episode's length + 10 %.

## 4. Who is connected

**Connected** means an Aurora screen whose socket is open and still answering:
- **The socket ping.** The server pings every socket every 30 s and ends one that missed the previous ping: a device switched off, a laptop asleep, Wi-Fi gone. A killed app's socket closes at once.
- **The heartbeat.** Every new client promises one (`hello` `hb: 60`). It sends `presence` every 60 s, and right away when its visibility changes, and the server answers `presence_ok`.
  - A client that says **nothing for 2.5 beats (150 s)** is ended: a page the browser froze, or a killed browser whose OS kept the socket half open.
  - A client whose beat goes **unanswered for 15 s** closes its socket and connects again, so a laptop that woke up holding a dead connection is back within seconds.
  - Old clients make no promise and are held to the socket ping only.
- **A server restart forgets everyone.** Presence lives in memory. The clients reconnect after a random wait and say hello again (the TV also repeats its activity). A repeated activity carries `played: 0`, because what played was already counted on the old socket.

What a screen is doing (`presenceOf`, the admin's chips):

| State | Means |
|---|---|
| Watching | the player is open and playing |
| Paused | the player is open, not playing (paused, loading, the end screen) |
| Browsing | the app or page is in front, no player |
| In the background | the page is hidden or the app is in the background (not counted in "screens open") |
| On the profile wall | the website is open, nobody picked a profile yet. The TV and phone apps open their socket only once a profile is chosen, so a TV left on its wall is not connected at all |
| Not answering | it said "Watching", then nothing for 45 s: not counted as watching, gone at the heartbeat deadline |

Edge cases:
- **A device turned off, or Wi-Fi lost:** the socket ping drops it in 30–60 s, and its session closes at its last report.
- **A laptop lid closed:** the same. On waking, its unanswered beat reconnects it at once, and none of the sleep counts.
- **An app killed:** its socket closes at once; a half-open one is caught by the ping.
- **Several tabs:** one row per screen in the admin ("2 tabs"), and the watch time counts once (shared bank).
- **The same device on two profiles:** a `hello` with another profile ends the first person's session.
- **A page frozen by Chrome:** it says so on `freeze`, shows "Not answering" after 45 s, and is gone after 150 s. On `resume` it beats again.
- **Leaving a page:** `pagehide` sends `navigator.sendBeacon('/api/presence/bye', {clientId})`, so the session ends and the socket closes at once. The id is the socket's own, known only to the page. A page kept in the back/forward cache is not treated as leaving.
- **Clock skew:** only the server's clock is used, except to date an offline sitting.
- **The admin's own page** is not counted as a screen.

## 5. Admin › Home › Activity
- **One answer:** `GET /api/admin/activity` (`src/lib/activity.js`, pure `build()`) returns:
  - the counts;
  - who is watching now: title, episode, position, device, playing or paused, and this sitting's real time;
  - every screen, grouped per person and device;
  - watch time today (since local midnight) and for 7 days, per person and per title;
  - the 12 latest plays.
- **Live:**
  - The admin socket's `client_*` messages make the page ask again (debounced 0.7 s). Position reports reach the admins at once when what is shown changes, otherwise every 20 s.
  - It asks every 10 s anyway while the section is open. Between answers, a 1 s tick moves the playing positions on by themselves.
  - Rows are keyed and updated in place: a text is written only when it changed, bars move by transform, heights are fixed and numbers tabular. `test/ui/admin-activity.test.js` checks that a live update moves nothing and records no layout shift.
- **When the section is closed:** its summary line shows the live state, and Copy for Claude gives the whole section as text.


## 6. Research: how others measure it

Sources are given after each claim. Where a vendor's internals are not public, this says so. Rows marked *(community)* come from reverse engineering or forum posts, not vendor docs.

### Netflix
- **A "view" today:** hours viewed ÷ runtime, in the twice-yearly "What We Watched" report (hours rounded to 100,000). So a view is not a person: two people each watching half a film make one view. https://about.netflix.com/en/news/what-we-watched-a-netflix-engagement-report
- **Earlier definitions:** 70 % of a title watched (before 2019), then 2 minutes watched ("intent", Q4 2019–2021), then hours viewed. https://tvline.com/2021/10/19/netflix-changes-viewership-reports-ratings-hours/
- **"Are you still watching?":** on TVs after 3 episodes and 90 minutes with no input; on other devices after 3 episodes in a row with no use of the player controls. https://help.netflix.com/en/node/114059
- **Not public:** the client heartbeat interval and how the back end splits sessions.

### YouTube
- **Metrics:** `estimatedMinutesWatched` and `averageViewDuration` in YouTube Analytics. The docs do not say how paused or background time is treated. https://developers.google.com/youtube/analytics/metrics
- **Player beacons** *(community)*: `/api/stats/watchtime` carries `st`/`et`, the media ranges that were played, plus `state` (playing/paused) and `vis` (visibility). It is sent about every 10 s for the first 30 s, then about every 40 s, and once more when the page is left. https://github.com/Xosrov/YouTube-Playback-Metrics
- **The point:** YouTube reports which media ranges played, not a running total, so the server can check and de-duplicate them.

### Plex and Tautulli
- **Plex clients** *(community)* report `/:/timeline` with state and time about every 10 s while playing. https://forums.plex.tv/t/play-state-not-syncing/86451
- **Tautulli:** `play_duration = stopped − started − paused_counter`. A stream with no update for 5 minutes is force-stopped. Plays under 120 s are not logged, and a stop within 10 s of the end counts as watched. https://raw.githubusercontent.com/Tautulli/Tautulli/master/plexpy/activity_processor.py

### Jellyfin and its Playback Reporting plugin
- **Clients** report `/Sessions/Playing/Progress` (with `IsPaused`, `PositionTicks`, `PlaybackRate`) every 10 s and on pause, seek and stop. https://raw.githubusercontent.com/jellyfin/jellyfin-web/master/src/components/playback/playbackmanager.js
- **The server** stops a playing session whose last check-in is over 5 minutes old, at the last reported position. https://raw.githubusercontent.com/jellyfin/jellyfin/master/Emby.Server.Implementations/Session/SessionManager.cs
- **The plugin** adds up only START/UNPAUSE → PAUSE/STOP spans, so paused time is left out rather than subtracted. It puts a synthetic stop at the last update when no stop arrives. https://raw.githubusercontent.com/jellyfin/jellyfin-plugin-playbackreporting/master/Jellyfin.Plugin.PlaybackReporting/Data/PlaybackTracker.cs

### Emby
- **Reporting:** every 10 s and right after any user action (`IsPaused`, `PositionTicks`, `PlaybackRate`). https://dev.emby.media/doc/restapi/Playback-Check-ins.html
- **Idle sessions:** forum logs show "gone idle while playing" about 60 s after the reports stop (not documented).

### Mux Data and Conviva
- **Mux, a view:** "an attempt to play a video". It ends when ended explicitly, or 60 minutes after playback stops; playback that resumes within that hour joins the same view. https://www.mux.com/docs/guides/understand-metric-definitions
- **Mux, the two clocks:**
  - Watch Time is wall time (startup and rebuffering included, so 2 minutes at 2× is 1 minute).
  - Playing Time leaves out rebuffering, seeking and pauses; Content Playing Time counts only while the playhead moves. https://www.mux.com/docs/guides/data-engagement-metric
- **Conviva:** a heartbeat every 20 s, and a session expires after 120 s without one. Playing Time counts only time the player reports as playing. https://docs.conviva.ai/vsi-video/metrics/

### Google Analytics 4
- **Engagement time:** counted only while the page is in focus or the app is in the foreground. It is sent when the page is hidden, loses focus or is left. https://support.google.com/analytics/answer/11109416

### The page lifecycle in browsers
- **The last reliable moment:** the page going hidden; `unload` often never fires. A frozen page runs no timers (`freeze`/`resume`). https://developer.chrome.com/docs/web-platform/page-lifecycle-api
- **The last report:** `navigator.sendBeacon` on `visibilitychange` → hidden, with `pagehide` as a backup. https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon
- **Chrome's throttling of hidden tabs:** timers at most once a second. After 5 minutes hidden and silent, at most once a minute ("intensive"). A tab playing audio is exempt. https://developer.chrome.com/blog/timer-throttling-in-chrome-88

### Presence
- **WebSocket ping/pong:** a peer must answer a ping. The `ws` library recommends a server sweep every 30 s, because a half-open link leaves both ends unaware. https://github.com/websockets/ws/blob/master/README.md
- **Socket.IO:** ping every 25 s with a 20 s timeout, so a dead link is noticed within 45 s. https://socket.io/docs/v4/server-options/
- **Phoenix:** a 30 s heartbeat; an unanswered one closes the socket. **Discord:** a server-chosen heartbeat of about 41 s; a missed ACK means close and reconnect. https://docs.discord.com/developers/topics/gateway
- **Slack:** "away" after 10 minutes of inactivity, or when the app is closed. https://slack.com/help/articles/201864558
- **Restarts:** presence lives in memory and is rebuilt from what reconnecting clients say. Reconnects wait a random time so they don't all arrive together.

### What the sources agree on
1. Credit only time when the playhead advances; pause, rebuffering and seeking are not watching (Mux, Conviva, Jellyfin).
2. Each report credits at most the smaller of the wall time that passed and the media time that played (divided by the speed), with a cap.
3. A gap longer than the reporting window is never credited; the session ends at its last check-in (Tautulli, Jellyfin).
4. Each session is clamped to its wall span and to the media's length.
5. Very short plays are not history (Tautulli 120 s, Jellyfin about 20 s).
6. Concurrent plays of one title by one person are de-duplicated. No vendor documents its exact rule.

## 7. Verified on devices (2026-11-04)

**Mi TV (QA build 5.8.4, versionCode 199 to 201, private server through `adb reverse`):**
- **Playing:** the server's count followed the position within a second. Position 13 / 28 / 48 / 68 against 12 / 27 / 47 / 67 s credited.
- **Paused for 40 s:** nothing was added (82 / 80 before and after). The admin showed Paused at once.
- **Home button while playing:** the app's JS stops in the background. The viewing went to "Not answering" after 45 s and closed at its last report ("silent", 101 s credited for 103 s played). The client was gone at the heartbeat deadline. Back in the app, it reconnected and went on.
- **Screen off (`KEYCODE_SLEEP`) while playing:** the socket closed within 20 s. The viewing ended ("closed", 31 s credited for 31 s played).
- **Found and fixed on the device:**
  - The first ~11 s of a play were lost. The activity effect re-ran when the stream's details landed, ended the viewing and started a new one.
  - About 1 s was lost per report, from a watch-clock tick with a stale position. The phone emulator check found this one.

**Android phone emulator (QA build 1.0.4):**
- **Profile chosen:** presence showed `app: phone`, `hb: 60`.
- **Playing and pausing:** playing counted, and a 40 s pause added nothing.
- **Home:** no picture-in-picture on the emulator, so the player was held still. The viewing went quiet, then closed at its last report with nothing counted for the background.
- **Force-stop:** the client was gone in under 10 s and the viewing closed.
- **Offline play:** a saved copy played 63 s with the server cut off. Nothing reached the server until the app came back to the front. Then one offline session of 62 s arrived, and a second foreground or a cold start did not count it again.
