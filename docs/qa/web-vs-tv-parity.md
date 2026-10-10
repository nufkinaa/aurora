# Website vs TV app: feature parity audit

Date: 2026-10-10. Tree: `C:\elia\aurora` at master (`bbead1f`, server 1.6.85). Published TV build: 5.1.31 (tag `tv-5.1.31-stable`, versionCode 94).

**Answer to "are the TV and website synced?"** No. The browsing surface (Home rows, Movies/Shows filters, My List, the AI page's controls) is closely in step. The gaps are in four places:

1. **Playback.** The TV has none of the website's quality layer (quality menu, Auto, the 720p/480p ladder, data saver) and lacks Skip recap, intro/credits for streamed episodes, "Still watching?", and the real-next-episode check.
2. **Title page.** Several rules differ (which episode Play picks, what a press on an episode does, More like this, Start over, default season).
3. **Search.** The TV never asks the server's search; it filters the library list itself, so typos and episode titles find nothing.
4. **Session control.** A TV ignores an admin kick or ban, never prompts for a forced password reset, and keeps its own copies of two settings the website stores on the profile (subtitle language, usage stats).

The TV is ahead of the website in a few places (AI "Try again", download status under Play, recovery after a dropped socket, honest load-error screens).

## How this was done

- Read-only. No code changed, nothing built, no adb, no server restart, no writes to the server.
- Everything is from reading source on both sides, area by area, plus endpoint and message-type greps across both clients. A sample of the findings was re-checked by hand against the files (marked "re-checked").
- **Nothing was run on a TV or in a browser.** Where behaviour depends on a device (ExoPlayer's clock on a copy stream, HDR, focus), it is marked undetermined.
- Line numbers are for master at this commit.

### Path shorthand

| Short | Path |
|---|---|
| `W/` | `public/js/` |
| `WS/` | `public/js/screens/` |
| `P.js` | `public/js/screens/player.js` |
| `dd.js` | `public/js/screens/discover-detail.js` |
| `T/` | `tv-native/src/` |
| `TS/` | `tv-native/src/screens/` |
| `P.tsx` | `tv-native/src/playback/Player.tsx` |
| `D.tsx` | `tv-native/src/screens/Detail.tsx` |
| `Ov.tsx` | `tv-native/src/components/Overlays.tsx` |
| `K/` | `tv-native/android/app/src/main/java/com/auroratv/` |
| `R/` | `src/routes/` |

### Verdict column

| Verdict | Meaning |
|---|---|
| SAME | Both have it and it behaves the same |
| MINOR | Both have it; the difference is wording, layout, or forced by the platform |
| DIFF | Both have it; rules, thresholds, defaults, endpoint or error handling differ |
| WEB | Website only (TV has none of it; the website may have only part) |
| TV | TV only |
| NONE | Neither client has it (listed because the brief or the server names it; not counted) |

## Counts

Counted from the matrix below (one row = one user-facing capability; rows marked NONE and settings rows that repeat another row are not counted).

| | Rows |
|---|---|
| Features found in either client | **244** |
| On both | **164** |
| of which the same | 59 |
| of which a minor difference (wording, layout, platform) | 42 |
| of which a real difference in behaviour | **63** |
| Website only | **65** (about 30 of them by design) |
| TV only | **15** |

## 1. Feature parity matrix

### 1.1 Sign-in and accounts

| # | Feature | Web | TV | Verdict | Difference |
|---|---|---|---|---|---|
| A1 | Finding out whether sign-in is required | yes, `GET /api/me` at boot, a failure is read as "open" (`W/main.js:616-625`) | yes, `GET /api/ping` while resolving the server (`T/api.ts:669-674`, `App.tsx:82`) | MINOR | Different endpoint, same outcome. |
| A2 | Login wall when the server requires sign-in | yes (`W/main.js:620-623`) | yes (`App.tsx:88-115`) | SAME | TV also re-validates its stored session first (`App.tsx:91-102`). |
| A3 | Username/email + password | yes (`WS/login.js:129-153`), empty-field message, show-password eye (`:41-52`) | yes (`TS/SignIn.tsx:130-143, 237-278`), no empty check, no eye | SAME | Same `POST /api/auth/login`. |
| A4 | QR pairing (TV shows a code, phone approves) | yes, the approving half: `#/pair/:code` (`WS/pair.js:11-102`) | yes, the requesting half: `device/start` + poll every 3000 ms (`TS/SignIn.tsx:76-124`) | SAME | Complementary halves, by design. |
| A5 | Pairing by typing the code instead of scanning | no: `pair.js` has no code input; `/link` with no code redirects to `/#/pair/` (`server.js:284-287`), which matches no route (`W/router.js:8-16`) | TV tells the viewer to do exactly that: "open {host}/link and type this code" (`TS/SignIn.tsx:355-358`) | DIFF | Broken path, see X1. Re-checked. |
| A6 | Google sign-in in a browser popup | yes (`W/google.js:22-56`) | no | WEB | By design (needs a browser redirect). |
| A7 | Google sign-in by device code | yes, fallback on IP hosts, link + code as text (`WS/login.js:306-357`) | yes, QR + text, only when `googleDevice` (`TS/SignIn.tsx:167-216, 304-315`) | MINOR | Same endpoints, 3000 ms poll on both. |
| A8 | Google identity with no profile: ask for access | yes, a form: name, optional username, note (`WS/login.js:198-282`) | yes, one press, name from Google, fixed note "Requested from the TV app" (`TS/SignIn.tsx:153-166`) | MINOR | Same `POST /api/auth/signup {pollId}`. |
| A9 | Sign up with a password | yes (`WS/login.js:198-282`, `WS/profiles.js:672-687`) | no, only "Ask {admin} for a profile" (`TS/SignIn.tsx:361-365`) | WEB | By design (typing). |
| A10 | Link Google to a signed-in profile | yes (`WS/preferences.js:481-533`) | no (no `google/link` in tv-native) | WEB | |
| A11 | Claim a profile (transition mode) | yes (`W/claim.js`, `WS/profiles.js:593-608`) | no (no `auth/claim` in tv-native) | WEB | By design. |
| A12 | Skip the password when this device already holds your session | yes (`WS/profiles.js:618-637`) | partial: only at boot (`App.tsx:130-143`); the picker always asks (`TS/ProfileGate.tsx:203-212`) | DIFF | See list C. |
| A13 | Sign out | yes (`W/main.js:571-581`, `WS/preferences.js:566-576`) | yes, "Sign out on this TV" (`TS/Settings.tsx:345-366`) | SAME | Hidden on both when there is no session. |
| A14 | Sign out everywhere else | yes (`WS/preferences.js:553-565`) | no | WEB | |
| A15 | List of signed-in devices, revoke one | yes (`WS/preferences.js:426-457`) | no | WEB | |
| A16 | Forced password reset prompt | partial: only after a password unlock at the profile picker (`WS/profiles.js:63-66`) | no (`mustReset` appears nowhere in tv-native) | WEB | And `/api/auth/login` drops the flag (X2). |
| A17 | Reaction to an admin kick | yes: toast, reload after 1500 ms (`W/ws.js:42-45`) | no: nothing subscribes to `kicked` (`T/realtime.ts:91-102`, `T/SessionWiring.tsx:50-61`) | WEB | Re-checked by grep. |
| A18 | Reaction to a ban | yes: "Access denied" page (`W/ws.js:46-55`) | no | WEB | |
| A19 | Sign-in wall goes up mid-session (401 `signinRequired`) | no (`W/api.js:32-44` keeps only `status` and `pinRequired`) | yes: clears credentials, shows login (`T/api.ts:610-618`, `App.tsx:213-223`) | TV | |
| A20 | Server unreachable at start | "Can't reach the Aurora server." + Try again, or opens Saved when offline copies exist (`W/main.js:629-650`) | "Can't reach Aurora." + Retry (`App.tsx:270-277`) | MINOR | Offline fallback is web only. |
| A21 | Choosing the server address | n/a (same origin) | none: two hard-coded candidates, LAN first (`T/api.ts:14-17, 719-726`); no entry screen | TV | The saved `aurora.serverUrl` is written but ignored (X12). |

### 1.2 Profiles

| # | Feature | Web | TV | Verdict | Difference |
|---|---|---|---|---|---|
| B1 | Profile picker "Who's watching?" | yes (`WS/profiles.js:561-779`) | yes (`TS/ProfileGate.tsx:418-459`) | SAME | |
| B2 | Picker order | recents band only with 7+ profiles, else A-Z (`WS/profiles.js:26, 719-733`); stores 10 (`W/state.js:56`) | always recents first (`TS/ProfileGate.tsx:110-119`); stores 8 (`T/storage.ts:39`) | MINOR | |
| B3 | Picker search box | yes at 7+ profiles (`WS/profiles.js:754-758`) | no, deliberate (`TS/ProfileGate.tsx:37-41`) | WEB | By design. |
| B4 | Password unlock and its errors | every failure says "Not quite. Try again." (`WS/profiles.js:50-85`) | separates wrong password, rate limit (server text), admin lock, no connection (`TS/ProfileGate.tsx:171-177`) | DIFF | TV is right. |
| B5 | Auto-enter at start | saved profile enters; a lone password-less profile skips the picker (`W/main.js:730-740`) | saved profile is validated first; no lone-profile shortcut (`App.tsx:122-178`) | DIFF | |
| B6 | Admin-locked profile | toast, dimmed tile (`WS/profiles.js:612`) | message, dimmed tile (`TS/ProfileGate.tsx:220-223`) | MINOR | Wording. |
| B7 | Password-less profile when the unlock call fails | enters anyway (`WS/profiles.js:187-198, 640-648`) | blocks with an error (`TS/ProfileGate.tsx:134-178`) | DIFF | TV is the safer one. |
| B8 | Ask for a new profile from the picker | yes (`WS/profiles.js:672-687`) | no | WEB | |
| B9 | Edit name, emoji avatar, colour | yes (`WS/profiles.js:263-549`) | no, deliberate (`TS/Settings.tsx:4-6`) | WEB | By design. |
| B10 | Set, change, remove a profile password | yes (`WS/profiles.js:304-336, 444-458`) | no | WEB | By design. |
| B11 | Delete a profile | yes (`WS/profiles.js:518-544`) | no | WEB | By design. |
| B12 | Profile e-mail | yes (`WS/profiles.js:436-443`, `WS/preferences.js:462-479`) | no | WEB | |
| B13 | Uploaded photo avatar, shown | yes (`WS/profiles.js:660-662`) | yes (`TS/ProfileGate.tsx:304-310`) | SAME | |
| B14 | Upload or remove a photo avatar | yes (`WS/preferences.js:365-413`) | no | WEB | By design (no file picker). |
| B15 | Kids badge on the picker | yes (`WS/profiles.js:664`) | yes (`TS/ProfileGate.tsx:315-319`) | SAME | |
| B16 | "Kids" mark while browsing | yes (`W/state.js:139`, `public/css/screens.css:4328-4336`) | no | WEB | |
| B17 | Make a profile a kids profile, pick the age limit, set the household PIN | yes: ages 0/7/12/16, PIN 4-6 digits (`WS/profiles.js:341-423`) | no | WEB | By design (also in admin). |
| B18 | How a device is held in kids mode | server cookie via `POST /api/kids/enter` (`W/state.js:140-142`) | `X-Profile` header + a local `aurora.kidsLock`; never calls `kids/enter` (`TS/ProfileGate.tsx:141-147`, `T/storage.ts:13-34`) | MINOR | By design; the TV lock lives on the box (clearing app data lifts it). |
| B19 | PIN to leave a kids profile | asked for any other profile (`WS/profiles.js:156-179`) | not asked when the target is a kids profile at least as strict (`TS/ProfileGate.tsx:214-217`) | DIFF | TV matches the server rule (`R/profiles.js:284-295`). Re-checked. |
| B20 | Household PIN to open a password-less grown-up profile | yes (`WS/profiles.js:187-198`) | yes (`TS/ProfileGate.tsx:158-166`) | SAME | |
| B21 | A kids profile opening a blocked title | toast in the server's words, then back (`dd.js:1133, 1164-1166`, `P.js:290-291`) | title page: failure swallowed, page stays up from the card with live buttons (`D.tsx:877, 1169-1183`); player: generic error with a pointless Retry (`P.tsx:1245-1250`) | DIFF | |
| B22 | Settings rows hidden for a kids profile | yes (`WS/preferences.js:388, 403, 762, 891`) | no: "Sign out on this TV" is shown to a child (`TS/Settings.tsx:345`) | DIFF | |
| B23 | Switch profile | profile menu; hidden when sign-in is required (`W/main.js:564-565`) | rail pill, press twice within 4000 ms (`T/components/NavRail.tsx:333-339`); when sign-in is required it signs out (`App.tsx:239-246`) | MINOR | |
| B24 | "Genres you like" | yes (`WS/preferences.js:315-346`) | yes (`TS/Settings.tsx:106-155`) | SAME | Same endpoint `POST /api/profiles/:id/preferences`. |
| B25 | Look, theme, accent colour | yes, stored on the profile (`W/state.js:80-115`) | no | WEB | By design (one TV look). |
| B26 | Watch-time nudge, welcome back | yes (`W/easter.js:205-218`) | no | WEB | By design. |
| B27 | Taste picker ("pick what you like") | yes (`WS/taste.js`) | no | WEB | |
| B28 | Wrapped (your year) | yes (`WS/wrapped.js`) | no | WEB | |
| B29 | Your own star rating on a title | yes (`W/components.js:23-52`, `WS/details.js:130-133`) | no (no `/rating` in tv-native) | WEB | |

### 1.3 Navigation and Home

| # | Feature | Web | TV | Verdict | Difference |
|---|---|---|---|---|---|
| C1 | Top-level destinations | Search, Home, Movies, Shows, My List, AI, New, Saved, downloads pill, gear, profile (`public/index.html:119-144`) | Search, Home, Movies, Shows, My List, AI, Preferences, profile (`T/navSection.ts:25-41`) | MINOR | What's new and My downloads sit under Settings on TV (`TS/Settings.tsx:228, 234`). The rail says "Preferences", the screen says "Settings". |
| C2 | Deep links | any hash route (`W/main.js:65-112`) | only `aurora://open` from the launcher row (`T/homeScreen.ts:45-46`, `TS/Home.tsx:324-348`) | MINOR | By design. |
| C3 | Home rows and their order | `GET /api/home?profile=` (`W/api.js:88`) | `GET /api/home?slim=1&profile=` (`T/api.ts:868`) | SAME | Server builds every row (`R/api.js:594-650`); `slim` only strips per-item fields. |
| C4 | Reorder or hide Home rows | yes (`WS/preferences.js:212-232`) | no editor; the TV obeys what the website saved | WEB | |
| C5 | Home refresh when the library changes | yes (`WS/home.js:546-594`) | yes, held 2500 ms (`TS/Home.tsx:208-225`) | SAME | |
| C6 | Hero rotation | 9000 ms, 15000 ms hold after a manual move (`WS/home.js:54, 309`) | same constants (`TS/Home.tsx:419-426`) | SAME | |
| C7 | Moving the hero by hand | dots, swipe, both directions (`WS/home.js:182-189, 353-374`) | RIGHT on the last button = next; no previous (`TS/Home.tsx:646-652`) | MINOR | |
| C8 | Hero text | kicker, title, rating, year, episode count, duration, genres, format badges, synopsis, "x in, y left" (`WS/home.js:251-277`) | kicker, title, rating, year, S/E, genres, 2-line synopsis (`TS/Home.tsx:831-838, 943-949`) | MINOR | |
| C9 | Hero buttons | Play or Stream, Details (`WS/home.js:278-293`) | same (`TS/Home.tsx:951-971`) | SAME | |
| C10 | Trailer on the hero | YouTube iframe, id from the item or `/api/discover/meta`; starts after 4000 ms (`W/heroTrailer.js:38-39, 172-183`) | `/api/trailer` (Apple HLS, else YouTube resolved on the box); starts after 4500 ms (`T/trailers.ts:81-115`, `TS/Home.tsx:569-579`) | MINOR | Source differs by design. 25 s muted / 50 s unmuted on both. |
| C11 | Trailer mute/unmute | yes (`W/heroTrailer.js:282-296`) | yes (`TS/Home.tsx:972-979`) | SAME | |
| C12 | At most two hero trailers per visit; none on a weak box | no | yes (`TS/Home.tsx:459-462, 540`) | TV | |
| C13 | Reporting a trailer that failed | no | yes, `POST /api/trailer/report` (`T/trailers.ts:46-57`) | TV | |
| C14 | Greeting and daily line | yes (`WS/home.js:419-455`) | no | WEB | By design. |
| C15 | Live watch parties on Home | every party, Join (`WS/home.js:459-487`) | up to 2 pills (`TS/Home.tsx:981-996`) | MINOR | |
| C16 | Continue Watching card | wide card, "N min left" (`W/components.js:302-358`) | frame card, "N min left" (`T/components/Card.tsx:154-157, 401`) | SAME | |
| C17 | Remove from Continue Watching | X or peek; toast with Undo; card restored on failure (`W/components.js:306-356`) | peek only; no toast, no Undo, failure swallowed (`TS/Home.tsx:724-744`) | DIFF | Same two endpoints. |
| C18 | "Because you loved X" rows | yes, reason as a tooltip (`W/components.js:156`) | yes, reason not shown | SAME | |
| C19 | New Episodes card label ("S2 E5, 3 new") | yes (`W/components.js:104-118`) | no label (`T/components/Card.tsx:265`) | DIFF | The row is a bare poster on TV. |
| C20 | NEW tag (7 days, not started) | yes (`W/components.js:73, 89`) | yes (`T/components/Card.tsx:31, 283-284`) | SAME | |
| C21 | Peek sheet (hold a card) | 480 ms hold or right-click; Play/Resume only when playable (`W/peek.js:15, 65-131`) | long-press OK; always a primary Play or Open; "N% watched" line (`Ov.tsx:152-199`) | MINOR | |

### 1.4 Movies / Shows, Search, My List, AI, other pages

| # | Feature | Web | TV | Verdict | Difference |
|---|---|---|---|---|---|
| D1 | Categories: All, Trending, New, Top rated, For you, Downloaded | yes (`WS/browse.js:214-221`) | yes (`TS/Browse.tsx:93-100`) | SAME | Default All on both. No sort option on either. |
| D2 | Genre picker | yes (`WS/browse.js:505-516`) | yes (`TS/Browse.tsx:200`) | SAME | |
| D3 | Unwatched toggle | yes (`WS/browse.js:517-524`) | yes (`TS/Browse.tsx:440-449`) | SAME | |
| D4 | "For you" | asks the catalogue for a different liked genre per page (`WS/browse.js:449-455`) | asks for plain trending and floats liked genres to the front (`TS/Browse.tsx:302-305, 453-458`) | DIFF | Different titles. Re-checked. |
| D5 | Paging | "Load more" button (`WS/browse.js:429-441`) | automatic, retries at 3/8/20 s (`TS/Browse.tsx:75-80, 584-591`) | MINOR | By design. |
| D6 | Count line and empty wording | yes (`WS/browse.js:391-423`) | same strings (`TS/Browse.tsx:621-630, 689-695`) | SAME | |
| D7 | Search box inside Movies / Shows | yes (`WS/browse.js:547-587`) | no, removed on purpose (`TS/Browse.tsx:11-13`) | WEB | By design. |
| D8 | Surprise me | prefers titles you have not started; toast "The dice say"; Roll again (`W/surprise.js:26-52`, `dd.js:1380-1385`) | uniform random; silent; no Roll again (`TS/Browse.tsx:481-494`) | DIFF | |
| D9 | Searching the library | server search: exact, prefix, all-words, fuzzy, episode titles (`WS/search.js:221`, `R/api.js:529-584`) | local substring over titles from `/api/library` (`TS/Search.tsx:94-97`) | DIFF | TV never calls `/api/search`. Re-checked. |
| D10 | Searching the catalogue | `/api/discover/search`, 3+ characters while typing, 180 ms (`WS/search.js:59, 208-214, 304`) | same endpoint, any length, 350 ms (`TS/Search.tsx:101-112`) | MINOR | |
| D11 | Search suggestions | yes (`W/suggest.js:34-56`) | no | WEB | |
| D12 | Recent searches | yes, 8 per profile (`WS/search.js:34-54`) | no | WEB | |
| D13 | "Popular in this house" on an empty search | yes, `/api/popular` (`WS/search.js:120-136`) | no | WEB | |
| D14 | Search states | three "no results" variants, error + Try again (`WS/search.js:164-187, 289-293`) | "No matches yet…" for searching, failed and empty (`TS/Search.tsx:111, 180-182`) | DIFF | |
| D15 | My List page: source and default order | yes (`WS/browse.js:716-733`) | yes (`TS/MyList.tsx:133-135`) | SAME | |
| D16 | My List sorts | 8 (`WS/browse.js:36-45`) | 7, without "Files on this device" (`TS/MyList.tsx:44-52`) | MINOR | By design. |
| D17 | My List filter chips and genre | yes (`WS/browse.js:49-57`) | identical (`TS/MyList.tsx:57-65`) | SAME | |
| D18 | Add / remove toast | add: "Title saved for later" (+ what is downloading) (`W/ui.js:467-473`); remove: "Off the list. Bold." (`W/peek.js:101`); no revert on failure (`dd.js:101`) | title page: a toast only when a download started; peek: "Added to My List" / "Removed from My List"; reverts on failure (`D.tsx:1189-1218`, `Ov.tsx:136-158`) | DIFF | The TV's download wording is merged, not released (section E). |
| D19 | AI tab shown | only when `/api/ai/status` says enabled (`W/main.js:761-766`) | always; an amber notice when off (`TS/Pick.tsx:169-174, 336-341`) | DIFF | |
| D20 | AI controls: Movies/Shows, era, length | yes (`WS/pickforme.js:30-60`) | identical (`TS/Pick.tsx:47-69`) | SAME | |
| D21 | AI wait lines, status line, 3-300 characters | yes (`WS/pickforme.js:65-72, 96, 239-247`) | same (`TS/Pick.tsx:77-82, 230, 250-254`) | SAME | |
| D22 | AI "Try again" (a fresh list) | no | yes, sends `fresh: true` (`TS/Pick.tsx:469-478`, `R/ai.js:38-40`) | TV | |
| D23 | AI result cards | card + reason (`WS/pickforme.js:203-209`) | card + reason + owned/stream mark (`TS/Pick.tsx:283-303`) | MINOR | |
| D24 | AI controls fold after an answer | no | yes (`TS/Pick.tsx:343-368`) | TV | |
| D25 | Discover page (`#/requests`) | deep link only (`W/main.js:81`) | no | WEB | Legacy. |
| D26 | Screensaver | idle 3 min (`W/screensaver.js:11-16`) | no (system screensaver) | WEB | By design. |
| D27 | Narrator jokes, easter eggs | yes (`W/easter.js`, `W/narrator.js`) | no | WEB | By design. |
| D28 | Live TV | no | no | NONE | No "iptv" or "live tv" anywhere. |

### 1.5 Title page

| # | Feature | Web | TV | Verdict | Difference |
|---|---|---|---|---|---|
| E1 | One page for library and catalogue titles | yes (`dd.js:1-12, 1128-1181`) | yes (`D.tsx:1-6, 861-918`) | SAME | |
| E2 | Finding your copy of a catalogue title | by IMDb id, then title with year within 1 (`dd.js:2949-2979`) | card's `inLibrary`, then title; a fuzzy match needs both years (`D.tsx:175-198, 891-918`) | MINOR | |
| E3 | Play a film you hold | yes (`dd.js:1278-1282`) | yes (`D.tsx:2586-2601`) | SAME | |
| E4 | Resume a film | position > 10 s and not finished; "Resume 12:34" (`dd.js:1237, 1259-1277`) | same rule and label (`D.tsx:1317-1318, 2592-2593`) | SAME | |
| E5 | Start over (film) | yes, `?restart=1` (`dd.js:1284-1291`) | no button: `playFromStart` is defined and never used (`D.tsx:1306-1309`) | WEB | Re-checked. CHANGELOG lists it for TV 5.1.4. |
| E6 | Which episode Play picks on a show | most recently touched owned episode; if finished, the next owned one (`dd.js:1219-1234`) | first owned episode in list order that has progress, else first unwatched, else S1E1 (`D.tsx:2057-2090`) | DIFF | With two half-watched episodes: web the latest, TV the earliest. |
| E7 | Show Play label | "Continue S E, clock" when position > 10 s (`dd.js:1294-1308`) | "Continue S E" when the rounded percent is non-zero; no clock (`D.tsx:1649-1652, 2062, 2446-2452`) | DIFF | 10 s vs about 0.5% of the runtime. |
| E8 | Show with nothing on disk | no Play; "Choose episode" scrolls to the list (`dd.js:1293, 1366-1375`) | Play saves the best source for S1E1; hold opens sources (`D.tsx:2442-2455`) | DIFF | |
| E9 | Film you do not hold: main button | "Save & watch" saves the Best source, then a sheet with "Stream it meanwhile" (`dd.js:1343-1363, 588-643`) | "Play" saves the best source; hold opens the list; toasts only (`D.tsx:1933-1998, 2601-2602`) | MINOR | Same action, different label. |
| E10 | Stream now without saving | "Stream instead" button (`dd.js:1366-1375`) | only via hold Play, then Stream on a row (`TS/Sources.tsx:563-573`) | MINOR | By the 5.1.15 design. |
| E11 | Download progress on the page | button text "Downloading, N%" etc. (`dd.js:1327-1342`) | button + status line with speed, "Ready, press Play", failure reasons (`D.tsx:540-605, 2167-2189`) | MINOR | TV shows more. |
| E12 | Live download state on the page | socket `download_update` only (`dd.js:927-945`) | socket + `download_removed` + 10 s re-read + 4 s poll when the socket is shut (`D.tsx:1532-1621`) | DIFF | TV is right. |
| E13 | Mark a film watched | yes, also for a film you do not hold (`dd.js:1656-1696`) | only when on disk (`D.tsx:1319-1337, 2571-2573`) | DIFF | |
| E14 | Follow a show | yes; hidden when torrents are off (`dd.js:1394-1421`) | yes; same endpoint and toasts; not gated (`D.tsx:1225-1260, 2422-2424`) | SAME | |
| E15 | Trailer button and its gate | when `meta.trailers` has ids (`dd.js:1377-1379`) | same condition (`D.tsx:2425-2427, 2562-2564`) | SAME | |
| E16 | Trailer playback | YouTube iframe; "Trailer 1..N" pills (`dd.js:2860-2888`) | `/api/trailer`: Apple HLS, else YouTube resolved on the box, automatic fallback; "Open in YouTube" (`T/trailers.ts:81-115`, `Ov.tsx:724-815`) | MINOR | By design. |
| E17 | More like this | `/api/discover/similar` (the vibe ranker) (`dd.js:1851-1875`) | `/api/catalog` by the title's genres, max 18 (`D.tsx:1345-1412`) | DIFF | Different rows for the same title. Re-checked. |
| E18 | Collection / director / creator / network shelves | yes (`dd.js:1813-1850`) | no | WEB | |
| E19 | X-Ray on the title page | full panel: episode stepper, filmmakers, cast, rating tiles incl. the household's, facts, person links (`W/xray.js:103-225`) | one sheet: a facts line, six crew as text, 18 cast; no stepper, links or retry (`Ov.tsx:580-679`) | DIFF | TV never sends `keys`, so no household rating (`T/api.ts:1034-1042`). |
| E20 | Facts line and badges | season's year, rating from library or metadata, runtime, file size, director, next-episode date, up to 6 format badges, all genres, expandable synopsis, full cast (`dd.js:1701-1765`, `WS/details.js:105-201`) | title's year, card rating only, runtime, 2 badges, 4 genres (films only), fixed synopsis, 4 cast (`D.tsx:297-312, 2404-2414, 2537-2555`) | MINOR | |
| E21 | Season switcher | pills, dropdown above 8 (`dd.js:2409-2466`) | pills (`D.tsx:2462-2484`) | SAME | |
| E22 | Which season opens | remembered per show, else the season of your next episode (`dd.js:1984-1991, 2401-2403`) | always the first season (`D.tsx:873, 908, 1180`) | DIFF | |
| E23 | Episode card | still, number, runtime, title, air date, overview, watched, downloaded, up next (`dd.js:2253-2314`) | same set (`D.tsx:688-781`) | SAME | Air-date rules ported (`D.tsx:608-648`). |
| E24 | Unaired episode | disabled (`dd.js:2243-2244`) | focusable; press toasts "Not aired yet"; long-press still offers Sources and Mark watched (`D.tsx:1839-1843, 2005-2017`) | DIFF | |
| E25 | Progress timeline, up-next marker | yes (`dd.js:2201-2204, 2317-2325`) | same (`D.tsx:731-743, 1701-1704`) | SAME | |
| E26 | Press an episode you hold | plays only at 1080p or better; otherwise opens sources (`dd.js:2225, 2246-2250`) | always plays (`D.tsx:1668-1669`) | DIFF | |
| E27 | Press an episode you do not hold | opens the sources list, top 3 (`dd.js:2250`) | saves the best source at once (`D.tsx:1670, 1835-1926`) | DIFF | |
| E28 | Hold an episode | opens its sources (`dd.js:2328`) | actions sheet: Sources / Mark watched / Play (`D.tsx:1999-2023`) | MINOR | |
| E29 | Mark an episode watched | tick on the card (`dd.js:2354-2363`) | long-press menu, with a toast (`D.tsx:2006-2017`) | MINOR | |
| E30 | Mark a season watched | pill; one request per episode; toast with Undo (`dd.js:2494-2568`) | pill; one batched request; restore snapshot on unmark; no Undo (`D.tsx:2029-2051`) | DIFF | Each side has half. |
| E31 | Open straight on an episode (`?s=&e=`) | yes (`dd.js:2610-2623`) | no | WEB | |
| E32 | Extras (bonus files) | yes (`dd.js:2674-2694`) | no | WEB | |
| E33 | Sources list: endpoint | `GET /api/torrents/sources` (`W/api.js:100-106`) | same (`T/api.ts:998-1013`) | SAME | |
| E34 | Sources: order and "Last played" | last-played floated and badged (`dd.js:497-508, 843-867`) | no last-played (`TS/Sources.tsx:345-363`) | DIFF | |
| E35 | Sources: how many, quality filter | episode 3, film 5 or 8, then "Show all"; quality pills (`dd.js:712-749, 881-920`) | all rows, no filter (`TS/Sources.tsx:717-728`) | DIFF | The top-3 rule is not on TV. |
| E36 | Source badges | Best, Last played, Cam, Pack (`dd.js:386-389`) | Best, Cam, Dub; "Stream" still carries a warning glyph (`TS/Sources.tsx:532-534, 563-573`) | MINOR | |
| E37 | Save button states | Save / Waiting / Queued / Starting / N% / Saved / Retry, "trying a second source" (`dd.js:141-218`) | Save + ring; no starting or second-source state (`TS/Sources.tsx:50-102`) | DIFF | |
| E38 | Starting a download | `POST /api/downloads`, with `poster` (`dd.js:651-667`) | same fields without `poster` (`TS/Sources.tsx:416-431`, `D.tsx:1879-1894`) | MINOR | |
| E39 | Sources empty and error states | four messages, Try again (`dd.js:820-839, 956-973`) | two messages, no retry (`TS/Sources.tsx:250, 709-712`) | MINOR | |
| E40 | "Yours" row | Play, Download, Offline (`dd.js:754-789`) | Play (`TS/Sources.tsx:674-701`) | SAME | |
| E41 | Download the file to this device | yes (`W/downloadPicker.js`, `dd.js:1643-1652`) | no | WEB | By design. |
| E42 | Save offline inside the app | yes (`W/offlinePicker.js`, `dd.js:2717-2854`) | no | WEB | By design. |
| E43 | Server has torrents switched off | hides Save, Stream, Follow, sources (`dd.js:1186-1187, 1343, 1394`) | not checked; buttons stay and the request is refused | DIFF | |
| E44 | Title not found / no connection | message, then back (`dd.js:1165, 1176-1180`) | none; page stays on the card's data | DIFF | |
| E45 | Cancel a download from the title page | no | no | NONE | Only on the downloads page, both sides. |
| E46 | Report a problem / request a title from the title page | no | no | NONE | No client calls `/api/requests` (list D). |

### 1.6 Playback

| # | Feature | Web | TV | Verdict | Difference |
|---|---|---|---|---|---|
| F1 | Direct play | yes (`P.js:535-539`) | yes (`P.tsx:1374, 1396`) | SAME | |
| F2 | Deciding direct vs repackage for a library file | the browser decides from codec and container (`P.js:116-182`) | server flag for audio only; an undecodable picture is found by failing: direct, then copy, then h264 (`P.tsx:1376-1394, 2659-2667`) | DIFF | |
| F3 | Deciding the path for a torrent | release tags, then a real probe `/api/torrents/probe` (`P.js:344-359, 1831-1898`) | release tags only: H.265/AV1 always re-encoded to h264 (`TS/Sources.tsx:30-31, 378-395`) | DIFF | |
| F4 | One stream for the whole film when repackaging (jit) | yes (`P.js:1444-1509`) | no (no `jit/` in tv-native); a far seek restarts the encode (`P.tsx:1785-1832`) | WEB | |
| F5 | Quality menu: Original / 720p / 480p / Auto | yes (`P.js:3126-3157`, ladder `P.js:1021-1041`) | no | WEB | |
| F6 | Automatic quality as the line changes | yes (`P.js:4486-4597`) | no | WEB | |
| F7 | "Still loading" card with Lower quality (480p) | no | yes, at 25 s and 90 s (`P.tsx:208-210, 2217-2264, 3503-3535`) | TV | The TV's only quality control. |
| F8 | Connection probe and Data saver | yes, `/api/netprobe`, `aurora-data-mode` (`W/net.js:30-45, 196`) | no | WEB | |
| F9 | Audio track menu, default track, dub memory | yes (`P.js:1064-1076, 3106-3123`) | yes (`P.tsx:1343-1355, 3316-3336`) | SAME | Same rule in `W/lang.js:227-236` and `T/lang.ts:141-150`. |
| F10 | Switching audio track | keeps the stream's codec (`P.js:1191-1220`) | always restarts as `copy` (`P.tsx:1119`) | DIFF | |
| F11 | Mute | yes, remembered (`P.js:2094-2106`) | yes, not remembered (`P.tsx:668-669, 3032-3054`) | MINOR | Volume slider is web only, by design. |
| F12 | Subtitle sources | file tracks, online lookup, auto-fetch, live "being written" (OCR) tracks (`P.js:5205-5279`) | file tracks, online lookup, auto-fetch, files inside the torrent (`P.tsx:1202-1238, 1308, 1464-1482`) | DIFF | OCR notice web only; in-torrent files TV only. |
| F13 | Which subtitle turns on by itself | your last pick, then the setting, then the language, then the first track (`P.js:2708-2743`) | same, but with language "any" it tries Hebrew before the first track (`P.tsx:475-542`) | DIFF | |
| F14 | Subtitle languages offered | any / he / en / ru; auto-fetch he/en/ru (`P.js:2702-2707, 5233-5252`) | any / he / en; auto-fetch he/en (`T/storage.ts:109`, `T/api.ts:1120`) | DIFF | No Russian on TV. |
| F15 | Remembering the subtitle pick on the profile | yes (`P.js:2994-2995`) | yes (`P.tsx:1654-1677`) | SAME | |
| F16 | Subtitle size S/M/L and background | yes (`P.js:85, 225-227`) | yes (`P.tsx:146, 4011`) | SAME | |
| F17 | Subtitle timing: -5 / -0.5 / +0.5 / +5 / Reset | yes (`P.js:3021-3073`) | yes (`P.tsx:1720-1730, 3233-3281`) | SAME | Not saved on either. |
| F18 | A subtitle file that is empty or fails | silent reload (`P.js:2754-2766`) | says so (`P.tsx:1704-1709`) | MINOR | TV is better. |
| F19 | Skip intro (hand-marked, and detected for library files) | yes (`P.js:4176-4245`) | yes (`P.tsx:1419-1443, 2477-2482`) | SAME | |
| F20 | Skip recap | yes (`P.js:4238-4285`) | no (no "recap" in tv-native) | WEB | |
| F21 | Intro / recap / credits for a streamed episode | yes, `/api/segments` (`P.js:4228-4233`) | no | WEB | |
| F22 | Marking an intro by hand; ignoring a detected one | no: the code has no caller (`P.js:4187-4198, 4249-4275`) | yes, gear menu (`P.tsx:3349-3409`) | TV | The web removed it on purpose (`CHANGELOG.md:430`). |
| F23 | Up next: when it appears | at the credits, else the last 30-90 s; retracts on a seek back (`P.js:4334-4354`) | same window; never retracts (`P.tsx:2485-2489`) | MINOR | 15 s countdown on both. |
| F24 | Which episode is "next" | the real next episode; one you do not hold is offered as "Choose episode" (`P.js:3907-3976`) | the next file on disk (`P.tsx:2303-2306, 2340-2343`) | DIFF | TV can jump E4 to E8. |
| F25 | Up next for a streamed episode | yes (`P.js:3946-3974`) | no (`P.tsx:2300, 2486`) | WEB | |
| F26 | Next episode button | yes (`P.js:4127-4138`) | yes (`P.tsx:2330-2349, 3014-3021`) | SAME | |
| F27 | Autoplay next episode switch | yes, default on (`P.js:3159-3168`) | yes, default on (`P.tsx:3337-3347`) | SAME | |
| F28 | "Still watching?" after 3 hands-off episodes | yes (`P.js:87-110, 4001-4034`) | no | WEB | Re-checked by grep. |
| F29 | When a title resumes | position > 10 s and more than 20 s from the end (`P.js:1526-1536`) | same (`P.tsx:1189-1196`) | SAME | |
| F30 | Where it resumes | 4 s before where you stopped (`P.js:1533-1535`) | exactly where you stopped (`P.tsx:1195`) | DIFF | Re-checked. |
| F31 | Resume across sources of the same title | yes (`W/state.js:309-315`) | no | WEB | |
| F32 | Resume notice | pill "Resumed at 12:34, Start over", 4 s (`P.js:3813-3844`) | card with the frame, Start over, 4 s (`P.tsx:1403-1405, 3145-3170`) | MINOR | |
| F33 | Progress saving | every 5 s, on exit (`P.js:5018-5019`) | every 5 s if moved 4 s, on exit (`P.tsx:2132-2142`) | SAME | Finished at 95% is the server's rule (`src/profiles.js:773`). |
| F34 | Refusing to save when history could not be read | no | yes (`P.tsx:1148-1163`) | TV | |
| F35 | Playback marks for the admin | yes (`P.js:401-413`), plus torrent marks (`P.js:385-394`) | yes, a different set, no torrent marks (`P.tsx:2055-2065`) | MINOR | |
| F36 | "Watching" report for the admin's live view | every 5 s (`P.js:5022-5033`) | every 5 s (`P.tsx:2116-2130`) | SAME | |
| F37 | Skip steps on repeated presses | 10,10,10,30,60,60,120,180 (`P.js:59`) | 10,10,10,30,60,60,120,300 (`P.tsx:128`) | DIFF | Re-checked. The TV comment says "ported verbatim". |
| F38 | Dragging the timeline, hover time, double-tap | yes (`P.js:3539-3637, 4998-5009`) | no | WEB | By design. |
| F39 | Recovery from a stream error | 4 rebuilds per 30 s, then a card (`P.js:910-944`) | 4 per 30 s, then h264, then a screen (`P.tsx:2581-2635`) | MINOR | |
| F40 | Recovery from a silent stall | nudge at 6 s, rebuild at 20 s, card at 45 s (`P.js:4704-4711`) | repackaged streams only: reissue after 25 s; direct play: nothing (`P.tsx:2273-2294`) | DIFF | |
| F41 | Frozen picture with data buffered | 3 s, then copy if possible, else h264 (`P.js:1755-1772`) | 6 s, always h264 (`P.tsx:2190-2206`) | DIFF | |
| F42 | Final error screen | "Playback stopped" + Try again / Back (`P.js:4633-4655`) | message + Back only (`P.tsx:2646-2666`) | DIFF | |
| F43 | Title failed to load | silent return to Home (`P.js:289-293`) | says why, Retry / Back (`P.tsx:1245-1250, 2702-2724`) | DIFF | TV is right. |
| F44 | Opening a stream for a title you now hold | plays your copy instead (`P.js:308-326`) | plays the stream | WEB | |
| F45 | Playback speed | 0.5 to 2 (`P.js:17`) | same list (`P.tsx:127`) | SAME | |
| F46 | Picture in picture | yes (`P.js:2033-2060`) | no | WEB | By design. |
| F47 | Fullscreen, AirPlay | yes (`P.js:2066-2091, 2618-2676`) | n/a | WEB | By design. |
| F48 | Lock-screen / media-key controls (Media Session) | yes (`P.js:4893-4941`) | no | WEB | Unclear whether a TV needs it. |
| F49 | Keyboard shortcuts and the "?" overlay | yes (`P.js:5064-5153`, `WS/shortcuts.js:5-15`) | n/a | WEB | By design. |
| F50 | Remote keys: play/pause, fast-forward, rewind, Back ladder | n/a | yes (`P.tsx:1940-2018`) | TV | By design. |
| F51 | X-Ray in the player | full panel; keeps playing in a party (`P.js:1986-2022`) | compact sheet; always pauses, also in a party (`P.tsx:3083-3102`) | DIFF | |
| F52 | Watch party: start and join | yes (`P.js:3642-3803`, `W/party.js`) | yes (`P.tsx:3434-3468`, `T/party.ts`) | SAME | Same messages and tolerances. |
| F53 | Host leaving a party with guests | needs a second Back within 6 s (`P.js:5285-5289`) | leaves at once (`P.tsx:1591-1596`) | DIFF | |
| F54 | Party guest at the end of an episode | no countdown; "Following the host" (`P.js:3996, 4104-4107`) | countdown runs and does nothing (`P.tsx:2309, 2381-2382`) | DIFF | See X6. |
| F55 | Report a problem from the player | yes (`P.js:3196-3197`) | no | WEB | |
| F56 | HDR | no client logic; the server tone-maps what it encodes (`src/media/ladder.js:331-333`) | no client logic; direct play is left to the TV | SAME | Result on a real HDR set: undetermined. |
| F57 | Playing a copy saved on this device | yes (`P.js:263-282`) | no | WEB | By design. |

### 1.7 Downloads and notifications

| # | Feature | Web | TV | Verdict | Difference |
|---|---|---|---|---|---|
| G1 | "My downloads" page | yes, nav pill and profile menu (`WS/downloads.js:306`, `W/main.js:82, 567`) | yes, under Settings (`TS/Downloads.tsx:71`, `TS/Settings.tsx:231`) | SAME | Same `GET /api/downloads?profile=`. |
| G2 | Sections and state wording | Downloading now / Waiting / Ready to play / Didn't make it / Also on the server; "Starting", peer count, the admin's name (`WS/downloads.js:61-95, 368-375`) | Ready to play / On its way / Waiting for approval / Didn't make it / Also on the server; "0%", "the admin" (`TS/Downloads.tsx:44-68, 216-220`) | DIFF | TV lists a finished-but-not-indexed row under Ready, where a press does nothing (`:47, 128, 164`). |
| G3 | Cancel a download | confirm sheet once past 5% (`WS/downloads.js:172-203`) | one press, no confirm (`TS/Downloads.tsx:138-164`) | DIFF | |
| G4 | Remove a failed / declined / cancelled row | "Remove" calls `/dismiss` (`WS/downloads.js:215-231`) | "Remove" only on failed rows, and it calls `/cancel`, so the row stays as "Canceled" (`TS/Downloads.tsx:150, 164`; no dismiss in `T/api.ts:1134-1139`) | DIFF | Bug X3. Re-checked. |
| G5 | Try again on a failed download | yes (`WS/downloads.js:109-137, 206-213`) | no | WEB | |
| G6 | Open the title page from a row | yes (`WS/downloads.js:157-167`) | no | WEB | |
| G7 | Keeping the list fresh | socket only; not refetched after a reconnect (`WS/downloads.js:383, 402`, `W/main.js:291-302`) | socket + refetch on reconnect + 15 s poll while the socket is shut (`TS/Downloads.tsx:90-112`) | DIFF | TV is right. |
| G8 | Download pill in the nav, app-icon badge | yes (`W/main.js:244-328`) | no | WEB | |
| G9 | Next-episode downloads (server, 65% through an episode) | fired by progress saves; quiet toast "Next episode downloading"; AUTO tag (`W/main.js:345-348`, `WS/downloads.js:255-260`) | fired by the same saves; no toast; row prefix "Next episode, queued for you" (`TS/Downloads.tsx:178`) | MINOR | Server: `src/media/smartdl.js`. |
| G10 | Switches: "Get the next episode ready", "Tidy up after watching" | yes, on the profile (`WS/preferences.js:799-827`) | no | WEB | A TV-only household cannot turn them off. |
| G11 | My List downloads shown | toast on add; MY LIST tag (`W/ui.js:467-473`, `WS/downloads.js:255-260`) | released 5.1.31: plain toast, and the row says "Next episode, queued for you" even for a film | DIFF | Fixed in source, unreleased (section E). |
| G12 | In-app "ready" toast | "X is ready to watch" + Play; never for automatic downloads (`W/main.js:355-365`) | "X is ready to play, Settings, My downloads"; for every finished download of yours, automatic ones too; can repeat (`T/SessionWiring.tsx:52-57`) | DIFF | |
| G13 | Notification when the app is closed | Web Push, at once (`W/push.js:44-56`, `public/sw.js:210-231`, `src/media/downloads.js:1552-1560`) | Android notification "X is ready to watch"; a background check every 3 h (`K/DownloadNotices.kt:188-219`, `K/HomeScreenRows.kt:55, 380`) | MINOR | Up to 3 h late on a closed TV app. |
| G14 | Notification switch | "Tell me when it's ready", default off (`WS/preferences.js:765-797`) | "Tell me when a download lands", default on (`TS/Settings.tsx:298-317`, `T/storage.ts:162`) | MINOR | Browser needs a permission tap. |
| G15 | A followed show's new episode arriving | push only; no toast, no pill (the job is marked automatic, `src/media/follows.js:74`) | toast + notification + "New:" row | DIFF | Nothing at all on the web when push is off. |
| G16 | Aurora row on the Android TV home screen: resume, "New: Show S E", picks | no | yes (`T/homeScreen.ts:31-33, 107-131, 246`, `K/HomeScreenRows.kt:59-60, 519`) | TV | By design. |
| G17 | Watch Next row on the Android TV home screen | no | yes (`T/homeScreen.ts:172-194`) | TV | By design. |

### 1.8 Settings: every setting on each side

| # | Setting (web wording / TV wording) | Options | Web default and key | TV default and key | On the server profile? | Verdict |
|---|---|---|---|---|---|---|
| H1 | Trailers on the home page / Trailers on the home billboard | On, Off | on, off on a small touch screen; `aurora-player.heroTrailers` (`WS/preferences.js:694, 707-708`) | on, forced off on a weak box; `aurora.prefs.heroTrailers` (`T/storage.ts:160`, `TS/Settings.tsx:265-266`) | neither | SAME |
| H2 | Play the next episode / Autoplay next episode | On, Off | on; `aurora-player.autoplayNext` (`WS/preferences.js:700`) | on; `aurora.prefs.autoplayNext` (`T/storage.ts:151`) | neither | SAME |
| H3 | Subtitles on by themselves / Turn subtitles on automatically | On, Off | on; `aurora-player.subsDefault` | on; `aurora.prefs.subsDefault` | neither | SAME |
| H4 | Subtitle language / Preferred subtitle language | web: any, he, en, ru; TV: any, he, en | any; `aurora-player.subLang` and profile `prefs.subLang` (`WS/preferences.js:715-735`, `W/state.js:156-164`) | any; `aurora.prefs.subLang` only (`TS/Settings.tsx:282`, `T/storage.ts:109, 153`) | web only | DIFF |
| H5 | Subtitle size | S, M, L | M; `aurora-player.cueSize` | M; `aurora.prefs.cueSize` | neither | SAME |
| H6 | Dark box behind subtitles / Subtitle background | On, Off | on; `aurora-player.cueBackground` | on; `aurora.prefs.cueBackground` | neither | SAME |
| H7 | Help improve Aurora / Usage stats | On, Off | on; profile `prefs.usageStats` (`WS/preferences.js:860-886`, `W/usage.js:21-22`) | on; `aurora.prefs.usageStats`, this box only (`TS/Settings.tsx:322-325`, `T/storage.ts:161`) | web only | DIFF |
| H8 | Tell me when it's ready / Tell me when a download lands | On, Off | off; `aurora-notify-ready`, `aurora-push` | on; `aurora.prefs.downloadNotices` | no | counted as G14 |
| H9 | Genres you like / What you like | chips | none; server | none; server | both | counted as B24 |
| H10 | Get the next episode ready; Tidy up after watching | On, Off | on; profile `prefs.smartDownloads`, `prefs.smartCleanup` | absent | web only | counted as G10 |
| H11 | Internet use | Automatic, Data saver, Full quality | auto; `aurora-data-mode` (`W/net.js:30`) | absent | no | counted as F8 |
| H12 | Size of saved copies; Saved on this device | ask, original, 1080, 720, 480 | ask; `aurora-offline-quality` (`W/offline.js:68`) | absent | no | WEB |
| H13 | Look, theme, accent; Home rows | see B25, C4 | profile | absent | web only | counted as B25, C4 |
| H14 | Aurora TV version, Check / Update | | absent | `TS/Settings.tsx:331-342` | | TV |
| H15 | Last subtitle pick, last audio language (remembered, no switch) | | profile `prefs.subPick`, `prefs.audioLang` | same profile fields | both | counted as F9, F15 |

Neither side has: an interface-language setting, an auto-skip-intro setting, a server-address setting, a diagnostics screen. Session and identity keys: web keeps the session in an HttpOnly cookie `aurora_session`, the profile in `localStorage aurora-profile`, the unlock token in `sessionStorage aurora-token-<id>` (`W/state.js:167-173`); the TV keeps `aurora.session`, `aurora.profileId`, `aurora.token` in AsyncStorage (`T/storage.ts:9-13`) and sends `X-Session`, `X-Profile`, `X-Profile-Token` (`T/api.ts:581-583`).

### 1.9 What's new, reports, usage, realtime, updates, offline, accessibility

| # | Feature | Web | TV | Verdict | Difference |
|---|---|---|---|---|---|
| I1 | "New in Aurora" cards | 15 hand-written cards (`WS/whatsnew.js:18-125`) | 9 hand-written cards (`TS/WhatsNew.tsx:20-83`) | MINOR | Written per client; no shared source. |
| I2 | The raw changelog | latest + "Show older", bold rendered (`WS/preferences.js:621-664`) | first 8 releases, raw text with the `**` marks showing (`TS/WhatsNew.tsx:147-164`) | DIFF | Same unfiltered `/api/changelog`: the TV lists website-only entries. |
| I3 | "Something new" dot | follows the server version (`W/main.js:451-461`) | follows the app version (`T/navSection.ts:42-65`) | MINOR | |
| I4 | Report a problem | text + "What were you doing?"; sends route, network, playback marks, last errors (`W/report.js:40-73`); from the profile menu, the player, What's new | text only; no network, no playback marks, `online` always true (`Ov.tsx:217-254`); from Settings and What's new | DIFF | Same `POST /api/reports`. |
| I5 | Usage stats: batching | every 20 s, 25 events (`W/usage.js:17-18`) | same (`T/usage.ts:16-17`) | SAME | Event names differ in places (`xray_player` vs `xray_tv`). |
| I6 | Usage stats: page timing (`route`) | time until the page is painted (`W/router.js:72`) | time spent on the previous screen (`T/navigation.tsx:80-87`) | DIFF | Bug X5. |
| I7 | Frame-rate and memory reports | no | yes (`T/perfTier.ts:147-149`) | TV | |
| I8 | Admin broadcast and server notices | toast (`W/ws.js:39`, `W/main.js:329`) | toast (`T/SessionWiring.tsx:50-51`) | SAME | |
| I9 | "Writing subtitles for X" notices | yes (`W/ws.js:30-34`) | no | WEB | |
| I10 | Library changed: reload | yes (`W/ws.js:35-38`) | yes (`T/realtime.ts:99`) | SAME | |
| I11 | Socket reconnect | 1 s doubling to 30 s; banner "Can't reach the Aurora server" after 2 failures (`W/ws.js:64-126`) | same backoff; no banner (`T/realtime.ts:86-108`) | MINOR | |
| I12 | Getting a new version | new code on the next page load; the service worker re-caches when `/sw-manifest.json` moves (`public/sw.js:31-44`) | self-update: `/tv-version.json`, "Update now / Later", quiet install, "Restart now / Later" (`T/update.ts:24-198`, `Ov.tsx:315-489`, `K/UpdaterModule.kt`) | TV | By design. |
| I13 | A request that hangs | no time limit; a GET is retried twice (`W/api.js:15-31`) | gives up after 45 s with no answer or 30 s of silence; no retry (`T/api.ts:520-533`) | DIFF | |
| I14 | Works offline: app shell, cached answers, saved copies, queued progress | yes (`public/sw.js:20-24, 127-136`, `W/offline.js:301-318`) | no | WEB | By design. |
| I15 | Slow-line mode: lighter pictures, notice | yes (`W/net.js:36-45`, `W/main.js:193-196`) | no | WEB | |
| I16 | D-pad / keyboard focus | yes (`W/focus.js:160-251`) | native focus engine (`T/components/Focusable.tsx`) | SAME | |
| I17 | Screen-reader labels | about 69 labels, roles, live regions (`WS/login.js:57`, `WS/search.js:74`) | 8 labels, no roles or live regions (e.g. `T/components/NavRail.tsx:532, 574`) | DIFF | |
| I18 | Reduced motion | honoured (e.g. `W/heroTrailer.js:66`) | not read anywhere | WEB | |
| I19 | Admin | `public/admin.html` | none (no `api/admin` in tv-native) | WEB | By design; not enumerated. |

## A. The website has it, the TV does not

Most important first. Row numbers point into the matrix. Effort: S = hours, M = a day or two, L = more.

| # | What is missing on the TV | Rows | Gap or by design | Recommendation | Effort |
|---|---|---|---|---|---|
| A-1 | Any quality control: Quality menu, Auto, the 720p/480p ladder, Data saver. On a slow line the TV has only the "Still loading" card. | F5, F6, F8 | Real gap | Port a simple Quality menu on the existing capped encodes first; Auto later | M, then L |
| A-2 | Reaction to an admin kick or ban. A kicked TV reconnects after 1 s and carries on. | A17, A18 | Real gap | Port: `kicked` to the profile picker with a toast, `banned` to a blocking screen | S |
| A-3 | Skip recap, and intro/recap/credits for streamed episodes (`/api/segments`) | F20, F21 | Real gap | Port | S |
| A-4 | "Still watching?" after three hands-off episodes | F28 | Real gap | Port | S |
| A-5 | Start over on a film you are part-way through | E5 | Real gap; the function is there, the button is not | Port | S |
| A-6 | Up next for streamed episodes | F25 | Real gap | Port together with C-2 | M |
| A-7 | Forced password reset prompt | A16 | Real gap (and half-missing on the web, bug X2) | Fix the server answer, prompt on both | M |
| A-8 | Switches for next-episode downloads and tidy-up | G10 | Real gap: a TV-only home cannot turn them off | Port (the profile fields exist) | S |
| A-9 | Recent searches, "Popular in this house", suggestions | D11, D12, D13 | Real gap; typing on a remote is slow | Port recents and popular; suggestions later | S, S, M |
| A-10 | Try again on a failed download; open the title page from a download | G5, G6 | Real gap | Port | S |
| A-11 | One stream for the whole film when repackaging (seeks without restarting the encode) | F4 | Real gap | Port after A-1 | L |
| A-12 | Playing your copy when Continue Watching still points at a stream | F44 | Real gap | Port | S |
| A-13 | Resume across sources of the same title | F31 | Real gap | Port | S |
| A-14 | Your own star rating | B29 | Real gap; it feeds recommendations | Port | M |
| A-15 | Collection / director / creator / network shelves | E18 | Real gap | Port | M |
| A-16 | Report a problem from inside the player | F55 | Real gap; player problems are the ones worth a report | Port | S |
| A-17 | Reduced motion | I18 | Real gap | Port | M |
| A-18 | Taste picker, Wrapped | B27, B28 | Gap, lower priority | Port | M each |
| A-19 | Home row order / hide editor | C4 | Gap, lower priority (the TV obeys what the website saved) | Port or leave | M |
| A-20 | "Kids" mark while browsing | B16 | Small gap | Port | S |
| A-21 | "Writing subtitles for X" notices | I9 | Small gap | Port | S |
| A-22 | Sign out everywhere, devices list | A14, A15 | Low value on a TV | Leave | |
| A-23 | Open on a given episode; extras list | E31, E32 | Small | Leave | |
| A-24 | Download pill in the nav; slow-line mode | G8, I15 | The TV has the launcher row; mostly on a LAN | Leave | |
| A-25 | Sign-up form, claim, Google popup and linking, picker search, new-profile tile, profile editing, passwords, e-mail, avatar upload, kids setup, look/theme, greeting, in-page search, screensaver, jokes, device downloads, offline copies and offline mode, drag/double-tap seeking, picture in picture, fullscreen, AirPlay, media keys, keyboard shortcuts, admin | A6, A9, A10, A11, B3, B8, B9, B10, B11, B12, B14, B17, B25, B26, C14, D7, D25, D26, D27, E41, E42, F38, F46, F47, F48, F49, F57, H12, I14, I19 | By design: typing, touch, browser features | Leave | |

## B. The TV has it, the website does not

| # | What the website lacks | Rows | Recommendation | Effort |
|---|---|---|---|---|
| B-1 | Sending the viewer to the login screen when the sign-in wall goes up mid-session | A19 | Port to the website | S |
| B-2 | AI "Try again" for a different list | D22 | Port | S |
| B-3 | Refusing to save progress when the watch history could not be read (so a failed read cannot overwrite it) | F34 | Port | S |
| B-4 | "Still loading" card with Keep waiting / Lower quality / Back | F7 | Keep; consider for the website's direct-play starts | S |
| B-5 | Marking an intro by hand and ignoring a detected one | F22 | Decide once: the website removed it on purpose. Remove on the TV or restore on the website | S |
| B-6 | Reporting a trailer that failed; two-trailers-per-visit cap | C12, C13 | Leave | |
| B-7 | AI controls folding away after an answer | D24 | Leave | |
| B-8 | Frame-rate and memory reports | I7 | Leave | |
| B-9 | Aurora row and Watch Next on the Android TV home screen | G16, G17 | Leave (by design) | |
| B-10 | Self-update, version row, remote keys, built-in server addresses | I12, H14, F50, A21 | Leave (by design) | |

Several TV behaviours that are better than the website's sit in list C (C-10, C-16, C-19, C-27), because both sides have the feature.

## C. Same feature, different behaviour (the real mismatches)

| # | Mismatch | Rows | Which side looks right | Recommendation | Effort |
|---|---|---|---|---|---|
| C-1 | **Library search.** Website: server search with typo tolerance and episode titles. TV: plain substring over titles; never calls `/api/search`. | D9, D14 | Website | Align the TV to `/api/search`; show searching / failed / none apart | S |
| C-2 | **Next episode.** Website checks the real episode list. TV takes the next file on disk, so it can jump E4 to E8. | F24 | Website | Align the TV | M |
| C-3 | **Which episode Play picks on a show.** Website: the one you touched last. TV: the earliest one with progress. Threshold 10 s vs about 0.5%. | E6, E7 | Website (matches Continue Watching) | Align the TV | S |
| C-4 | **Pressing an episode.** Not held: website opens the sources, TV saves the best source at once. Held below 1080p: website opens sources, TV plays. Show with nothing held: website has no Play, TV saves S1E1. | E8, E26, E27 | Owner's call; a TV comment wrongly says this is the website's flow (`D.tsx:1664-1667`) | Decide one rule, then align | M |
| C-5 | **More like this.** Website: the vibe ranker (`/api/discover/similar`). TV: the genre catalogue. | E17 | Website | Align the TV | S |
| C-6 | **Removing a failed download.** Website dismisses it. TV's "Remove" cancels it, and the row stays for good. | G4 | Website | Fix the TV (add `/dismiss`) | S |
| C-7 | **Subtitle language.** Website stores it on the profile and applies it everywhere. TV keeps its own per-box value, has no Russian, and with "any" prefers Hebrew over the first track. | H4, F13, F14 | Website for storage and Russian; Hebrew-first is a product call | Align the TV | S |
| C-8 | **Usage-stats opt-out.** Website: per profile, on the server. TV: per box. A profile that opted out on the website is still reported from the TV; the server does not enforce it. | H7 | Website | TV reads/writes the profile field, or the server drops opted-out batches | S |
| C-9 | **Automatic downloads landing** (a followed show's new episode, My List). Website stays silent in the app, and says nothing at all if push is off. TV toasts, notifies and lists every one, next-episode prefetch included. | G12, G15 | TV for follows and My List; website for next-episode prefetch | Needs a server flag to tell them apart; then align both | M |
| C-10 | **Stalls and errors in the player.** Website: staged recovery and a card with Try again. TV: no stall recovery on direct play, a dead-end error screen. But the TV explains a failed load where the website silently goes Home. | F40, F41, F42, F43 | Website for recovery; TV for the load error | Add Try again and direct-play stall recovery on the TV; port the load-error screen to the website | S to M |
| C-11 | **H.265 / AV1 torrents.** Website copies the picture when the device can decode it. TV always re-encodes to h264, and for library files finds an undecodable picture only by failing. | F2, F3 | Website | Try direct or copy first on the TV | M |
| C-12 | **Resume point.** Website 4 s early; TV exact. Top skip step 180 s vs 300 s. | F30, F37 | Website (the later decision) | Align the TV | S |
| C-13 | **Which season opens.** Website: the one you are in. TV: season 1. | E22 | Website | Align the TV | S |
| C-14 | **Kids profile opening a blocked title; a title that is gone; torrents switched off.** Website explains and goes back. TV leaves a live page whose buttons fail. | B21, E43, E44 | Website | Align the TV | S |
| C-15 | **Re-entering your own password-protected profile.** Website uses the session it already has. TV asks for the password on the remote every time. | A12 | Website | Port | S |
| C-16 | **PIN when hopping between kids profiles.** Website asks for any other profile. TV and the server let a stricter-or-equal kids profile through. | B19 | TV (it is the server's rule) | Align the website | S |
| C-17 | **"For you" on Movies / Shows.** Website pages through your liked genres. TV shows trending, reordered. | D4 | Website | Align the TV | S |
| C-18 | **Cancel a download.** Website confirms past 5%. TV cancels on one press of the focused row. | G3 | Website | Align the TV | S |
| C-19 | **Downloads after a dropped connection.** TV refetches and polls. Website's list and title page stay stale until a reload. | G7, E12 | TV | Align the website | S |
| C-20 | **Watch party.** Host pressing Back: website asks twice, TV ends the party. Guest at the end of an episode: TV shows a countdown that does nothing. X-Ray: TV pauses locally without telling the room. | F51, F53, F54 | Website | Align the TV | S |
| C-21 | **Mark watched.** Website: Undo, a film you do not hold, one request per episode. TV: one batched request with a restore, no Undo, held films only. | E13, E30 | Each has half | Align both | S |
| C-22 | **Continue Watching remove; New Episodes label.** TV gives no toast, no Undo, no rollback; the New Episodes row has no "S2 E5" label. | C17, C19 | Website | Align the TV | S |
| C-23 | **My List wording.** "saved for later" / "Off the list. Bold." vs "Added to My List" / "Removed from My List"; the TV title page is silent unless a download started. Website does not undo a failed add. | D18 | Pick one wording; TV for the rollback | Align | S |
| C-24 | **AI tab when the recommender is off.** Hidden on the website, shown with a notice on the TV. | D19 | Either; hiding matches the server's intent | Align | S |
| C-25 | **Pairing by typed code.** The TV tells you to type the code at `/link`; the website has nowhere to type it. | A5 | Neither | Add a code field, or print `/link?code=XXXXXX` on the TV | S |
| C-26 | **Sources list.** TV has no "Last played", no top-3 fold or quality filter, no "starting" / "second source" states, no retry; the website has no "Dub" badge. | E34, E35, E37 | Website, plus the TV's Dub | Align | S to M |
| C-27 | **Profile picker.** Website says "Not quite" for a rate limit or an admin lock, and lets you into a password-less profile when the check fails; the TV is exact and fails closed. TV has no lone-profile shortcut and shows Sign out to a child. | B4, B5, B7, B22 | TV for errors; website for the shortcut and hiding sign-out | Align each way | S |
| C-28 | **Changelog and reports.** TV prints `**` marks and website-only entries; TV reports carry no network or playback marks and always say "online". | I2, I4 | Website | Align the TV | S |
| C-29 | **Usage timing and hung requests.** TV sends time-on-previous-screen as page-load time; website requests have no time limit. | I6, I13 | Website for the timing; TV for the limit | Align each way | S, M |
| C-30 | **Surprise me; X-Ray depth; unaired episodes; audio switch; downloads page layout; screen-reader labels.** | D8, E19, E24, F10, G2, G11, I17, F12 | Website in each case | Align the TV | S to M each |

## D. Server features neither client exposes, or only one can reach

**No viewer client calls these:**

| Server feature | Evidence |
|---|---|
| Title requests: `GET` / `POST /api/requests` (`R/requests.js:128-170`) | No `/api/requests` in `public/js` or `tv-native`. Only `public/admin.html` reads the list. Nobody can file a request. |
| `POST /api/auth/password` (`R/auth.js:216`) | Neither client; the website uses `/api/profiles/:id/password`. |
| `DELETE /api/intro/:key` (`R/api.js:200`) | Defined in `W/api.js:206`, never called. Admin page only. |
| Socket message `profile_signed_out` (`R/profiles.js:710`) | Broadcast by "Sign out everywhere else"; no client listens (the string exists only on that line). |
| Socket message `request_update` (`R/requests.js:184, 208`) | No client listens. |
| Pre-blurred WebP pictures (`?blur=…&fmt=webp`) | CHANGELOG 1.6.82: "Nothing asks for it yet". |
| My List stale marks (14 / 21 days) | Shown only in the admin page (`public/admin.html:3076-3083`). |
| `POST /api/profiles` (old "create a profile" request) | `W/api.js:215` exists but its form is unreachable. |

**Only the website reaches these:** `/api/search`, `/api/search/suggest`, `/api/popular`, `/api/discover/similar`, `/api/discover/collection`, `/api/segments`, `/api/netprobe`, `/api/library/for`, `/api/torrents/probe`, `/api/torrents/perf-mark`, the jit streams (`/stream/transcode/:id/jit/*`, `/stream/torrent/hls/.../jit/*`), `/api/offline/*`, `/offline/*`, `/api/push/*`, `POST /api/downloads/:id/dismiss`, `/api/kids/enter`, `/api/profiles/:id/kids`, `/password`, `/email`, `/avatar-image`, `/rating`, `/taste`, `/wrapped`, `/today`, `/signout-everywhere`, `/api/auth/sessions`, `/api/auth/claim*`, `/api/auth/google/web-*` and `/link`, `/api/auth/device/describe` and `/approve`, `/api/changelog?head=1`, `/sw-manifest.json`.

**Only the TV reaches these:** `/api/trailer`, `/api/trailer/report`, `/api/auth/device/start` and `/poll`, `/api/ping`, `/tv-version.json`, `/download`, `POST /api/intro/:key` (the website's caller is dead code), `/api/ai/recommend` with `fresh`, `/api/home?slim=1`.

## E. Merged in source, not in a released TV build

`git diff tv-5.1.31-stable..master -- tv-native`: 4 files, 36 insertions, 9 deletions (commit `14f3a76`). `APP_VERSION` is still 5.1.31 (`T/update.ts:10`).

| File | What is waiting |
|---|---|
| `T/api.ts` | `ListDownload` type and `listAddedLine()`: "Added to My List — downloading the film" / "… the first episode"; `MyDownload.auto` |
| `Ov.tsx` | The peek sheet's add toast says what started downloading |
| `D.tsx` | The title page toasts after an add, only when a download started |
| `TS/Downloads.tsx:178` | Row prefix "From My List · " |

Until a TV build ships, a TV on 5.1.31 adds to My List with a plain "Added to My List", and a film fetched that way appears under My downloads as "Next episode, queued for you" (bug X10). CHANGELOG 1.6.85 says the TV side ships with the next build. Nothing else in `tv-native` differs from the tag.

## F. Bugs and inconsistencies found on the way

Not part of the parity question; listed so they are not lost. "Re-checked" = confirmed by hand against the file.

**Affect users**

| # | Where | What |
|---|---|---|
| X1 | TV + website | The TV's "open {host}/link and type this code" leads nowhere: `/link` without a code redirects to `/#/pair/`, which matches no route and lands on Home; `pair.js` has no code field (`TS/SignIn.tsx:355-358`, `server.js:284-287`, `W/router.js:8-16`). Re-checked. |
| X2 | Server | `/api/auth/login` drops `mustReset` from its answer (`R/auth.js:93-99`) although `profiles.login` returns it (`src/profiles.js:134`). When sign-in is required, nobody is ever prompted after an admin's forced reset. Re-checked. |
| X3 | TV | "Remove" on a failed download calls cancel; the row stays as "Canceled" with no action, permanently. Declined and cancelled rows have no action at all (`TS/Downloads.tsx:138-164`). Re-checked. |
| X4 | Server + both | "Sign out everywhere else" broadcasts `profile_signed_out`, which no client handles; other devices keep running until a request is refused. The comment at `R/profiles.js:708` says otherwise. Re-checked by grep. |
| X5 | TV | `route` usage events carry time spent on the previous screen under the new screen's name (`T/navigation.tsx:80-87`); the admin page reads them as time-to-painted (`src/lib/usage.js:89-93`). TV screen timings there are meaningless. |
| X6 | TV | A party guest's Up next sets the `advancing` guard and returns without clearing it (`P.tsx:2372-2382`); the Next button is then dead for that player (`P.tsx:2353`). Re-checked. |
| X7 | TV | The request cache is keyed by path only and is not cleared on a profile switch (`T/api.ts:639-650`; `forgetMemo` is called only at `T/realtime.ts:99` and `D.tsx:967-968`). The library list and the first catalogue page are kept 60 s, so a kids profile entered within a minute of a grown-up can be shown the grown-up's lists. Opening a title is still refused by the server. From reading; not reproduced. |
| X8 | Both | The AI page keeps its last answer in module scope with no owner (`WS/pickforme.js:76`, `TS/Pick.tsx:97`): the next profile, a kids one included, is shown the previous profile's picks. Re-checked. |
| X9 | Website | `push.rebind()` is never called (`W/push.js:71`): after a profile switch, "ready" pushes keep going to whoever turned them on. Re-checked by grep. |
| X10 | TV 5.1.31 | A My List film download is labelled "Next episode, queued for you". Fixed in source (section E). |
| X11 | TV | X-Ray in a party pauses only this TV (`P.tsx:3089-3090`); a guest is un-paused by the next sync, a host drifts and then pulls the room back. |
| X12 | TV | `aurora.serverUrl` is saved (`App.tsx:77`) but `resolveServer` ignores it (`T/api.ts:719`); comments still describe a setup screen. |
| X13 | TV | A catalogue title's metadata fetch has no error handler (`D.tsx:1169-1183`): a refusal or a 502 is an unhandled rejection. |
| X14 | Website | After "Sign out everywhere else" the new token is stored but not put on requests (`WS/preferences.js:558`); on a password-protected profile with no session, requests fail until a reload. |
| X15 | Website | Downloads are not refetched after the socket reconnects, so a download that finished during an outage is missed, toast included (`W/ws.js:107-113`, `W/main.js:291-302`). |
| X16 | Both | Party code field: 4 characters on the website (`W/main.js:510`), 6 on the TV (`Ov.tsx:298`). |
| X17 | Website | Media keys "next" and "prev" are emitted (`W/focus.js:140-141`) and handled by nothing in the player (`P.js:5139-5152`). |

**Wording that says one thing while the code does another**

| # | Where | What |
|---|---|---|
| X18 | Website | A What's new card sends people to "Settings, More settings, Data use"; the section is called "Internet use" (`WS/whatsnew.js:31-32`, `WS/preferences.js:843`). Re-checked. |
| X19 | Website | The classic-look notice advertises "a Tonight row" (`W/main.js:434`); Home has no such row. Re-checked. |
| X20 | TV | The party hint says "profile menu, Join a watch party" (`P.tsx:3441`); on a TV it is a Settings row (`TS/Settings.tsx:237`). |
| X21 | TV | The update sheet says "Aurora TV x is ready" while offering a download (`Ov.tsx:440`). |
| X22 | TV | The rail says "Preferences" (`T/navSection.ts:39`); the screen and the website say "Settings". Re-checked. |
| X23 | TV | Reports always say `online: true` (`Ov.tsx:226`). |

**Dead code and stale comments**

| # | Where | What |
|---|---|---|
| X24 | TV | Unused: `playFromStart` (`D.tsx:1306`), `api.ping` and `api.discover` (`T/api.ts:836, 898`), nav section `'new'` (`T/navSection.ts:17`), `updateWasDismissed` (`T/storage.ts:214`), the `h264-720` type (`P.tsx:205`). |
| X25 | TV | Stale comments: "neither the server nor the site has a similar feature" (`D.tsx:1339-1344`; it is at `R/requests.js:96`); "the TV has no socket client" (`TS/Sources.tsx:256-258`); skip steps "ported verbatim" (`P.tsx:126`); "same three groups the site has" (`TS/Settings.tsx:3`). |
| X26 | Website | Unused: the intro-marking functions (`P.js:4187-4198, 4249-4275`) and `api.clearIntro` (`W/api.js:206`); the old create-profile form and `api.createProfile` (`WS/profiles.js:238-260`, `W/api.js:215`); `item.badge` on cards (`W/components.js:149-150`); `DL_BADGE` (`dd.js:266-271`); a `shows` row name the server never sends (`WS/preferences.js:205`). |
| X27 | Server | The fallback answer of `/api/discover/collection` lacks the `creator` and `network` keys (`R/requests.js:123` vs `:117`). |

**Could not be determined from code**

- Whether the TV's clock is exact after a resume on a `copy` stream: it ignores the `X-Aurora-Base` / `X-Aurora-Offset` headers the website relies on (`P.tsx:1029-1047`, `P.js:1141-1163`). Needs a device.
- HDR and Dolby Vision on a real HDR set: neither client has any logic for it.
- Whether the website's playback speed survives a stream rebuild (`P.js:820-821`). Needs a browser.
- Whether the server keeps `look: 'tv'` on usage batches or maps it to another look (`src/lib/usage.js:178` not traced).
- Voice search on the TV: nothing in code; it depends on the TV keyboard.
