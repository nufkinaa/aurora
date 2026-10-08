// Kids profiles (2026-10-08): the rating rules (lib/kids.js), the profile's
// kids field and the household PIN (profiles.js), the PIN attempt limiter
// (routes/profiles.js) and the gate in front of the routes — driven with fake
// requests, so nothing here touches the network, the scanner or data/.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const kids = require("../src/lib/kids");
const profiles = require("../src/profiles");

profiles._internals.store.save = () => {};
profiles._internals.store.data = { profiles: [], state: {}, pending: [], access: {} };
const store = () => profiles._internals.store.data;
const seed = (id, name, extra = {}) => {
  const p = { id, name, color: "#123456", avatar: "🙂", ...extra };
  store().profiles.push(p);
  return p;
};

// ---------- the rating arithmetic ----------

test("ageOf reads the app's own labels and raw certifications", () => {
  for (const [label, age] of [
    ["ALL", 0], ["0+", 0], ["6+", 6], ["12+", 12], ["16+", 16], ["18+", 18], ["17+", 17],
    ["U", 0], ["G", 0], ["TV-Y", 0], ["TV-G", 0], ["AL", 0],
    ["PG", 8], ["TV-PG", 8], ["pg", 8],
    ["PG-13", 13], ["TV-14", 14], ["TV-Y7", 7], ["12A", 12], ["NC-17", 17], ["FSK 16", 16],
    ["R", 17], ["TV-MA", 17],
    [12, 12], [0, 0],
  ]) assert.equal(kids.ageOf(label), age, String(label));
});

test("ageOf answers null for anything that is not a rating", () => {
  for (const v of [null, undefined, "", "  ", "NR", "Unrated", "Not Rated", "N/A", "-", "banana", -3, NaN, {}])
    assert.equal(kids.ageOf(v), null, String(v));
});

test("ageOf agrees with what certification.ageLabel produces", () => {
  const { ageLabel } = require("../src/media/certification");
  for (const [raw, age] of [["12A", 12], ["PG-13", 13], ["R", 17], ["TV-MA", 17], ["U", 0], ["AL", 0], ["16", 16], ["TV-Y7", 7], ["PG", 8]])
    assert.equal(kids.ageOf(ageLabel(raw)), age, raw);
  assert.equal(kids.ageOf(ageLabel("NR")), null);
});

test("allowed: a known rating at or under the limit, and nothing else", () => {
  assert.equal(kids.allowed({ certificate: "6+" }, 7), true);
  assert.equal(kids.allowed({ certificate: "ALL" }, 0), true);
  assert.equal(kids.allowed({ certificate: "12+" }, 12), true);
  assert.equal(kids.allowed({ certificate: "12+" }, 7), false);
  assert.equal(kids.allowed({ certificate: "PG" }, 7), false, "PG reads as 8");
  assert.equal(kids.allowed({ certificate: "PG" }, 12), true);
  assert.equal(kids.allowed({ certificate: "16+" }, 16), true);
  assert.equal(kids.allowed({ certificate: "17+" }, 16), false);
  assert.equal(kids.allowed({ certificate: "18+" }, 16), false);
});

test("allowed: an UNRATED title is hidden, whatever the limit", () => {
  for (const item of [{}, { certificate: null }, { certificate: "" }, { certificate: "NR" }, { title: "No idea" }])
    assert.equal(kids.allowed(item, 16), false, JSON.stringify(item));
  assert.equal(kids.allowed(null, 16), false);
  assert.equal(kids.allowed({ certificate: "ALL" }, undefined), false, "no limit given is not a pass");
});

test("filterItems keeps the order and never returns a non-array", () => {
  const list = [
    { id: "a", certificate: "ALL" }, { id: "b", certificate: "16+" }, { id: "c" },
    { id: "d", certificate: "7+" }, { id: "e", certificate: "12+" },
  ];
  assert.deepEqual(kids.filterItems(list, 7).map((i) => i.id), ["a", "d"]);
  assert.deepEqual(kids.filterItems(list, 12).map((i) => i.id), ["a", "d", "e"]);
  assert.deepEqual(kids.filterItems(list, 16).map((i) => i.id), ["a", "b", "d", "e"]);
  assert.deepEqual(kids.filterItems(null, 16), []);
  assert.equal(list.length, 5, "the input is not mutated");
});

// ---------- where a rating comes from ----------

// A tiny library + ratings cache: a film, a show with one episode, and a
// library film nobody has rated.
const LIB = {
  m1: { id: "m1", type: "movie", title: "Cartoon", year: 2020, certificate: null },
  m2: { id: "m2", type: "movie", title: "Slasher", year: 2021, certificate: null },
  m3: { id: "m3", type: "movie", title: "Mystery Tape", year: 1999, certificate: null },
  s1: { id: "s1", type: "show", title: "Kid Show", certificate: null },
  s2: { id: "s2", type: "show", title: "Grim Show", certificate: null },
  e1: { id: "e1", showId: "s1", season: 1, episode: 1, title: "Pilot" },
  e2: { id: "e2", showId: "s2", season: 1, episode: 1, title: "Pilot" },
};
const IMDB = { Cartoon: "tt0000001", Slasher: "tt0000002", "Kid Show": "tt0000003", "Grim Show": "tt0000004" };
const CERTS = { tt0000001: "ALL", tt0000002: "18+", tt0000003: "6+", tt0000004: "16+", tt0000010: "12+", tt0000011: "18+" };
const certOf = kids.makeCertOf({
  findById: (id) => LIB[id] || null,
  imdbIdFor: (item) => IMDB[item.title] || null,
  cached: (imdbId) => CERTS[imdbId] || null,
});

