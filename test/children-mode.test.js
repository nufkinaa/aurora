// Children mode (2026-11-11, docs/children-mode.md): per ACCOUNT, one click on
// with an age (the passcode chosen the first time only), every device signed
// in to the account filtered by the same gate kids profiles had, and leaving
// only with the account's passcode — or "Forgot the passcode?" with the
// account's own password or Google sign-in, or the admin.
//
// The safety half: a child in children mode can't get out without the
// passcode by any route — other accounts' routes, cookies, headers, query
// parameters, sign-in and password changes, password reset, the old
// /api/kids/exit, the old kids switch, the plain profile update. And the
// migration keeps every former kids profile locked at its old age.
//
// Stores are in-memory fakes; the routers are the real ones, mounted in
// server.js's order; Google is a stub on lib/googleauth.js's exports.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const config = require("../src/config");
config.ADMIN_PASSWORD = "test-admin-password";
config.ADMIN_NAME = "Elia";
const ADMIN = { "X-Admin-Password": config.ADMIN_PASSWORD };

const sessions = require("../src/lib/sessions");
const profiles = require("../src/profiles");
const settings = require("../src/lib/settings");
const pwreset = require("../src/lib/pwreset");
const authlog = require("../src/lib/authlog");
const notify = require("../src/lib/notify");
sessions._internals.store.save = () => {};
sessions._internals.store.data = {};
profiles._internals.store.save = () => {};
profiles._internals.store.data = { profiles: [], state: {}, pending: [], access: {} };
pwreset._internals.store.save = () => {};
authlog._internals.store.save = () => {};
settings.save = () => {};
notify.send = () => {};

const realtime = require("../src/realtime");
const resetgate = require("../src/lib/resetgate");
const googleauth = require("../src/lib/googleauth");
const scanner = require("../src/media/scanner");
const childmode = require("../src/lib/childmode");
const authRouter = require("../src/routes/auth");
const apiRouter = require("../src/routes/api");
const profilesRouter = require("../src/routes/profiles");
const adminRouter = require("../src/routes/admin");
const { fails } = authRouter._internals;
const { undo } = require("../scripts/children-mode-undo");

// ---------- a stub Google: the device flow, one account at a time ----------
const G = { device: null, tokens: new Map() };
googleauth.ids = () => ({ tv: "tv-client", tvSecret: null, web: "web-client", webSecret: "s" });
googleauth.mockActive = () => false;
googleauth.tokenInfo = async (t) => G.tokens.get(t) || { error: "invalid_token" };
googleauth.deviceStart = async () => ({ device_code: "dc-1", user_code: "ABCD-EFGH", verification_url: "https://example.test/device", expires_in: 900, interval: 0 });
googleauth.devicePoll = async () => {
  if (!G.device) return { error: "authorization_pending" };
  const t = "idt-" + crypto.randomBytes(6).toString("hex");
  G.tokens.set(t, { ...G.device, aud: "tv-client" });
  G.device = null;
  return { id_token: t };
};

// ---------- a tiny library: one for everyone, one 12+, one 18+, one unrated ----------
const LIB = [
  { id: "m-all", title: "Cartoon", certificate: "ALL" },
  { id: "m-12", title: "Adventure", certificate: "12+" },
  { id: "m-18", title: "Horror", certificate: "18+" },
  { id: "m-nr", title: "Nobody rated it" },
];
const ids = (body) => (body && body.movies ? body.movies.map((m) => m.id) : null);

