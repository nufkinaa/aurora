// The trail a problem report carries (docs/report-trail.md): the ring of the
// viewer's last steps and its rules (public/js/trail-core.js — and the apps'
// tv-native/src/trailCore.ts, run over the same cases), and what the server
// does with it at receipt (src/lib/reporttrail.js, src/routes/reports.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const web = () => import("../public/js/trail-core.js");
// the apps' copy, compiled the way test/tel-clients.test.js does it (skipped where the
// apps' TypeScript is not installed)
const app = (() => {
  let ts;
  try { ts = require(path.join(__dirname, "..", "tv-native", "node_modules", "typescript")); } catch { return null; }
  const file = path.join(__dirname, "..", "tv-native", "src", "trailCore.ts");
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const m = { exports: {} };
  new Function("module", "exports", "require", js)(m, m.exports, require);
  return m.exports;
})();
const both = async () => [["web", await web()], ...(app ? [["app", app]] : [])];

const clockAt = (start = 1_000_000) => {
  const c = { now: start };
  return { c, now: () => c.now };
};

test("the ring: at most 60 steps, oldest first, `t` counted back from the moment of sending", async () => {
  for (const [who, m] of await both()) {
    const { c, now } = clockAt();
    const t = new m.Trail({ now });
    for (let i = 0; i < 100; i++) { c.now += 6000; t.add("nav", { s: `/screen/${i}` }); }
    const out = t.take({ sentAt: c.now });
    assert.equal(out.length, 60, who);
    assert.equal(out[0].s, "/screen/40", who);
    assert.equal(out[59].s, "/screen/99", who);
    assert.equal(out[59].t, 0, who);
    assert.equal(out[58].t, 6000, who);
    assert.ok(out.every((e, i) => i === 0 || e.t <= out[i - 1].t), `${who}: oldest first`);
  }
});

test("the ring: only the last ten minutes are sent, repeats are counted, the whole is capped in bytes", async () => {
  for (const [who, m] of await both()) {
    const { c, now } = clockAt();
    const t = new m.Trail({ now });
    t.add("nav", { s: "/old" });
    c.now += 11 * 60 * 1000;
    for (let i = 0; i < 7; i++) { c.now += 300; t.add("key", { key: "ArrowDown" }); }
    t.add("key", { key: "Enter" });
    c.now += 6000;
    t.add("key", { key: "Enter" }); // (more than five seconds later: a step of its own)
    const out = t.take({ sentAt: c.now });
    assert.deepEqual(out.map((e) => [e.k, e.key || e.s, e.n || 1]), [["key", "ArrowDown", 7], ["key", "Enter", 1], ["key", "Enter", 1]], who);
    // a search refined as it is typed is one search
    t.add("search", { q: "ba" }); t.add("search", { q: "batm" }); t.add("search", { q: "batman" });
    assert.equal(t.take().filter((e) => e.k === "search").length, 1, who);
    assert.equal(t.take().pop().q, "batman", who);
    // bytes
    const big = new m.Trail({ now });
    for (let i = 0; i < 60; i++) big.add("toast", { m: `${i} ${"x".repeat(300)}` });
    const sent = big.take({ maxBytes: 4000 });
    assert.ok(JSON.stringify(sent).length <= 4000, who);
    assert.match(sent[sent.length - 1].m, /^59 /, `${who}: the newest kept`);
    assert.equal(sent[0].m.length, 160, `${who}: a string is 160 at most`);
  }
});

