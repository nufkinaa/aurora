// A forced password reset (admin → People → "Reset password") reaches every
// way of signing in, not only the profile wall's unlock: login, claim, the
// TV's pairing poll and Google all say `mustReset`, and the server's rule is
// the unlock's rule — the session works, the flag stays until a new password
// is saved, and saving one needs the current password.
// Stores are in-memory, as in auth.test.js.
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

const devicepair = require("../src/lib/devicepair");
const authRouter = require("../src/routes/auth");
const profilesRouter = require("../src/routes/profiles");
const { fails, googleOutcomeFor } = authRouter._internals;

const addProfile = async (id, { username = null, password = null, googleSub = null } = {}) => {
  const p = { id, name: id, avatar: "🦊", color: "#fff" };
  if (username) p.username = username;
  if (googleSub) p.googleSub = googleSub;
  if (password) {
    const { salt, hash } = await profiles._internals.hashPassword(password);
    p.passwordHash = hash;
    p.passwordSalt = salt;
  }
  profiles._internals.store.data.profiles.push(p);
  return p;
};

const boot = async () => {
  const app = express();
  app.use(express.json());
  app.use(authRouter);
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

const reset = () => {
  fails.clear();
  sessions._internals.store.data = {};
  profiles._internals.store.data = { profiles: [], state: {}, pending: [], access: {} };
};

test("login says mustReset, and the session it mints is held to the unlock's rule", async () => {
  reset();
  const srv = await boot();
  try {
    await addProfile("p-ann", { username: "ann", password: "old-pass" });

    const plain = await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" });
    assert.equal(plain.status, 200);
    assert.strictEqual(plain.body.mustReset, false, "not flagged: the field is there and false");

    profiles.setMustReset("p-ann", true);
    const login = await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" });
    assert.equal(login.status, 200);
    assert.strictEqual(login.body.mustReset, true);
    // everything an older client reads is still there
    for (const k of ["ok", "user", "profile", "profileToken", "session"]) assert.ok(login.body[k], k);
    const S = { "X-Session": login.body.session };

    // the wall's unlock says the same thing about the same profile
    const unlock = await srv.call("POST", "/api/profiles/p-ann/unlock", { password: "old-pass" });
    assert.strictEqual(unlock.body.mustReset, true);

    // the unlock's rule: the session is a full session (as the unlock's token is a full token)...
    assert.equal((await srv.call("GET", "/api/profiles/p-ann/state", null, S)).status, 200);
    assert.equal((await srv.call("GET", "/api/profiles/p-ann/state", null, { "X-Profile-Token": unlock.body.token })).status, 200);
    // ...the flag stays until a new password is saved...
    assert.strictEqual((await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).body.mustReset, true);
    // ...and saving one needs the current password, session or not
    const noProof = await srv.call("POST", "/api/profiles/p-ann/password", { newPassword: "new-pass-1" }, S);
    assert.equal(noProof.status, 401);
    const wrong = await srv.call("POST", "/api/profiles/p-ann/password", { newPassword: "new-pass-1", currentPassword: "guess" }, S);
    assert.equal(wrong.status, 401);
    assert.strictEqual(profiles.signinList().find((x) => x.id === "p-ann").mustReset, true);

    const saved = await srv.call("POST", "/api/profiles/p-ann/password", { newPassword: "new-pass-1", currentPassword: "old-pass" }, S);
    assert.equal(saved.status, 200);
    assert.strictEqual(profiles.signinList().find((x) => x.id === "p-ann").mustReset, false);
    // the session that saved it lives on; the next sign-in is not asked again
    assert.equal((await srv.call("GET", "/api/profiles/p-ann/state", null, S)).status, 200);
    const after = await srv.call("POST", "/api/auth/login", { username: "ann", password: "new-pass-1" });
    assert.strictEqual(after.body.mustReset, false);
    assert.equal((await srv.call("POST", "/api/auth/login", { username: "ann", password: "old-pass" })).status, 401);
  } finally {
    await srv.close();
    reset();
  }
});

test("a wrong password never reveals that a reset is due", async () => {
  reset();
  const srv = await boot();
  try {
    await addProfile("p-bob", { username: "bob", password: "right-one" });
    profiles.setMustReset("p-bob", true);
    const r = await srv.call("POST", "/api/auth/login", { username: "bob", password: "wrong-one" });
    assert.equal(r.status, 401);
    assert.equal("mustReset" in r.body, false);
  } finally {
    await srv.close();
    reset();
  }
});

test("the TV's pairing poll says mustReset for the profile it is handed", async () => {
  reset();
  const srv = await boot();
  try {
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
  } finally {
    await srv.close();
    reset();
  }
});

test("a Google sign-in says mustReset too (both flows share one outcome)", async () => {
  reset();
  await addProfile("p-dee", { username: "dee", password: "old-pass", googleSub: "g-123" });
  const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  assert.strictEqual(googleOutcomeFor({ sub: "g-123" }, req).mustReset, false);
  profiles.setMustReset("p-dee", true);
  const o = googleOutcomeFor({ sub: "g-123" }, req);
  assert.strictEqual(o.mustReset, true);
  assert.ok(o.session && o.profileToken && o.user && o.profile);
  // an identity with no profile is a signup, with nothing to reset
  assert.equal("mustReset" in googleOutcomeFor({ sub: "g-none" }, req), false);
  reset();
});

test("claim: the flag is reported for a profile that keeps its password, and cleared by a password picked at claim time", async () => {
  reset();
  const srv = await boot();
  try {
    // has a password already: the claim only adds a username, the reset is still due
    await addProfile("p-eve", { password: "old-pass" });
    profiles.setMustReset("p-eve", true);
    const tok = profiles.issueToken("p-eve");
    const kept = await srv.call("POST", "/api/auth/claim", { profileId: "p-eve", username: "eve" }, { "X-Profile-Token": tok });
    assert.equal(kept.status, 200);
    assert.strictEqual(kept.body.mustReset, true);

    // no password yet: the claim's own password IS the new password
    await addProfile("p-fay");
    profiles.setMustReset("p-fay", true);
    const fresh = await srv.call("POST", "/api/auth/claim", { profileId: "p-fay", username: "fay", password: "brand-new-1" });
    assert.equal(fresh.status, 200);
    assert.strictEqual(fresh.body.mustReset, false);
    assert.strictEqual(profiles.signinList().find((x) => x.id === "p-fay").mustReset, false);
  } finally {
    await srv.close();
    reset();
  }
});
