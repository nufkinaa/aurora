// One search, step by step, the same on the website and the TV app:
//   public/js/searchflow.js     the website's (an ES module, imported as is)
//   tv-native/src/searchFlow.ts its mirror — transpiled here with the TV app's
//                               own TypeScript and run through the very same
//                               assertions (skipped when tv-native/node_modules
//                               is absent)
// The local answer at once, the waiting ask for the catalogue, ONE retry when
// the catalogue could not answer, and a failure said as a failure — never as
// "No results" (2026-10-26, "La Cocina").
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const loadWeb = () => import("../public/js/searchflow.js");
let tvFile;
const loadTv = async () => {
  let ts;
  try {
    ts = require("../tv-native/node_modules/typescript");
  } catch {
    return null;
  }
  if (!tvFile) {
    const src = fs.readFileSync(path.join(__dirname, "../tv-native/src/searchFlow.ts"), "utf8");
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    tvFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aurora-searchflow-")), "searchFlow.mjs");
    fs.writeFileSync(tvFile, out);
  }
  return import(pathToFileURL(tvFile).href);
};
const both = (name, fn) => {
  test(`${name} (web)`, async () => fn(await loadWeb()));
  test(`${name} (tv)`, async (t) => {
    const m = await loadTv();
    if (!m) return t.skip("tv-native/node_modules/typescript is not installed");
    return fn(m);
  });
};

const card = (title) => ({ key: `k:${title}`, title });
const answer = (titles, extra = {}) => ({ results: titles.map(card), related: [], pending: false, catalogFailed: false, ...extra });

// A scripted server: one answer (or a thrown error) per ask, in order.
const rig = (m, script, opts = {}) => {
  const asks = [];
  const painted = [];
  const said = [];
  let alive = true;
  const steps = script.slice();
  return {
    asks, painted, said,
    kill: () => { alive = false; },
    run: () => m.runSearch({
      ask: async (o) => {
        asks.push(o);
        const next = steps.shift();
        if (typeof next === "function") return next();
        if (next instanceof Error) throw next;
        return next;
      },
      paint: (r, step) => painted.push([step, r.results.map((c) => c.title)]),
      busy: (t) => said.push(t),
      live: () => alive,
      retryAfterMs: 5,
      stillAfterMs: 10_000,
      ...opts,
    }),
  };
};

both("the same words on both", (m) => {
  assert.deepEqual(m.SEARCH_TEXT, {
    searching: "Searching…",
    catalogue: "Searching the catalogue…",
    still: "Still searching…",
    unreachable: "Couldn't reach the catalogue — try again",
    partial: "Couldn't reach the catalogue — there may be more.",
    offline: "Couldn't reach the server — check the connection and try again.",
    retry: "Try again",
  });
  assert.equal(m.noResultsText("La Cocina"), "No results for “La Cocina”");
  assert.equal(m.shortText("la"), "Nothing in the library for “la”.");
});

both("the catalogue answers: local cards, then the catalogue's, no retry", async (m) => {
  const r = rig(m, [answer([], { pending: true }), answer(["La Cocina"])]);
  const out = await r.run();
  assert.deepEqual(r.asks.map((a) => a.wait), [false, true]);
  assert.deepEqual(r.painted, [["local", []], ["catalogue", ["La Cocina"]]]);
  assert.equal(out.note, null);
  assert.equal(out.failed, false);
  assert.equal(r.said.at(-1), null, "the busy line is gone");
});

both("the catalogue was too slow: 'Still searching…', ONE retry, and it is found — never 'No results'", async (m) => {
  const r = rig(m, [answer([], { pending: true }), answer([], { catalogFailed: true }), answer(["La Cocina"])]);
  const out = await r.run();
  assert.deepEqual(r.asks.map((a) => a.wait), [false, true, true]);
  assert.ok(r.said.includes("Still searching…"));
  assert.deepEqual(r.painted.at(-1), ["catalogue", ["La Cocina"]]);
  assert.equal(out.note, null);
});

both("the catalogue stays down: one retry only, then 'Couldn't reach the catalogue', not 'No results'", async (m) => {
  const r = rig(m, [answer([], { pending: true }), answer([], { catalogFailed: true }), answer([], { catalogFailed: true }), answer(["never asked"])]);
  const out = await r.run();
  assert.equal(r.asks.length, 3, "the first ask, the waiting one, one retry");
  assert.equal(out.note, "unreachable");
  assert.equal(out.failed, true);
});

both("the waiting ask itself fails (a dropped request): retried once too", async (m) => {
  const r = rig(m, [answer(["Test Film One"], { pending: true }), new Error("network"), answer(["Test Film One", "La Cocina"])]);
  const out = await r.run();
  assert.equal(r.asks.length, 3);
  assert.equal(r.asks[2].pin, "k:Test Film One", "the first card stays first");
  assert.equal(out.note, null);
});

both("the library answered but the catalogue did not: the cards stay, and it says there may be more", async (m) => {
  const r = rig(m, [answer(["Test Film One"], { pending: true }), answer(["Test Film One"], { catalogFailed: true }), new Error("network")]);
  const out = await r.run();
  assert.equal(out.note, "partial");
  assert.deepEqual(r.painted.at(-1), ["catalogue", ["Test Film One"]], "the local cards were never taken away");
  assert.equal(r.said[1], "Searching the catalogue…", "local cards on screen: the catalogue is what is being searched");
});

both("the server itself does not answer: 'Couldn't reach the server'", async (m) => {
  const r = rig(m, [new Error("offline")]);
  const out = await r.run();
  assert.equal(out.note, "offline");
  assert.deepEqual(r.painted, []);
});

both("a real 'No results', and the few-letters hint while typing", async (m) => {
  assert.equal((await rig(m, [answer([], { pending: true }), answer([])], { q: "la cocina" }).run()).note, "none");
  assert.equal((await rig(m, [answer([])], { q: "la", committed: false }).run()).note, "short");
  assert.equal((await rig(m, [answer([])], { q: "la", committed: true }).run()).note, "none");
});

both("a search that is no longer on screen paints and says nothing more", async (m) => {
  let r;
  r = rig(m, [answer([], { pending: true }), () => { r.kill(); return answer(["late"]); }]);
  assert.equal(await r.run(), null);
  assert.deepEqual(r.painted, [["local", []]], "the late answer was not painted");
  // …and none during the retry's pause either
  r = rig(m, [answer([], { pending: true }), answer([], { catalogFailed: true }), answer(["late"])], {
    sleep: async () => { r.kill(); },
  });
  assert.equal(await r.run(), null);
  assert.equal(r.asks.length, 2, "no retry for a search that is gone");
});

both("'Searching the catalogue…' becomes 'Still searching…' when the catalogue takes long", async (m) => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const r = rig(m, [answer(["Test Film One"], { pending: true }), () => slow], { stillAfterMs: 20 });
  const done = r.run();
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(r.said.at(-1), "Still searching…");
  release(answer(["Test Film One", "La Cocina"]));
  const out = await done;
  assert.equal(out.note, null);
  assert.equal(r.said.at(-1), null);
});
