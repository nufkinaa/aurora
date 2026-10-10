// A forced password reset (admin → People → "Reset password") REALLY forces
// it (2026-10-10): the profile is signed out everywhere at once, and until a
// new password is saved its sessions and unlock tokens are RESTRICTED
// credentials — they open the routes that save a password and nothing else
// (src/lib/resetgate.js). Covered here: the gate on a representative set of
// routes (api, stream, img, avatars, proxy, the WebSocket upgrade), the
// revocation and the socket message on force, the change itself, the three
// sign-in modes, Google-only / PIN / kids profiles, and what a client that
// predates the rule is told.
// Stores are in-memory, as in auth.test.js. The sign-in mode lives in the
// stubbed settings and is put back to "transition" after every test.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const express = require("express");

const config = require("../src/config");
config.ADMIN_PASSWORD = "test-admin-password";
const ADMIN = { "X-Admin-Password": config.ADMIN_PASSWORD };

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
const resetgate = require("../src/lib/resetgate");
const authz = require("../src/lib/authz");
const authRouter = require("../src/routes/auth");
const profilesRouter = require("../src/routes/profiles");
const adminRouter = require("../src/routes/admin");
const { fails, googleOutcomeFor } = authRouter._internals;

const addProfile = async (id, { username = null, password = null, googleSub = null, kids = null } = {}) => {
  const p = { id, name: id, avatar: "🦊", color: "#fff" };
  if (username) p.username = username;
  if (googleSub) p.googleSub = googleSub;
  if (kids) p.kids = kids;
  if (password) {
    const { salt, hash } = await profiles._internals.hashPassword(password);
    p.passwordHash = hash;
    p.passwordSalt = salt;
  }
  profiles._internals.store.data.profiles.push(p);
  return p;
};

