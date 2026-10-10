// The TV's pairing code, now that it can be typed ({host}/link): looking a
// code up is limited per address like a failed sign-in, and nothing about who
// may approve or collect changed.
// The stores are swapped for in-memory ones first, as in auth.test.js.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const express = require("express");

const sessions = require("../src/lib/sessions");
const profiles = require("../src/profiles");
sessions._internals.store.save = () => {};
sessions._internals.store.data = {};
profiles._internals.store.save = () => {};
profiles._internals.store.data = { profiles: [], state: {}, pending: [], access: {} };

const devicepair = require("../src/lib/devicepair");
const authRouter = require("../src/routes/auth");
const { fails, FAIL_MAX } = authRouter._internals;

const boot = async () => {
  const app = express();
  app.use(express.json());
  app.use(authRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
};

test("looking up a pairing code: a miss is counted, the eleventh ask is refused, a hit is never counted", async () => {
  const srv = await boot();
  try {
    fails.clear();
    devicepair._internals.pairs.clear();
    const tv = devicepair.start({ ip: "10.0.0.9", device: { device: "TV" } });

    // a real code can be asked about as often as the confirm screen repaints
    for (let i = 0; i < FAIL_MAX + 5; i++) {
      const r = await srv.call("GET", `/api/auth/device/describe/${tv.code}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.approved, false);
    }
    // lower case reads the same (people type)
    assert.equal((await srv.call("GET", `/api/auth/device/describe/${tv.code.toLowerCase()}`)).status, 200);

    for (let i = 0; i < FAIL_MAX; i++) {
      const r = await srv.call("GET", "/api/auth/device/describe/ZZZZZZ");
      assert.equal(r.status, 404, `miss ${i + 1}`);
      assert.match(r.body.error, /expired/);
    }
    const refused = await srv.call("GET", "/api/auth/device/describe/ZZZZZZ");
    assert.equal(refused.status, 429);
    assert.match(refused.body.error, /too many attempts/);
    // ...and while refused, a right code tells nothing either
    assert.equal((await srv.call("GET", `/api/auth/device/describe/${tv.code}`)).status, 429);
  } finally {
    fails.clear();
    await srv.close();
  }
});

test("a typed code still needs the phone's own session to approve, and the TV's secret to collect — once", async () => {
  const srv = await boot();
  try {
    fails.clear();
    devicepair._internals.pairs.clear();
    profiles._internals.store.data.profiles.push({ id: "p-pair", name: "Pair", avatar: "🦊", color: "#fff", username: "pair" });
    const tv = devicepair.start({ ip: "10.0.0.9" });

    // knowing the code is not enough: no session, no approval
    const anon = await srv.call("POST", "/api/auth/device/approve", { code: tv.code });
    assert.equal(anon.status, 401);
    assert.equal(devicepair.describe(tv.code).approved, false);

    const sid = sessions.create("p-pair", { ip: "test" });
    const ok = await srv.call("POST", "/api/auth/device/approve", { code: tv.code.toLowerCase() }, { "X-Session": sid });
    assert.equal(ok.status, 200);
    // approved twice is refused
    assert.equal((await srv.call("POST", "/api/auth/device/approve", { code: tv.code }, { "X-Session": sid })).status, 410);

    // the wrong secret reads as "expired" and does not burn the pairing
    assert.equal((await srv.call("POST", "/api/auth/device/poll", { code: tv.code, secret: "nope" })).status, 410);
    const got = await srv.call("POST", "/api/auth/device/poll", { code: tv.code, secret: tv.secret });
    assert.equal(got.status, 200);
    assert.equal(got.body.profile.id, "p-pair");
    assert.notEqual(got.body.session, sid, "the TV gets a session of its own, not the phone's");
    assert.equal(sessions.get(got.body.session).profileId, "p-pair");
    // single-use
    assert.equal((await srv.call("POST", "/api/auth/device/poll", { code: tv.code, secret: tv.secret })).status, 410);
    // an expired code: gone for the phone and for the TV
    const old = devicepair.start({ ip: "10.0.0.9" });
    devicepair._internals.pairs.get(old.code).expiresAt = Date.now() - 1;
    assert.equal((await srv.call("GET", `/api/auth/device/describe/${old.code}`)).status, 404);
    assert.equal((await srv.call("POST", "/api/auth/device/approve", { code: old.code }, { "X-Session": sid })).status, 410);
  } finally {
    fails.clear();
    sessions._internals.store.data = {};
    profiles._internals.store.data.profiles = [];
    await srv.close();
  }
});
