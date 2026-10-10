# Changelog

Shown inside the app under Preferences → What's new. Newest first; one
"## version — date" heading per release, plain bullets under it.

## 1.6.87 — 2026-10-10

- **Press a person, see their work.** On the website (phone and desktop), pressing an actor or the director — in X-Ray or in the cast line of a title page — opens a sheet on top of what you were doing instead of jumping to search: a few portraits of them, a short biography, and their films and shows, the ones already in the library first. Pressing a title adds it to My List (the card shows a tick; press again or use Undo to take it off); "Details", a long press, a right-click or the I key opens the title's page instead. It works over a film, in fullscreen too, and the film stays as you left it. A kids profile only sees titles it is allowed. Photos and filmographies come from TMDB (IMDb offers no way to fetch them); the sheet links to the person's IMDb page. The TV app gets the same sheet with its next update.
- **My List downloads wait their turn.** A download that started because someone added a title to their list is now the lowest priority: it starts after every other download, and while anything else is waiting or downloading it goes on hold, keeping what it already has, and carries on by itself about a minute after the queue is quiet. Downloads people ask for come first, then next-episode and followed-show downloads, then My List. Held downloads show as "On hold" with their progress; Admin → Downloads has "Start now" for them, and a setting to let them run alongside other downloads whenever a slot is free instead.

## 1.6.86 — 2026-10-10

Fixes on the website and the server, from a side-by-side check of the website and the TV app.

- **Pairing a TV by typing its code works.** The TV says "open nufurora.com/link and type this code", but that page had no place to type it. It has one now. Ten wrong codes from one address in fifteen minutes pause lookups from that address for a while.
- **A forced password reset is asked for** after every kind of sign-in when sign-in is required (it was only asked at the profile wall).
- **"Sign out everywhere else" reaches the other devices at once** — it was announced to every device of every profile and acted on by none; now only that person's other tabs are told, and they return to the sign-in screen. A tab that signs in also joins the live connection straight away (it used to miss live updates until a reload).
- **Notifications follow the person using the browser** — on a shared browser they stayed with whoever switched them on first. Signing out withdraws them.
- **The website goes to the sign-in screen when sign-in is switched on mid-session**, instead of failing request by request.
- **The player never saves progress over a watch history it could not read**, so a failed read cannot reset a title to the beginning.
- The AI page forgets its last answer when the profile changes; downloads catch up when the connection returns; the password sheet says why an unlock failed (too many tries, locked by the admin, no connection) instead of "Not quite"; two pieces of wording corrected.

## 1.6.85 — 2026-10-10

- **My List downloads.** Adding a film to your list downloads it; adding a show you have not started downloads its first episode (a show you are already watching is left to the next-episode downloads). The website says so when you add it ("saved for later — downloading the film"). A copy nobody has watched after 14 days is marked stale and offered first under Admin → Free up space → Suggest what to delete; after 21 days it is deleted by itself, and the title stays on your list to stream. Watching it at any point keeps it. Only copies fetched this way are ever removed — never something downloaded by hand. Two people adding the same title is one download; a kids profile never fetches something over its limit; each person starts at most 5 a day. Admin → Downloads → "My List downloads" has the switch, the day counts and a Keep button per copy. The TV app shows the same from its next update.

## 1.6.84 — 2026-10-10

- **Aurora TV 5.1.31 — pictures are back on TVs signed in to a server that requires sign-in** (Zev's report from a Chromecast: "Photos on home, movies and shows tabs are not working at all"; the server log showed every picture request arriving with no session at all). The cause was in React Native itself: on Android this version only passes a picture's request headers along when the source is written as a list, and every picture in the app passes a single source — so the TV's sign-in never travelled with its picture requests, and a server in sign-in-required mode refused each one. The app now carries a one-line patch to React Native that forwards them. Checked on the Mi TV against a server in sign-in-required mode: Home, Movies and a title page load their pictures, with no refused request in the log. **Every TV needs this update.**
- With sign-in required, the server was also refusing its own requests for the soft placeholder pictures (the "blur-up" shown while a cover loads), so nobody got placeholders and the log filled with refusals. It now recognises its own requests.

## 1.6.83 — 2026-10-10

- The healer names a failing file correctly whichever system wrote its path: a Windows path in the log was shown whole on a Linux server instead of just the file's name. (This was also why the automatic checks on GitHub had failed on every push since 1.6.73.)

## 1.6.82 — 2026-10-10

- For the TV lab's artwork test: the server can hand a pre-blurred picture out as WebP when a client asks for it (`?blur=…&fmt=webp`, about a third of the JPEG's size). Nothing asks for it yet — every app gets exactly what it got before.

## 1.6.81 — 2026-10-10

- **The hero is sharp on a desktop screen** (elia: "on web the hero always has low res photos"). The website never asked for a backdrop wider than 1280 pixels, whatever the screen — and the billboard draws it about 2100 wide on a 1080p monitor, more on a scaled laptop or a retina display, so every hero was a 1280 picture stretched by half again. The "sharper picture when idle" upgrade had the same ceiling, so it never helped. The site now asks for the width the hero is drawn at, up to the 1920 the artwork comes in; the server gained 1600 and 1920 steps so that arrives as a WebP rather than the 0.5–1.3 MB original. Title pages and the screensaver get the same. A slow line or Data saver still gets the small picture first, and phones ask for what they always did. Website only — the TV app is untouched and receives exactly what it did.

## 1.6.80 — 2026-10-09

- **Aurora TV 5.1.30.** In the open menu the logo lines up with the rows (elia). The menu's rows are no longer focusable while it is shut: at a cold start Android's first focus search could land on them before the home page had drawn, and the menu came up open on its own.

## 1.6.79 — 2026-10-09

- **Admin → Insights shows the TV's frame timings.** Each screen's p50 / p90 / jank as the Android TV app measured them, one row per app version and per implementation (which components draw natively), beside the boxes that reported them — model, Android level, RAM, heap, GPU, and why a box ran its low-memory economies. "Copy stats" carries the same two sections. This is the evidence base for the native-rendering work (`docs/native-rewrite`, P0).

## 1.6.78 — 2026-10-09

- **Aurora TV 5.1.29.** The rail's logo mark is smaller (28dp closed, 36dp open) and optically centred over the section dots — the beam's weight is on its flat side, so a box-centred mark read as standing left of them (elia).

## 1.6.77 — 2026-10-09

- **No pictures on a TV, fixed on the server** (elia, from a HOT Streamer on nufurora.com: "No cover photos anywhere", every `/img/…` answered 401). The sign-in wall read the browser cookie first and stopped there; a TV carries a cookie from an earlier unlock or login *and* its stored session in the X-Session header, and once the cookie's session had been revoked (an admin kick, a later unlock replacing it) the dead cookie shadowed the live header on every request. The wall now takes whichever of the two is alive, and signing out revokes both. A refused request is logged once a minute per path (`[auth] 401 … cookie=dead x-session=live`) so the next such report reads straight off the log. No TV update needed for this one.
- **Aurora TV 5.1.28.**
  - Trailers from YouTube play again on the box. Three things stood in the way, all seen on the Mi TV: Google's abuse wall answered the resolver's Firefox user agent with a "Sorry…" page (it presents itself as Chrome now — replayed from the same network: Firefox 403, Chrome 200); the web player call still gets that page now and then, so the resolver also asks as the iOS app; and the whole extraction (several calls plus the player cipher run through a JavaScript interpreter on the box) takes 10–20 s on a Mi TV, so the 15 s limit cut most of them off — it is 30 s, and a page starts resolving the moment it opens, so the Trailer button plays at once. Apple's trailers were never affected.
  - The show page: LEFT from the Play button or the first action opens the menu instead of doing nothing (DorM). Play on an episode that is not downloaded says so right under the button — "Getting sources…", "Downloading · 34%", "Ready" — instead of a toast far away, and the episode card's download state clears within seconds of a cancel from the site or admin, with or without the live socket.
  - A new episode that finished downloading shows up on the Android TV home screen's Aurora channel as "New: Silo S3 E5" and, when the switch in Settings is on, as a TV notification (DorM's idea).
  - Marking a season watched no longer starts smart downloads for it, and "mark unwatched" gives every episode back the position it had (one request for the whole season, with a restore of what was there). The same mark route serves the website's Watched buttons.
  - The rail's logo is the bare Beam mark, as on the site — no tile behind it (elia).
  - The NEW badge on cards is smaller.
  - Trailers on the hero stop when the menu opens; Surprise me returns focus to its button on BACK; the AI page's off state answers LEFT and a press with a hint; the subtitle timing row no longer wraps; "Settings" is labelled in the rail.

## 1.6.76 — 2026-10-09

- **Aurora TV 5.1.27.** The AI page's cards are wider (six to a row instead of eight) so the title and the reason read from the sofa, with three lines for the reason. A card whose picture fails to load now tells the server why (the route, the size asked for and the player's own error text), as a client error in Insights → usage — so a TV with no pictures in someone else's living room can be diagnosed from the admin page.
- The server logs an artwork request that fails (`[img] …`) instead of answering a silent 502 or 404.

## 1.6.75 — 2026-10-09

- **Aurora TV 5.1.26: the AI page gets out of the way once it has answered.** When the picks arrive, the mood field and the What / Era / Length dials fold to a single line ("a clever thriller · Movies · Any era · Any length · Change") and the picks take the screen. Moving up onto that line opens the controls again with the search bar ready; moving back down into the picks folds them.
- For testing the pages that show the recommender's picks without spending anything: `AURORA_AI_MOCK=1` in the server's environment makes the recommender answer a fixed list. Never set it on a real server.

## 1.6.74 — 2026-10-08

**Aurora TV 5.1.25 — smoother on weak boxes, honest on a bad connection.** Tested on the Mi TV, including through a deliberately slow line (0.9 Mbit/s, a quarter-second of lag).

- **Covers that never showed on a slow connection** (elia: "only the names"). Two real causes, both fixed. Every picture was fetched at full size and shrunk on the TV — posters, backdrops, episode stills now come from the server at the size they are drawn, about ten times smaller, through the server even for catalogue titles. And the server dropped an idle connection after five seconds, which on a laggy link cut a picture off just as the TV reused it; it now keeps connections for over a minute. On the throttled line every cover of the Movies grid is in within three seconds, where before Inception, Jolt and Knives Out stayed blank for good.
- **A screen no longer freezes waiting for the network.** Requests had no limit at all; a stalled link left a screen waiting for minutes. A request now gives up only when the connection is actually dead (no answer for 45 s, or silence for 30 s while one is coming) — a slow answer that is still arriving is left alone.
- **Wrong screens on a bad line, fixed.** Movies and Shows said "Nothing matches" or "0 to stream" when a request failed; now they say the load failed, retry by themselves three times, and offer Retry. A failed page no longer ends scrolling. The downloaded shelf never appears empty while the list is still coming. A film that could not load offers Retry and says whether it was the server or the title. A library file that shows nothing for 25 seconds gets a card: keep waiting, lower quality (a 480p encode from where you are), or back.
- **Smoother.** Confirmed in the library's own source: this version of React Native TV asked the system about accessibility services on every single animated frame; that call is now answered from memory. The hero's blurred backdrops are blurred on the server instead of on the TV, three times per rotation. The trailer no longer forces the whole screen to be redrawn on every video frame, and the trailer player is dropped the moment a trailer ends instead of living on under the film. Several full-screen layers nobody could see are gone. Card shading is a picture instead of a vector drawn per card. Measured on the Mi TV: memory from 363 MB to 309 MB, graphics memory from 156 MB to 95 MB, and the app draws 34 frames in 15 seconds while a trailer plays instead of 364.
- **The TV knows what it is running on.** A native module reports memory, GPU and frame stutter per screen to the server (usage events), and a low-memory box gets a lighter player buffer and emptier image caches without looking different.
- **Remote: one press, one move.** A touchpad remote sometimes registered two steps for one swipe (elia). The app now acts once per press, and the native side drops a repeat of the same key within 110 ms; holding a key to scroll still works.
- **Left on the hero's button opens the side menu**, as everywhere else. Right on the last button still turns the slide.
- **Trailers play inside Aurora.** The TV handed trailers to the YouTube app, which on some sets opens YouTube's home page instead. "Open in YouTube" stays as a button. The hero trailer starts after 4.5 s.
- **The AI page, redesigned:** an explanation of what it does, the controls grouped as What, Era and Length with icons, a compact grid that fits about eight picks per row, and Try again now gives a different list instead of the cached one.
- **Server:** `?blur=` and three new sizes for the image resizer; longer keep-alive; a slow-connection test proxy in `tools/throttle-proxy.js` for testing the apps against this server on a bad line.

## 1.6.73 — 2026-10-08

