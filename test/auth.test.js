// Prompt 10's foundation: sessions, accounts, and the login rate limiter.
// Both stores are swapped for in-memory fakes BEFORE any test runs — save()
// is a no-op and data is replaced — so these tests can never touch the live
// data/sessions.json or data/users.json (and jsonstore's shutdown flushAll
// skips them too: it only flushes stores with a pending save timer, which a
// no-op save() never arms).
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const sessions = require("../src/lib/sessions");
const users = require("../src/users");

sessions._internals.store.save = () => {};
sessions._internals.store.data = {};
users._internals.store.save = () => {};
users._internals.store.data = { users: [], pending: [] };

const sesStore = () => sessions._internals.store.data;

// ---------- sessions ----------

test("create() returns a 64-hex sid and stores only its sha256", () => {
  const sid = sessions.create("user1", { device: "test", ip: "1.2.3.4" });
  assert.match(sid, /^[0-9a-f]{64}$/);
  assert.equal(sesStore()[sid], undefined, "the raw sid must never be a storage key");
  const key = sessions._internals.hash(sid);
  assert.ok(sesStore()[key], "the sha256 of the sid is the storage key");
  assert.equal(sesStore()[key].userId, "user1");
  sessions.revoke(sid);
});

test("get() resolves a valid sid and rejects garbage", () => {
  const sid = sessions.create("user2");
  const row = sessions.get(sid);
  assert.equal(row.userId, "user2");
  assert.equal(sessions.get("not-a-sid"), null);
  assert.equal(sessions.get(null), null);
  assert.equal(sessions.get(crypto.randomBytes(32).toString("hex")), null, "unknown sid");
  sessions.revoke(sid);
});

test("an expired session is rejected AND deleted on sight", () => {
  const sid = sessions.create("user3");
  const key = sessions._internals.hash(sid);
  sesStore()[key].expiresAt = Date.now() - 1000;
  assert.equal(sessions.get(sid), null);
  assert.equal(sesStore()[key], undefined, "expired row is pruned by the read");
});

test("get() slides the expiry once the touch interval has passed", () => {
  const sid = sessions.create("user4");
  const key = sessions._internals.hash(sid);
  // pretend the last touch was long ago but the session is still alive
  sesStore()[key].lastSeenAt = Date.now() - 10 * 60 * 1000;
  const oldExpiry = (sesStore()[key].expiresAt -= 10 * 60 * 1000);
  sessions.get(sid);
  assert.ok(sesStore()[key].expiresAt > oldExpiry, "expiry moved forward");
  sessions.revoke(sid);
});

test("revoke works by sid and by hash key; revokeAllFor clears a user", () => {
  const a = sessions.create("user5");
  const b = sessions.create("user5");
  const c = sessions.create("someone-else");
  assert.equal(sessions.revoke(a), true, "revoke by raw sid");
  assert.equal(sessions.revoke(sessions._internals.hash(b)), true, "revoke by hash key");
  assert.equal(sessions.get(a), null);
  assert.equal(sessions.get(b), null);
  assert.ok(sessions.get(c), "other users' sessions untouched");
  const d = sessions.create("someone-else");
  assert.equal(sessions.revokeAllFor("someone-else"), 2);
  assert.equal(sessions.get(c), null);
  assert.equal(sessions.get(d), null);
});

test("listFor exposes the hash key as a handle, never a usable sid", () => {
  const sid = sessions.create("user6", { device: "TV", ip: "10.0.0.9" });
  const rows = sessions.listFor("user6");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, sessions._internals.hash(sid));
  assert.equal(rows[0].device, "TV");
  assert.ok(!Object.values(rows[0]).includes(sid), "raw sid must not appear");
  sessions.revoke(sid);
});

// ---------- users ----------

