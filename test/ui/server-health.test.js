// The resilience round on a real private instance: the admin's metrics
// endpoint (admin only), the Server → Health card at desktop and phone width
// (the page never wider than the screen), request bodies over their limit
// or not JSON (413 / 400, one quiet log line), the rate limits wired in log
// mode (counted, nothing refused), and the boot's config check.
const assert = require("node:assert/strict");
const { suite, PHONE, DESKTOP, ARTIFACTS } = require("./helpers");
const path = require("path");

const ui = suite({
  server: {
    // an unknown key and a bad value: the boot check must name both and the
    // server must start anyway
    config: { prewarmStream: true, scanIntervalMinutes: "never" },
  },
});

const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
  await page.click('.tab[data-tab="server"]');
  await page.waitForFunction(() => document.querySelectorAll("#mx-stats .stat").length >= 6);
};

ui.test("metrics: admin only; JSON with requests, event loop, memory, work, outside services, limits, checks", async ({ srv, api }) => {
  assert.equal((await api.call("GET", "/api/admin/metrics")).status, 403);
  const m = await api.adminGet("/api/admin/metrics");
  for (const k of ["eventLoop", "memory", "work", "requests", "upstream", "rateLimits", "ws", "checks", "http"]) assert.ok(k in m, k);
  assert.equal(m.rateLimits.mode, "enforce");
  assert.equal(m.http.headersTimeout, 20000);
  const cfg = m.checks.checks.find((c) => c.id === "config");
  const keys = cfg.problems.map((p) => `${p.key}:${p.level}`).sort();
  assert.deepEqual(keys, ["prewarmStream:warn", "scanIntervalMinutes:refused"]);
  // the Prometheus form
  const r = await fetch(`${srv.url}/api/admin/metrics?fmt=prom`, { headers: api.admin });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /aurora_http_requests_total\{group="[^"]+",result="s2"\} \d+/);
});

