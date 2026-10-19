# Phone remote and Play on TV (branch feat-phone-remote)

2026-10-20. Website tested in real Chrome at phone and desktop sizes against a simulated TV. The TV part passes its logic tests, `tsc` and a Kotlin compile, but has not been on the Mi TV yet (device checks below). Commit 4a87524.

## What it does

- **Your TVs.** Every TV app, and every website on a computer or tablet, shows up on a phone signed in to the same profile. Phones are only remotes and don't list each other.
- **Play on TV** is on title pages next to Play, every downloaded episode row, the hold/right-click sheet of any card (so Continue Watching on Home works), the remote's own "Continue watching" strip, and the website player itself (hands its film over at the same second with its subtitles and dub).
- **The TV opens the player** at that episode and position, with the phone's subtitle and audio language.
- **The remote screen (`#/remote`).**
  - Top: device picker ("Living room TV ▾") with a connection light.
  - Now playing: artwork over its own blur, title and episode, a thick scrub bar with times, a big play/pause between ±10 and ±30, Subtitles (with ±0.5 s timing and Reset), Audio, Next episode, Stop.
  - Touchpad: swipe = arrow (long swipe keeps stepping), tap = OK, ripple and buzz where the phone vibrates. Or a round D-pad with OK, plus Back, Play/Pause, Home.
  - Bottom: Now playing / Touchpad tabs, volume −/mute/+ when the device allows it.
  - Landscape phones, tablets and desktops show both halves side by side. Glass and classic looks are both covered.
- **Ways in:** Remote button in the nav and a "Remote" item in the profile menu (only while a TV is on), Settings → "Phone as a remote", and a "Remote" shortcut in the installable app.
- **Parity:** a computer can be played on too ("Play on this computer"); arrows, OK and Back move its focus like its keyboard. Settings has "This device's name" and "Let my other devices play here"; the TV has "This TV's name".

## Who may control what

- A device's profile is proven the same way as the rest of the server (sign-in session or the profile unlock token). A bare claim, a locked profile or a profile that owes a new password is refused.
- Same profile by default. Admin switch People → "Phone as a remote" (off by default) lets grown-ups also control the household's other TVs. Kids profiles only control their own. Checked again on every command.
- 15 commands a second, 40 at once, per remote, following the existing WebSocket limits' log/enforce mode.
- Every command gets one answer: the device's own, a refusal from the server, or "didn't answer" after 6 s. A device that goes away answers "went away" and leaves every list. Position updates every second while a remote screen is open.

## On the TV

