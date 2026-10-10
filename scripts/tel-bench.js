// What the telemetry costs (docs/analytics.md, "What it costs"): run with
//   node scripts/tel-bench.js
// It measures the client's hot path (the pure core the site and the TV app
// share — public/js/telemetry-core.js), the size of what goes over the wire,
// and what a batch costs the server in time and on disk. Memory only: it
// writes nothing and sends nothing.
"use strict";
const path = require("path");

const ns = (fn, n) => {
  for (let i = 0; i < Math.min(n, 20000); i++) fn(i); // warm up
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn(i);
  return Number(process.hrtime.bigint() - t0) / n;
};
const fmt = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} ms` : v >= 1000 ? `${(v / 1000).toFixed(1)} µs` : `${v.toFixed(0)} ns`);

(async () => {
  const core = await import("file://" + path.join(__dirname, "..", "public", "js", "telemetry-core.js").replace(/\\/g, "/"));
  const tel = require("../src/lib/tel");
  tel._reset();

  console.log("CLIENT — per event, on this machine (a TV box's CPU is roughly 10–30× slower)");
  let lastInput = 0;
  console.log(`  a key press (the idle gate's one assignment)      ${fmt(ns(() => { lastInput = Date.now(); }, 2e6))}`);
  const counter = new core.ControlCounter();
  const ids = ["card.open", "detail.play", "player.seek.fwd", "nav.home"];
  console.log(`  a press on a tagged control (ControlCounter.hit)   ${fmt(ns((i) => counter.hit("tv:home", ids[i & 3], "remote"), 2e6))}`);
  const heapBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < 1e6; i++) counter.hit("tv:home", ids[i & 3], "remote");
  console.log(`  …heap growth over a million presses                ${Math.max(0, Math.round((process.memoryUsage().heapUsed - heapBefore) / 1024))} KB`);
  const book = new core.ErrorBook();
  book.add("img", "error", "/img/:id?w=256", { screen: "tv:home", ctx: { status: 401 }, raw: true });
  console.log(`  a repeat of a known error (ErrorBook.add, raw)     ${fmt(ns(() => book.add("img", "error", "/img/:id?w=256", { screen: "tv:home", ctx: { status: 401 }, raw: true }), 5e5))}`);
  console.log(`  a new error message (normalised, then counted)     ${fmt(ns((i) => new core.ErrorBook().add("js", "error", `Cannot read properties of undefined (reading 'x${i % 7}') at http://10.0.0.5:4000/js/a.js:${i}`), 5e4))}`);
  const timers = new core.Timers(() => Date.now());
  console.log(`  a timing (Timers.value)                            ${fmt(ns((i) => { timers.value("nav_paint", i % 900, "tv:home"); if (timers.done.length > 100) timers.done.length = 0; }, 1e6))}`);
  void lastInput;

  // a busy session's batch: the usage events of 20 seconds, 3 kinds of error, 8 timings, 12 controls
  const batch = (i = 0) => ({
    profile: "p1", sid: "abcd1234", device: "tv", look: "tv", iid: `box${String(i).padStart(13, "0")}`, app: "tv", v: "5.1.31", model: "Acme Box 2", os: "android 30", auth: "open", flags: ["lite"],
    events: [{ n: "route", t: Date.now(), p: { r: "tv:detail", ms: 420 } }, { n: "route", t: Date.now(), p: { r: "tv:home", ms: 300 } }, { n: "feat", t: Date.now(), p: { f: "trailer_play" } }],
    tel: {
      e: [{ k: "img", l: "error", m: "/img/:id?w=256", n: 37, t0: Date.now(), t1: Date.now(), r: "tv:home", c: { status: 401 } }, { k: "http", l: "warn", m: "GET /api/item/:id?profile", n: 2, t0: Date.now(), t1: Date.now(), r: "tv:detail", c: { status: 404 } }, { k: "console", l: "warn", m: "[player] slow start", n: 1, t0: Date.now(), t1: Date.now(), r: "tv:player" }],
      t: [["nav_paint", 420, "tv:detail"], ["nav_paint", 300, "tv:home"], ["title_content", 380, "library"], ["title_backdrop", 1100, "library"], ["play_first_frame", 2100, "direct"], ["seek_resume", 900, "direct"], ["grid_first_poster", 500, "tv:home"], ["search_results", 240, "library"]],
      u: [["tv:home", "card.open", "remote", 4, 1], ["tv:home", "nav.movies", "remote", 1, 1], ["tv:detail", "detail.play", "remote", 2, 1], ["tv:detail", "detail.trailer", "remote", 1, 1], ["tv:player", "player.playpause", "remote", 6, 1], ["tv:player", "player.seek.fwd", "remote", 9, 1], ["tv:player", "player.seek.back", "remote", 3, 1], ["tv:player", "player.subtitles.open", "remote", 1, 1], ["tv:player", "player.subtitles.pick", "remote", 1, 1], ["tv:player", "player.back", "remote", 1, 1], ["tv:browse/movie", "card.open", "remote", 2], ["tv:browse/movie", "browse.category.pick", "remote", 3, 1]],
    },
  });
  const bytes = Buffer.byteLength(JSON.stringify(batch()));
  const quiet = Buffer.byteLength(JSON.stringify({ ...batch(), tel: { t: [["nav_paint", 420, "tv:detail"]], u: [["tv:home", "card.open", "remote", 1]] }, events: [{ n: "route", t: Date.now(), p: { r: "tv:detail", ms: 420 } }] }));
  console.log("\nWIRE");
  console.log(`  a busy batch (3 events, 3 error kinds, 8 timings, 12 controls)   ${bytes} bytes`);
  console.log(`  an ordinary one (1 event, 1 timing, 1 control)                   ${quiet} bytes`);
  console.log(`  at most one batch per 20 s of use: a two-hour evening of browsing is ≤ 360 batches,`);
  console.log(`  in practice a few dozen (a film that is playing gives little to report) — about ${Math.round((40 * quiet + 5 * bytes) / 1024)} KB`);

  console.log("\nSERVER — per batch");
  let i = 0;
  console.log(`  validate, scrub, fingerprint, count (tel.record)   ${fmt(ns(() => tel.record(batch(i++ % 4000)), 4000))}`); // (4000 different devices, so no daily allowance is in the way)
  const usage = require("../src/lib/usage");
  usage._reset();
  console.log(`  the usage events beside it (usage.record)          ${fmt(ns(() => usage.record(batch(i++ % 4000), { persist: false }), 4000))}`);
  const mw = tel.timings.middleware;
  const res = { statusCode: 200, once: () => {} };
  console.log(`  the timing middleware on an unwatched request      ${fmt(ns(() => mw({ path: "/api/profiles", query: {} }, res, () => {}), 1e6))}`);
  console.log(`  …on a watched one (/api/home)                      ${fmt(ns(() => mw({ path: "/api/home", query: {} }, res, () => {}), 1e6))}`);

  // disk: a fleet of 30 devices, 30 days, each reporting from 2 versions, 60 kinds of error
  tel._reset();
  const DAY = 86400000;
  const now = Date.now();
  for (let d = 30; d >= 0; d--) {
    for (let dev = 0; dev < 30; dev++) {
      for (let b = 0; b < 4; b++) {
        const x = batch(dev % 30);
        x.v = d > 15 ? "5.1.30" : "5.1.31";
        x.tel.s = b === 0 ? 1 : 0;
        x.tel.e = [0, 1, 2].map((k) => ({ k: "js", m: `fault kind ${String.fromCharCode(97 + ((dev + d + k * 7) % 26))}${String.fromCharCode(97 + ((d * 3 + k) % 26)) }`, n: 1 + (dev % 5) }));
        tel.record(x, {}, now - d * DAY + b * 3600000);
      }
    }
  }
  const size = (o) => Buffer.byteLength(JSON.stringify(o));
  const e = size(tel.errors._internals.state);
  const t = size({ v: 1, hists: tel.timings._internals.hists });
  const c = size({ v: 1, days: tel.controls._internals.days });
  console.log("\nDISK — 30 devices × 30 days × 4 batches a day (3,720 batches), two versions");
  console.log(`  tel-errors.json     ${(e / 1024).toFixed(0)} KB   (${tel.errors.list().length} kinds; capped at ${tel.errors.LIMITS.MAX_FPS})`);
  console.log(`  tel-timings.json    ${(t / 1024).toFixed(0)} KB   (${Object.keys(tel.timings._internals.hists).length} histograms; capped at ${tel.timings.LIMITS.MAX_KEYS})`);
  console.log(`  tel-controls.json   ${(c / 1024).toFixed(0)} KB   (30 days kept)`);
  console.log(`  per device per day  ${Math.round((e + t + c) / 30 / 31)} bytes — and it stops growing: every store is a fixed-size aggregate, not a log`);
  tel._reset();
})();