test("a library item has no certificate of its own: it is found by its IMDb id in the cache", () => {
  assert.equal(certOf(LIB.m1), "ALL");
  assert.equal(certOf(LIB.m2), "18+");
  assert.equal(certOf(LIB.m3), null, "no IMDb id known -> unknown -> hidden");
  assert.equal(kids.allowed(LIB.m1, 7, certOf), true);
  assert.equal(kids.allowed(LIB.m2, 16, certOf), false);
  assert.equal(kids.allowed(LIB.m3, 16, certOf), false);
});

test("shows and films alike; an episode is rated as its show", () => {
  assert.equal(kids.allowed(LIB.s1, 7, certOf), true);
  assert.equal(kids.allowed(LIB.s2, 12, certOf), false);
  assert.equal(kids.allowed(LIB.s2, 16, certOf), true);
  assert.equal(certOf(LIB.e1), "6+");
  assert.equal(kids.allowed(LIB.e1, 7, certOf), true);
  assert.equal(kids.allowed(LIB.e2, 12, certOf), false);
});

test("catalogue cards, watchlist stream cards and stamped library items resolve by imdbId", () => {
  assert.equal(certOf({ type: "movie", title: "X", imdbId: "tt0000010" }), "12+");
  assert.equal(certOf({ id: "disc:tt0000011", type: "movie", title: "Y" }), "18+");
  assert.equal(certOf({ id: "m9", type: "movie", title: "Unknown", imdbId: "tt0000099" }), null);
  // a card that carries its own rating (discover meta) is taken at its word
  assert.equal(certOf({ type: "show", imdbId: "tt0000011", certificate: "ALL" }), "ALL");
});

test("a torrent play-item's own certificate is NOT trusted (the client stored it) — only its id", () => {
  const forged = { id: "torrent|" + "a".repeat(40) + "|0", imdbId: "tt0000002", certificate: "ALL", title: "Slasher" };
  assert.equal(certOf(forged), "18+");
  assert.equal(kids.allowed(forged, 16, certOf), false);
  assert.equal(certOf({ id: "torrent|" + "b".repeat(40) + "|0", certificate: "ALL" }), null, "no id at all -> unknown");
});

// ---------- an /api/home-shaped payload ----------

const HOME = () => ({
  hero: [
    { id: "h1", imdbId: "tt0000002", title: "Slasher", synopsis: "…" },
    { id: "m1", type: "movie", title: "Cartoon" },
  ],
  rows: [
    { id: "continue", title: "Continue Watching", items: [{ ...LIB.e2, progress: { position: 50 } }, { ...LIB.e1, progress: { position: 9 } }] },
    { id: "trending-stream", title: "Trending to Stream", items: [
      { type: "movie", title: "A", imdbId: "tt0000010", source: "stream" },
      { type: "movie", title: "B", imdbId: "tt0000011", source: "stream" },
      { type: "show", title: "C (never rated)", imdbId: "tt0000777", source: "stream" },
    ] },
    { id: "genre-Horror", title: "Horror", items: [LIB.m2, { type: "movie", title: "B", imdbId: "tt0000011" }] },
    { id: "movies", title: "All Movies", items: [LIB.m1, LIB.m2, LIB.m3] },
  ],
});

test("filterHome: hero and every row are filtered; emptied rows disappear; the rest is untouched", () => {
  const src = HOME();
  const out = kids.filterHome(src, 12, certOf);
  assert.deepEqual(out.hero.map((i) => i.id), ["m1"]);
  assert.deepEqual(out.rows.map((r) => r.id), ["continue", "trending-stream", "movies"]);
  assert.deepEqual(out.rows[0].items.map((i) => i.id), ["e1"]);
  assert.equal(out.rows[0].items[0].progress.position, 9, "items pass through whole");
  assert.deepEqual(out.rows[1].items.map((i) => i.title), ["A"]);
  assert.deepEqual(out.rows[2].items.map((i) => i.id), ["m1"]);
  assert.equal(out.rows[2].title, "All Movies");
  assert.equal(src.rows.length, 4, "the source payload is not mutated");
  assert.equal(src.rows[3].items.length, 3);
});

test("filterHome at the strictest limit, and on junk", () => {
  const out = kids.filterHome(HOME(), 0, certOf);
  assert.deepEqual(out.hero.map((i) => i.id), ["m1"]);
  assert.deepEqual(out.rows.map((r) => [r.id, r.items.length]), [["movies", 1]]);
  assert.deepEqual(kids.filterHome({}, 7, certOf), { hero: [], rows: [] });
  assert.equal(kids.filterHome(null, 7, certOf), null);
});

// ---------- the profile field ----------

test("cleanKids accepts exactly { maxAge: one of AGES } or an off value", () => {
  assert.deepEqual(kids.AGES, [0, 7, 12, 16]);
  for (const a of kids.AGES) assert.deepEqual(kids.cleanKids({ maxAge: a }), { maxAge: a });
  assert.deepEqual(kids.cleanKids({ maxAge: 12, admin: true, pin: "1" }), { maxAge: 12 }, "extra keys are dropped");
  assert.equal(kids.cleanKids(null), null);
  assert.equal(kids.cleanKids(false), null);
  assert.equal(kids.cleanKids({ maxAge: null }), null);
  for (const bad of [undefined, true, 12, "12", [], [12], {}, { maxAge: "12" }, { maxAge: 13 }, { maxAge: 18 }, { maxAge: -1 }, { maxAge: 7.5 }, { maxAge: NaN }, { max: 12 }])
    assert.equal(kids.cleanKids(bad), undefined, JSON.stringify(bad));
});

