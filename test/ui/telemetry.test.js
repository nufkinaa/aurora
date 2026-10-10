// The site's telemetry, end to end against the private server
// (docs/analytics.md): what a page captures, that it reaches the server
// reduced and counted, that a profile with usage stats off sends nothing and
// is refused by the server anyway — and the admin's App health page, drawn
// from stubbed data.
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

const ui = suite();

// The page is "going away": usage.js sends what it holds at once (by beacon).
const sendNow = (page) => page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
const telemetry = (api, q = "") => api.adminGet(`/api/admin/telemetry${q}`);
const until = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const findError = (api, re) => until(async () => {
  const t = await telemetry(api);
  return [...t.errors.top, ...t.errors.ignored].find((r) => re.test(r.message));
}, `an error report matching ${re}`);

ui.test("a thrown error and failed pictures each become ONE counted report — with nothing personal in it", {
  allow: [/smuggled/, /Failed to load resource.*\/img\//],
}, async ({ page, goto, signIn, freshProfile, api }) => {
  await signIn(await freshProfile());
  await goto("#/");
  await page.evaluate(() => {
    // an uncaught error whose message carries things that must not leave the page
    setTimeout(() => { throw new Error("smuggled 4711 while opening \"Test Film One\" (tt9000001) at http://10.9.8.7:4000/x?token=abc123def456"); }, 0);
    // seven pictures the server does not have: one line, not seven
    for (let i = 0; i < 7; i++) {
      const im = new Image();
      im.src = `/img/${(0xaaaaaaaaa000 + i).toString(16)}?w=311`;
      im.style.cssText = "position:absolute;width:1px;height:1px;opacity:0";
      document.body.append(im);
    }
  });
  await page.waitForFunction(() => [...document.querySelectorAll('img[src*="w=311"]')].every((im) => im.complete));
  await page.waitForTimeout(100);
  await sendNow(page);

  const img = await findError(api, /^image \/img\/:id\?w=311/);
  assert.equal(img.message, "image /img/:id?w=311 → 404");
  assert.equal(img.n, 7, "seven failed pictures, one report");
  assert.equal(img.devices, 1);
  assert.equal(img.app, "web");
  assert.equal(img.kind, "img");
  assert.deepEqual(img.ctx.status, { 404: 7 });
  assert.deepEqual(img.screens, { "/": 7 });
  assert.deepEqual(img.auth, { open: 7 }, "the sign-in mode the page saw rides with the report");

  const js = await findError(api, /^smuggled/);
  assert.equal(js.message, "smuggled N while opening '…' (<id>) at <url>");
  assert.equal(js.kind, "js");
  assert.equal(js.n, 1);
  assert.match(Object.keys(js.models)[0], /^(chrome|edge) \d+$/, "the browser's family and major version, nothing finer");
  const everything = JSON.stringify(await telemetry(api));
  for (const needle of ["Test Film One", "tt9000001", "10.9.8.7", "abc123def456", "4711"]) assert.ok(!everything.includes(needle), `"${needle}" reached the server`);
});

ui.test("console.warn and a refused request are reported by what the code wrote, never by what it was handed", {
  allow: [/Failed to load resource.*\/api\/item\//],
}, async ({ page, goto, signIn, freshProfile, api }) => {
  await signIn(await freshProfile());
  await goto("#/");
  await page.evaluate(async () => {
    console.warn("[telemetry-test] stalled on", "Test Film Two", { title: "Test Film Two" });
    console.warn("[telemetry-test] stalled on", "Test Film One", { title: "Test Film One" });
    await fetch("/api/item/bbbbbbbbbbbb?profile=somebody&q=secret+words").catch(() => {});
  });
  await sendNow(page);
  const warn = await findError(api, /telemetry-test/);
  assert.equal(warn.message, "[telemetry-test] stalled on <string> <object>");
  assert.equal(warn.level, "warn");
  assert.equal(warn.n, 2, "the same warning about two different titles is one kind");
  const http = await findError(api, /^GET \/api\/item\/:id/);
  assert.equal(http.message, "GET /api/item/:id?profile&q → 404");
  assert.equal(http.level, "warn");
  const everything = JSON.stringify(await telemetry(api));
  for (const needle of ["Test Film", "somebody", "secret", "bbbbbbbbbbbb"]) assert.ok(!everything.includes(needle), `"${needle}" reached the server`);
});

ui.test("a tagged control is counted, and screens are timed", async ({ page, goto, signIn, freshProfile, api }) => {
  await signIn(await freshProfile());
  await goto("#/");
  const before = await telemetry(api);
  const count = (t, id) => (t.controls.web.used.find((u) => u.id === id) || { n: 0 }).n;
  await page.click('#nav [data-ui="nav.movies"]');
  await page.waitForFunction(() => location.hash === "#/movies");
  await page.click('#nav [data-ui="nav.home"]');
  await page.waitForFunction(() => location.hash === "#/" || location.hash === "");
  await page.click('#nav [data-ui="nav.movies"]');
  await page.waitForFunction(() => location.hash === "#/movies");
  await page.waitForSelector(".card");
  await sendNow(page);
  const after = await until(async () => {
    const t = await telemetry(api);
    return count(t, "nav.movies") >= count(before, "nav.movies") + 2 ? t : null;
  }, "the control counts");
  assert.equal(count(after, "nav.movies") - count(before, "nav.movies"), 2);
  assert.equal(count(after, "nav.home") - count(before, "nav.home"), 1);
  const movies = after.controls.web.used.find((u) => u.id === "nav.movies");
  assert.ok(movies.in.mouse >= 2, "how it was pressed");
  assert.ok(after.controls.web.sessions >= 1);
  assert.ok(after.controls.web.never.includes("player.skipintro"), "what nobody pressed is listed too");
  const metrics = after.timings.rows.filter((r) => r.app === "web").map((r) => `${r.metric}|${r.dim}`);
  assert.ok(metrics.includes("nav_paint|/movies"), `nav_paint for /movies in ${metrics.join(", ")}`);
  assert.ok(metrics.includes("app_start_home|-"), "app start → Home usable");
  // the server timed its own answers along the way
  assert.ok(after.timings.rows.some((r) => r.app === "server" && r.metric === "srv_home"));
});

ui.test("usage stats off: the page sends nothing, and the server would refuse it anyway", {
  allow: [/smuggled/, /Failed to load resource.*\/img\//],
}, async ({ page, goto, signIn, freshProfile, api, srv }) => {
  const me = await freshProfile();
  await api.ok("PUT", `/api/profiles/${me.id}`, { prefs: { usageStats: false } }, await api.as(me));
  assert.equal((await api.profile(me.id)).prefs.usageStats, false);
  const sent = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/usage") sent.push(r.method()); });
  await signIn(me);
  await goto("#/");
  await page.evaluate(() => {
    setTimeout(() => { throw new Error("smuggled opt-out marker"); }, 0);
    const im = new Image();
    im.src = "/img/cccccccccccc?w=313";
    document.body.append(im);
    console.warn("[optout-test] a warning");
  });
  await page.click('#nav [data-ui="nav.movies"]');
  await page.waitForSelector(".card");
  await page.waitForTimeout(300);
  await sendNow(page);
  await page.waitForTimeout(700);
  assert.deepEqual(sent, [], "a profile with usage stats off sent a batch");

  // …and a client that ignored the switch gets nowhere: the server reads the profile itself
  const post = (profile) => fetch(`${srv.url}/api/usage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, sid: "abcd1234", device: "desktop", look: "glass", iid: "tabdddddddddddd1", app: "web", v: "9.9.9", events: [{ n: "feat", t: Date.now(), p: { f: "optout_marker" } }], tel: { e: [{ k: "js", m: "optout marker from a rogue client" }], t: [["nav_paint", 123, "/wrapped"]], u: [["/wrapped", "nav.saved", "mouse", 5, 1]] } }),
  });
  const refused = await post(me.id);
  assert.equal(refused.status, 204);
  assert.equal(refused.headers.get("x-usage"), "off", "the answer says so, and the clients stop on it");
  const unknown = await post("no-such-profile");
  assert.equal(unknown.headers.get("x-usage"), "off", "a profile the server does not know cannot have agreed");
  await new Promise((r) => setTimeout(r, 300));
  const t = await telemetry(api);
  const all = JSON.stringify(t) + JSON.stringify(await api.adminGet("/api/admin/usage"));
  for (const needle of ["optout", "opt-out marker", "w=313", "9.9.9"]) assert.ok(!all.includes(needle), `"${needle}" was counted for a profile that said no`);
  assert.ok(!t.timings.rows.some((r) => r.dim === "/wrapped"));
});

// ------------------------------------------------------------ the admin page
const NOW = Date.now();
const days = (n) => Array.from({ length: 14 }, (_, i) => ({ day: new Date(NOW - (13 - i) * 86400000).toISOString().slice(0, 10), n: i === 13 ? n : 0, devices: i === 13 ? 3 : 0 }));
const errRow = (o) => ({
  fp: "aaaaaaaaaa", app: "tv", kind: "img", level: "error", message: "image /img/:id?w=256 → 401", where: "", n: 111, n24: 111, devices: 3, devices24: 3,
  first: NOW - 40 * 60000, last: NOW - 60000, firstVersion: "5.1.31", isNew: true, newInLatest: true, spike: { cur: 111, base: null, factor: null },
  versions: { "5.1.31": 111 }, models: { "Acme Box 2": 80, "Other TV": 31 }, screens: { "tv:home": 111 }, auth: { closed: 111 }, net: { ok: 111 }, os: { "android 30": 111 }, flags: {}, ctx: { status: { 401: 111 } },
  days: days(111), state: "open", note: "", ...o,
});
const STUB = () => ({
  errors: {
    total: 3, latest: { tv: "5.1.31", web: "1.6.86" },
    fresh: [errRow({})],
    spiking: [errRow({ fp: "bbbbbbbbbb", app: "web", kind: "http", level: "warn", message: "GET /api/home → 503", isNew: false, newInLatest: false, first: NOW - 9 * 86400000, firstVersion: "1.6.80", spike: { cur: 60, base: 2, factor: 30 }, n: 400, n24: 70, devices: 5, models: { "chrome 141": 400 }, screens: { "/": 400 }, auth: { open: 400 }, ctx: { status: { 503: 400 } } })],
    top: [errRow({}), errRow({ fp: "bbbbbbbbbb", app: "web", kind: "http", level: "warn", message: "GET /api/home → 503", isNew: false, newInLatest: false, n: 400, devices: 5 })],
    ignored: [errRow({ fp: "cccccccccc", app: "web", kind: "js", message: "ResizeObserver loop completed with undelivered notifications.", state: "ignored", note: "the browser's own layout notice; nothing breaks", isNew: false, newInLatest: false })],
    filters: { apps: ["tv", "web"], versions: ["5.1.31", "1.6.86", "1.6.80"], models: ["Acme Box 2", "Other TV", "chrome 141"], levels: ["error", "warn"] },
  },
  timings: {
    histograms: 4,
    rows: [
      { metric: "play_first_frame", label: "Play pressed → first frame", app: "tv", dim: "direct", version: "5.1.31", n: 40, p50: 3000, p90: 6200, p99: 9000, mean: 3400, prevVersion: "5.1.30", prev: { n: 55, p50: 2000, p90: 4000, p99: 6000 }, changeP50: 50, changeP90: 55, byDevice: { tv: { n: 40, p50: 3000, p90: 6200, p99: 9000 } }, byNet: {}, versions: [] },
      { metric: "app_start_home", label: "App start → Home usable", app: "web", dim: "-", version: "1.6.86", n: 120, p50: 800, p90: 1900, p99: 4200, mean: 1000, prevVersion: "1.6.80", prev: { n: 90, p50: 1000, p90: 2000, p99: 4000 }, changeP50: -20, changeP90: -5, byDevice: {}, byNet: {}, versions: [] },
      { metric: "srv_home", label: "Server: /api/home", app: "server", dim: "-", version: "1.6.86", n: 900, p50: 42, p90: 120, p99: 400, mean: 60, prevVersion: null, prev: null, changeP50: null, changeP90: null, byDevice: {}, byNet: {}, versions: [] },
    ],
  },
  controls: {
    vocabulary: 162,
    web: { app: "web", days: 30, sessions: 50, presses: 300, used: [{ id: "card.open", n: 200, s: 45, share: 90, by: { "/": 150, "/movies": 50 }, in: { touch: 120, mouse: 80 }, feature: "card" }, { id: "detail.play", n: 100, s: 30, share: 60, by: { "/movie/:id": 100 }, in: { touch: 100 }, feature: "detail" }], never: ["player.pip", "saved.remove"], screens: { "/": [{ id: "card.open", n: 150 }], "/movies": [{ id: "card.open", n: 50 }], "/movie/:id": [{ id: "detail.play", n: 100 }] }, features: [] },
    tv: { app: "tv", days: 30, sessions: 20, presses: 500, used: [{ id: "player.seek.fwd", n: 400, s: 18, share: 90, by: { "tv:player": 400 }, in: { remote: 400 }, feature: "player.seek" }, { id: "card.open", n: 100, s: 20, share: 100, by: { "tv:home": 100 }, in: { remote: 100 }, feature: "card" }], never: ["update.later"], screens: { "tv:player": [{ id: "player.seek.fwd", n: 400 }], "tv:home": [{ id: "card.open", n: 100 }] }, features: [] },
    compare: [{ id: "card.open", web: 200, webShare: 90, tv: 100, tvShare: 100 }],
  },
  alertRules: { alert: true, newDevices: 2, newCount: 20, windowMin: 30, spikeFactor: 5, spikeMin: 20, cooldownMin: 30, maxPerDay: 6 },
  text: "Errors and warnings from devices — 3 kinds known\n\nTimings\n\nMost used — web",
});

const openAppHealth = async (page, srv, { posts = [] } = {}) => {
  await page.route("**/api/admin/telemetry*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(STUB()) }));
  await page.route("**/api/admin/telemetry/**", (route) => {
    posts.push({ url: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, alertRules: STUB().alertRules }) });
  });
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
  await page.click('.tab[data-tab="analytics"]');
  await page.click('#subtabs [data-sub="telemetry"]');
  await page.waitForSelector("#tel-errors tr");
};

ui.test("admin › App health › Errors: what is new, what is spiking, what is ignored — and silencing one", async ({ page, srv }) => {
  const posts = [];
  await openAppHealth(page, srv, { posts });
  assert.equal(await page.textContent("#page-sub"), "What goes wrong on people's devices, how long things take, and which controls get used.");
  // New is the first view
  assert.equal(await page.textContent("#tel-n-fresh"), "1");
  assert.equal(await page.textContent("#tel-n-spiking"), "1");
  let row = page.locator("#tel-errors tr").first();
  const text = async () => (await row.innerText()).replace(/\s+/g, " ");
  assert.match(await text(), /error TV image \/img\/:id\?w=256 → 401 new in 5\.1\.31/);
  assert.match(await text(), /versions: 5\.1\.31 111 · on: Acme Box 2 80, Other TV 31 · screens: tv:home 111 · sign-in: closed 111 · connection: ok 111 · status: 401 111/);
  assert.match(await text(), /111 111 today 3 40 min ago in 5\.1\.31/);
  assert.equal(await row.locator(".tel-spark i").count(), 14, "fourteen days, one bar each");
  // Spiking
  await page.click('#tel-views [data-view="spiking"]');
  row = page.locator("#tel-errors tr").first();
  assert.match(await text(), /warning Website GET \/api\/home → 503/);
  assert.match(await text(), /this hour 60, usually 2/);
  // Ignored: with why, and a way back
  await page.click('#tel-views [data-view="ignored"]');
  row = page.locator("#tel-errors tr").first();
  assert.match(await text(), /ResizeObserver loop/);
  assert.match(await text(), /the browser's own layout notice/);
  assert.equal((await row.locator("button").allTextContents()).join("|"), "Stop ignoring");
  // Top by devices: mark one known, ignore another
  await page.click('#tel-views [data-view="top"]');
  assert.equal(await page.locator("#tel-errors tr").count(), 2);
  await page.locator('#tel-errors tr[data-fp="aaaaaaaaaa"] button[data-tel-state="known"]').click();
  await page.waitForFunction(() => /Marked as known/.test(document.body.innerText));
  await page.locator('#tel-errors tr[data-fp="bbbbbbbbbb"] button[data-tel-state="ignored"]').click();
  await page.waitForFunction(() => /Ignored — still counted, never alerted/.test(document.body.innerText));
  assert.deepEqual(posts, [
    { url: "/api/admin/telemetry/errors/aaaaaaaaaa/state", body: { state: "known" } },
    { url: "/api/admin/telemetry/errors/bbbbbbbbbb/state", body: { state: "ignored" } },
  ]);
  // the filters come from what was seen, and narrow the question the page asks
  assert.deepEqual(await page.locator("#tel-f-version option").allTextContents(), ["Every version", "5.1.31", "1.6.86", "1.6.80"]);
  const asked = page.waitForRequest((r) => /\/api\/admin\/telemetry\?/.test(r.url()));
  await page.selectOption("#tel-f-app", "tv");
  assert.match((await asked).url(), /\?app=tv$/);
});

ui.test("admin › App health › Timings, Most used, the alert rules and Copy", { permissions: ["clipboard-read", "clipboard-write"] }, async ({ page, srv }) => {
  const posts = [];
  await openAppHealth(page, srv, { posts });
  // Timings: a release that made something slower is red, faster is green
  const rows = await page.locator("#tel-timings tr").evaluateAll((trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, " ")));
  assert.match(rows[0], /Play pressed → first frame play_first_frame TV direct 5\.1\.31 40 3\.0 s 6\.2 s 9\.0 s \+50% vs 5\.1\.30/);
  assert.match(rows[1], /App start → Home usable app_start_home Website 1\.6\.86 120 800 ms 1\.9 s 4\.2 s -20% vs 1\.6\.80/);
  assert.match(rows[2], /Server: \/api\/home srv_home Server 1\.6\.86 900 42 ms 120 ms 400 ms –/);
  assert.ok(await page.locator("#tel-timings tr").nth(0).locator(".pill.bad").count(), "slower: marked");
  assert.ok(await page.locator("#tel-timings tr").nth(1).locator(".pill.live").count(), "faster: marked");

  // Most used: the website first
  const bars = () => page.locator("#tel-used .hrow").evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, " ")));
  assert.deepEqual(await bars(), ["card.open 200 · 90%", "detail.play 100 · 60%"]);
  assert.match(await page.textContent("#tel-u-totals"), /50 sessions · 300 presses · 2 of 4 controls used/);
  assert.deepEqual(await page.locator("#tel-never .pill").allTextContents(), ["player.pip", "saved.remove"]);
  // one screen's controls
  await page.selectOption("#tel-u-screen", "/movies");
  assert.deepEqual(await bars(), ["card.open 50"]);
  // the TV
  await page.click('#tel-apps [data-app="tv"]');
  assert.deepEqual(await bars(), ["player.seek.fwd 400 · 90%", "card.open 100 · 100%"]);
  assert.deepEqual(await page.locator("#tel-never .pill").allTextContents(), ["update.later"]);
  // side by side
  await page.click('#tel-apps [data-app="compare"]');
  assert.deepEqual(await bars(), ["card.open 200 / 100"]);

  // the alert rules: shown, changed, saved
  assert.match(await page.textContent("#tel-rules-line"), /new on 2 devices or 20× within 30 min · spiking at 5× usual \(≥ 20 an hour\) · at most one alert per 30 min, 6 a day/);
  await page.click(".tel-rules summary");
  await page.fill('#tel-rules [data-rule="newDevices"]', "3");
  await page.click("#tel-rules-save");
  await page.waitForFunction(() => /Alert rules saved/.test(document.body.innerText));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/admin/telemetry/alert-rules");
  assert.deepEqual(posts[0].body, { alert: true, newDevices: 3, newCount: 20, windowMin: 30, spikeFactor: 5, spikeMin: 20, cooldownMin: 30, maxPerDay: 6 });

  // Copy
  await page.click("#tel-copy");
  await page.waitForFunction(() => /Report copied/.test(document.body.innerText));
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^Errors and warnings from devices — 3 kinds known/);
});

ui.test("admin: the real endpoints — marking a kind known, the rules, and that only the admin may", async ({ api, srv }) => {
  // (no page: the private instance's own API, with its own made-up admin password)
  const noAdmin = await api.call("GET", "/api/admin/telemetry");
  assert.equal(noAdmin.status, 403);
  assert.equal((await api.call("POST", "/api/admin/telemetry/errors/aaaaaaaaaa/state", { state: "ignored" })).status, 403);
  assert.equal((await api.call("POST", "/api/admin/telemetry/alert-rules", { alert: false })).status, 403);
  const me = await api.createProfile(`Tel${Date.now().toString(36).slice(-5)}`, { open: true });
  const res = await fetch(`${srv.url}/api/usage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile: me.id, sid: "abcd1234", device: "tv", look: "tv", iid: "boxeeeeeeeeeeee1", app: "tv", v: "5.1.31", model: "Acme Box 2", os: "android 30", auth: "open", events: [], tel: { s: 1, e: [{ k: "media", m: "player error error_code_io_bad_http_status", c: { code: 2004, status: 401 } }] } }),
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("x-usage"), null);
  const row = await findError(api, /error_code_io_bad_http_status/);
  assert.equal(row.message, "player error error_code_io_bad_http_status");
  assert.deepEqual(row.ctx, { code: { 2004: 1 }, status: { 401: 1 } });
  assert.equal(row.state, "open");
  assert.deepEqual(await api.adminPost(`/api/admin/telemetry/errors/${row.fp}/state`, { state: "known", note: "the test one" }), { ok: true, state: "known" });
  assert.equal((await findError(api, /error_code_io_bad_http_status/)).state, "known");
  assert.equal((await api.call("POST", `/api/admin/telemetry/errors/${row.fp}/state`, { state: "nonsense" }, api.admin)).status, 400);
  const rules = await api.adminPost("/api/admin/telemetry/alert-rules", { newDevices: 4, junk: 1, alert: true });
  assert.equal(rules.alertRules.newDevices, 4);
  assert.equal((await telemetry(api)).alertRules.newDevices, 4);
  await api.adminPost("/api/admin/telemetry/alert-rules", { newDevices: 2 });
  // the Copy text of the old Analytics card now ends with the new sections
  const usage = await api.adminGet("/api/admin/usage");
  assert.match(usage.text, /Errors and warnings from devices/);
  assert.match(usage.text, /Timings \(metric/);
  assert.match(usage.text, /Most used — web/);
});

ui.run({ concurrency: 2 });