// The gate in front of the real auth / profile / admin routers, plus
// stand-ins for the routers that serve titles, video and pictures: the gate
// decides on the path, before any of them runs.
// (/avatars is the profile wall's faces: asked "as nobody" — see the signing-in-again test)
const DATA_ROUTES = ["/api/library", "/stream/abc", "/img/abc", "/offline/file/abc", "/proxy"];
const boot = async () => {
  const app = express();
  app.use(express.json());
  app.use(resetgate.middleware);
  app.use(authRouter);
  app.use(profilesRouter);
  app.use(adminRouter);
  for (const r of [...DATA_ROUTES, "/avatars/abc.jpg"]) app.get(r, (req, res) => res.json({ served: true, as: authz.sessionFor(req) ? "someone" : "nobody" }));
  app.get("/", (req, res) => res.json({ shell: true }));
  app.get("/js/main.js", (req, res) => res.json({ shell: true }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get("set-cookie") };
  };
  return { call, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
};

const reset = () => {
  fails.clear();
  realtime.clients.clear();
  sessions._internals.store.data = {};
  sessions._internals.ended.clear();
  profiles._internals.store.data = { profiles: [], state: {}, pending: [], access: {} };
  settings.data.authMode = "transition";
};
// One server per test, the mode set for it and put back afterwards.
const withServer = async (mode, fn) => {
  reset();
  settings.data.authMode = mode;
  const srv = await boot();
  try { await fn(srv); } finally { await srv.close(); reset(); }
};

// A socket as realtime keeps it (see signout-everywhere.test.js).
const fakeClient = (id, { hello = null, helloId = null, session = null, restricted = null } = {}) => {
  const got = [];
  const ws = { readyState: 1, profileId: session, restricted, authed: !!session, send: (m) => got.push(JSON.parse(m)), close: () => { ws.closed = true; } };
  realtime.clients.set(id, { id, profile: hello, profileId: helloId, ws });
  return { got, ws };
};

const force = (srv, id, on = true) => srv.call("POST", `/api/admin/profiles/${id}/force-reset`, { on }, ADMIN);
const isResetRefusal = (r, id, what) => {
  assert.equal(r.status, 401, `${what}: status`);
  assert.strictEqual(r.body.passwordResetRequired, true, `${what}: passwordResetRequired`);
  assert.strictEqual(r.body.signinRequired, true, `${what}: signinRequired (what an older client acts on)`);
  assert.equal(r.body.profileId, id, `${what}: names the profile`);
  assert.ok(r.body.error, `${what}: says why`);
};
const cookieOf = (sid) => ({ cookie: `aurora_session=${sid}` });

// ---------- the profile store's half ----------

test("the flag is only ever set on a profile that has a password; the new password must be a new one", async () => {
  reset();
  await addProfile("p-pw", { password: "old-pass" });
  await addProfile("p-open");
  await addProfile("p-legacy");
  profiles._internals.store.data.profiles.find((p) => p.id === "p-legacy").mustReset = true; // left by an older build

  assert.strictEqual(profiles.resetDue("p-pw"), false);
  const flagged = profiles.setMustReset("p-pw", true);
  assert.ok(flagged && !flagged.noPassword);
  assert.strictEqual(profiles.resetDue("p-pw"), true);

  const open = profiles.setMustReset("p-open", true);
  assert.strictEqual(open.noPassword, true, "nothing to reset: said so");
  assert.strictEqual(profiles.resetDue("p-open"), false);
  assert.equal("mustReset" in profiles._internals.store.data.profiles.find((p) => p.id === "p-open"), false);
  assert.strictEqual(profiles.resetDue("p-legacy"), false, "a flag on a password-less profile means nothing");
  assert.strictEqual((await profiles.unlock("p-legacy", "")).mustReset, false);
  assert.strictEqual(profiles.resetDue("nobody"), false);

  assert.deepEqual(await profiles.setPassword("p-pw", "brand-new", "guess"), { error: "wrong password" });
  assert.equal((await profiles.setPassword("p-pw", "old-pass", "old-pass")).code, "same");
  assert.equal((await profiles.setPassword("p-pw", "", "old-pass")).code, "needed");
  assert.strictEqual(profiles.resetDue("p-pw"), true, "none of those cleared it");
  assert.deepEqual(await profiles.setPassword("p-pw", "brand-new", "old-pass"), { ok: true });
  assert.strictEqual(profiles.resetDue("p-pw"), false);
  // with nothing due, the same password again is an ordinary (pointless) change
  assert.deepEqual(await profiles.setPassword("p-pw", "brand-new", "brand-new"), { ok: true });
  reset();
});

// ---------- force: everything of the profile ends at once ----------

for (const mode of ["open", "transition", "closed"]) {
  test(`[${mode}] forcing a reset ends every session and unlock token and tells the profile's sockets`, async () => {
    await withServer(mode, async (srv) => {
      await addProfile("p-ann", { username: "ann", password: "old-pass" });
      await addProfile("p-bob", { username: "bob", password: "bob-pass" });
      const phone = (await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).body;
      const tv = (await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).body;
      const bob = (await srv.call("POST", "/api/auth/login", { username: "bob", password: "bob-pass" })).body;
      assert.strictEqual(phone.mustReset, false);
      assert.equal((await srv.call("GET", "/api/profiles/p-ann/state", null, { "X-Session": phone.session })).status, 200);

      const byHello = fakeClient("c-hello", { hello: "p-ann", helloId: "p-ann" }); // a tab: said hello as the profile
      const bySession = fakeClient("c-sess", { session: "p-ann" });               // a TV that has only connected
      const other = fakeClient("c-bob", { hello: "p-bob", helloId: "p-bob", session: "p-bob" });

      const r = await force(srv, "p-ann");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true, mustReset: true, kicked: 2, sessions: 2 });
      assert.equal(sessions.listFor("p-ann").length, 0, "no session of the profile is left");
      for (const t of [phone.profileToken, tv.profileToken]) assert.equal(profiles.tokenValid("p-ann", t), false);
      for (const c of [byHello, bySession]) {
        assert.deepEqual(c.got.map((m) => m.type), ["kicked"], "the message every client already handles");
        assert.strictEqual(c.got[0].reset, true);
        assert.strictEqual(c.ws.closed, true);
      }
      assert.deepEqual(other.got, [], "nobody else's socket hears a thing");
      assert.equal(sessions.listFor("p-bob").length, 1);

      // the devices that were signed in: refused in a way they understand
      for (const h of [{ "X-Session": phone.session }, { "X-Profile-Token": tv.profileToken }]) {
        const dead = await srv.call("GET", "/api/profiles/p-ann/state", null, h);
        assert.equal(dead.status, 401);
        assert.strictEqual(dead.body.signinRequired, true);
        assert.equal("passwordResetRequired" in dead.body, false, "an ended credential is not a restricted one");
      }
      // bob is untouched
      assert.equal((await srv.call("GET", "/api/profiles/p-bob/state", null, { "X-Session": bob.session })).status, 200);
      // the admin's list says a reset is pending for ann, and only for her
      const people = (await srv.call("GET", "/api/admin/people", null, ADMIN)).body.people;
      assert.strictEqual(people.find((p) => p.id === "p-ann").mustReset, true);
      assert.strictEqual(people.find((p) => p.id === "p-bob").mustReset, false);
    });
  });

  // ---------- the restricted credential ----------

  test(`[${mode}] a must-reset sign-in opens nothing but the way to a new password (api, stream, img, avatars, proxy, socket)`, async () => {
    await withServer(mode, async (srv) => {
      await addProfile("p-ann", { username: "ann", password: "old-pass" });
      await force(srv, "p-ann");
      const login = await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" });
      assert.equal(login.status, 200, "the current password still signs in — that is the proof of who this is");
      assert.strictEqual(login.body.mustReset, true);
      // everything an older client reads is still there
      for (const k of ["ok", "user", "profile", "profileToken", "session"]) assert.ok(login.body[k], k);
      const sid = login.body.session;

      // the same refusal whichever way the credential arrives
      const carriers = { "X-Session": { "X-Session": sid }, cookie: cookieOf(sid), "X-Profile-Token": { "X-Profile-Token": login.body.profileToken } };
      for (const [name, h] of Object.entries(carriers)) {
        for (const url of [...DATA_ROUTES, "/api/profiles/p-ann/state", "/api/profiles/p-ann/watchlist", "/api/auth/sessions", "/api/push/key", "/api/push/pending?k=" + "0".repeat(64)]) {
          isResetRefusal(await srv.call("GET", url, null, h), "p-ann", `GET ${url} by ${name}`);
        }
        for (const [method, url, body] of [
          ["POST", "/api/auth/profile-token", {}],
          ["POST", "/api/profiles/p-ann/signout-everywhere", {}],
          ["POST", "/api/profiles/p-ann/progress", { itemId: "x", position: 1, duration: 2 }],
          ["POST", "/api/profiles/p-ann/watchlist", { itemId: "x", add: true }],
          ["PUT", "/api/profiles/p-ann", { name: "Hacked" }],
          ["DELETE", "/api/profiles/p-ann", null],
          ["POST", "/api/auth/device/approve", { code: "ABCDEF" }],
          ["POST", "/api/auth/claim", { profileId: "p-ann", username: "ann2" }],
          ["POST", "/api/profiles/p-other/password", { newPassword: "whatever-1", currentPassword: "old-pass" }],
        ]) {
          isResetRefusal(await srv.call(method, url, body, h), "p-ann", `${method} ${url} by ${name}`);
        }
        // what stays open: what a client needs to draw the screen...
        assert.equal((await srv.call("GET", "/api/ping", null, h)).status, 200);
        const me = await srv.call("GET", "/api/me", null, h);
        assert.equal(me.status, 200);
        assert.strictEqual(me.body.user, null, "not signed in, as far as a client that predates the rule can tell");
        assert.strictEqual(me.body.passwordResetRequired, true);
        assert.deepEqual(me.body.resetProfile, { id: "p-ann", name: "p-ann", avatar: "🦊", color: "#fff" });
        assert.equal(me.body.authMode, mode);
        // ...and the static shell, which is not data (the screen that asks has to load)
        assert.equal((await srv.call("GET", "/", null, h)).status, 200);
        assert.equal((await srv.call("GET", "/js/main.js", null, h)).status, 200);
      }
      assert.equal(profiles.list().find((p) => p.id === "p-ann").name, "p-ann", "nothing was written");
      assert.equal(profiles.list().length, 1, "nothing was deleted");

      // the list of what a restricted credential may call is exact
      const may = (method, path) => resetgate.allowedWhileRestricted({ method, path }, "p-ann");
      assert.equal(may("GET", "/api/server-info"), true);
      assert.equal(may("POST", "/api/server-info"), false);
      assert.equal(may("POST", "/api/auth/logout"), true);
      assert.equal(may("POST", "/api/auth/password"), true);
      assert.equal(may("POST", "/api/profiles/p-ann/password"), true);
      assert.equal(may("POST", "/api/profiles/p-ann/passwordx"), false);
      assert.equal(may("POST", "/api/profiles/p-ann/password/x"), false);
      assert.equal(may("GET", "/api/me-too"), false);
      assert.equal(may("POST", "/api/auth/login"), false, "signing in is not done AS the profile (see the next test)");

      // the admin page open in the same browser keeps working (its calls carry the admin password)
      assert.equal((await srv.call("GET", "/api/library", null, { ...cookieOf(sid), ...ADMIN })).status, 200);
      assert.equal((await srv.call("GET", "/api/admin/people", null, { ...cookieOf(sid), ...ADMIN })).status, 200);

      // the WebSocket upgrade: a stranger's socket, and what it says is dropped
      for (const headers of [{ cookie: `aurora_session=${sid}` }, { "x-session": sid }]) {
        const ws = {};
        realtime._internals.stampSocket(ws, { headers });
        assert.deepEqual({ authed: ws.authed, profileId: ws.profileId, restricted: ws.restricted },
          { authed: false, profileId: null, restricted: "p-ann" });
        const client = { id: "c1", profile: null, activity: "Browsing", ws };
        realtime._internals.handleMessage(client, { type: "hello", profile: "p-ann", profileId: "p-ann" }, ws);
        realtime._internals.handleMessage(client, { type: "activity", action: "Watching", details: "A film" }, ws);
        assert.deepEqual({ profile: client.profile, activity: client.activity }, { profile: null, activity: "Browsing" });
      }

      // someone else on the same server is not held up by ann's reset
      await addProfile("p-bob", { username: "bob", password: "bob-pass" });
      const bob = (await srv.call("POST", "/api/auth/login", { username: "bob", password: "bob-pass" })).body;
      assert.equal((await srv.call("GET", "/api/library", null, { "X-Session": bob.session })).status, 200);
      assert.equal((await srv.call("GET", "/api/profiles/p-bob/state", null, { "X-Session": bob.session })).status, 200);
      const bobWs = {};
      realtime._internals.stampSocket(bobWs, { headers: { "x-session": bob.session } });
      assert.deepEqual({ authed: bobWs.authed, profileId: bobWs.profileId, restricted: bobWs.restricted }, { authed: true, profileId: "p-bob", restricted: null });
    });
  });

  // ---------- signing in again, and a device that has moved on ----------

  test(`[${mode}] a device holding a must-reset sign-in can still sign in as someone else — as a stranger would, and never as that profile`, async () => {
    await withServer(mode, async (srv) => {
      await addProfile("p-ann", { username: "ann", password: "old-pass" });
      await addProfile("p-bob", { username: "bob", password: "bob-pass" });
      await addProfile("p-open");
      await force(srv, "p-ann");
      const login = async () => (await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).body;

      // what a device with no sign-in may ask is exactly this list, and nothing that acts with a session
      const again = (method, path) => resetgate.signingInAgain({ method, path });
      for (const [m, p] of [["POST", "/api/auth/login"], ["POST", "/api/auth/signup"], ["POST", "/api/auth/google/start"], ["POST", "/api/auth/google/poll"],
        ["GET", "/api/auth/google/web-start"], ["GET", "/api/auth/google/web-callback"], ["POST", "/api/auth/google/web-finish"],
        ["POST", "/api/auth/device/start"], ["POST", "/api/auth/device/poll"], ["GET", "/api/auth/device/describe/ABC123"],
        ["GET", "/api/profiles"], ["POST", "/api/profiles/p-bob/unlock"], ["GET", "/api/kids/status"], ["POST", "/api/kids/enter"], ["POST", "/api/kids/exit"], ["GET", "/avatars/x.jpg"]]) {
        assert.equal(again(m, p), true, `${m} ${p}`);
      }
      for (const [m, p] of [["POST", "/api/auth/device/approve"], ["POST", "/api/auth/profile-token"], ["POST", "/api/auth/claim"], ["GET", "/api/auth/claimable/p-ann"],
        ["POST", "/api/auth/google/link"], ["GET", "/api/auth/sessions"], ["DELETE", "/api/auth/sessions/abc"], ["POST", "/api/profiles"], ["GET", "/api/profiles/p-ann/state"],
        ["POST", "/api/profiles/p-ann/kids"], ["GET", "/api/library"], ["GET", "/img/x"], ["GET", "/stream/x"]]) {
        assert.equal(again(m, p), false, `${m} ${p}`);
      }

      // the restricted sign-in in an X-Session header (a TV on its "new password" screen): the wall and the
      // sign-in answer as they do for a stranger, and the session is left alone
      const a = await login();
      const H = { "X-Session": a.session };
      const wall = await srv.call("GET", "/api/profiles", null, H);
      if (mode === "closed") {
        assert.deepEqual([wall.status, wall.body.signinRequired, "passwordResetRequired" in wall.body], [401, true, false], "the wall of a closed server, to a stranger");
      } else {
        assert.equal(wall.status, 200);
        assert.equal(wall.body.length, 3);
      }
      assert.deepEqual((await srv.call("GET", "/avatars/abc.jpg", null, H)).body, { served: true, as: "nobody" }, "a face on the wall, asked as nobody");
      const asBob = await srv.call("POST", "/api/auth/login", { username: "bob", password: "bob-pass" }, H);
      assert.deepEqual([asBob.status, asBob.body.user.profileId, asBob.body.mustReset], [200, "p-bob", false]);
      const pair = await srv.call("POST", "/api/auth/device/start", {}, H);
      assert.equal(pair.status, 200);
      // approving a TV is done WITH a session: not as this one
      isResetRefusal(await srv.call("POST", "/api/auth/device/approve", { code: pair.body.code }, H), "p-ann", "approve");
      assert.equal((await srv.call("GET", "/api/me", null, H)).body.passwordResetRequired, true, "the session is still there, still restricted");

      // an unlock at the wall of someone else's profile, with the restricted token still in the header
      const T = { "X-Profile-Token": a.profileToken };
      const other = await srv.call("POST", "/api/profiles/p-open/unlock", {}, T);
      if (mode === "closed") assert.equal(other.status, 401, "a closed server unlocks for its own session only");
      else assert.ok(other.status === 200 && other.body.token);

      // THE STALE COOKIE (the TV's HTTP stack keeps the cookie of an earlier sign-in). The device has moved
      // on to bob, with bob's own session in the header: it is bob — not held up by ann's reset, and not ann.
      const stale = await login();
      const bob = asBob.body;
      const both = { "X-Session": bob.session, ...cookieOf(stale.session) };
      assert.equal((await srv.call("GET", "/api/library", null, both)).status, 200);
      assert.equal((await srv.call("GET", "/api/profiles/p-bob/state", null, both)).status, 200);
      assert.equal((await srv.call("GET", "/api/me", null, both)).body.user.profileId, "p-bob");
      const annsData = await srv.call("GET", "/api/profiles/p-ann/state", null, both);
      assert.equal(annsData.status, 401, "ann's cookie does not open ann's data through bob's request");
      assert.equal((await srv.call("POST", "/api/auth/profile-token", {}, both)).body.profileId, "p-bob", "nor does it turn into a token for ann");
      const ws = {};
      realtime._internals.stampSocket(ws, { headers: { "x-session": bob.session, cookie: `aurora_session=${stale.session}` } });
      assert.deepEqual({ authed: ws.authed, profileId: ws.profileId, restricted: ws.restricted }, { authed: true, profileId: "p-bob", restricted: null });
      // ...and the session the cookie named is over: it cannot go on riding along (a TV's pictures carry no token)
      assert.equal((await srv.call("GET", "/api/me", null, cookieOf(stale.session))).body.user, null);
      assert.equal("passwordResetRequired" in (await srv.call("GET", "/api/me", null, cookieOf(stale.session))).body, false);

      // The cookie alone, at the wall or the sign-in screen: let through as a stranger, and the session ended
      const left = await login();
      const C = cookieOf(left.session);
      isResetRefusal(await srv.call("GET", "/api/library", null, C), "p-ann", "the cookie alone is ann's");
      // (a face on the wall loads as nobody's, and does not end the sign-in the screen is waiting on)
      assert.deepEqual((await srv.call("GET", "/avatars/abc.jpg", null, C)).body, { served: true, as: "nobody" });
      assert.equal((await srv.call("GET", "/api/me", null, C)).body.passwordResetRequired, true);
      const reSign = await srv.call("POST", "/api/auth/login", { username: "bob", password: "bob-pass" }, C);
      assert.deepEqual([reSign.status, reSign.body.user.profileId], [200, "p-bob"]);
      assert.match(reSign.cookie || "", /^aurora_session=[0-9a-f]{64};/, "the browser's cookie is bob's now");
      assert.equal((await srv.call("GET", "/api/me", null, C)).body.user, null, "ann's restricted session ended when the device walked away");
      assert.equal(sessions.listFor("p-ann").length, 1, "only the one still in a header is left");
      assert.strictEqual(profiles.resetDue("p-ann"), true, "and none of this made the requirement go away");
    });
  });

  // ---------- the change ----------

  test(`[${mode}] saving the new password: the current one is the proof, the old one again is refused, and this device carries on with fresh credentials`, async () => {
    await withServer(mode, async (srv) => {
      await addProfile("p-ann", { username: "ann", password: "old-pass" });
      await force(srv, "p-ann");
      const here = (await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).body;
      const elsewhere = (await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).body; // a second device, also mid-reset
      const S = { "X-Session": here.session };
      const otherSock = fakeClient("c-else", { restricted: "p-ann" });
      const mySock = fakeClient("c-here", { restricted: "p-ann" });

      const post = (body, h = S) => srv.call("POST", "/api/profiles/p-ann/password", body, h);
      assert.equal((await post({ newPassword: "new-pass-1" })).status, 401, "no current password");
      const wrong = await post({ newPassword: "new-pass-1", currentPassword: "guess" });
      assert.deepEqual([wrong.status, wrong.body.error], [401, "wrong password"]);
      const same = await post({ newPassword: "old-pass", currentPassword: "old-pass" });
      assert.deepEqual([same.status, same.body.code], [400, "same"]);
      const none = await post({ newPassword: "", currentPassword: "old-pass" });
      assert.deepEqual([none.status, none.body.code], [400, "needed"]);
      assert.equal((await post({ newPassword: "abc", currentPassword: "old-pass" })).status, 400, "the usual minimum");
      assert.strictEqual(profiles.resetDue("p-ann"), true, "none of those ended the requirement");
      isResetRefusal(await srv.call("GET", "/api/library", null, S), "p-ann", "still restricted");
      // with no credential at all the route is the wall's, as ever
      assert.equal((await post({ newPassword: "new-pass-1", currentPassword: "old-pass" }, {})).status, 401);

      const saved = await post({ newPassword: "new-pass-1", currentPassword: "old-pass", clientId: "c-here" });
      assert.equal(saved.status, 200);
      assert.deepEqual({ ok: saved.body.ok, passwordReset: saved.body.passwordReset }, { ok: true, passwordReset: "done" });
      assert.ok(saved.body.token && saved.body.session && saved.body.user, "fresh credentials for this device");
      assert.match(saved.cookie || "", /^aurora_session=[0-9a-f]{64};/, "and the browser's cookie");
      assert.notEqual(saved.body.session, here.session);
      assert.strictEqual(profiles.resetDue("p-ann"), false);

      // this device: straight on, no wall in between
      const fresh = { "X-Session": saved.body.session };
      assert.equal((await srv.call("GET", "/api/library", null, fresh)).status, 200);
      assert.equal((await srv.call("GET", "/api/profiles/p-ann/state", null, fresh)).status, 200);
      // (the unlock token alone opens the profile wherever a token alone ever did)
      assert.equal((await srv.call("GET", "/api/profiles/p-ann/state", null, { "X-Profile-Token": saved.body.token })).status, mode === "closed" ? 401 : 200);
      assert.equal((await srv.call("GET", "/api/me", null, fresh)).body.user.profileId, "p-ann");
      const ws = {};
      realtime._internals.stampSocket(ws, { headers: { "x-session": saved.body.session } });
      assert.deepEqual({ authed: ws.authed, profileId: ws.profileId, restricted: ws.restricted }, { authed: true, profileId: "p-ann", restricted: null });

      // everything else of the profile is gone: the session that saved it, the other device's, every old token
      assert.equal(sessions.listFor("p-ann").length, 1);
      for (const dead of [here.session, elsewhere.session]) {
        assert.equal((await srv.call("GET", "/api/me", null, { "X-Session": dead })).body.user, null);
        assert.equal((await srv.call("GET", "/api/profiles/p-ann/state", null, { "X-Session": dead })).status, 401);
      }
      for (const t of [here.profileToken, elsewhere.profileToken]) assert.equal(profiles.tokenValid("p-ann", t), false);
      // the other device's socket is told; the one that saved it is not
      assert.deepEqual(otherSock.got, [{ type: "profile_signed_out", profileId: "p-ann" }]);
      assert.deepEqual(mySock.got, []);

      // the old password is finished; the new one signs in with nothing due
      assert.equal((await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).status, 401);
      const after = await srv.call("POST", "/api/auth/login", { username: "ann", password: "new-pass-1" });
      assert.deepEqual([after.status, after.body.mustReset], [200, false]);
      assert.equal((await srv.call("GET", "/api/library", null, { "X-Session": after.body.session })).status, 200);
    });
  });

  test(`[${mode}] the session route saves it too, and "Sign out" ends the restricted sign-in`, async () => {
    await withServer(mode, async (srv) => {
      await addProfile("p-ann", { username: "ann", password: "old-pass" });
      await force(srv, "p-ann");
      const a = (await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).body;
      // sign out: the session and the unlock token it came with are both gone
      const out = await srv.call("POST", "/api/auth/logout", {}, { "X-Session": a.session, "X-Profile-Token": a.profileToken });
      assert.equal(out.status, 200);
      assert.equal(sessions.listFor("p-ann").length, 0);
      assert.equal(profiles.tokenValid("p-ann", a.profileToken), false);
      assert.strictEqual(profiles.resetDue("p-ann"), true, "signing out does not make the requirement go away");

      const b = (await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).body;
      const S = { "X-Session": b.session };
      const bad = await srv.call("POST", "/api/auth/password", { currentPassword: "nope", newPassword: "new-pass-2" }, S);
      assert.deepEqual([bad.status, bad.body.error], [401, "current password is wrong"]);
      const same = await srv.call("POST", "/api/auth/password", { currentPassword: "old-pass", newPassword: "old-pass" }, S);
      assert.deepEqual([same.status, same.body.code], [400, "same"]);
      const ok = await srv.call("POST", "/api/auth/password", { currentPassword: "old-pass", newPassword: "new-pass-2" }, S);
      assert.equal(ok.status, 200);
      assert.ok(ok.body.token && ok.body.session && ok.body.user);
      assert.equal((await srv.call("GET", "/api/library", null, { "X-Session": ok.body.session })).status, 200);
      assert.strictEqual(profiles.resetDue("p-ann"), false);
    });
  });

  test(`[${mode}] the admin can take it back, or choose the password — either ends the requirement`, async () => {
    await withServer(mode, async (srv) => {
      await addProfile("p-ann", { username: "ann", password: "old-pass" });
      await force(srv, "p-ann");
      const a = (await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).body;
      const S = { "X-Session": a.session };
      isResetRefusal(await srv.call("GET", "/api/library", null, S), "p-ann", "restricted");
      // withdrawn: what was opened with the right password meanwhile is an ordinary sign-in again
      const off = await force(srv, "p-ann", false);
      assert.deepEqual(off.body, { ok: true, mustReset: false });
      assert.equal((await srv.call("GET", "/api/library", null, S)).status, 200);
      assert.equal((await srv.call("GET", "/api/me", null, S)).body.user.profileId, "p-ann");

      // "Set password" (someone forgot theirs): no requirement left, old sign-ins gone, the chosen password signs in
      await force(srv, "p-ann");
      const set = await srv.call("POST", "/api/admin/signin/p-ann/password", { newPassword: "temp-1234" }, ADMIN);
      assert.equal(set.status, 200);
      assert.strictEqual(profiles.resetDue("p-ann"), false);
      const temp = await srv.call("POST", "/api/auth/login", { username: "ann", password: "temp-1234" });
      assert.deepEqual([temp.status, temp.body.mustReset], [200, false]);
      // ...and "Reset password" after it makes that a temporary password
      await force(srv, "p-ann");
      const t2 = await srv.call("POST", "/api/auth/login", { username: "ann", password: "temp-1234" });
      assert.strictEqual(t2.body.mustReset, true);
      const done = await srv.call("POST", "/api/profiles/p-ann/password", { currentPassword: "temp-1234", newPassword: "my-own-1" }, { "X-Session": t2.body.session });
      assert.equal(done.status, 200);
      assert.equal((await srv.call("POST", "/api/auth/login", { username: "ann", password: "temp-1234" })).status, 401);
    });
  });
}