test("setKids stores only the clean shape, shows it in the public view, and can switch it off", () => {
  seed("kid", "Noa");
  assert.equal(profiles.pub(store().profiles.find((p) => p.id === "kid")).kids, null);
  assert.equal(profiles.kidsOf("kid"), null);

  const on = profiles.setKids("kid", { maxAge: 7, sneaky: "x" });
  assert.equal(on.ok, true);
  assert.deepEqual(on.profile.kids, { maxAge: 7 });
  assert.deepEqual(store().profiles.find((p) => p.id === "kid").kids, { maxAge: 7 });
  assert.deepEqual(profiles.kidsOf("kid"), { maxAge: 7 });
  assert.deepEqual(profiles.publicList().find((p) => p.id === "kid").kids, { maxAge: 7 });

  for (const bad of [{ maxAge: 13 }, { maxAge: "7" }, "yes", 7, {}, undefined]) {
    assert.ok(profiles.setKids("kid", bad).error, JSON.stringify(bad));
    assert.deepEqual(profiles.kidsOf("kid"), { maxAge: 7 }, "a refused value changes nothing");
  }
  assert.equal(profiles.setKids("nobody", { maxAge: 7 }).error, "not found");

  const off = profiles.setKids("kid", null);
  assert.equal(off.profile.kids, null);
  assert.equal("kids" in store().profiles.find((p) => p.id === "kid"), false);
});

test("the ordinary profile update can NOT touch kids mode (it needs the PIN route)", () => {
  seed("kid2", "Omer", { kids: { maxAge: 7 } });
  const p = profiles.update("kid2", { name: "Omer B", kids: null });
  assert.equal(p.name, "Omer B");
  assert.deepEqual(p.kids, { maxAge: 7 }, "still a kids profile");
  profiles.update("kid2", { kids: { maxAge: 16 }, prefs: { kids: false, smartDownloads: false } });
  assert.deepEqual(profiles.kidsOf("kid2"), { maxAge: 7 });

  seed("grown", "Dana");
  assert.equal(profiles.update("grown", { kids: { maxAge: 0 } }).kids, null, "nor switch it on");
});

// ---------- the household PIN ----------

test("the PIN: shape, hashed storage, verify", async () => {
  assert.equal(profiles.kidsPinSet(), false);
  assert.equal(await profiles.verifyKidsPin("1234"), false, "no PIN set: nothing verifies");

  for (const bad of ["123", "1234567", "12a4", "", " 1234", 1234, null, undefined, "١٢٣٤"]) {
    assert.ok((await profiles.setKidsPin(bad)).error, String(bad));
    assert.equal(kids.validPin(bad), false, String(bad));
  }
  assert.equal(profiles.kidsPinSet(), false);

  assert.equal((await profiles.setKidsPin("0042")).ok, true);
  assert.equal(profiles.kidsPinSet(), true);
  const saved = store().kidsPin;
  assert.ok(saved.hash && saved.salt && saved.setAt);
  assert.equal(JSON.stringify(store()).includes("0042"), false, "never stored in clear");
  assert.equal(saved.hash.length, 128, "scrypt, like the passwords");

  assert.equal(await profiles.verifyKidsPin("0042"), true);
  assert.equal(await profiles.verifyKidsPin("0043"), false);
  assert.equal(await profiles.verifyKidsPin("42"), false);
  assert.equal(await profiles.verifyKidsPin(42), false);
  assert.equal(await profiles.verifyKidsPin(""), false);

  // changing it: the old one stops working
  assert.equal((await profiles.setKidsPin("987654")).ok, true);
  assert.equal(await profiles.verifyKidsPin("0042"), false);
  assert.equal(await profiles.verifyKidsPin("987654"), true);

  profiles.clearKidsPin();
  assert.equal(profiles.kidsPinSet(), false);
  assert.equal(await profiles.verifyKidsPin("987654"), false);
});

test("PIN attempts are rate-limited per address, like unlock attempts", async () => {
  const { pinAttempt } = require("../src/routes/profiles")._internals;
  await profiles.setKidsPin("2468");

  assert.deepEqual(await pinAttempt("10.0.0.50", "2468"), { ok: true });
  let wrong = 0;
  let limited = null;
  for (let i = 0; i < 40 && !limited; i++) {
    const r = await pinAttempt("10.0.0.51", "1111");
    if (r.status === 429) limited = r;
    else {
      assert.equal(r.status, 401);
      assert.equal(r.wrongPin, true);
      wrong++;
    }
  }
  assert.ok(limited, "the limiter kicks in");
  assert.ok(wrong >= 3 && wrong <= 20, `after a handful of wrong guesses (${wrong})`);
  // …and once it has, even the RIGHT pin from that address waits
  assert.equal((await pinAttempt("10.0.0.51", "2468")).status, 429);
  // another device is not locked out by the first one's guessing
  assert.deepEqual(await pinAttempt("10.0.0.52", "2468"), { ok: true });
  profiles.clearKidsPin();
});

// ---------- who is asking ----------

