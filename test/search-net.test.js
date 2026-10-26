// Search when the outside catalogue is slow or failing (2026-10-26: "Sometimes
// the search doesn't find. I leave the search and come back and then it
// finds. Example: La Cocina").
//
// What happened: Cinemeta's search answered after the page's 2.5 s deadline
// (lib/upstream.js). media/discover.js then made an answer from the fallbacks
// (empty) and marked it `degraded`, but media/search.js took any answer as
// the catalogue's word — `catalogFailed: false`, no results — and the screen
// said "No results for “La Cocina”". The late answer WAS kept upstream (late
// fill), so the next search (leaving and coming back) found it.
//
// Here the real discover.search runs over a stubbed network: nothing leaves
// the machine.
const test = require("node:test");
const assert = require("node:assert/strict");

const upstream = require("../src/lib/upstream");
const discover = require("../src/media/discover");
const engine = require("../src/media/search");
const spoken = require("../src/media/spoken");

const real = global.fetch;
let keep = null;
test.beforeEach(() => { keep = setInterval(() => {}, 1000); }); // (upstream's timers are unref'd)
test.afterEach(() => { global.fetch = real; upstream._internals._reset(); clearInterval(keep); });

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const refused = () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a query nobody else in this process has asked (discover keeps answers for the hour)
let n = 0;
const fresh = (base) => `${base} q${Date.now() % 100000}x${++n}`;
const cocina = (q) => ({
  metas: [{ id: "tt27770001", name: q, releaseInfo: "2024", poster: "https://images.metahub.space/poster/small/tt27770001/img", description: "A kitchen in Times Square.", genres: ["Drama"] }],
});

// The engine over an empty library, its catalogue the real discover.search.
const useRealCatalogue = () =>
  engine._internals._setSources({
    stamp: () => 1,
    libraryItems: () => [],
    imdbIdFor: () => null,
    markLibrary: (list) => list,
    trending: () => null,
    seenTitles: () => [],
    seenPeople: () => [],
    knownTitles: () => [],
    knownStamp: () => "",
    recTitles: () => [],
    facts: () => [],
    liveCached: (q) => discover.searchCached(q),
    live: (q) => discover.search(q, { waiting: true }),
    similarCached: () => null,
    collectionCached: () => null,
    canFetchSimilar: () => false,
    canFetchPeople: () => false,
    remember: () => {},
  });

test("a catalogue slower than the page waits: a failure the screen can retry, never 'no results' — and the retry finds it", async () => {
  useRealCatalogue();
  const q = fresh("la cocina");
  let asked = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (!/v3-cinemeta\.strem\.io\/catalog\/(movie|series)\/top\/search=/.test(u)) return refused();
    asked++;
    await sleep(3200); // past the 2.5 s the page waits
    return jsonRes(/\/movie\//.test(u) ? cocina(q) : { metas: [] });
  };
  const first = await engine.search(q, { wait: true, commit: true });
  assert.deepEqual(first.results, [], "nothing in hand yet");
  assert.equal(first.catalogFailed, true, "said as a failure, so the screen offers to try again — not 'No results'");
  assert.equal(discover.searchCached(q), null, "the empty answer was not kept");

  await sleep(1200); // the late answer lands (kept by lib/upstream.js)
  const again = await engine.search(q, { wait: true, commit: true });
  assert.equal(again.catalogFailed, false);
  assert.equal(again.results[0] && again.results[0].title, q, "found on the retry");
  assert.equal(asked, 2, "one call per kind: the retry was answered from the late fill");
});

test("a catalogue that is down: every ask says catalogFailed, none of them is kept as 'nothing'", async () => {
  useRealCatalogue();
  const q = fresh("la cocina");
  global.fetch = async () => refused();
  const r = await engine.search(q, { wait: true, commit: true });
  assert.equal(r.catalogFailed, true);
  assert.equal(discover.searchCached(q), null);
});