// ---------- the profile wall (no sign-in: an unlock token is all there is) ----------

for (const mode of ["open", "transition"]) {
  test(`[${mode}] a profile with a password and no sign-in: the wall's unlock yields a restricted token, and the new password a fresh one`, async () => {
    await withServer(mode, async (srv) => {
      await addProfile("p-wall", { password: "old-pass" });
      const before = (await srv.call("POST", "/api/profiles/p-wall/unlock", { password: "old-pass" })).body.token;
      assert.equal((await force(srv, "p-wall")).body.mustReset, true);
      assert.equal(profiles.tokenValid("p-wall", before), false);

      const unlock = await srv.call("POST", "/api/profiles/p-wall/unlock", { password: "old-pass" });
      assert.deepEqual([unlock.status, unlock.body.mustReset], [200, true]);
      assert.equal("session" in unlock.body, false, "nothing to sign in as");
      const T = { "X-Profile-Token": unlock.body.token };
      for (const url of [...DATA_ROUTES, "/api/profiles/p-wall/state"]) {
        isResetRefusal(await srv.call("GET", url, null, T), "p-wall", `GET ${url}`);
      }
      assert.strictEqual((await srv.call("GET", "/api/me", null, T)).body.passwordResetRequired, true);
      // claiming a sign-in for it has to wait as well
      isResetRefusal(await srv.call("POST", "/api/auth/claim", { profileId: "p-wall", username: "wall" }, T), "p-wall", "claim");
      // the profile's data needs a credential, and every credential is restricted: no way round
      assert.equal((await srv.call("GET", "/api/profiles/p-wall/state")).status, 401);
      // (what these modes serve to anyone, they still serve to anyone — see lib/resetgate.js)
      assert.equal((await srv.call("GET", "/api/library")).status, 200);

      const saved = await srv.call("POST", "/api/profiles/p-wall/password", { currentPassword: "old-pass", newPassword: "new-pass-1" }, T);
      assert.equal(saved.status, 200);
      assert.ok(saved.body.token);
      assert.equal("session" in saved.body, false);
      assert.equal(profiles.tokenValid("p-wall", unlock.body.token), false, "the restricted token ended with the old password");
      assert.equal((await srv.call("GET", "/api/profiles/p-wall/state", null, { "X-Profile-Token": saved.body.token })).status, 200);
      assert.equal((await srv.call("GET", "/api/library", null, { "X-Profile-Token": saved.body.token })).status, 200);
      const again = await srv.call("POST", "/api/profiles/p-wall/unlock", { password: "new-pass-1" });
      assert.deepEqual([again.status, again.body.mustReset], [200, false]);
    });
  });
}

