# Watch time and presence

elia, 2026-11-04: *"currently if a person stops the playback, leaves the TV or computer with the movie or episode paused, or just closes the laptop while a movie is paused or playing we for some reason consider this watch time, that's the only way to explain watch time of 71 hours for one 40 min episode only 1 person has seen… make sure who we consider connected still is someone that answers a ping."*

This page has four parts: what other products do (research), how Aurora worked before this change (the map and the 71-hour cause), the rules now, and the presence rules.

<!-- PARTS-BELOW -->

## 1. Research: how others measure it

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