const reqOf = ({ path = "/api/home", method = "GET", query = {}, body = undefined, headers = {} } = {}) =>
  ({ path, method, query, body, headers });
const KIDS = { kid7: { maxAge: 7 }, kid12: { maxAge: 12 } };
const deps = (over = {}) => ({
  closed: () => false,
  session: () => null,
  tokenProfile: (t) => ({ "tok-kid": "kid7", "tok-adult": "adult" })[t] || null,
  kidsOf: (id) => KIDS[id] || null,
  ...over,
});
const cookie = (id, at = 1000) => ({ cookie: `theme=x; ${kids.lockCookie(id, { at }).split(";")[0]}` });

test("a request that names no profile is not a kids request (every old caller)", () => {
  assert.equal(kids.resolveKids(reqOf(), deps()), null);
  assert.equal(kids.resolveKids(reqOf({ query: { profile: "adult" } }), deps()), null);
  assert.equal(kids.resolveKids(reqOf({ headers: { "x-profile-token": "tok-adult" } }), deps()), null);
  assert.equal(kids.resolveKids(reqOf({ query: { profile: "ghost" } }), deps()), null);
});

test("a kids profile is recognised by query, body, token, path and session", () => {
  const want = { profile: "kid7", maxAge: 7, source: "request" };
  assert.deepEqual(kids.resolveKids(reqOf({ query: { profile: "kid7" } }), deps()), want);
  assert.deepEqual(kids.resolveKids(reqOf({ method: "POST", path: "/api/downloads", body: { profile: "kid7" } }), deps()), want);
  assert.deepEqual(kids.resolveKids(reqOf({ path: "/api/library", headers: { "x-profile-token": "tok-kid" } }), deps()), want);
  assert.deepEqual(kids.resolveKids(reqOf({ path: "/api/profiles/kid7/watchlist" }), deps()), want);
  assert.deepEqual(
    kids.resolveKids(reqOf({ path: "/api/library" }), deps({ session: () => ({ profileId: "kid7", createdAt: 5 }) })), want);
  // two named at once: the stricter limit
  assert.equal(kids.resolveKids(reqOf({ query: { profile: "kid12" }, headers: { "x-profile-token": "tok-kid" } }), deps()).maxAge, 7);
});

test("the device lock cookie makes EVERY request from that browser a kids one", () => {
  const r = kids.resolveKids(reqOf({ path: "/stream/video/m2", headers: cookie("kid12") }), deps());
  assert.deepEqual(r, { profile: "kid12", maxAge: 12, source: "lock" });
  // it wins over a profile named in the request (the child typing ?profile=adult)
  assert.equal(kids.resolveKids(reqOf({ query: { profile: "adult" }, headers: cookie("kid7") }), deps()).profile, "kid7");
  // a lock on a profile that is no longer a kids one (or is gone) means nothing
  assert.equal(kids.resolveKids(reqOf({ headers: cookie("adult") }), deps()), null);
  assert.equal(kids.resolveKids(reqOf({ headers: cookie("deleted") }), deps()), null);
  // junk cookies read as no lock
  for (const c of ["aurora_kid=", "aurora_kid=%zz", "aurora_kid=kid7", "aurora_kid=../x.1", "aurora_kid=kid7.abc"])
    assert.equal(kids.readLock({ headers: { cookie: c } }), null, c);
  assert.deepEqual(kids.readLock({ headers: cookie("kid7", 42) }), { profile: "kid7", at: 42 });
  assert.match(kids.lockCookie("kid7"), /HttpOnly/);
  assert.match(kids.clearCookie(), /Max-Age=0/);
});

test("a grown-up signing in AFTER the lock was set voids it; an older session does not", () => {
  const later = deps({ session: () => ({ profileId: "adult", createdAt: 2000 }) });
  const earlier = deps({ session: () => ({ profileId: "adult", createdAt: 500 }) });
  assert.equal(kids.resolveKids(reqOf({ headers: cookie("kid7", 1000) }), later), null);
  assert.equal(kids.resolveKids(reqOf({ headers: cookie("kid7", 1000) }), earlier).profile, "kid7",
    "the parent's long-lived session on the family browser must not switch kids mode off");
  // a kids profile's own later session doesn't void anything
  const kidSess = deps({ session: () => ({ profileId: "kid12", createdAt: 2000 }) });
  assert.equal(kids.resolveKids(reqOf({ headers: cookie("kid7", 1000) }), kidSess).profile, "kid7");
});