// ---------- the account types ----------

test("Google-only sign-in (no password): nothing to reset — signed out everywhere, no flag, and the next Google sign-in is an ordinary one", async () => {
  await withServer("closed", async (srv) => {
    await addProfile("p-goo", { username: "goo", googleSub: "g-1" });
    const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
    const first = googleOutcomeFor({ sub: "g-1" }, req);
    assert.equal((await srv.call("GET", "/api/library", null, { "X-Session": first.session })).status, 200);
    const sock = fakeClient("c-goo", { session: "p-goo" });

    const r = await force(srv, "p-goo");
    assert.deepEqual(r.body, { ok: true, mustReset: false, noPassword: true, hasGoogle: true, kicked: 1, sessions: 1 });
    assert.equal("mustReset" in profiles.list().find((p) => p.id === "p-goo"), false);
    assert.deepEqual(sock.got.map((m) => [m.type, "reset" in m]), [["kicked", false]]);
    assert.equal((await srv.call("GET", "/api/me", null, { "X-Session": first.session })).body.user, null);

    const next = googleOutcomeFor({ sub: "g-1" }, req);
    assert.strictEqual(next.mustReset, false);
    assert.equal((await srv.call("GET", "/api/library", null, { "X-Session": next.session })).status, 200);
    assert.strictEqual((await srv.call("GET", "/api/admin/people", null, ADMIN)).body.people.find((p) => p.id === "p-goo").mustReset, false);
  });
});

