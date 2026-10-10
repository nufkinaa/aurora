// The telemetry contract (docs/analytics.md), held by tests:
//   • a control id is tagged in the code exactly when it is on the list;
//   • an address can only be reduced to words the server's own routes have;
//   • whatever a client sends — here: a batch built to smuggle a title, a
//     name, search text, an address, a token, a path — nothing of it reaches
//     a store, a summary or the copied text, and no store grows a key that is
//     not on its whitelist;
//   • the document names every event, timing, kind and control there is.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const tel = require("../src/lib/tel");
const usage = require("../src/lib/usage");
const vocab = require("../src/lib/tel/vocab");

const ROOT = path.join(__dirname, "..");
const walk = (dir, ext, out = []) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (!/^(node_modules|vendor|sandbox|android|ios|__tests__)$/.test(f.name)) walk(p, ext, out); } else if (ext.test(f.name)) out.push(p);
  }
  return out;
};
// every "a.b.c" literal on a line that tags a control
const tagsIn = (files, lineRe) => {
  const ids = new Map(); // id -> first file
  for (const f of files) {
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      if (!lineRe.test(line)) continue;
      for (const m of line.matchAll(/["']([a-z]+(?:\.[a-z]+)+)["']/g)) if (!/\.(js|ts|tsx|css|html|json)$/.test(m[1]) && !ids.has(m[1])) ids.set(m[1], path.relative(ROOT, f));
    }
  }
  return ids;
};

test("controls: every tag on the site is on the list, and every id the list gives the site is tagged", () => {
  const tagged = tagsIn(walk(path.join(ROOT, "public"), /\.(js|html)$/), /data-ui|uiHit\(/);
  const listed = Object.keys(vocab.CONTROLS).filter((id) => vocab.CONTROLS[id].includes("w"));
  for (const [id, file] of tagged) assert.ok(vocab.CONTROLS[id] && vocab.CONTROLS[id].includes("w"), `${id} (tagged in ${file}) is not in src/lib/tel/controls-vocab.js for the site`);
  for (const id of listed) assert.ok(tagged.has(id), `${id} is on the list for the site but tagged nowhere — it would sit under "never used" for ever`);
  assert.ok(listed.length >= 60, `${listed.length} controls tagged on the site`);
});

test("controls: the same for the TV app", () => {
  const tagged = tagsIn(walk(path.join(ROOT, "tv-native", "src"), /\.tsx?$/), /uiId|uiHit\(/);
  const listed = Object.keys(vocab.CONTROLS).filter((id) => vocab.CONTROLS[id].includes("t"));
  for (const [id, file] of tagged) assert.ok(vocab.CONTROLS[id] && vocab.CONTROLS[id].includes("t"), `${id} (tagged in ${file}) is not in src/lib/tel/controls-vocab.js for the TV`);
  for (const id of listed) assert.ok(tagged.has(id), `${id} is on the list for the TV but tagged nowhere`);
  assert.ok(listed.length >= 60, `${listed.length} controls tagged on the TV`);
});

test("controls: ids are lower-case dotted words, and each belongs to at least one app", () => {
  for (const [id, where] of Object.entries(vocab.CONTROLS)) {
    assert.match(id, /^[a-z]+(\.[a-z]+){1,3}$/, id);
    assert.match(where, /^(w|t|wt)$/, `${id}: ${where}`);
  }
});

test("addresses: every path word of the server's routes is a word urlPattern keeps", () => {
  const files = [...walk(path.join(ROOT, "src", "routes"), /\.js$/), path.join(ROOT, "server.js")];
  const missing = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:router|app)\.(?:get|post|put|delete|patch|use|all)\(\s*["'`](\/[^"'`]*)["'`]/g)) {
      for (const seg of m[1].split("/").filter(Boolean)) {
        if (seg.startsWith(":") || /[*(]/.test(seg)) continue;
        const low = seg.toLowerCase();
        const ext = /\.([a-z0-9]{2,12})$/.exec(low);
        if (ext ? !vocab.SEGMENTS.has("." + ext[1]) : !vocab.SEGMENTS.has(low)) missing.add(seg);
      }
    }
  }
  assert.deepEqual([...missing], [], "add these to SEGMENTS in src/lib/tel/vocab.js (or a failing request to them is reported as /:id)");
});

// ------------------------------------------------------------ the adversarial batch
const TITLE = "The Example Film";
const NEEDLES = [TITLE, "Example Film", "Anna Tester", "anna.tester", "example.com", "hunter2", "sekrit-token-abc123def456", "192.168.1.77", "tt0133093", "secret search words", "Some Show", "D:\\Movies", "/mnt/media", "eyJhbGci", "0123456789abcdef0123456789abcdef", "שם הסרט"];
const hostile = () => ({
  profile: "p1", sid: "abcd1234", device: "phone", look: "glass", iid: "tabaaaaaaaaaaaa1", app: "web", v: "1.6.86",
  model: `chrome 141 ${TITLE}`, os: "anna.tester@example.com", net: "secret search words", auth: TITLE, flags: [TITLE, "look:glass", "tt0133093"],
  title: TITLE, user: "Anna Tester", cookie: "aurora_session=0123456789abcdef0123456789abcdef",
  events: [
    { n: "error", t: Date.now(), p: { m: `Could not play "${TITLE}" for Anna Tester at http://192.168.1.77:4000/stream/tt0133093?token=sekrit-token-abc123def456` } },
    { n: "route", t: Date.now(), p: { r: "/movie/:id", ms: 10 } },
  ],
  tel: {
    s: 1,
    title: TITLE,
    e: [
      { k: "js", l: "error", m: `Could not play "${TITLE}" (tt0133093) for Anna Tester <anna.tester@example.com>`, s: `http://192.168.1.77:4000/js/screens/player.js?token=sekrit-token-abc123def456:play${TITLE.replace(/ /g, "")}:10:2`, r: `/movie/tt0133093`, title: TITLE, c: { status: 500, title: TITLE, q: "secret search words" } },
      { k: "js", m: `search for 'secret search words' failed: password=hunter2 session: 0123456789abcdef0123456789abcdef` },
      { k: "console", l: "warn", m: `[player] stalled ${TITLE} S02E05 Some Show D:\\Movies\\${TITLE} (1999)\\${TITLE}.mkv /mnt/media/Shows/Some Show/e01.mkv` },
      { k: "http", m: `GET http://192.168.1.77:4000/api/search?q=secret+search+words&profile=Anna%20Tester`, c: { status: 500 } },
      { k: "http", m: `POST /api/${encodeURIComponent(TITLE)}/Anna Tester`, c: { status: 404 } },
      { k: "img", m: `/img/ext?u=https%3A%2F%2Fexample.com%2F${encodeURIComponent(TITLE)}.jpg&w=256`, c: { status: 502 } },
      { k: "promise", m: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbm5hIn0.sig rejected for הסרט \"שם הסרט\"" },
      { k: "media", m: TITLE },
      { k: TITLE, m: "x" },
    ],
    t: [["play_first_frame", 1200, TITLE], ["nav_paint", 200, "/movie/tt0133093"], [TITLE, 5], ["search_results", 300, "secret search words"]],
    u: [["/movie/tt0133093", "detail.play", "mouse", 1, 1], ["/", TITLE, "mouse", 1], ["/search/secret search words", "card.open", TITLE, 2, 1]],
  },
});

test("a batch built to smuggle personal things leaves none of them in any store, summary or text", () => {
  tel._reset();
  usage._reset();
  // what the server knows of its own household: the library's titles, the profiles' names
  tel.scrub.setDictionary({ titles: [TITLE, "Some Show"], people: ["Anna Tester"] });
  const kept = tel.record(hostile());
  usage.record(hostile(), { persist: false });
  assert.ok(kept.errors >= 6 && kept.timings >= 2 && kept.controls >= 2, "the batch was counted — in its reduced form");
  const everything = JSON.stringify({
    errors: tel.errors._internals.state.fps,
    known: tel.errors._internals.state.known,
    timings: tel.timings._internals.hists,
    controls: tel.controls._internals.days,
    summary: tel.summary(),
    text: tel.text(),
    usage: usage.summary(),
    usageText: usage.text(),
    validated: usage.validate(hostile()),
  });
  for (const n of NEEDLES) assert.ok(!everything.includes(n), `"${n}" reached the stores`);
  const msgs = tel.errors.list().map((f) => f.msg);
  for (const m of msgs) assert.equal(tel.scrub.sensitive(m), null, m);
  assert.ok(msgs.includes("<title>"), "a bare title from the library is known for what it is");
  assert.ok(msgs.some((m) => /<name>/.test(m)), "and so is a profile's name");
  tel._reset();
  usage._reset();
});

test("a title the server has never heard of is the one thing a scrubber cannot know — so the clients never send free text", () => {
  // A catalogue title that is not in the library is, to the server, a
  // sentence like any other: the dictionary cannot catch it. What stops a title is
  // that no client call site hands telemetry a title, a name or typed text:
  // every line that reports is checked here.
  const files = [...walk(path.join(ROOT, "public", "js"), /\.js$/), ...walk(path.join(ROOT, "tv-native", "src"), /\.tsx?$/)];
  const bad = [];
  for (const f of files) {
    if (/telemetry(-core|Core)?\.(js|ts)$/.test(f)) continue;
    for (const [i, line] of fs.readFileSync(f, "utf8").split(/\r?\n/).entries()) {
      if (!/\b(reportError|playerError|imageFailed|jsError|httpFailed|uiHit|tmValue|tmStart|tmEnd|tmLap|sinceNav|titleShown|playFirstFrame)\(/.test(line)) continue;
      const call = line.slice(line.search(/\b(reportError|playerError|imageFailed|jsError|httpFailed|uiHit|tmValue|tmStart|tmEnd|tmLap|sinceNav|titleShown|playFirstFrame)\(/)).replace(/\/\/.*$/, "")
        .replace(/\b(e|err|error)\.name\b/g, ""); // an Error's own name ("SecurityError") is code, not content
      if (/\.(title|name|showTitle|label|query|value|text)\b|\bquery\b|\bq\b(?!\w)/.test(call)) bad.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(bad, [], "a telemetry call is handed something a person named or typed");
});

test("the stores hold only whitelisted keys", () => {
  tel._reset();
  tel.record(hostile());
  const F_KEYS = new Set(["fp", "app", "kind", "level", "msg", "loc", "first", "last", "firstV", "n", "versions", "models", "screens", "auth", "net", "os", "flags", "ctx", "days", "hours", "alerted"]);
  for (const f of tel.errors.list()) {
    for (const k of Object.keys(f)) assert.ok(F_KEYS.has(k), `error record key "${k}"`);
    for (const k of Object.keys(f.ctx)) assert.ok(vocab.CTX_KEYS.includes(k), `context key "${k}"`);
    for (const k of Object.keys(f.screens)) assert.ok(k === "?" || k === "other" || vocab.SCREEN_RE.test(k), `screen "${k}"`);
    for (const k of Object.keys(f.auth)) assert.ok(k === "?" || vocab.AUTH_MODES.has(k), `auth "${k}"`);
    for (const k of Object.keys(f.net)) assert.ok(k === "?" || vocab.NET_TIERS.has(k), `net "${k}"`);
    for (const k of Object.keys(f.flags)) assert.match(k, vocab.FLAG_RE);
    assert.ok(vocab.ERROR_KINDS.has(f.kind));
    for (const d of Object.values(f.days)) { assert.deepEqual(Object.keys(d).sort(), ["ids", "n"]); for (const id of d.ids) assert.match(id, /^[0-9a-f]{6}$/); }
  }
  for (const key of Object.keys(tel.timings._internals.hists)) {
    const [metric, app, v, device, net, dim] = key.split("|");
    assert.ok(vocab.TIMINGS[metric], metric);
    assert.match(app, /^(web|tv|server)$/);
    assert.match(v, /^[A-Za-z0-9._?-]{1,16}$/);
    assert.ok(device === "-" || vocab.DEVICES.has(device));
    assert.ok(net === "-" || vocab.NET_TIERS.has(net));
    const def = vocab.TIMINGS[metric];
    assert.ok(dim === "-" || dim === "?" || dim === "other" || (def.dims === "screen" ? vocab.DIM_RE.test(dim) : def.dims.includes(dim)), `${metric} dimension "${dim}"`);
  }
  for (const day of Object.values(tel.controls._internals.days)) {
    for (const [app, a] of Object.entries(day)) {
      assert.match(app, /^(web|tv)$/);
      for (const [id, c] of Object.entries(a.c)) {
        assert.ok(vocab.CONTROLS[id], id);
        for (const s of Object.keys(c.by)) assert.ok(s === "?" || s === "other" || vocab.SCREEN_RE.test(s), `screen "${s}"`);
        for (const inp of Object.keys(c.in)) assert.ok(inp === "other" || vocab.INPUTS.has(inp), `input "${inp}"`);
      }
    }
  }
  tel._reset();
});

test("screens and dimensions cannot carry an id: no digits, no capitals", () => {
  for (const ok of ["/", "/movie/:id", "/discover/:type/:id", "/search/:q", "tv:home", "tv:browse/movie"]) assert.match(ok, vocab.SCREEN_RE);
  for (const bad of ["/movie/tt0133093", "/movie/3f9a2c1b7d4e", "/search/the matrix", "tv:Detail", "The Example Film", "", "x".repeat(50)]) assert.doesNotMatch(bad, vocab.SCREEN_RE);
});

test("docs/analytics.md names every timing, error kind, context key, input and control id", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "analytics.md"), "utf8");
  for (const name of Object.keys(vocab.TIMINGS)) assert.ok(doc.includes(`\`${name}\``), `timing ${name} is not in docs/analytics.md`);
  for (const kind of vocab.ERROR_KINDS) assert.ok(doc.includes(`\`${kind}\``), `error kind ${kind}`);
  for (const k of vocab.CTX_KEYS) assert.ok(doc.includes(`\`${k}\``), `context key ${k}`);
  for (const i of vocab.INPUTS) assert.ok(doc.includes(`\`${i}\``), `input ${i}`);
  for (const id of Object.keys(vocab.CONTROLS)) assert.ok(doc.includes(`\`${id}\``), `control ${id} is not in docs/analytics.md`);
  for (const n of ["route", "feat", "nav", "play", "error", "net", "perf", "app"]) assert.ok(doc.includes(`\`${n}\``), `event ${n}`);
  for (const word of ["Never collected", "X-Usage: off", "usageStats", "Retention", "How to add"]) assert.ok(doc.includes(word), `the section about "${word}"`);
});
