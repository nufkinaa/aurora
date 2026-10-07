// The People tab's server side (2026-10-07): the forced password reset flag
// and the token revocation the admin's Kick relies on. Module-level, like
// auth.test.js — the store is stubbed so nothing touches data/.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const profiles = require("../src/profiles");

profiles._internals.store.save = () => {};
profiles._internals.store.data = { profiles: [], state: {}, pending: [], access: {} };
const store = () => profiles._internals.store.data;

const seed = async (id, name, password) => {
  const p = { id, name, color: "#123456", avatar: "🙂", createdAt: Date.now() };
  store().profiles.push(p);
  if (password) await profiles.setPassword(id, password, "");
  return p;
};

test("setMustReset flags the profile, unlock reports it, a new password clears it", async () => {
  await seed("p1", "Ann", "secret1");
  assert.equal(profiles.signinList().find((x) => x.id === "p1").mustReset, false);

  const flagged = profiles.setMustReset("p1", true);
  assert.ok(flagged, "returns the public profile");
  assert.equal(profiles.signinList().find((x) => x.id === "p1").mustReset, true);

  // the current password still opens the profile — and says a new one is due
  const r = await profiles.unlock("p1", "secret1");
  assert.equal(r.ok, true);
  assert.equal(r.mustReset, true);
  assert.ok(r.token);

  // the wrong password still fails
  const bad = await profiles.unlock("p1", "nope");
  assert.equal(bad.error, "wrong password");

  // picking a new password is what the reset asked for
  const set = await profiles.setPassword("p1", "newer-1", "secret1");
  assert.equal(set.ok, true);
  assert.equal(profiles.signinList().find((x) => x.id === "p1").mustReset, false);
  const again = await profiles.unlock("p1", "newer-1");
  assert.equal(again.mustReset, false);
});

test("setMustReset(false) withdraws the flag; the admin setting a password clears it too", async () => {
  await seed("p2", "Ben", "pw1234");
  profiles.setMustReset("p2", true);
  profiles.setMustReset("p2", false);
  assert.equal(profiles.signinList().find((x) => x.id === "p2").mustReset, false);

  profiles.setMustReset("p2", true);
  await profiles.adminSetPassword("p2", "admin-set");
  assert.equal(profiles.signinList().find((x) => x.id === "p2").mustReset, false);
  assert.equal((await profiles.unlock("p2", "admin-set")).ok, true);
});

test("setMustReset and revokeTokensFor drop the profile's unlock tokens", async () => {
  await seed("p3", "Cy", "pw1234");
  const t1 = (await profiles.unlock("p3", "pw1234")).token;
  assert.equal(profiles.tokenValid("p3", t1), true);
  profiles.setMustReset("p3", true);
  assert.equal(profiles.tokenValid("p3", t1), false, "a reset signs every device out");

  const t2 = (await profiles.unlock("p3", "pw1234")).token;
  assert.equal(profiles.tokenValid("p3", t2), true);
  profiles.revokeTokensFor("p3");
  assert.equal(profiles.tokenValid("p3", t2), false, "kick drops the tokens");
});

test("setMustReset on an unknown profile answers null", () => {
  assert.equal(profiles.setMustReset("nope", true), null);
});
