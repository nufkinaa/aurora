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
  assert.equal(m.rateLimits.mode, "log");
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

ui.test("rate limits in log mode: a burst over the limit is answered, and counted as would-refuse", async ({ srv, api }) => {
  // X-Ray: burst 20 a client — a LAN/loopback client gets 4x, so 100 asks
  // (People has its own older per-address budget, routes/api.js, enforced)
  const codes = new Set();
  for (let i = 0; i < 100; i++) codes.add((await fetch(`${srv.url}/api/xray?type=movie&imdbId=bad${i}`)).status);
  assert.ok(!codes.has(429), `nothing refused in log mode (${[...codes]})`);
  const m = await api.adminGet("/api/admin/metrics");
  const g = m.rateLimits.groups.find((x) => x.group === "xray");
  assert.ok(g.wouldRefuse > 0, JSON.stringify(g));
  assert.equal(g.refused, 0);
});

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`the Server → Health card (${name}): the top numbers, the checks, and a page no wider than the screen`, { viewport }, async ({ page, srv }) => {
    await enter(page, srv);
    const text = await page.textContent("#mx-card");
    for (const s of ["event loop p99", "CPU (this process)", "requests in hand", "outside services", "Rate limits", "log only", "Live sockets"]) assert.ok(text.includes(s), s);
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