- **The healer does a great deal more.** It ran 14 checks a minute and its log check only counted errors. It now runs 29, in seven groups, and still finishes in milliseconds:
  - **It reads the log by meaning.** About thirty known problems — disk full, too many open files, a data file that would not save, ffmpeg missing or failing, the download engine not answering, a rejected TMDB key, a provider rate limit, a push token Apple refuses, someone guessing passwords — each get a plain sentence, and a repair or the name of the button to press. A kind of error it has never seen is reported once, with its text, instead of being a number. A film that keeps failing is named.
  - **It looks at the numbers, not only the log.** How long films take to start and how often they stall or fail, by device and by path; viewings that ended abnormally; encoders and refusals; how downloads have gone over the week; a library folder that has gone missing (reported loudly, never read as "the library is empty"); files that vanished or are cut short; backups; memory heading for trouble hours ahead; helper processes with nothing to do; whether a restart or an install is pending; whether alerts are actually being delivered; the clock; data files growing without limit.
  - **It can press the safe Actions itself**: tidy stream leftovers, re-apply the download-engine patch, rescan when a library drive comes back, back up when the newest backup is too old, retry a file that was replaced. Each has a daily limit and a cooldown, and after that it says "tried N times, needs you" with the button. It can never update, install, restart or send a test alert on its own — that is enforced in code and tested. `"healer": { "autoRepair": false }` switches the repairs off.
  - **Optional AI, off by default.** With an AI key and `"healer": { "ai": true }`, a brand-new unknown error gets a two-sentence explanation — at most five a day, with paths, addresses, e-mails and keys stripped before anything is sent. The answer is only shown; it cannot trigger anything.
  - The Healer card in admin groups all of this, problems first, healthy groups folded to one line, with a list of what the healer did by itself.
- A library drive being away no longer erases the list of finished downloads or the skip-intro timestamps of its episodes.
- Rescan in Actions says how many titles it found.

## 1.6.72 — 2026-10-08

- **Aurora TV 5.1.24: the TV reports what the site reports.** A TV never told the server what it was watching, so it was missing from History, from sessions and from the admin's live "who is watching" (elia). It now says so every five seconds with its position, as the site does, and "browsing" when it leaves the player; a socket that reconnects mid-film says it again. It also sends the playback marks the site sends — how long a film took to start and by which path, stalls, errors — and the usage events it lacked (search, audio track, stalls). In the admin page a TV is now named for what it is ("TV · Aurora TV 5.1.24 · Xiaomi MiTV-AFMU0") instead of "Desktop · Other · Other". A side effect worth having: "hold new downloads while someone is watching" now sees people watching on a TV.

## 1.6.71 — 2026-10-08

- **A slow download gets a second source.** When a download is slow because of where it comes from — no torrent details after two minutes, nobody to download from after three, or a finish time far beyond what its size should take — Aurora starts the next-best source of the same resolution beside it. Whichever finishes first is kept; the other is cancelled and its temporary files removed. You still see one card per title, with "trying a second source" while it happens. It is deliberately careful: the second source is given about a minute to prove it really connects before it counts; nothing is raced when the line itself is the limit, when a speed cap is set, when someone is watching, or when the download is nearly done; a race that makes nothing faster is stopped; at most two other sources are tried per download and one race runs at a time. Sources that stalled, failed to connect or lost are remembered for six weeks and ranked lower for that title. The resolution is never changed behind your back. Tried with real torrents: a dead source was noticed at two minutes, and a weak source was overtaken and replaced by a faster one. `"downloadRace": false` in config.json switches it off.
- **Downloads at once** is a setting (admin → Downloads, beside the speed caps): 1 to 6, now 4 by default instead of 2. While someone is watching, no more than two start; the rest wait and carry on afterwards.
- A torrent whose details never arrive no longer logs an uncaught error.

## 1.6.70 — 2026-10-08

Nine things a hands-on pass through the site found.

- **Auto quality now moves between Original and the lower qualities on HEVC films.** It stayed wherever it was put: the original is HEVC and the lower ones H.264, and the player's own automatic choice never crosses from one to the other. Aurora now makes that choice itself on such films.
- **Back after a run of episodes** goes to where you started, not back through every episode's player — each of which started a stream and moved your place.
- Auto stays in the Quality menu after picking Original.
- Mute is remembered into the next episode and the next film, as the volume already was.
- Original is no longer labelled "re-encoded" on a file that plays directly while a lower quality is showing.
- What's new shows its bold leads as bold instead of printing the asterisks.
- Opening an episode's sources no longer scrolls their heading under the navigation bar.
- The loaded part of the timeline is the part around the playhead, not everything up to the furthest thing ever loaded.
- A catalogue address with an id that does not exist says so instead of drawing a page called "Untitled".

## 1.6.69 — 2026-10-08

- **Server → Actions, in the admin page.** The things that used to need a terminal are buttons: update and restart in one press, what version is this, pull, npm install, restart; run the test suite, test streaming on this machine, tool versions, the health checks, the healer, a test alert; back up now, verify the backups, rescan, the daily refresh, age ratings, missing subtitles (with a dry run); the caches; the download-engine patch. It is a fixed list — each entry shows the exact command it runs, and nothing typed in a browser is ever turned into a command. The page also gains the Backups table (with download), the Alerts card and a list of recent runs with their output.
- **Two people watching the same repackaged film** at different places no longer knock each other's stream over: each gets its own producer (up to three per film), where there used to be one that both kept re-aiming.
- **`"torrents": false` in config.json now switches torrents off for real** — no download engine, no torrent streams or downloads, no source lookups — and the site stops offering what would only fail. Library playback is untouched.
- Resuming a title that plays directly starts four seconds before where you stopped, like every other stream.
- A page change interrupted by the next one no longer logs an error.
- **Aurora TV 5.1.23.** Closing a menu in the player puts you back on the button that opened it (it used to land on Rewind, so the next OK jumped back ten seconds). The Settings menu on a film with one audio track opened with nothing selected and could not be used. Up from the outermost buttons now always reaches the timeline.

## 1.6.68 — 2026-10-08

- **A quality ladder.** A library film that is repackaged for the browser is now offered as one stream with several qualities under it — the file as it is, 720p and 480p, only those below the source — and the player moves between them by itself as the connection changes, up as well as down, with no rebuild and no black gap. The Quality menu gains Auto, and a pick is a switch inside the same stream. Every quality is cut at the same places, to the frame (checked on three films), and the lower ones are only encoded when someone is watching them. Data saver starts on 720p and stays at or under it. Direct play and the TV app are unchanged; iPhone's own player and torrents do not use the ladder yet.
- **The end of a film is no longer taken for a slow connection.** Every film switched to a 480p re-encode for its last eight seconds.
- **Back after an episode.** Leaving an episode opened from its show page goes back to that page instead of stacking a second copy, which had made Back bounce into the player again.
- Quality → Original no longer claims a re-encode on a file that is playing directly.
- A hung quality change can no longer hold back the "Playback stopped" card.
- A kids profile following a link to a blocked title's player is told why.

## 1.6.67 — 2026-10-08

- Aurora TV 5.1.22: the logo in the side rail is larger and crisp (elia: it read as low-res). It was a single image the TV shrank on the fly to 52 pixels; it is now drawn about a third larger closed and half again larger open, from files rendered at the exact pixel size each screen uses, 1080p and 4K, so nothing is rescaled.

## 1.6.66 — 2026-10-08

- **Browser tests.** `npm run test:ui` drives the real web app in the installed Chrome against a private, offline server with a generated library: 106 tests across the profile wall, navigation, library, title pages, the player (including stall recovery), settings, live updates, kids profiles, images and the admin page. See `docs/testing.md`. The first run found ten bugs; three are fixed here and the rest are pinned by tests marked todo.
- **"Help improve Aurora" off now stays off.** The switch in Preferences → Privacy was never stored by the server, so it came back on after a reload.
- An episode you own stays playable from its sources panel when the source provider cannot be reached.
- A kids profile that follows a link to a library title it may not see is told so, instead of landing on Home without a word.

## 1.6.65 — 2026-10-08

- **A logo.** Aurora has its own mark now, "Beam": a play triangle cut into bands of green, teal and violet on a dark purple-green ground. It is the site's icon and Home Screen icon, the notification badge, the mark in the navigation, and on the TV the launcher icon, the banner and the mark in the side rail. The sources and the script that redraws every size are in `docs/brand/`.
- **Seeking in transcoded streams lands where the playlist says.** The on-demand transcoder promised one set of segment lengths in its playlist and cut another, so a long film could drift, stutter at a seam or end early. It now cuts one segment per picture group at the places the playlist names, checks the first ones against the promise, and for the rare damaged file that cannot be cut that way it says no once and falls back to the ordinary stream instead of guessing. Measured exact on seven file and format combinations.
- **Kids profiles, tightened.** A title with several ratings is judged by its strictest one. Leaving a kids profile on the TV asks for the household PIN (a number pad; the lock survives closing the app), and the profile wall shows a KIDS badge. In a house with a kids profile and a PIN, a grown-up profile with no password asks for the PIN too, so open mode is no longer a way round. A few small leaks are closed: a poster asked for by its address when the title is not one the profile may see, an unlock token issued to a kids profile being read as a grown-up one, and the offline copies a browser keeps (dropped when a kids profile is entered or left).
- **Subtitles and dubs are remembered by language.** Pick Hebrew, English or Russian subtitles (or switch them off) and the next title starts that way, on the site and on the TV; the automatic subtitle fetch no longer overrules what you chose.
- **Backups.** Once a day the server writes one small archive of everything a household would miss — profiles, progress, lists, follows, sign-ins, settings, usage, its own configuration — keeping seven daily, four weekly and three monthly. It is a plain `.tar.gz` that opens anywhere. By default it sits in `data/backups`, on the same disk as the data: set `"backupDir"` in config.json to another drive or a synced folder for a backup that survives the disk.
- **Health alerts.** The server tells whoever runs it, once and in a sentence, when the disk is filling, ffmpeg is missing, the download engine is dead with jobs waiting, there has been no backup for two days, or it keeps restarting — and again when it recovers. Sent through ntfy or Telegram when configured, and listed at `/api/admin/alerts`. `"healthPingUrl"` pings a dead-man's-switch service every five minutes.
- **Web Push.** Notifications on iPhone did not arrive: the sender's contact address was a placeholder, which Apple refuses. It is now the site's own address (or `"pushContact"` in config.json), and the log names the push service's reason when one says no. A subscription may only point at a real browser push service (Google, Mozilla, Microsoft, Apple), never an arbitrary address.
- **Aurora TV 5.1.21** carries the logo, the kids PIN and the language memory.
- Restarting from the admin page saves everything first.

## 1.6.64 — 2026-10-08

A round built in parallel and then tested in a real browser and on the Mi TV.

- **Kids profiles.** Mark a profile as a kids one with an age limit (all ages, 7+, 12+, 16+) from its edit sheet or the admin's People tab, and it only sees titles rated at or under that age — home, browse, search, the library, title pages, X-Ray, streams and downloads are filtered on the server, and anything without a known rating stays hidden. Leaving a kids profile on the site, or switching kids mode off, takes a household PIN (4–6 digits, set by whoever enables kids mode first, changeable by the admin). Needs a TMDB key for ratings. The TV gets the filtering but has no PIN step yet.
- **The player recovers from a silent stall.** After six seconds of a frozen picture it gives the stream a harmless nudge, after twenty it rebuilds an idle stream at the same second, and if that fails it says so with a Try again card — never touching a seek in flight, a torrent waiting on its swarm, or a watch party. A fatal stream error now rebuilds at the playhead instead of restarting a film at 0:00, and a far seek that "ended" the stream recovers at the place you asked for.
- **Still watching?** After three episodes have started by themselves with nobody touching anything, Up next asks instead of counting down.
- **Next episode is the next episode.** Next and Up next used to jump to the next one *on disk* (E4 → E8 when E5–E7 were not downloaded); they now offer the real next episode and open its sources when it is not here yet.
- **Phones.** Leaving the tab while a film plays moves it into picture in picture where the browser allows; Safari gets an AirPlay button when an Apple TV is in reach and the stream can be handed over; the installed app has Home Screen shortcuts and puts a number on its icon when a download finishes in the background (not on iPhone yet). The lock-screen controls no longer lose their title when an episode changes.
- **HDR.** HDR10 and HLG titles that have to be re-encoded for a device that cannot play them directly are tone-mapped to SDR, so they no longer come out grey. Direct play and every SDR title are untouched — their encodes are byte-for-byte what they were. The server times the filter on its own hardware at startup and only uses it where the stream stays at least 1.5× ahead of real time; `AURORA_TONEMAP=0` switches it off.
- **Aurora TV 5.1.20.** The TV hears the server instead of asking it: a download counts up on its card and turns playable the moment it lands, and Home, Movies and Shows pick up new arrivals by themselves (an idle title page had also been re-asking the server in a loop; that is gone). Aurora's row on the TV's home screen refreshes every few hours with the app closed and tidies its old pictures. Shows can be followed from the TV. The dub and subtitle you pick follow your profile between the TV and the site. Poster slots show a soft preview while the picture loads.
- **Admin log.** The once-a-minute "OperationError: User-Initiated Abort" was pm2's own exception hook printing every dropped web peer beside Aurora's quiet count; the harmless case is now filtered before that hook sees it, and real errors still print.
- **README** rewritten, with pictures. Three logo proposals are in `docs/brand/` (none installed).

