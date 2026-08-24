// Prompt 10's foundation, second iteration: ACCOUNT = PROFILE. Sessions,
// sign-in identity on profiles, claiming, email login, the rollout switch,
// and the login rate limiter.
// The profiles and sessions stores are swapped for in-memory fakes BEFORE any
// test runs — save() is a no-op and data is replaced — so these tests can
// never touch the live data/*.json (jsonstore's shutdown flushAll skips them
// too: it only flushes stores with a pending save timer, which a no-op save()
// never arms).
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const sessions = require("../src/lib/sessions");
const profiles = require("../src/profiles");

sessions._internals.store.save = () => {};
sessions._internals.store.data = {};
profiles._internals.store.save = () => {};
profiles._internals.store.data = { profiles: [], state: {}, pending: [], access: {} };

const sesStore = () => sessions._internals.store.data;
const profStore = () => profiles._internals.store.data;

// ---------- sessions ----------

test("create() returns a 64-hex sid and stores only its sha256", () => {
  const sid = sessions.create("prof1", { device: "test", ip: "1.2.3.4" });
  assert.match(sid, /^[0-9a-f]{64}$/);
  assert.equal(sesStore()[sid], undefined, "the raw sid must never be a storage key");
  const key = sessions._internals.hash(sid);
  assert.ok(sesStore()[key], "the sha256 of the sid is the storage key");
  assert.equal(sesStore()[key].profileId, "prof1");
  sessions.revoke(sid);
});

test("get() resolves a valid sid and rejects garbage", () => {
  const sid = sessions.create("prof2");
  assert.equal(sessions.get(sid).profileId, "prof2");
  assert.equal(sessions.get("not-a-sid"), null);
  assert.equal(sessions.get(null), null);
  assert.equal(sessions.get(crypto.randomBytes(32).toString("hex")), null, "unknown sid");
  sessions.revoke(sid);
});

test("an expired session is rejected AND deleted on sight", () => {
  const sid = sessions.create("prof3");
  const key = sessions._internals.hash(sid);
  sesStore()[key].expiresAt = Date.now() - 1000;
  assert.equal(sessions.get(sid), null);
  assert.equal(sesStore()[key], undefined, "expired row is pruned by the read");
});

test("get() slides the expiry once the touch interval has passed", () => {
  const sid = sessions.create("prof4");
  const key = sessions._internals.hash(sid);
  sesStore()[key].lastSeenAt = Date.now() - 10 * 60 * 1000;
  const oldExpiry = (sesStore()[key].expiresAt -= 10 * 60 * 1000);
  sessions.get(sid);
  assert.ok(sesStore()[key].expiresAt > oldExpiry, "expiry moved forward");
  sessions.revoke(sid);
});

test("revoke by sid and by hash key; revokeAllFor clears a profile's sessions", () => {
  const a = sessions.create("prof5");
  const b = sessions.create("prof5");
  const c = sessions.create("other-prof");
  assert.equal(sessions.revoke(a), true, "revoke by raw sid");
  assert.equal(sessions.revoke(sessions._internals.hash(b)), true, "revoke by hash key");
  assert.ok(sessions.get(c), "other profiles' sessions untouched");
  const d = sessions.create("other-prof");
  assert.equal(sessions.revokeAllFor("other-prof"), 2);
  assert.equal(sessions.get(c), null);
  assert.equal(sessions.get(d), null);
});

test("listFor exposes the hash key as a handle, never a usable sid", () => {
  const sid = sessions.create("prof6", { device: "TV", ip: "10.0.0.9" });
  const rows = sessions.listFor("prof6");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, sessions._internals.hash(sid));
  assert.ok(!Object.values(rows[0]).includes(sid), "raw sid must not appear");
  sessions.revoke(sid);
});

// ---------- sign-in identity on profiles ----------

const addProfile = (p) => {
  profStore().profiles.push(p);
  return p;
};

test("norms: username strips junk, email validates", () => {
  const { normUsername, normEmail, validEmail } = profiles._internals;
  assert.equal(normUsername("  ELia!@# "), "elia");
  assert.equal(normUsername("a".repeat(50)).length, 24);
  assert.equal(normEmail("  Bob@Example.COM "), "bob@example.com");
  assert.equal(validEmail("bob@example.com"), true);
  assert.equal(validEmail("not-an-email"), false);
  assert.equal(validEmail("a@b.c"), false, "TLD needs 2+ chars");
});

