// "Sign out everywhere else": every other session and unlock token of the
// profile ends, and the profile's OTHER open sockets are told so
// (`profile_signed_out`) — not every socket of every profile, and not the
// device that asked.
// Stores are in-memory, as in auth.test.js; the sockets are stand-ins.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const express = require("express");

const sessions = require("../src/lib/sessions");
const profiles = require("../src/profiles");
const settings = require("../src/lib/settings");
sessions._internals.store.save = () => {};
sessions._internals.store.data = {};
profiles._internals.store.save = () => {};
profiles._internals.store.data = { profiles: [], state: {}, pending: [], access: {} };
settings.save = () => {};
settings.data.authMode = "transition";

const realtime = require("../src/realtime");
const profilesRouter = require("../src/routes/profiles");

// A socket as realtime keeps it: { id, profileId (from its hello), ws }.
// ws.profileId is what the server read from the session at connect time.
const fakeClient = (id, { hello = null, session = null, open = true } = {}) => {
  const got = [];
  const c = { id, profileId: hello, ws: { readyState: open ? 1 : 3, profileId: session, authed: !!session, send: (m) => got.push(JSON.parse(m)) } };
  realtime.clients.set(id, c);
  return got;
};

const boot = async () => {
  const app = express();
  app.use(express.json());
  app.use(profilesRouter);
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
  return { call, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
};

const seed = async () => {
  realtime.clients.clear();
  sessions._internals.store.data = {};
  const { salt, hash } = await profiles._internals.hashPassword("pw-ann-1");
  profiles._internals.store.data = {
    profiles: [
      { id: "p-ann", name: "Ann", avatar: "🦊", color: "#fff", username: "ann", passwordHash: hash, passwordSalt: salt },
      { id: "p-bob", name: "Bob", avatar: "🐼", color: "#fff" },
    ],
    state: {}, pending: [], access: {},
  };
};

test("only the profile's other sockets are told; the asking device keeps its session and gets a fresh token", async () => {
  await seed();
  const srv = await boot();
  try {
    const mine = sessions.create("p-ann", { ip: "phone" });
    const tv = sessions.create("p-ann", { ip: "tv" });
    const laptop = sessions.create("p-ann", { ip: "laptop" });
    const oldToken = profiles.issueToken("p-ann");

    const asker = fakeClient("c-asker", { hello: "p-ann", session: "p-ann" });
    const tvSock = fakeClient("c-tv", { session: "p-ann" });            // known by its session only
    const tabSock = fakeClient("c-tab", { hello: "p-ann" });            // known by its hello only (no sign-in: an unlock token)
    const bobSock = fakeClient("c-bob", { hello: "p-bob" });            // someone else
    const stranger = fakeClient("c-none");                              // said nothing yet
    const closed = fakeClient("c-closed", { hello: "p-ann", open: false });

    const r = await srv.call("POST", "/api/profiles/p-ann/signout-everywhere", { clientId: "c-asker" }, { "X-Session": mine });
    assert.equal(r.status, 200);
    assert.equal(r.body.ended, 2);
    assert.equal(r.body.told, 2);

    // sessions: the asker's lives, the others are gone
    assert.ok(sessions.get(mine));
    assert.equal(sessions.get(tv), null);
    assert.equal(sessions.get(laptop), null);
    // unlock tokens: the old one is dead, the answer carries a live one
    assert.equal(profiles.tokenValid("p-ann", oldToken), false);
    assert.equal(profiles.tokenValid("p-ann", r.body.token), true);

    const msg = { type: "profile_signed_out", profileId: "p-ann" };
    assert.deepEqual(tvSock, [msg]);
    assert.deepEqual(tabSock, [msg]);
    assert.deepEqual(asker, [], "the device that asked is not told it was signed out");
    assert.deepEqual(bobSock, [], "another profile's socket hears nothing");
    assert.deepEqual(stranger, []);
    assert.deepEqual(closed, []);
  } finally {
    realtime.clients.clear();
    await srv.close();
  }
});

test("with no clientId (an older client) every socket of the profile is told — the client checks before acting", async () => {
  await seed();
  const srv = await boot();
  try {
    const mine = sessions.create("p-ann", { ip: "phone" });
    const asker = fakeClient("c-asker", { hello: "p-ann", session: "p-ann" });
    const other = fakeClient("c-other", { hello: "p-ann" });
    const r = await srv.call("POST", "/api/profiles/p-ann/signout-everywhere", {}, { "X-Session": mine });
    assert.equal(r.status, 200);
    assert.equal(asker.length, 1);
    assert.equal(other.length, 1);
    // what that check finds: the asker's session still opens the profile...
    assert.equal((await srv.call("GET", "/api/profiles/p-ann/state", null, { "X-Session": mine })).status, 200);
    // ...a device with nothing valid left is refused
    assert.equal((await srv.call("GET", "/api/profiles/p-ann/state", null, { "X-Profile-Token": "stale" })).status, 401);
  } finally {
    realtime.clients.clear();
    await srv.close();
  }
});

test("it cannot be used on a profile you are not inside", async () => {
  await seed();
  const srv = await boot();
  try {
    const victim = sessions.create("p-ann", { ip: "tv" });
    const sock = fakeClient("c-tv", { session: "p-ann" });
    // no session, no token, on a profile with a password
    const r = await srv.call("POST", "/api/profiles/p-ann/signout-everywhere", { clientId: "x" });
    assert.equal(r.status, 401);
    assert.ok(sessions.get(victim), "nothing was revoked");
    assert.deepEqual(sock, [], "nobody was told anything");
  } finally {
    realtime.clients.clear();
    await srv.close();
  }
});