const addProfile = async (id, { username = null, password = null, googleSub = null, kids = null } = {}) => {
  const p = { id, name: id, avatar: "A", color: "#fff" };
  if (username) { p.username = username; p.claimedAt = Date.now(); }
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
const raw = (id) => profiles._internals.store.data.profiles.find((p) => p.id === id);

const boot = async () => {
  const app = express();
  app.use(express.json());
  app.use(resetgate.middleware);
  app.use(authRouter);
  app.use(apiRouter);
  app.use(profilesRouter);
  app.use(adminRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // the browser's cookie jar, when a test asks for one
  const call = (method, url, body, headers = {}, jar = null) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const cookie = jar ? Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") : "";
    const req = http.request({
      host: "127.0.0.1", port, method, path: url,
      headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    }, (res) => {
      let text = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        if (jar) {
          for (const sc of [].concat(res.headers["set-cookie"] || [])) {
            const [kv, ...attrs] = sc.split(";");
            const [k, ...v] = kv.split("=");
            if (attrs.some((a) => /max-age=0/i.test(a.trim()))) delete jar[k.trim()];
            else jar[k.trim()] = v.join("=");
          }
        }
        resolve({ status: res.statusCode, body: json, kids: res.headers["x-aurora-kids"] || null });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
  return { call, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
};
// sockets: a fake client per device, collecting what the server says to it
const sockets = [];
const socketOf = (profileId) => {
  const got = [];
  const id = "c-" + crypto.randomBytes(4).toString("hex");
  realtime.clients.set(id, { id, profileId, ws: { readyState: 1, bufferedAmount: 0, send: (m) => got.push(JSON.parse(m)) } });
  sockets.push(id);
  return got;
};
const reset = (mode) => {
  fails.clear();
  for (const id of sockets.splice(0)) realtime.clients.delete(id);
  childmode._internals.resetTokens.clear();
  sessions._internals.store.data = {};
  profiles._internals.store.data = { profiles: [], state: {}, pending: [], access: {} };
  pwreset._internals.store.data = { tokens: {}, codes: {}, requests: [] };
  authlog._internals.store.data = { events: [] };
  settings.data.authMode = mode;
  scanner.index.movies = LIB.map((m) => ({ ...m }));
  scanner.index.shows = [];
};
const withServer = (mode, fn) => async () => {
  reset(mode);
  const srv = await boot();
  try { await fn(srv); } finally { await srv.close(); reset("open"); }
};
const signIn = (id) => ({ "X-Session": sessions.create(id, { kind: "phone", via: "password" }) });

// The account "mum" (password), and a grown-up "dad" next to her.
const family = async () => {
  await addProfile("mum", { username: "mum", password: "mum-pass", googleSub: "g-mum" });
  await addProfile("dad", { username: "dad", password: "dad-pass" });
};

// ---------- turning on: one click, the passcode the first time only ----------

test("turning on: the first time asks for a passcode; after that it is ONE click (age + Turn on)", withServer("closed", async (srv) => {
  await family();
  const S = signIn("mum");
  const view = await srv.call("GET", "/api/profiles/mum/child-mode", null, S);
  assert.deepEqual([view.status, view.body.on, view.body.passcodeSet, view.body.ages], [200, false, false, [0, 7, 12, 16]]);
  assert.deepEqual(view.body.forgot, { password: true, google: true });

  const noCode = await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 7 }, S);
  assert.deepEqual([noCode.status, noCode.body.passcodeNeeded], [400, true], "first time: choose a passcode");
  for (const bad of ["12", "1234567", "12a4", 1234]) {
    assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 7, newPasscode: bad }, S)).status, 400, String(bad));
  }
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 9, newPasscode: "2468" }, S)).status, 400, "only the ages on offer");
  const on = await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 7, newPasscode: "2468" }, S);
  assert.equal(on.status, 200);
  assert.deepEqual([on.body.childMode.on, on.body.childMode.maxAge, on.body.childMode.passcodeSet], [true, 7, true]);
  assert.deepEqual(on.body.profile.kids, { maxAge: 7 }, "older apps see their kids profile");
  assert.equal(on.body.profile.childMode.maxAge, 7);
  assert.ok(!JSON.stringify(on.body).includes(raw("mum").childPass.hash), "the passcode's hash never leaves the server");

  // off with the passcode, then on again: no passcode asked, no newPasscode needed
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode/off", { passcode: "2468" }, S)).status, 200);
  assert.equal(profiles.kidsOf("mum"), null);
  assert.equal(raw("mum").childPass.hash.length > 0, true, "the passcode is remembered on the account");
  const again = await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 12 }, S);
  assert.deepEqual([again.status, again.body.childMode.maxAge], [200, 12], "one click the second time");
}));

