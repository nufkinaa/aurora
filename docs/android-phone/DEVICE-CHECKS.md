# Aurora for Android — checks on a real phone

What the emulator (Pixel 9 AVD, Android 17 preview, x86_64) could not prove. Run on a real Android phone (ideally one mid-range, e.g. a Pixel 6a / Galaxy A5x, and one older Android 10–11 phone for the PiP and notification fallbacks). QA builds only: a QA build has `http://127.0.0.1:4000` as its ONLY server (adb reverse to a private instance — never nufurora, never the house server).

## Build and install

```
# QA (emulator / test phone) — 127.0.0.1 only; Gradle's auroraQaGuard (-PauroraQa) fails the
# build if SERVER_CANDIDATES names anything else:
ABIS=arm64-v8a,armeabi-v7a bash tv-native/tools/build-phone-qa.sh
adb -s <phone> install -r tv-native/android/app/build/outputs/apk/release/aurora-phone-release.apk
adb -s <phone> reverse tcp:4000 tcp:<private instance port>
```

The release build (for elia, later) is the same command without the QA line: nufurora.com first, then the house server.

## 1. Install and start
1. Installs **beside** the TV app's APK if both are sideloaded (different applicationId `com.aurora.phone`), launcher shows "Aurora" with the Aurora icon.
2. Cold start (app killed): the wall or Home within ~1 s on a mid-range phone; `adb logcat -s ReactNativeJS | grep faststart` — `fresh t=` under 1500 ms on Wi-Fi.
3. Second start with a remembered profile: Home's shelves are on screen in the first frame (the kept snapshot), no spinner.
4. Status bar and navigation bar are transparent (edge-to-edge); the clock stays readable over the billboard and over scrolled pages (the scrim).

## 2. Sign-in (closed mode on the private instance: `POST /api/admin/auth-mode {"mode":"closed"}`, back to "transition" after)
1. Sign-in screen: username + password signs in; a wrong password shows the server's words.
2. "Use a code instead": the code shows; approving it from the website's Pair page signs the phone in by itself.
3. Pictures load in closed mode (`grep -c "\[auth\] 401" data/server-stdout.log` → 0) — the RN Image-headers patch applies to the phone too.
4. Forced new password (People → Reset password): the new-password screen, Back does nothing, saving goes on.
5. Kicked from People: "Signed out by the admin" and the sign-in screen.

## 3. Profile wall (open / transition)
1. Tiles, the last-used one lit; a password profile asks for its password (keyboard up, password manager offered).
2. Kids profile: KIDS badge; leaving it asks for the household PIN (number pad).

## 4. Home
1. Billboard: swipe between slides, the dots follow; it turns by itself every 9 s while untouched; Stream opens the title page which plays by itself; Details opens it.
2. Greeting line ("Good evening, <name>"), Watching-together strip when a party runs.
3. Continue Watching: tap resumes (library film straight into the player); ✕ removes with "Removed from Continue Watching".
4. "Recommended by your household" sits under "Recommended for you"; its Show all tile opens the page (For you / You sent).
5. Long-press a poster: haptic tick + sheet (Details, Recommend).
6. Pull to refresh re-reads Home; scrolling at 60 Hz (and 90/120 Hz on a fast phone) stays smooth — `adb shell dumpsys gfxinfo com.aurora.phone` after a minute of scrolling: Janky frames under 5 % on a mid-range phone.
7. Tab bar: Home · Movies · Shows · My List · Search; switching keeps each tab's scroll; tapping the tab you're on scrolls it to the top; every label stays visible after any number of switches.

## 5. Title pages
1. Library film: Play / Resume 0:42, Start over, Save to phone, My List, Recommend, X-Ray, Mark watched, Trailer (opens YouTube), Share (Android share sheet with the nufurora.com link).
2. Catalogue film: Save & watch (best source saved AND played while it downloads), Stream instead (Sources), the line under the button tells the download's story; a CAM-only film shows the server's sentence and opens the list.
3. Show: Continue S1 E3 · 12:04; season chips; episodes as glass cards (still, kicker, progress bead, ✓, owned glow); tap an episode you don't hold → saves its best source, the card shows SAVING n%; long-press → Save and play / Sources / Mark watched; "Save season offline (n)"; "Mark season watched".
4. "Play on <TV>" appears only while a TV of the profile is on; pressing it starts the film on the TV and the toast says so.
5. Landscape: shorter picture, body in a centred column.

