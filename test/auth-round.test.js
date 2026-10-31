// The sign-in round (auth-round, 2026-10-31; docs/auth-round.md):
//   - Google on the phone app: app-start → Google → web-callback → a one-time
//     hand-off code through aurora-phone:// → app-finish with the verifier
//     (single use, short-lived, bound to the challenge: a code caught by
//     another app is worth nothing);
//   - where the phone may use that flow (server-info googleApp);
//   - the test stand-in for Google can never be on in production;
//   - a password is required for every sign-up, Google too;
//   - self-service reset: Google, the admin (request → approve → the waiting
//     device continues; a code), a signed-in device, email (off), with rate
//     limits, no enumeration, single-use hashed secrets and an audit log
//     that holds no secret.
// Stores are in-memory fakes (as in auth.test.js); Google is a stub set on
// lib/googleauth.js's exports (the stand-in itself only runs on a private
// test instance — test/ui/signin-round.test.js drives that one).
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const net = require("net");
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
// never a real alert: every send is caught here
const alerts = [];
notify.send = (title, message) => { alerts.push({ title, message }); };

const realtime = require("../src/realtime");
const resetgate = require("../src/lib/resetgate");
const googleauth = require("../src/lib/googleauth");
const googlemock = require("../src/lib/googlemock");
const authRouter = require("../src/routes/auth");
const apiRouter = require("../src/routes/api");
const adminRouter = require("../src/routes/admin");
const { fails, googleAppFor, handoffs } = authRouter._internals;