test("the PIN takes a browser out of the kids profile it is SIGNED IN as, until that profile is entered again", () => {
  const kidSess = deps({ session: () => ({ profileId: "kid7", createdAt: 1000 }) });
  const left = (id, at) => ({ cookie: kids.releaseCookie(id, { at }).split(";")[0] });
  // signed in as the kids profile, the grown-up's profile entered with its own token: still the child's, before the PIN
  assert.equal(kids.resolveKids(reqOf({ path: "/api/library", headers: { "x-profile-token": "tok-adult" } }), kidSess).profile, "kid7");
  // after the PIN: the grown-up's requests are the grown-up's, and a bare <video> request is nobody's
  assert.equal(kids.resolveKids(reqOf({ path: "/api/library", headers: { "x-profile-token": "tok-adult", ...left("kid7", 2000) } }), kidSess), null);
  assert.equal(kids.resolveKids(reqOf({ path: "/stream/video/m2", headers: left("kid7", 2000) }), kidSess), null);
  // ...but anything that still names the kids profile itself is still a kids request
  assert.equal(kids.resolveKids(reqOf({ headers: { "x-profile-token": "tok-kid", ...left("kid7", 2000) } }), kidSess).profile, "kid7");
  // a mark about ANOTHER profile, or one older than the sign-in (signed in again since), frees nothing
  assert.equal(kids.resolveKids(reqOf({ headers: left("kid12", 2000) }), kidSess).profile, "kid7");
  assert.equal(kids.resolveKids(reqOf({ headers: left("kid7", 500) }), kidSess).profile, "kid7");
  // the device lock is not touched by it
  assert.equal(
    kids.resolveKids(reqOf({ headers: { cookie: `${kids.lockCookie("kid7", { at: 3000 }).split(";")[0]}; ${kids.releaseCookie("kid7", { at: 2000 }).split(";")[0]}` } }), kidSess).source,
    "lock");
  // sign-in closed: the session is the person, whatever the mark says
  const closedKid = deps({ closed: () => true, session: () => ({ profileId: "kid7", createdAt: 1000 }) });
  assert.equal(kids.resolveKids(reqOf({ headers: left("kid7", 2000) }), closedKid).profile, "kid7");
  assert.deepEqual(kids.readRelease({ headers: left("kid7", 42) }), { profile: "kid7", at: 42 });
  assert.match(kids.releaseCookie("kid7"), /HttpOnly/);
  assert.match(kids.clearRelease(), /Max-Age=0/);
});

test("sign-in closed: only the session counts", () => {
  const closedKid = deps({ closed: () => true, session: () => ({ profileId: "kid7", createdAt: 1 }) });
  const closedAdult = deps({ closed: () => true, session: () => ({ profileId: "adult", createdAt: 1 }) });
  assert.deepEqual(kids.resolveKids(reqOf(), closedKid), { profile: "kid7", maxAge: 7, source: "session" });
  assert.equal(kids.resolveKids(reqOf({ headers: cookie("kid7"), query: { profile: "kid7" } }), closedAdult), null);
  assert.equal(kids.resolveKids(reqOf({ query: { profile: "kid7" } }), deps({ closed: () => true })), null);
});

// ---------- the gate, driven with fake requests ----------

const HASH_OK = "a".repeat(40);
const HASH_BAD = "b".repeat(40);
const HASH_NEW = "c".repeat(40);
const makeGate = (kid, extra = {}) => {
  const unknown = [];
  const hashes = new Map();
  const gate = kids.createGate({
    kidsFor: () => kid,
    certOf,
    findById: (id) => LIB[id] || null,
    streamItem: (profileId, id) =>
      ({ [`torrent|${HASH_OK}|0`]: { imdbId: "tt0000001", title: "Cartoon" }, [`torrent|${HASH_BAD}|0`]: { imdbId: "tt0000002", certificate: "ALL" } })[id] || null,
    certByTitle: (type, title) => ({ "movie|Cartoon": "ALL", "movie|Slasher": "18+", "series|Kid Show": "6+" })[`${type}|${title}`] || null,
    hashes,
    onUnknown: (item) => unknown.push(item),
    ...extra,
  });
  // run one request through the gate, then through `handler` (the real route)
  const run = (r, handler = (req, res) => res.json({ reached: true })) => {
    const res = {
      statusCode: 200, body: undefined, sent: 0,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; this.sent++; return this; },
    };
    const req = reqOf(r);
    let passed = false;
    gate(req, res, () => { passed = true; handler(req, res); });
    return { status: res.statusCode, body: res.body, passed, sent: res.sent, req };
  };
  return { run, unknown, hashes };
};
const KID = { profile: "kid", maxAge: 12, source: "lock" };

test("gate: a request that is not a kids one passes untouched", () => {
  const { run } = makeGate(null);
  const home = HOME();
  const r = run({ path: "/api/home" }, (req, res) => res.json(home));
  assert.equal(r.passed, true);
  assert.equal(r.body, home, "the very same object — no copy, no filter");
  assert.equal(run({ path: "/stream/video/m2" }).passed, true);
  assert.equal(run({ path: "/api/item/m2" }).passed, true);
  assert.equal(r.req.kids, undefined);
});

test("gate: the admin panel, sign-in, kids routes and static files are never gated", () => {
  const { run } = makeGate(KID, { kidsFor: () => { throw new Error("must not even be asked"); } });
  for (const path of ["/api/admin/people", "/api/admin/library", "/api/auth/login", "/api/kids/exit", "/api/kids/status", "/js/main.js", "/", "/img/m2"])
    assert.equal(run({ path }).passed, true, path);
});

