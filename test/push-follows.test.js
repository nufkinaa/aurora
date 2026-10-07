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