## 1.6.63 — 2026-10-08

- Aurora TV 5.1.19: Aurora on the TV's own home screen (elia: "like Disney+ does"). A row named Aurora sits among the other apps' rows: what this profile is part-way through comes first — the frame it stopped on, with its progress — and the recommendations follow. Pressing a resume entry opens Aurora straight into playback at that point; pressing a recommendation opens its page. The row is rewritten whenever Home loads and only when it changed, and it leaves the TV's home screen when the profile is switched. Measured on the Mi TV's Google TV home: the row shows, with pictures; the launcher's own "Continue watching" row is kept for partner apps and did not take Aurora's entry (it is still published, for launchers that do). Pictures that live on the Aurora server are fetched inside the app, with the session, and handed to the launcher through a small read-only provider — the launcher cannot sign in, and refuses a plain-http LAN address.

## 1.6.62 — 2026-10-08

- Aurora TV 5.1.18: an update no longer waits for the app to leave the screen (elia: on new streamers that rarely happens, so a TV stayed on the old version for days). The build is still fetched quietly, and when it is on the TV a sheet says so: **Restart now** or **Later** — never over the player or another sheet. Restart now installs it at once (about three seconds on the Mi TV); Later keeps the old behaviour and installs when Aurora next leaves the screen. Android refuses to let an app reopen itself from the background, so after the install the TV returns to its home screen and the sheet says so honestly — unless the viewer allows "Display over other apps" for Aurora (a third button on the sheet opens that settings screen), in which case Aurora comes back by itself, measured at about ten seconds.

## 1.6.61 — 2026-10-07

- Next episode, on the TV and the site (elia): a button in the player's row beside +10, there from the start of any episode that has one after it — Up next at the credits can be dismissed, and was no help to someone who wants the next one now. A press saves your place and starts the next episode; a watch party's host carries the room along. Library episodes on the TV; on the site a streamed next episode opens its page to pick a source, as Up next does.
- Aurora TV 5.1.17: the nav rail's aurora curtains are gone (elia: "ditch our attempt of the aurora effect and just add the hues"), replaced by the room's hue — and it moves (elia: "make them move a bit"): two soft glows, violet high and green low, drifting and breathing on the native driver. Measured on the Mi TV with the rail open: 60 frames a second, no janky frames; nothing is drawn while the rail is closed, and a slow box gets the same glows standing still.
- Aurora TV 5.1.17: a cover that failed to load is asked for again (elia: "it will just not try again") — twice quickly, then the server's backup poster for the title, then every half minute while the card is on screen.

## 1.6.60 — 2026-10-07

- Web: blur-up placeholders (elia). A poster or hero shows its picture's colours and rough shape from the first frame, and the real picture comes into focus over it, instead of a grey shimmer. The server keeps a 16-pixel WebP of every picture it hands out (about 230 bytes, made in the background with ffmpeg and cached on disk) and sends the ones it has beside a page's data — the hero's slides and the posters first, up to 120 per answer — to browsers that ask for them; the TV app and older tabs get exactly the answers they always got. The first visit after a new title appears has none for it; the next one does. On the lite tier and with reduced motion the picture simply replaces the placeholder.

## 1.6.59 — 2026-10-07

Ten of the streaming practices from the report, on the site (elia picked them):

