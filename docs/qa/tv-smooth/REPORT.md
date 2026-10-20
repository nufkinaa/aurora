# TV smoothness finish + ten known issues (branch tv-smooth-finish)

2026-10-20 · 15 commits on master 9ecf96f · every TV item checked on the Mi TV twice · evidence in `proof/` (open first), `bench/`, `pixels/`.

## A. The two render switches — both ON in the release defaults

**cardtext.** Slower before because of mount work, not text layout: the grid mounts ~12 cards per batch on a held key and every card carried the ~2 KB decor style twice plus a dozen props it never draws (UI thread +9 % in frames; prop updates +16 %, prop-map reads +25 %, view creation +17 %; frames >32 ms 12/13/12 → 15/17/17). Fix: only cards that draw words, a pill, a bar or a tile title get the decor; it goes native once per launch and cards carry a short key. The pixel diff also caught a real bug: after leaving Continue Watching and coming back its cards drew no title or progress bar (Android frees a shared node's drawing; the cached copy came back empty) — now redrawn. Result: 0 px in all 44 deterministic states, 2 runs each.

**keyrate.** The held-key gate moved focus inside the frame's animation step (frames with >4 ms animation 4.8 % → 14.3 %, the +2–2.5 ms p90). Fix: decide on the frame, move right after it, drop the move if the key came up. 0 px in 7 of 8 held-key states (the 8th isn't repeatable on the harness even preset vs preset). Hold LEFT stops at card 0 without opening the rail; next tap opens it. Held RIGHT stops at the last column; a separate tap opens filters. 10 taps = 10 moves. Overshoot after release on the Movies grid 3 moves (≤106 ms late) → 0; Home shelf interval spread 5.2 → 1.75 ms. User-visible: a held key now moves 15×/s instead of 20.

3 interleaved rounds, cold start each; janky % / p90 / p99 ms, frames >32 ms total:

| scenario | preset (rec / rec2) | + cardtext | + keyrate | both (new default) |
|---|---|---|---|---|
| Home shelf, held keys | 1.1/21/31, 5 — 0.9/20/30, 7 | 0.7/17/25, 0 | 1.0/20/31, 12 | 0.7/18/25, 0 |
| Movies grid, held keys | 2.6/22/42, 68 — 2.6/23/46, 63 | 3.0/23/46, 66 | 2.3/19/38, 39 | 2.5/19/38, 39 |
| Shows grid, held keys | 3.1/22/65, 47 — 3.3/21/85, 43 | 3.1/22/65, 54 | 2.4/17/40, 32 | 3.1/17/44, 39 |
| Home row steps | 3.5/31/101 — 4.4/31/109 | 3.4/26/69 | 4.2/30/105 | 3.4/27/77 |
| Row taps / grid taps / rail | noise | noise | noise | noise |
| Under load (3 cores), shelf | 2.2/25, 23 | — | 1.6/24, 18 | 0.9/21, 3 |
| Under load, Movies grid | 3.7/26, 70 | — | 3.0/20, 39 | 3.2/24, 50 |

Longest Movies-grid frame 126–137 → 95 ms. Caveat: each switch alone has one small long-frame count outside noise (keyrate alone on the Home shelf 12 vs 5–7; cardtext alone on Shows 54 vs 43–47); together they're within noise or better everywhere. The server switch can still turn either off per TV model.

## B. Ten known issues (each on the Mi TV twice)

1. **Late card at a row's end** — 2 GB boxes used the low-memory margin that kept no card behind the direction of travel. Now keeps one behind and commits at once when a visible card is missing. 0 `[row] behind` lines in three passes.
2. **Labels truncated at density 240** — only when density/font changes while running; after a relaunch everything fits at 160/213/240/320, font 1.0–1.3. The app now restarts its JS side on such a change; round-button labels grow at most 15 % with font size.
3. **Detail left scrolled after UP to Resume** — any button in the title area scrolls the page to the top (as the website does).
4. **Faint box behind the hero title** — the shadow was cut at its text box; now spreads. Shots at 160 and 320. With `herotext` off on the server the box still shows on that path.
5. **Kids lock after a closed-mode re-pair** — signing in as a grown-up lifts it (as the server does). Seen twice.
6. **Kids empty Home / genre panel** — "Nothing for this age here yet" with the age in the calm empty style; on Movies the message sits beside the open panel and focus stays in it after a pick.
7. **Downloads error never retried** — retries after 3, 8, 20 s, then every 30 s; clears when the list loads. Tested twice with a private server stopped 55 s.
8. **"O&apos;Connor" on the taste card** — decoded on the server where Cinemeta names come in (fixes TV and website).
9. **subtitle_sync handled 2–3 times** — the server sends one per track; the TV reloads only if that track's timing changed (like the website). Proven twice incl. a server restart while playing.
10. **Focus rings peaking at 5–6** — capped at 4 per screen; measured 1 used / 4 max / 4 made, twice.

## C. Website counterparts
- 8: fixed by the server change; UI test.
- 7: the website never retried and showed "Nothing downloading yet"; now retries the same way and says so; UI test.
- 6: the website told a child to point config.json at media folders; now the TV's wording; UI test. Its genre dropdown closes on a pick, so no panel issue.
- 3: already scrolled to the top.
Checked in real Chrome at phone and desktop sizes (shots in `proof/`).

## Found, not fixed
While a title is playing, the server rejects Resync and undo for every subtitle track of it with "that subtitle is not one of this title's"; the same call works once playback stops. Seen on a private copy of master 1.8.2.

## Tests
- TV logic 534/534 three times; tsc clean four times; Kotlin unit 78 green; every QA build succeeded.
- Root `npm test` 1851/1851 on each of the last three runs.
- Whole `test:ui` under ui-lock, three runs: 10 load timeouts (each file green alone); fully green 298 pass / 1 skipped; one kids "hopping between profiles" 403 (untouched file, 3/3 alone).
- Touched UI files 3× each.

## End state
Mi TV on QA build **vc119** of this branch (live server first), signed in as Claude QA, new defaults active, density 320, font 1.0, stay-awake on. No QA markers in the source. Private server stopped and its folders deleted.

## Commits
10f1053 catalogue text decoded · 0315820 website downloads retry + kids Home wording · 39259de cardtext decor only where drawn · 9988eba keyrate move after the frame; restart on display change · e819470 ring cap 4 · 863bcff no late card at a turn · 84aa626 Detail scroll; label font cap · affff96 hero shadow box; kids Home · 33612bc kids lock after re-pair; message beside the panel · 8b3a3a4 TV downloads retry · c5a7d50 subtitle_sync only on change · 8342ef5 QA harness · 8787008 cardtext empty-decor fix · 51ebb44 both switches in the release default · f07d888 evidence