// ---------- a stub Google (on the exports routes/auth.js calls) ----------
const G = { accounts: new Map(), codes: new Map(), tokens: new Map(), device: null };
googleauth.ids = () => ({ tv: "tv-client", tvSecret: null, web: "web-client", webSecret: "s" });
googleauth.mockActive = () => false;
googleauth.authUrl = ({ redirectUri, state }) => `https://accounts.example.test/auth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
googleauth.exchangeCode = async (code, redirectUri) => {
  const c = G.codes.get(code);
  G.codes.delete(code);
  if (!c || c.redirectUri !== redirectUri) return { error: "invalid_grant" };
  const t = "idt-" + crypto.randomBytes(6).toString("hex");
  G.tokens.set(t, { ...c.account, aud: "web-client" });
  return { id_token: t };
};
googleauth.tokenInfo = async (t) => G.tokens.get(t) || { error: "invalid_token" };
googleauth.deviceStart = async () => ({ device_code: "dc-1", user_code: "ABCD-EFGH", verification_url: "https://example.test/device", expires_in: 900, interval: 0 });
googleauth.devicePoll = async () => {
  if (!G.device) return { error: "authorization_pending" };
  const t = "idt-" + crypto.randomBytes(6).toString("hex");
  G.tokens.set(t, { ...G.device, aud: "tv-client" });
  G.device = null;
  return { id_token: t };
};
// "the person picks this Google account" for a web/app attempt: what Google's
// page would do — a code to the redirect URI with the state
const googleSays = (authLocation, account) => {
  const u = new URL(authLocation);
  const code = "gc-" + crypto.randomBytes(6).toString("hex");
  G.codes.set(code, { account, redirectUri: u.searchParams.get("redirect_uri") });
  return `/api/auth/google/web-callback?code=${code}&state=${u.searchParams.get("state")}`;
};

const addProfile = async (id, { username = null, email = null, password = null, googleSub = null, kids = null, locked = false } = {}) => {
  const p = { id, name: id, avatar: "A", color: "#fff" };
  if (username) { p.username = username; p.claimedAt = Date.now(); }
  if (email) p.email = email;
  if (googleSub) p.googleSub = googleSub;
  if (kids) p.kids = kids;
  if (locked) p.locked = true;
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
  app.use(resetgate.middleware);
  app.use(authRouter);
  app.use(apiRouter);
  app.use(adminRouter);
  app.get("/api/library", (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // (http.request, not fetch: a test has to choose the Host header)
  const port = server.address().port;
  const call = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port, method, path: url,
      headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let text = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: json, location: res.headers.location || null, headers: { get: (k) => res.headers[k.toLowerCase()] } });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
  return { call, base, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
};
const reset = () => {
  fails.clear();
  handoffs.clear();
  realtime.clients.clear();
  sessions._internals.store.data = {};
  profiles._internals.store.data = { profiles: [], state: {}, pending: [], access: {} };
  pwreset._internals.store.data = { tokens: {}, codes: {}, requests: [] };
  authlog._internals.store.data = { events: [] };
  alerts.length = 0;
  settings.data.authMode = "closed";
};
const withServer = async (fn) => {
  reset();
  const srv = await boot();
  try { await fn(srv); } finally { await srv.close(); reset(); }
};
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
};
// One whole phone round: app-start → Google (the account) → callback → the app's code.
const phoneRound = async (srv, account, intent = "signin", host = "nufurora.test") => {
  const { verifier, challenge } = pkce();
  const start = await srv.call("GET", `/api/auth/google/app-start?intent=${intent}&challenge=${challenge}`, null, { Host: host });
  assert.equal(start.status, 302, "app-start sends the tab to Google");
  const back = await srv.call("GET", googleSays(start.location, account), null, { Host: host });
  assert.equal(back.status, 302);
  assert.match(back.location, /^aurora-phone:\/\/auth\/google\?code=[A-Za-z0-9_-]{43}$/, "the tab is handed back to the app with a one-time code");
  const code = decodeURIComponent(back.location.split("code=")[1]);
  return { code, verifier };
};
const ANA = { sub: "g-ana", email: "ana@example.test", name: "Ana" };

// ---------- where the phone's Custom Tab flow may run ----------

test("googleApp: an IP address without the stand-in → no (the phone uses the code flow)", () => {
  assert.equal(googleAppFor({ host: "10.0.0.1:4000", mock: false, webId: "w" }), false);
  assert.equal(googleAppFor({ host: "127.0.0.1:4000", mock: false, webId: "w" }), false);
  assert.equal(googleAppFor({ host: "[::1]:4000", mock: false, webId: "w" }), false);
  assert.equal(googleAppFor({ host: "localhost:4000", mock: false, webId: "w" }), false, "a phone's localhost is not this server");
});
test("googleApp: an IP address on a private test instance with the stand-in → yes", () => {
  assert.equal(googleAppFor({ host: "127.0.0.1:4000", mock: true, webId: "w" }), true);
});
test("googleApp: a real domain → yes; no web client → never", () => {
  assert.equal(googleAppFor({ host: "nufurora.com", mock: false, webId: "w" }), true);
  assert.equal(googleAppFor({ host: "nufurora.com", mock: false, webId: null }), false);
});
test("server-info says googleApp per host, and never says anything about a stand-in", async () => {
  await withServer(async (srv) => {
    const dom = (await srv.call("GET", "/api/server-info", null, { Host: "nufurora.test" })).body;
    const ip = (await srv.call("GET", "/api/server-info", null, { Host: "192.168.1.5:4000" })).body;
    assert.deepEqual([dom.googleApp, dom.googleDevice, dom.googleWeb], [true, true, true]);
    assert.deepEqual([ip.googleApp, ip.googleDevice], [false, true]);
    for (const k of Object.keys(dom)) assert.doesNotMatch(k, /mock/i, "no public mock field");
  });
});

// ---------- the stand-in for Google can never run in production ----------

test("the Google stand-in: on only when all six conditions hold; each one alone turns it off", () => {
  const good = { env: { AURORA_GOOGLE_MOCK: "1" }, entry: "ui-instance.js", ownerPidFile: true, port: 51234 };
  assert.equal(googlemock.evaluate(good), true);
  assert.equal(googlemock.evaluate({ ...good, env: {} }), false, "no switch");
  assert.equal(googlemock.evaluate({ ...good, env: { AURORA_GOOGLE_MOCK: "true" } }), false, "only the exact value");
  assert.equal(googlemock.evaluate({ ...good, env: { AURORA_GOOGLE_MOCK: "1", NODE_ENV: "production" } }), false, "NODE_ENV=production");
  assert.equal(googlemock.evaluate({ ...good, entry: "server.js" }), false, "the real server's entry");
  assert.equal(googlemock.evaluate({ ...good, ownerPidFile: false }), false, "not a private copy");
  assert.equal(googlemock.evaluate({ ...good, port: 4000 }), false, "the household port");
  for (const k of ["GOOGLE_WEB_CLIENT_SECRET", "GOOGLE_TV_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"]) {
    assert.equal(googlemock.evaluate({ ...good, env: { AURORA_GOOGLE_MOCK: "1", [k]: "real" } }), false, `${k} present`);
  }
});
test("the Google stand-in refused on production: the live tree (server.js, port 4000, no .owner-pid) can never pass, even with the switch set", () => {
  const live = { env: { AURORA_GOOGLE_MOCK: "1" }, entry: "server.js", ownerPidFile: false, port: 4000 };
  assert.equal(googlemock.evaluate(live), false);
  // and in THIS process (a test run, not a private instance) it is off too
  const before = process.env.AURORA_GOOGLE_MOCK;
  process.env.AURORA_GOOGLE_MOCK = "1";
  try {
    const fresh = require.resolve("../src/lib/googlemock");
    delete require.cache[fresh];
    assert.equal(require("../src/lib/googlemock").active(), false, "not ui-instance.js, no .owner-pid");
  } finally {
    if (before === undefined) delete process.env.AURORA_GOOGLE_MOCK; else process.env.AURORA_GOOGLE_MOCK = before;
  }
});

// ---------- Google on the phone ----------

test("phone: a linked profile signs in through the hand-off; the code works once", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ana", { username: "ana", password: "ana-pass", googleSub: "g-ana" });
    const { code, verifier } = await phoneRound(srv, ANA);
    const r = await srv.call("POST", "/api/auth/google/app-finish", { code, verifier }, { "X-Aurora-App": "phone" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.session && r.body.profileToken && r.body.user && r.body.profile);
    assert.equal(r.body.mustReset, false);
    assert.equal((await srv.call("GET", "/api/library", null, { "X-Session": r.body.session })).status, 200);
    const again = await srv.call("POST", "/api/auth/google/app-finish", { code, verifier });
    assert.deepEqual([again.status, again.body.code], [410, "used"], "a code is single use");
    // the hand-off code is kept only as its sha256
    assert.equal(JSON.stringify([...handoffs.keys()]).includes(code), false);
  });
});

test("phone: a code finished with another device's verifier is refused, and burnt", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ana", { username: "ana", password: "ana-pass", googleSub: "g-ana" });
    const { code, verifier } = await phoneRound(srv, ANA);
    const thief = await srv.call("POST", "/api/auth/google/app-finish", { code, verifier: pkce().verifier });
    assert.deepEqual([thief.status, thief.body.code], [400, "wrong-device"]);
    assert.equal(thief.body.session, undefined);
    const owner = await srv.call("POST", "/api/auth/google/app-finish", { code, verifier });
    assert.deepEqual([owner.status, owner.body.code], [410, "used"], "burnt on the first try, right or wrong");
  });
});

test("phone: an expired code is refused with words that say so", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ana", { username: "ana", password: "ana-pass", googleSub: "g-ana" });
    const { code, verifier } = await phoneRound(srv, ANA);
    for (const h of handoffs.values()) h.expiresAt = Date.now() - 1;
    const r = await srv.call("POST", "/api/auth/google/app-finish", { code, verifier });
    assert.deepEqual([r.status, r.body.code], [410, "expired"]);
    assert.match(r.body.error, /expired/i);
    const unknown = await srv.call("POST", "/api/auth/google/app-finish", { code: "x".repeat(43), verifier });
    assert.deepEqual([unknown.status, unknown.body.code], [410, "expired"]);
  });
});

test("phone: app-start refuses a missing challenge and an IP host (no stand-in)", async () => {
  await withServer(async (srv) => {
    assert.equal((await srv.call("GET", "/api/auth/google/app-start?intent=signin", null, { Host: "nufurora.test" })).status, 400);
    assert.equal((await srv.call("GET", `/api/auth/google/app-start?challenge=${pkce().challenge}`, null, { Host: "10.0.0.1:4000" })).status, 409);
  });
});

test("phone: Google cancelled → the app is told in words; a web-finish can never collect a phone's attempt", async () => {
  await withServer(async (srv) => {
    const { verifier, challenge } = pkce();
    const start = await srv.call("GET", `/api/auth/google/app-start?challenge=${challenge}`, null, { Host: "nufurora.test" });
    const state = new URL(start.location).searchParams.get("state");
    assert.equal((await srv.call("POST", "/api/auth/google/web-finish", { state })).status, 404);
    const back = await srv.call("GET", `/api/auth/google/web-callback?error=access_denied&state=${state}`, null, { Host: "nufurora.test" });
    const code = decodeURIComponent(back.location.split("code=")[1]);
    const r = await srv.call("POST", "/api/auth/google/app-finish", { code, verifier });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /cancelled/);
  });
});

// ---------- sign-up with Google needs a password ----------

test("sign-up with Google (phone): an unknown account becomes a request, and the request needs a password", async () => {
  await withServer(async (srv) => {
    const { code, verifier } = await phoneRound(srv, ANA);
    const r = await srv.call("POST", "/api/auth/google/app-finish", { code, verifier });
    assert.equal(r.status, 200);
    assert.equal(r.body.signup.email, "ana@example.test");
    const pollId = r.body.pollId;
    const none = await srv.call("POST", "/api/auth/signup", { name: "Ana", pollId });
    assert.deepEqual([none.status, none.body.field, none.body.code], [400, "password", "short"]);
    assert.match(none.body.error, /update the Aurora app/, "an app from before the rule has no password field: the words say what to do");
    const ok = await srv.call("POST", "/api/auth/signup", { name: "Ana", pollId, password: "ana-pass-1", username: "ana" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const people = (await srv.call("GET", "/api/admin/people", null, ADMIN)).body;
    assert.equal(people.requests[0].viaGoogle, true);
    const approved = await srv.call("POST", `/api/admin/profile-requests/${people.requests[0].id}/approve`, {}, ADMIN);
    assert.equal(approved.status, 200);
    assert.equal((await profiles.login("ana", "ana-pass-1")).ok, true, "the Google profile has its own password from day one");
    assert.equal((await srv.call("POST", "/api/auth/signup", { name: "Ana2", pollId, password: "ana-pass-1" })).status, 400, "the Google step is spent");
  });
});

test("sign-up with Google (TV code flow): the same rule", async () => {
  await withServer(async (srv) => {
    const start = (await srv.call("POST", "/api/auth/google/start", { intent: "signup" })).body;
    G.device = { sub: "g-tv", email: "tv@example.test", name: "Tee" };
    let r;
    for (let i = 0; i < 5; i++) { r = await srv.call("POST", "/api/auth/google/poll", { pollId: start.pollId }); if (!r.body.pending) break; }
    assert.equal(r.body.signup.email, "tv@example.test");
    assert.equal((await srv.call("POST", "/api/auth/signup", { name: "Tee", pollId: start.pollId })).body.field, "password");
    assert.equal((await srv.call("POST", "/api/auth/signup", { name: "Tee", pollId: start.pollId, password: "tee-pass" })).status, 200);
  });
});

// ---------- reset with Google ----------

test("reset with Google: the linked profile gets a single-use token; the new password signs in, other devices are signed out", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ana", { username: "ana", password: "old-pass", googleSub: "g-ana" });
    const other = sessions.create("p-ana", { via: "password" });
    const { code, verifier } = await phoneRound(srv, ANA, "reset");
    const r = await srv.call("POST", "/api/auth/google/app-finish", { code, verifier });
    assert.equal(r.body.reset.name, "p-ana");
    const token = r.body.reset.token;
    assert.deepEqual((await srv.call("POST", "/api/auth/reset/check", { token })).body.name, "p-ana");
    const short = await srv.call("POST", "/api/auth/reset/complete", { token, newPassword: "abc" });
    assert.deepEqual([short.status, short.body.field], [400, "newPassword"]);
    const done = await srv.call("POST", "/api/auth/reset/complete", { token, newPassword: "new-pass-1" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(done.body.session && done.body.profileToken);
    assert.equal(done.body.signedOutOthers, 1);
    assert.equal(sessions.get(other), null, "the other device is signed out");
    assert.equal((await profiles.login("ana", "old-pass")).ok, undefined);
    assert.equal((await profiles.login("ana", "new-pass-1")).ok, true);
    assert.equal((await srv.call("POST", "/api/auth/reset/complete", { token, newPassword: "again-1" })).status, 410, "single use");
  });
});

test("reset with Google: 'keep me signed in elsewhere' keeps the other devices", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ana", { username: "ana", password: "old-pass", googleSub: "g-ana" });
    const other = sessions.create("p-ana", { via: "password" });
    const token = pwreset.issueToken("p-ana", "google");
    const done = await srv.call("POST", "/api/auth/reset/complete", { token, newPassword: "new-pass-1", signOutOthers: false });
    assert.equal(done.body.signedOutOthers, 0);
    assert.ok(sessions.get(other));
  });
});

test("reset with Google: an unlinked account is told so; a kids profile is not reset here", async () => {
  await withServer(async (srv) => {
    await addProfile("p-kid", { username: "kid", password: "kid-pass", googleSub: "g-kid", kids: { maxAge: 7 } });
    const a = await phoneRound(srv, { sub: "g-nobody", email: "n@example.test" }, "reset");
    const r = await srv.call("POST", "/api/auth/google/app-finish", a);
    assert.equal(r.status, 401);
    assert.match(r.body.error, /No Aurora profile is linked/);
    const k = await phoneRound(srv, { sub: "g-kid" }, "reset");
    assert.equal((await srv.call("POST", "/api/auth/google/app-finish", k)).status, 401);
  });
});

// ---------- ask the admin, and codes ----------

test("ask the admin: the same answer for a real name and an unknown one; the admin sees only the real one", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ben", { username: "ben", password: "ben-pass" });
    const real = await srv.call("POST", "/api/auth/reset/request", { identifier: "ben" });
    const fake = await srv.call("POST", "/api/auth/reset/request", { identifier: "nobody-here" });
    assert.deepEqual([real.status, Object.keys(real.body).sort()], [200, ["expiresIn", "ok", "ticket"]]);
    assert.deepEqual([fake.status, Object.keys(fake.body).sort()], [200, ["expiresIn", "ok", "ticket"]]);
    assert.deepEqual((await srv.call("POST", "/api/auth/reset/status", { ticket: real.body.ticket })).body, { status: "pending" });
    assert.deepEqual((await srv.call("POST", "/api/auth/reset/status", { ticket: fake.body.ticket })).body, { status: "pending" });
    const people = (await srv.call("GET", "/api/admin/people", null, ADMIN)).body;
    assert.deepEqual(people.resetRequests.map((r) => r.profileId), ["p-ben"]);
    assert.equal(alerts.length, 1, "the admin is alerted about the real one only (stubbed: never a real send)");
    assert.match(alerts[0].message, /p-ben asked for a password reset/);
  });
});

test("ask the admin: approve → the waiting device gets a token ONCE and the admin a code; the new password works", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ben", { username: "ben", password: "ben-pass" });
    const { ticket } = (await srv.call("POST", "/api/auth/reset/request", { identifier: "BEN " })).body;
    const id = (await srv.call("GET", "/api/admin/people", null, ADMIN)).body.resetRequests[0].id;
    const ap = await srv.call("POST", `/api/admin/reset-requests/${id}/approve`, {}, ADMIN);
    assert.match(ap.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const st = (await srv.call("POST", "/api/auth/reset/status", { ticket })).body;
    assert.equal(st.status, "approved");
    assert.equal(st.name, "p-ben");
    assert.deepEqual((await srv.call("POST", "/api/auth/reset/status", { ticket })).body, { status: "used" }, "handed over once");
    const done = await srv.call("POST", "/api/auth/reset/complete", { token: st.token, newPassword: "ben-new-1" });
    assert.equal(done.status, 200);
    assert.equal((await profiles.login("ben", "ben-new-1")).ok, true);
    // the code given beside it closed with the reset
    assert.equal((await srv.call("POST", "/api/auth/reset/code", { identifier: "ben", code: ap.body.code })).status, 400);
    assert.equal((await srv.call("POST", `/api/admin/reset-requests/${id}/approve`, {}, ADMIN)).status, 404, "answered once");
  });
});

test("ask the admin: decline → the waiting screen is told", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ben", { username: "ben", password: "ben-pass" });
    const { ticket } = (await srv.call("POST", "/api/auth/reset/request", { identifier: "ben" })).body;
    const id = (await srv.call("GET", "/api/admin/people", null, ADMIN)).body.resetRequests[0].id;
    assert.equal((await srv.call("POST", `/api/admin/reset-requests/${id}/decline`, {}, ADMIN)).status, 200);
    assert.deepEqual((await srv.call("POST", "/api/auth/reset/status", { ticket })).body, { status: "declined" });
    assert.deepEqual((await srv.call("POST", "/api/auth/reset/status", { ticket: "made-up" })).body, { status: "expired" });
  });
});

test("reset code: right once; wrong, unknown or for nobody: one answer; five wrong tries burn it", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ben", { username: "ben", email: "ben@example.test", password: "ben-pass" });
    const { code } = (await srv.call("POST", "/api/admin/profiles/p-ben/reset-code", {}, ADMIN)).body;
    const wrong = await srv.call("POST", "/api/auth/reset/code", { identifier: "ben", code: "AAAA-AAAA" });
    const nobody = await srv.call("POST", "/api/auth/reset/code", { identifier: "zed", code });
    assert.deepEqual([wrong.status, wrong.body.field], [400, "code"]);
    assert.deepEqual(nobody.body, wrong.body, "no telling a real name from a made-up one");
    const ok = await srv.call("POST", "/api/auth/reset/code", { identifier: "ben@example.test", code: code.toLowerCase().replace("-", " ") });
    assert.equal(ok.status, 200, "case, spaces and dashes don't matter; email works as the name");
    assert.ok(ok.body.token);
    assert.equal((await srv.call("POST", "/api/auth/reset/code", { identifier: "ben", code })).status, 400, "single use");
    // a fresh code, then five misses: gone
    const c2 = (await srv.call("POST", "/api/admin/profiles/p-ben/reset-code", {}, ADMIN)).body.code;
    fails.clear();
    for (let i = 0; i < 5; i++) await srv.call("POST", "/api/auth/reset/code", { identifier: "p-x" + i, profileId: "p-ben", code: "BBBB-BBBB" });
    fails.clear();
    assert.equal((await srv.call("POST", "/api/auth/reset/code", { identifier: "ben", code: c2 })).status, 400, "burnt after five wrong tries");
  });
});

test("kids and locked profiles: no self-service reset (asked like nobody); the admin is told to use Set password for a kid", async () => {
  await withServer(async (srv) => {
    await addProfile("p-kid", { username: "kid", password: "kid-pass", kids: { maxAge: 7 } });
    await addProfile("p-lock", { username: "lock", password: "lock-pass", locked: true });
    for (const identifier of ["kid", "lock"]) assert.equal((await srv.call("POST", "/api/auth/reset/request", { identifier })).status, 200);
    assert.deepEqual((await srv.call("GET", "/api/admin/people", null, ADMIN)).body.resetRequests, []);
    assert.equal((await srv.call("POST", "/api/admin/profiles/p-kid/reset-code", {}, ADMIN)).body.kidsProfile, true);
  });
});

// ---------- rate limits ----------

test("rate limits: asking for a reset, guessing a code, and signing in answer 429 with the wait", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ben", { username: "ben", password: "ben-pass" });
    let r;
    for (let i = 0; i < 6; i++) r = await srv.call("POST", "/api/auth/reset/request", { identifier: "ben" });
    assert.equal(r.status, 429);
    assert.ok(r.body.retryAfter > 0 && Number(r.headers.get("retry-after")) === r.body.retryAfter);
    assert.match(r.body.error, /^Too many tries\. Wait \d+ minutes?, then try again\.$/);
    for (let i = 0; i < 11; i++) r = await srv.call("POST", "/api/auth/reset/code", { identifier: "u" + i, code: "AAAA-AAAA" });
    assert.equal(r.status, 429);
    fails.clear();
    for (let i = 0; i < 11; i++) r = await srv.call("POST", "/api/auth/login", { username: "ben", password: "nope" });
    assert.equal(r.status, 429);
    assert.equal(r.body.code, "limited");
  });
});

// ---------- the signed-in device ----------

const sessionOf = async (id, { kind, via = "password", ageMs = 0 }) => {
  const sid = sessions.create(id, { kind, via });
  const row = sessions._internals.store.data[sessions._internals.hash(sid)];
  row.createdAt -= ageMs;
  return { "X-Session": sid };
};
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

test("signed-in device: a phone or browser signed in within 30 days changes the password without the old one (others signed out)", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ana", { username: "ana", password: "old-pass" });
    const other = sessions.create("p-ana", { kind: "tv", via: "pair" });
    for (const kind of ["phone", "web"]) {
      const S = await sessionOf("p-ana", { kind, ageMs: 5 * DAY });
      assert.deepEqual((await srv.call("GET", "/api/auth/password/options", null, S)).body, { hasPassword: true, needsCurrent: false });
    }
    const S = await sessionOf("p-ana", { kind: "phone", ageMs: 5 * DAY });
    const r = await srv.call("POST", "/api/auth/password", { newPassword: "fresh-1" }, S);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token);
    assert.equal(sessions.get(other), null, "a forgotten-password change signs the other devices out");
    assert.ok(sessions.get(S["X-Session"]), "this device stays signed in");
    assert.equal((await profiles.login("ana", "fresh-1")).ok, true);
    assert.ok(authlog.forProfile("p-ana").some((e) => e.type === "password-reset" && e.via === "signed-in device"));
  });
});

test("signed-in device: a TV, a paired TV, an old session or a kids profile must give the current password", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ana", { username: "ana", password: "old-pass" });
    await addProfile("p-kid", { username: "kid", password: "kid-pass", kids: { maxAge: 7 } });
    const cases = [
      [await sessionOf("p-ana", { kind: "tv", ageMs: HOUR }), "tv"],
      [await sessionOf("p-ana", { kind: "tv", via: "pair", ageMs: 2 * 60 * 1000 }), "tv"],
      [await sessionOf("p-ana", { kind: "web", via: "pair", ageMs: HOUR }), "paired"],
      [await sessionOf("p-ana", { kind: "web", ageMs: 40 * DAY }), "old"],
      [await sessionOf("p-kid", { kind: "phone", ageMs: 2 * 60 * 1000 }), "kids"],
    ];
    for (const [S, why] of cases) {
      assert.deepEqual((await srv.call("GET", "/api/auth/password/options", null, S)).body, { hasPassword: true, needsCurrent: true, why }, why);
      const r = await srv.call("POST", "/api/auth/password", { newPassword: "fresh-1" }, S);
      assert.deepEqual([r.status, r.body.field, r.body.why], [401, "currentPassword", why], why);
    }
    // a TV the person signed in on a minute ago, by typing the password: they are standing at it
    const now = await sessionOf("p-ana", { kind: "tv", ageMs: 60 * 1000 });
    assert.equal((await srv.call("GET", "/api/auth/password/options", null, now)).body.needsCurrent, false);
    // and with the current password, any device may change it
    const tv = cases[0][0];
    assert.equal((await srv.call("POST", "/api/auth/password", { newPassword: "fresh-1", currentPassword: "old-pass" }, tv)).status, 200);
  });
});

test("the app says what it is: X-Aurora-App on a sign-in is kept on the session", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ana", { username: "ana", password: "old-pass" });
    const tv = await srv.call("POST", "/api/auth/login", { username: "ana", password: "old-pass" }, { "X-Aurora-App": "tv" });
    const web = await srv.call("POST", "/api/auth/login", { username: "ana", password: "old-pass" }, { "User-Agent": "Mozilla/5.0 Chrome" });
    const rows = sessions._internals.store.data;
    assert.equal(rows[sessions._internals.hash(tv.body.session)].kind, "tv");
    assert.equal(rows[sessions._internals.hash(web.body.session)].kind, "web");
    assert.equal(rows[sessions._internals.hash(web.body.session)].via, "password");
  });
});

// ---------- errors name their field ----------

test("sign-in errors are sentences that name their field", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ana", { username: "ana", password: "old-pass" });
    assert.deepEqual((await srv.call("POST", "/api/auth/login", { username: "", password: "x" })).body.field, "identifier");
    assert.deepEqual((await srv.call("POST", "/api/auth/login", { username: "ana", password: "" })).body.field, "password");
    const wrong = await srv.call("POST", "/api/auth/login", { username: "ana", password: "nope" });
    const nobody = await srv.call("POST", "/api/auth/login", { username: "zed", password: "nope" });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, nobody.body, "the same words whether the name exists or not");
    assert.match(wrong.body.error, /reset your password/);
  });
});

// ---------- email: built, off ----------

test("email reset is off unless configured: 501, and the options say email:false", async () => {
  await withServer(async (srv) => {
    assert.equal((await srv.call("GET", "/api/auth/reset/options")).body.email, false);
    assert.equal((await srv.call("POST", "/api/auth/reset/email", { identifier: "ben" })).status, 501);
    const mailer = require("../src/lib/mailer");
    const miss = mailer.missing();
    assert.ok(miss.some((m) => /enabled/.test(m)) && miss.some((m) => /publicUrl/.test(m)));
  });
});

test("the SMTP sender speaks SMTP (a local fake server; nothing leaves this machine) and refuses a server without encryption", async () => {
  const mailer = require("../src/lib/mailer");
  const got = [];
  const fake = net.createServer((sock) => {
    sock.write("220 fake ESMTP\r\n");
    let data = false;
    let body = "";
    sock.on("data", (d) => {
      for (const line of String(d).split("\r\n").filter((l, i, a) => i < a.length - 1 || l)) {
        if (data) {
          if (line === ".") { data = false; got.push(body); sock.write("250 queued\r\n"); } else body += line + "\n";
          continue;
        }
        got.push(line);
        if (/^EHLO/.test(line)) sock.write("250-fake\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH/.test(line)) sock.write("235 ok\r\n");
        else if (/^(MAIL|RCPT)/.test(line)) sock.write("250 ok\r\n");
        else if (line === "DATA") { data = true; sock.write("354 go\r\n"); }
        else if (line === "QUIT") sock.end("221 bye\r\n");
      }
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const port = fake.address().port;
  try {
    const s = { from: "Aurora <no-reply@example.test>", smtp: { host: "127.0.0.1", port, user: "u" }, smtpPassword: "p" };
    const connect = () => net.connect({ host: "127.0.0.1", port });
    await assert.rejects(mailer._internals.sendSmtp(s, { to: "ben@example.test", subject: "x", text: "y" }, { connect, timeoutMs: 3000 }), /no encryption/);
    got.length = 0;
    await mailer._internals.sendSmtp(s, { to: "ben@example.test", subject: "Reset your Aurora password", text: "open https://example.test/#/reset/abc" }, { connect, insecureOk: true, timeoutMs: 3000 });
    assert.ok(got.includes("MAIL FROM:<no-reply@example.test>"));
    assert.ok(got.includes("RCPT TO:<ben@example.test>"));
    const msg = got[got.length - 1];
    assert.match(msg, /Subject: Reset your Aurora password/);
    const b64 = msg.split("\n\n")[1].replace(/\s+/g, "");
    assert.match(Buffer.from(b64, "base64").toString("utf-8"), /#\/reset\/abc/);
  } finally {
    fake.close();
  }
});

// ---------- the audit log keeps no secret ----------

test("the auth log records what happened and never a password, token, code or ticket", async () => {
  await withServer(async (srv) => {
    await addProfile("p-ben", { username: "ben", password: "ben-pass", googleSub: "g-ben" });
    const { ticket } = (await srv.call("POST", "/api/auth/reset/request", { identifier: "ben" })).body;
    const id = (await srv.call("GET", "/api/admin/people", null, ADMIN)).body.resetRequests[0].id;
    const { code } = (await srv.call("POST", `/api/admin/reset-requests/${id}/approve`, {}, ADMIN)).body;
    const { token } = (await srv.call("POST", "/api/auth/reset/status", { ticket })).body;
    await srv.call("POST", "/api/auth/reset/complete", { token, newPassword: "secret-new-pw" });
    const text = JSON.stringify(authlog._internals.store.data) + JSON.stringify(pwreset._internals.store.data);
    for (const secret of [ticket, code, code.replace("-", ""), token, "secret-new-pw", "ben-pass"]) {
      assert.equal(text.includes(secret), false, "no secret in the log or the reset store");
    }
    const types = authlog.forProfile("p-ben").map((e) => e.type);
    assert.deepEqual(types.slice(0, 3), ["password-reset", "reset-approved", "reset-asked"]);
    const people = (await srv.call("GET", "/api/admin/people", null, ADMIN)).body;
    assert.equal(people.people.find((p) => p.id === "p-ben").authLog[0].type, "password-reset");
  });
});
