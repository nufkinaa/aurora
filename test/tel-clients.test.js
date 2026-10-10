// The pure half of both clients' telemetry: public/js/telemetry-core.js (the
// site) and tv-native/src/telemetryCore.ts (the TV app — the same logic,
// typed). What a message is reduced to before it leaves the device, the book
// that counts repeats instead of sending them, the control counter, the
// timers and the idle gate. The TV file is compiled on the spot with the TV
// project's own TypeScript; where that is not installed (a root-only
// `npm ci`), the TV half is skipped and the site's half still runs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const scrub = require("../src/lib/tel/scrub");

const webCore = () => import("../public/js/telemetry-core.js");
const tvCore = () => {
  let ts;
  try { ts = require(path.join(__dirname, "..", "tv-native", "node_modules", "typescript")); } catch { return null; }
  const file = path.join(__dirname, "..", "tv-native", "src", "telemetryCore.ts");
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const m = new Module(file, module);
  m.filename = file;
  m.paths = module.paths;
  m._compile(js, file);
  return m.exports;
};

const SAMPLES = [
  "Cannot read properties of undefined (reading 'duration')",
  "Request timed out after 30000 ms (attempt 3)",
  "Could not open \"The Example Film (1999)\"",
  "GET http://192.168.1.20:4000/img/3f9a2c1b7d4e?w=256 failed",
  "read failed D:\\Movies\\The Example Film (1999)\\The Example Film.mkv: EIO",
  "read failed /mnt/media/Shows/Some Show/Season 1/e01.mkv",
  "mail anna.tester@example.com bounced",
  "token=abc123def456ghi789 rejected",
  "title tt0133093 not found for Some Show S02E05",
  "bad jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
  "שגיאה בטעינת הסרט \"שם הסרט\"",
  "TypeError: x is not a function\n    at foo (http://h/js/a.js:1:2)",
];