test("claimSignin: a profile WITH a password keeps it — claim only adds identity", async () => {
  const { hash, salt } = await (async () => {
    const h = await profiles._internals.hashPassword("bobo");
    return { hash: h.hash, salt: h.salt };
  })();
  addProfile({ id: "p-elia", name: "elia", passwordHash: hash, passwordSalt: salt });

  assert.deepEqual(profiles.claimableFor("p-elia"), {
    suggestedUsername: "elia", hasPassword: true, name: "elia",
  });

  // no password field needed — the profile password IS the sign-in password
  const r = await profiles.claimSignin({ profileId: "p-elia", username: "Elia", email: "e@example.com" });
  assert.equal(r.ok, true);
  assert.equal(r.user.username, "elia");
  assert.equal(r.user.claimed, true);
  assert.equal(profiles.claimableFor("p-elia"), null, "no longer claimable");

  const login = await profiles.login("elia", "bobo");
  assert.equal(login.ok, true, "the EXISTING profile password signs in");
  assert.equal(login.profileId, "p-elia");
  const byMail = await profiles.login("E@Example.com", "bobo");
  assert.equal(byMail.ok, true, "email works as the identifier");
  assert.ok((await profiles.login("elia", "wrong")).error);
});

test("claimSignin: a password-less profile must set one at claim time", async () => {
  addProfile({ id: "p-dana", name: "Dana" });
  assert.equal(profiles.claimableFor("p-dana").hasPassword, false);
  const noPw = await profiles.claimSignin({ profileId: "p-dana", username: "dana" });
  assert.ok(noPw.error, "password required when the profile has none");
  const short = await profiles.claimSignin({ profileId: "p-dana", username: "dana", password: "abc" });
  assert.ok(short.error, "4+ chars");
  const ok = await profiles.claimSignin({ profileId: "p-dana", username: "dana", password: "mypassword1" });
  assert.equal(ok.ok, true);
  assert.equal((await profiles.login("dana", "mypassword1")).ok, true);
  // the same password now guards the profile at the wall too — ONE password
  assert.equal(profiles.isProtected("p-dana"), true);
});

test("a claimed profile cannot be re-claimed; taken identifiers are refused", async () => {
  const again = await profiles.claimSignin({ profileId: "p-elia", username: "thief", password: "hijack99" });
  assert.ok(again.error);
  assert.equal(again.claimed, true, "flagged for the 409");

  addProfile({ id: "p-x", name: "Xander" });
  const dupeU = await profiles.claimSignin({ profileId: "p-x", username: "elia", password: "abcd1234" });
  assert.ok(dupeU.error, "username uniqueness");
  const dupeE = await profiles.claimSignin({ profileId: "p-x", username: "xander", email: "e@example.com", password: "abcd1234" });
  assert.ok(dupeE.error, "email uniqueness");
});

test("unclaimed and locked profiles can never log in", async () => {
  addProfile({ id: "p-ghost", name: "Ghost" }); // unclaimed, no password
  assert.ok((await profiles.login("ghost", "anything")).error);
  const h = await profiles._internals.hashPassword("lockpass1");
  addProfile({
    id: "p-locked", name: "Locky", username: "locky",
    passwordHash: h.hash, passwordSalt: h.salt, locked: true,
  });
  const r = await profiles.login("locky", "lockpass1");
  assert.ok(r.error, "right password, locked profile → refused");
});

test("signup request carries identity; approval mints a login-able profile", async () => {
  const bad = await profiles.requestProfile({ name: "Newbie", username: "x", password: "abcd1234" });
  assert.ok(bad.error, "1-char username rejected");
  const dupe = await profiles.requestProfile({ name: "Copycat", username: "elia", password: "abcd1234" });
  assert.ok(dupe.error, "existing username rejected at request time");

  const r = await profiles.requestProfile({
    name: "Newbie", realName: "Newbie", username: "Newbie-One", email: "new@example.com",
    password: "abcd1234", note: "hi",
  });
  assert.equal(r.ok, true);
  assert.equal(r.request.username, "newbie-one");
  assert.ok(!JSON.stringify(r.request).includes("abcd1234"), "plaintext never leaves");

  const approved = profiles.approveRequest(r.request.id);
  assert.equal(approved.hasPassword, true);
  const login = await profiles.login("new@example.com", "abcd1234");
  assert.equal(login.ok, true, "approved request can sign in immediately");
  assert.equal(profiles.isClaimed(profiles.byUsername("newbie-one")), true);
});