test("never in it: a character typed, in a field or not — only the keys that leave a field, and keys by name", async () => {
  for (const [who, m] of await both()) {
    for (const ch of ["a", "Z", "7", "@", "ש", "é"]) {
      assert.equal(m.keyName(ch, true), null, `${who}: ${ch} in a field`);
      assert.equal(m.keyName(ch, false), null, `${who}: ${ch} outside`);
    }
    assert.equal(m.keyName("Backspace", true), null, who);
    assert.equal(m.keyName("ArrowLeft", true), null, who);
    assert.equal(m.keyName("Enter", true), "Enter", who);
    assert.equal(m.keyName("Escape", true), "Escape", who);
    assert.equal(m.keyName(" ", false), "Space", who);
    assert.equal(m.keyName(" ", true), null, who);
    assert.equal(m.keyName("ArrowDown", false), "ArrowDown", who);
    assert.equal(m.keyName("MediaPlayPause", false), "MediaPlayPause", who);
    assert.equal(m.keyName("Shift", false), null, who);
  }
  // the remote's keys (the apps): by name, and nothing a focus move reports
  if (app) {
    assert.equal(app.tvKeyName("select"), "select");
    assert.equal(app.tvKeyName("playPause"), "playPause");
    assert.equal(app.tvKeyName("focus"), null);
    assert.equal(app.tvKeyName("blur"), null);
  }
});

test("addresses: no query, no origin, ids kept, codes and tokens behind their guard words cut", async () => {
  const cases = [
    ["http://10.0.0.3:4000/api/item/abc123?profile=x&token=zzz", "/api/item/abc123"],
    ["/stream/transcode/abc123/jit/master.m3u8?v=h264-720", "/stream/transcode/abc123/jit/master.m3u8"],
    ["/api/auth/login", "/api/auth/login"],
    ["/api/auth/sessions/9f2c4d1e7a6b5c3d", "/api/auth/sessions/…"],
    ["/api/auth/sessions/deadbeefcafe", "/api/auth/sessions/…"],
    ["/api/auth/device/describe/K7Q2-PX", "/api/auth/device/describe/…"],
    ["/api/profiles/242da3b05797/unlock", "/api/profiles/242da3b05797/unlock"],
    ["/api/person/Tom%20Hanks", "/api/person/…"],
    ["/img/tt0111161?w=256", "/img/tt0111161"],
  ];
  for (const [who, m] of await both()) {
    for (const [u, want] of cases) assert.equal(m.trailPath(u), want, `${who}: ${u}`);
    assert.equal(m.searchOf("/api/search?v=2&q=star%20wars&commit=1"), "star wars", who);
    assert.equal(m.searchOf("/api/discover/search?q=dune+part+two"), "dune part two", who);
    assert.equal(m.searchOf("/api/search/suggest?v=2&q=sta"), null, `${who}: the suggestions while typing are not a search run`);
    assert.equal(m.searchOf("/api/item/x?q=nope"), null, who);
    // whatever a string says, no address query, no key written out, no e-mail
    const r = m.redact("Failed https://h:4000/api/x?token=abc · password: hunter2 · mail elia@example.com");
    assert.doesNotMatch(r, /abc|hunter2|elia@example\.com/, who);
    assert.match(r, /\/api\/x/, who);
  }
  const w = await web();
  assert.deepEqual(w.routeEntry("/discover/:type/:id", "#/discover/series/tt0903747?s=2&e=3"), { s: "/discover/:type/:id", ty: "series", id: "tt0903747" });
  assert.deepEqual(w.routeEntry("/party/:code", "#/party/QW3R7Y"), { s: "/party/:code" });
  assert.deepEqual(w.routeEntry("/search/:q", "#/search/batman"), { s: "/search/:q" }, "the search is the request's entry, not the screen's");
  assert.equal(w.safeRoute("#/pair/ABCD12"), "#/pair/…");
  assert.equal(w.safeRoute("#/movie/abc"), "#/movie/abc");
});

test("other profiles' names come out as “someone”, whole words only, any script", async () => {
  for (const [who, m] of await both()) {
    const { now } = clockAt();
    const t = new m.Trail({ now });
    t.add("toast", { m: "Dor joined the party" });
    t.add("toast", { m: "Doris and דנה are here" });
    t.add("tap", { r: "button", l: "Continue as Dor" });
    const out = t.take({ names: ["Dor", "דנה"] });
    assert.equal(out[0].m, "someone joined the party", who);
    assert.equal(out[1].m, "Doris and someone are here", who);
    assert.equal(out[2].l, "Continue as someone", who);
  }
});