test("gate: /api/home is filtered on the way out", () => {
  const { run, unknown } = makeGate(KID);
  const r = run({ path: "/api/home" }, (req, res) => res.json(HOME()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.hero.map((i) => i.id), ["m1"]);
  assert.deepEqual(r.body.rows.map((x) => x.id), ["continue", "trending-stream", "movies"]);
  assert.deepEqual(r.body.rows[1].items.map((i) => i.title), ["A"]);
  assert.ok(unknown.some((i) => i.imdbId === "tt0000777"), "the unrated title was handed to the background lookup");
  assert.ok(!unknown.some((i) => i.imdbId === "tt0000011"), "a title that is simply too old is not looked up again");
  assert.deepEqual(r.req.kids, KID);
});

test("gate: library, search, catalogue, discover, similar, popular, watchlist lists are filtered", () => {
  const { run } = makeGate(KID);
  const cards = [{ title: "A", imdbId: "tt0000010" }, { title: "B", imdbId: "tt0000011" }, { title: "?", imdbId: "tt0000999" }];
  const lib = run({ path: "/api/library" }, (q, res) => res.json({ movies: [LIB.m1, LIB.m2, LIB.m3], shows: [LIB.s1, LIB.s2], scannedAt: 7 }));
  assert.deepEqual(lib.body.movies.map((i) => i.id), ["m1"]);
  assert.deepEqual(lib.body.shows.map((i) => i.id), ["s1"]);
  assert.equal(lib.body.scannedAt, 7);

  const search = run({ path: "/api/search", query: { q: "x" } }, (q, res) => res.json({ results: [LIB.m2, LIB.s1], catalog: cards }));
  assert.deepEqual(search.body.results.map((i) => i.id), ["s1"]);
  assert.deepEqual(search.body.catalog.map((i) => i.title), ["A"]);

  const sug = run({ path: "/api/search/suggest" }, (q, res) => res.json({ suggestions: [...cards, LIB.m1] }));
  assert.deepEqual(sug.body.suggestions.map((i) => i.title), ["A", "Cartoon"]);

  for (const path of ["/api/catalog", "/api/popular", "/api/discover/similar/movie/tt0000001", "/api/profiles/kid/watchlist"]) {
    const r = run({ path }, (q, res) => res.json({ items: cards, hasMore: true }));
    assert.deepEqual(r.body.items.map((i) => i.title), ["A"], path);
    assert.equal(r.body.hasMore, true);
  }
  for (const path of ["/api/discover", "/api/discover/search"]) {
    const r = run({ path }, (q, res) => res.json({ movies: cards, shows: [{ title: "S", imdbId: "tt0000004" }] }));
    assert.deepEqual(r.body.movies.map((i) => i.title), ["A"], path);
    assert.deepEqual(r.body.shows, [], path);
  }
  const coll = run({ path: "/api/discover/collection/movie/tt0000001" }, (q, res) =>
    res.json({ collection: { name: "Saga", items: cards }, director: { name: "D", items: [cards[1]] }, creator: null }));
  assert.deepEqual(coll.body.collection.items.map((i) => i.title), ["A"]);
  assert.equal(coll.body.collection.name, "Saga");
  assert.equal(coll.body.director, null, "a shelf left empty is dropped");
  assert.equal(coll.body.creator, null);

  const owned = run({ path: "/api/library/for" }, (q, res) => res.json({ item: LIB.m2 }));
  assert.equal(owned.body.item, null);
  assert.equal(run({ path: "/api/library/for" }, (q, res) => res.json({ item: LIB.m1 })).body.item.id, "m1");

  // genres and other non-title answers are left alone
  assert.deepEqual(run({ path: "/api/catalog/genres" }, (q, res) => res.json({ genres: ["Horror"] })).body, { genres: ["Horror"] });
});

test("gate: an error answer from the route is passed through, not 'filtered'", () => {
  const { run } = makeGate(KID);
  const r = run({ path: "/api/catalog" }, (q, res) => res.status(502).json({ error: "upstream" }));
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: "upstream" });
});

test("gate: direct access to a title over the limit is 403 with a clear error", () => {
  const { run } = makeGate(KID);
  const refused = (r, label) => {
    assert.equal(r.status, 403, label);
    assert.equal(r.passed, false, label);
    assert.match(r.body.error, /kids profile/, label);
    assert.equal(r.body.kids, true, label);
  };
  refused(run({ path: "/api/item/m2" }), "item: 18+ film");
  refused(run({ path: "/api/item/m3" }), "item: unrated film");
  refused(run({ path: "/api/item/e2" }), "item: episode of a 16+ show");
  refused(run({ path: "/stream/video/m2" }), "play");
  refused(run({ path: "/stream/hls/e2/index.m3u8" }), "hls of an episode");
  refused(run({ path: "/stream/transcode/m2/jit/index.m3u8" }), "transcode");
  refused(run({ path: "/stream/download/m2" }), "download the file");
  refused(run({ path: "/offline/file/m2" }), "offline copy");
  refused(run({ path: "/img/frame/m2" }), "a frame cut from the film");
  refused(run({ path: "/img/still/e2" }), "an episode still");
  refused(run({ path: "/api/offline/prepare/m2", method: "POST" }), "offline prepare");
  refused(run({ path: "/api/torrents/subtitles/movie/tt0000002" }), "subtitles for it");
  refused(run({ path: "/api/ai/recommend", method: "POST" }), "the recommender");
  refused(run({ path: "/stream/embedded/m2/0" }), "a subtitle track inside the file");
  refused(run({ path: "/api/xray", query: { type: "movie", imdbId: "tt0000002" } }), "x-ray by IMDb id");
  refused(run({ path: "/api/xray", query: { itemId: "m2" } }), "x-ray by library id");
  refused(run({ path: "/api/xray", query: {} }), "x-ray that names nothing");
  assert.equal(run({ path: "/api/xray", query: { type: "movie", imdbId: "tt0000001" } }).passed, true, "x-ray of an allowed title");
  assert.equal(run({ path: "/api/xray", query: { itemId: "m1" } }).passed, true, "x-ray of an allowed library item");
  assert.equal(run({ path: "/stream/embedded/m1/0" }).passed, true, "embedded subtitles of an allowed film");

  for (const path of ["/api/item/m1", "/api/item/e1", "/api/item/s1", "/stream/video/m1", "/stream/hls/e1/seg1.ts", "/offline/file/m1", "/img/still/m1", "/api/torrents/subtitles/movie/tt0000001"])
    assert.equal(run({ path }).passed, true, path);
  // an id the library doesn't know is the route's own 404, not ours
  assert.equal(run({ path: "/api/item/nope" }).passed, true);
  assert.deepEqual(run({ path: "/api/ai/status" }).body, { enabled: false });
});