test("while on: lowering the age is free; raising it takes the passcode", withServer("closed", async (srv) => {
  await family();
  const S = signIn("mum");
  await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 12, newPasscode: "2468" }, S);
  const since = raw("mum").childMode.since;
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 7 }, S)).status, 200, "lower: free");
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 0 }, S)).status, 200, "lower again: free");
  const up = await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 16 }, S);
  assert.deepEqual([up.status, up.body.passcodeRequired], [401, true]);
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 16, passcode: "1111" }, S)).status, 401);
  assert.deepEqual(profiles.kidsOf("mum"), { maxAge: 0 }, "nothing changed");
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 16, passcode: "2468" }, S)).status, 200);
  assert.deepEqual(profiles.kidsOf("mum"), { maxAge: 16 });
  assert.equal(raw("mum").childMode.since, since, "the same stretch of children mode");
}));

// ---------- the whole account, on every device — and only that account ----------

test("on: every device of the account is filtered (session, token, header, query, cookie) and told by socket; other accounts untouched", withServer("open", async (srv) => {
  await family();
  const phone = socketOf("mum");
  const tv = socketOf("mum");
  const dads = socketOf("dad");
  const jar = {};
  const token = (await srv.call("POST", "/api/profiles/mum/unlock", { password: "mum-pass" })).body.token;
  const on = await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 12, newPasscode: "2468" }, { "X-Profile-Token": token }, jar);
  assert.equal(on.status, 200);
  assert.ok(jar.aurora_kid, "the browser that turned it on is locked to the account");
  assert.deepEqual(phone.at(-1), { type: "child_mode", profileId: "mum", childMode: { maxAge: 12 } });
  assert.deepEqual(tv.at(-1), { type: "child_mode", profileId: "mum", childMode: { maxAge: 12 } });
  assert.equal(dads.length, 0, "another account hears nothing");

  const allowed = ["m-all", "m-12"];
  for (const [how, url, headers, cookies] of [
    ["the device lock", "/api/library", {}, jar],
    ["the X-Profile header (TV, phone app)", "/api/library", { "X-Profile": "mum" }, null],
    ["the unlock token", "/api/library", { "X-Profile-Token": token }, null],
    ["?profile=", "/api/library?profile=mum", {}, null],
  ]) {
    const r = await srv.call("GET", url, null, headers, cookies ? { ...cookies } : null);
    assert.deepEqual([r.status, ids(r.body), r.kids], [200, allowed, "12"], how);
  }
  const dad = await srv.call("GET", "/api/library", null, { "X-Profile": "dad" });
  assert.deepEqual([ids(dad.body), dad.kids], [LIB.map((m) => m.id), null], "dad's account is not filtered");

  // the AI picks, a title over the age, the recommender
  assert.deepEqual((await srv.call("GET", "/api/ai/status", null, { "X-Profile": "mum" })).body, { enabled: false });
  assert.equal((await srv.call("GET", "/api/item/m-18", null, { "X-Profile": "mum" })).status, 403);
  assert.equal((await srv.call("GET", "/api/item/m-nr", null, { "X-Profile": "mum" })).status, 403, "unrated is hidden");
  assert.equal((await srv.call("POST", "/api/ai/recommend", {}, { "X-Profile": "mum" })).status, 403);

  // off: every device told, the lists whole again
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode/off", { passcode: "2468" }, { "X-Profile-Token": token }, jar)).status, 200);
  assert.deepEqual(phone.at(-1), { type: "child_mode", profileId: "mum", childMode: null });
  assert.equal(jar.aurora_kid, undefined, "the lock cookie is taken off this browser");
  assert.deepEqual(ids((await srv.call("GET", "/api/library", null, { "X-Profile": "mum" })).body), LIB.map((m) => m.id));
}));

test("closed sign-in: the session is the person — every device signed in to the account is filtered, whatever else it says", withServer("closed", async (srv) => {
  await family();
  const S1 = signIn("mum");
  const S2 = signIn("mum");
  await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 0, newPasscode: "2468" }, S1);
  for (const [how, url, headers] of [
    ["another device of the account", "/api/library", S2],
    ["…naming dad in a header", "/api/library", { ...S2, "X-Profile": "dad" }],
    ["…naming dad in the query", "/api/library?profile=dad", S2],
  ]) {
    const r = await srv.call("GET", url, null, headers);
    assert.deepEqual([ids(r.body), r.kids], [["m-all"], "0"], how);
  }
  assert.deepEqual(ids((await srv.call("GET", "/api/library", null, signIn("dad"))).body), LIB.map((m) => m.id), "dad, signed in, is not");
}));