ui.test("request bodies: too large is 413, not JSON is 400 — as JSON, without a stack in the log", async ({ srv }) => {
  const big = await fetch(`${srv.url}/api/usage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x: "y".repeat(200 * 1024) }) });
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: "request body too large" });
  const auth = await fetch(`${srv.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "a", password: "p".repeat(20 * 1024) }) });
  assert.equal(auth.status, 413, "sign-in bodies are held to 16 kB");
  const bad = await fetch(`${srv.url}/api/usage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(bad.status, 400);
  await new Promise((r) => setTimeout(r, 200));
  const log = srv.log().join("\n");
  assert.match(log, /\[http\] refused a request body \(entity\.too\.large\)/);
  assert.doesNotMatch(log, /PayloadTooLargeError: request entity too large\n\s+at /, "no stack trace");
});

ui.test("rate limits (enforced by default): a normal visit is never refused, a hammering client is — 429 with Retry-After", async ({ srv, api, freshProfile }) => {
  // a first visit: Home, the library, the catalogue rows, a search typed at 10 letters a second
  const p = await freshProfile();
  const h = await api.as(p);
  const visit = [`/api/home?profile=${p.id}`, "/api/library", "/api/catalog?type=movie&category=trending&page=0", "/api/catalog/genres?type=movie"];
  const codes = [];
  for (const u of visit) codes.push((await fetch(srv.url + u, { headers: h })).status);
  for (let k = 1; k <= 10; k++) {
    const q = encodeURIComponent("interstell".slice(0, k));
    codes.push(...(await Promise.all([`/api/search?v=2&q=${q}`, `/api/search/suggest?v=2&q=${q}`].map(async (u) => (await fetch(srv.url + u, { headers: h })).status))));
    await new Promise((r) => setTimeout(r, 100));
  }
  // person sheets, one after another: the old limit (40 a minute per address,
  // routes/api.js before this round) refused the 41st — and behind the site's
  // reverse proxy every visitor shared it
  for (let i = 0; i < 45; i++) codes.push((await fetch(`${srv.url}/api/person/${encodeURIComponent(`Some Person ${i}`)}`, { headers: h })).status);
  assert.ok(!codes.includes(429), `normal use was refused: ${codes}`);
  // a script: 400 X-Ray asks at once from one address (a LAN address: 4 x 60 allowed at once)
  const many = await Promise.all(Array.from({ length: 400 }, (_, i) => fetch(`${srv.url}/api/xray?type=movie&imdbId=bad${i}`)));
  const refused = many.filter((r) => r.status === 429);
  assert.ok(refused.length > 0, "the hammer was refused");
  assert.ok(Number(refused[0].headers.get("retry-after")) >= 1);
  const m = await api.adminGet("/api/admin/metrics");
  assert.equal(m.rateLimits.mode, "enforce");
  const g = m.rateLimits.groups.find((x) => x.group === "xray");
  assert.ok(g.refused >= refused.length, JSON.stringify(g));
});

ui.test("two signed-in devices behind one address, at a power user's pace for 15 s (screens every second, searches at 10 letters a second, a grid flung, title pages and people in a row): never refused", async ({ srv, api }) => {
  const device = async (name) => {
    const p = await api.createProfile(name);
    await api.post("/api/auth/claim", { profileId: p.id, username: name.toLowerCase() }, await api.as(p));
    const r = await api.post("/api/auth/login", { username: name.toLowerCase(), password: p.password });
    return { "X-Session": r.session };
  };
  const devs = [await device(`Nat${Date.now().toString(36).slice(-4)}a`), await device(`Nat${Date.now().toString(36).slice(-4)}b`)];
  const codes = {};
  const ask = async (u, h) => { const st = (await fetch(srv.url + u, { headers: h })).status; codes[st] = (codes[st] || 0) + 1; return st; };
  const tt = () => `tt${7000000 + Math.floor(Math.random() * 900000)}`;
  const stopAt = Date.now() + 15000;
  const run = async (h, tag) => {
    const jobs = [];
    let i = 0;
    while (Date.now() < stopAt) {
      // a screen
      const id = tt();
      jobs.push(ask("/api/home", h), ask("/api/library", h), ask("/api/catalog?type=movie&category=trending&page=0", h),
        ask(`/api/discover/meta/movie/${id}`, h), ask(`/api/discover/similar/movie/${id}`, h), ask(`/api/xray?type=movie&imdbId=${id}`, h), ask(`/api/trailer?type=movie&imdbId=${id}`, h),
        ask(`/api/person/${encodeURIComponent(`Some One ${tag}${i}`)}?of=${id}&type=movie`, h));
      // a word typed, a letter every 100 ms
      for (let k = 1; k <= 10; k++) {
        const q = encodeURIComponent(`q${tag}${i}abcdefgh`.slice(0, k));
        jobs.push(ask(`/api/search?v=2&q=${q}`, h), ask(`/api/search?v=2&q=${q}&wait=1`, h), ask(`/api/search/suggest?v=2&q=${q}`, h), ask(`/api/discover/search?q=${q}`, h));
        await new Promise((r) => setTimeout(r, 100));
      }
      // the grid flung: 80 pictures nobody asked for before
      for (let k = 0; k < 80; k++) jobs.push(ask(`/img/ext?u=${encodeURIComponent(`https://images.metahub.space/poster/medium/${tt()}/img`)}&w=240`, h));
      i++;
      await new Promise((r) => setTimeout(r, 1000)); // (looks at what came up)
    }
    await Promise.all(jobs);
  };
  await Promise.all(devs.map((h, n) => run(h, `d${n}`)));
  assert.ok(!codes[429], `refused: ${JSON.stringify(codes)}`);
});

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`the Server → Health card (${name}): the top numbers, the checks, and a page no wider than the screen`, { viewport }, async ({ page, srv }) => {
    await enter(page, srv);
    const text = await page.textContent("#mx-card");
    for (const s of ["event loop p99", "CPU (this process)", "requests in hand", "outside services", "Rate limits", "enforced", "Live sockets"]) assert.ok(text.includes(s), s);
    assert.match(text, /prewarmStream/, "the config warning is shown");
    assert.match(text, /scanIntervalMinutes/, "the refused setting is shown");
    // the watchdog card is still there, under its own name
    assert.ok((await page.textContent("#pane-server")).includes("Watchdog"));
    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, screen: window.innerWidth }));
    assert.equal(widths.doc, widths.screen, JSON.stringify(widths));
    require("fs").mkdirSync(ARTIFACTS, { recursive: true });
    await page.locator("#mx-card").screenshot({ path: path.join(ARTIFACTS, `server-health-${name}.png`) });
  });
}

ui.run();