test("normUsername lowercases, strips junk, and caps length", () => {
  const { normUsername } = users._internals;
  assert.equal(normUsername("  Elia  "), "elia");
  assert.equal(normUsername("El!a@Ha <script>"), "elahascript");
  assert.equal(normUsername("a".repeat(50)).length, 24);
  assert.equal(normUsername(null), "");
});

test("requestSignup validates, stores a hash (never plaintext), and dedupes", async () => {
  const bad1 = await users.requestSignup({ username: "x", password: "goodpass" });
  assert.ok(bad1.error, "1-char username rejected");
  const bad2 = await users.requestSignup({ username: "goodname", password: "abc" });
  assert.ok(bad2.error, "short password rejected");

  const ok = await users.requestSignup({ username: "TestGuy", name: "Test Guy", password: "hunter22" });
  assert.equal(ok.ok, true);
  const pending = users._internals.store.data.pending;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].username, "testguy");
  assert.ok(pending[0].passwordHash && pending[0].passwordSalt, "hashed at request time");
  assert.ok(!JSON.stringify(pending[0]).includes("hunter22"), "plaintext never stored");

  const dupe = await users.requestSignup({ username: "testguy", password: "whatever1" });
  assert.ok(dupe.error, "pending username is already taken");

  // pendingList strips the hash material
  const listed = users.pendingList()[0];
  assert.equal(listed.passwordHash, undefined);
  assert.equal(listed.passwordSalt, undefined);
});

test("approveSignup creates a login-able account; wrong password fails", async () => {
  const req = users.pendingList()[0];
  const approved = users.approveSignup(req.id);
  assert.equal(approved.ok, true);
  assert.equal(users.pendingList().length, 0);

  const good = await users.login("TESTGUY", "hunter22"); // case-insensitive
  assert.equal(good.ok, true);
  assert.equal(good.user.username, "testguy");
  assert.ok(!("passwordHash" in good.user), "pub() shape only");

  const bad = await users.login("testguy", "hunter23");
  assert.ok(bad.error);
  const ghost = await users.login("nobody-here", "hunter22");
  assert.ok(ghost.error, "unknown user fails the same way");
});

test("rejectSignup drops the request without creating a user", async () => {
  await users.requestSignup({ username: "shortlived", password: "abcd1234" });
  const req = users.pendingList().find((r) => r.username === "shortlived");
  assert.equal(users.rejectSignup(req.id).ok, true);
  assert.equal(users.byUsername("shortlived"), null);
  assert.ok(users.rejectSignup("nope").error, "unknown id errors");
});

test("setPassword rotates credentials; ownsProfile answers the required-mode question", async () => {
  const u = users.byUsername("testguy");
  await users.setPassword(u.id, "newpass99");
  assert.ok((await users.login("testguy", "hunter22")).error, "old password dead");
  assert.equal((await users.login("testguy", "newpass99")).ok, true);

  assert.equal(users.ownsProfile(u.id, "prof-a"), false);
  u.profileIds = ["prof-a"];
  assert.equal(users.ownsProfile(u.id, "prof-a"), true);
  assert.equal(users.ownsProfile("ghost-user", "prof-a"), false);
});