test("approval refuses a username claimed while the request waited", async () => {
  const r = await profiles.requestProfile({ name: "Race", username: "racer", password: "abcd1234" });
  assert.equal(r.ok, true);
  addProfile({ id: "p-sneak", name: "Sneak", username: "racer" }); // claims it meanwhile
  const out = profiles.approveRequest(r.request.id);
  assert.ok(out.error, "duplicate username must not be minted");
  assert.equal(profStore().pending.some((x) => x.id === r.request.id), true, "request stays queued");
  profiles.rejectRequest(r.request.id);
});

test("google-only signup request needs no password; sub uniqueness enforced", async () => {
  const r = await profiles.requestProfile({
    name: "Googler", googleSub: "sub-123", googleEmail: "g@example.com",
  });
  assert.equal(r.ok, true, "no password needed with a verified Google identity");
  const p = profiles.approveRequest(r.request.id);
  assert.equal(p.hasPassword, false);
  assert.equal(profiles.byGoogleSub("sub-123").name, "Googler");
  assert.equal(profiles.isClaimed(profiles.byGoogleSub("sub-123")), true);
  const again = await profiles.requestProfile({ name: "Googler2", googleSub: "sub-123" });
  assert.ok(again.error, "one Google identity, one profile");
});

test("adminSetPassword overwrites without the old one; setEmail validates", async () => {
  await profiles.adminSetPassword("p-elia", "fresh-start1");
  assert.ok((await profiles.login("elia", "bobo")).error, "old password dead");
  assert.equal((await profiles.login("elia", "fresh-start1")).ok, true);
  assert.ok(profiles.setEmail("p-elia", "junk").error);
  assert.equal(profiles.setEmail("p-elia", "elia2@example.com").ok, true);
  assert.equal((await profiles.login("elia2@example.com", "fresh-start1")).ok, true);
  // ONE email, ONE profile — a second profile can never take a used address
  assert.ok(profiles.setEmail("p-dana", "elia2@example.com").error, "email uniqueness on setEmail");
  assert.ok(profiles.setEmail("p-dana", "ELIA2@example.COM").error, "…case-insensitively");
  assert.equal(profiles.setEmail("p-elia", "elia2@example.com").ok, true, "re-setting your OWN email is fine");
});

test("signinList exposes status, never hashes", () => {
  const rows = profiles.signinList();
  assert.ok(rows.length >= 2);
  const elia = rows.find((r) => r.username === "elia");
  assert.equal(elia.claimed, true);
  assert.equal(elia.hasPassword, true);
  assert.ok(!JSON.stringify(rows).match(/passwordHash|passwordSalt/), "hashes never leave");
});

// ---------- auth mode (the admin rollout switch) ----------

test("authmode: settings win over config, legacy names normalize, junk falls to open", () => {
  const settings = require("../src/lib/settings");
  const authmode = require("../src/lib/authmode");
  const savedSave = settings.save;
  const savedMode = settings.data.authMode;
  settings.save = () => {};
  try {
    settings.data.authMode = "closed";
    assert.equal(authmode.get(), "closed");
    settings.data.authMode = "hybrid"; // legacy name from the first cut
    assert.equal(authmode.get(), "transition");
    settings.data.authMode = "required";
    assert.equal(authmode.get(), "closed");
    settings.data.authMode = "banana";
    assert.equal(authmode.get(), "open");
    assert.equal(authmode.set("nonsense"), false, "junk is refused");
    assert.equal(authmode.set("transition"), true);
    assert.equal(settings.data.authMode, "transition");
  } finally {
    settings.data.authMode = savedMode;
    settings.save = savedSave;
  }
});

// ---------- login rate limiter ----------

test("rate limiter opens after FAIL_MAX failures and isolates keys", () => {
  const { tooMany, recordFail, fails, FAIL_MAX } = require("../src/routes/auth")._internals;
  fails.clear();
  const key = "ip:test-suite";
  for (let i = 0; i < FAIL_MAX; i++) {
    assert.equal(tooMany(key), false, `attempt ${i + 1} still allowed`);
    recordFail(key);
  }
  assert.equal(tooMany(key), true, "locked after FAIL_MAX");
  assert.equal(tooMany("ip:innocent-bystander"), false, "other keys unaffected");
  fails.set(key, fails.get(key).map(() => Date.now() - 16 * 60 * 1000));
  assert.equal(tooMany(key), false, "window expiry unlocks");
  fails.clear();
});
