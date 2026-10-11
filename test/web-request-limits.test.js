// The website's requests give up (public/js/api.js "how long a request may
// take"). Before, a server that accepted a request and never answered left
// Home on its skeleton and — for the history read boot waits for — the page
// blank, for as long as the browser cared to wait. Checked here with the
// real module under a stub `fetch` and a clock the test moves:
//   - a request that never answers ends at its limit, once, with an error the
//     screens already handle (it is not retried, and it is not an AbortError);
//   - an answer that has started is ended only by silence, never by its length;
//   - the answers the page asked for early (index.html) are held to the same clock;
//   - a history read that timed out is "could not be read": state.js reports
//     false and does not mark the history as known, which is what the
//     player's refusal to save progress keys on.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const load = (name) => import(pathToFileURL(path.join(__dirname, "..", "public", "js", name)).href);

// A `fetch` whose every call is recorded and answered by the test. A request
// that is aborted rejects with the signal's reason, as the browser's does.
const stubFetch = () => {
  const calls = [];
  const fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const call = { url: String(url), init, resolve, reject, aborted: false };
    calls.push(call);
    if (init.signal) {
      const stop = () => { call.aborted = true; reject(init.signal.reason || Object.assign(new Error("aborted"), { name: "AbortError" })); };
      if (init.signal.aborted) stop(); else init.signal.addEventListener("abort", stop, { once: true });
    }
  });
  return { fetch, calls };
};
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// lets promise chains run between two moves of the clock
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const outcome = (p) => { const o = { done: false, value: undefined, error: null }; p.then((v) => { o.done = true; o.value = v; }, (e) => { o.done = true; o.error = e; }); return o; };

const withPage = async (t, fn) => {
  const real = { fetch: global.fetch, window: global.window };
  const { fetch, calls } = stubFetch();
  global.fetch = fetch;
  global.window = { dispatchEvent: () => true };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await fn({ calls, tick: async (ms) => { t.mock.timers.tick(ms); await settle(); } });
  } finally {
    t.mock.timers.reset();
    global.fetch = real.fetch;
    global.window = real.window;
  }
};

test("the limits: boot's questions 20 s, reads 45 s, the calls that think 90 s, writes 30 s, an upload none", async () => {
  const { requestLimitMs } = await load("api.js");
  for (const u of ["/api/me", "/api/server-info", "/api/profiles", "/api/profiles/abc/state"]) assert.equal(requestLimitMs(u), 20000, u);
  for (const u of ["/api/home?profile=abc", "/api/item/x1", "/api/profiles/abc/today", "/api/profiles/abc/wrapped", "/api/downloads", "/api/changelog?head=1"]) assert.equal(requestLimitMs(u), 45000, u);
  for (const u of ["/api/search?v=2&q=x&wait=1", "/api/torrents/sources?imdbId=tt1", "/api/discover/search?q=x", "/api/discover/catalog/movie/top", "/api/library?profile=a", "/api/xray?id=1", "/api/person/tmdb%3A1?x=1", "/api/ai/status"]) assert.equal(requestLimitMs(u), 90000, u);
  assert.equal(requestLimitMs("/api/ai/recommend", { method: "POST", body: "{}" }), 90000, "thinking is thinking, read or write");
  assert.equal(requestLimitMs("/api/profiles/abc/progress", { method: "POST", body: "{}" }), 30000);
  assert.equal(requestLimitMs("/api/profiles/abc", { method: "DELETE" }), 30000);
  assert.equal(requestLimitMs("/api/profiles/abc/avatar-image", { method: "POST", body: new Blob(["x"]) }), 0, "a file on its way up is not timed");
});

test("Home that is accepted and never answered: an error at 45 s — once, not retried, not an AbortError", async (t) => {
  const { api } = await load("api.js");
  await withPage(t, async ({ calls, tick }) => {
    const o = outcome(api.home("p1"));
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/home?profile=p1");
    await tick(44000);
    assert.equal(o.done, false, "44 s in: still waiting — a slow answer is not a dead one");
    await tick(1000);
    assert.equal(o.done, true, "45 s: given up");
    assert.equal(o.error.name, "TimeoutError");
    assert.equal(o.error.timeout, true);
    assert.match(o.error.message, /took too long/);
    assert.equal(o.error.status, undefined, "not a refusal: nothing here says 401 or 404");
    assert.equal(calls[0].aborted, true, "the request itself was ended, not left hanging");
    await tick(5000);
    assert.equal(calls.length, 1, "a request that got no answer is not asked again behind the screen's back");
  });
});

