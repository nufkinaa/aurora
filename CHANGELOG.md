# Changelog

Shown inside the app under Preferences → What's new. Newest first; one
"## version — date" heading per release, plain bullets under it.

## 1.6.2 — 2026-09-14

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