test("gate: the household's download list only names titles the kids profile may see", () => {
  const { run } = makeGate(KID);
  const jobs = [
    { id: "a", title: "Cartoon", imdbId: "tt0000001", certificate: "ALL" },
    { id: "b", title: "Slasher", imdbId: "tt0000002", certificate: "ALL" }, // what the job says proves nothing
    { id: "c", title: "No id" },
  ];
  const r = run({ path: "/api/downloads" }, (req, res) => res.json(jobs));
  assert.deepEqual(r.body.map((j) => j.id), ["a"]);
  assert.equal(jobs.length, 3, "the store's own list is not touched");
});

test("gate: discover meta is judged by the rating that arrives with it", () => {
  const { run } = makeGate(KID);
  const ok = run({ path: "/api/discover/meta/movie/tt0000050" }, (q, res) => res.json({ imdbId: "tt0000050", title: "Fresh", certificate: "6+" }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.title, "Fresh");
  for (const certificate of ["18+", null]) {
    const no = run({ path: "/api/discover/meta/movie/tt0000051" }, (q, res) => res.json({ imdbId: "tt0000051", title: "Nope", certificate, synopsis: "secret" }));
    assert.equal(no.status, 403, String(certificate));
    assert.equal(no.body.synopsis, undefined, "nothing of the title leaks with the refusal");
    assert.match(no.body.error, /kids profile/);
  }
});

test("gate: stream sources are refused by title, and a torrent only opens once an allowed title listed it", () => {
  const { run } = makeGate(KID);
  assert.equal(run({ path: `/stream/torrent/${HASH_NEW}/0` }).status, 403, "an unknown torrent");
  assert.equal(run({ path: `/api/torrents/status/${HASH_NEW}` }).status, 403);

  assert.equal(run({ path: "/api/torrents/sources", query: { type: "movie", title: "Slasher", year: "2021" } }).status, 403);
  assert.equal(run({ path: "/api/torrents/sources", query: { type: "movie", title: "Never Heard Of It" } }).status, 403, "unknown title");

  const src = run({ path: "/api/torrents/sources", query: { type: "movie", title: "Cartoon" } },
    (q, res) => res.json({ streams: [{ infoHash: HASH_NEW.toUpperCase(), recommended: true }] }));
  assert.equal(src.status, 200);
  assert.equal(src.body.streams.length, 1);
  for (const path of [`/stream/torrent/${HASH_NEW}/0`, `/stream/torrent/hls/${HASH_NEW}/0/jit/index.m3u8`, `/stream/torrent/sub/${HASH_NEW}/2`, `/api/torrents/probe/${HASH_NEW}/0`])
    assert.equal(run({ path }).passed, true, path);

  // a refreshed player rebuilding a stream: by the profile's stored play-item
  assert.equal(run({ path: `/api/item/${encodeURIComponent(`torrent|${HASH_OK}|0`)}` }).passed, true);
  assert.equal(run({ path: `/stream/torrent/${HASH_OK}/0` }).passed, true, "…which opens its stream");
  assert.equal(run({ path: `/api/item/torrent|${HASH_BAD}|0` }).status, 403, "stored item of an 18+ film (its forged certificate ignored)");
  assert.equal(run({ path: `/stream/torrent/${HASH_BAD}/0` }).status, 403);
  assert.equal(run({ path: `/api/item/torrent|${"d".repeat(40)}|0` }).status, 403, "nothing stored: unknown");
});

test("gate: a torrent opened for an older kids profile stays shut for a younger one", () => {
  const hashes = new Map();
  const older = makeGate({ profile: "big", maxAge: 16, source: "lock" }, { hashes });
  const younger = makeGate({ profile: "small", maxAge: 7, source: "lock" }, { hashes });
  older.run({ path: "/api/torrents/sources", query: { type: "series", title: "Kid Show" } }, (q, res) => res.json({ streams: [{ infoHash: HASH_OK }] }));
  older.run({ path: "/api/home" }, (q, res) => res.json({ hero: [], rows: [{ id: "continue", items: [{ id: `torrent|${HASH_NEW}|0`, imdbId: "tt0000004" }] }] }));
  assert.equal(older.run({ path: `/stream/torrent/${HASH_NEW}/0` }).passed, true, "a 16+ Continue Watching card opens its stream");
  assert.equal(younger.run({ path: `/stream/torrent/${HASH_NEW}/0` }).status, 403);
  assert.equal(younger.run({ path: `/stream/torrent/${HASH_OK}/0` }).passed, true, "the 6+ one is fine for both");
});

test("gate: download requests are judged by IMDb id", () => {
  const { run } = makeGate(KID);
  assert.equal(run({ path: "/api/downloads", method: "POST", body: { imdbId: "tt0000002", title: "Slasher", certificate: "ALL" } }).status, 403);
  assert.equal(run({ path: "/api/downloads", method: "POST", body: { title: "No id" } }).status, 403);
  assert.equal(run({ path: "/api/downloads", method: "POST", body: { imdbId: "tt0000001", title: "Cartoon" } }).passed, true);
  assert.equal(run({ path: "/api/downloads" }).passed, true, "reading the queue is not a request");
});

test("gate: a locked device can't reach another profile, nor undo the kids profile's own guard rails", () => {
  const { run } = makeGate(KID);
  for (const [method, path] of [["GET", "/api/profiles/adult/state"], ["POST", "/api/profiles/adult/unlock"], ["GET", "/api/profiles/adult/watchlist"], ["PUT", "/api/profiles/adult"]]) {
    const r = run({ method, path });
    assert.equal(r.status, 403, path);
    assert.equal(r.body.kidsLocked, true, path);
  }
  for (const [method, path] of [["POST", "/api/profiles/kid/password"], ["POST", "/api/profiles/kid/email"], ["DELETE", "/api/profiles/kid"]])
    assert.equal(run({ method, path }).status, 403, `${method} ${path}`);
  for (const [method, path] of [["GET", "/api/profiles"], ["GET", "/api/profiles/kid/state"], ["POST", "/api/profiles/kid/progress"], ["PUT", "/api/profiles/kid"], ["POST", "/api/profiles/kid/kids"], ["POST", "/api/profiles/kid/unlock"], ["DELETE", "/api/profiles/kid/progress/m1"]])
    assert.equal(run({ method, path }).passed, true, `${method} ${path}`);

  // recognised only by what the request names (the TV): other profiles' routes are not this gate's business
  const tv = makeGate({ profile: "kid", maxAge: 12, source: "request" });
  assert.equal(tv.run({ path: "/api/profiles/adult/state" }).passed, true);
});

test("gate: a filter that throws fails closed", () => {
  const { run } = makeGate(KID, { certOf: () => { throw new Error("boom"); } });
  const r = run({ path: "/api/home" }, (q, res) => res.json(HOME()));
  assert.equal(r.status, 500);
  assert.equal(r.body.hero, undefined);
});

// ---------- the real wiring ----------

test("routes/api: kidsFor reads the live profile store; no kids profile means no work", () => {
  const { kidsFor } = require("../src/routes/api")._internals;
  store().profiles = [];
  seed("a1", "Adult");
  assert.equal(kidsFor(reqOf({ query: { profile: "a1" }, headers: {} })), null);
  seed("k1", "Kid", { kids: { maxAge: 12 } });
  assert.equal(kidsFor(reqOf({ query: { profile: "a1" }, headers: {} })), null);
  assert.equal(kidsFor(reqOf({ headers: {} })), null, "no profile named: unfiltered, as before");
  assert.deepEqual(kidsFor(reqOf({ query: { profile: "k1" }, headers: {} })), { profile: "k1", maxAge: 12, source: "request" });
  const tok = profiles.issueToken("k1");
  assert.equal(kidsFor(reqOf({ path: "/api/library", headers: { "x-profile-token": tok } })).profile, "k1");
  assert.equal(profiles.tokenProfile(tok), "k1");
  assert.equal(profiles.tokenProfile("nope"), null);
  assert.equal(kidsFor(reqOf({ path: "/stream/video/x", headers: cookie("k1") })).source, "lock");
});

test("discover: a rating outlives the meta cache and answers by id and by title", () => {
  const discover = require("../src/media/discover");
  const { certStore, noteCertificate } = discover._internals;
  const before = certStore.data;
  certStore.data = {};
  certStore.save = () => {};
  try {
    noteCertificate({ imdbId: "tt7000001", type: "movie", title: "Paper Boats", year: 2019, certificate: "6+" });
    noteCertificate({ imdbId: "tt7000002", type: "show", title: "Paper Boats", year: 2019, certificate: "16+" });
    noteCertificate({ imdbId: "tt7000003", type: "movie", title: "The Unrated", year: 2001, certificate: null });
    noteCertificate({ imdbId: "not-an-id", type: "movie", title: "Junk", certificate: "ALL" });
    assert.equal(discover.certificateCached("tt7000001"), "6+");
    assert.equal(discover.certificateCached("tt7000003"), null);
    assert.equal(discover.certificateCached("tt7999999"), null);
    assert.equal(Object.keys(certStore.data).length, 3);

    assert.equal(discover.certificateByTitle("movie", "paper boats!", 2019), "6+", "normalized title");
    assert.equal(discover.certificateByTitle("movie", "Paper Boats", 2020), "6+", "a year apart is the same film");
    assert.equal(discover.certificateByTitle("movie", "Paper Boats", 1985), null, "a different film of that name");
    assert.equal(discover.certificateByTitle("series", "Paper Boats", null), "16+", "the show, not the film");
    assert.equal(discover.certificateByTitle("movie", "The Unrated", 2001), null);
    assert.equal(discover.certificateByTitle("movie", "", null), null);

    // two films that tie on title: the OLDER rating answers
    noteCertificate({ imdbId: "tt7000004", type: "movie", title: "Paper Boats", year: 2019, certificate: "18+" });
    assert.equal(discover.certificateByTitle("movie", "Paper Boats", 2019), "18+");
    // a later failed lookup never erases a rating we had
    noteCertificate({ imdbId: "tt7000001", type: "movie", title: "Paper Boats", year: 2019, certificate: null });
    assert.equal(discover.certificateCached("tt7000001"), "6+");
  } finally {
    certStore.data = before;
    delete certStore.save;
  }
});
