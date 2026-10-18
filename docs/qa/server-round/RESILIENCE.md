# Server round 2026-10-18: resilience and observability (branch srv-resilience)

The goal: the server stays healthy when providers or clients misbehave, and the admin can see why it is slow. It runs on any box: Windows or Linux, Node 20 or 22, behind a reverse proxy or not, with 2 cores or 16.

Measured on a private instance. The live server was never touched.

## In one paragraph

Every call to the outside world now goes through one module, `src/lib/upstream.js`. Each call gets a timeout that covers the whole answer, a fair share per host, a circuit breaker per host, retries only where they are safe, a JSON cache (stale-while-revalidate, stale-if-error, remembered 404s), and a 2.5 s wait for calls a person is waiting on. Answers that arrive after that wait are still kept for the next ask.

Results with the provider hanging, compared with master:

| | master | after |
|---|---|---|
| Title page wait (p50) | 12.3 s | 17 ms |
| Sockets held to the provider | 1,550–2,010 | 16 |
| Cold Home of pictures (p50) | 90 s | 4.5 s |

The HTTP server now:
- drops slow-dripping clients at 20 s (headers) or 120 s (whole request); before, it was 80 s and 300 s;
- caps JSON bodies;
- rate-limits the endpoints that cost provider work or CPU, per device, at at least 3.5× a measured power user. The owner's ruling is enforce; normal use is never refused.

WebSockets get a message cap, a heartbeat, a send-queue limit, a flood limit and a per-address cap. During a WebSocket flood, normal users' p50 was 101 ms on master and 6 ms after.

The admin gets `/api/admin/metrics` and a Server → Health card. config.json is checked at boot. The machine's resources are checked and shown.

## Commits (all local on srv-resilience, from master 4862136)

| commit | what |
|---|---|
| 3f3b4d9 | `lib/upstream.js`, and every outside call site converted |
| efd371a | HTTP server limits (`lib/httplimits.js`), JSON body limits, `lib/ratelimit.js` |
| 0929d80 | WebSocket hygiene (`realtime.js`) |
| 8605e76 | `/api/admin/metrics`, the slow-request log, the Server → Health card (`lib/metrics.js`) |
| 9730d01 | config check at boot (`lib/configcheck.js`), resource checks (`lib/resources.js`) |
| ee6c7f9 | the page deadline only for page work; a degraded search is no longer filed as "no IMDb match" |
| 0e21d1c | X-Forwarded-For only from a trusted proxy, read from the right (rate limits, WS cap, the admission lane); memory and core checks |
| 36d8f91 | fault-injection findings: deadline strikes open the breaker; the search fallback budget; a failed poster search is kept 10 min, not a week; graceful 408 |
| 1f7a23e | rate limits ENFORCED (owner), sized from the power user; the old per-address person budget is removed (behind the proxy it was one budget for the whole site); `tools/resilience/` |
| 5ac0ea2 | WS per-address cap 64, following the rate-limit mode |
| cc58c61 | the page deadline by an explicit `{ waiting: true }` instead of AsyncLocalStorage (~15–20 % CPU per request) |
| 01ec293 | `/healthz` keeps exactly its four loop numbers |
| e6a8021 | pictures never wait on a slow or dead picture host (load-test finding) |
| 540b70e | `upstream.json` parses an answer once (the first caller gets it); the 2-core profile pins the last cores |
| 365fab8 | the AI picks budget per device (it was `req.ip`: one budget for the whole site behind the proxy); reports record the client's address |

## 1. Outside calls: `src/lib/upstream.js`

`upstream.fetch(url, opts)` returns a real `Response` whose body has already been read inside the timeout. `upstream.json(url, opts)` adds the cache. `globalThis.fetch` is looked up on every call, so the tests that stub it still work.

### What each call gets

