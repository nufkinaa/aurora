# release-next — the Mi TV pass (2026-10-17/18)

Branch `tv-release-next` (master 9b16dc4 = server 1.7.0 + tv-native-deep + feat-audio-subsync + this pass's fixes).
Device: Mi TV MiTV-AFMU0, QA variants vc100–vc103 (never committed; 0 "QA VARIANT" markers after each build).
Servers: the live :4000 (1.7.0) for torrents / one-press Play / an old-server check; a private instance of this
branch on :4300 (own data dir, library paths read from the live config, a synthetic "QA Test Show" and a 3-dub
"Parasite" test file, fresh admin password) for everything that needs this branch's server (tuning defaults,
profile-delete kick, Resync routes, closed mode, temp profiles). Evidence: `%TEMP%\aurora-agents\tv-release-next\`
(shots/, pixels/, bench/, logs/); tables and raw numbers in `bench/` and `pixels/` next to this file.

**Verdict: ready to release** with the defaults below, after the orchestrator's normal release steps. Open items
are listed at the end; none blocks.

## Defects found on the device and fixed on this branch

| # | defect | fix | verified |
|---|---|---|---|
| 1 | slow start reported as a stall-end lasting the whole wait | `playerRules.ts` stallClock*: stall clock only after the first frame; Player.tsx | logic tests; server log shows `stall at=… queued=27` only for a real outage stall |
| 2 | admin profile delete left its devices signed in | admin.js DELETE kicks first (kickProfile) | must-reset.test.js ×3 modes; device: TV dropped to the wall with "This profile was deleted" (shots 16, 17) |
| 3 | Up next ignored an episode added while playing | Player asks again on `library_updated` (realtime `onLibraryNews`, 1–6 s jitter) and once near the end | device: E5 added mid-E4 → `next episode now library S1 E5 (was none, news)`, Up next "S1 E5" (shot 15) |
| 4 | play marks lost in an outage | api.ts holds ≤30 marks (6 h) and sends them on the next answered request | logic tests; device: server stopped 2.5 min mid-film → `[play] … stall … queued=27` arrived after restart |
| 5 | **new** hero "Stream" (one-press Play) on a title NOT on disk dropped after 12 s | Detail.tsx: "not in the library" now settles `libSettled` | device: `pressed for you` after ~1.4 s, film + show S1 E1 streamed while saving (shots 01→02) |
| 6 | **new** "first available" picked "English (SDH)" over the ★ "English 4" | subTracks.ts autoPick: first language's best track (★, full over SDH/forced) | subs-pick test |
| — | tuning defaults | tvtuning.js `DEFAULT_PLAYER` {1000, 5000, resumeAtSource} unless config.json sets keys | tests; device on :4300: first frames logged `buf=1000`, resume opened at the source |

## The pass (phase / item → result)

| phase / item | result | evidence |
|---|---|---|
| A-1 held LEFT/RIGHT (switches off) | PASS by eye (no late card in the 15 fps recording); `[row] behind` printed 8× (held RIGHT at the shelf end / fast LEFT) — logging only, no blank card seen | logs/logcat-pass.txt, shots/a1-* |
| A-2 hero Stream / Play film / Play show | FAIL→fixed (#5); after the fix PASS (film, show S1E1) ; BACK→title page→Home PASS | shots 01–03 |
| A-3 Continue Watching one press | PASS (player at once, no title page) | shot 04 |
| A-4 Settings first focus | PASS (Action chip ringed, no jump) | shot 05 |
| A-5/A-6 taste swipe | NOT RUN (time) | — |
| B-1/B-2 one press F3, second Play same hash | PASS (job "by Claude QA", same infoHash, no "already on its way"); cancelled+dismissed | logs/jobs.txt |
| B-3 S1 Play | PASS (S1 E1 streamed while saving). Note: the E1 download COMPLETED before the cancel landed — see end state | jobs.txt |
| B-4 episode card you don't hold | PASS (only downloads, focus stays, no player); cancelled+dismissed | shots/b4-* |
| B-5 "Started by" | NOT RUN | — |
| C-1 gear menu walk, edges, dub tick | PASS (inside the screen, focused row visible, edges inert, ticked "Russian" reopens ticked) | shots 06–08 |
| C-2 subtitle / speed / party menus | PASS | shots 09, 10 |
| C-3 copy-job clock | PASS on TV (`copy job at 18: clock starts at 10.33`, resume not ahead); website half NOT RUN | logcat |
| C-4 delay ±0.5/±5, reopen, Reset | PASS (instant both ways; restored on reopen; Reset 0.0) | shots 13, 14 |
| C-5 cue above the scrubber | PASS (cue lifted with chrome up, back down hidden) | shots s1-pre, r2-where |
| C-7 / F-4 remux goodbye | PASS (`[remux] its viewer left` within 1 s, open and closed mode) | srv.log |
| C-6, C-8–C-12 | NOT RUN (busy-server, torrent transcode, credits) | — |
| D-1–D-4 popups / person / kids / density | NOT RUN (time) | — |
| E native switches on: cold start, shelves, hold, Detail↔BACK, dev panel | PASS; one open finding (below, pre-existing, same in JS) | shots 25, 26 |
| F closed mode on :4300 | PASS: Home/shelves/Movies/billboard drew with switches on and off, pairing by code, resync, sidecar cues; `[auth] 401` count 0 throughout; back to "transition" and verified | shots 19–24 |
| subtitle-sync 1/2 (Resync, finish) | PASS on Night Hunter: `against audio 0 → applied (Moved 16 s later)`, cues reloaded once, toast in server words | shot 12 |
| subtitle-sync 4 (no match) | PASS ("Couldn't match — kept as it was", timing unchanged) | shot 11 |
| subtitle-sync 6 (second dub) | PASS (`against audio 2` with the third dub playing) | logcat |
| subtitle-sync 7 (★ rows) | PASS (gold ★ + "Matches this release", one per language, "Embedded" clear) | shot 10 |
| subtitle-sync 10 (old server) | PASS on live: "This server can't match subtitles to the audio yet — re-downloaded the track, delay reset to 0.0s" | shot 29 |
| subtitle-sync 11 (closed mode) | PASS (resync applied, 0 401) | srv.log |
| subtitle-sync 3, 5, 8, 9, 12 | NOT RUN | — |
| G pixels | PASS — table below | pixels/ |
| H frames | done — decision table below | bench/ |

## Pixels (Claude QA, trailers off; pixelmatch run.py / strict.py)

| set | result |
|---|---|
| 3a JS vs native (92 states + 15 app) | 0 px on every state except a 3/21-px difference caused by the synthetic art-less "QA Test Show" card (its tile title under the label); with that card removed the retaken states are 0 px. Trace-only fails: `row.tx` (production JS has no row trace), `navrail` slide timing, app `rail-to-settings` / `movies-grid-hold` focus tables (the lab's known ones, 0 px) |
| 3b ccsu vs none (11) | run.py 11/11; strict: none > 8/255, max 7/255, 125–1010 px > 1/255 (the lab's known layer difference: ≤ 994, max 7) |
| 3d noise floor rec vs rec (33) | 0 px everywhere |
| 3c pool (33) | 32/33; `row/offset-5` failed once (the upper shelf's content changed between A and B), retaken ×3 → 3/3 at 0 px; `pool-wrap-shadow` 0 px |
| 3r ringshare (47) | 47/47, **0 differing px** |
| 3h herotext (48, 2 runs) | 50/50 run.py; strict max 2/255, 68–112 px > 1/255, identical in both runs (the layer's fractional offset) |
| 3t cardtext, 3k keyrate | not run: both stay off on the frame numbers |

## Frames (4 interleaved rounds per cell, cold start per run; medians; "lower n/4" = rounds better)

| switch (vs base) | gate result | key numbers | decision |
|---|---|---|---|
| recommended (5 native + cardlayer, cull, shadowcache, unstuff, pool) vs JS | every scenario better | janky S1 4.6→1.6 %, S2 10.5→3.6, S3 7.1→4.6, S4 4.1→3.5; p90 36→24 / 48→29 / 36→29 / 44→36 ms; RT −3.9..−8.1 ms/frame; PSS −61..−112 MB; L1 frames > 32 ms 543→43 (sum), > 64 ms 54→0; under load S2 15.3→4.1 % | **ON** |
| pool (rec vs ccsu) | L1 frames > 32 ms lower 4/4 (63→43), p99 −3 ms; S1/G1 not worse | | **ON** (kept in the preset) |
| ringshare vs rec | "everywhere" holds (hold-bench S1 +0.38 pt was not repeated: re-run S1 −0.03, G1 −0.72); RT lower in every scenario | views −78 at rest, S2 p99 115→97, G1 frames > 32 ms 84→62, 0 px | **ON** (added to the preset) |
| herotext vs rec | RT ≤ base on S1 (+0.01), lower S2/S3/S4 (4/4 on S3/S4); G1 +0.36 pt is noise (no hero in the grid) | S4 janky 3.5→3.1 (4/4), max 2/255 | **ON** (added to the preset) |
| cardtext vs rec | **fails "everywhere" on G1** (Movies grid): janky +0.58 / +0.71 pt, p90 +1.5 ms in both benches | big wins elsewhere: S2 3.6→2.5 %, p99 115→81, L1 2.1→0.9 %, views −110…−375; without layers S1/S2 −0.7/−2.4 pt | **OFF** (server/dev can enable) |
| keyrate vs rec | **fails**: G1 p90 +2.5 / +2 ms, frames > 32 ms 82→98 / 84→108 | L1 p99 −4, under load L1 frames > 32 52→25 | **OFF** |

Release default in code (`renderRules.ts releaseDefault`): a TV the server says nothing to runs the preset
(above, incl. ringshare + herotext); on a scaled canvas (not 960 dp) without cardlayer/shadowcache unless the
server names them. The server's `tvRender` is the emergency lever (`{"recommended": false}` = all off, `{"pool":
false}` = one). The set is stored at startup and applies from the next launch; on the Mi TV after install:
`impl=FCRHN exp=cardlayer+cull+shadowcache+unstuff+pool+ringshare+herotext src=saved`.

## Open findings (not fixed)

- After a long sequence (rest on the hero ~8 s, DOWN×8/UP×8, holds on shelf 4, open a card), BACK from the title
  page returns Home to the hero instead of the card — **the same with every switch off (JS)**, so pre-existing; not
  reproduced with a short sequence (shot 28).
- `[row] behind` still prints during held keys at a shelf end (8× in A-1, 5× with switches on); no blank card seen
  on screen at 15 fps.
- Shared rings: peak 5–6 made after long holds at the system's ~20/s repeat (plan said ≤ 4 at 15/s); bounded.
- An episode card with no art at all shows its tile title under the label (synthetic file only; real titles have art).
- A finished episode's download that completes before "cancel" stays in the library (see end state).

## End state

TV on QA vc103 of this branch (live :4000 first), Claude QA signed in, release default active (`src=saved`),
stay-awake ON; live auth mode untouched ("transition"); temp profiles were only on the private instance, which is
stopped and deleted (no junctions; `srv`, `srvtmp`, `media` removed); every download this pass started on live was
cancelled + dismissed (`2e440648e6c2`, `4fbcfc6f5628`, `276dc6eda8ff`). **Left for elia:** `4fbcfc6f5628` had
already finished: `E:\Downloads\Shows\Small Prophets (2026)\Season 01\Small Prophets S01E01.mkv` (+ its .srt files)
is in the live library — delete it from the admin page if unwanted (agents do not hard-delete files).
0 "QA VARIANT" markers in tv-native/src.
