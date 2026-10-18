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
  await assert.rejects(discover.meta("movie", id), (e) => e.code === "deadline");
  const waited = Date.now() - t0;
  assert.ok(waited >= 2400 && waited < 3000, `the page waited ${waited} ms`);
  await new Promise((r) => setTimeout(r, 1000)); // the late answer lands
  const t1 = Date.now();
  const data = await discover.meta("movie", id);
  assert.ok(Date.now() - t1 < 100, "answered from what came late");
  assert.equal(data.title, `Title ${id}`);
  assert.equal(calls, 1, "the provider was asked once");
  const h = upstream.status().hosts.find((x) => x.host === "v3-cinemeta.strem.io");
  assert.equal(h.lateFills, 1);
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