test("a fallback that failed: the (empty) answer is not kept for the hour, so the next ask tries again", async () => {
  const q = fresh("zz no such film");
  let tvmaze = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (/v3-cinemeta/.test(u)) return jsonRes({ metas: [] }); // Cinemeta answered: nothing
    if (/api\.tvmaze\.com/.test(u)) tvmaze++;
    return refused(); // TVMaze, Wikipedia: down
  };
  const r = await discover.search(q, { waiting: true });
  assert.deepEqual([r.movies.length, r.shows.length], [0, 0]);
  assert.equal(r.degraded, undefined, "the primary catalogue did answer: not a failure for the person");
  assert.equal(discover.searchCached(q), null, "but not kept as the hour's answer either");
  const before = tvmaze;
  await discover.search(q, { waiting: true });
  assert.ok(tvmaze > before, "asked again");
});

test("a healthy catalogue that finds nothing: kept, and not a failure", async () => {
  useRealCatalogue();
  const q = fresh("zz nothing at all");
  global.fetch = async (url) => {
    const u = String(url);
    if (/v3-cinemeta/.test(u)) return jsonRes({ metas: [] });
    if (/api\.tvmaze\.com/.test(u)) return jsonRes([]);
    if (/wikipedia/.test(u)) return jsonRes({ query: { search: [] } });
    return refused();
  };
  const r = await engine.search(q, { wait: true, commit: true });
  assert.equal(r.catalogFailed, false, "a real 'no results'");
  assert.notEqual(discover.searchCached(q), null, "kept for the hour");
});

test("voice search: nothing found while a spelling could not reach the catalogue is a failure too", async () => {
  const fake = {
    // "toy story 2" (the first spelling, the one kept when none finds
    // anything) answered; "toy story two" could not reach the catalogue
    search: async (q) => ({ q, results: [], related: [], pending: false, catalogFailed: q === "toy story two" }),
  };
  const r = await spoken.search("toy story two", { engine: fake, wait: true });
  assert.equal(r.q, "toy story 2");
  assert.equal(r.catalogFailed, true);
});

test("typing into a slow catalogue does not shut it off: a search past the page's wait is not a sign the host is down", async () => {
  // Each pause in the typing asks the catalogue for what is in the box ("la c",
  // "la coc", "la cocin" — the page stops waiting for the older ones, the
  // server's calls go on). Five calls past the page deadline, none answered,
  // used to open Cinemeta's breaker (lib/upstream.js): for 30 s every search
  // AND every title page failed at once, "La Cocina" included.
  useRealCatalogue();
  const base = fresh("la cocina");
  const asked = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (!/v3-cinemeta\.strem\.io/.test(u)) return refused();
    asked.push(decodeURIComponent(u));
    await sleep(3200);
    return jsonRes(/\/movie\//.test(u) && /cocina/.test(decodeURIComponent(u)) ? cocina(base) : { metas: [] });
  };
  const typed = [base.slice(0, 4), base.slice(0, 6), base.slice(0, 8)];
  const pending = [];
  for (const q of typed) {
    pending.push(engine.search(q, { wait: true }));
    await sleep(200);
  }
  await Promise.all(pending);
  const h = upstream.status().hosts.find((x) => x.host === "v3-cinemeta.strem.io");
  assert.equal(h.breaker, "closed", "still asked");
  // the whole name, pressed Search: Cinemeta is asked (a breaker would have
  // refused it in microseconds), and the screen's one retry finds it
  const t0 = Date.now();
  const r = await engine.search(base, { wait: true, commit: true });
  assert.ok(Date.now() - t0 >= 2400, "waited for Cinemeta, not refused at once");
  assert.ok(asked.some((u) => u.includes(`search=${base}.json`)), "asked for the whole name");
  assert.equal(r.catalogFailed, true, "still slow: said as a failure the screen retries");
  await sleep(1200);
  const again = await engine.search(base, { wait: true, commit: true });
  assert.equal(again.catalogFailed, false);
  assert.equal(again.results[0] && again.results[0].title, base);
});

test("a catalogue that is really down still opens its breaker (failures, not slowness)", async () => {
  useRealCatalogue();
  global.fetch = async () => refused();
  for (let i = 0; i < 4; i++) await engine.search(fresh("zz down"), { wait: true, commit: true });
  const h = upstream.status().hosts.find((x) => x.host === "v3-cinemeta.strem.io");
  assert.equal(h.breaker, "open");
});