// ---------- no way out without the passcode ----------

test("leaving: a wrong passcode is refused and rate-limited (per device and per account)", withServer("closed", async (srv) => {
  await family();
  const S = signIn("mum");
  await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 7, newPasscode: "2468" }, S);
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode/off", {}, S)).body.passcodeRequired, true, "no passcode typed: asked, not counted");
  for (let i = 0; i < 5; i++) assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode/off", { passcode: "000" + i }, S)).status, 401);
  const limited = await srv.call("POST", "/api/profiles/mum/child-mode/off", { passcode: "2468" }, S);
  assert.equal(limited.status, 429, "even the right passcode waits once the tries are spent");
  assert.deepEqual(profiles.kidsOf("mum"), { maxAge: 7 });
  // the per-account window holds across devices/addresses too
  const keys = childmode.keysFor("10.9.9.9", "mum");
  for (let i = 0; i < 30; i++) require("../src/lib/authlimit").recordFail(keys[1][0]);
  const r = await childmode.attempt("10.9.9.9", "mum", "2468", profiles.verifyChildPass);
  assert.equal(r.status, 429, "30 wrong tries a day on the account, from anywhere, and it waits");
}));

test("no way out without the passcode: old exit, old kids switch, plain update, sign-in changes, reset, other accounts", withServer("open", async (srv) => {
  await family();
  await addProfile("kidpw", { username: "kidpw", password: "kid-pass" });
  const jar = {};
  // mum's tablet, in children mode
  const tok = (await srv.call("POST", "/api/profiles/mum/unlock", { password: "mum-pass" }, {}, jar)).body.token;
  const T = { "X-Profile-Token": tok };
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 7, newPasscode: "2468" }, T, jar)).status, 200);
  const still = async (why) => {
    assert.deepEqual(profiles.kidsOf("mum"), { maxAge: 7 }, why);
    const r = await srv.call("GET", "/api/library", null, T, { ...jar });
    assert.deepEqual(ids(r.body), ["m-all"], why + " (still filtered)");
  };

  // the old route the released apps use to leave a kids profile
  for (const body of [{}, { pin: "" }, { pin: "0000" }, { profile: "mum" }, { profile: "mum", pin: "1357" }]) {
    const r = await srv.call("POST", "/api/kids/exit", body, T, { ...jar });
    assert.ok([401, 403].includes(r.status), "kids/exit " + JSON.stringify(body) + " → " + r.status);
  }
  await still("old exit without the passcode");
  // the old kids switch, the plain update, the stored fields by name
  assert.equal((await srv.call("POST", "/api/profiles/mum/kids", { kids: null }, T, { ...jar })).status, 401);
  assert.equal((await srv.call("POST", "/api/profiles/mum/kids", { kids: { maxAge: 16 } }, T, { ...jar })).status, 401, "raising through the old switch");
  await srv.call("PUT", "/api/profiles/mum", { name: "Mum", kids: null, childMode: null, childPass: null }, T, { ...jar });
  await still("the plain profile update");
  assert.equal(raw("mum").name, "Mum", "(the update itself went through)");
  // the account's sign-in and the account itself
  for (const [m, url, body] of [
    ["POST", "/api/profiles/mum/password", { password: "new-pass-1", currentPassword: "mum-pass" }],
    ["POST", "/api/profiles/mum/email", { email: "x@example.test" }],
    ["POST", "/api/profiles/mum/signout-everywhere", {}],
    ["DELETE", "/api/profiles/mum", null],
  ]) assert.equal((await srv.call(m, url, body, T, { ...jar })).status, 403, url);
  await still("sign-in changes");
  // another account's routes from the locked browser: refused, even its unlock with the right password
  assert.equal((await srv.call("POST", "/api/profiles/dad/unlock", { password: "dad-pass" }, {}, { ...jar })).status, 403);
  assert.equal((await srv.call("GET", "/api/profiles/dad/state", null, { "X-Profile": "dad" }, { ...jar })).status, 403);
  assert.equal((await srv.call("POST", "/api/profiles/dad/child-mode/off", { passcode: "2468" }, {}, { ...jar })).status, 403);
  // naming a grown-up in a header or the query does not lift the browser's lock
  assert.deepEqual(ids((await srv.call("GET", "/api/library?profile=dad", null, { "X-Profile": "dad" }, { ...jar })).body), ["m-all"]);
  // a forged lock cookie for another account only restricts the forger
  assert.deepEqual(ids((await srv.call("GET", "/api/library", null, {}, { aurora_kid: "dad.1" })).body), LIB.map((m) => m.id), "dad is not limited: a cookie naming him means nothing");
  // a "left it" mark from before children mode frees nothing
  const before = encodeURIComponent(`mum.${raw("mum").childMode.since - 1000}`);
  assert.deepEqual(ids((await srv.call("GET", "/api/library", null, T, { aurora_kid_out: before })).body), ["m-all"]);
  // hopping to a less strict account in children mode takes the passcode
  await srv.call("POST", "/api/profiles/kidpw/child-mode", { maxAge: 16, newPasscode: "9999" }, { "X-Profile-Token": (await srv.call("POST", "/api/profiles/kidpw/unlock", { password: "kid-pass" })).body.token });
  assert.equal((await srv.call("POST", "/api/kids/enter", { profile: "kidpw" }, {}, { ...jar })).status, 401);
  // the forgot path with a wrong password, and Google for the wrong account
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode/forgot", { password: "nope" }, T, { ...jar })).status, 401);
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode/forgot", { googleToken: childmode.issueResetToken("dad") }, T, { ...jar })).status, 401);
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode/forgot", {}, T, { ...jar })).status, 401);
  // the admin's routes without the admin password
  assert.ok([401, 403].includes((await srv.call("POST", "/api/admin/profiles/mum/child-mode", { on: false }, T, { ...jar })).status));
  await still("everything above");
}));

