# Aurora for Android phones — every feature, beside the website and the TV

elia, 2026-10-29: *"Also the app does not work with / link for the tv, I don't want to find more stuff like that, so please make sure all is there and really ready, and all features are working and working well, also updates because we are not on the app store."*

Branch `phone-features` (on top of `phone-web-look`, phone 1.0.1). One row per feature: where it lives on the **website**, on the **TV**, in the **phone app**, its **status**, and **how it was verified**.

- **Status**: ✅ works · 🆕 added in this branch · 🔧 was broken, fixed in this branch · 🌐 website only, on purpose (why in the row) · ◐ partly (what is missing in the row)
- **How verified**: **E** = done by hand on the Android emulator (AVD `Aurora_PhoneFeat_API37`, a Pixel 9 / Android 17 image, `emulator-5556`) against a private test server from this worktree (`scripts/ui-test-server.js`, profiles *Phone QA* / *Other QA* / *Unclaimed QA*); **U** = a jest test in `tv-native/__tests__/logic/`; **S** = a server test in `test/`; **R** = read in the code only (no device check).

## Sign-in, profiles, the wall

| Feature | Website | TV | Phone app | Status | How verified |
|---|---|---|---|---|---|
| Sign in with username/email + password (closed mode) | login.js | SignIn.tsx | screens/SignIn.tsx | ✅ | E (closed-mode server) |
| Sign in with a code shown on the device (approved elsewhere) | — (it approves) | SignIn.tsx QR | SignIn.tsx "Use a code instead" | ✅ | E (approved from a script; the phone walked in) |
| **Sign in a TV — the TV's QR (`/link?code=…`)** | `/link` → #/pair/:code (pair.js) | shows the QR | **screens/PairTv.tsx**, opened by the link (manifest claims `nufurora.com/link`) | 🔧 the app ignored it | E (warm, cold, after Back closed the app, at the wall then after sign-in), U |
| **Sign in a TV — type its code** | #/pair (pair.js) | — | Settings → Aurora → *Sign in a TV*; Your TVs → *Sign in a TV* | 🆕 | E (wrong code, right code), U |
| Sign in a TV on an open / transition server (phone holds no sign-in, or another profile's) | pair.js "Sign in to approve" | — | PairTv "Sign in to approve" (only this profile's sign-in is accepted) | 🆕 | E (Unclaimed QA; Other QA's sign-in refused) |
| Who's watching? wall, locked profiles, password | profiles.js | ProfileGate.tsx | screens/Gate.tsx | ✅ | E |
| Kids profiles, household PIN to leave | profiles.js, kids | ProfileGate + kids lock | Gate.tsx (shared AppRoot rules) | ✅ | R (shared AppRoot code, TV-verified; no kids profile on the test server) |
| Switch profile | profile menu | Settings | profile menu, Settings | ✅ | E |
| Sign out on this phone | Settings → Sign-in | Settings | Settings → Account | ✅ | E |
| Forced new password | resetwall.js | NewPassword.tsx | screens/NewPassword.tsx | ✅ | R (shared AppRoot rule) |
| Add a profile / request access | profiles.js (the add tile opens login.js signup) | — | Gate "Add profile", SignIn "First time here? Request access" (POST /api/auth/signup) | 🆕 | E (request filed, seen in the admin's queue), U |
| Edit profile & password (name, emoji, colour, email, password) | preferences.js / profiles.js | — | Settings → Your profile → screens/EditProfile.tsx | 🆕 | E (emoji saved; wrong current password refused; new password kept the sign-in across a relaunch), U |
| Upload / change / remove a photo | preferences.js | — | Settings → Your profile (Android's photo picker, scaled to 1024 px JPEG, PhoneModule.kt) | 🆕 | E (picked, uploaded, shown; removed) |
| Kids mode on/off, delete a profile | preferences.js | — | — | 🌐 for now — needs the household PIN flow; done on the website |
| Signed-in devices, revoke, sign out everywhere, add email | preferences.js Sign-in | — | — | 🌐 account security, kept on the website (one place to look after your sign-ins) |
| Connect Google / sign in with Google | google.js | TV Google QR | — | 🌐 Google's flows need the browser; the phone signs in with a password or a code |
| Set up my sign-in (claim, transition onboarding) | claim.js | — | — | 🌐 one-time setup, done once on the website |

## Browsing

| Feature | Website | TV | Phone app | Status | How verified |
|---|---|---|---|---|---|
| Home rows, billboard, greeting, Continue watching (✕ to remove) | home.js | Home.tsx | screens/Home.tsx | ✅ | E (rows, billboard, greeting); R (✕) |
| Recommended by your household (row, banner, Not for me, page) | home.js, household.js | Home, Household.tsx | Home, Detail banner, screens/Household.tsx | ✅ | R |
| Recommend to household | recommend.js | RecommendSheet | sheets/RecommendSheet.tsx | ✅ | E (sent to Other QA; the server's "sent" list has it) |
| Movies / Shows grids, categories, genre, Unwatched, Surprise me | browse.js | Browse.tsx | screens/Browse.tsx | ✅ | E (grid, open a title) |
| My List (filters, sort) | browse.js #/list | MyList.tsx | screens/MyList.tsx | ✅ | E (added from a title page; the server's list has it; the tab shows it) |
| Title page: play, resume, start over, stream instead, My List, X-Ray, mark watched, follow, trailer, share | details.js / discover-detail.js | Detail.tsx | screens/Detail.tsx | ✅ | E (play, resume, My List, X-Ray sheet, watched); R (trailer, share, follow) |
| **Your rating (1–5 stars)** | components.js starRating | — (not on the TV yet) | **ui/StarRating.tsx** on the title page, same key (IMDb id) | 🆕 | E (4★ stored as the site stores it), U |
| **"On this server" lines** (on disk, size, how many episodes) | discover-detail.js serverInfoFor | — | Detail, under Your rating | 🆕 | E, U |
| Seasons, episodes (cards), mark season/episode watched | details.js | Detail.tsx | Detail.tsx | ✅ | E (Test Show: the cards, an episode's choices) |
| Search, recent searches, suggestions, voice | search.js, voice.js | Search.tsx, voice | screens/Search.tsx | ✅ | E (a `#/search/<words>` link searched: library results, and the offline test server's honest "couldn't reach the catalogue"); voice R |
| Person sheet (tap a cast name) | personSheet.js | PersonSheet | — | ◐ cast is plain text on the phone |
| Pick for me (AI mood) | pickforme.js | Pick.tsx | — | 🌐 for now — needs the server's AI switched on; the link opens the app with "that page is on the website" |
| Swipe your taste (+ Edit list) | taste.js | Taste.tsx | screens/Taste.tsx (drag the card; ✕ / ↑ / ♥; Undo) | 🆕 | E (a right drag stored Love on the server, Undo took it back), U |
| Your Aurora Wrapped | wrapped.js | — (not on the TV yet) | screens/Wrapped.tsx | 🆕 | E (the test profile's stats and lines), U |
| Requests (old Discover page) | requests.js | — | — | 🌐 kept only for old links on the website |
| Home rows editor, Look (glass/classic), theme, accent | preferences.js | — | — | 🌐 the phone app has one look (the site's glass); the row order set on the website is what the phone's Home shows |

## Settings

| Feature | Website | TV | Phone app | Status | How verified |
|---|---|---|---|---|---|
| Genres you like | preferences.js | Settings.tsx | Settings | ✅ | R |
| Subtitles: on by themselves, language, the six style rows with a preview | preferences.js | Settings.tsx | Settings (personPrefs: same on every device) | ✅ | R (rows seen, not changed) |
| Audio language | remembered per pick (`prefs.audioLang`) | the same | the same (shared player) | ✅ | R |
| Night mode, dialogue boost | preferences.js | Settings | Settings, player menu | ✅ | E (in the player menu) |
| Autoplay next episode | preferences.js | Settings | Settings | ✅ | R |
| Quality / data use | Internet: Automatic / Data saver / Full | — | the player's *Lower quality* on a slow start; saves to the phone pick a quality | ◐ no Data-saver switch on the phone; ExoPlayer's own bitrate and the server's capped encode do the job |
| **What's new** (the CHANGELOG through the server) | preferences.js What's new, #/new | WhatsNew.tsx | **screens/WhatsNew.tsx** (Settings, the profile menu, `#/new`) | 🆕 | E (opened from `#/new`: 1.15.4, 1.15.3 …), U |
| Get the apps | /install | — | profile menu → the browser's /install | 🆕 | R (opens the browser; Chrome's first-run terms were not accepted on the emulator) |
| Notifications ("tell me when it lands") | Web Push | the TV's notice | Settings → Notifications (Android notifications) | ✅ | E (the permission prompt) |
| Recommendations: on/off, mute people, What you sent | preferences.js | Settings | Settings | ✅ | E (seen), R (switches) |
| Usage stats on/off | preferences.js | Settings | Settings | ✅ | R |
| On the TV: match frame rate, surround | preferences.js | Settings | — | 🌐 TV-only settings |
| Phone as a remote: this device's name, let others play here | preferences.js | — | — | ◐ the phone is a remote (Your TVs), not a screen others can play on |
| **Check for updates** | — | Settings | Settings → This phone | 🔧 said "latest" when the server could not be reached | E (all cases below) |

## Downloading

| Feature | Website | TV | Phone app | Status | How verified |
|---|---|---|---|---|---|
| Sources / pick a release, save to the server | discover-detail.js | Sources.tsx | screens/Sources.tsx | ✅ | R (the private test server has no internet, so no sources; no server download was started anywhere) |
| My downloads (cancel, retry, remove, the household's) | downloads.js | Downloads.tsx | screens/Downloads.tsx | ✅ | E (the screen and its offline answer); R (cancel/retry: no server download was started) |
| **Get another version** (a bad copy) | replaceCopy.js | ReplaceSheet | **sheets/ReplaceSheet.tsx** — from the player's settings menu, a film's *Another version*, an episode's choices | 🔧 the player's entry opened nothing on the phone | E (reasons → sources step; the private server cannot reach a provider, so no pick) |
| Get the next episode ready, tidy up after watching | preferences.js | Settings | Settings | ✅ | R |
| Save to the phone (offline), quality, Wi-Fi only, play offline | offlinePicker.js (browser cache) | — | offline/*, OfflinePlayer.tsx (DownloadManager, real files) | ✅ | E (small film, then removed) |
| Download the file to this device / play your own files | downloadPicker.js, localplay.js | — | — | 🌐 a browser thing; on the phone "Save to phone" is the way |

## Playback

| Feature | Website | TV | Phone app | Status | How verified |
|---|---|---|---|---|---|
| Direct play, copy, encode (by what the phone decodes) | player.js | Player.tsx + avCaps | shared Player + avCaps | ✅ | E (the test films played; capabilities reported) |
| **The player's menus by touch** (subtitles, audio and settings, speed, Watch together, Get another version, Skip intro, Up next …) | — | D-pad | the shared Player's menus | 🔧 a tap did nothing from the second launch on (the TV's native Focusable answers the remote's OK only; the phone now always uses the Pressable one) | E (subtitles Off, Watch together → Start / Share / End, Get another version — each by a tap) |
| Resume, start over | player.js | Player | Player | ✅ | E |
| Subtitles (pick, style, timing), audio tracks, speed | player.js | Player | Player + PhoneChrome | ✅ | E (subtitles shown, switched off) |
| Skip intro / recap / credits, Up next | player.js | Player | Player | ✅ | R (shared, TV-verified) |
| X-Ray | xray.js | XraySheet | sheets/XraySheet.tsx | ✅ | E (opens; the offline test server has no X-Ray data) |
| Picture in picture, background audio, lock-screen controls | browser PiP | — | PhoneActivity PiP + media session | ✅ streaming · 🔧 a saved copy did not shrink into PiP (react-native-video reset the window's PiP rules) | E (streaming: PiP window + the media notification/session; the saved-copy fix is in the last build) |
| Gestures (seek, brightness, volume, double-tap, pinch, lock) | phone gestures | — | player/PhoneGestures.tsx | ✅ | U; E (tap for the controls) |
| Report a problem | report.js | Overlays | sheets/SmallSheets.tsx | ✅ | R |

## Together

| Feature | Website | TV | Phone app | Status | How verified |
|---|---|---|---|---|---|
| Watch party: host, react, hand over, end/leave | player.js party | Player | shared Player | 🔧 (the menus by touch, above) | E (started Q2CK, ended; the server's party list empty after) |
| **Watch party: share the invite** | party.js Share invite | — (no share sheet) | **Player → Watch together → Share the invite** (Android share sheet, `…/#/party/CODE`) | 🆕 | E ("Watch Test Film Two with me on Aurora — …/#/party/Q2CK") |
| Watch party: join by code or link | main.js #/party, Join sheet | Settings | Settings / menu Join sheet, `#/party/CODE` links | ✅ | U (links); R (join) |
| Phone remote: pick a TV, D-pad, volume, tracks, play/pause/seek | #/remote | the receiver | screens/Remote.tsx | ✅ | R (needs a TV on the socket; not used here) |
| Remote: rename the TV, touchpad, subtitle timing, Continue watching when idle | remote.js | — | — | ◐ website extras |
| Play on TV (from a title page) | details.js | — | Detail *Play on TV* | ✅ | R |

## Updates (no app store)

See "The updater, case by case" below for each case. Phone-only native half: `android/app/src/main/java/com/auroratv/phone/PhoneUpdaterModule.kt`; decisions: `src/phone/update/rules.ts` (U); steps: `src/phone/update/store.ts`; the TV's updater (`UpdaterModule.kt`, `src/update.ts`) is unchanged.

## Links the website, the server and the TV hand out

| Link | Made by | Phone app opens | Status | How verified |
|---|---|---|---|---|
| `nufurora.com/link?code=XXXXXX` (TV sign-in QR) | src/routes/auth.js, TV SignIn.tsx | Sign this TV in? | 🔧 | E, U |
| `nufurora.com/link` (no code) | TV "No camera handy?" | the code field | 🆕 | U |
| `#/pair`, `#/pair/CODE` | website | the same | 🆕 | U |
| `#/movie/<id>`, `#/show/<id>`, `#/discover/(movie|series)/<tt>` | site share, the app's Share | the title page | ✅ | U, E |
| `#/party/<CODE>` | party invite | the party's film | ✅ | U |
| `#/search/<words>` (the site's form) | X-Ray cast names | Search on those words | 🔧 opened Home | U |
| `#/play/<id>` | the "… is ready" Web Push | the player | 🔧 opened nothing | U |
| `#/new`, `#/household[/sent]`, `#/saved`, `#/downloads`, `#/remote`, `#/preferences`, `#/list`, `#/movies`, `#/shows` | site | the matching screen | 🔧 (`new`, `household`, `saved` were not known) | U |
| `#/wrapped`, `#/taste` | site | Wrapped, Swipe your taste | 🆕 | U |
| `#/pick`, `#/requests` | site | a note that the page is on the website | 🌐 | U |
| `aurora://open?…`, `aurora-phone://…` | notifications, the app's own | the title / player | ✅ | U |
| `/install`, `/download`, `/download/phone`, `/download/<id>/latest`, `/web`, `/admin` | server | **not claimed** — they stay the browser's (the manifest claims only `/` and `/link`) | ✅ | U (manifest test) |

Admin pages (`/admin`) are website-only on purpose; the website shows admins no extra links in its normal pages.

## The updater, case by case (emulator, private server, the same release key)

Builds: **1.0.1 / vc 2** (this branch) installed; **1.0.9 / vc 9** (the same code, version raised locally for the test only) published on the private server as `public/aurora-phone.apk` + `phone-version.json`. A small proxy in front of the server (`adb reverse tcp:4000` → proxy → server) broke the download on purpose.

| Case | What happened | Result |
|---|---|---|
| Found on launch | "Update ready · Aurora for Android 1.0.9 · this phone has 1.0.1" with the notes, 6 s after Home | ✅ |
| Found from Settings → Check for updates | the same sheet (a "Later" from before does not hide it here) | ✅ |
| Found on return to the app | asks again when the app comes back, at most every 30 min (`checkOnReturn`, U) | ✅ U; R on device |
| Later | the version waits a day: a relaunch said nothing | ✅ E |
| "Install unknown apps", first time | "Allow in Settings" opened Aurora's own switch; turned on, Back → the update went on by itself (download, check, Android's question) — the app was not restarted by Android | ✅ E |
| Download with progress | "Downloading… 23% of 32.9 MB" under a bar, and in the notification shade (Android's DownloadManager) | ✅ E |
| App backgrounded mid-download | Home pressed at 7 %: the download finished with the app in the background; back in the app → checked → Android's question | ✅ E |
| Checked before installing | SHA-256 and size against `/phone-version.json` (the server now announces the APK's SHA-256), and the APK itself: package, higher versionCode, same signing certificate | ✅ E, S |
| Android's question → Cancel | "The update wasn't installed. It's ready whenever you are." + "Install the update" (no new download: the kept file went straight back to Android) | ✅ E |
| Android's question → Update | Android replaced the app and **opened it again by itself as 1.0.9**; "Aurora is updated to 1.0.9 — what's new" once; not again on the next launch; the downloaded file was cleaned up | ✅ E |
| Sign-in and saved copies kept | still in Phone QA after the update; a film saved to the phone before the update played after it, in airplane mode with the server down | ✅ E |
| No network (Settings check) | "Couldn't check — this phone is offline" (used to say "You're on the latest version") | 🔧 ✅ E |
| Server unreachable (Settings check) | "Couldn't reach 127.0.0.1:4000 — try again in a moment" | 🔧 ✅ E |
| Network lost mid-download | "Waiting for a connection — it carries on by itself."; back online it resumed (HTTP Range) and finished | ✅ E |
| Connection dropped mid-download | "The server didn't answer — trying again in a moment." then resumed from the byte it had, verified, installed | ✅ E |
| Corrupt download (same size, bytes flipped) | refused by the SHA-256 check, fetched once more by itself, refused again → "The download arrived damaged, so it was thrown away. Try again." Nothing reached the installer | ✅ E |
| The file gone from the server mid-way (404) | "The update is no longer on the server — it may have just been replaced. Try again." | ✅ E |
| Low storage | ~93 MB free: "There isn't room on this phone for the update: it needs about 132 MB free, and 92.9 MB is…" before anything was downloaded | ✅ E |
| The same version offered | 1.0.1 published, 1.0.1 installed: no sheet; Settings: "You're on the latest version (1.0.1)" | ✅ E, U |
| A downgrade offered | 1.0.0 published, 1.0.1 installed: no sheet, nothing downloaded | ✅ E, U |
| A newer name with a build number that did not go up | not offered (Android would refuse it: no "App not installed" loop) | ✅ U |
| Google Play Protect | on phones with Play services Android adds its own "App scan recommended" box to a sideloaded update; "More details → Install without scanning" (or Scan app) goes on | ⚠️ outside the app — said in DEVICE-CHECKS |

Server side: `/phone-version.json` is answered from the APK itself (version, versionCode, size and now SHA-256; notes only when `phone-version.json` names the same version), `/download/phone` and `/download/phone/latest` hand the file over in every sign-in mode, `/install` shows the same SHA-256. `test/phoneapp.test.js` now fails a release that commits `public/phone-version.json` for another build than `public/aurora-phone.apk` (or a TV APK in the phone's place). nufurora.com already serves `/.well-known/assetlinks.json` with the release key's fingerprint (checked with curl) — `/link` opens the app there with no new verification (App Links verify the host, not the path).

Not run: updating FROM the published 1.0.0 (its updater is the old one) — the QA rules keep the published build (it talks to nufurora.com) off the emulator. The server side it uses (`/phone-version.json`, `/download/phone`) is unchanged, and the new APK is a normal update for it (same key, higher versionCode).
