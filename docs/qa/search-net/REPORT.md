# Search misses + slow-connection message (branch fix-search-net: 664c652, 684eb21)

## Search said "not found", then found it after coming back (La Cocina)
- A Cinemeta answer after the 2.5 s page deadline came back as an empty `degraded` answer (src/media/discover.js), and search.js:1110 counted it as success → "No results". The late answer was kept by upstream.js, so the next search found it.
- The TV never read `catalogFailed`.
- Typing pauses ("la c", "la coc"…) each asked Cinemeta; five past the deadline opened its breaker (upstream.js:563) → every search and title page failed for 30 s.
- An empty answer made while a fallback (TVMaze, Wikipedia, TMDB) failed was cached for an hour.
Fixes: degraded → `catalogFailed` (also through spoken.js); no caching of failure-empties; search calls use `strike: false` (late ≠ failure; real failures still open the breaker); shared flow public/js/searchflow.js = tv-native/src/searchFlow.ts: local cards at once, "Still searching…", one retry after 1.5 s, then "Couldn't reach the catalogue — try again" (or "…there may be more.") with Try again; recents kept as soon as something is found.

## "Slow connection" at entry
public/js/net.js timed every response alone; during page load posters and modules share the line, so a 10 Mbit/s line read as 1.6–1.9 Mbit/s and the main.js toast fired. Fixes: overlapping responses count as one reading (≥96 kB); server time subtracted via Server-Timing (now on /img too); probe waits for a quiet page (64 kB, re-check 192 kB); a measured slow line must stay slow 20 s over 3 readings (Data Saver / 2G / own setting still immediate); the entry toast is gone — the viewer is told only when the player starts at lower quality, once per session, quiet 24 h after OK.
| Emulated line | Measured | Called |
|---|---|---|
| 20 Mbit/s, 80 ms | 18.6 Mbit/s | fast |
| 10 Mbit/s, 150 ms | 8.2 Mbit/s | fast |
| 800 kbit/s | ~800 kbit/s | slow after ~40 s (was ~5 s) |
TV has no entry-time measure or toast.

Tests: root npm test 1981 ×2; touched UI files 3×; whole test:ui run 2 fully green, run 3 one unrelated signin flake (passes alone ×2); TV jest 684, tsc clean. Not verified: Mi TV, live Cinemeta, real phone networks.

## Mi TV checks (QA variant)
1. "la cocina" + OK: results, no stray message.
2. Cinemeta blocked/slow on the QA server: "Still searching…", then "Couldn't reach the catalogue — try again"; Try again focusable; after unblocking it finds the title.
3. Blocked + a library title: cards stay, "…there may be more." + Try again above; UP from the top row reaches the field/chips.
4. Server stopped: "Couldn't reach the server — check the connection and try again." + Try again.
5. Nonsense word, catalogue up: "No results for “…”".
6. Voice search still searches and fills the field.