test("closed sign-in: no password change, no Google link, no signing others out, no reset of the account in children mode", withServer("closed", async (srv) => {
  await family();
  const S = signIn("mum");
  await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 7, newPasscode: "2468" }, S);
  const pw = await srv.call("POST", "/api/auth/password", { newPassword: "fresh-pass-1", currentPassword: "mum-pass" }, S);
  assert.deepEqual([pw.status, pw.body.childMode], [403, true]);
  assert.equal(await profiles.checkPassword("mum", "mum-pass"), true, "the password is unchanged");
  const other = sessions.create("mum", { kind: "tv", via: "password" });
  const key = sessions.listFor("mum").find((r) => r.key !== sessions.listFor("mum").find((x) => x.current)?.key)?.key || sessions.listFor("mum")[0].key;
  assert.equal((await srv.call("DELETE", "/api/auth/sessions/" + key, null, S)).status, 403);
  assert.ok(sessions.get(other), "nobody signed out");
  assert.equal((await srv.call("POST", "/api/auth/google/link", { pollId: "x" }, S)).status, 403);
  // a self-service reset of the account in children mode gives no token (the answer can't tell)
  await srv.call("POST", "/api/auth/reset/request", { identifier: "mum" });
  assert.equal(Object.keys(pwreset._internals.store.data.tokens || {}).length, 0);
  // Google "reset" intent: refused for a limited account
  G.device = { sub: "g-mum", email: "mum@example.test", name: "Mum" };
  const start = await srv.call("POST", "/api/auth/google/start", { intent: "reset" });
  let poll;
  for (let i = 0; i < 3 && (!poll || (poll.status === 200 && poll.body.pending)); i++) poll = await srv.call("POST", "/api/auth/google/poll", { pollId: start.body.pollId });
  assert.equal(poll.status, 401, "reset by Google refused in children mode");
  assert.deepEqual(profiles.kidsOf("mum"), { maxAge: 7 });
}));

// ---------- the ways out ----------

test("forgot the passcode: the account's own password clears it and turns children mode off (next on asks for a new one)", withServer("closed", async (srv) => {
  await family();
  const S = signIn("mum");
  const sock = socketOf("mum");
  await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 7, newPasscode: "2468" }, S);
  const r = await srv.call("POST", "/api/profiles/mum/child-mode/forgot", { password: "mum-pass" }, S);
  assert.deepEqual([r.status, r.body.childMode.on, r.body.childMode.passcodeSet], [200, false, false]);
  assert.deepEqual(sock.at(-1).childMode, null, "every device told");
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 7 }, S)).body.passcodeNeeded, true);
  assert.ok(authlog._internals.store.data.events.some((e) => e.type === "child-passcode-reset" && e.via === "password"));
  assert.ok(!JSON.stringify(authlog._internals.store.data.events).includes("mum-pass"), "no secret in the log");
}));