test("the same words on every client: each kind of step as a line, flagged where it went wrong", async () => {
  const steps = [
    { t: 125000, k: "nav", s: "/movie/:id", id: "abc" },
    { t: 120000, k: "tap", ui: "detail.play" },
    { t: 119000, k: "tap", r: "button", l: "Cancel" },
    { t: 118000, k: "key", key: "ArrowDown", n: 4 },
    { t: 110000, k: "sheet", s: "Report a problem", on: true },
    { t: 100000, k: "toast", m: "Added to My List" },
    { t: 90000, k: "req", m: "GET", p: "/api/item/abc", s: 500, ms: 3200 },
    { t: 85000, k: "req", m: "POST", p: "/api/mylist", s: 200, ms: 40 },
    { t: 80000, k: "search", q: "dune" },
    { t: 70000, k: "play", e: "seek", from: 60, to: 1830 },
    { t: 65000, k: "play", e: "stall", ms: 4200, at: 1834 },
    { t: 60000, k: "play", e: "mark", mk: "path", path: "jit" },
    { t: 50000, k: "err", w: "js", m: "TypeError: x is undefined" },
    { t: 40000, k: "net", on: false },
    { t: 30000, k: "app", e: "hidden" },
    { t: 20000, k: "feat", f: "audio_track" },
  ];
  const w = await web();
  const lines = steps.map(w.trailLine);
  assert.deepEqual(lines, [
    "opened /movie/:id (abc)",
    "pressed detail.play",
    "pressed button “Cancel”",
    "key ArrowDown ×4",
    "opened “Report a problem”",
    "was shown: “Added to My List”",
    "GET /api/item/abc → 500 in 3.2 s",
    "POST /api/mylist → 200 in 40 ms",
    "searched “dune”",
    "seek 1:00 → 30:30",
    "stalled 4.2 s at 30:34",
    "player mark path (path jit)",
    "error (js): TypeError: x is undefined",
    "went offline",
    "left the app (out of sight)",
    "used audio_track",
  ]);
  assert.deepEqual(steps.map(w.trailLevel).map((l, i) => (l ? i : -1)).filter((i) => i >= 0), [6, 10, 12, 13]);
  assert.equal(w.trailAgo(125000), "−2:05");
  const text = w.trailText({ trail: steps, env: { app: "web", v: "1.15.27", up: 3700, installed: true }, player: { id: "abc", pos: 1834, ahead: 0, path: "jit" }, reqs: [{ t: 1000, m: "GET", p: "/api/me", s: 200, ms: 12 }] });
  assert.match(text, /−1:30  !! GET \/api\/item\/abc → 500 in 3\.2 s/);
  assert.match(text, /installed as an app: yes/);
  assert.match(text, /this session: 1:01:40/);
  assert.match(text, /position: 30:34/);
  assert.match(text, /−0:01  GET \/api\/me → 200 in 12 ms/);
  if (app) {
    assert.deepEqual(steps.map(app.trailLine), lines, "the apps say the same");
    assert.deepEqual(steps.map(app.trailLevel), steps.map(w.trailLevel));
    assert.equal(app.trailText({ trail: steps, env: { app: "tv", v: "5.9.2" } }), w.trailText({ trail: steps, env: { app: "tv", v: "5.9.2" } }));
  }
});

// ------------------------------------------------------------ the server
const lib = require("../src/lib/reporttrail");