test("setProfiles keeps only ids that are real profiles; removeUser removes", () => {
  const u = users.byUsername("testguy");
  // "definitely-not-a-real-profile" doesn't exist in profiles.json → filtered
  const r = users.setProfiles(u.id, ["definitely-not-a-real-profile"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.user.profileIds, []);
  assert.ok(users.setProfiles("ghost", []).error);

  assert.equal(users.removeUser(u.id).ok, true);
  assert.equal(users.byUsername("testguy"), null);
  assert.ok(users.removeUser(u.id).error, "second removal errors");
});

test("migrateFromProfiles is idempotent (second run adds nothing)", () => {
  // backup:false so the test never writes into data/backups
  const first = users.migrateFromProfiles({ backup: false });
  assert.ok(Array.isArray(first));
  const second = users.migrateFromProfiles({ backup: false });
  assert.deepEqual(second, [], "every profile already has an account");
});

test("approveSignup refuses a username that got claimed while pending", async () => {
  await users.requestSignup({ username: "collide-user", password: "abcd1234" });
  const req = users.pendingList().find((r) => r.username === "collide-user");
  // the migration (or another approval) claims the name in the meantime
  users._internals.store.data.users.push({
    id: "occupier", username: "collide-user", name: "x", profileIds: [],
  });
  const r = users.approveSignup(req.id);
  assert.ok(r.error, "duplicate username must not be minted");
  assert.equal(users.pendingList().some((x) => x.id === req.id), true, "request stays in the queue");
  users.rejectSignup(req.id);
  users.removeUser("occupier");
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

// ---------- email sign-in ----------

test("email: validation, uniqueness, and login by email", async () => {
  const { normEmail, validEmail } = users._internals;
  assert.equal(normEmail("  Bob@Example.COM "), "bob@example.com");
  assert.equal(validEmail("bob@example.com"), true);
  assert.equal(validEmail("not-an-email"), false);
  assert.equal(validEmail("a@b.c"), false, "TLD needs 2+ chars");

  const bad = await users.requestSignup({ username: "mailguy", password: "abcd1234", email: "nope" });
  assert.ok(bad.error, "junk email rejected");
  await users.requestSignup({ username: "mailguy", password: "abcd1234", email: "Mail.Guy@Example.com" });
  const req = users.pendingList().find((r) => r.username === "mailguy");
  assert.equal(req.email, "mail.guy@example.com", "stored normalized");
  users.approveSignup(req.id);

  const byMail = await users.login("MAIL.GUY@example.com", "abcd1234");
  assert.equal(byMail.ok, true, "email works as the identifier");
  assert.equal(byMail.user.username, "mailguy");
  const byName = await users.login("mailguy", "abcd1234");
  assert.equal(byName.ok, true, "username still works");

  const dupe = await users.requestSignup({ username: "othermail", password: "abcd1234", email: "mail.guy@example.com" });
  assert.ok(dupe.error, "email uniqueness enforced");
  users.removeUser(users.byUsername("mailguy").id);
});

// ---------- claiming (transition onboarding) ----------

test("claimAccount: an unclaimed migrated account becomes a real login", async () => {
  users._internals.store.data.users.push({
    id: "mig1", username: "dana", name: "Dana", profileIds: ["prof-dana"],
    passwordHash: null, passwordSalt: null, migrated: true,
  });
  assert.equal(users.unclaimedFor("prof-dana").username, "dana", "claim UI sees the seed");

  const short = await users.claimAccount({ profileId: "prof-dana", username: "dana", password: "abc" });
  assert.ok(short.error, "short password rejected");

  const r = await users.claimAccount({
    profileId: "prof-dana", username: "DanaBanana", password: "mypassword1", email: "dana@example.com",
  });
  assert.equal(r.ok, true);
  assert.equal(r.user.username, "danabanana", "username adjustable at claim time");
  assert.equal(r.user.claimed, true);
  assert.equal(users.unclaimedFor("prof-dana"), null, "no longer claimable");

  const login = await users.login("danabanana", "mypassword1");
  assert.equal(login.ok, true, "the claim IS the credential");

  const again = await users.claimAccount({ profileId: "prof-dana", username: "thief", password: "hijack99" });
  assert.ok(again.error, "a claimed account cannot be re-claimed");
  assert.equal(again.claimed, true, "flagged as already-claimed for the 409");

  const orphan = await users.claimAccount({ profileId: "no-such-profile", username: "x", password: "abcd1234" });
  assert.ok(orphan.error, "no account behind the profile");
  users.removeUser("mig1");
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
  // stale entries age out of the window
  fails.set(key, fails.get(key).map(() => Date.now() - 16 * 60 * 1000));
  assert.equal(tooMany(key), false, "window expiry unlocks");
  fails.clear();
});