test("Google sign-in on a profile that also has a password: the reset is the password's — the Google sign-in is restricted and the change wants the current password", async () => {
  await withServer("closed", async (srv) => {
    await addProfile("p-both", { username: "both", password: "old-pass", googleSub: "g-2" });
    assert.equal((await force(srv, "p-both")).body.mustReset, true);
    const o = googleOutcomeFor({ sub: "g-2" }, { headers: {}, socket: { remoteAddress: "127.0.0.1" } });
    assert.strictEqual(o.mustReset, true);
    assert.ok(o.session && o.profileToken && o.user && o.profile);
    const S = { "X-Session": o.session };
    isResetRefusal(await srv.call("GET", "/api/library", null, S), "p-both", "Google session");
    // no password was typed to sign in: it is asked for here, and a guess is refused
    assert.equal((await srv.call("POST", "/api/profiles/p-both/password", { newPassword: "new-pass-1" }, S)).status, 401);
    assert.equal((await srv.call("POST", "/api/profiles/p-both/password", { newPassword: "new-pass-1", currentPassword: "old-pass" }, S)).status, 200);
    // an identity with no profile is a signup, with nothing to reset
    assert.equal("mustReset" in googleOutcomeFor({ sub: "g-none" }, { headers: {}, socket: { remoteAddress: "127.0.0.1" } }), false);
  });
});