test("the server keeps known kinds only, flat short values, no markup, in order — whatever a client sends", () => {
  const out = lib.cleanTrail([
    { t: 5000, k: "toast", m: "<img src=x onerror=alert(1)>hi" },
    { t: 9000, k: "nav", s: "/movie/:id", id: "abc", deep: { a: 1 }, list: [1, 2], fn: "x".repeat(500) },
    { t: 1000, k: "evil", m: "dropped" },
    { t: -50, k: "key", key: "Enter", n: 3 },
    { t: 1e15, k: "app", e: "start", n: -2 },
    "not an object",
    null,
    { t: 2000, k: "req", "bad key!": 1, m: "GET", p: "/api/x", s: 500, ms: Infinity },
  ]);
  assert.deepEqual(out.map((e) => e.k), ["app", "nav", "toast", "req", "key"], "oldest first, unknown kinds gone");
  const nav = out.find((e) => e.k === "nav");
  assert.equal(nav.deep, undefined);
  assert.equal(nav.list, undefined);
  assert.equal(nav.fn.length, 160);
  assert.equal(out.find((e) => e.k === "toast").m, "‹img src=x onerror=alert(1)›hi");
  assert.equal(out.find((e) => e.k === "key").t, 0);
  assert.equal(out.find((e) => e.k === "key").n, 3);
  assert.equal(out.find((e) => e.k === "app").n, undefined, "a count is a whole number above zero");
  assert.equal(out.find((e) => e.k === "app").t, 24 * 3600 * 1000);
  assert.equal(out.find((e) => e.k === "req").ms, undefined);
  assert.equal(out.find((e) => e.k === "req")["bad key!"], undefined);
});

test("the server caps a hostile trail in count and bytes, and takes other profiles' names out itself", () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ t: 5000 - i, k: "toast", m: `${"y".repeat(150)} ${i}` }));
  const out = lib.cleanTrail(many);
  assert.ok(out.length <= lib.LIMITS.ENTRIES);
  assert.ok(JSON.stringify(out).length <= lib.LIMITS.TRAIL_BYTES);
  const named = lib.cleanTrail([{ t: 1, k: "toast", m: "Watcher joined · Dorothy stays" }], { names: ["Watcher", "Dor"] });
  assert.equal(named[0].m, "someone joined · Dorothy stays");
  assert.deepEqual(lib.cleanTrail("nope"), []);
  assert.equal(lib.cleanEnv([1, 2]), null);
  assert.equal(lib.cleanEnv(null), null);
  const env = lib.cleanEnv(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, `v${i}`])));
  assert.equal(Object.keys(env).length, lib.LIMITS.ENV_KEYS);
  assert.deepEqual(lib.cleanReqs([{ t: 5, m: "GET", p: "/api/x", s: 200, ms: 10 }, { p: 3 }, "x"]), [{ t: 5, m: "GET", p: "/api/x", s: 200, ms: 10 }]);
});

test("a report from an old client (no trail) is filed as before; a new one keeps its trail, facts, player and requests", () => {
  const reports = require("../src/routes/reports");
  const old = reports.add({ text: "old app", quiet: true, context: { route: "tv:Home", look: "tv", version: "5.0.0" } });
  assert.equal(old.text, "old app");
  assert.deepEqual(old.context.trail, []);
  assert.equal(old.context.env, null);
  assert.equal(old.context.player, null);
  assert.deepEqual(old.context.reqs, []);
  assert.ok(old.context.srv && typeof old.context.srv.up === "number", "the server's own facts are there for every report");

  const r = reports.add({
    text: "it froze", quiet: true,
    context: {
      route: "#/pair/SECRET1",
      trail: [{ t: 3000, k: "play", e: "stall", ms: 4100, at: 600 }, { t: 0, k: "tap", ui: "report.send" }],
      env: { app: "web", v: "1.15.27", screen: "1920×1080 @1x", nested: { x: 1 } },
      player: { id: "abc", pos: 600, path: "jit" },
      reqs: [{ t: 2000, m: "GET", p: "/api/item/abc", s: 0, ms: 30000 }],
    },
  });
  assert.equal(r.context.route, "#/pair/…", "a pairing code in the address does not land with the admin");
  assert.deepEqual(r.context.trail.map((e) => e.k), ["play", "tap"]);
  assert.deepEqual(r.context.env, { app: "web", v: "1.15.27", screen: "1920×1080 @1x" });
  assert.deepEqual(r.context.player, { id: "abc", pos: 600, path: "jit" });
  assert.equal(r.context.reqs[0].s, 0);
  // the store keeps the heavy parts on the newest reports only
  const all = require("../src/routes/reports");
  assert.ok(all.openCount() >= 2);
});