const shared = (name, get) => {
  test(`${name}: a message is reduced on the device — and the server would not change it further`, async (t) => {
    const core = await get();
    if (!core) return t.skip("the TV project's TypeScript is not installed");
    for (const s of SAMPLES) {
      const out = core.normMessage(s);
      assert.equal(scrub.sensitive(out), null, `${s} → ${out}`);
      assert.ok(out.length <= 160);
      // already reduced: the server's pass is a no-op, so both ends agree on the fingerprint's input
      assert.equal(scrub.normMessage(out), out, `the server would change "${out}"`);
    }
    assert.equal(core.normMessage("Request timed out after 30000 ms"), core.normMessage("Request timed out after 45000 ms"));
    assert.match(core.normMessage("reading 'currentTime'"), /'currentTime'/);
    assert.doesNotMatch(core.normMessage("could not find 'Inception'"), /Inception/);
  });

  test(`${name}: an address is reduced to its shape`, async (t) => {
    const core = await get();
    if (!core) return t.skip("the TV project's TypeScript is not installed");
    assert.equal(core.urlPattern("http://10.0.0.5:4000/img/3f9a2c1b7d4e?w=256"), "/img/:id?w=256");
    assert.equal(core.urlPattern("/api/item/9af3c2d1e0b4?profile=anna"), "/api/item/:id?profile");
    assert.equal(core.urlPattern("/api/search?q=the+example+film"), "/api/search?q");
    assert.equal(core.urlPattern("/hls/abc123def456/720/seg-00012.ts"), "/hls/:id/:id/:file.ts");
    assert.equal(core.urlPattern("/img/ext?u=https%3A%2F%2Fimages.example%2Fp.jpg&w=256"), "/img/ext?u&w=256");
    // whatever the device kept, the server keeps only its own route words
    assert.equal(scrub.urlPattern(core.urlPattern("/api/inception/secret")), "/api/:id/:id");
    for (const u of ["/api/search?q=anna@example.com", "/stream/abcdef0123456789/The Example Film.mkv"]) assert.equal(scrub.sensitive(core.urlPattern(u)), null);
  });

  test(`${name}: the error book — repeats count up, kinds are capped, a failed batch comes back`, async (t) => {
    const core = await get();
    if (!core) return t.skip("the TV project's TypeScript is not installed");
    const book = new core.ErrorBook({ perSession: 5, perDay: 8, sentToday: 0 });
    for (let i = 0; i < 37; i++) book.add("img", "error", "/img/:id?w=256", { screen: "tv:home", ctx: { status: 401 }, raw: true, now: 1000 + i });
    book.add("img", "error", "/img/:id?w=256", { screen: "tv:home", ctx: { status: 502 }, raw: true });
    assert.equal(book.size, 2, "thirty-seven refused pictures are one entry; another status is another");
    const [first] = book.drain(1);
    assert.deepEqual(first, { k: "img", l: "error", m: "/img/:id?w=256", n: 37, t0: 1000, t1: 1036, r: "tv:home", c: { status: 401 } });
    // only the keys of the contract ever leave
    for (const k of Object.keys(first)) assert.ok(["k", "l", "m", "n", "t0", "t1", "s", "r", "c"].includes(k), k);
    // the same kind again after it was sent: it counts from one, and is not a new kind
    book.add("img", "error", "/img/:id?w=256", { ctx: { status: 401 }, raw: true });
    assert.equal(book.seen.size, 2);
    // five kinds a session
    for (const m of ["a fault", "b fault", "c fault", "d fault", "e fault"]) book.add("js", "error", m);
    assert.equal(book.seen.size, 5);
    assert.equal(book.dropped, 2);
    assert.equal(book.add("js", "error", "yet another"), false);
    // a batch that did not get through
    const out = book.drain();
    assert.equal(book.size, 0);
    book.add("js", "error", "a fault");
    book.restore(out);
    assert.equal(book.items.size, out.length);
    assert.equal([...book.items.values()].find((r) => r.m === "a fault").n, 2);
    // and a device's day
    const tired = new core.ErrorBook({ perSession: 40, perDay: 8, sentToday: 7 });
    assert.equal(tired.add("js", "error", "one more"), true);
    assert.equal(tired.add("js", "error", "and another"), false, "the day's allowance is spent");
    assert.equal(new core.ErrorBook().add("js", "error", ""), false, "nothing to say is nothing");
    // 20 a batch; the rest wait
    const big = new core.ErrorBook();
    for (let i = 0; i < 30; i++) big.add("js", "error", `kind ${String.fromCharCode(97 + i)}`);
    assert.equal(big.drain().length, core.LIMITS.REPORTS_PER_BATCH);
    assert.equal(big.size, 10);
  });

  test(`${name}: a press is an increment — counts per screen, control and input, sent as totals`, async (t) => {
    const core = await get();
    if (!core) return t.skip("the TV project's TypeScript is not installed");
    const c = new core.ControlCounter();
    assert.deepEqual(c.drain(), []);
    for (let i = 0; i < 5; i++) c.hit("tv:home", "card.open", "remote");
    c.hit("tv:detail", "detail.play", "remote");
    c.hit("tv:detail", "card.open", "remote");
    assert.deepEqual(c.drain(), [["tv:home", "card.open", "remote", 5, 1], ["tv:detail", "detail.play", "remote", 1, 1], ["tv:detail", "card.open", "remote", 1]]);
    assert.deepEqual(c.drain(), [], "sent once");
    c.hit("tv:home", "card.open", "remote");
    assert.deepEqual(c.drain(), [["tv:home", "card.open", "remote", 1]], "not this session's first use any more");
    // a hold of the remote: ten thousand presses allocate no new keys
    const keys = () => Object.keys(c.screens).length + Object.values(c.screens).reduce((s, o) => s + Object.keys(o).length, 0);
    const before = keys();
    for (let i = 0; i < 10000; i++) c.hit("tv:home", "card.open", "remote");
    assert.equal(keys(), before);
    assert.deepEqual(c.drain(), [["tv:home", "card.open", "remote", 10000]]);
    c.hit("x", "y", "remote");
    c.clear();
    assert.deepEqual(c.drain(), []);
  });

  test(`${name}: timers — a span, a lap, a value; bounded`, async (t) => {
    const core = await get();
    if (!core) return t.skip("the TV project's TypeScript is not installed");
    let now = 1000;
    const tm = new core.Timers(() => now);
    tm.start("play");
    assert.equal(tm.running("play"), true);
    now += 2100;
    assert.deepEqual(tm.end("play", "direct"), ["play", 2100, "direct"]);
    assert.equal(tm.end("play"), null, "ended once");
    assert.equal(tm.end("never-started"), null);
    assert.deepEqual(tm.value("nav_paint", 419.6), ["nav_paint", 420]);
    assert.equal(tm.value("x", -5), null);
    assert.equal(tm.value("x", NaN), null);
    tm.start("gone");
    tm.cancel("gone");
    assert.equal(tm.running("gone"), false);
    for (let i = 0; i < 500; i++) tm.value("nav_paint", i, "tv:home");
    assert.equal(tm.done.length, core.LIMITS.TIMINGS_HELD, "the oldest make room");
    assert.equal(tm.drain().length, core.LIMITS.TIMINGS_PER_BATCH);
    assert.equal(core.playPath({ torrent: true, transcode: true }), "torrent");
    assert.equal(core.playPath({ remux: true }), "remux");
    assert.equal(core.playPath({ transcode: true }), "transcode");
    assert.equal(core.playPath({ offline: true }), "offline");
    assert.equal(core.playPath({}), "direct");
  });

  test(`${name}: nothing is sent while someone is moving about, or while a play is starting`, async (t) => {
    const core = await get();
    if (!core) return t.skip("the TV project's TypeScript is not installed");
    assert.equal(core.idleNow({ sinceInputMs: 0, playStarting: false }), false, "a key was just pressed");
    assert.equal(core.idleNow({ sinceInputMs: core.IDLE_MS - 1, playStarting: false }), false, "a key-repeat burst keeps the gate shut");
    assert.equal(core.idleNow({ sinceInputMs: core.IDLE_MS, playStarting: false }), true);
    assert.equal(core.idleNow({ sinceInputMs: 60000, playStarting: true }), false, "between Play and the first frame");
    assert.ok(core.IDLE_MS >= 2000);
  });
};

