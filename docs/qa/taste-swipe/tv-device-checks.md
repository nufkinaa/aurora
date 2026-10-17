# Taste swipe on the TV — the Mi TV pass (not done yet)

Branch `feat-taste-swipe`, commit "TV: the swipe taste picker for the remote". Logic
tests (`__tests__/logic/taste-session.test.ts`, `key-release.test.ts`) and `tsc` are
green; nothing below has been seen on a device. Install a QA variant against a local
server (recipe: memory `aurora-tv-qa-mitv-2026-10-06.md`), never nufurora.com; the
local server must run this branch (the `/taste/deck` and `/taste/answer` routes).
Use the test profile only. `adb shell svc power stayon true` after the install.

Reach it: Settings → "Swipe your taste" (first row under the genre chips).

1. **Opens with focus on the card.** The poster is lit (ring), title / year · kind ·
   genres / one line on the right, the legend under it, "0 / 24", Undo dim, Done.
2. **RIGHT = Love.** The card flies right with a LOVE stamp, the next one is there at
   once, "1 / 24". Focus is still on the card (no ring jumps to the toolbar or off-screen).
3. **LEFT = Not for me** (flies left, NOPE) — and the nav rail does NOT open.
4. **DOWN = Haven't seen** (drops down, HAVEN'T SEEN) — focus does not leave the card.
5. **OK = Love** (same as RIGHT). One press = one answer: tap each key 10× quickly and
   check the counter moves exactly 10 (watch for doubles on key-up, focus.ts acceptTvEvent).
6. **Hold RIGHT** for ~2 s: answers come one per repeat at most, never a backlog that
   keeps flying after release; no frame stalls (logcat / the perf overlay).
7. **UP** goes to the toolbar (Undo / Done). **DOWN from the toolbar back onto the card
   must NOT answer** (pressMovedFocus) — the counter stays.
8. **Undo** (UP, OK on Undo): the last card is back on show and focus returns to it;
   twice → two back. Check on the website (same profile, `#/taste/list`) that an undone
   Love is gone and a "no" that existed before is restored.
9. **Round end:** 24 answers → "24 answers — Home is already using them", the tally,
   Keep going focused. Keep going → "24 / 36" and cards again, focus on the card.
10. **Done / BACK** return to Settings with focus on "Swipe your taste".
11. **Posters** draw at once (the one behind is mounted; two more are prefetched at
    rest) — also in sign-in **closed** mode (the Image-headers rule,
    memory `aurora-tv-image-headers.md`): no blank cards, no 401 in logcat.
12. **Lite box / "Remove animations"** (Android Settings → Accessibility): a quick fade
    instead of the flight; nothing else changes.
13. **Kids profile:** only titles rated for its age (an unrated title never shows);
    an empty deck shows "That's every title we had for you" with Done.
14. Take screencaps of 1, 2 (mid-flight if possible), 7, 9 into `docs/qa/taste-swipe/tv-*.png`.
