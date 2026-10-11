// Settings follow the person (2026-10-10). The choices a profile carries in
// `prefs` reach every device; the usage-stats opt-out is enforced by the
// server; a change tells the person's other devices to read the profile again.
//   src/profiles.js          the whitelist (autoplayNext, subsDefault joined it)
//   src/routes/usage.js      a batch from a profile that opted out is dropped
//   src/routes/profiles.js   PUT /api/profiles/:id broadcasts profile_updated
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const profiles = require("../src/profiles");
const realtime = require("../src/realtime");
const usage = require("../src/lib/usage");

profiles._internals.store.save = () => {};
const withProfiles = (list, fn) => {
  const keep = profiles._internals.store.data;
  profiles._internals.store.data = { profiles: list, state: {}, pending: [], access: {} };
  try {
    return fn();
  } finally {
    profiles._internals.store.data = keep;
  }
};

test("prefs: every on/off choice that follows the person is stored, by name, as a boolean", () => {
  withProfiles([{ id: "p1", name: "T" }], () => {
    const out = profiles.update("p1", {
      prefs: { autoplayNext: false, subsDefault: false, smartDownloads: false, smartCleanup: false, usageStats: false, subLang: "ru" },
    });
    assert.deepStrictEqual(out.prefs, {
      smartDownloads: false, smartCleanup: false, usageStats: false, autoplayNext: false, subsDefault: false, subLang: "ru",
    });
    // back on: the key stays, as an explicit choice
    assert.strictEqual(profiles.update("p1", { prefs: { autoplayNext: true } }).prefs.autoplayNext, true);
  });
});

test("prefs: what belongs to the screen, and anything not a boolean, never lands on the profile", () => {
  withProfiles([{ id: "p1", name: "T" }], () => {
    const out = profiles.update("p1", {
      prefs: { autoplayNext: "no", subsDefault: 0, cueSize: "L", cueBackground: false, heroTrailers: false, downloadNotices: false, subLang: "fr", junk: true },
    });
    assert.deepStrictEqual(out.prefs, {});
  });
});

test("prefs: a write of one key leaves the others as they were", () => {
  withProfiles([{ id: "p1", name: "T", prefs: { subLang: "he", autoplayNext: false, subPick: "en" } }], () => {
    const out = profiles.update("p1", { prefs: { subsDefault: false } });
    assert.deepStrictEqual(out.prefs, { subLang: "he", autoplayNext: false, subPick: "en", subsDefault: false });
  });
});

const usageRouter = require("../src/routes/usage");
const handlerOf = (router, path, method) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  const st = layer.route.stack;
  return st[st.length - 1].handle; // past any gate
};
const fakeRes = () => {
  const r = { code: 200, body: undefined, headers: {} };
  r.setHeader = (k, v) => ((r.headers[k] = v), r);
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  r.end = () => r;
  return r;
};

const req = (body) => ({ body, headers: {}, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" }, connection: { remoteAddress: "127.0.0.1" } });

test("usage opt-out is ENFORCED: a batch from an opted-out profile is dropped, whatever sent it", () => {
  const recorded = [];
  const keep = usage.record;
  usage.record = (b) => recorded.push(b.profile);
  try {
    withProfiles([{ id: "in", name: "A" }, { id: "out", name: "B", prefs: { usageStats: false } }], () => {
      const post = handlerOf(usageRouter, "/api/usage", "post");
      const batch = (profile) => ({ profile, sid: "abcd1234", device: "tv", look: "tv", events: [{ n: "route", t: Date.now(), p: { r: "tv:home", ms: 400 } }] });
      const a = fakeRes();
      post(req(batch("out")), a);
      const b = fakeRes();
      post(req(batch("in")), b);
      const c = fakeRes();
      post(req(null), c); // malformed: still the forgiving 204
      assert.deepStrictEqual([a.code, b.code, c.code], [204, 204, 204]);
      // the one enforcement (routes/usage.js, lib/tel verdict): a dropped batch is answered `X-Usage: off`, on which the clients stop sending
      assert.deepStrictEqual([a.headers["X-Usage"], b.headers["X-Usage"]], ["off", undefined]);
      assert.deepStrictEqual(recorded, ["in"]);
      // switched back on: counted again
      profiles.update("out", { prefs: { usageStats: true } });
      post(req(batch("out")), fakeRes());
      assert.deepStrictEqual(recorded, ["in", "out"]);
    });
  } finally {
    usage.record = keep;
  }
});

test("a prefs change tells the person's other devices to read the profile again (profile_updated, the id only)", () => {
  const profileRouter = require("../src/routes/profiles");
  const put = handlerOf(profileRouter, "/api/profiles/:id", "put");
  const sent = [];
  const keep = realtime.broadcastAll;
  realtime.broadcastAll = (m) => sent.push(m);
  try {
    withProfiles([{ id: "p1", name: "T" }], () => {
      const a = fakeRes();
      put({ params: { id: "p1" }, body: { prefs: { autoplayNext: false } } }, a);
      assert.strictEqual(a.body.prefs.autoplayNext, false);
      assert.deepStrictEqual(sent, [{ type: "profile_updated", profileId: "p1" }]);
      // a change that is not a setting (the name) says nothing
      put({ params: { id: "p1" }, body: { name: "Tee" } }, fakeRes());
      assert.strictEqual(sent.length, 1);
      // nobody there: 404 and nothing sent
      const c = fakeRes();
      put({ params: { id: "nope" }, body: { prefs: { autoplayNext: true } } }, c);
      assert.strictEqual(c.code, 404);
      assert.strictEqual(sent.length, 1);
    });
  } finally {
    realtime.broadcastAll = keep;
  }
});