shared("site", webCore);
shared("TV", async () => tvCore());

test("the site and the TV reduce a message to the same thing", async (t) => {
  const web = await webCore();
  const tv = tvCore();
  if (!tv) return t.skip("the TV project's TypeScript is not installed");
  for (const s of SAMPLES) assert.equal(tv.normMessage(s), web.normMessage(s), s);
  for (const u of ["http://h:1/img/abc123?w=256", "/api/item/x1?profile=a", "/a/b/c.m3u8?t=1"]) assert.equal(tv.urlPattern(u), web.urlPattern(u), u);
  assert.deepEqual(Object.keys(tv.LIMITS).sort(), Object.keys(web.LIMITS).sort());
});

test("site: where an error came from — the app's own files, a function name, never a line or a host", async () => {
  const { locOf } = await webCore();
  const chrome = "TypeError: x\n    at onStall (http://10.0.0.5:4000/js/screens/player.js?v=ab12cd:4777:12)\n    at HTMLVideoElement.<anonymous> (http://10.0.0.5:4000/js/screens/player.js?v=ab12cd:900:3)\n    at flush (http://10.0.0.5:4000/js/usage.js:40:1)";
  assert.equal(locOf(chrome), "screens/player.js:onStall < screens/player.js");
  const safari = "onStall@http://10.0.0.5:4000/js/screens/player.js:4777:12\nflush@http://10.0.0.5:4000/js/usage.js:40:1";
  assert.equal(locOf(safari), "screens/player.js:onStall < usage.js:flush");
  assert.equal(locOf("Error\n    at t (http://10.0.0.5:4000/js/vendor/hls.min.js:1:2345)\n    at json (http://10.0.0.5:4000/js/api.js:20:5)"), "api.js:json", "vendor frames are skipped");
  assert.equal(locOf(""), "");
  assert.equal(locOf(undefined), "");
  for (const s of [chrome, safari]) {
    assert.equal(scrub.sensitive(locOf(s)), null);
    assert.equal(scrub.normLocation(locOf(s)), locOf(s), "the server keeps it as it is");
  }
});

test("site: the browser is a family and a major version, nothing finer", async () => {
  const { uaClass } = await webCore();
  assert.deepEqual(uaClass("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.55 Mobile Safari/537.36"), { browser: "chrome 141", os: "android" });
  assert.deepEqual(uaClass("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), { browser: "safari 18", os: "ios" });
  assert.deepEqual(uaClass("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"), { browser: "edge 141", os: "windows" });
  assert.deepEqual(uaClass("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"), { browser: "firefox 130", os: "linux" });
  assert.deepEqual(uaClass(""), { browser: "other", os: "other" });
});