- Arrows, OK and Back are real key presses injected into the TV app through the same path as the hand remote, so the focus logic that fixed "the rail opens by itself" applies unchanged (pinned by a logic test). Presses are spaced ≥130 ms so the double-press filter doesn't swallow them.
- Home goes to Aurora's Home, not the Android launcher.
- Volume and mute are the TV's own volume with the system bar. Fixed-volume TVs hide the buttons on the phone. On a computer, volume is the player's own.
- First command shows "Controlled from Elia's iPhone" once per remote.
- App in the background: Play on TV tries to bring Aurora forward. Android 10+ may refuse; the phone then says "Aurora is in the background on the TV — open it there".
- Phone presses keep the TV screen on for 5 minutes (injected presses don't count as activity for the screensaver).

## Tests

| Run | Result |
|---|---|
| Root `npm test` | Run 1: 13 load/file-lock failures in untouched tests, each green alone. Run 2: 1862/1862. |
| Full `npm run test:ui` | Run 1 (before fixes): 301/305. Runs 2 and 3 under ui-lock: 304 pass, 0 fail, 1 skipped. |
| `remote.test.js`, `remote-restart.test.js` | 3 runs each, green. `navigation` 3×, `leaks`, `signin` green alone. |
| `test/devices.test.js` | 14/14, 3 runs. |
| TV logic tests | 51 suites / 600 tests, green 3 times (73 new). |
| `tsc` / Kotlin compile | Clean / BUILD SUCCESSFUL. |

Browser tests run in real Chrome with real touch swipes against `test/ui/support/sim-tv.js`. They cover glass and classic (Play on TV, pause, ±10/30, scrub = exactly one seek, subtitle track and timing, second dub, swipes, taps, D-pad, Back, volume, mute, Stop, Continue Watching resume), episodes and Next episode, landscape, scoping (another profile's TV never offered, empty remote, a TV that never answers), Play on this computer, web player handoff, the Home hold sheet, and a server restart.

Two bugs found by the full run and fixed before the commit: title pages leaked through the Play on TV button, and the navigation route table didn't know `/remote`.

## Not verified

- Everything that needs the Mi TV: injected key order and focus, volume/mute and the system bar, the TV's device name, bring-to-front, keep-screen-on, the toast and the name picker.
- A real iPhone or Android phone: haptics and safe-area insets.
- Autoplay on a computer tab nobody clicked may be refused by the browser; the player then shows its play button and the phone shows Paused.

## Files

- New: `src/lib/devices.js` (protocol in its header), `public/js/remote.js`, `public/js/screens/remote.js`, `public/css/remote.css`, `tv-native/src/remote/*`, `RemoteModule.kt`, `RemotePackage.kt`, `test/devices.test.js`, `test/ui/remote.test.js`, `test/ui/remote-restart.test.js`, `test/ui/support/sim-tv.js`, `tv-native/__tests__/logic/remote-*`.
- Changed inside `[phone-remote]` blocks: `src/realtime.js`, `src/routes/admin.js` (`/api/admin/remote`), `src/lib/tel/vocab.js`, `src/lib/tel/controls-vocab.js`, `docs/analytics.md`, `main.js`, `screens/player.js` (start position, languages, appended block), `discover-detail.js`, `peek.js`, `preferences.js`, `admin.html`, `manifest.webmanifest`, `Player.tsx`, `realtime.ts`, `navigation.tsx`, `SessionWiring.tsx`, `Settings.tsx`, `storage.ts`, `MainActivity.kt`, `MainApplication.kt`, the `profile-scope` TV test, `test/ui/navigation.test.js`.
- Screenshots here (19): phone glass and classic screens, phone landscape, desktop remote and the hold sheet's Play on TV. The test artwork is colour bars, so the blurred backgrounds look loud; a real poster gives a calm wash.

## Mi TV checks (QA build, local server)

1. **Shows up.** Profile on the TV, Remote on a phone in the same profile: the TV appears by its system name (or "Living room TV") with arrows and volume.
2. **Play on TV from a film page.** Player opens within about 1 s; the phone says "Playing on …".
3. **An episode.** TV header shows the show, "S1 E2" and the episode name.
4. **Continue Watching, including a streamed item.** Starts at the phone's position, not 0:00.
5. **Start over.** Starts at 0:00.
6. **Scrub to about 40 minutes.** TV lands exactly there.
7. **−10 / +10 / −30 / +30 pressed quickly.** Each press moves exactly that far.
8. **Pause / play.** TV flashes the icon; phone follows within about 1 s.
9. **Next episode.** Next one starts. Last episode: "There is no next episode". Watch-party guest: TV says "Following the host…".
10. **Subtitles.** Off / a track / another track: the TV's own menu ticks the same one. Remembered Hebrew comes on even if late; remembered "off" stays off.
11. **Audio track on a multi-dub file.** Stream restarts on that dub; a remembered dub starts on it without starting twice.
12. **Subtitle timing ±0.5 / Reset.** TV shows "Subtitle delay +0.5s". With subtitles off, the phone says "Turn a subtitle track on first".
13. **Volume and mute.** TV volume changes. Note whether the system bar appears and whether it takes the next phone arrow. Hand-remote volume updates the phone within about 1 s.
14. **D-pad on Home — the important one.** One press = one move; fast repeats never double or skip. The rail never opens by itself: left along a shelf stops on the first card, only the next left opens the rail. Up from the first shelf onto the hero doesn't open the rail; only a second up does.
15. **Rail, Detail and the player.** In the player: left/right skip with controls hidden, OK pauses, up/down show controls, Back hides them then leaves.
16. **Phone Home key** from Detail and from the player: TV lands on Home with no sheet open.
17. **The toast.** "Controlled from Elia's iPhone" once, not again after more presses or a reconnect. A second phone gets its own.
18. **Rename.** Settings → "This TV's name" → "Bedroom TV" shows on the phone within seconds. Back changes nothing. Renaming from the phone (⋯ → Rename) updates the Settings row. Survives an app restart.
19. **App in the background.** Home on the hand remote, then Play on TV: report whether Aurora comes forward and plays or the phone shows the "open it there" message.
20. **Server restart.** TV reconnects and reappears, commands work, the toast doesn't repeat.
21. **Switch profile on the TV.** It leaves the first profile's phone and appears on the new one's.
22. **Screensaver.** Steer only from the phone past the screensaver delay: no screensaver until about 5 minutes after the last press.
23. **Kids.** A kids profile's phone sees only its own TV even with the household switch on. A grown-up playing an over-age title on the kids TV is refused the same way the TV refuses it itself.
