# Changelog

Shown inside the app under Preferences → What's new. Newest first; one
"## version — date" heading per release, plain bullets under it.

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