test("kids and PIN-opened profiles: the household PIN is not this password — a reset never touches it, and a kids profile is never asked for a new password", async () => {
  await withServer("transition", async (srv) => {
    await profiles.setKidsPin("4321");
    await addProfile("p-kid", { kids: { maxAge: 7 } });                         // a kids profile with no password
    await addProfile("p-kidpw", { kids: { maxAge: 12 }, password: "kid-pass" }); // ...and one with its own
    await addProfile("p-adult");                                                // no password: the PIN opens it
    assert.strictEqual(profiles.needsKidsPin("p-adult"), true);

    for (const id of ["p-kid", "p-adult"]) {
      const r = await force(srv, id);
      assert.deepEqual([r.status, r.body.mustReset, r.body.noPassword], [200, false, true], id);
      assert.strictEqual(profiles.resetDue(id), false);
    }
    // they open exactly as before: the kids one freely, the grown-up's with the PIN
    const kid = await srv.call("POST", "/api/profiles/p-kid/unlock", {});
    assert.deepEqual([kid.status, kid.body.mustReset], [200, false]);
    assert.equal((await srv.call("GET", "/api/library", null, { "X-Profile-Token": kid.body.token })).status, 200);
    assert.strictEqual((await srv.call("POST", "/api/profiles/p-adult/unlock", {})).body.pinRequired, true);
    const adult = await srv.call("POST", "/api/profiles/p-adult/unlock", { pin: "4321" });
    assert.deepEqual([adult.status, adult.body.mustReset], [200, false]);

    // A kids profile WITH a password is not asked either: a child may not change it (the kids gate
    // refuses that from inside a kids profile), so the requirement could never be met. It is signed
    // out everywhere; the grown-ups' "Set password" is what gives it a new one.
    const before = (await srv.call("POST", "/api/profiles/p-kidpw/unlock", { password: "kid-pass" })).body.token;
    const kf = await force(srv, "p-kidpw");
    assert.deepEqual(kf.body, { ok: true, mustReset: false, kidsProfile: true, kicked: 0, sessions: 0 });
    assert.strictEqual(profiles.resetDue("p-kidpw"), false);
    assert.equal(profiles.tokenValid("p-kidpw", before), false, "signed out all the same");
    const u = await srv.call("POST", "/api/profiles/p-kidpw/unlock", { password: "kid-pass" });
    assert.deepEqual([u.status, u.body.mustReset], [200, false]);
    assert.equal((await srv.call("GET", "/api/library", null, { "X-Profile-Token": u.body.token })).status, 200);
    assert.strictEqual((await srv.call("GET", "/api/admin/people", null, ADMIN)).body.people.find((p) => p.id === "p-kidpw").mustReset, false);
    const set = await srv.call("POST", "/api/admin/signin/p-kidpw/password", { newPassword: "kid-new-1" }, ADMIN);
    assert.equal(set.status, 200);
    assert.equal((await srv.call("POST", "/api/profiles/p-kidpw/unlock", { password: "kid-pass" })).status, 401);
    assert.equal((await srv.call("POST", "/api/profiles/p-kidpw/unlock", { password: "kid-new-1" })).status, 200);
    assert.deepEqual(profiles.kidsOf("p-kidpw"), { maxAge: 12 });

    // a profile made a kids one while a reset was pending stops owing it (nobody could meet it there)
    await addProfile("p-late", { password: "late-pass" });
    assert.equal((await force(srv, "p-late")).body.mustReset, true);
    assert.strictEqual(profiles.resetDue("p-late"), true);
    profiles.setKids("p-late", { maxAge: 7 });
    assert.strictEqual(profiles.resetDue("p-late"), false);
    const late = await srv.call("POST", "/api/profiles/p-late/unlock", { password: "late-pass" });
    assert.deepEqual([late.status, late.body.mustReset], [200, false]);

    assert.strictEqual(profiles.kidsPinSet(), true);
    assert.strictEqual(await profiles.verifyKidsPin("4321"), true, "the PIN is what it was");
  });
});

