# Subtitle sync against the film's audio (feat-audio-subsync, on server 1.7.0)

Done 2026-10-17. The owner asked: "Subs resync btn … it needs to really sync the subs." and "Hebrew subs out of sync: can't we adapt them for the release that was downloaded?"

Checked in real Chrome on private instances at desktop and phone sizes, including on copies of two real library files (Ted 1x1, Knives Out). **The TV part is logic-tested only**; the device checks are at the end. Measured on the household's library, read only, on an i7-10700K with the library on a spinning disk. Raw results: `%TEMP%\aurora-agents\feat-audio-subsync\results\`. Tools: `tools/subsync-eval/`.

## In short

- Resync and the background job now line a subtitle up with **what is said** in the film's audio: one offset, a frame-rate fix, or in parts for another cut of the film (which adapts a subtitle made for another release to the downloaded one).
- **Fixed:** 329 of 357 deliberately broken subtitles come back to within 0.2 s (median 0.06 s, p90 0.18 s) — shifts, every frame-rate ratio, scenes added or missing on either side, real cuts of the audio.
- **Wrong:** twice (a short first part of two Ted episodes stayed 20 s off while the rest was fixed).
- **Refused, as it should:** all 29 synthetic controls and all 77 real sidecars of other episodes found in the same folders.
- **Real problem files fixed:** Inception `Hebrew 3` (56 s and the frame rate), Caught Stealing (`English` 29 s, `Hebrew 6` 1.0 s), Knives Out (`Hebrew 3` 0.5 s, `Hebrew 4` 0.3 s), Avatar's two drifting English files.
- **Silo S03E02 `Hebrew 2` is refused:** it matches no part of E01–E05 at any frame rate (another cut).
- **Ted 1x1's Hebrew files are left alone, rightly:** by eye they start on the words; the earlier "0.25 s off" came from Ted's own English track, which leads the speech by about 0.2 s.
- **Speed:** a Resync of a 2–3 h film takes 13–25 s cold (most of it reading the file); an episode 5–13 s; a repeat is instant.

## What the viewer gets

**Resync (website and TV).** The player sends the title, the shown track and the playing audio track to `POST /api/subtitles/resync` (202, works in the background) and polls `…/status`. A pill says "Listening to the film… 40%", then "Matching the lines to what is said…"; playback never stops. Then the server's words: "Moved 0.5 s later", "Matched the frame rate and moved 56 s later", "Matched to this release in 3 parts", "Already in time — nothing to move", "Couldn't match — kept as it was". A correction is fetched at once and that track's ±delay returns to 0; the ±0.5/±5 buttons stay for fine tuning on top. A refusal changes nothing and never overwrites an earlier good result. Corrections are kept per file + subtitle (`data/sub-audiosync.json`) and served at the same address to every device (`X-Aurora-Subtitle-Repair: audio: …`, `no-cache`). **Files on disk are never changed.** The website offers "↺ Use the file's own timing" after a move (`…/undo`); the TV has no undo. Torrent streams and offline copies keep the old reload.

**In the background.** Every sidecar of a library file is lined up with the audio, Hebrew first, provider fetches first in line, through `cpuwork.js` kind `speech` (lowest priority, paused while a viewer is being encoded for, once per file + mtime), applied only when confident. Embedded tracks are only scored (for the ★) and moved only by a Resync.

**The ★.** At most one track per language gets a gold ★ and "Matches this release" (`scanner.starBest`): only the best kind competes (full before SDH; forced/signs/commentary never win); a track inside the file wins its language unless under 20 lines, matched nothing, or found off and not yet moved; otherwise the sidecar that needed the least correction (in time → one offset/fps fix → parts), then the better match; unchecked, unmatched or undone sidecars never get it. The automatic pick (`lang.js` / `lang.ts` `bestTrackIndex`) takes the viewer's language, the lowest kind first, then the ★ track. When the ★ changes during playback the server broadcasts `subtitle_sync`; the player updates by track url, refetches the shown track if its timing changed, and switches to the new ★ only if the shown track was its own pick and nobody picked by hand this session.

## Speech detection

`src/media/vad.js` (JS, worker thread): 8 kHz mono (centre channel when there is one), one speech probability per 10 ms from 25 features (six band levels, spectral flatness, voicing 80–400 Hz, spectral flux, syllable-rate swell, each against the film's own floor/ceiling over ±1 s), logistic model fitted on six items (901,288 frames, label = a line of the item's own English track is on screen), checked on eleven unseen items; 80 ms fixed delay (median subtitle lead). The weights the previous agent left were hand-written (kept in `tools/subsync-eval/legacy.js` for comparison).

| option | held-out AUC | kept? | why |
|---|---|---|---|
| energy gate | 0.669 | baseline | rates a held chord above speech; moved two right files |
| speech-band energy | 0.678 | baseline | same weakness |
| previous hand weights | 0.835 | no | blurred timing |
| **fitted logistic (shipped)** | **0.900** | **yes** | best alignment, no wrong control |
| one hidden layer | 0.909 | no | 6 false accepts vs 2; moved 2 right files |
| WebRTC VAD | — | no | native builds on Windows/CI, no Node 22 prebuilds |
| Silero (onnxruntime) | — | no | 301 MB runtime |

## Alignment (`src/media/audiosync.js`)

