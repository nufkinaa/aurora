// lib/push.js (VAPID tickle + pending queue) and media/follows.js (which
// episodes a follow fetches).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const push = require("../src/lib/push");

test("the VAPID public key is a raw uncompressed P-256 point", () => {
  const raw = Buffer.from(push.publicKey(), "base64url");
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4);
});

test("the tickle's JWT verifies against the public key and names the push origin", () => {
  const { jwtFor, store } = push._internals;
  const jwt = jwtFor("https://fcm.googleapis.com/fcm/send/abc");
  const [h, b, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { typ: "JWT", alg: "ES256" });
  const body = JSON.parse(Buffer.from(b, "base64url"));
  assert.equal(body.aud, "https://fcm.googleapis.com");
  assert.ok(body.exp > Date.now() / 1000 && body.exp <= Date.now() / 1000 + 24 * 3600);
  const { d, ...pubJwk } = store.data.vapid.jwk;
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${b}`), { key: crypto.createPublicKey({ key: pubJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  assert.equal(ok, true);
});

test("only https endpoints subscribe; pending messages are read once", () => {
  assert.ok(push.subscribe("p1", "http://evil.example/x").error);
  assert.ok(push.subscribe("", "https://push.example/x").error);
  const { okEndpoint, keyOf, store } = push._internals;
  assert.equal(okEndpoint("https://web.push.apple.com/abc"), true);
  // queue by hand (send() would try the network)
  const ep = "https://push.example/test-" + Date.now();
  const key = keyOf(ep);
  store.data.pending = store.data.pending || {};
  store.data.pending[key] = [{ title: "T", body: "B", url: "/", tag: "t", at: Date.now() }, { title: "old", body: "", url: "/", tag: "o", at: Date.now() - 9 * 24 * 3600 * 1000 }];
  const first = push.takePending(key);
  assert.equal(first.length, 1);
  assert.equal(first[0].title, "T");
  assert.equal(push.takePending(key).length, 0);
});

test("only the browsers' real push services may be subscribed (no posting to arbitrary hosts)", () => {
  const { okEndpoint, hostMatches } = push._internals;
  for (const good of [
    "https://fcm.googleapis.com/fcm/send/dQw4:APA91b",
    "https://fcm.googleapis.com/wp/dQw4",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAD",
    "https://db5p.notify.windows.com/w/?token=x",
    "https://web.push.apple.com/QGuAbc",
    "https://FCM.GoogleAPIs.com/fcm/send/x", // hostnames are case-insensitive
    "https://fcm.googleapis.com:443/fcm/send/x", // the default port, spelled out
  ]) assert.equal(okEndpoint(good, []), true, good);
  for (const bad of [
    "http://fcm.googleapis.com/fcm/send/x", // not https
    "https://evil.example/x",
    "https://localhost/x", "https://router.lan/x", "https://intranet/x",
    "https://127.0.0.1/x", "https://10.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://[::1]/x", "https://[fd00::1]/x",
    "https://2130706433/x", "https://0x7f000001/x", "https://017700000001/x", "https://127.1/x", // IPv4 in disguise
    "https://fcm.googleapis.com:8443/x", "https://fcm.googleapis.com:80/x", // any other port
    "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com@evil.example/x", // userinfo
    "https://fcm.googleapis.com.evil.example/x", "https://evilfcm.googleapis.com/x", "https://googleapis.com/x", "https://storage.googleapis.com/x",
    "https://evilpush.apple.com/x", "https://push.apple.com.evil.net/x", "https://apple.com/x",
    "https://notify.windows.com.evil.net/x", "https://xnotify.windows.com/x",
    "https://push.services.mozilla.com.evil.net/x", "https://mozilla.com/x",
    "https://fcm.googleapis.com./x", // trailing dot
    "ftp://fcm.googleapis.com/x", "//fcm.googleapis.com/x", "fcm.googleapis.com/x", "", null, undefined, 42, {},
    "https://fcm.googleapis.com/" + "a".repeat(1200), // absurdly long
  ]) assert.equal(okEndpoint(bad, []), false, String(bad));

  // the override list in config.json ("pushHosts")
  assert.equal(okEndpoint("https://push.example.com/x", []), false);
  assert.equal(okEndpoint("https://push.example.com/x", ["push.example.com"]), true);
  assert.equal(okEndpoint("https://eu.push.example.net/x", ["*.push.example.net"]), true);
  assert.equal(okEndpoint("https://push.example.net/x", ["*.push.example.net"]), false); // a suffix needs a label in front
  assert.equal(okEndpoint("https://evilpush.example.net/x", ["*.push.example.net"]), false);
  assert.equal(okEndpoint("https://sub.push.example.com/x", ["push.example.com"]), false); // exact means exact
  // an override cannot open the door to everything, to an IP, or to a port
  for (const silly of [["*"], ["*."], ["*.com"], [""], [null], ["10.0.0.1"], ["*.0.1"], "push.example.com", { 0: "evil.example" }]) {
    assert.equal(okEndpoint("https://evil.example/x", silly), false, JSON.stringify(silly));
    assert.equal(okEndpoint("https://10.0.0.1/x", silly), false, JSON.stringify(silly));
  }
  assert.equal(okEndpoint("https://push.example.com:8443/x", ["push.example.com"]), false);
  assert.equal(hostMatches("a.b.example.com", "*.example.com"), true);
  assert.equal(hostMatches("example.com", "*.example.com"), false);

  // and subscribe() itself enforces it
  assert.ok(push.subscribe("p1", "https://evil.example/x").error);
  assert.ok(push.subscribe("p1", "https://127.0.0.1/x").error);
  assert.equal(push.countFor("p1"), 0);
});

test("subscriptions that no longer pass the rule are dropped at load, with what was waiting for them", () => {
  const { pruneBadSubs, keyOf } = push._internals;
  const mk = (endpoint) => ({ key: keyOf(endpoint), endpoint, profileId: "p", ua: "", at: 1 });
  const good = [mk("https://fcm.googleapis.com/fcm/send/a"), mk("https://web.push.apple.com/b")];
  const bad = [mk("https://evil.example/hook"), mk("https://192.168.1.1/x"), mk("http://fcm.googleapis.com/c"), null, { key: "k", profileId: "p" }];
  const data = {
    vapid: { publicKey: "x" },
    subs: [good[0], ...bad, good[1]],
    pending: { [good[0].key]: [{ title: "kept" }], [bad[0].key]: [{ title: "gone" }], [bad[1].key]: [{ title: "gone" }] },
  };
  assert.equal(pruneBadSubs(data, []), 5);
  assert.deepEqual(data.subs, good);
  assert.deepEqual(Object.keys(data.pending), [good[0].key]);
  assert.equal(data.vapid.publicKey, "x");
  assert.equal(pruneBadSubs(data, []), 0); // nothing left to do
  // a host the household allowed stays; take it off the list and it goes
  const own = { subs: [mk("https://push.example.com/x")], pending: {} };
  assert.equal(pruneBadSubs(own, ["push.example.com"]), 0);
  assert.equal(pruneBadSubs(own, []), 1);
  assert.deepEqual(own.subs, []);
  assert.equal(pruneBadSubs({}, []), 0); // an empty store is fine
});

test("a follow fetches what aired after it began, within ten days, never the future", () => {
  const { freshEpisodes } = require("../src/media/follows")._internals;
  const now = Date.UTC(2026, 9, 7, 12);
  const day = 24 * 3600 * 1000;
  const iso = (t) => new Date(t).toISOString();
  const meta = { seasons: [
    { number: 0, episodes: [{ season: 0, episode: 1, released: iso(now - day) }] },
    { number: 2, episodes: [
      { season: 2, episode: 1, released: iso(now - 30 * day) }, // too old
      { season: 2, episode: 2, released: iso(now - 5 * day) },  // before the follow
      { season: 2, episode: 3, released: iso(now - 2 * day) },  // yes
      { season: 2, episode: 4, released: iso(now + 5 * day) },  // not aired
      { season: 2, episode: 5 },                                // no date
    ] },
  ] };
  const got = freshEpisodes(meta, now - 3 * day, now).map((e) => e.episode);
  assert.deepEqual(got, [3]);
});