- **Lock screen and headset controls (Media Session).** What is playing — title, episode, picture — with play/pause, ±10 s and a scrubber on the phone's lock screen, the notification shade, the iPhone's Dynamic Island, a headset's buttons and a keyboard's media keys.
- **Picture in picture.** A button in the player floats the film over other apps and tabs (desktop, Android, and Safari's own on iPhone/iPad).
- **Your languages follow you.** The audio language you pick in the Audio menu and the subtitle track you pick (or "Off") are remembered on the profile and applied to the next title that has them, on every device.
- **Resume four seconds early**, so you come back before the sentence, not in the middle of it.
- **An error card instead of a dead player.** A stream that stopped for good says so, with "Try again" (from this second) and "Back".
- **Pages follow the library.** The Movies and Shows grids and open search results update by themselves when a download lands or a file goes — same filters, same scroll.
- **Follow a show.** A Follow button on a show's page: new episodes download by themselves when they air (checked every three hours; only episodes aired after you followed, never one already here or queued).
- **Notifications with Aurora closed (Web Push).** "Tell me when it's ready" in Settings now reaches this device even when the tab is shut: a download you asked for, or one a follow fetched. No third-party service and no new dependency — the server signs an empty push and the service worker asks it what to say. An iPhone needs Aurora added to the Home Screen first, and the setting says so.
- **A page on its way shows its outline** (a heading bar and a grid of shimmering cards) instead of an empty dark page, when the wait is long enough to notice.
- **Sign out everywhere else**, next to the list of signed-in devices: every other session and unlock of the profile ends; this device stays.

## 1.6.58 — 2026-10-07

- Web: the TV's small touches, on the site (elia). The player's menus (subtitles, timing, speed, audio, quality, playback, subtitle style, help) carry a glyph on every section title and the violet-to-green hue in the glass; the X-Ray sheet carries the same hue; a film being saved shows a mint strip along the foot of its hero button that follows the download.

## 1.6.57 — 2026-10-07

- Trailers in 1080p, on the TV and the site (elia: "right now it's just on low res always, right?" — yes: YouTube sizes its quality to the player's CSS pixels, and setPlaybackQuality has been a no-op for years, so a 1100px TV frame or a 1650px laptop hero got 720p). The player is now laid out at exactly 1920 CSS pixels wide and scaled down to fit, so YouTube serves 1080p — exactly 1920, never more: at 2200 YouTube handed the Mi TV 2160p and the interface fell to 63% janky frames. A line or box that can't carry it steps down by itself: two rebuffers in the first 25 seconds (or one longer than 2.5 s) shrink the player to 1× and reload at the same second, and the session stays at 1× after that; a box the perf tier already judged lite, or a browser on the lite tier or data saver, starts at 1×. The trailer modal on the site gets the same doubling below 1100px wide.
- Aurora TV 5.1.16: a title page's small buttons (My List, Trailer, X-Ray, Versions, Watched) light up as a white disc when focused, like the player's buttons, instead of a ring drawn around disc and label that cut through the word (elia); the film's download strip and hint sit clear of the focused Play's ring (elia).

## 1.6.56 — 2026-10-07

- Aurora TV 5.1.15: a film the library lacks gets the episodes' flow (elia: "remove the warning from the Stream button … pressing Play downloads the best and only a long press opens the sources panel"). The button reads "▶ Play"; a press saves the server's best source (recommended, else best-seeded) and the button carries the job — "⬇ Starting", "⬇ Saving 34%" — with a mint strip and a line under it ("Saving the best source · hold Play for other sources"); a hold opens the list of sources. When the download lands the page turns into the copy's Play by itself. Idle, the line says "Press Play to save the best source · hold for the list".

## 1.6.55 — 2026-10-07

- Aurora TV 5.1.14: the X-Ray sheet carries the same violet-to-green hue as the player's menus (elia).

## 1.6.54 — 2026-10-07

- Aurora TV 5.1.13: the Home billboard's picture is a fixed layer that fades out with the scroll instead of travelling with the page and ending in a line a third of the way down the screen (elia: "under the hero on home it gets cut and it's noticeable").
- Aurora TV 5.1.13: subtitles sit lower while the controls are up — the old height dated from the taller chrome and left the cue floating mid-picture over the slimmer timeline (elia).
- Aurora TV 5.1.13: a card that has slid past a shelf's left edge fades into the page under the rail instead of being cut (elia); the room light has a touch more of the aurora's green, a third bloom low on the right (elia: "add some green hue, just a bit"); the player's menus (subtitles, speed, settings, watch together) carry an icon on every section title and a violet-to-green hue in the glass (elia); a poster that fails to load falls back to the title tile instead of an empty frame (seen in search results on the Mi TV).

## 1.6.53 — 2026-10-07

- Aurora TV 5.1.12: X-Ray on the TV (elia: "why not add X-Ray also to TV?"). An eye button on every title page and in the player's row: who is in this, who made it, what people thought — a sheet that rises from the foot of the screen with a small overshoot, the phone's shape at TV size. For an episode: its own guest cast first ("In this episode"), the regulars under them, the air date, runtime and rating, the director and writers; for a film or a show: cast, ratings, release, runtime, country, the crew by job. Faces are round portraits that keep their initials until the picture lands; Back closes; opened from the player the film pauses and resumes when the sheet goes. The server answers by library id now (`/api/xray?itemId=`), so the remote never needs to know a show's IMDb id or an episode's numbers.
- Aurora TV 5.1.12: an episode that is being saved wears a small download glyph after its "STARTING" / "SAVING 34%" text (elia).

## 1.6.52 — 2026-10-07

- Aurora TV 5.1.11: the collapsed rail's active dot is a lit pill like the hero's dots — taller, white, with the soft glow — instead of a plain white dot.
- Aurora TV 5.1.11 and the site: the episode to watch next carries the same rise in the accent purple; one that is also on disk blends both — green at the foot rising into purple (elia).
- Aurora TV 5.1.11 and the site: an owned episode's green rises from the card's foot and fades toward the top (elia), over the glass — baked as a small gradient image on the TV, two stacked gradients on the site.

## 1.6.51 — 2026-10-07

- Aurora TV 5.1.10 — four fixes from the household (elia), and the look of an owned episode: a soft green glass on the card instead of a tick on the picture, on the TV and the site (elia: "a green hue background"). **The dub:** the player's settings menu lists a multi-dub file's audio tracks (language, codec, channels, "Original") and switching restarts the stream at the same second with that track; the TV and the web both start on the title's original language — TMDB's original language for the title, matched against the file's audio tags on the server (`/api/item` marks the track `original`). **Watched controls:** hold OK on an episode card for Mark watched / unwatched, Sources and Play; a "Mark season watched" pill under the season pills ticks the aired episodes off (or back) with the same writes the site makes, so the web and the TV agree; streamed episodes now show their watched state on the TV too. **Trailers:** open in the TV's own YouTube app when it is installed (hardware decode; the in-app embed stuttered and dropped frames on real sets) — the manifest now declares the package visibility Android 11+ needs, which is why "Open in YouTube" did nothing before; the embed stays as the fallback. **Episodes, the site's flow (elia: "press on it downloads the best source and only a long press opens the source list"):** a press on an episode you don't hold saves the server's best source at once (recommended, else best-seeded) and the card carries the download — "SAVING 34%" in the kicker and a mint bar, polled while it runs; hold OK for Sources, Mark watched and Play. The number is gone from the still (the kicker says "EPISODE N"), and Continue Watching's bar is the site's violet-to-mint ramp with the lit bead. **Updates:** a TV that has not yet allowed Aurora to install apps is no longer held for the quiet update (which cannot run without the permission and failed silently) — the sheet shows at once; the install permission is asked for before the download, the screen reopens through fallbacks when the per-app one is missing, the manual path is spelled out, and coming back from Settings carries on by itself.

## 1.6.50 — 2026-10-07

- Admin, People tab — the design pass (elia: "more icons, easier to use, fonts, sizes"): stroke icons of the side nav's family throughout (modes, devices, downloads, addresses, every action), the sign-in status as chips (mode in one line, Google popup / TV code flow each a chip), quick filters with counts over the table (All · Online · Claimed · Not claimed · Needs attention), the table sorted with who is here now first then most recently seen, a live dot for "now", device and download icons in the cells, a chevron that says a row opens. The sheet: icons on the section titles and the sign-in facts, poster thumbnails on the recent downloads, a live dot on the address a device is connected from, tap any address, username or email to copy it, icons on the actions and Delete set apart under a dashed line, shorter tile labels, the scroll kept across live re-renders, a loading line before the first payload.
- Playback: "Original" is confirmed to be the file's video bit for bit — a copy, never re-encoded — on every device that can decode its codec (direct play for MP4/H.264, an HLS copy for MKV and HEVC). Only a device that cannot decode the codec (HEVC, AV1, 10-bit on most phones and desktops) gets an H.264 re-encode, and that encode now runs at crf 18 / superfast instead of crf 23 / ultrafast (elia: "I don't want low-bitrate artifacts, I want the real image as we downloaded it"); the Quality menu says "re-encoded — this device can't play the file's codec" there instead of claiming the file. The slow-line 720p/480p encodes keep their bitrate ceilings: those are about data, not fidelity.

## 1.6.49 — 2026-10-07

- Web: a hero picture that was served small — on a slow line the billboard and the title pages ask for a 780px picture at 1× density — is replaced by the full-size one later, by itself (elia): when the viewer has been still for a few seconds, the tab is visible, nothing is playing, and the line is neither slow nor on data saver, the full picture is fetched at low priority, decoded off-screen and swapped in — the same picture, sharper, nothing moves. A slide that has turned or a page that was left is skipped; a picture that was already full-size costs nothing. A line that recovers, a tab that returns or a window made wider tries again.

## 1.6.48 — 2026-10-07

- Admin, the People tab redone (elia: "reorganize and redo the whole People tab so it's easier to use and shows what's really relevant"). The sign-in switch sits on top as a segmented control and stays there while you scroll — never folded — with the current mode's one line and the Google setup behind a "how to set it up" fold. Who is waiting for approval shows only while someone is. Everyone is ONE table — person, sign-in (username, Google badge, email), last seen, devices, downloads, status — with five tiles above it (people, claimed, online now, devices connected, banned) and a search box. "Connected now" lists every open app or tab with its device and address, and for a device that hasn't opened a profile, who has used that address before ("probably elia"). Banned addresses fold at the bottom.
- Admin: press a person for their sheet — their sign-in details, last seen / addresses / signed-in devices / started / finished / list, who of theirs is online now (with Kick), their last 5 downloads with status and progress, their last 8 addresses and devices with Ban / Unban, and every action: Suspend / Unsuspend, Kick (sign out of every device), Reset password (they must pick a new one at the next sign-in), Set password, Delete. Full-screen on a phone.
- Server: `GET /api/admin/people` (one payload for the tab), `POST /api/admin/profiles/:id/kick` (closes live sockets, revokes sign-in sessions and unlock tokens), `POST /api/admin/profiles/:id/force-reset` (a new password is required at the next sign-in; `on: false` withdraws it). The gate honours it: the current password still opens the profile, then "Pick a new password" must be saved before going on; a new password — the person's or the admin's — clears the flag. Tests cover the flag and the token revocation.

## 1.6.47 — 2026-10-07

- Web, the sky on a phone (elia: the aurora still showed vertical cuts across the band on a real iPhone, not in a browser's phone mode): the curtains are painted as one-pixel columns at quarter resolution and rely on the upscale's smoothing to blend — iOS Safari ignores the high-quality smoothing hint, so the columns showed. Phones now get no curtains: a fuller starfield (210 stars, a fifth of them bright) that swings further between dim and lit, over a faint, still wash of the same violet and green so the glass keeps its tone. Desktops keep the aurora.
- Web, the sky everywhere (elia: "add more stars and shooting stars"): the desktop field grows from 170 to 260 stars with more bright ones, and every 7–16 seconds a shooting star crosses a tenth of the sky in under a second — a bright head, a tail that fades to nothing, flaring at once and dying away.

## 1.6.46 — 2026-10-07

- Web, the aurora on a phone (elia, iPhone 18 Pro: "the aurora effect looks choppy when scrolling"): three causes, all fixed. The sky canvas was sized to the viewport, which shrinks and grows as Safari's toolbar collapses while you scroll — each change reallocated and cleared the canvas mid-scroll; it now keeps the large viewport's height (100lvh) and ignores a toolbar's worth of height change. A phone painted the aurora at a fixed 12 fps, a slideshow on a 120 Hz screen — the cadence now follows the measured cost of a frame (30 fps when a frame is under 4 ms, 20 when under 9, 12 beyond). And the 150 ms hold after every scroll event, which left the aurora standing still through a fling and jumping after, now applies only when a frame is measured dear, on any device.
- Web: a device tier for the glass look — a genuinely weak device (two cores, 2 GB, or data saver) gets no live blur and flat tints on the chrome (`data-fx="lite"`); everything else keeps its glass.
- Web: a source row's audio flags no longer run out of the card and push the whole page sideways on a phone — at most five flags then "+N", and the line clips.

## 1.6.45 — 2026-10-07

- Web, scrolling (elia: "the background animation stops and it looks bad", "scrolling is laggy and choppy, especially to or from the hero"): the aurora sky no longer pauses while a desktop scrolls — the hold stays on phones only — and the surfaces that made every sky frame expensive stopped blurring what is behind them: the hero slab (its art fills it edge to edge, so the blur was never visible) and the many small glass cards (episodes, source rows, taste tiles, party strip). They keep the tint and the edge light.
- Web, choosing a stream for an episode (elia): the list shows the top three sources with one "Show all N" for the rest; pressing Save puts the list away and the episode card carries the job — "Requested" / "Starting" / "Downloading 34%" in the kicker and a mint progress bar, live — no "Downloading now!" modal. Pressing a downloading episode says how far it is; a HOLD (or right-click) on any episode brings its sources back. The block is away until an episode asks for it.
- Web: episode cards a touch less see-through (each stop of the glass fill lifted by 0.03), with hover and focus stepping up from there.

## 1.6.44 — 2026-10-07

- Aurora TV 5.1.8 — the episode timeline lies on the still's own bottom edge and the still's bottom corners are square under it (its top corners stay round), so the bar's ends no longer poke out past the picture's rounded corners (elia's photo).

## 1.6.43 — 2026-10-07

- Aurora TV 5.1.7 — the episode card's glass half is written like the site's (elia: "add a bit more info … make sure all episodes have all of the data"): the kicker "EPISODE 3 · 49 MIN" — the file's length for an episode on disk, the show's typical runtime from the catalogue for the rest, since Cinemeta has none per episode — the name, two lines of synopsis, and a foot line that leads with the air date (▶ 4 Feb 2022, the year dropped when it is this year) with CC and a ✓ once watched. A part-watched episode's progress is the site's timeline — a 3dp track on the seam between the still and the glass, the violet fill with its glow and a lit white bead at the head — instead of a slab inside the picture. The date comes from Cinemeta for every episode, so cards 3 and 4 no longer sit empty under their stills — before, only an episode on disk had a runtime to show. The site's three air states are ported: a dated future episode is greyed as upcoming, a date-less one past the season's last dated episode reads "Date TBA", and a season with no dates at all is simply aired.

## 1.6.42 — 2026-10-07

- Aurora TV 5.1.6 — episode cards take the site's glass look (elia: "the very small border and the glass background on the bottom half"): each card is a translucent box (white at 6%, 9% while focused) with the 1dp light edge every card has, the still inset 5dp inside it with the smaller corner radius, and the name, runtime and CC / WATCHED tags on the glass under it. A focused episode card — and a film's "More like this" card — scrolls the title page to its end, so the row never sits flush on the screen's edge (seen on the Mi TV: the box's foot at 1075 of 1080px).

## 1.6.41 — 2026-10-07

- Aurora TV 5.1.5 — the title pages take the Max / HBO shape (elia's references): the picture is the title's real key art (metahub's background, not a random frame still), it lives in the **upper right** — from 30% of the width to the edge, 76% of the height — and melts into the page down its left side and at its foot; the words sit on the plain page to its left, never over it — title, one small facts line, ONE big Play / Resume / Continue button, a row of small round icon buttons with tiny labels (My List · Trailer · Versions · Start over · Watched, or Similar on a show), and only then the synopsis, genres and cast. The page scrolls: a show's season pills and episode rail, and a film's "More like this" shelf, sit below the fold and come up as focus moves down.

## 1.6.40 — 2026-10-06

- Aurora TV 5.1.4 — the title pages redrawn as a designer would (elia): the artwork is the page, the lockup sits low on the left over a wider, darker ramp (title, one facts line with the badges, a quiet genre line, a two-line synopsis, the cast), **one row of equal buttons** (Resume · Start over · Other versions · Trailer · My List · Watched), and the half of the screen that was empty carries a **"More like this" shelf** of real cards at the foot, like a show's episode rail. The poster and the genre chips are gone from the film page.
- Home: no warning sign on the billboard's Stream (it stays on the title page and the source rows); the billboard's picture dissolves lower, under the first shelf's heading; a touch less air between the lockup and Continue Watching; content sits closer to the collapsed rail.
- The collapsed rail's dark edge reached the bottom of the screen 27dp short — its scrim was sized against the strip's padding box. Fixed.
- A dark-purple glow spreads from the centre of the background (~40% at its heart), baked into the one ambient image with the aurora green.

## 1.6.39 — 2026-10-06

- Aurora TV 5.1.3: the player's timeline is the site's (elia). The two times sit either side of the bar on one row, the track is 6dp (8 with focus), the fill is the violet → cyan → mint ramp with a mint glow, and a lit white bead marks the head and grows a little while the bar has focus. The intro and credits ticks stay.

## 1.6.38 — 2026-10-06

- Aurora TV 5.1.2 — the TV's scale, measured against tvOS and the Google TV app (elia: "elements too big, claustrophobic", 2026-10-06). The type scale steps down (hero 30, title 24, row 18, body 15, small 13), buttons are 40dp tall instead of 50 (tvOS's are 33 at our canvas, Google TV's 40–48), the billboard is 66% of the height like the Apple TV app's top shelf and its lockup is wider with a brighter two-line synopsis — the poster card beside Details is gone, the backdrop is the picture. A film's page follows: smaller poster, tighter facts and chips, 40dp buttons. Stream buttons carry a ⚠ (billboard, title page, source rows) — a stream is a slow start you may not want. The background has a breath of the site's aurora green, baked into the one ambient image so it costs the box nothing.

## 1.6.37 — 2026-10-06

- Aurora TV 5.1.1: **4K and 16:10 panels look like a 1080p set.** Android TV panels report different dp sizes (the Streamer and most 1080p sets 960×540, many sets 1280×720, 4K sets 1920×1080) and the app drew fixed dp, so on a big panel the whole interface was tiny and sat low. The app now lays out on a 960-wide logical canvas and scales it to fill the screen — twice the size on a 1920-wide panel, 1.33× on 1280; a 16:10 panel gets a taller canvas and the layout flows into it. The video view switches to a TextureView on a scaled canvas (a SurfaceView ignores the scale). Nothing changes on a 960-wide panel. The sandbox's 1920×1080 frame shows it.

## 1.6.36 — 2026-10-06

- Aurora TV 5.1.0 — the TV catches up with the site's look (elia's ten points after the Mi TV pass):
  - Cards carry the site's one-pixel light edge.
  - **AI** takes New's place in the side rail: describe the mood, pick Movies or Shows, an era and a length, and the recommender answers with cards and a line on why each one fits. New lives under Settings → What's new (with its dot).
  - A film's page has the poster at the lockup's left, genre chips, Play / Other versions / Trailer / My List in one row and Start over / More like this / Mark watched as smaller pills under it; "Stream now" is "Stream". No STREAM tags on episode or landscape cards.
  - Sources read like the site's list: the quality, what the copy is in plain words (BluRay · DD+ · H.265), seeders and size — no release names. **Pressing a row saves it**; Stream is the smaller button beside Save, so a stream is one press further away than before, and your own copy is a green "Yours · In your library · Plays instantly" row with Play.
  - A slimmer player: smaller buttons, a tighter top and bottom band, the title at the row size — more picture. Ticks on the bar where the intro starts and ends and where the credits begin, like the site. The popups are narrower and tighter and sit just above the bar; Autoplay only shows for an episode.
  - Continue Watching cards are the site's: 16:10, the frame you stopped on (a library title) or the landscape art, the title set large on a deep fade, the episode and "▶ N min left" under it.
  - The billboard's dots are the site's lit pill. **RIGHT on the last hero button turns the billboard a slide, LEFT on the first turns it back; UP from the hero opens the side rail.**
  - Tidy-ups: the episode player and Continue Watching say the episode's real name, not "Episode 1"; Settings shows one chip for Sci-Fi however the sources spell it.

## 1.6.35 — 2026-10-06

- Aurora TV 5.0.3, from a full pass on a Xiaomi TV (Android 14, 2 GB): the nav rail's Search is reachable again — UP from Home jumped to the profile pill because two focus claims raced as the panel opened, so Search could only be reached by wrapping the other way; pressing a lit rail item now still goes there (Movies from a film's page, Preferences from My downloads — it used to just close the rail); the Sources screen is opaque, so the title page no longer ghosts between the rows; the subtitles menu opens scrolled to the ticked track instead of on a list that looked unmarked; and the first launch after the TV wakes gives the house server a second ping before falling over to the remote one, which on a closed server meant the QR sign-in instead of the profile picker.
- The APK on the server is 5.0.3 (build 58).

## 1.6.34 — 2026-10-06

- Settings → Your profile is tidy: your avatar and name with "Password protected" under it on one line, then rows like every other setting — Edit profile & password, Upload a photo (Change / Remove photo once you have one), Your Aurora Wrapped, Pick titles you love — each with an icon, one short line and a chevron. It was a stack of mismatched pills.

## 1.6.33 — 2026-10-06

- The phone's tab bar has AI first and Search last — the two swapped places.
- Haptics that actually arrive on an iPhone. The tap a web page can trigger there only works in the moment after a finger lifts, so a hold-to-peek now taps as the finger comes off the card (Android taps the moment the hold lands). A tap also goes with adding to or leaving My List, marking something watched, pressing Save on a source, flipping a switch in Settings, and the X-Ray sheet settling on a stop.

## 1.6.32 — 2026-10-06

- A downloaded episode in 1080p or better just plays when you press it — there is nothing to choose. An episode that is not on disk, or a smaller copy, still opens its sources (with your copy first when you have one).
- The "In your library" row no longer looks like two buttons pressed together — an old style was still applied to it.
- The Save button's states read properly again while a download runs: Waiting · Queued (dots) · Starting (dots) · 47% with a progress line · Saving · Saved ✓ · Retry. The progress line had been hidden by an older rule.
- Home's billboard has the same one-pixel light edge as the cards.

## 1.6.31 — 2026-10-06

- The list of sources is redrawn, the way a versions list looks in Infuse or Plex: one calm row per source — the quality on the left, what the copy is in plain words (BluRay · H.265 · DD+), under it its size and how well it is seeded, and on the right Stream and Save. The paragraph of advice, the "Save it, then watch it" panel, the per-row "vs ★ BEST" sentences and the file names across the page are gone (a row's tooltip still carries the file name and the advice). The first eight show (five on a phone), with Show all for the rest, instead of a box that scrolled inside the page. Your own copy, when you have one, is one green row at the top with Play. Headings read "Sources" and "Sources · S1 E2".
- On a phone the cast line sits straight under the synopsis on a title's page, before the genres and your rating.

## 1.6.30 — 2026-10-06

- A hold you can feel. Holding a card to peek at it now gives a small tap under the finger the moment it opens — a vibration on Android, and on iPhones the click Safari makes for a switch (the system offers a web page nothing else). The X-Ray sheet ticks the same way when it settles on a stop.
- The X-Ray sheet on a phone moves with the finger and has three places to rest: the very top of the screen (the whole list, scrollable), the middle (where it opens), and three-quarters down (a strip, with the title readable above it). Let go and it carries on the way it was thrown and settles on the nearest one, easing out; thrown past the last, it leaves. Its list scrolls only when the sheet is all the way up — lower down, dragging anywhere moves the sheet.
- X-Ray leads with the filmmakers: the director, writers, cinematographer, editor and composer as people above the cast (one card each, jobs joined — "Director · Writer"), and for an episode its own director and writers first. They were lines in a table at the bottom. Portraits appear where the source has them.
- Home's billboard on a phone has its round corners and its margin back — the slab it was — at the shorter height.

## 1.6.29 — 2026-10-06

- "✓ 7 ready" is a round download button with a count badge now: the number is how many things you asked for have been downloaded and not opened yet. On a phone it stays where it is. On a computer it shows for ten seconds — when Aurora opens and whenever something new lands — then goes clear, and comes back when the pointer is over it.

## 1.6.28 — 2026-10-06

- The green "✓ 7 ready" pill at the top is an announcement now, not a fixture: it shows for ten seconds when Aurora opens and again whenever something new becomes ready, then fades away. What is ready is still on Home's Tonight row and the Downloads page. (The "⬇ 2 · 47%" pill for a download in progress stays while it runs.)

## 1.6.27 — 2026-10-06

- X-Ray on a phone is a sheet. It rises over the title's page — the way it does over a film in the player — with a grab bar and a round ✕ in place of "Back to the title". Drag it down to put it away (from the bar at any time, or from the list when it is at its top; a quick flick is enough), or press the ✕, tap the page behind it, or go Back. The page underneath is no longer rearranged, so there is nothing to find your way back from.

## 1.6.26 — 2026-10-06

- On a phone the top of the screen is no longer treated as a bar. The three small buttons up there (the logo, the gear, your profile) used to live in one invisible strip fixed across the top edge, and newer iPhones read a strip like that as the page's top bar — a flat band under the clock and a frosted band under that, with the picture starting below both. The strip is gone: the logo floats by itself at the left, the other two at the right, and nothing wide is pinned to the top, so a title's cover and Home's billboard are free to run to the top of the screen.
- Play has a rounder, friendlier triangle, and Trailer has its own icon — a clapperboard — instead of a second play triangle.

## 1.6.25 — 2026-10-06

- Continue Watching looks the same on a computer as on a phone: the taller card with a landscape picture, the title set large at the lower left on a deep fade, the show's name leading for an episode, and "▶ 98 min left" under it.

## 1.6.24 — 2026-10-06

- The nav's words follow what is behind them. Each button — every tab, the logo, the gear, your profile — reads the brightness of what it is floating over and fades between white and dark text on its own: white over a night scene, dark over a pale poster or a bright frame. The glass no longer darkens itself to protect white text; it stays glass.
- X-Ray on a show's page is about the show: the series cast, its ratings, who made it. It used to open on one episode, which read as "X-Ray is about episode 1". An episode is one step away — "The whole series" is the first entry in the picker, and the arrows walk from it into the episodes. (In the player X-Ray is still about the episode that is playing.)
- State changes dissolve instead of cutting: X-Ray taking over a title and giving it back, stepping between episodes inside it, a show's season switching, "Other versions" unfolding, More / Less on a synopsis.
- The STREAM tag is gone from cards — it sat on nearly every poster and said little.
- Every card has a hairline edge (one pixel of light grey at about a third strength), so a dark poster no longer melts into the page.
- Continue Watching on a phone: a taller card with a landscape picture — the frame you stopped on, or the title's own backdrop — instead of a poster cropped to a strip; the title set larger on a deeper fade, the show's name leading for an episode, and "▶ 29 min left" under it.
- On a phone: posters are a touch larger (114px), and both the Home billboard and a title's cover are taller than yesterday's cut.
- "Save next 3" under the offline icon on a show now reads "Save 3 offline" — it saves the next three episodes you haven't finished to this device.
- Aurora added to a phone's Home Screen takes the whole screen: the page runs under the status bar and around the Dynamic Island instead of stopping at a black band beneath it, with its own icon. The top buttons keep clear of the island and the tab bar of the home indicator.

## 1.6.23 — 2026-10-06

- The phone, a size smaller. Posters on a phone were two-and-a-bit to a row and every shelf took 340px of the page; now there are three and a peek, and the shelves sit closer together — about a third more of Aurora on each screen. Corner tags shrink with them (the film / series tag keeps its icon and drops its word).
- Home's billboard on a phone is a little over half the screen instead of nearly all of it, and runs edge to edge and to the very top.
- Continue Watching cards say what is left — "▶ 29 min left" under the title — for films as well as episodes.
- Episodes on a phone are a rail of picture cards you slide through: the still, "Episode 5", the title, three lines of what happens, and the date and length at the foot beside the download and watched buttons. The rail opens on the episode you are up to.
- A title's cover on a phone is shorter, and it drifts: as you scroll, the picture moves at under half the page's speed and the title fades over it; pulling down past the top swells it slightly.
- The tab bar rides lower, over the home-indicator strip rather than a full inset above it, and the top buttons keep clear of the Dynamic Island when Aurora runs full screen.
- Computers, tablets and the TV are unchanged.

## 1.6.22 — 2026-10-06

- Finished streams no longer sit on the disk for good. The server keeps the last few streams it prepared so that re-opening a title is instant — but "the last few" had no clock on it, and three films streamed once in August were still holding 1.6 GB in October. A prepared stream nobody has touched for a day is now removed (the healer does it every round, and says so in its log).
- A lighter start. Every page load fetched the whole changelog (56 KB) just to learn the version number for the dot on the nav; it now asks for the version alone.

## 1.6.21 — 2026-10-05

- Saved copies do what the rest of Aurora does. A title saved to a phone used to be the picture, the sound and the subtitles and nothing more, because everything else is asked of the server while the film plays. Those answers now travel with the copy:
  - Skip intro and Skip recap, and Up next arriving at the credits instead of at a guess — the detected ranges for that episode, and the household's hand-marked intro if there is one.
  - Up next goes to the next episode you have saved, and plays it from the device. With nothing else saved it asks the server, as before.
  - X-Ray in the player: the cast, crew and ratings for that film or that one episode (portraits need the server; without it the initials show).
  - Resume: where you stopped while out of reach is remembered across closing and reopening the app, not only until the app is closed. It used to start from wherever the server last heard of.
- Copies saved before today pick all of this up by themselves the next time the app is open with the server in reach — nothing to save again.

## 1.6.20 — 2026-10-05

- A quality change you barely see. Changing between the original, 720p and 480p used to put a spinner over the film, then four seconds of black, then the picture again. Now the film keeps playing while the new stream is prepared a few seconds ahead of where you are, and takes over when you get there: the last frame holds for about half a second and the film carries on — nothing replayed, nothing skipped, no spinner. A film that is paused or already stuck changes on the spot.
- Faster to notice a struggling connection. Once a second Aurora looks at how much of the film is in hand and how fast more is arriving; when the line is falling behind it steps down to 720p or 480p before the picture freezes (it used to wait for two freezes, or one of eight seconds, and then run a separate speed test). A freeze the watcher did not see coming now counts after three seconds instead of eight.
- And back up again. When a film that was stepped down has had room to spare for a quarter of a minute, it goes back up by itself — at most twice a film, and not again once going up was followed by trouble. Data saver never steps up.
- The message is a small chip in the top corner — "Auto 720p" with Revert on it for six seconds, or just "720p" for two when you chose it yourself — in place of the pill in the middle of the picture and the box at the bottom.
- Fixed: a lighter stream could fail to play at all. Where a file has no sound for the first seconds after the point you were at (a damaged stretch, a track that starts late), the stream came out without an audio track at first and the player went round in circles trying to restart it. The sound now starts with the picture, as silence if need be.
- The New page: X-Ray, quality that follows your connection, Ready to watch, Save the next three and Popular in this house have cards; the two looks, the keyboard shortcuts and resume-with-the-frame are retired from it (the features themselves are unchanged). Everything from this month carries the New ribbon, not only the very latest release.

## 1.6.19 — 2026-10-05

- A title's page on a phone, opened up. Under the cover there is now one plain line of facts (rating, year, length, director) instead of a stack of capsules; Play across the full width; and the rest of the buttons — Trailer, My List, X-Ray, Save offline, Download, Mark watched — as one strip of round buttons you slide sideways, where there used to be two rows of boxed tiles. Your rating and its stars share a line, what is on the server is two quiet lines without a box, and on a series the episodes start sooner. For a film you already have, the other versions are folded behind one row ("Other versions — stream or save a different copy"), so More like this comes right after the film instead of after a list of fifty sources.
- X-Ray on a phone is its own screen: the page folds down to the cover and X-Ray starts right under it (it used to open a screen and a half down, under the synopsis and the rating). The cast is a row of portraits you slide through, with full names, instead of two columns of names cut short; the X-Ray bar with Back to the title stays in reach while you scroll; the episode picker gets a full-width row.
- Back to the title works. It used to bring the rest of the page back but leave the X-Ray panel sitting in the middle of it — on every screen size. Closing X-Ray now removes it and returns you to where you were on the page.
- The sky behind the app on a phone: stars are sharp points again (they were being drawn at a quarter of the screen's resolution and came out as soft blobs, with a faint grid in the glow), there are fewer of them, and the aurora is three calmer bands that run off both edges of the screen instead of five thick stripes and the occasional glowing lozenge.
- Settings on a phone: a setting with a wide button (Subtitle language → "First available") no longer squeezes its explanation into a column three words wide — the button drops to the next line. Genres you like shows one Sci-Fi instead of "Sci-Fi", "Science Fiction" and "Science-Fiction" (pressing it covers all three).
- X-Ray shows a release date as a date ("16 Jul 2010") rather than 2010-07-16, and a date with no time is that calendar day in every time zone.

## 1.6.18 — 2026-10-05

- Trailers on Home start sooner. The trailer used to begin loading only after a title had sat on the billboard for six seconds — YouTube's script, then its player, then the first buffer — so the picture really moved eight or nine seconds in. Now all of that happens while the title sits there: the player is built unseen a second in, and the moment the wait ends the trailer is already playing. The wait itself is four seconds instead of six. Nothing changes on a slow connection, where trailers stay off.

## 1.6.17 — 2026-10-05

- The player's settings menu no longer has a Skip intro section (ignore the detected intro, mark the start and end by hand, clear the marks). Detection and the public timestamp databases do that job; the Skip intro button itself is unchanged. A wrong mark can still be removed in Admin → Inbox → Skip-intro marks.

## 1.6.16 — 2026-10-05

- TV app (5.0.2 source — in the next APK): quiet updates. On a TV running Android 12 or newer, a new build is fetched in the background while you browse and installed the moment you leave the app (Home button, another app, the TV going to sleep) — no prompt; the next time Aurora opens it is the new version. The update prompt is held back for at most a day and returns at once if the quiet install is refused or fails. Older TVs (Android 11 and below) keep the prompt that comes back every half hour. The update that brings this in still asks once, the old way.

## 1.6.15 — 2026-10-05

- Back (Escape, or a remote's Back button) closes X-Ray first — in the player it used to close the sheet and leave the film as well; on a title page it left the page with X-Ray still open behind it.
- X-Ray with nothing to show for an episode no longer draws an empty box, and its saved answers on the server are kept to a few megabytes.
- The "Resumed at…" pill and the lighter-stream pill no longer sit on top of each other when a film both resumes and starts lighter.

## 1.6.14 — 2026-10-05

- A slimmer player dock: the elapsed and remaining times sit on the timeline's own row instead of a row beneath it, the "% loaded" text is gone (the lighter bar on the timeline already shows it), and the padding and the play button came in a little. On a computer the dock is about a third shorter. Same on the TV (source — in the next APK): 32dp shorter, with Skip intro, the resume card and subtitles following it down.

## 1.6.13 — 2026-10-05

- Ready to watch: when something you saved finishes downloading, Aurora says so once wherever you are in the app, with Play on the message (it used to be said only on the Downloads page or the title's own page). Behind a film it is one quiet line. Settings → More settings → Downloads → "Tell me when it's ready" adds a system notification for when Aurora is in the background. Smart downloads stay silent.
- Play-ready copies, only where they are needed: when a download lands whose video is not plain H.264, and this household's devices have actually needed the slow live-encode path this month, the server makes a 1080p copy ahead of time and the player uses it instead of encoding when Play is pressed — it starts at once and seeks freely. Nothing is made for files every device plays as they are, nor when no device here has needed it; copies live in the same capped temporary folder as phone copies, for six days. `"preconvert": false` in config.json turns it off.
- Admin → Downloads → On disk → Running low?: type how many GB to free and Aurora suggests what to delete — only things someone finished and nobody is part-way through, the longest-ago watched first, just enough to reach the number — and shows the list before anything is removed.
- Search, when the box is empty, shows Popular in this house under your recent searches: what the household has been watching in the last six weeks, minus what you have already finished.
- A series you own has a Save next 3 button: the next three episodes you haven't finished are saved to the device one after another, at a size asked once.
- Resuming is quieter: a small pill at the top — "Resumed at 12:34 · Start over" — for four seconds, instead of a card with a picture over the film. On the TV the card is smaller, dimmer and gone in four seconds.
- Good connections are protected: a single slow speed reading no longer switches a device to the light mode — it takes a second reading a few seconds later to agree.
- TV app 5.0.2 (source only — the APK has to be rebuilt): trailers on Home are two per visit instead of an endless loop; a box that is struggling (Android 9 or older, or slow frames measured after Home settles) goes without trailers and with a still aurora, and Settings says so; resolution badges are right for widescreen films; the app reports itself as "tv" in the usage stats.

## 1.6.12 — 2026-10-05

- X-Ray. A new button on every title page (the scan-frame icon) swaps everything under the hero for who is in it, who made it and what people thought: the cast with their characters and portraits, ratings side by side (IMDb, TVMaze or TMDB, and this household's own stars), director, writers, awards, network or studio, release, runtime. Press it again, or Back to the title, and the page is as it was.
- X-Ray knows which episode. For a series the panel is about one episode at a time — its own guest cast, director and writers, rating, air date and still — and opens on the episode you are up to; arrows and a list step through the rest. An anthology (Black Mirror, Modern Love: no cast of its own, a different film every episode) is recognised and leads with "In this episode" instead of a series cast that would be wrong; a regular series shows the episode's guest stars first and the regulars under them.
- X-Ray in the player: the new button pauses the film and raises a sheet with the same panel, on the episode that is playing; closing it picks the film back up. In a watch party the film keeps running for everyone.
- Light on the line and the server: nothing is fetched until X-Ray is opened (a hover warms it on a good connection), answers are kept on the server for two weeks (an episode for a month) and on the device for ten minutes, the next episode is looked up behind the one you opened so stepping is instant, portraits come through the image cache at the size they are drawn, and a slow connection loads six faces at first instead of twelve. Tapping a cast member on a title page searches for them. No key is needed: series come from TVMaze, films from TMDB when the server has a key and Wikidata when it does not.

## 1.6.11 — 2026-10-04

- Settings anyone can read. The page is called Settings now; the first screen is the handful people actually change — your profile, the look, Watching, Subtitles, the genres you like — and everything else (Home rows, downloads, internet, saving for later, privacy, sign-in, what's new) is one press away under More settings. Every section and every setting leads with a plain grey icon, an On / Off setting is a switch instead of a button that says "On", and each one is explained in a single short sentence. Nothing was removed.
- Glass that reads what is behind it. The player's controls, the party panel and the top bar measure the picture under them — the video frame, the hero backdrop — and put a darker layer under their glass over a bright scene, none over a dark one, gliding between the two. Text keeps its contrast without the glass turning into a solid box.
- The Watch together panel is readable: light text instead of grey, slightly larger, and it never drops below a firm dark floor whatever is playing behind it.
- The TV app is announced from the APK itself. The server reads the version out of the published file and tells the TVs that — a notes file that says 5.0.2 beside an APK that is still 5.0.1 used to send every TV into an update that reinstalls what it has and asks again half an hour later. Admin → Server → TV app shows what is on the server (version, build, size, date, fingerprint), what the notes were written for and what the source says, and spells out any disagreement; the healer checks the same. A new build replaces the one file in place — there is only ever one APK on the server.
- Fixes found reviewing 1.6.9–1.6.10 before they reached anyone: a 720p / 480p stream's segments would have been refused by the server (a name check did not know the new stream names); a 720p stream was being picked for lines too thin to carry it (480p now, until there is room); a film's own download was counted as a speed measurement, which could call a good line slow; Data saver was ignored on a fast line; a start that never got going was not treated as a stall; the wait for a lighter stream showed a blank screen; Original on a file the device plays directly now goes back to plain direct play; a phone copy bigger than the cache cap could be cleared while it was still being fetched.

## 1.6.10 — 2026-10-04

- A line that stops keeping up mid-film is handled for you: after two real stalls in three minutes (or one of eight seconds) Aurora measures the connection again, and if the line is the problem the stream steps down by itself — the file → 720p → 480p — at the same spot. A small pill at the top says "720p for your connection" with Revert on it, for whoever would rather wait for the full picture; reverting, or choosing a quality by hand, ends the automatic changes for that film. A stall on a fast line changes nothing (a smaller picture would not fix it).
- Quality is not given up for nothing: a connection that carries the file comfortably is never capped, whatever it was classed as.
- The server looks after itself while doing this. A lighter stream never takes the last encode slot (that one stays free for a device that cannot play its file any other way). Copies prepared for phones are temporary now — removed half a day after they were last fetched, capped at 8 GB in all (`"offlineCacheGb"` in config.json), and not made at all when the disk would be left with under 5 GB; before, every prepared copy stayed on the server forever, and an Original copy is the whole film again.
- The healer watches more: temporary files (how much, which folders; expired phone copies are cleared every round, and finished streams nobody is watching when the disk is tight), encode slots (both busy for ten minutes means people are being refused), the server's own data files (one that no longer parses is a failure; one that has grown huge is a warning), and where the disk is heading — "full in about 30 h at this rate" while there is still time to delete something calmly.

## 1.6.9 — 2026-10-04

- Slow connections are noticed and Aurora goes lighter for them. Each device times a small download from the server shortly after opening and every few minutes (and reads the browser's Data Saver and 2G signals); a slow line gets pictures at the size they are drawn instead of the screen's 2–3× density, a smaller hero backdrop, nothing loaded ahead of time and no hero trailers. One quiet message says so the first time. A fast line is unaffected.
- A lighter stream for a slow line: a title in the library starts as a 720p stream (480p on a very thin line) when the connection can't carry the file itself, and says so. The player's ⚙ menu has a Quality section — Original, 720p, 480p — to change it mid-film at the same spot. If the server can't make the lighter stream, the title plays the way it always did. Library titles only; streamed sources are unchanged.
- Home paints at once when you come back to it, and refreshes its rows underneath, instead of showing the loading skeleton again. On a slow line the last Home is also kept on the device, so opening the app shows the shelves straight away.
- Preferences → Data use: Automatic, Data saver (always light — for mobile data) or Full quality (never adapts), with what the connection looks like right now.
- Admin → Insights shows how many sessions were on a slow, fine or fast connection, the typical measured speed and the slowest tenth, and which devices the slow ones were. A problem report carries the reporter's connection.
- Smart downloads keep to themselves: no message over a film when the next episode starts downloading (elsewhere, one small dim line for two seconds), no "ready to play" when it lands, and they no longer show in the download pill at the top. They are still on the Downloads page, marked AUTO, where they can be cancelled.
- Admin: two libraries on the same disk are one storage bar; the "nothing waiting" note no longer claims there is enough disk space when there isn't.

## 1.6.8 — 2026-10-04

- Admin, rebuilt around six places instead of nine tabs: Home, Inbox, Downloads, People, Insights (Analytics + History) and Server (Status + Logs). A sidebar on a computer, a strip on a tablet, a dock under the thumb on a phone. Every page says what it is for at the top. Old links (#live, #logs, #history…) still land.
- Admin → Home opens with what needs you, as sentences: people waiting to be let in, downloads waiting for approval, open problem reports, title requests, an update to pull, a failing health check — each one a tap away from where you deal with it, and a green "Nothing needs you" when there is nothing. Live (who is connected, kick, ban, the broadcast message) moved onto Home; the ten equal number boxes became four plus one quiet line.
- Admin on a phone: tables are stacks of small cards with every value labelled, instead of seven columns to scroll sideways. Scrolling no longer refetches the page every time the address bar slides away.
- Admin asks before destructive things in its own sheet — the button says what it does ("Yes, delete", in red) instead of the browser's OK / Cancel box.
- Admin, smaller: banned addresses live under People with the devices they came from; Storage sits at the top of Downloads; Rescan library and Clear caches moved to Server → Maintenance with a line saying what each does; a refresh button and a live-updates light on every page; the old play counter and the connection log fold away under History.
- Skip intro is measured the moment a download lands: the audio pass runs for the new episode's season right away (never-analysed episodes first) instead of waiting for the nightly round, and an answer from the public databases no longer stops the file itself from being measured.
- Credits start later, where they really start: the detector's start was landing 10–20 seconds early on the music that leads into the credits. It is now tightened to where the episodes agree densely, then snapped forward to the cut to black when there is one nearby. Every episode is re-measured once.
- Offline copies ask what size you want — Original, 1080p, 720p or 480p, each with its size — and Original is ready in seconds when your device can play the file's video (it is repackaged, not re-encoded; the old way was always a full 720p conversion). The app checks there is room first, says so when there isn't, and a laptop that starts with no connection opens straight on Saved.
- Missing covers: a title whose poster source has nothing now tries a chain of others by IMDb id (Cinemeta, TVMaze, TMDB, iTunes) and keeps the first that answers.

## 1.6.7 — 2026-09-28

- Skip intro, Skip recap and the credits-timed Up next stay current. Every day the server asks SkipDB and TheIntroDB again about every episode in the library, and about every streamed episode someone played in the last month — episodes with no timestamps yet go first, so a new show or last night's episode picks up its Skip intro as soon as someone submits it, instead of waiting a week (empty answers) or never (answers already on file). New downloads and new shows are still asked the moment they land. A streamed episode whose answer is over a day old plays with that answer at once while a fresh one is fetched behind it. A re-ask that can't reach the databases, or that only one of them answered, never erases what was already known.
- Library details stay current too: a show still on the air has its rating, synopsis, genres and poster re-checked daily, everything else monthly. A refresh only ever improves an entry — an answer for a different title or a failed request leaves it as it was, and new art replaces the old only once it has downloaded.
- Admin → Analytics → Skip intro shows when the databases were last refreshed and how much changed.

## 1.6.6 — 2026-09-23

- More like this, rebuilt around the feel of a title. The row used to be TMDB's own "recommended" list, which leans on whatever is popular (Interstellar got Avengers: Endgame and Guardians of the Galaxy). Now Aurora gathers a wider neighbourhood — recommendations, similar titles, and films sharing the source's themes — and ranks it on shared themes weighted by how telling they are ("wormhole" says more than "space"), tone (a comedy or an action spectacle under a quiet drama loses; so does grounded politics under a sci-fi dystopia), the genre, the quality with small-sample ratings discounted, the era and the language. Cartoons never land under live action, documentaries never under fiction, kids' TV only under kids' TV; the title's own franchise stays on its own shelf and any other franchise gets one spot. Hover a card to see why it is there ("Same vibe: alien contact · scientist"). On a hand-judged set of twelve titles, good picks in the top ten went from 29 to 54 and bad ones from 12 to 7. Rows rebuild on their own the next time a title is opened.
- Smart downloads tidy up after you: an episode that smart downloads fetched for you is removed from the server once you have finished it and started a later episode of the same show — with its subtitles, and its folder if that leaves it empty. Never anything downloaded by hand (or shared with a hand download), never someone else's smart download, and never an episode another profile is part-way through. A finale stays until you remove it. Preferences → Playback → Tidy up watched episodes turns it off for your profile.
- Subtitles move up while the player's controls are showing, so a line is never hidden behind the dock, and drop back when the controls fade. Subtitles that place themselves (signs, songs at the top) are left alone.
- Apple Horror: dropdowns, the player's menus, the profile menu and search suggestions sit on a darker glass with brighter text, so they read over a busy frame or a bright sky. Sign out stays red.
- Deleting a profile now signs it out everywhere at once, instead of leaving its sign-in sessions to expire on their own.

## 1.6.5 — 2026-09-17

- Skip intro, Skip recap and a credits-timed Up next, from more places. Aurora's own detector (chapter markers, then the audio every episode of a season shares) stays the first answer for a file you own — it is measured on that very file. What it can't reach is now filled from the two public, crowd-sourced timestamp databases, SkipDB and TheIntroDB, asked by IMDb id + season + episode + runtime: STREAMED episodes (no file to analyse — they never had Skip intro before), a season of one episode, episodes where the audio pass found nothing, and recaps, which repeat nowhere and so can't be found by comparison (the button says Skip recap while you're in one). A database answer is used when its runtime match is exact or shifted, or when the two databases agree within five seconds; a lone uncertain answer is dropped — a wrong Skip button is worse than none. One polite request at a time per host, answers cached on disk for a month; only the show's id, season, episode and runtime leave the server, and `"skipDatabases": false` in config.json turns it off. Admin → Analytics counts what came from the databases.
- Timestamps go on file when a download lands: the moment an episode finishes downloading, Aurora asks the public databases about it once and saves the answer with the episode — before anyone presses Play. Watching a library episode never sends a request (the player reads the saved record); the record is only re-asked if the file changes, or weekly while the databases have nothing for it. A streamed episode asks once and the answer is cached on the server for a month, for everyone.
- Title pages on a phone: everything above Play — the kind, the title, the year / rating / age line — sits ON the cover now, and Play comes right under it. The cover is as tall as it needs to be for a long title, never less than 56% of the screen.
- Save first, then watch (elia: "make the flow of saving a movie and watching it after it downloaded a lot easier and clearer"). A film you don't own leads with one button, Save & watch: it saves the ★ BEST source to the library, tells you what happens next (with a "Stream it meanwhile" door on that sheet), then follows the download on the page — Queued, Starting, Downloading · 42%, Almost there — and turns into Play when it lands. Stream instead sits beside it, plain. In the sources list, pressing a source SAVES it (the accent SAVE rail is the same press and shows its state); a small Stream pill on each card is the side door, and it disappears once the source is downloaded. The list is headed Save to your library, and its note says why.
- Audio tracks: a multi-dub file (a torrent or a title you own) gets an Audio section in the player's settings menu — each track by language (English, Russian, Hebrew…), the release's own title when it named one, codec and channels. Picking one restarts playback at the same spot with that track (the server maps it in: a repackage at stream speed for a file the device can decode, the h264 encode otherwise); a browser can't switch tracks inside one stream, so this is how. The probe reports every audio stream's language now, and the library re-reads its files once for the same.
- Resolution badges judge by width too: a 2.40:1 film is 1920×800, and by height alone it read as 720p — which is why nearly every download said 720p. Letterboxed 1080p is 1080p now; 4K likewise.
- A page that loaded half old, half new code across a deploy (the symptom: "Importing binding name … is not found") reloads itself once instead of sitting broken.
- Genre tags on a phone are centred pills again, not tall boxes with the word at the top (the finger-height rule was stretching a label that is not a button).

## 1.6.4 — 2026-09-16

- Smoother on phones. Home drew a blurred-glass pill (STREAM, FILM, SERIES) on nearly every card — 460 live blur layers on one page — and every flick of a row re-blurred all of them, which is what made rows tile in late and scroll unevenly; the pills are a plain tint now (10 blur surfaces on the page instead of 470). Posters that come from the cache show at once instead of fading in again, so coming back to Home no longer looks like the rows are loading. The first cards of the top rows fetch their art eagerly. The sky holds its frame while you scroll. A tap no longer leaves the tapped card lifted and ringed (there is no hover on a phone, and Android kept the focus on it); chips and pills let go of their ring once the tap has done its job. The screen's rise-in on phones is a plain fade, shorter, without sliding the whole page.
- Rows remember where you were: come back from a title and the shelf you were browsing is scrolled where you left it, not snapped back to its first card. A library refresh while you look (a scan finishing, a download landing) rebuilds only the shelves that changed instead of every row.
- Search: the keyboard's Search key runs the query at once (a fast type-then-Search used to land on a blank screen while the typing pause and the lookup caught up) and drops the keyboard; a "Searching…" line stands in while nothing has arrived, then "Searching the catalogue…" under the library hits while the slower lookup is out; typo-tolerant streamable matches from the cached catalogue show instantly, before the live lookup answers; a two-letter title ("Up", "It") searches the catalogue when you press Search; a ✕ clears the box; the box is a real search field (no autocorrect "fixing" a title); a catalogue that didn't answer says so, with Try again, instead of "no results". On Movies/Shows, a search shows shimmer while it looks (it said "Nothing by that name." for the whole second the lookup was out) and the count says "Searching…". No-result lookups are about half as long: the catalogue's fallbacks run side by side.
- The ★ BEST source is a normal (full-width, gold) card in the list again — it scrolls with the others instead of staying pinned over them, which on a phone hid a third of the box. On a phone the sources box no longer scrolls inside the page (two thumbs fighting): the first six show, the rest behind one "Show all N sources" press.
- My downloads, rebuilt: one summary line up top ("2 downloading · 1 request waiting (1 on the admin) · 1 ready to play"), then Downloading now → Waiting → Ready to play → Didn't make it → Also on the server, in that order. Rows are firm cards (no frosted glass, a dark base) with a coloured edge and a bold state word — green ready, accent downloading, amber waiting, red dead — the poster larger, the release quality and provider on a sub-line, AUTO on smart-download rows, NEW on a finished one you haven't opened. Live ticks move the bar instead of rebuilding the row. A failed or canceled request has Try again (same source, one press) and Remove — Remove used to just relabel the row "Canceled"; it now clears it (a new dismiss route). Cancelling a download that is already well under way asks first. A title's Cancel stays pressed across live repaints.
- Shelves build only what fits across the screen plus a few in reserve; the rest of a row is built the moment it is scrolled, nudged or focus reaches its end (Home on a phone: 87 cards to lay out instead of 237, same shelves, nothing lost). A remembered position deep in a shelf builds the shelf first.
- Nothing jumps to the top any more when a page repaints itself: Mark watched on a title page, Reset to default / an avatar change / a sign-in in Preferences all keep your place.
- Touch targets and text: the billboard dots are thumb-sized; the smallest badges (★ BEST, SAVE, source tags) are a size up.
- Honest failure states: Home, My List and Movies/Shows say "couldn't load" with Try again instead of an empty page or "nothing here"; a title whose details won't load takes you back where you came from instead of to the retired Requests page; "Browse what's trending" on an empty search opens Movies. Deleting a profile asks first (it was one tap, no undo). The email prompt in Preferences is Aurora's own sheet, not the browser's. The "can't reach the server" strip sits above the phone's tab bar instead of on top of it. The phone's Movies/Shows search box has a ✕ too.
- The healer (Admin → Server): every minute it checks the download queue (a job with no torrent details after 12 minutes, or no progress and no speed for 15, is restarted from its staging bytes; a queue with a free slot and a job waiting five minutes is pumped; a dead progress poller is restarted), the download engine (a deaf aria2 is killed and respawned; a start that failed is no longer remembered as the answer forever — that one was compounding into "every download fails" after a while), disk on every library volume and the staging folder, orphaned staging folders (purged), the upstream catalogue / sources / artwork providers, error and warning spikes in the server's own log with the most-repeated messages named, an overdue library scan (run), the streaming client and the process itself. Each check answers ok / warn / fail in a sentence; the card shows the round, four hours of history and every action taken, and a check flipping to fail (or recovering) goes out through ntfy / Telegram when those are configured. Deterministic — no model needed.
- Player: the Subtitles, Speed and Settings menus open centred over the button that was pressed, just above the dock (one fixed spot used to serve all three — with the glass dock an island mid-screen, Speed and Settings opened a hundred pixels to the right of their buttons and into the dock). Phones keep the full-width sheet. The Back button (and the other top-bar buttons) sit on a darker base so the icon reads over a bright frame, and hover / remote focus turn them solid white — the 14% tint was invisible there. A clicked dock button no longer stays white until the next click (focus styling is for keyboards and remotes now); hover on the dock is a stronger tint.
- Russian subtitles, alongside Hebrew and English: Preferences → Subtitles offers Russian as the preferred language, the player recognises Russian tracks and fetches one for a title you own that lacks it, streamed titles and downloads get Russian tracks from the providers too, and a Windows-1251 file decodes as Cyrillic instead of a screen of Hebrew (the same bytes are one alphabet in one code page and the other in the other — both are tried and the one with real letters wins).
- Title pages on a phone: less air above the title — the art band is half the screen instead of 58%, the title starts higher.
- Title pages on a phone, laid out again: the poster fills the top of the screen and dissolves into the page, the title sits over its lower edge, then one meta line, one full-width Play (or Continue / Stream now), a row of equal icon tiles for the rest (Trailer, My List, Save offline, Download, Mark watched…), a three-line synopsis with More, then genres and the rating card. The small floating poster beside empty space, and the wall of wrapping buttons, are gone. Every look; the synopsis gets More / Less on wide screens too (it used to be cut at five lines with no way to read on).
- Title pages: the hero is about a sixth taller (a real band of art above the title) on desktop and phone alike. My downloads keeps each row's node when a job moves between sections, so posters never reload on a state change.
- Under the hood: posters cached on the device expire after a week (a replaced cover shows up) and the cache is capped at 800 entries (it grew forever); a catalogue fallback that hasn't answered in 4 seconds answers nothing; a dead server is reported in about a second instead of two and a half; a committed search is remembered at once.

## 1.6.3 — 2026-09-14

- Aurora TV 5.0.0: everything the website learned this month, on the Streamer. Watch parties (start one from the player's 👥 button, join from the Home billboard pill or Settings → Join a watch party; the host's Up next carries the room along); trailers — a Trailer button on every title page and, after six seconds on the home billboard, the trailer plays muted over the art with an Unmute button (Settings → Playback to turn it off); Skip intro from the household's marks or the server's own detection, Up next at the detected credits, gear-menu marking and "Ignore the detected intro"; a resume card with the frame you stopped on and Start over; subtitles fetched in your preferred language when a title lacks them; a New page (nav dot until seen); My downloads; Report a problem (with the app version, the TV model and the last errors); usage stats (device "tv") with a Privacy toggle; the next screen warmed while you look at this one; a peek sheet on a held OK. Google sign-in on the TV can request access in one press when no profile is linked yet. Subtle glass touches: lit progress heads, glass panels and toasts.
- Aurora TV updates itself: when a newer build is published the TV offers it on Home and under Settings → This TV, downloads it from the server and hands it to Android's installer — no computer, no sideloading tool. First time, Android asks once to allow it.
- Aurora TV 5.0.1: the update offer is a popup you have to answer, not a chip in the corner — it opens on Home every time you come back to it and every half hour while you browse, and Later only buys ten minutes. Louder card too: the accent edge and a deeper backdrop. Fixed: after one successful in-app update, the next one could show Android's old "App installed" screen and install nothing — the installer's leftover task swallowed the request; every install now gets a fresh installer.
- My downloads (web and TV): a request the admin removed, or whose file has since left the library, disappears from the page at once instead of sitting there as "Finished — indexing…"; the page shows your own downloads first and what the rest of the house has in flight underneath.
- Apple Horror's sky on desktop paints its stars on a full-resolution layer — points, not blocks — while the curtains keep their soft low-resolution blur.

## 1.6.2 — 2026-09-14

- Desktop polish (Apple Horror): a source card is one glass surface — the play area and the SAVE / DEVICE / OFFLINE rails sit inside it and share its corners (each used to draw its own rounded box, and the offline button was a loose circle); a failed download rail says RETRY. The player's title pill is a rounded rectangle instead of a capsule around three lines. Preferences rows span the card and their buttons line up with the home-row editor's controls.
- The next title is ready before you tap it: after Home paints, the two most recent Continue Watching titles that aren't effectively finished, and the most recent series still in progress, get their page warmed (record, metadata, art) — quietly, at idle, one every 700ms. Hovering, focusing or pressing any card warms that title's page; hovering Play on a title you own starts the server side of playback (the jit index or copy job) so the first frame is closer when the tap lands. Every prefetch is low priority, skipped on data saver, a 2G connection, a hidden tab, offline, or while a film is playing.
- Usage stats: which screens, features and play paths get used, and how long they took to appear — a few bytes each, batched every 20 seconds, sent to this server only. Admin → Analytics shows them (screens with time-to-painted, features, play starts by path, nav taps, client errors) with a Copy stats button that puts the whole summary on the clipboard as text. Each profile can turn it off under Preferences → Privacy. Never what you search for or type.
- Screensaver: come back to Aurora after 90 seconds or more in another tab (or on the phone's home screen) and the saver greets you until the first input. It now arms on every screen — a title page, Movies, the New and AI tabs, Preferences — not only Home; never over a film that is playing (a paused one is fine), never under a sheet or the profile door. A quick tab hop stays invisible.

## 1.6.1 — 2026-09-14

- Phone QA pass on Apple Horror. Home: the billboard dots sit under Play/Details instead of on their bottom edge (they were stealing the tap). Player: the subtitles/speed/settings menu is a full-width sheet above the two-row dock (it used to hang 42px off the left edge and over the controls); Up next, Skip intro, the intro-marking chip and the resume card float above the dock too, and the dock is a plain tint on phones (no live blur over video). Peek sheet: square bottom corners where it meets the screen edge. Title pages: episode cards give the title room (smaller still, tighter gaps, the runtime back on the sub-line), the season pills scroll on their own with the season actions wrapped under them, the owned source row keeps its title, one CC badge instead of two. Search suggestions keep the whole title (the library mark is a green tick). Posters are 150px and wide cards 264px on phones so a third card peeks in. Pills, chips and rating stars are finger-sized; toasts clear the home indicator.
- Preferences: settings rows are rows again (no box inside the section box) in Playback, Offline, Subtitles and the home-row editor; the Shown/Hidden toggle is a pill; the changelog note lines up. New page: the button never touches the text above it and the footer buttons stop wrapping their labels on phones.
- Faster on weak phones and slow connections: one minified stylesheet instead of six render-blocking ones; the browse, search, requests, Wrapped, taste, AI and New screens load on first visit (warmed after boot); the sky starts once the page is idle, paints at a quarter resolution and 12 fps on phones, and sleeps while the player is open; artwork is served at the size it is drawn (a 1.3 MB catalogue backdrop is ~80 KB on a phone; a 200 KB poster ~30 KB); the hidden hero poster and picks no longer download; one changelog request instead of four; a real robots.txt and a page description. The next screen is fetched while you read this one: once Home is up and the browser is idle, My List, Movies and Shows warm their data quietly (about 22 KB in all, one request every half second), and hovering, focusing or touching a nav link warms that page at once — so the first tap on a tab paints from memory. Never on data saver, a 2G connection, or in a hidden tab. Lighthouse (mobile, the door): performance 78 → 97, accessibility 94 → 100, LCP 4.8 s → 2.3 s, bytes 267 KB → 127 KB.

## 1.6.0 — 2026-09-14

- A "New" tab in the nav (Apple Horror): what Aurora can do now and how to use it — a card per feature with a small living cue, one plain sentence, a How, and a button that takes you there. The tab carries a dot until you've seen this version's page; on phones it lives in the profile menu.
- Trailers in the hero (Apple Horror): a title that sits on the billboard for three seconds cross-fades from its art to its trailer, streamed straight from YouTube, muted, for 25 seconds — then back to the art and on to the next pick. Press Unmute for sound and the trailer runs 50 seconds before easing out. A dot, a swipe, scrolling past or hiding the tab ends it at once. Off on data saver, reduce-motion and the classic look; off by default on phones (Preferences → Playback → Trailers in the hero).
- The screensaver now also takes over a film left paused for three minutes, exactly as it does on Home; any input or playback resuming wakes it, and the frame is where you left it.
- Hero: a slab again, 12px in from the edges, a little taller, brighter art, the buttons level with the dots. The sliding highlights across glass surfaces are gone; hovered cards keep the ring without the halo; the season picker sits inside the page margin; greys are brighter.

## 1.5.1 — 2026-09-14

- QA pass, 23 fixes. Peek: a Discover title offers Open (not a Play that went nowhere), an episode's Details opens its show, focus returns to the card, no iOS image sheet under a hold. Watch parties: the host stays host across Up next, a guest never advances on its own. The player ignores its shortcuts while a sheet or text field has the keyboard, and sheets and toasts show inside fullscreen. Confirm and Join sheets trap remote focus; Join is a centred sheet with a four-character code. Downloads' Cancel keeps its button after a failure. The classic look's player dock lays its groups out inline again. Title pages: no stray "0" on an episode without a duration, the season island scrolls on phones, the phone puts the actions before the rating card and keeps a smaller poster. Phone dock: transport on one row, tools on the next.
- Server: problem reports store only the fields they need and the admin broadcast is slim; the subtitle fetch coalesces library rescans and rejects prototype-key languages; intro detection fingerprints cooperatively (never a one-second block), reads chapters asynchronously, prunes entries for deleted episodes, and tells the watchdog it's busy; the watchdog never restarts twice within fifteen minutes, ignores lag while the server is legitimately working, counts ffmpeg from the spawners on every platform, and flushes stores at the last moment; jit's soft heal spares producers anyone is waiting on; play-mark log lines are sanitised; pm2 counts a death within 10s of boot as a crash.

## 1.5.0 — 2026-09-14

- Apple Horror, tightened: the home hero is full-bleed and taller, sits behind the floating nav, and its art is sharp from the first frame; the Tonight row is gone — Continue Watching is Continue Watching again, and parties live in their own strip; the quiet dots are back instead of the picks panel; the sky moves faster and its curtains cover the whole height.
- One glass everywhere: every raised surface — sheets, menus, settings cards, episode and source rows, the title page's side card and season island — is the nav island's material (blur 7px, the same fill and edge light). The title page's art blur dropped from 50px to 1px.
- Title pages redesigned for the new look: a chip row, a big title, glass action pills, a side card with your rating and what's on the server, a season island, and episode cards with stills, "EPISODE N · MIN" kickers and progress.
- Player dock rebalanced: volume on the left, transport in the middle, tools on the right. The title pill up top keeps resolution, HDR and sound and drops the codec and CC.
- Nav links no longer flash white when the mouse leaves them (pointer focus is drawn like hover; only keyboard focus gets the strong ring).
- Faster starts for files on disk: HEVC in MKV goes straight to the copy stream instead of gambling on direct play and stalling; the decode-stall watchdog decides in 3 seconds instead of 6; every library start now logs its steps under [play] in the server log (mount → path → first frame, with milliseconds) so a slow start can be read, not guessed.
- Watchdog and self-heal: every 20 seconds the server checks memory, event-loop lag and ffmpeg children. Under pressure it drops rebuildable caches and stops idle transcoders; if memory keeps climbing or the loop is stuck it restarts itself cleanly under pm2. Admin → Server has a Health card with the numbers, the events, and a Heal now button.
- Report a problem: profile menu → Report a problem (or the player's gear menu). A few words from you, and the screen, the title playing, the look, the browser, the app version, the player's start-up marks and the page's last errors come along by themselves. Admin → Moderation lists them; the admin's phone gets a push.
- Performance, same picture: the glass sheen moves by transform instead of repainting every surface each frame; ordinary buttons no longer carry a backdrop blur each; rows and grids below the fold skip layout until they scroll near; the sky paints at 20 fps.

## 1.4.0 — 2026-09-14

- Auto-subtitles: pick a language under Preferences → Subtitles and it follows your profile to every device. When a title you own doesn't have it, Aurora fetches one from the subtitle providers in the background, saves it next to the file for everyone, and switches it on the moment it lands.
- Hold any card (or right-click it) for a peek sheet: art, what it is, how much is left, the synopsis, and Play / Details / My List right there. Back, the backdrop or ✕ puts you exactly where you were.
- Phone: double-tap the left or right of the picture to skip 10 seconds, with a ripple where your finger landed. Dragging the scrubber ticks under your finger where the intro ends and the credits start — those points are also drawn on the bar.
- Player controls step aside after 2.4 seconds of nothing moving, and come straight back on any motion — finger, wheel, key or remote, not only the mouse.
- Desktop: the first visit gets one quiet hint that ? opens the keyboard shortcuts.
- Smart downloads explains itself the first time it queues an episode, and every such toast has Cancel on it.
- Up next for a streamed show lands on the exact episode with its sources open.
- Watch parties on a transcoded or torrent stream tolerate more drift before re-seeking, so a guest on a slower stream stops restarting its pipeline every few seconds.
- "Clear intro marks" has Undo, and the admin page shows who marked an intro and when.
- Trailers: several trailers get a chooser; a device with no internet is told why the trailer stays black.
- Series pages get two new shelves when a TMDB key is set: More from the creator, and More on the network.
- The Discover storefront (trending + catalogue search) is reachable again from a search with no results, and uses the app's own API client.
- Wrapped shows a greyed-out preview of the real cards until there's something to wrap.
- Save offline can be cancelled with a second press, and its percentage counts the bytes that actually landed.
- Taste: the first two rows of posters load eagerly.
- Admin: every table sorts by its headers, ← → walk the tabs, irreversible actions (ban, kick, decline, remove, broadcast, pull) ask first, the banned-IPs table has headers, server errors say so instead of leaving a pane blank, and Analytics has a Skip intro card: episodes analysed, intros and credits detected, marks made by hand.

## 1.3.0 — 2026-09-14

- "Apple Horror" is now the default look for everyone. The first time a profile opens Aurora after the update, one small note says the classic look is a switch away (Preferences → Appearance → Look) — shown once, then never again.
- Skip intro and Up next got real detection: after a scan, Aurora listens to the first ten minutes and the last four of every episode, fingerprints the audio, and finds the stretch that repeats across the season (the theme) and the stretch shared at the end (the credits). Chapters named "Intro" / "Credits" win when a file has them; anything you mark by hand still beats both. Needs ffmpeg on the server; runs quietly in the background.
- The Up next card now appears when the credits actually start, not at a fixed number of seconds before the end.
- Motion, everywhere the new look lives: menus pop, buttons squash on press, lists and cards rise in as they arrive, the LIVE badge breathes, "ready" pills land, skeletons shimmer, the scrubber head grows under the finger, focus glides between controls. All of it steps aside for "reduce motion".
- A toast the moment smart downloads queues the next episode, so a new row on the Downloads page is never a mystery.
- The three "get this somewhere" buttons say what they do on hover: Save (to the server library, for everyone), Download the file (to this device), Save offline (inside Aurora, plays with no server).
- Watch parties survive Up next: when the host's player rolls into the next episode, everyone follows and the party keeps its code. The 👥 button now explains what a party is (and that it shows on everyone's Home) before it starts one. Back with guests in the room asks for a second press.
- Skip intro: a detected intro that's wrong can be ignored for that show (gear → Skip intro), and marking one by hand is two taps on the video — "Mark intro start", then an "Ends here" chip — instead of a trip back through the menu.
- "Start over" on the resume card really starts over on transcoded files, and resume is announced once, not after every seek.
- Your own downloads can be cancelled from My downloads while they're still on their way; My downloads is always one press away in the profile menu.
- Save offline asks first, with the size it will take and whether it's the original file or a 720p copy; saved subtitles now actually play offline.
- Preferences has an Offline card that says where offline copies can live (https or localhost) — and on plain http the Saved entry and the "Saved titles still play" link stay out of the way instead of leading to a dead end.
- The TV pairing page is a proper centered card in both looks.

## 1.2.0 — 2026-09-14

- A second look, "Apple Horror": glass chrome floating over a living aurora sky, a hero that's a lens, a Tonight row that carries what landed and who's watching, a player dock, and a phone tab bar. Pick it per profile under Preferences → Appearance → Look; the classic look stays exactly as it was.
- Format badges everywhere a file is described: 4K, Dolby Vision, HDR10, Dolby Atmos, TrueHD, DTS:X, channel count, HEVC/AV1, subtitles — read from the file itself (the scanner now probes colour transfer, Dolby Vision side data and audio profiles).

## 1.1.0 — 2026-09-13

- Downloaded titles always play the file on disk, never the torrent — from Continue Watching, Up Next, deep links and the detail page.
- One watch history per title: an episode streamed on Monday and downloaded on Tuesday resumes where you left it, and dismissing it dismisses it everywhere.
- Detail pages open instantly for anything in the library; cast, backdrop and episode titles fill in as they arrive.
- The sources list explains itself: the ★ BEST pick says how it will go ("starts in about 4s · 1080p · 1.0 GB"), the others say what they trade away.
- My downloads (the nav pill): your own requests — ready to play, on their way, waiting for approval — and a green "✓ ready" that stays until you open the title.
- Franchise and "More from <director>" shelves on movie pages (needs a TMDB key).
- Trailers on the detail page.
- Admin log can be filtered by subsystem and copied in one press.
- Smart downloads: two-thirds into an episode, the next one starts downloading to the server (off per profile in Preferences → Playback).
- Resume shows the frame you stopped on — on the title page's Resume button and in the player.
- Watch parties: start one from the player (👥), share a four-letter code, and everyone's play, pause and seek stay in step.
- Offline on your phone: "Save offline" on any title you own keeps a phone-playable copy on the device; the app and your saved titles work with no server in reach. Needs Aurora on an https address (browsers allow offline storage only there).
- This "What's new" card, with the app's version, under Preferences.

## 1.0.0 — 2026-08-27

- Downloads page in the admin panel: needs you / in flight / on disk, with per-episode deletion.
- Full-timeline VOD streaming for library MKVs and torrents (seek anywhere, Apple fullscreen keeps the whole timeline).
- Disk guard: streaming refuses loudly at 2GB free instead of failing mid-play.
