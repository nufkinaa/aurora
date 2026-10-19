# Fast start without reshuffling (branch feat-fast-start)

2026-10-20 · commits d18776a (the work), eedd1c0 (test fix). Website measured in real Chrome on a private server; TV passes its tests and builds but is not done until the Mi TV pass (checks below).

## What changed

- **First paint**
  - TV: Home's last answer is kept per profile on the box, read while boot is still finding the server, drawn in Home's first frame (its pictures are still in the image cache). Boot order is unchanged: server found and profile checked first, so kicks, forced resets and the kids lock decide before Home exists.
  - Website: the copy in the browser used to be kept only on slow lines; now on every line, written when idle; the early Home request still goes out in parallel.
- **Who may see a copy:** only this profile (on the TV, only this server); at most 24 h old; at most 4 profiles on a TV, 3 in a browser. Kids: the server sends `X-Aurora-Kids` on every answer it filters for a kids profile (`src/lib/kids.js`); the TV only paints a copy filtered the same way as now, and a differently-filtered newer answer replaces everything at once.
- **The merge rule** (`public/js/homeMerge.js`, copied line for line to `tv-native/src/homeMerge.ts`):
  1. Every shelf from the top down to the last one on screen, and the focused one, keeps its place. None disappears while visible; new or moved shelves go below.
  2. On a visible shelf, cards up to the last visible one keep places and titles; their data (progress, NEW tag) updates in place; the heading stays.
  3. The focused card keeps its place and identity even if the server dropped it.
  4. The billboard keeps the slide on show; while visible its list stays; off screen it takes the new list with the current slide pinned.
  5. Everything else takes the new answer at once.

| Moment | Website | TV | What may change |
|---|---|---|---|
| View settles somewhere new | scroll end + 250 ms | focus on another shelf + 700 ms | shelves that left the screen take new data |
| 5 s with no touch/key | yes | yes | visible shelves update slot by slot in place (soft fade on web), no shift, never shorter |
| Home not looked at | leaving Home | another screen on top / app in background | the new answer, except shelves above the viewport and the focused one |

## Numbers (website, real Chrome, 7 runs, medians; shared PC, ±120–400 ms)

| Scenario | Before (master) | After |
|---|---|---|
| Server slow to answer Home (1.5 s): first shelf card, desktop / phone | 1601 / 1605 ms | 235 / 149 ms |
| Fast line, desktop / phone | 147 / 117 ms | 182 / 203 ms (no gain; likely noise, not proven) |
| Slow 3G, desktop / phone | 4872 / 4366 ms | 4783 / 4281 ms (page code decides) |
| Back to Home after the answer changed: visible cards that moved | 14 of 14 / 12 of 12 | 0 / 0 |
| After a reload, once the newer answer lands | not measurable | 0 moved every run |

Bench simplification: Home's answer is delayed by line time but doesn't compete with page code for bandwidth (same for both builds). TV timings not measured; launch steps log under `faststart` in logcat.

## Tests

- Merge rule: 530 before/after Home answers (30 named, 500 generated) — every rule checked on each, a second merge changes nothing, leaving Home yields exactly the new answer; the TV copy gives the same answer on all 530.
- TV logic 553/553 (snapshot storage: age, profile, server, kids isolation, read-ahead; view of what is on screen; a whole launch). tsc clean. Gradle debug + release bundle successful, 0 QA-variant markers.
- Root `npm test` 1864/1864 twice (an earlier run had 4 load failures, each green alone).
- `test/ui/home-fresh.test.js` (8 tests, desktop + phone, both looks) 7 green runs, last 3 in a row after eedd1c0.
- Whole `npm run test:ui` under the lock: 303/304 twice — run A failed this branch's own test (fixed in eedd1c0), run B a sign-in timeout under load (signin 10/10 alone). No fully green full run yet.
- Screenshots looked at for each stage on desktop and phone. The NEW tag on a poster overlaps the FILM tag in that corner — pre-existing card drawing.

## Not verified
- Anything on the TV device, incl. the kids case beyond logic tests.
- Cold start after the process was killed opens on Home (from the copy), not the last screen; a resumed app is already on its screen.

## Files
- Shared rule: `public/js/homeMerge.js`, `tv-native/src/homeMerge.ts`, `tools/home-merge-cases.js` → `test/home-merge-cases.json`.
- Website: `public/js/screens/home.js`, `public/js/components.js`, `public/css/components.css`.
- TV: `tv-native/src/homeSnapshot.ts`, `homeLook.ts`, `screens/Home.tsx`, `App.tsx`, `api.ts`.
- Server: `src/lib/kids.js`.
- Tests: `test/home-merge.test.js`, `test/ui/home-fresh.test.js`, `tv-native/__tests__/logic/home-merge.test.ts`, `home-snapshot.test.ts`, small edits to `fake-xhr.ts`, `profile-scope.test.ts`.
- Bench: `tools/fast-start/bench-web.js`.

## Mi TV checks
QA build (local server first, versionCode above the installed one for the build only, assembleRelease, 0 QA-variant markers after), install, `svc power stayon true`, Claude QA, every adb call in `timeout`.

1. **First launch (no copy):** `adb logcat -c; adb shell am force-stop com.auroratv; adb shell am start -W -n com.auroratv/.MainActivity`; `adb logcat -d -s ReactNativeJS | grep faststart` shows `boot`, `server found`, `profile`, `paint src=network`, `usable t=…`, `fresh merged=no`.
2. **With the copy:** stay on Home ≥10 s, force-stop and relaunch 5×. Expect `paint src=snapshot age=…min`, paint and usable before fresh, then `[home] fresh quiet: moved=0`. Note median `usable t=` with/without copy and `am start -W` total. A screencap ~0.5 s after launch shows shelves with posters, not the spinner.
3. **Nothing moves at the top:** change Claude QA's Home from the website, relaunch TV. Focus on Play: slide and first shelf unchanged ~5 s, then the shelf updates in place without sliding; log `fresh quiet: moved=0`, then `fresh idle`.
4. **Focus deep:** third shelf, fourth card, trigger a rescan: card stays focused and in place (`moved=0`). Press left/right 10 s: nothing updates while pressing; ~5 s after stopping, shelves update in place.
5. **Away:** Details from the billboard, Back: lower shelves may be reordered, the slide is the same. Open a card, Back: focus on the same card, that shelf and those above unchanged.
6. **Resume:** Home button, reopen from the launcher: same screen, no reload flash.
7. **Profile isolation:** another test profile (never elia, jn, Watcher, QA Stream, Dor): first Home `paint src=network`.
8. **Kids (private server only, optional):** make a test profile kids after its copy was kept, relaunch: `paint src=network` or `shown for all, answered for kids:N: taken whole`. No kids PIN on the household server.
9. **Old copy:** after more than 24 h off, the loading screen as before.