Global FFT correlation over seven frame-rate ratios, then piecewise dynamic programming. Fixes over the previous agent's draft: the overlap/drop rule was wrong (dropped 17 real lines, kept 12 fake ones on one case) — boundaries are now placed by the shape of the change; z-score on the sharp part of the correlation (right subtitles z 7.9–72, wrong 1.3–3.8); split price from each subtitle's own noise; every part needs its own evidence (≥ 20 lines, PART_Z 4); only the first 2.5 s of each line is matched; 30-line windows at both ends; "in time" = within 0.25 s, one part, no fps change. Confidence = weakest of global z, the plan's own sharpness and the weakest part; refused below 0.2 (highest wrong score anywhere 0.06, lowest right 0.41).

## Results (17 items, 415 synthetic cases)

| | fixed | mostly | false refusals | false accepts | controls right | median / p90 error |
|---|---|---|---|---|---|---|
| all | 329/357 | 20 | 1 | 2 | 58/58 | 0.06 / 0.18 s |
| tuning items (6) | 124/126 | 0 | 0 | 0 | 17/17 | 0.07 / 0.16 s |
| other items (11) | 205/231 | 20 | 1 | 2 | 41/41 | 0.06 / 0.23 s |

18 of the 20 "mostly" are Ministry, whose own English tracks sit about 0.27 s late against its audio. Lines lost or kept wrongly next to a cut: 2–4 per case.

## Real Hebrew cases

| film | file | verdict | lines within 0.5 s of the film's own English starts |
|---|---|---|---|
| Inception | Hebrew 3 (55.7 s + 24/23.976) | "Matched the frame rate and moved 56 s later" | 20 → 76 % |
| Caught Stealing | English (28.8 s) | "Moved 29 s earlier" | 26 → 83 % |
| Caught Stealing | Hebrew 6 (1.0 s) | "Moved 1.0 s earlier" | 11 → 92 % |
| Knives Out | Hebrew 3 / Hebrew 4 | "Moved 0.5 s later" / "Moved 0.3 s earlier" | 42 → 89 % / 78 → 87 % |
| Avatar | English, English 5 (drift) | "Matched the frame rate" | 33 → 96 % |
| Ted 1x1 | Hebrew 1–3 | in time, left alone | 75 % (English habit) |
| Silo S03E02 | Hebrew 2 | refused (another cut) | 22 % |
| Silo / Ted folders | 77 other-episode sidecars | all refused | — |

Through the real routes on copies: Knives Out Hebrew 3/4 moved as above, the four other Hebrew files "already in time", first Resync 15.5 s cold; Ted 1x1 all six tracks "already in time", 20.8 s cold for the first, then under 1 s each. Menus: Knives Out ★ on "Hebrew 5" and the embedded English; Ted 1x1 ★ on "Hebrew 2" and the embedded English.

## Speed

One ffmpeg reads the file once and copies the audio into 300 s pieces, up to 4 decoded in parallel (2 while a viewer is encoded for); the previous four-readers-at-once draft took 176 s cold on the spinning disk. Urgent Resync 13–25 s for 2–3 h films, 5–13 s for episodes; background 13–36 s per film, once; under full load 2–4× slower by design.

## Failure modes

Short parts in weak evidence (the two Ted false accepts; laugh track reads as speech); each release's own timing habit (moves under 0.25 s are not made — Ministry −0.5 s was called in time); lines next to a cut; search limits ±600 s global, ±300 s per part, seven fps ratios (beyond is refused). Not measured: song/signs-only subtitles, TrueHD/DTS-HD, an idle machine, torrents still downloading.

## Tests

Root `npm test` twice 1615/1615; `vad`, `audiosync`, `speech` 25/25 ×3; `subaudio` (real routes), `substar`, `subpick` pass; `test/ui/subresync.test.js` real Chrome 5/5 ×3 (generated film with voice-like bursts at known times, a held chord, noise); touched UI files pass alone; whole `test:ui` twice 264/265 (a kids and a person-sheet load flake, each 3/3 alone); TV jest 459/459 twice; TV tsc clean.

## Before deploying

Restart the live server for the new routes; afterwards each library file with a sidecar gets one low-priority decode. New data: `data/sub-audiosync.json`, `data/cache/speech/*.u8` (~0.7 MB per two-hour film, capped at 400 files). `/stream/embedded/*` is now `no-cache` (was one day), revalidated by ETag, so a Resync reaches the other devices.

## Mi TV device checks

QA build against a server with the new routes; watch `adb logcat -s ReactNativeJS` for `[player]` lines.

1. Resync: "⟲ Resync subtitles" fits in the menu; the film keeps playing; the row reads "Resyncing…" %, then "Matching…"; with the menu closed "Listening to the film… N %" at the bottom; log `resync: … against audio 0`.
2. Finish: the toast shows the server's words; cues line up with no blank gap; timing shows +0.0s; log `→ applied`, cues reloaded `(again)`, then `subtitle_sync` and no second reload.
3. ±0.5 applies on top; leave and come back — the correction is still there.
4. A track that matches nothing: "Couldn't match — kept as it was", timing and delay unchanged.
5. Back during "Listening…": no late toast, no crash; reopen + Resync joins the same job.
6. Multi-dub film, second dub playing: log says `against audio 1`.
7. ★ in gold with "Matches this release", at most one per language; long labels and "Embedded" do not overlap; Hebrew in Settings + no hand pick → the ★ Hebrew track is on.
8. Resync another Hebrew track from the website: the TV switches with "Switched to … — matches this release"; after a hand pick on the TV it does not switch but still reloads cues if that track was corrected.
9. Torrent stream: the row reads "⟲ Reload subtitles" and does the old reload.
10. Server without the new routes: an honest toast that this server can't match to the audio yet, then the old reload.
11. Closed mode: steps 1, 2 and 7 produce no 401 in the TV or server log.
12. Pull the network 10 s during "Listening…": it finishes when back or ends "Lost touch with the server — kept as it was"; playback never blocks.