- **Timeout over the whole answer.** It covers the body too: a host dripping a byte a second is cut off. There is also a size cap (16 MB by default), and a `Content-Length` over the cap is refused without reading.
- **A fair share per host.** At most `concurrency` calls in flight per host (default 6; TMDB 8 with a 256-deep queue; picture hosts 64). Then a bounded queue, then `busy` at once. Sockets per host are bounded.
- **A circuit breaker per host.** It opens after 5 failures in a row: network errors, timeouts, 5xx and 429 count; 404 and other 4xx do not. It stays open for 30 s, doubling up to 5 min. After that, ONE trial call goes through. The breaker also opens when 5 calls are past a page's deadline at once and nothing has been answered since the oldest of them started: a host that never answers stops costing pages within a few seconds, instead of after the first 12 s timeouts. Alerts (ntfy/Telegram) and the health ping use `breaker: false` and are never dropped by a breaker.
- **Retries** only for GET/HEAD, on network errors and 502/503/504/429: at most one by default, after a full-jitter wait (250 ms base, 2 s cap), honouring `Retry-After` up to 2 s, and never while the breaker is open. POSTs are never retried.
- **JSON cache** (`ttlMs`). It is an LRU of 24 MB at most (2 MB per entry). A fresh entry is answered from memory, and each caller parses its own copy. A stale entry is answered at once and refreshed behind it. A failure is covered by the stale entry. A 404 is remembered for 10 min. Callers asking at the same time share one call.
- **Page deadline** (`deadlineMs`). Only call sites a person is waiting on pass it. Past the deadline the caller gets `UpstreamError("deadline")` at once, and the call carries on to its timeout. Its answer is kept in the cache: a "late fill", counted as `lateFills`. Background work (the follows check, IMDb id matching, the library warm-up, Home's hero, newEpisodes, smartdl, mylistdl) passes no deadline and waits for the full answer, as before. This used AsyncLocalStorage at first; that cost about 15–20 % CPU per promise-heavy request (measured), so it is now an explicit `{ waiting: true }` from the routes.
- **Counting.** `lib/signals.provider` now counts every answer in one place; the healer reads it. `status()` gives per host: breaker, failures in a row, in flight, queued, calls, ok, failed, timeouts, refused by the breaker, busy, retries, 404s, deadlines, late fills, cache hits and latency. Never a key or a path.

### Every converted call site

| file | what it asks | timeout | page wait / cache |
|---|---|---|---|
| media/discover.js `fetchJson` | Cinemeta catalog/meta/manifest/search, TVmaze schedule/search, Wikipedia, Wikimedia, TMDB trending/search | 12 s | 2.5 s + 10 min cache when a route asks (`waiting`): title meta, catalogue pages, genres, catalogue search, the live part of /api/search |
| media/online.js `fetchJson`, `cachePoster` | TVmaze singlesearch, TMDB search/details, Wikipedia; poster images | 12 s / 15 s, 12 MB | background; its own 429/403 back-off kept, upstream retries 0 |
| media/person.js `getJson` | TMDB people, credits, find | 7 s | 2.5 s, 10 min, 404 remembered |
| media/xray.js `getJson` | Cinemeta, TVmaze, TMDB, Wikidata SPARQL | 7 s | 2.5 s, 10 min; an answer built while a provider failed is kept 10 min, not 14 days |
| media/similar.js `tmdb` | TMDB find / external_ids / collection / credits / discover | 8 s | 2.5 s, 10 min; a row built while a call failed is kept FAIL_TTL (30 min) |
| media/vibe.js `tmdb` | TMDB (~45 calls per row) | 8 s | retry 1 by upstream (was its own) |
| media/recs/tmdb.js `get` | TMDB (daily sync) | 9 s | its own retry kept |
| media/availability.js | TMDB find / watch providers | 8 s | — |
| media/certification.js | TMDB release dates / content ratings / details | 6 s | — |
| media/trailers.js `getJson` | Wikidata, Apple TV API | 8 s | (test seam kept) |
| media/skipsegments.js | SkipDB, TheIntroDB | its TIMEOUT_MS | — |
| media/websubs.js `fetchJson`, `fetchSrt` | OpenSubtitles addon, Wizdom search; subtitle files | 12 s / 20 s, 8 MB | 4 s (the player's subtitle menu), 30 min cache |
| media/wellknown.js | Cinemeta top lists (weekly) | 15 s | — |
| media/posterfallback.js | Cinemeta, TVmaze, TMDB, iTunes | 8 s | 3 s; a search that ended while providers failed is kept 10 min (was 7 days) |
| media/torrent.js `fetchJson` | torrent source providers | 12 s | — |
| media/downloads.js `saveCover` | cover image | 15 s, 12 MB | — |
| media/ai.js `callModel` | OpenRouter | 45 s, 2 at once | POST, no retry |
| lib/healer-checks/ai.js | OpenRouter | its timeout | — |
| routes/stream.js `fetchExtImage` (/img/ext) | picture hosts | 15 s, 6 MB | the card waits 4 s at most, the picture lands on disk later |
| routes/auth.js | Google device code, token (×2), tokeninfo (×2) | 8 s | no retry |
| lib/notify.js | ntfy, Telegram | 10 s | breaker off |
| lib/push.js `tickle` | web push services | 10 s | — |
| lib/health.js `pingOnce` | healthPingUrl | 10 s | breaker off, no retry |
| routes/proxy.js `/proxy` | the TV browser's page fetch (http.request with the SSRF-guarded lookup) | now 30 s for the whole answer + 25 MB cap (was only a 20 s socket-idle timeout) | not through upstream: it streams pages |

**Left as they are, on purpose:**
- `lib/healer.js checkUpstream`: the healer's own reachability probe must see the raw truth.
- `lib/blurup.js`: the server asking itself.
- `media/aria2.js`: local RPC.
- `lib/updatecheck.js`: `git ls-remote`, already 5 s.
- Trackers and DHT: webtorrent internals, the srv-streaming lane.
- YouTube trailers: resolved on the device.

### Pages that can show empty or partial on the FIRST ask while a provider is slow (over 2.5 s)

Each of these is answered at once on the next ask from the late fill, and every one already handled provider errors before this round.

- **Catalogue title page** (`/api/discover/meta`): the 502 the client already handles.
- **Browse catalogue page** (`/api/catalog`): an empty page, not cached.
- **The genre chips**: the previous list, or empty.
- **Catalogue search**: TVmaze/TMDB/Wikipedia fallbacks within what is left of ~3 s; not kept for the hour.
- **The live (catalogue) half of `/api/search`**.
- **Person sheet**: partial (kept 30 min by person.js's own PARTIAL_TTL) or an error.
- **X-Ray**: partial, kept 10 min.
- **More like this**: the local/genre fallback, kept 30 min.
- **The player's subtitle menu**: the web subtitles missing (waits 4 s).
- **Cards whose picture is not on disk**: the placeholder (waits 4 s).

Home, the library, the library title pages and playback do not depend on a provider.

## 2. HTTP server limits

All in `lib/httplimits.js`, overridable as `"http": {…}` in config.json.

- **keepAliveTimeout 75 s (unchanged).** Above nginx's 60 s upstream keep-alive, so the client side closes first.
- **headersTimeout 20 s (was 80 s), requestTimeout 120 s (was Node's 300 s), connectionsCheckingInterval 2 s.** Node's default check interval is 30 s, which turned a 20 s limit into a 20–50 s one.
- **Proved on Node 20.18 and 22.13, on Windows and in WSL Ubuntu** (`test/httplimits.test.js`):
  - an idle keep-alive connection is NOT cut by headersTimeout, so the 2026-10-08 laggy-TV fix stands;
  - an answer that streams for longer than requestTimeout is never cut;
  - a WebSocket that stays open past requestTimeout is not cut;
  - a connection that never sends a byte gets its 408 at headersTimeout from Node itself, so no reaper of our own is needed.
- **Graceful 408/431/400.** A request the parser gives up on is answered and the socket ended. It was not ended before: Node's default writes the answer and destroys the socket at once, and on Windows the 408 was often lost to the reset.
- **maxConnections** is set from the open-file limit on Linux: soft limit − 256, so handles stay free for files and ffmpeg.
- **JSON bodies:** 100 kB, 16 kB under `/api/auth/`. A body too large gets 413 JSON; malformed JSON gets 400 JSON. One log line a minute at most; they used to be a stack trace each.
- **X-Forwarded-For** is believed only from a trusted proxy: this machine, or `"trustProxy": ["172.17.0.1", "10.0.0.0/8"]`. It is read from the right, skipping trusted hops, so a client cannot name itself. The admission lane's client key uses the same rule now; before, it trusted any header's left-most hop, so one device could make itself many clients. `test/stampede.test.js`'s expectation was updated for this.

### Rate limits (`lib/ratelimit.js`): enforced, per device, only where a call costs something

The owner's rules (2026-10-18): enforce, about 10/s per device, and NORMAL USE IS NEVER REFUSED.

**What is limited:**
- search;
- suggestions;
- catalogue/discover: the catalogue pages, genres, trending, More like this, collections;
- people;
- X-Ray and trailers;
- picture-host MISSES only (`/img/ext`, `/img/poster`, never a picture on disk);
- Subtitle Resync;
- the web proxy.

**Never limited:** Home, the library, Movies/Shows/My List, title pages (`/api/discover/meta` too), playback, progress, downloads, settings, kept pictures, and the server's own blur-up reads.

**Key:** a live session (a made-up one counts as its address). A device that is not signed in is keyed by its address, and a LAN address gets 4×. On the house LAN in open mode every device has its own address; on nufurora.com every device has a session.

The final limits, and the power user they were sized from: `tools/resilience/poweruser.js`, 10 minutes per pattern, two signed-in devices behind one address. Each device, all at once:
- a screen every second;
- a 10-letter search at 10 letters a second every 3 s — /api/search ×2 phases + suggestions + the catalogue search per letter, with no debounce, which is worse than the website's 180 ms;
- 10 title pages and 10 person sheets in a row every 20 s;
- the Movies grid flung every 2 s: 50 (web) / 80 (TV) new pictures;
- TV only: focus prefetch of meta and More like this 5× a second.

Peak per device, as "peak in any 1 s / peak 10-second average per second":

| group | web peak | TV peak | burst | rate/s | headroom (burst, rate) |
|---|---|---|---|---|---|
| search | 30 / 11.4 | 20 / 7.8 | 120 | 40 | 4×, 3.5× |
| suggest | 10 / 3.8 | 10 / 3.9 | 120 | 30 | 12×, 7.7× |
| catalogue | 11 / 3.4 | 16 / 8.3 | 90 | 30 | 5.6×, 3.6× |
| person | 4 / 1.0 | 4 / 1.0 | 40 | 10 | 10×, 10× |
| xray (+trailer) | 10 / 2.4 | 10 / 2.4 | 60 | 20 | 6×, 8.3× |
| img-fetch (misses) | 50 / 25 | 80 / 40 | 300 | 150 | 3.8×, 3.8× |
| resync | – | – | 30 | 10 | (a button) |
| proxy | – | – | 300 | 50 | (a TV browser page is many requests) |

**Results:**
- 51,972 (web) + 77,710 (TV) requests: **0 refused** (that count includes the admission lane's 429s).
- A hammer (200 searches a second for 5 s, signed in): 621 of 940 refused with 429 + Retry-After.
- The UI test "two signed-in devices behind one address at a power user's pace for 15 s" passes: 0 refused.

`Retry-After` is at most 5 s. The website (`public/js/api.js`) retries a GET's 429 twice, honouring Retry-After (it waits up to 5 s), with no toast. The TV (`tv-native/src/api.ts` + `serverManners.tooManyWait`) retries GETs twice, up to 10 s. Resync is a POST, so it is not retried; a 429 there needs a button pressed 30 times.

`"rateLimits": "log"` is the off-switch: nothing is refused, would-refuse is counted. Per-group overrides go in `{ "groups": { "search": { "rate", "burst", "mode" } } }`.

**Removed:** the old per-address people budget in `routes/api.js` (40 a minute keyed on `req.ip`). Without "trust proxy", every visitor of nufurora.com shared that ONE budget.

**Changed the same way:** `routes/ai.js` had the same per-`req.ip` pattern (10 AI asks a minute). It is now per device, keyed like the rate limits. The budget itself (it spends money) is unchanged.

**Other ad-hoc limits, checked:**
- the sign-in, sign-up, claim, pair and PIN attempt limits in `routes/auth.js` and `routes/profiles.js` key on `realtime.clientIp`, which uses X-Forwarded-For's first hop. Behind the proxy that is per real client, not shared, so they are left as they are. Their spoofability (a client can rotate the header) is noted for the owner: these are attempt limits, and the owner handles authentication;
- `lib/viewer.js` uses `req.ip` only for viewers that are not signed in, which happens only in open mode on the LAN, where there is no proxy.

The power user opens 10 person sheets every 20 s per device (2 devices behind one address), which is 60 a minute from one address. The old 40-a-minute per-address limit would have refused that; it gets 0 refusals now. The UI test also asks for 45 in a row.

## 3. WebSocket hygiene (`realtime.js`)

- **Messages:** maxPayload 64 kB (ws's default was 100 MB). An oversize message closes the socket with 1009.
- **Heartbeat:** a ping every 30 s. A peer that has not answered the previous ping is terminated. Browsers and the TV's OkHttp answer by themselves.
- **One `send()` for every message:**
  - a broadcast is skipped for a socket with more than 1 MB waiting to go out;
  - a socket with more than 8 MB waiting is ended;
  - so a slow reader cannot grow memory.
- **Messages per socket:** 50 a second, 200 at once. Over that they are dropped, and 1000 dropped within 10 s closes the socket with 1008.
- **Per address:** 64 sockets, LAN 4×, using the trusted-proxy address rule. It follows the rate-limit mode (enforce).
- `wsStatus()` feeds the metrics. `telemetry.js`'s sampler timer is now unref'd: a one-line change in another file, needed by the tests.

## 4. Observability

**`GET /api/admin/metrics`** is admin only, JSON; `?fmt=prom` gives Prometheus text. It reports:
- requests per route GROUP: the request's shape (`/api/item/:id`; a word the server does not route on becomes `:id`, so a title never becomes a group), at most 300 groups;
- per group: count, 2xx/3xx/4xx/5xx/aborted, in flight, and a time-to-first-byte histogram (first byte, because a film streams for an hour on one request);
- event loop p50/p99/max;
- CPU % and memory;
- work in hand: streams, encoders, torrents and peers, the heavy lane, the picture-variant queue, the CPU budget's waiting jobs;
- upstream hosts and cache;
- rate-limit counts per group, WebSocket hygiene, the HTTP limits in force, and the boot checks.

**The slow-request line:** a request whose first byte takes over 1 s is logged as `[slow] GET /api/home 200 first byte after 1234 ms — compose 1100 (made), event loop blocked up to 300 ms lately`. It carries the route's own Server-Timing steps. One line per group per 10 s at most, with a count of the rest.

**The admin Server → Health card** (the watchdog's old card is now titled "Watchdog") shows:
- event loop, CPU and memory;
- requests in hand, streams, encoders and torrents;
- answers, slow ones and 5xx;
- the heavy lane;
- outside services, with their breakers;
- the boot checks;
- the slowest routes;
- rate limits and live sockets.

It was checked in real Chrome at 1280 px and 390 px. At 390 px the document is exactly the screen width (asserted). The table rows become stacked cards, at most 6 services and 5 routes.

## 5. Config check at boot, and resources

**Config check.** `lib/configcheck.js` holds a schema of every key `config.js` reads (about 40).
- An unknown key is a warning with a did-you-mean (`prewarmStream` → `prewarmStreams`).
- A bad value is REFUSED: it is taken out before the server reads it, so its default applies, and the log line names the key, the reason and the default. For example, `"torrents": "false"` in quotes used to mean ON.
- A number written in quotes is a warning and still used.
- It never crashes the server (a crash would mean a keeper crash loop).
- It never repeats a secret's value.
- The production config.json was checked read-only: no problem.

**Resources.** `lib/resources.js` checks, on Windows and Linux:
- the Node version (≥ 20);
- cores and memory: available memory is MemAvailable from `/proc/meminfo` on Linux and freemem elsewhere, plus the heap limit;
- the open-file limit from `/proc/self/limits` on Linux. A limit under 4096 warns, with the LimitNOFILE / ulimit advice. Above 80 % in use is critical. The limit also sets maxConnections;
- free disk where the data lives;
- the config check's result.

These are said once in the log at boot and shown on the Health card. They are not sent through the health alerts, so a config typo never pages anyone.

## Fault injection (tools/resilience/faultinject.js)

A fresh private instance per scenario. A local FAKE UPSTREAM stands in for every provider (`tools/resilience/preload.js` routes them to it); the server's code still sees the real host names. The upstream behaves as answering (20 ms), 500, never answering, or dripping a byte a second.

Throughout each scenario:
- **6 normal users** loop on the library, a library title, `/healthz` and a script file;
- **8 page users** (upstream scenarios) loop on catalogue title pages and searches;
- the fake counts the sockets the server holds to it;
- the instance's CPU, event-loop delay and memory come from the preload's side door.

The stalled-client cases:
- **slowloris:** 300 header drippers + 200 body drippers;
- **idle sockets:** 1,500 connections that never send a byte;
- **WS flood:** 20 sockets sending as fast as they can, + 5 messages of 2 MB.

"before" = master 4862136 (exported, its own node_modules), "after" = this branch. Medians of the runs; the PC was shared with other agents throughout, so wall-clock numbers are noisy.

### Windows 11, 16 cores, Node 22 (medians; before: 4 runs, after: 3, interleaved)

| scenario | normal p50 / p99 / max (before → after) | page wait p50 / max (before → after) | sockets to the provider, max (before → after) | provider requests (before → after) | event loop p99 / max (before → after) | server CPU (before → after) | requests answered to normal users (before → after) | notes (after) |
|---|---|---|---|---|---|---|---|---|
| baseline (4/3 runs) | 11 ms → 12 ms / 51 ms → 70 ms / 393 ms → 1.0 s | 44 ms → 63 ms / 523 ms → 1.3 s | 21 → 14 | 3763 → 2735 | 61 ms → 80 ms / 344 ms → 1.0 s | 16.9 s → 18.6 s | 7723 → 6806 | {} |
| up-500 (4/3 runs) | 16 ms → 17 ms / 57 ms → 102 ms / 275 ms → 765 ms | 37 ms → 17 ms / 467 ms → 764 ms | 33 → 14 | 9003 → 28 | 61 ms → 98 ms / 254 ms → 743 ms | 17.2 s → 16.5 s | 5585 → 5407 | {} |
| up-hang (4/3 runs) | 11 ms → 6 ms / 104 ms → 57 ms / 348 ms → 231 ms | 12.3 s → 17 ms / 16.4 s → 3.2 s | 1550 → 16 | 2235 → 25 | 134 ms → 75 ms / 386 ms → 226 ms | 20.0 s → 19.6 s | 6744 → 14424 | {} |
| up-drip (4/3 runs) | 15 ms → 6 ms / 201 ms → 42 ms / 482 ms → 445 ms | 12.3 s → 15 ms / 16.4 s → 3.4 s | 2010 → 16 | 2503 → 25 | 97 ms → 63 ms / 435 ms → 416 ms | 22.8 s → 17.8 s | 4940 → 14160 | {} |
| slowloris (4/3 runs) | 5 ms → 6 ms / 38 ms → 48 ms / 300 ms → 314 ms | – | – | – | 53 ms → 68 ms / 330 ms → 312 ms | 24.4 s → 28.7 s | 23476 → 22239 | {"slowSockets":500,"closedByServer":300,"closedAfterMsP50":21706} |
| idle-sockets (4/3 runs) | 5 ms → 5 ms / 25 ms → 25 ms / 238 ms → 253 ms | – | – | – | 33 ms → 36 ms / 232 ms → 238 ms | 28.8 s → 29.9 s | 29522 → 29715 | {"idleSockets":1500,"closedByServer":1500} |
| ws-flood (4/3 runs) | 98 ms → 6 ms / 388 ms → 41 ms / 570 ms → 393 ms | – | – | – | 28 ms → 59 ms / 423 ms → 294 ms | 16.1 s → 17.2 s | 843 → 13423 | {"wsCloses":{"1008":20,"1009":5}} |



### Pinned to 2 cores (the machine's last two) with a 384 MB heap, two interleaved pairs

| scenario | normal p50 / p99 (before → after) | page wait p50 / max (before → after) | sockets to the provider (before → after) | provider requests (before → after) |
|---|---|---|---|---|
| baseline | 20 / 120 ms, 9.5 / 79 ms → 25 / 142 ms, 5.5 / 42 ms | 76 ms, 47 ms → 100 ms, 51 ms | 17, 21 → 14, 14 | 2469, 3548 → 1810, 3643 |
| up-500 | 26 / 185 ms, 20 / 108 ms → 13 / 66 ms, 16 / 107 ms | 66 ms, 56 ms → 13.5 ms, 16 ms | 33, 28 → 14, 13 | 5191, 6053 → 27, 28 |
| up-hang | 11 / 244 ms, 10 / 179 ms → 6.3 / 74 ms, 6.4 / 77 ms | 12.3 s / 16.4 s, 12.2 s / 16.3 s → 22 ms / 3.3 s, 30 ms / 3.2 s | 2374, 1835 → 19, 19 | 2467, 2024 → 25, 25 |
| ws-flood | 482 ms / 22.4 s (42 answered in 20 s), 73 / 513 ms → 17.5 / 176 ms, 5.5 / 57 ms | – | – | – |

On a small box the difference is largest exactly where a box is weakest: during a WebSocket flood master answered 42 normal requests in 20 s (p99 22 s), after 4,530–12,439. (An earlier 2-core pair pinned to cores 0–1, which the OS and the other agents' work share, was too noisy to read: probe failures on both sides — discarded.)

What it shows:
- **Provider hanging or dripping.** Master made title pages wait 12–16 s and held 2,000+ sockets to the provider. After: pages answer in tens of ms (the first few wait ~2.5 s until 5 calls are past the deadline and the breaker opens), and the server holds about 16 sockets.
- **Provider answering 500.** Master kept asking it about 9,000 times in 20 s; after, 28 times. Normal users' p99 rose from 57 to 102 ms in this scenario. The page users loop as fast as they are answered, and failing fast they made about twice as many page requests in the same 20 s (5,252 against 2,517 in the first pair). That is an artefact of the closed-loop harness: a person does not re-press instantly. Watch it in the load-test agent's open-loop runs.
- **Slowloris.** The 300 header drippers are closed with 408 at ~22 s (master: none within the run; its limit was 80 s). The body drippers are held to 120 s. Normal users are flat.
- **Baseline (nothing wrong).** Within the noise of a shared PC. After saw fewer page users' answers in one run and more in another. A microbenchmark of this round's middlewares (metrics, rate-limit group test) on a promise-heavy route measured ~3 % more CPU per request, within its own noise. The AsyncLocalStorage version had measured 15–20 % and was replaced (cc58c61).
- **Idle sockets.** All 1,500 are closed at ~20 s (master: none).
- **WS flood.** Master's normal users waited ~100 ms p50 while it parsed every message. After: the 20 flooders are closed with 1008, the 5 oversize messages with 1009, and normal users are at ~6 ms p50.

### Pictures (tools/resilience/picbench.js; the load-test agent's A/B found picture p95 up on an earlier commit)

16 households, each a browser with 6 connections. Each opens a cold Home (45 shared + 10 own /img/ext misses at w=240, + 6 /img/poster), then the same Home again twice. The picture host is fast (20 ms), slow (800 ms), down (refused) or hanging.

| host | master cold Home p50 / p95 | e6a8021 cold Home p50 / p95 | next Home p50 (master → e6a8021) |
|---|---|---|---|
| hanging | 90 s / 167 s | 4.5 s / 8.1 s | 0.4 s → 0.3 s |
| down | 0.44–0.54 s / 1.0–1.6 s | 0.46 s / 0.96–1.1 s | ~0.3 s both |
| fast | 2.1–2.4 s / 3.9–5.4 s | 2.1–2.4 s / 4.6–5.2 s | equal within noise |
| slow | 5.7 s / 12.5 s | 5.7–6.1 s / 12.7–13.2 s | equal within noise |

The cause on the earlier commit:
- the picture hosts' per-host cap of 12 with a 15 s slot wait, which serialized a Home's misses behind a slow or hanging host;
- a re-asked picture waiting a second time for a fetch already in flight.

Now:
- the cap is 64 with a 2 s slot wait;
- a miss waits at most 4 s, counted from when the fetch began, and then the card gets its placeholder while the picture lands on disk;
- misses past their wait strike the breaker.

Pictures on disk never touch `lib/upstream.js`.

## Tests

**New test files:**
- `test/upstream.test.js`: a local fake upstream; timeouts, drip, size cap, breaker open/half-open/close, deadline strikes, slow-but-alive not opened, concurrency cap and busy, GET retry with jitter but never POST, cache fresh/stale/stale-on-error/negative, late fill, abort, the stub seam, no secrets in status;
- `test/upstream-callsites.test.js`: a slow Cinemeta → the page waits ~2.5 s and the late answer is there next time; background waits the full answer; a dead provider → fail fast; a degraded search is not filed as "no match"; no bare `fetch(` left in src;
- `test/httplimits.test.js`;
- `test/ratelimit.test.js`;
- `test/ws-hygiene.test.js`;
- `test/metrics.test.js`;
- `test/configcheck.test.js`;
- `test/ui/server-health.test.js`: real Chrome, a private instance, desktop and phone; metrics admin-only and its shape, 413/400 bodies, normal visit not refused and hammer refused, two signed-in devices behind one NAT at power-user pace never refused, the Health card at 1280 and 390 px with document width = screen. Run 3× in a row, green.

**Touched tests:**
- `test/healer-signatures.test.js`: provider counting is now in `upstream.js`;
- `test/stampede.test.js`: the admission key uses the right-most X-Forwarded-For hop.

**Root `npm test` on Windows, Node 22:** green apart from known real-ffmpeg flakes under load. Run 1: 1662 pass / 1 fail; run 2: 1660 / 3. The `/healthz` key test failure was mine; it was fixed in 01ec293. jit-budget-warm and jit-warm (real ffmpeg, EBUSY/timing under load) pass when run alone.

**Root `npm test` on Linux (WSL Ubuntu, a clone of the branch from a bundle):** Node 22.13.1: 1679 tests, 1626 pass, 0 fail, 53 skipped (no ffmpeg there, as in CI). Node 20.18.1: the same.

**Final rounds on HEAD 365fab8:**

| run | result |
|---|---|
| Root `npm test`, Windows, round 1 (540b70e) | 1662 pass, 1 fail (jit-budget-warm, real ffmpeg; passes alone: 4/4) |
| Root `npm test`, Windows, round 2 | 1663 pass, 0 fail, 16 skipped |
| Root `npm test`, Windows, round 3 (365fab8) | 1663 pass, 0 fail |
| Root `npm test`, Linux (WSL Ubuntu, a clone from a bundle), Node 22.13.1 | 1626 pass, 0 fail, 53 skipped (no ffmpeg) |
| Root `npm test`, Linux, Node 20.18.1 | 1626 pass, 0 fail, 53 skipped |
| Whole `npm run test:ui`, round 1 | 268 pass, 4 fail: boot (a screen timeout), live (two library messages for one burst), subresync ×2 (2.4 s instead of 2.5–2.6 s). All pass alone (boot 7/7, live 6/6, subresync 5/5); the PC was loaded by the other agents |
| Whole `npm run test:ui`, round 2 | 272 pass, 0 fail |
| `test/ui/server-health.test.js` | 3× in a row green, at every stage; real Chrome; screenshots looked at, desktop and phone |

## Owner decisions taken, and what is left

**Decisions taken:**
- **D1, rate limits:** ENFORCE (owner). The limits sit far above heavy normal use; `"rateLimits": "log"` is the off-switch.

**Left:**
- **`routes/ai.js`:** its per-`req.ip` budget is one budget for the whole of nufurora.com behind the proxy. It is not changed here because it protects money: the owner decides.
- **Not converted to upstream.js:** webtorrent trackers and DHT (srv-streaming's lane) and the healer's raw probe.
- **Fault injection was not run in WSL**: the private instance's media is made with ffmpeg, which WSL does not have. The limits themselves were proved on Linux by the unit tests.
- **Files outside this lane, touched minimally:**
  - routes/stream.js: /img/ext and /img/poster;
  - media/torrent.js: fetchJson;
  - telemetry.js: the unref;
  - lib/admission.js: clientKey;
  - lib/looplag.js: detail();
  - media/discover.js, person.js, xray.js and similar.js: srv-eventloop's item 5 (title-page fetch) may touch the same functions, so a merge needs care there.