// ---------- signed out by the admin, as a client with no socket meets it ----------

for (const mode of ["open", "transition"]) {
  test(`[${mode}] a device the admin signed out is told to sign in again on its next request — and can`, async () => {
    await withServer(mode, async (srv) => {
      await addProfile("p-ann", { username: "ann", password: "old-pass" });
      const a = (await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).body;
      const kick = await srv.call("POST", "/api/admin/profiles/p-ann/kick", {}, ADMIN);
      assert.deepEqual(kick.body, { ok: true, kicked: 0, sessions: 1 });

      // what the TV app and the website attach themselves (headers)
      for (const h of [{ "X-Session": a.session }, { "X-Profile-Token": a.profileToken }, { "X-Session": a.session, "X-Profile-Token": a.profileToken }]) {
        for (const url of [...DATA_ROUTES, "/api/profiles/p-ann/state"]) {
          const r = await srv.call("GET", url, null, h);
          assert.deepEqual([r.status, r.body.signinRequired, r.body.signedOut], [401, true, true], `GET ${url}`);
          assert.equal("passwordResetRequired" in r.body, false);
        }
        // the way back in stays open: the wall's list, its unlock, sign-in
        assert.equal((await srv.call("GET", "/api/profiles", null, h)).status, 200);
        assert.equal((await srv.call("GET", "/api/me", null, h)).status, 200);
        assert.equal((await srv.call("POST", "/api/profiles/p-ann/unlock", { password: "old-pass" }, h)).status, 200);
      }
      // a dead COOKIE is only a dead cookie (a browser keeps it until something replaces it)
      assert.equal((await srv.call("GET", "/api/library", null, cookieOf(a.session))).status, 200);
      // signed in again: the old token still in a header no longer matters
      const b = (await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).body;
      assert.equal((await srv.call("GET", "/api/library", null, { "X-Session": b.session, "X-Profile-Token": a.profileToken })).status, 200);
      // a token nobody ended (unknown, or lost in a restart) is not "signed out by the admin"
      assert.equal((await srv.call("GET", "/api/library", null, { "X-Profile-Token": "f".repeat(48) })).status, 200);
    });
  });
}

