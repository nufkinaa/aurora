// A browser's push subscription follows the profile that is using the
// browser: filing the same endpoint under another profile MOVES it (the
// website's push.rebind on a profile switch), and what was waiting for the
// previous owner is not read out to the next one.
// Nothing is ever sent: the store is in-memory and fetch is a recorder.
"use strict";
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
settings.data.authMode = "open";

const push = require("../src/lib/push");
const { store, keyOf } = push._internals;
store.save = () => {};

// the sender, stubbed: every "push" is a line in this list
const sent = [];
const realFetch = global.fetch;
const stubFetch = () => {
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1:")) return realFetch(url, opts); // this test's own server
    sent.push(u);
    return { ok: true, status: 201, text: async () => "" };
  };
};
const reset = () => {
  sent.length = 0;
  store.data.subs = [];
  store.data.pending = {};
};

const EP = "https://fcm.googleapis.com/fcm/send/unit-test-browser-1";
const EP2 = "https://fcm.googleapis.com/fcm/send/unit-test-browser-2";
const flush = () => new Promise((r) => setTimeout(r, 20));

test("the same endpoint filed under another profile moves there; the old profile no longer gets this browser's pushes", async () => {
  reset();
  stubFetch();
  try {
    assert.deepEqual(push.subscribe("p-a", EP, "ua"), { ok: true });
    assert.equal(push.countFor("p-a"), 1);

    // B enters on the same browser
    assert.deepEqual(push.subscribe("p-b", EP, "ua"), { ok: true });
    assert.equal(push.countFor("p-a"), 0, "the old association is gone");
    assert.equal(push.countFor("p-b"), 1);
    assert.equal(store.data.subs.length, 1, "one row per browser");

    // a download of A's lands: this browser is not tickled, nothing is queued for it
    assert.equal(push.send("p-a", { title: "Ready to watch", body: "A's film" }), 0);
    await flush();
    assert.deepEqual(sent, []);
    assert.deepEqual(push.takePending(keyOf(EP)), []);

    // B's does reach it
    assert.equal(push.send("p-b", { title: "Ready to watch", body: "B's film" }), 1);
    await flush();
    assert.deepEqual(sent, [EP]);
    assert.deepEqual(push.takePending(keyOf(EP)).map((m) => m.body), ["B's film"]);
  } finally {
    global.fetch = realFetch;
    reset();
  }
});

test("what was waiting for the previous owner is dropped on the move, and kept when the same profile files again", async () => {
  reset();
  stubFetch();
  try {
    push.subscribe("p-a", EP, "ua");
    push.send("p-a", { title: "Ready to watch", body: "A's film" });
    await flush();
    // the same profile again (every boot re-files it): the message still waits
    push.subscribe("p-a", EP, "ua");
    assert.equal((store.data.pending[keyOf(EP)] || []).length, 1);
    // another profile takes the browser over: it is not theirs to read
    push.subscribe("p-b", EP, "ua");
    assert.deepEqual(push.takePending(keyOf(EP)), []);
    // a second browser of A's is untouched by all this
    push.subscribe("p-a", EP2, "ua");
    push.subscribe("p-b", EP, "ua");
    assert.equal(push.countFor("p-a"), 1);
    assert.equal(push.countFor("p-b"), 1);
  } finally {
    global.fetch = realFetch;
    reset();
  }
});

test("the route files a subscription under the profile in the address only for someone inside that profile; on:false takes it off", async () => {
  reset();
  stubFetch();
  const { salt, hash } = await profiles._internals.hashPassword("pw-locked-1");
  profiles._internals.store.data.profiles = [
    { id: "p-open", name: "Open", avatar: "🦊", color: "#fff" },
    { id: "p-locked", name: "Locked", avatar: "🐼", color: "#fff", passwordHash: hash, passwordSalt: salt },
  ];
  const app = express();
  app.use(express.json());
  app.use(require("../src/routes/profiles"));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (id, body, headers = {}) => {
    const res = await realFetch(`${base}/api/profiles/${id}/push`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const a = await post("p-open", { endpoint: EP });
    assert.equal(a.status, 200);
    assert.equal(a.body.devices, 1);
    // a rebind sends no "test": nothing goes out
    await flush();
    assert.deepEqual(sent, []);

    // not inside the protected profile: refused, and the subscription stays where it was
    const refused = await post("p-locked", { endpoint: EP });
    assert.equal(refused.status, 401);
    assert.equal(push.countFor("p-open"), 1);
    assert.equal(push.countFor("p-locked"), 0);

    // inside it (an unlock token): the browser moves over
    const tok = profiles.issueToken("p-locked");
    const moved = await post("p-locked", { endpoint: EP }, { "X-Profile-Token": tok });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.devices, 1);
    assert.equal(push.countFor("p-open"), 0);

    // an address that is not a push service is never stored
    assert.equal((await post("p-open", { endpoint: "https://evil.example/x" })).status, 400);

    // signing out: off the server
    const off = await post("p-locked", { endpoint: EP, on: false }, { "X-Profile-Token": tok });
    assert.equal(off.status, 200);
    assert.equal(push.countFor("p-locked"), 0);
    assert.equal(store.data.subs.length, 0);
    await flush();
    assert.deepEqual(sent, [], "no push was sent by any of this");
  } finally {
    global.fetch = realFetch;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    profiles._internals.store.data.profiles = [];
    reset();
  }
});