test("forgot the passcode: a Google sign-in of THIS account (intent childmode) clears it — never another account's", withServer("closed", async (srv) => {
  await family();
  const S = signIn("mum");
  await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 7, newPasscode: "2468" }, S);
  G.device = { sub: "g-mum", email: "mum@example.test", name: "Mum" };
  const start = await srv.call("POST", "/api/auth/google/start", { intent: "childmode" }, S);
  assert.equal(start.status, 200);
  let poll;
  for (let i = 0; i < 3 && !(poll && poll.body && poll.body.childReset); i++) poll = await srv.call("POST", "/api/auth/google/poll", { pollId: start.body.pollId }, S);
  assert.equal(poll.body.childReset.profileId, "mum", "a childmode attempt is never a link, never a sign-in");
  assert.equal(poll.body.session, undefined);
  const tok = poll.body.childReset.token;
  const r = await srv.call("POST", "/api/profiles/mum/child-mode/forgot", { googleToken: tok }, S);
  assert.deepEqual([r.status, r.body.childMode.on], [200, false]);
  // single use
  await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 7, newPasscode: "1357" }, S);
  assert.equal((await srv.call("POST", "/api/profiles/mum/child-mode/forgot", { googleToken: tok }, S)).status, 401);
}));

test("the admin page: People shows children mode per account; Turn off and Clear passcode, admin only", withServer("closed", async (srv) => {
  await family();
  const S = signIn("mum");
  await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 12, newPasscode: "2468" }, S);
  const people = (await srv.call("GET", "/api/admin/people", null, ADMIN)).body.people;
  const mum = people.find((p) => p.id === "mum");
  assert.deepEqual([mum.childMode.on, mum.childMode.maxAge, mum.childMode.passcodeSet], [true, 12, true]);
  assert.deepEqual(people.find((p) => p.id === "dad").childMode.on, false);
  assert.equal((await srv.call("POST", "/api/admin/profiles/mum/child-mode", { on: false }, ADMIN)).status, 200);
  assert.equal(profiles.kidsOf("mum"), null);
  assert.equal(profiles.childPassSet("mum"), true, "Turn off keeps the passcode");
  await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 12 }, S);
  assert.equal((await srv.call("POST", "/api/admin/profiles/mum/child-mode", { clearPasscode: true }, ADMIN)).status, 200);
  assert.deepEqual([profiles.kidsOf("mum"), profiles.childPassSet("mum")], [null, false], "Clear passcode turns it off with it");
  assert.equal((await srv.call("POST", "/api/admin/profiles/dad/child-mode", { maxAge: 7 }, ADMIN)).status, 400, "the admin can't turn it on for an account with no passcode");
}));

// ---------- the apps released before children mode ----------

test("older apps: the account reads as a kids profile; their PIN screen takes the account's passcode and lifts only that device's lock", withServer("open", async (srv) => {
  await family();
  const T = { "X-Profile-Token": (await srv.call("POST", "/api/profiles/mum/unlock", { password: "mum-pass" })).body.token };
  // the old editor's switch, first time: newPin becomes the account's passcode
  const on = await srv.call("POST", "/api/profiles/mum/kids", { kids: { maxAge: 7 }, newPin: "2468" }, T);
  assert.deepEqual([on.status, on.body.profile.kids], [200, { maxAge: 7 }]);
  assert.equal(await profiles.verifyChildPass("mum", "2468"), true);
  const wall = (await srv.call("GET", "/api/profiles")).body.find((p) => p.id === "mum");
  assert.deepEqual(wall.kids, { maxAge: 7 }, "the wall badge");
  assert.equal((await srv.call("GET", "/api/kids/status?profile=mum")).body.pinSet, true, "\"a PIN is set\" for that account");
  // the old TV: enters (a lock it keeps itself), leaves with the passcode
  assert.equal((await srv.call("POST", "/api/kids/enter", { profile: "mum" })).status, 200);
  assert.equal((await srv.call("POST", "/api/kids/exit", { profile: "mum", pin: "1111" })).status, 401);
  assert.equal((await srv.call("POST", "/api/kids/exit", { profile: "mum", pin: "2468" })).status, 200);
  assert.deepEqual(profiles.kidsOf("mum"), { maxAge: 7 }, "children mode stays on for the account");
  assert.deepEqual(ids((await srv.call("GET", "/api/library", null, { "X-Profile": "mum" })).body), ["m-all"], "and the account stays filtered");
  // the old switch: off takes the passcode
  assert.equal((await srv.call("POST", "/api/profiles/mum/kids", { kids: null, pin: "2468" }, T)).status, 200);
  assert.equal(profiles.kidsOf("mum"), null);
}));

