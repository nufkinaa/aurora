# Subtitles — the five reports from the admin inbox (fix-subs, from 1.6.100)

Done 2026-10-17. Server and website measured in Chrome on private instances. **The TV parts are logic-tested only, not run on a device** (this branch did not own the TV).

## The timing rig (`tools/subs-rig/`, `node tools/subs-rig/run.js [words]`)

ffmpeg-made films whose every frame shows its own source time as 12 binary bars. Cue *i* runs *i.0–i.8 s* with the text `T<i>`. In Chrome, the page reads each presented frame's bars and compares when that frame's cue is *scheduled* (after every shift the player makes) with when the frame is *shown*. A positive error means the subtitle is late. The instrument's accuracy is about ±0.1 s (a perfect path reads about −0.04 s).

The three films:
- `Sync Direct` — an MP4 that plays as the file itself.
- `Sync Jit` — an MKV with a keyframe every 5 s and AC-3 audio. It plays through the repackaged stream (jit), or through the offset copy job when jit is refused.
- `Sync Late` — the same MKV with every timestamp 1.5 s late.

Each film has an embedded English track and an English sidecar.

## Measured, path by path

| path | before | after |
|---|---|---|
| file · sidecar / · resume 50 s | −0.04 / −0.04 | same |
| jit · embedded / sidecar / far seek / resume | −0.06 / −0.07 / −0.06 / −0.11 | same |
| start 1.5 s · jit | −0.06 / −0.07 | same |
| offset copy · resume 47 s · embedded / sidecar / far seek | −0.04 | same |
| **start 1.5 s · offset copy · resume · embedded** | **−1.53** | −0.04 |
| start 1.5 s · offset copy · resume · sidecar | (same cause) | −0.04 |
| h264 encode (data saver) · resume | −0.06 | same |
| nudge +2.0 / −1.0 | +1.96 / −1.06 | same |
| **TV · offset copy at ss 20/47/71** (5 s GOP, from the server headers) | **5.08 / 2.10 / 1.07 s ahead** | uses `X-Aurora-Base` (needs the device check) |
| **iPhone · fMP4 copy at ss 20/47** (the job's frames decoded) | **5.08 / 2.10 s ahead** | server sends base 14.918 / 44.902 (measured truth 14.92 / 44.90); the web player uses it (not checked on an iPhone) |

## 1. "Track 1 and Track 2"

**Cause.** 209 embedded text tracks in the live library have no language tag and no title (42 in each Silo S03 episode, 38 in Spider-Noir). Only about 20 languages had names. Titles like "SDH" or "Track 1" were shown as names. Dispositions (forced, hearing-impaired) were never read.

**Fix.**
- New `media/subnames.js`: 75 languages in every tag form, plus flags and region qualifiers. Examples: `English (SDH)`, `Spanish (Latin America, SDH)`, an unknown code shown as itself (`XYZ`), duplicates numbered (`English 2`).
- The ffprobe probe is now version 6: dispositions, `handler_name`, the file's start time, the video frame rate.
- New `media/sublang.js`: one ffmpeg pass per file extracts all untagged tracks (into the existing VTT cache), and their language is read from the text. SDH and forced are also detected. This runs in the background, at the lowest priority. Results are kept in `data/sub-langs.json`, and the library is rescanned when names change.
- Tracks now carry `lang` / `forced` / `sdh` / `commentary`; audio tracks carry a `label`.
- Subtitle files inside torrents are named by language and decoded properly (Windows-1255, ASS).

**Measured.** 405 of 406 real sidecars detected correctly (the one miss was a file named `.HI.`, meaning hearing-impaired). Every track in the live VTT cache got a language.

## 2. "Out of sync, especially in Hebrew"

**Causes.**
- The provider files. The chooser took the first two per language. Wizdom returns every file with score 0 in no useful order, and OpenSubtitles' own order put CAM/Telesync files first. Measured against the video's own track:
  - Inception `Hebrew 3`: 55.7 s early, with 24/23.976 drift.
  - Caught Stealing: `English` 28.8 s off, `Hebrew 6` 1.0 s.
  - Knives Out: `Hebrew 3` +0.53 s, `Hebrew 4` −0.32 s.
  - Avatar: two English files with 24/23.976 drift.
  - Ted S1E1: all three Hebrew files 0.25 s off.
  - Silo S03E02 `Hebrew 2` matches nothing (another cut).
- The TV and iPhone copy-job clocks (table above).
- Files whose clock starts late.
- Windows-1255 Hebrew inside torrents, and right-to-left punctuation written for players without bidi support.

**Fixes.**
- `websubs.rank`: candidates ranked against the release being watched (same group, source, service and edition rank higher; CAM/TS last; a different frame rate costs).
  - Downloads now keep the torrent's file name (`job.release`).
  - Streams pass `?release=`.
- New `subsync.repair` when a file is fetched: frame-rate correction (PAL vs film), overrun correction, punctuation fix. It only fixes punctuation when at least 20 % of the right-to-left lines are reversed.
- Background sync jobs line each sidecar up against the video's own text track. They try a set of frame-rate ratios and an offset found by vote, and apply only when at least 30 % of lines match and at least 1.2× as many as before.
  - `/stream/subtitle` serves the corrected version, with the header `X-Aurora-Subtitle-Repair` and `no-cache`.
  - Sidecars that match nothing are moved behind the ones that do.
  - The file on disk is never changed.
- `X-Aurora-Base` now has the file's start time taken out.
- fMP4 copy jobs publish their real start time (`streamprobe.fmp4ClockBase`, which follows ffmpeg's own seek rule).
- The TV uses `X-Aurora-Base` for every content↔media conversion.

**Not done.** Audio-based sync; different cuts; aligning torrent streams; the punctuation fix for embedded Hebrew; the iPhone clock for torrent fMP4.

## 3. "Sync button doesn't work"

In desktop Chrome the buttons did move the cues, on the plain file and on hls.js. What actually went wrong:
- The delay was never saved, so it was gone after the next reload or resume.
- On a phone, the confirmation toast covered the timing buttons.
- A file that drifts can't be fixed with one offset (now fixed at the file, see 2).
- On the TV, the cue lookup could get stuck after a backward nudge.

**Fix.** The delay is saved per title and track (`public/js/subdelay.js` on the web, AsyncStorage on the TV) and restored with a quiet "as you left it" note. Reset or Resync forgets it. No toast while the menu is open. Tests cover all of this.

## 4. "Subs behind the timeline"

**Cause**, measured from Chrome's own cue boxes: Chrome does not support `VTTCue.lineAlign`. The cue started at the dock's top edge and hung down under it (cue box 586–629 px, dock from 598 px).

**Fix.** Where lineAlign is missing, the player aims the cue's top instead: the line minus the cue's own height. Line height is max(1.53 × font size, 6 % of the video height), fitted on three window widths and three cue sizes. Safari and Firefox keep lineAlign. Cues have a minimum size of 15 px (at M). In iPhone native fullscreen, cues go back to the system's own placement (not verified). The UI test checks the cue box ends above the dock on desktop, phone and landscape, and drops back when the controls hide.

## 5. Dor (TV)

Fixed in TV source, all with logic tests:
1. Another profile's "Off" switched subtitles off for every profile on that TV.
2. The auto-pick decided on the first tracks to arrive and never looked again.
3. Person settings that arrived late were ignored.
4. A broken track left nothing on screen; now the next best is tried.
5. The language regexes missed "HEB" and ".heb.".
6. The cue parser dropped some cues.

Also on the server: Silo's "Track N" tracks, where no track matched Hebrew. Checked and not a cause: login-required servers (the wall also reads X-Session), and the cue layer.

## Mi TV device pass

1. **Clock.** Resume an EAC-3 film at about 10:00 on the TV and on the website at the same point. The scrubber and a chosen cue should agree within about 0.3 s. In logcat, look for `copy job at N: its clock starts at …` a few seconds below N. Repeat after a far seek and with a second dub. Check the saved resume point is not ahead.
2. **Delay.** Try ±0.5 / ±5 while playing and while paused: the cue moves at once, backwards too. Reopen the title: the delay is back for that track only. After Reset: 0.
3. **Position.** With the chrome up, a two-line cue sits above the scrubber at S, M and L. With the chrome hidden, the old position.
4. **Dor's case.**
   - Hebrew-default profile, after another profile pressed Off on this TV: subtitles come on.
   - Late-arriving Hebrew on a torrent: "…switched on".
   - Broken track: "…trying another track".
   - Untagged embedded track: "Preparing subtitles…".
5. **Names.** Silo S03 shows languages (after the server's background detection has run once). The audio menu has no "Stereo" or release strings.

## Before deploying

The probe format changed, so every library file is re-probed once in the background. Then untagged and sidecar-bearing files get one low-priority ffmpeg pass each.

## Not verified

The Mi TV, an iPhone, and Safari/Firefox. Provider ranking was checked live for one title only. The background detection and alignment have not yet run on the live library.
