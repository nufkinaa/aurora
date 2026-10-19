# Player options — night mode, dialogue boost, one subtitle look (branch player-options)

2026-10-19. Website tested in real Chrome; the TV part builds and passes its tests but has not been on the Mi TV yet (device checks below).

## What a viewer gets (same names and behaviour on website and TV)

- **Night mode** and **Dialogue boost**: Settings → Sound, and player ⚙ → Audio (the Audio section is always there; the dub list sits above the two switches when a film has several dubs).
- **Subtitle look**: Settings → Subtitles, and the player's Subtitles menu → Subtitle style (moved there from ⚙ on both platforms). Live sample with an English and a Hebrew line; cues on screen change at once.
  - size S / M / L / XL · text colour white / yellow / cyan / green · background none / shadow / outline / box · box opacity 25 / 50 / 75 / 100 % (only with Box) · weight regular / bold · position lower / raised.
- The **subtitle delay** stays per title and track on the device (the delay that fixes one file is wrong for the next).
- **Per person**, stored on the profile and synced; the server accepts only values from the fixed lists.
- **Defaults** = the TV's old look: Medium, white, box 75 %, bold, lower; both sound switches off. One visible change: website cues are now bold by default (Regular can be picked).
- **Migration**: the old device subtitle size and background move into the profile once per person, only if the profile has nothing of its own. "Background off" becomes None on the website and Shadow on the TV, matching what each drew before.
- Hebrew stays right to left; the cue lift above the timeline still works (Raised = 80 % down the picture; with the controls up, the higher of the two wins).

## The sound

- Shared numbers: night mode = compressor −34 dB, 3:1, +6 dB make-up; dialogue boost = +6 dB around 1–4 kHz, −4 dB under 200 Hz, +3 dB centre channel for 5.1; limiter at −1 dB when either is on.
- **Website**: a Web Audio graph on the `<video>`, built only when an option is turned on; switching crossfades (a first version that glided the compressor made an audible zipper). Works with hls.js and native playback.
- **iPhone, iPad, Safari**: switches greyed — "Not on iPhone, iPad or Safari — Apple's player keeps the sound to itself." (Apple's player can silence a film routed through Web Audio; native fullscreen and AirPlay take the sound from the page anyway.) The film plays its normal sound; the choice still applies on the person's other devices.
- **TV**: Android DynamicsProcessing (Android 9+) on the player's own audio session, via react-native-video's plugin interface (library not patched); switching glides over 200 ms. When the sound is passed through as AC-3/E-AC-3/DTS or offloaded, nothing is applied and the switches are greyed with the reason (detected from the audio track itself). Android 8 or older / firmware without the effect: greyed with the reason.
- TV build: one new normal permission (`MODIFY_AUDIO_SETTINGS`); a compile-only media3 1.8.0 dependency that must stay equal to react-native-video's media3 version.

## Measured (offline render of the same chain over a made clip)

| Measurement | Result |
|---|---|
| Loudness range | 34.9 → 17.6 dB |
| Quiet speech | −40 → −35 dB |
| Loud bursts | −6 → −18 dB |
| Voice band | +9.5 dB |
| 5.1 centre | +3 dB |
| Click on switching | none |

## Tests

- Root `npm test` 1858/1858 twice in a row (earlier runs had 4 unrelated load failures that pass alone).
- Whole `npm run test:ui` through the shared lock: 309/310 twice in a row (one skipped). One earlier failure was this branch's own (player-hls dub-list check saw the new switches) and is fixed.
- New `test/ui/player-options.test.js` (13 tests, 3× green): graph built on the real `<video>`, values read back and output measured, night mode on an hls.js film, the offline render, subtitle styles read from Chrome's own cue boxes on desktop and phone in both looks, Raised + lift, Hebrew, the Settings sample, a second browser picking up the choices, the migration, the iPhone greyed state.
- New `test/player-options.test.js`: server, website and TV tables (choices, defaults, wording, Kotlin numbers) checked equal; migration and limits.
- TV: jest logic 539/539, tsc clean, gradle testReleaseUnitTest 81/0 (5 new), bundle and assembleDebug succeed.

## Known, not changed (already broken before this branch)

In the legacy look on a phone, the subtitle menu is 371 px wide and sits 17 px off the left edge, and the last dock icon is clipped.

## Mi TV device checks

QA variant with a higher versionCode against a local server, `svc power stayon true`, profile Claude QA.

1. Settings → Subtitles: two-line sample, Hebrew right to left; every row cycles and the sample updates; Box opacity only with Box; D-pad reaches every row.
2. Settings → Sound: On/Off with notes if `getprop ro.build.version.sdk` ≥ 28; below that "Not here / Needs Android 9 or later".
3. Sync: Yellow + Outline + XL + Night mode set on the website show on the TV; Box opacity changed on the TV shows on the website after a reload.
4. Old box settings: old size Large and background Off before updating → profile shows Large / Shadow after, and it does not move again after a change and a restart.
5. Subtitle menu → Subtitle style: each choice changes the cue at once; outline crisp, no doubled text on two-line cues; box at all opacities; XL clearly bigger.
6. Hebrew track: right to left, punctuation at the left, outline lines up.
7. Raised: cue about a fifth up; above the bar when the bar shows; Lower drops it back.
8. ⚙ → Audio: first focus on Night mode for a single-dub film; toggling during speech and music gives no click, pop or dropout; night mode quiets loud parts and lifts speech; dialogue boost clearer voices; `adb logcat -s AuroraAudioFx` shows no "failed".
9. Passthrough title (E-AC-3/AC-3 bitstream): rows read "Not here" with the reason and pressing shows a toast; sound intact; an AAC dub brings the rows back.
10. 5.1 AAC film: dialogue boost brings the voice forward, no silence.
11. Next episode: options carry over from the first second.
12. Regression: subtitle timing buttons, Resync, subtitles off/on, Autoplay, Skip intro marks, Report a problem.