test("an account in children mode with no passcode (an old kids profile in a house without a PIN) is left only by the admin", withServer("open", async (srv) => {
  await addProfile("noa", { kids: { maxAge: 7 } });
  const r = profiles.migrateChildMode(profiles._internals.store.data, { dir: fs.mkdtempSync(path.join(os.tmpdir(), "cm-")), log: () => {} });
  assert.equal(r, 1);
  assert.deepEqual([profiles.kidsOf("noa"), profiles.childPassSet("noa")], [{ maxAge: 7 }, false]);
  assert.deepEqual((await srv.call("POST", "/api/kids/exit", { profile: "noa" })).body.noPasscode, true, "the old route no longer lets it go for free");
  assert.equal((await srv.call("POST", "/api/profiles/noa/child-mode/off", { passcode: "0000" })).status, 403);
  assert.equal((await srv.call("POST", "/api/profiles/noa/child-mode/forgot", { password: "x" })).status, 400, "no password to prove anything with");
  assert.deepEqual(profiles.kidsOf("noa"), { maxAge: 7 });
  assert.equal((await srv.call("POST", "/api/admin/profiles/noa/child-mode", { on: false }, ADMIN)).status, 200);
  assert.equal(profiles.kidsOf("noa"), null);
}));

// ---------- the migration ----------

test("migration: every kids profile becomes children mode at its old age, its passcode the household PIN; backed up, logged, once; undo restores it", async () => {
  reset("open");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-"));
  await profiles.setKidsPin("4321");
  await addProfile("small", { kids: { maxAge: 0 } });
  await addProfile("big", { kids: { maxAge: 12 } });
  await addProfile("teen", { password: "teen-pass", kids: { maxAge: 16 } });
  await addProfile("dad", { password: "dad-pass" });
  const data = profiles._internals.store.data;
  const before = JSON.stringify(data);
  const ages = { small: profiles.kidsOf("small"), big: profiles.kidsOf("big"), teen: profiles.kidsOf("teen") };
  const lines = [];
  assert.equal(profiles.migrateChildMode(data, { dir, now: 1700000000000, log: (l) => lines.push(l) }), 3);
  // the backup is the whole file as it was
  assert.equal(fs.readFileSync(path.join(dir, "profiles.pre-children-mode-1700000000000.json"), "utf8"), JSON.stringify(JSON.parse(before), null, 1));
  assert.match(lines[0], /migrated 3 kids profile\(s\) to children mode/);
  assert.ok(!lines[0].includes(data.kidsPin.hash), "no secret in the log line");
  for (const id of ["small", "big", "teen"]) {
    assert.deepEqual(profiles.kidsOf(id), ages[id], id + " keeps its age");
    assert.equal(raw(id).kids, undefined);
    assert.equal(raw(id).childMode.migrated, true);
    assert.equal(await profiles.verifyChildPass(id, "4321"), true, id + ": the household PIN's digits open it");
    assert.equal(await profiles.verifyChildPass(id, "1234"), false);
  }
  assert.equal(profiles.kidsOf("dad"), null, "a grown-up is not touched");
  assert.equal(raw("dad").childMode, undefined);
  assert.deepEqual(data.migrations.childMode.map((r) => r.profiles.map((p) => p.id)), [["small", "big", "teen"]]);
  // once: a second boot changes nothing and writes no second backup
  assert.equal(profiles.migrateChildMode(data, { dir, now: 1700000099999, log: () => {} }), 0);
  assert.equal(fs.readdirSync(dir).length, 1);
  // the household PIN is still needed (copied passcodes), so the admin can't remove it yet
  assert.equal(profiles.householdPinNeeded(), true);
  // the admin changes the PIN: the copies follow
  await profiles.setKidsPin("8642");
  assert.equal(await profiles.verifyChildPass("big", "8642"), true);
  // an account that chose its own passcode no longer leans on the PIN
  for (const id of ["small", "big", "teen"]) await profiles.setChildPass(id, "1111");
  assert.equal(profiles.householdPinNeeded(), false);
  // undo (rolling back to a server from before children mode): kids profiles again, at the age they have now
  profiles.setChildMode("big", 7);       // made stricter since: undo keeps it stricter
  profiles.setChildMode("small", null);  // a grown-up turned it off since: stays off
  const said = undo(data);
  assert.equal(said.length, 3);
  assert.deepEqual([raw("big").kids, raw("teen").kids, raw("small").kids], [{ maxAge: 7 }, { maxAge: 16 }, undefined]);
  assert.equal(raw("big").childMode, undefined);
  assert.equal(data.migrations.childMode, undefined);
  reset("open");
});

