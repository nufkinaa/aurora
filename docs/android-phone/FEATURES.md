# Aurora for Android phones — every feature, beside the website and the TV

elia, 2026-10-29: *"Also the app does not work with / link for the tv, I don't want to find more stuff like that, so please make sure all is there and really ready, and all features are working and working well, also updates because we are not on the app store."*

Branch `phone-features` (on top of `phone-web-look`, phone 1.0.1). One row per feature: where it lives on the **website**, on the **TV**, in the **phone app**, its **status**, and **how it was verified**.

- **Status**: ✅ works · 🆕 added in this branch · 🔧 was broken, fixed in this branch · 🌐 website only, on purpose (why in the row) · ◐ partly (what is missing in the row)
- **How verified**: **E** = done by hand on the Android emulator (AVD `Aurora_PhoneFeat_API37`, a Pixel 9 / Android 17 image, `emulator-5556`) against a private test server from this worktree (`scripts/ui-test-server.js`, profiles *Phone QA* / *Other QA* / *Unclaimed QA*); **U** = a jest test in `tv-native/__tests__/logic/`; **S** = a server test in `test/`; **R** = read in the code only (no device check).

## Sign-in, profiles, the wall

| Feature | Website | TV | Phone app | Status | How verified |
|---|---|---|---|---|---|
| Sign in with username/email + password (closed mode) | login.js | SignIn.tsx | screens/SignIn.tsx | ✅ | E (closed-mode server) |
| Sign in with a code shown on the device (approved elsewhere) | — (it approves) | SignIn.tsx QR | SignIn.tsx "Use a code instead" | ✅ | E |
| **Sign in a TV — the TV's QR (`/link?code=…`)** | `/link` → #/pair/:code (pair.js) | shows the QR | **screens/PairTv.tsx**, opened by the link (manifest claims `nufurora.com/link`) | 🔧 the app ignored it | E (warm, cold, after Back closed the app, at the wall then after sign-in), U |
| **Sign in a TV — type its code** | #/pair (pair.js) | — | Settings → Aurora → *Sign in a TV*; Your TVs → *Sign in a TV* | 🆕 | E (wrong code, right code), U |
| Sign in a TV on an open / transition server (phone holds no sign-in, or another profile's) | pair.js "Sign in to approve" | — | PairTv "Sign in to approve" (only this profile's sign-in is accepted) | 🆕 | E (Unclaimed QA; Other QA's sign-in refused) |
| Who's watching? wall, locked profiles, password | profiles.js | ProfileGate.tsx | screens/Gate.tsx | ✅ | E |
| Kids profiles, household PIN to leave | profiles.js, kids | ProfileGate + kids lock | Gate.tsx (shared AppRoot rules) | ✅ | R (shared AppRoot code, TV-verified) |
| Switch profile | profile menu | Settings | profile menu, Settings | ✅ | E |
| Sign out on this phone | Settings → Sign-in | Settings | Settings → Account | ✅ | E |
| Forced new password | resetwall.js | NewPassword.tsx | screens/NewPassword.tsx | ✅ | R (shared AppRoot rule) |
| Add a profile / request access | profiles.js, login.js signup | — | Gate "Add profile", SignIn "Request access" | 🆕 | see the end of this file |
| Edit profile & password, photo | preferences.js / profiles.js | — | Settings → Your profile | 🆕 | see the end of this file |
| Signed-in devices, revoke, sign out everywhere, add email | preferences.js Sign-in | — | — | 🌐 account security, kept on the website (one place to look after your sign-ins) |
| Connect Google / sign in with Google | google.js | TV Google QR | — | 🌐 Google's flows need the browser; the phone signs in with a password or a code |
| Set up my sign-in (claim, transition onboarding) | claim.js | — | — | 🌐 one-time setup, done once on the website |

## Browsing

| Feature | Website | TV | Phone app | Status | How verified |
|---|---|---|---|---|---|
| Home rows, billboard, greeting, Continue watching (✕ to remove) | home.js | Home.tsx | screens/Home.tsx | ✅ | E |
| Recommended by your household (row, banner, Not for me, page) | home.js, household.js | Home, Household.tsx | Home, Detail banner, screens/Household.tsx | ✅ | E (row/page on the test server) |
| Recommend to household | recommend.js | RecommendSheet | sheets/RecommendSheet.tsx | ✅ | E |
| Movies / Shows grids, categories, genre, Unwatched, Surprise me | browse.js | Browse.tsx | screens/Browse.tsx | ✅ | E |
| My List (filters, sort) | browse.js #/list | MyList.tsx | screens/MyList.tsx | ✅ | E |
| Title page: play, resume, start over, stream instead, My List, X-Ray, mark watched, follow, trailer, share | details.js / discover-detail.js | Detail.tsx | screens/Detail.tsx | ✅ | E |
| **Your rating (1–5 stars)** | components.js starRating | — (not on the TV yet) | **ui/StarRating.tsx** on the title page, same key (IMDb id) | 🆕 | E (4★ stored as the site stores it), U |
| **"On this server" lines** (on disk, size, how many episodes) | discover-detail.js serverInfoFor | — | Detail, under Your rating | 🆕 | E, U |
| Seasons, episodes (cards), mark season/episode watched | details.js | Detail.tsx | Detail.tsx | ✅ | E |
| Search, recent searches, suggestions, voice | search.js, voice.js | Search.tsx, voice | screens/Search.tsx | ✅ | E (typed; mic asks for the permission) |
| Person sheet (tap a cast name) | personSheet.js | PersonSheet | — | ◐ cast is plain text on the phone |
| Pick for me (AI mood) | pickforme.js | Pick.tsx | — | 🌐 for now — needs the server's AI switched on; the link opens the app with "that page is on the website" |
| Swipe your taste | taste.js | Taste.tsx | screens/Taste.tsx | 🆕 | see the end of this file |
| Your Aurora Wrapped | wrapped.js | — | screens/Wrapped.tsx | 🆕 | see the end of this file |
| Requests (old Discover page) | requests.js | — | — | 🌐 kept only for old links on the website |
| Home rows editor, Look (glass/classic), theme, accent | preferences.js | — | — | 🌐 the phone app has one look (the site's glass); the row order set on the website is what the phone's Home shows |

## Settings

| Feature | Website | TV | Phone app | Status | How verified |
|---|---|---|---|---|---|
| Genres you like | preferences.js | Settings.tsx | Settings | ✅ | E |
| Subtitles: on by themselves, language, the six style rows with a preview | preferences.js | Settings.tsx | Settings (personPrefs: same on every device) | ✅ | E |
| Audio language | remembered per pick (`prefs.audioLang`) | the same | the same (shared player) | ✅ | R |
| Night mode, dialogue boost | preferences.js | Settings | Settings, player menu | ✅ | E |
| Autoplay next episode | preferences.js | Settings | Settings | ✅ | E |
| Quality / data use | Internet: Automatic / Data saver / Full | — | the player's *Lower quality* on a slow start; saves to the phone pick a quality | ◐ no Data-saver switch on the phone; ExoPlayer's own bitrate and the server's capped encode do the job |
| **What's new** (the CHANGELOG through the server) | preferences.js What's new, #/new | WhatsNew.tsx | **screens/WhatsNew.tsx** (Settings, the profile menu, `#/new`) | 🆕 | E, U |
| Get the apps | /install | — | profile menu → the browser's /install | 🆕 | E |
| Notifications ("tell me when it lands") | Web Push | the TV's notice | Settings → Notifications (Android notifications) | ✅ | E (the permission prompt) |
| Recommendations: on/off, mute people, What you sent | preferences.js | Settings | Settings | ✅ | E |
| Usage stats on/off | preferences.js | Settings | Settings | ✅ | R |
| On the TV: match frame rate, surround | preferences.js | Settings | — | 🌐 TV-only settings |
| Phone as a remote: this device's name, let others play here | preferences.js | — | — | ◐ the phone is a remote (Your TVs), not a screen others can play on |
| **Check for updates** | — | Settings | Settings → This phone | 🔧 said "latest" when the server could not be reached | E (all cases below) |

## Downloading

| Feature | Website | TV | Phone app | Status | How verified |
|---|---|---|---|---|---|
| Sources / pick a release, save to the server | discover-detail.js | Sources.tsx | screens/Sources.tsx | ✅ | E (lists; no download started) |
| My downloads (cancel, retry, remove, the household's) | downloads.js | Downloads.tsx | screens/Downloads.tsx | ✅ | E |
| **Get another version** (a bad copy) | replaceCopy.js | ReplaceSheet | **sheets/ReplaceSheet.tsx** — from the player's settings menu, a film's *Another version*, an episode's choices | 🔧 the player's entry opened nothing on the phone | E (reasons → sources step; the private server cannot reach a provider, so no pick) |
| Get the next episode ready, tidy up after watching | preferences.js | Settings | Settings | ✅ | R |
| Save to the phone (offline), quality, Wi-Fi only, play offline | offlinePicker.js (browser cache) | — | offline/*, OfflinePlayer.tsx (DownloadManager, real files) | ✅ | E (small film, then removed) |
| Download the file to this device / play your own files | downloadPicker.js, localplay.js | — | — | 🌐 a browser thing; on the phone "Save to phone" is the way |

## Playback

| Feature | Website | TV | Phone app | Status | How verified |
|---|---|---|---|---|---|
| Direct play, copy, encode (by what the phone decodes) | player.js | Player.tsx + avCaps | shared Player + avCaps | ✅ | E (the test film played; capabilities reported) |
| Resume, start over | player.js | Player | Player | ✅ | E |
| Subtitles (pick, style, timing), audio tracks, speed | player.js | Player | Player + PhoneChrome | ✅ | E |
| Skip intro / recap / credits, Up next | player.js | Player | Player | ✅ | R (shared, TV-verified) |
| X-Ray | xray.js | XraySheet | sheets/XraySheet.tsx | ✅ | E |
| Picture in picture, background audio, lock-screen controls | browser PiP | — | PhoneActivity PiP + media session | ✅ | E |
| Gestures (seek, brightness, volume, double-tap, pinch, lock) | phone gestures | — | player/PhoneGestures.tsx | ✅ | U, E |
| Report a problem | report.js | Overlays | sheets/SmallSheets.tsx | ✅ | R |

## Together

| Feature | Website | TV | Phone app | Status | How verified |
|---|---|---|---|---|---|
| Watch party: host, react, hand over, end/leave | player.js party | Player | shared Player | ✅ | E |
| **Watch party: share the invite** | party.js Share invite | — (no share sheet) | **Player → Watch together → Share the invite** (Android share sheet, `…/#/party/CODE`) | 🆕 | E |
| Watch party: join by code or link | main.js #/party, Join sheet | Settings | Settings / menu Join sheet, `#/party/CODE` links | ✅ | E |
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
