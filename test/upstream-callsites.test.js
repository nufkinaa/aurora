// The call sites, through lib/upstream.js: a title page whose provider is
// slow waits ~2.5 s, not the provider's 12; the answer that came late is
// there on the next ask (late fill); a provider that is down is not asked
// again for its cooldown — the page fails in milliseconds; and every module
// that talks to the outside world goes through upstream (no bare fetch()).
// The outside world is a stub: nothing here leaves the machine.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const upstream = require("../src/lib/upstream");
const discover = require("../src/media/discover");

const real = global.fetch;
test.afterEach(() => { global.fetch = real; upstream._internals._reset(); });

const meta = (id) => ({ meta: { id, name: `Title ${id}`, releaseInfo: "2001", genres: ["Drama"], description: "x" } });
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("a slow provider: the title page waits ~2.5 s, and the late answer is there on the next ask", async () => {
  const id = `tt9${Date.now() % 1000000}1`;
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    assert.match(String(url), /v3-cinemeta\.strem\.io\/meta\/movie\//);
    await new Promise((r) => setTimeout(r, 3200)); // slower than the page waits
    return jsonRes(meta(id));
  };
  const t0 = Date.now();
  await assert.rejects(discover.meta("movie", id, { waiting: true }), (e) => e.code === "deadline");
  const waited = Date.now() - t0;
  assert.ok(waited >= 2400 && waited < 3000, `the page waited ${waited} ms`);
  await new Promise((r) => setTimeout(r, 1000)); // the late answer lands
  const t1 = Date.now();
  const data = await discover.meta("movie", id, { waiting: true });
  assert.ok(Date.now() - t1 < 100, "answered from what came late");
  assert.equal(data.title, `Title ${id}`);
  assert.equal(calls, 1, "the provider was asked once");
  const h = upstream.status().hosts.find((x) => x.host === "v3-cinemeta.strem.io");
  assert.equal(h.lateFills, 1);
});

test("background work (no person waiting) waits for the provider's full answer — it never mistakes slow for nothing", async () => {
  const id = `tt8${Date.now() % 1000000}2`;
  global.fetch = async () => { await new Promise((r) => setTimeout(r, 2800)); return jsonRes(meta(id)); };
  const t0 = Date.now();
  const data = await discover.meta("movie", id); // the follows check, the library warm-up…
  assert.ok(Date.now() - t0 >= 2700, "waited for the answer");
  assert.equal(data.title, `Title ${id}`);
});

test("a provider that is down: after a few failures the page fails in milliseconds, without asking it", async () => {
  let calls = 0;
  global.fetch = async () => { calls++; throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); };
  for (let i = 0; i < 5; i++) await assert.rejects(discover.meta("movie", `tt80000${i}1`));
  const asked = calls;
  const t0 = performance.now();
  await assert.rejects(discover.meta("movie", "tt8000099"), (e) => e.code === "open");
  assert.ok(performance.now() - t0 < 20, "failed fast");
  assert.equal(calls, asked, "the dead provider was not asked");
  assert.equal(upstream.status().hosts.find((x) => x.host === "v3-cinemeta.strem.io").breaker, "open");
});

test("IMDb id matching does not file \"no match\" for a search made while Cinemeta failed", async () => {
  let calls = 0;
  global.fetch = async () => { calls++; throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); };
  const r = await discover.search(`zzunknown${Date.now()}`);
  assert.equal(r.degraded, true);
  assert.deepEqual(Object.keys(r).sort(), ["movies", "shows"], "the flag is not sent to clients");
  upstream._internals._reset(); // (breakers closed again, so the next ask reaches the stub)
  const imdb = require("../src/media/imdb");
  const title = `Some Film ${Date.now()}`;
  assert.equal(await imdb.resolve(title, "movie", 2001), null);
  const before = calls;
  upstream._internals._reset();
  assert.equal(await imdb.resolve(title, "movie", 2001), null);
  assert.ok(calls > before, "asked again: nothing was filed as \"no match\"");
});

// Voice search (media/spoken.js): a Hebrew title the catalogues do not know
// is looked up on the Hebrew Wikipedia. That call is the page's too (the
// microphone's search waits for it), so it has the same guards as the others.
test("voice search's Hebrew Wikipedia lookup: through upstream — the search waits ~2.5 s at most, the late answer is kept", async (t) => {
  const keep = setInterval(() => {}, 1000); // (upstream's timers are unref'd)
  t.after(() => clearInterval(keep));
  const spoken = require("../src/media/spoken");
  spoken._internals._reset();
  const asked = [];
  global.fetch = async (url) => {
    asked.push(String(url));
    await new Promise((r) => setTimeout(r, 3200)); // slower than the search waits
    return jsonRes({ query: { pages: [{ index: 1, title: "פאודה", langlinks: [{ lang: "en", title: "Fauda" }] }] } });
  };
  const t0 = Date.now();
  assert.equal(await spoken._internals.englishTitle("פאודה"), null, "past the budget: nothing yet, not an error");
  const waited = Date.now() - t0;
  assert.ok(waited >= 2400 && waited < 3000, `the voice search waited ${waited} ms`);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^https:\/\/he\.wikipedia\.org\/w\/api\.php\?/);
  await new Promise((r) => setTimeout(r, 1000)); // the late answer lands
  const t1 = Date.now();
  assert.equal(await spoken._internals.englishTitle("פאודה"), "Fauda");
  assert.ok(Date.now() - t1 < 100, "answered from what came late");
  assert.equal(asked.length, 1, "Wikipedia was asked once");
  const h = upstream.status().hosts.find((x) => x.host === "he.wikipedia.org");
  assert.ok(h, "he.wikipedia.org is one of upstream's hosts (admin Health shows it)");
  assert.equal(h.lateFills, 1);
});

test("voice search's Hebrew Wikipedia lookup: Wikipedia down opens its breaker, and voice search stops asking it", async (t) => {
  // (upstream's own timers — the retry's wait — are unref'd, as a server's
  // should be: with nothing else here the loop could end mid-retry)
  const keep = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keep));
  const spoken = require("../src/media/spoken");
  spoken._internals._reset();
  let calls = 0;
  global.fetch = async () => { calls++; throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); };
  for (let i = 0; i < 5; i++) assert.equal(await spoken._internals.englishTitle(`שם ${i}`), null);
  assert.equal(upstream.status().hosts.find((x) => x.host === "he.wikipedia.org").breaker, "open");
  const asked = calls;
  const t0 = performance.now();
  assert.equal(await spoken._internals.englishTitle("שם אחר"), null);
  assert.ok(performance.now() - t0 < 20, "failed fast");
  assert.equal(calls, asked, "the dead host was not asked");
});

test("no module talks to the outside world with a bare fetch()", () => {
  // the only fetch() calls left: this server talking to itself (blur-up),
  // the local download engine (aria2 RPC on 127.0.0.1), and the healer's own
  // reachability probe (it must see the raw truth, breakers or not)
  const allowed = new Set(["src/lib/blurup.js", "src/media/aria2.js", "src/lib/healer.js", "src/lib/upstream.js"]);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));
  const root = path.join(__dirname, "..");
  const offenders = [];
  for (const file of walk(path.join(root, "src"))) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (allowed.has(rel)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (/(^|[^.\w])fetch\(/.test(line.replace(/\/\/.*$/, ""))) offenders.push(`${rel}:${i + 1}`);
    });
  }
  // (mylistdl's own `fetch(key)` is a local function of that name)
  assert.deepEqual(offenders.filter((o) => !o.startsWith("src/media/mylistdl.js")), []);
});