## 6. Player (ExoPlayer)
1. Opens landscape; the rotate button turns it portrait and back; leaving the player gives the phone its own rotation again.
2. Tap shows / hides the controls (4 s); double-tap left/right skips 10 s (taps in a row accelerate); horizontal drag scrubs with the target time shown; vertical drag left = brightness, right = volume; pinch = fill / fit; lock leaves only the unlock button.
3. Scrubber drag shows the time bubble; intro band and ticks on the bar.
4. Subtitles menu (tracks, resync, timing, the person's style), gear menu (audio tracks with Original, night mode / dialogue boost), speed, X-Ray (pauses, resumes on close), Watch together.
5. Skip intro / recap, Up next with countdown, "Still watching?" after three in a row.
6. Hardware decoding: an HEVC / 10-bit file plays direct where the phone decodes it (`adb logcat | grep -i "c2\.\(qti\|exynos\|mtk\)"` shows the hardware codec; the server's avcaps report lists hevc).
7. Recovery: kill the private server mid-film → the card with Try again after the bounded retries; never back to 0:00 (the 1.13.7 / 5.7.1 rule).
8. Picture-in-picture: Home button / swipe-up while playing shrinks it into a window (Android 12+ smoothly by itself; Android 8–11 on Home); the window shows the picture only (no controls, no cue layer); tap returns full screen.
9. Lock screen / notification: play, pause, seek from the media notification and from Bluetooth headphones; the notification shows the title.
10. Screen stays on while playing; brightness set by the swipe goes back to the system's when leaving.

## 7. Saving to this phone
1. Settings → Saved on this phone → Quality "Ask each time": the sheet lists the server's sizes (Original · 2 MB, 480p · ~8 MB …).
2. A save shows "Preparing on the server — …", then the Android download notification with progress; it continues with the app closed and after a Wi-Fi drop.
3. "Save on Wi-Fi only" on mobile data: "Waiting for Wi-Fi", starts on its own on Wi-Fi.
4. Downloads → On this phone: the copy, its size, free space; tap plays it **with the server unreachable** (airplane mode); subtitles saved beside it can be cycled with CC.
5. Progress watched offline reaches the profile once the server answers again (Continue Watching on the website shows it).
6. Remove deletes the file (`adb shell ls /sdcard/Android/data/com.aurora.phone/files/offline/`).
7. Not enough space: the sheet's size larger than free space → the site's sentence, nothing downloaded.

## 8. Your TVs (phone as the remote)
1. With the Mi TV on (its owner's turn) or a website tab on a computer: the device chip, the D-pad (up/down/left/right/OK), Back, Home move the TV.
2. While something plays: the title, the position ticking every second, play/pause, ±10, Next, Subtitles / Audio pickers, Stop; volume − / + / mute where the TV says it can.
3. A TV of another household member shows its owner's name when the admin allows household remotes.

## 9. Search
1. Typing: suggestions (title / person / genre) then results; "Searching the catalogue…" / "Still searching…"; a failure says so with Try again.
2. Mic: the permission is asked once; listening shows "Listening in English"; the other-language chip switches to Hebrew; the server tidies what was heard ("search for the movie inception" → inception).
3. Recent searches, Clear; Popular in this house.

## 10. Settings
1. Every switch that follows the person (autoplay, subtitles on, language, style, night mode, usage stats) shows the same value on the website after changing it on the phone, and the other way round.
2. Notifications: turning "Tell me when a download lands" on asks Android 13+ for permission; a finished download posts "<title> is ready to watch"; tapping it opens the app on the title (aurora://open).
3. Household recommendations switch and mutes; What you sent.
4. Sign out on this phone.

## 11. Links
1. A `https://nufurora.com/#/movie/<id>` link tapped in a chat opens the app on that title once nufurora.com serves `/.well-known/assetlinks.json` for the phone's signing key (until then: Android's chooser, or Settings → Apps → Aurora → Open supported links).
2. `#/party/<code>` joins the party; `#/remote` opens Your TVs; `#/search?q=…` searches.

## 12. Tablet / foldable
1. Grids widen (5–8 columns), the tab bar stays centred at most 560 dp wide; a fold/unfold keeps the film playing (configChanges).
2. Split screen: the app resizes without restarting; the player keeps playing (multi-window is treated like PiP).

## 13. Battery
1. One hour of browsing with the screen on, no film: `adb shell dumpsys batterystats com.aurora.phone` — no wakelocks held outside playback; the socket reconnects on return from background.

## 14. A weak phone (2–3 GB, Android 8–10, e.g. a Galaxy A10 / Redmi 8)
1. `adb logcat -s ReactNativeJS | grep "low-end"` prints `[phone] low-end: yes (…)`; on a mid-range phone it prints `no`.
2. Cold start (app killed, profile remembered): `adb logcat -s ReactNativeJS | grep faststart` — `paint t=` under 1500 ms, and the whole launch (tap to shelves) under 3 s.
3. Home and Movies: a minute of flinging, then `adb shell dumpsys gfxinfo com.aurora.phone` — Janky frames under 5 %, 90th percentile under 32 ms.
4. Looks the same as on a fast phone: no missing pictures, no blank shelves after a fast fling (they fill in), pictures appear without a fade.
5. `adb shell dumpsys meminfo com.aurora.phone` after ten screens: TOTAL PSS around 250 MB or less; Home button then `adb shell am send-trim-memory com.aurora.phone BACKGROUND` — the bitmaps drop to a few MB.
6. Switching tabs: Movies, Shows, My List and Search start at the top again after another tab was used (a weak phone lets them go); Home keeps its place.
7. A film starts within ~4 s on Wi-Fi; the player does not stutter while the controls fade.

## 15. Updates (the phone app's own)
On the private instance: copy a newer phone build (versionName higher than the installed one, versionCode higher) to `<instance root>/public/aurora-phone.apk`, notes in `public/phone-version.json` (`{"versionName":"1.0.1","notes":"…"}`). `curl <instance>/phone-version.json` answers the APK's own version.
1. A few seconds after start: "Update ready · Aurora for Android 1.0.1 · this phone has 1.0.0" with the notes. Later closes it and it does not come back that day for that version; Settings → This phone → Check for updates brings it back ("You're on the latest version" when there is none).
2. Update, first time: "Android asks once: allow Aurora to install apps" → Allow in Settings opens Android's Install unknown apps page for Aurora. **The person** switches it on and comes back: the download starts by itself (progress, MB), then Android's installer asks to confirm. Nothing installs without that confirm. (Emulator: verified up to Android's page; switching it on was left to a person.)
3. After the install the app opens as the new version (Settings shows it); `/download/phone` and the /install page's button hand over the same file.

## 16. App links (nufurora.com)
1. `curl https://nufurora.com/.well-known/assetlinks.json` — the phone's package and the SHA-256 of the signing certificate (`apksigner verify --print-certs` on the APK), served by Aurora itself (config `phoneCertSha256` / `AURORA_PHONE_CERT_SHA256`, else read from public/aurora-phone.apk). No redirect on the way.
2. `adb shell pm get-app-links com.aurora.phone` → nufurora.com `verified` (after a fresh install; `adb shell pm verify-app-links --re-verify com.aurora.phone` to ask again).

## 17. First launch and the network
1. Phone just rebooted (or just out of airplane mode), app opened at once: the loading screen may say "Still connecting — waiting for the network…" for a few seconds, then Home — not "Can't reach Aurora" (`adb logcat -s ReactNativeJS | grep faststart` shows `round2`, `round3` and `server … found`).
2. Really offline (airplane mode): "Can't reach Aurora." after about 15 s, Try again works once the network is back.

## 18. Hebrew phone (right to left)
1. With the phone's language set to Hebrew the layout mirrors: back button and kicker on the right, the tab bar Home on the right, row chevrons and the back arrow point the other way; play / ±10 s keep their direction.
2. Title pages (film, show, a long name, landscape): the kicker never sits under the back button, at rest or scrolled; once scrolled the scrim comes up behind the pills.

## 19. Bars while scrolling
1. Every page: once scrolled, a soft page-coloured scrim comes up behind the clock and the round pills (the website's look — no solid app bar); the clock stays readable.
2. Scrolling down a long page slides the tab bar away; any scroll up, the top of the page or a new page brings it back.
3. Landscape (the website's wide layout): the tab bar sits at the top between the logo and the pills, the billboard is nearly the whole height, a title's cover the whole screen with its words low in a centred column, the words never under the top bar; Settings / Downloads / Your TVs read in a centred column.

## 20. The website's look (1.0.1, docs/android-phone/WEB-PARITY.md)
1. Side by side with nufurora.com in Chrome on the same phone (glass look, same profile): Home's billboard, row titles, poster and Continue Watching cards, the tab bar and the top pills are the same sizes and in the same places; the sky is the same dark navy night with the violet glow at the top (not green).
2. A title page: the poster across the top (phone upright), the 16-round white Play button, the strip of round buttons with small words, the season island and the episode cards scrolling sideways.
3. The profile button opens the glass panel under it (not a bottom sheet); Back or a tap outside closes it.
4. Settings → Display size and Font size at their largest: no word breaks inside the title page's round buttons; the tab bar's words fit.
5. A phone with 3-button navigation: the tab bar sits above the buttons, never on them.
6. Scroll Home on an older phone for a minute: smooth (`dumpsys gfxinfo com.aurora.phone`: janky under 5 %).