test("guessing the current password on the change route runs into the unlock limiter", async () => {
  await withServer("transition", async (srv) => {
    await addProfile("p-ann", { username: "ann", password: "old-pass" });
    await force(srv, "p-ann");
    const a = (await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).body;
    const S = { "X-Session": a.session };
    for (let i = 0; i < 10; i++) {
      assert.equal((await srv.call("POST", "/api/profiles/p-ann/password", { currentPassword: `guess-${i}`, newPassword: "new-pass-1" }, S)).status, 401);
    }
    const blocked = await srv.call("POST", "/api/profiles/p-ann/password", { currentPassword: "old-pass", newPassword: "new-pass-1" }, S);
    assert.equal(blocked.status, 429);
    assert.equal((await srv.call("POST", "/api/auth/password", { currentPassword: "old-pass", newPassword: "new-pass-1" }, S)).status, 429);
    assert.strictEqual(profiles.resetDue("p-ann"), true);
  });
});

test("a wrong password never reveals that a reset is due", async () => {
  await withServer("transition", async (srv) => {
    await addProfile("p-bob", { username: "bob", password: "right-one" });
    profiles.setMustReset("p-bob", true);
    const r = await srv.call("POST", "/api/auth/login", { username: "bob", password: "wrong-one" });
    assert.equal(r.status, 401);
    assert.equal("mustReset" in r.body, false);
    const u = await srv.call("POST", "/api/profiles/p-bob/unlock", { password: "wrong-one" });
    assert.equal(u.status, 401);
    assert.equal("mustReset" in u.body, false);
  });
});

test("the TV's pairing poll hands a must-reset profile a restricted session, and says so", async () => {
  await withServer("closed", async (srv) => {
    const devicepair = require("../src/lib/devicepair");
    await addProfile("p-cat", { username: "cat", password: "old-pass" });
    const pair = async () => {
      const tv = devicepair.start({ ip: "10.0.0.9" });
      devicepair.approve(tv.code, "p-cat");
      return srv.call("POST", "/api/auth/device/poll", { code: tv.code, secret: tv.secret });
    };
    assert.strictEqual((await pair()).body.mustReset, false);
    profiles.setMustReset("p-cat", true);
    const got = await pair();
    assert.equal(got.status, 200);
    assert.strictEqual(got.body.mustReset, true);
    for (const k of ["ok", "user", "profile", "profileToken", "session"]) assert.ok(got.body[k], k);
    isResetRefusal(await srv.call("GET", "/api/library", null, { "X-Session": got.body.session }), "p-cat", "the paired TV");
  });
});
