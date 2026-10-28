# Aurora for Android — checks on a real phone

What the emulator (Pixel 9 AVD, Android 17 preview, x86_64) could not prove. Run on a real Android phone (ideally one mid-range, e.g. a Pixel 6a / Galaxy A5x, and one older Android 10–11 phone for the PiP and notification fallbacks). QA builds only: a QA build has `http://127.0.0.1:4000` as its ONLY server (adb reverse to a private instance — never nufurora, never the house server).

## Build and install

```
cd tv-native/android
# QA (emulator / test phone): bash $TEMP/aurora-agents/android-phone/build-qa.sh  — or by hand:
#   put 'http://127.0.0.1:4000', // QA VARIANT  as the ONLY entry of SERVER_CANDIDATES (src/api.ts)
gradlew.bat assembleRelease -Paurora=phone -PreactNativeArchitectures=arm64-v8a,armeabi-v7a
#   restore src/api.ts; `grep -c "QA VARIANT" src/api.ts` must print 0
adb -s <phone> install -r app/build/outputs/apk/release/aurora-phone-release.apk
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