test("a request that fails outright is still retried twice, and the caller's own abort is still the caller's", async (t) => {
  const { api } = await load("api.js");
  await withPage(t, async ({ calls, tick }) => {
    const o = outcome(api.item("x1"));
    await settle();
    calls[0].reject(new TypeError("Failed to fetch"));
    await settle();
    await tick(600);
    assert.equal(calls.length, 2, "first retry");
    calls[1].reject(new TypeError("Failed to fetch"));
    await settle();
    await tick(1000);
    assert.equal(calls.length, 3, "second retry");
    calls[2].resolve(jsonResponse({ id: "x1" }));
    await settle();
    assert.deepEqual(o.value, { id: "x1" });
    await tick(60000);
    assert.equal(calls.every((c) => !c.aborted), true, "no limit fires on a request that has ended");

    const ctrl = new AbortController();
    const s = outcome(api.suggest("ab", "", 5, { signal: ctrl.signal }));
    await settle();
    ctrl.abort();
    await settle();
    assert.equal(s.error.name, "AbortError", "a newer search replaced this one: silence, as before");
    assert.equal(s.error.timeout, undefined);
  });
});

test("an answer that has started is ended by silence, not by its length", async (t) => {
  const { api } = await load("api.js");
  await withPage(t, async ({ calls, tick }) => {
    const body = (feed) => new Response(new ReadableStream({ start: feed }), { status: 200 });
    // slow but coming: a piece every 25 s for 100 s — far past any limit — arrives whole
    let slow;
    const a = outcome(api.home("p1"));
    await settle();
    calls[0].resolve(body((c) => { slow = c; }));
    await settle();
    const text = JSON.stringify({ rows: ["a", "b", "c", "d"] });
    for (let i = 0; i < 4; i++) {
      await tick(25000);
      slow.enqueue(new TextEncoder().encode(text.slice(i * 6, i === 3 ? undefined : (i + 1) * 6)));
      await settle();
    }
    slow.close();
    await settle();
    assert.deepEqual(a.value, { rows: ["a", "b", "c", "d"] });

    // begun, then nothing: 30 s of silence ends it
    let stuck;
    const b = outcome(api.home("p2"));
    await settle();
    calls[1].resolve(body((c) => { stuck = c; }));
    await settle();
    stuck.enqueue(new TextEncoder().encode('{"rows":['));
    await settle();
    await tick(29000);
    assert.equal(b.done, false);
    await tick(1000);
    assert.equal(b.done, true);
    assert.equal(b.error.name, "TimeoutError");
    assert.match(b.error.message, /went quiet/);
    assert.equal(calls[1].init.signal.aborted, true, "the connection is let go");
  });
});

test("the answers the page asked for early are held to the same clock, counted from when they were asked", async (t) => {
  const { api } = await load("api.js");
  await withPage(t, async ({ calls, tick }) => {
    // asked 5 s ago by index.html, never answered
    global.window.__auroraEarly = { "/api/profiles/p1/state|": { at: performance.now() - 5000, res: new Promise(() => {}) } };
    const o = outcome(api.profileState("p1"));
    await tick(14000);
    assert.equal(o.done, false);
    await tick(1100);
    assert.equal(o.done, true, "20 s after the page asked — not 20 s after boot got round to it");
    assert.equal(o.error.timeout, true);
    assert.equal(calls.length, 0, "and it is not asked a second time for another 20 s");

    // an early answer that FAILED is still asked again the ordinary way
    global.window.__auroraEarly = { "/api/profiles/p1/state|": { at: performance.now(), res: Promise.reject(new TypeError("Failed to fetch")) } };
    global.window.__auroraEarly["/api/profiles/p1/state|"].res.catch(() => {});
    const again = outcome(api.profileState("p1"));
    await settle();
    assert.equal(calls.length, 1);
    calls[0].resolve(jsonResponse({ progress: {} }));
    await settle();
    assert.deepEqual(again.value, { progress: {} });
  });
});

test("a history read that timed out is \"could not be read\": nothing is marked as known, so the player will not save over it", async (t) => {
  const { state, refreshProgress } = await load("state.js");
  await withPage(t, async ({ calls, tick }) => {
    state.profile = { id: "p1", name: "P" };
    state.historyOf = null;
    const o = outcome(refreshProgress());
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/profiles/p1/state");
    await tick(19000);
    assert.equal(o.done, false, "boot is still waiting for the history");
    await tick(1000);
    await settle();
    assert.equal(o.done, true, "20 s: boot goes on without it — no blank page for ever");
    assert.equal(o.value, false, "the read is reported as failed");
    assert.equal(state.historyOf, null, "and the history is NOT known (player.js: historyKnown() === false → it refuses to save)");
    assert.deepEqual(state.progress, {});

    // a later read that answers makes it known again
    const next = outcome(refreshProgress());
    await settle();
    calls[1].resolve(jsonResponse({ progress: { x1: { position: 3000, duration: 6000 } } }));
    await settle();
    assert.equal(next.value, true);
    assert.equal(state.historyOf, "p1");
    assert.equal(state.progress.x1.position, 3000);

    // ...and a read that times out AFTER the history was known keeps what was read (the resume point is real)
    const third = outcome(refreshProgress());
    await settle();
    await tick(20000);
    await settle();
    assert.equal(third.value, false);
    assert.equal(state.historyOf, "p1");
    assert.equal(state.progress.x1.position, 3000);
    state.profile = null;
  });
});