test("migration fails closed: no backup written → nothing migrated, and the old kids profiles stay exactly as strict", async () => {
  reset("open");
  await addProfile("noa", { kids: { maxAge: 7 } });
  const data = profiles._internals.store.data;
  // (a "folder" that is a file: nothing can be written in it)
  const notDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cm-")), "a-file");
  fs.writeFileSync(notDir, "x");
  const r = profiles.migrateChildMode(data, { dir: notDir, log: () => {} });
  assert.equal(r, 0);
  assert.deepEqual(raw("noa").kids, { maxAge: 7 });
  assert.deepEqual(profiles.kidsOf("noa"), { maxAge: 7 });
  reset("open");
});

test("a lock from an EARLIER stretch of children mode never pulls a device back in; a migrated kids profile's locks stand", withServer("open", async (srv) => {
  await family();
  const token = (await srv.call("POST", "/api/profiles/mum/unlock", { password: "mum-pass" })).body.token;
  const T = { "X-Profile-Token": token };
  // the living-room browser was on mum's account during children mode last week…
  const jar = {};
  await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 7, newPasscode: "2468" }, T, jar);
  const stale = { ...jar };
  assert.ok(stale.aurora_kid);
  // …mum left it from her phone (this browser kept its cookie: it missed the word), and the browser is dad's now
  await srv.call("POST", "/api/profiles/mum/child-mode/off", { passcode: "2468" }, T);
  await new Promise((r) => setTimeout(r, 5));
  // mum turns it on again today, from her phone
  await srv.call("POST", "/api/profiles/mum/child-mode", { maxAge: 7 }, T);
  const dad = await srv.call("GET", "/api/library", null, { "X-Profile": "dad" }, { ...stale });
  assert.deepEqual([ids(dad.body), dad.kids], [LIB.map((m) => m.id), null], "dad's browser is not pulled into mum's children mode");
  const dadTok = (await srv.call("POST", "/api/profiles/dad/unlock", { password: "dad-pass" }, {}, { ...stale })).body.token;
  assert.equal((await srv.call("GET", "/api/profiles/dad/state", null, { "X-Profile-Token": dadTok }, { ...stale })).status, 200, "dad's own routes open");
  // the void lock is cleared with no passcode (the app does this when told "off")
  const clear = { ...stale };
  assert.equal((await srv.call("POST", "/api/kids/exit", {}, {}, clear)).status, 200);
  assert.equal(clear.aurora_kid, undefined);

  // a migrated kids profile: its devices' locks from before the migration stand
  await profiles.setKidsPin("4321");
  await addProfile("noa", { kids: { maxAge: 0 } });
  const oldLock = { aurora_kid: encodeURIComponent("noa.1000") };
  profiles.migrateChildMode(profiles._internals.store.data, { dir: fs.mkdtempSync(path.join(os.tmpdir(), "cm-")), log: () => {} });
  const kid = await srv.call("GET", "/api/library", null, { "X-Profile": "dad" }, oldLock);
  assert.deepEqual([ids(kid.body), kid.kids], [["m-all"], "0"], "the child's tablet stays locked through the migration");
  profiles.setChildMode("noa", 0);
  assert.deepEqual(ids((await srv.call("GET", "/api/library", null, {}, oldLock)).body), ["m-all"], "…and after an age change");
}));
