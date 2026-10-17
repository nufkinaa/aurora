// AirPlay links (src/lib/airtoken.js): the signed, expiring, one-title
// address an Apple TV is handed, since it fetches the stream with no
// credential of its own. Held here: what a token may open (one title's
// stream paths, GET/HEAD only), when it stops (expiry, a tampered or foreign
// token, the asking session ended, the profile locked / owing a new password,
// the wall closed on a sessionless link), and what the request looks like to
// the routes behind it (every credential gone, req.url the stream path,
// req.air the asker). The whole server path — the wall, the kids gate, the
// receiver fetching a real playlist — is test/ui/airplay.test.js.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const express = require("express");

const airtoken = require("../src/lib/airtoken");

const LIB = "0123456789ab";
const OTHER = "ba9876543210";
const HASH = "a".repeat(40);

test("pathScope: every stream path of a title names that title, and nothing else is a stream a link may open", () => {
  const lib = [
    `/stream/video/${LIB}`,
    `/stream/hls/${LIB}/index.m3u8`,
    `/stream/hls/${LIB}/seg00003.ts`,
    `/stream/transcode/${LIB}/jit/master.m3u8`,
    `/stream/transcode/${LIB}/jit/index.m3u8`,
    `/stream/transcode/${LIB}/jit/init.mp4`,
    `/stream/transcode/${LIB}/jit/seg00012.m4s`,
    `/stream/transcode/${LIB}/jit/seg00012.ts`,
    `/stream/transcode/${LIB}/1200/index.m3u8`,
    `/stream/transcode/${LIB}/0/seg00000.ts`,
    `/stream/airplay/${LIB}/master.m3u8`,
    `/stream/airplay/${LIB}/sub/0.m3u8`,
    `/stream/airplay/${LIB}/sub/11.vtt`,
  ];
  for (const p of lib) assert.equal(airtoken.pathScope(p), `l:${LIB}`, p);
  const tor = [
    `/stream/torrent/${HASH}/2`,
    `/stream/torrent/hls/${HASH}/2/jit/index.m3u8`,
    `/stream/torrent/hls/${HASH}/2/jit/seg00001.m4s`,
    `/stream/torrent/hls/${HASH}/2/300/index.m3u8`,
  ];
  for (const p of tor) assert.equal(airtoken.pathScope(p), `t:${HASH}:2`, p);
  assert.equal(airtoken.pathScope(`/stream/torrent/${HASH.toUpperCase()}/2`), `t:${HASH}:2`, "a hash in capitals is the same torrent");
  const never = [
    `/stream/download/${LIB}`, // taking the file away is not watching it
    `/stream/download/${LIB}/sub/x`,
    `/stream/transcode/${LIB}/jit/bye`, // the goodbye beacon (a POST anyway)
    `/stream/subtitle/${LIB}`,
    `/stream/embedded/${LIB}/0`,
    `/stream/torrent/sub/${HASH}/2`,
    "/stream/websub",
    `/api/item/${LIB}`,
    `/img/still/${LIB}`,
    `/offline/file/${LIB}`,
    `/stream/transcode/${LIB}/jit/../../video/${OTHER}`,
    `/stream/transcode/${LIB}/jit/index.m3u8/`,
    `/stream/video/${LIB}/extra`,
    `/stream/airplay/${LIB}/sub/x.vtt`,
    "",
    null,
  ];
  for (const p of never) assert.equal(airtoken.pathScope(p), null, String(p));
});

test("mint / verify: a token says what it was made with; a changed, foreign or expired one is nothing", () => {
  const now = Date.now();
  const { token, expiresAt } = airtoken.mint({ title: `l:${LIB}`, profileId: "p1", sessionKey: "k".repeat(64), maxAge: 7, ttlMs: 3 * 3600 * 1000, now });
  assert.ok(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token), "URL-safe, no padding, one dot");
  assert.ok(Math.abs(expiresAt - (now + 3 * 3600 * 1000)) < 1500);
  const p = airtoken.verify(token, now);
  assert.equal(p.t, `l:${LIB}`);
  assert.equal(p.p, "p1");
  assert.equal(p.k, 7);
  assert.equal(p.s, airtoken.sessionDigest("k".repeat(64)));
  assert.ok(!JSON.stringify(p).includes("kkkk"), "the session key itself is not in the token");
  // expiry
  assert.equal(airtoken.verify(token, expiresAt + 1), null);
  assert.ok(airtoken.verify(token, expiresAt - 1000));
  // one changed character anywhere
  const [body, sig] = token.split(".");
  const flip = (s, i) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
  assert.equal(airtoken.verify(`${flip(body, 3)}.${sig}`, now), null);
  assert.equal(airtoken.verify(`${body}.${flip(sig, 3)}`, now), null);
  // a payload re-signed by anyone else (another title, no expiry) is refused
  const forged = Buffer.from(JSON.stringify({ ...p, t: `l:${OTHER}`, e: 9999999999 })).toString("base64url");
  assert.equal(airtoken.verify(`${forged}.${sig}`, now), null);
  for (const bad of ["", ".", "abc", `${body}.`, `.${sig}`, `${body}.${sig}.x`, null, 42]) assert.equal(airtoken.verify(bad, now), null, String(bad));
  // two links for the same thing are different strings
  assert.notEqual(airtoken.mint({ title: `l:${LIB}`, now }).token, airtoken.mint({ title: `l:${LIB}`, now }).token);
  assert.throws(() => airtoken.mint({ title: "l:../x" }));
  assert.throws(() => airtoken.mint({ title: `/stream/video/${LIB}` }));
});

test("ttlFor: long enough for the film and a break, never more than eight hours, never less than three", () => {
  const H = 3600 * 1000;
  assert.equal(airtoken.ttlFor(0), 3 * H);
  assert.equal(airtoken.ttlFor(45 * 60), 3 * H);
  assert.equal(airtoken.ttlFor(3 * 3600), 5 * H);
  assert.equal(airtoken.ttlFor(20 * 3600), 8 * H);
  // and mint clamps whatever it is handed
  const now = Date.now();
  assert.ok(airtoken.mint({ title: `l:${LIB}`, ttlMs: 999 * H, now }).expiresAt <= now + 8 * H + 1000);
});

test("allowed: GET and HEAD of that title's stream; not another title's, not a POST", () => {
  const p = airtoken.verify(airtoken.mint({ title: `l:${LIB}` }).token);
  assert.equal(airtoken.allowed(p, "GET", `/stream/transcode/${LIB}/jit/index.m3u8`), true);
  assert.equal(airtoken.allowed(p, "HEAD", `/stream/video/${LIB}`), true);
  assert.equal(airtoken.allowed(p, "GET", `/stream/video/${OTHER}`), false);
  assert.equal(airtoken.allowed(p, "POST", `/stream/transcode/${LIB}/jit/index.m3u8`), false);
  assert.equal(airtoken.allowed(p, "DELETE", `/stream/video/${LIB}`), false);
  assert.equal(airtoken.allowed(null, "GET", `/stream/video/${LIB}`), false);
  const t = airtoken.verify(airtoken.mint({ title: `t:${HASH}:2` }).token);
  assert.equal(airtoken.allowed(t, "GET", `/stream/torrent/${HASH}/2`), true);
  assert.equal(airtoken.allowed(t, "GET", `/stream/torrent/${HASH}/3`), false, "another file of the same torrent");
  assert.equal(airtoken.allowed(t, "GET", `/stream/torrent/${"b".repeat(40)}/2`), false);
});

// ---------- the middleware, in front of stand-in routes ----------
const world = () => ({
  closed: false,
  profiles: { p1: { id: "p1" }, locked: { id: "locked", locked: true } },
  due: new Set(),
  liveSessions: new Set(),
});
const boot = async (w) => {
  const app = express();
  app.use(airtoken.makeMiddleware({
    closed: () => w.closed,
    profile: (id) => w.profiles[id] || null,
    resetDue: (id) => w.due.has(id),
    sessionLive: (d) => w.liveSessions.has(d),
  }));
  // what the routes behind it see
  app.all(/^\/(stream|api)\//, (req, res) => res.json({
    path: req.path, query: req.query, air: req.air || null,
    cookie: req.headers.cookie || null, session: req.headers["x-session"] || null,
    token: req.headers["x-profile-token"] || null, admin: req.headers["x-admin-password"] || null,
    internal: req.headers["x-aurora-internal"] || null,
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, { method = "GET", headers = {} } = {}) => {
    const res = await fetch(base + url, { method, headers });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body, headers: res.headers };
  };
  return { call, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
};

test("middleware: a good link becomes a request for the stream — the query kept, every credential gone, the asker marked", async () => {
  const w = world();
  const s = await boot(w);
  try {
    const { token } = airtoken.mint({ title: `l:${LIB}`, profileId: "p1", maxAge: 12 });
    const r = await s.call(`/air/${token}/stream/transcode/${LIB}/jit/index.m3u8?seg=fmp4&vtag=hvc1`, {
      headers: { Cookie: "aurora_session=abc; other=1", "X-Session": "s".repeat(64), "X-Profile-Token": "tok", "X-Admin-Password": "nope", "X-Aurora-Internal": "nope" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.path, `/stream/transcode/${LIB}/jit/index.m3u8`);
    assert.deepEqual(r.body.query, { seg: "fmp4", vtag: "hvc1" });
    assert.deepEqual([r.body.cookie, r.body.session, r.body.token, r.body.admin, r.body.internal], [null, null, null, null, null]);
    assert.equal(r.body.air.profile, "p1");
    assert.equal(r.body.air.maxAge, 12);
    assert.equal(r.body.air.title, `l:${LIB}`);
    // a segment the playlist names, resolved against the playlist's address
    const seg = new URL("seg00004.m4s?v=copy&seg=fmp4", `http://x/air/${token}/stream/transcode/${LIB}/jit/index.m3u8?seg=fmp4`).pathname;
    assert.ok(seg.startsWith(`/air/${token}/`), "a relative segment address keeps the token");
    assert.equal((await s.call(seg + "?v=copy&seg=fmp4")).status, 200);
    // HEAD too (a receiver asks for the size of a file)
    assert.equal((await s.call(`/air/${token}/stream/transcode/${LIB}/jit/index.m3u8`, { method: "HEAD" })).status, 200);
    // anything else under /air is not a stream of anything
    assert.equal((await s.call(`/air/${token}`)).status, 404);
    assert.equal((await s.call(`/air//stream/video/${LIB}`)).status, 404);
  } finally {
    await s.close();
  }
});

test("middleware: refused — another title, another kind of route, a POST, a forged or expired link", async () => {
  const w = world();
  const s = await boot(w);
  try {
    const { token } = airtoken.mint({ title: `l:${LIB}`, profileId: "p1" });
    for (const p of [`/stream/video/${OTHER}`, `/stream/download/${LIB}`, `/api/item/${LIB}`, `/api/profiles/p1/state`, `/stream/subtitle/${LIB}`]) {
      const r = await s.call(`/air/${token}${p}`);
      assert.equal(r.status, 403, p);
      assert.equal(r.body.airplay, true);
    }
    // an encoded way round the scope check
    assert.equal((await s.call(`/air/${token}/stream/transcode/${LIB}/jit/%2e%2e/%2e%2e/video/${OTHER}`)).status, 403);
    assert.equal((await s.call(`/air/${token}/stream/video/${LIB}`, { method: "POST" })).status, 403);
    assert.equal((await s.call(`/air/${token.slice(0, -2)}xx/stream/video/${LIB}`)).status, 401);
    const old = airtoken.mint({ title: `l:${LIB}`, profileId: "p1", now: Date.now() - 9 * 3600 * 1000 }).token;
    const r = await s.call(`/air/${old}/stream/video/${LIB}`);
    assert.equal(r.status, 401);
    assert.match(r.body.error, /expired/);
    assert.equal(r.headers.get("cache-control"), "no-store");
  } finally {
    await s.close();
  }
});

test("middleware: a link stops with the sign-in that asked for it, with a locked or deleted profile, and while a new password is due", async () => {
  const w = world();
  const s = await boot(w);
  try {
    const key = "k".repeat(64);
    w.liveSessions.add(airtoken.sessionDigest(key));
    const { token } = airtoken.mint({ title: `l:${LIB}`, profileId: "p1", sessionKey: key });
    const url = `/air/${token}/stream/video/${LIB}`;
    assert.equal((await s.call(url)).status, 200);
    w.due.add("p1");
    let r = await s.call(url);
    assert.equal(r.status, 401);
    assert.match(r.body.error, /new password/);
    w.due.delete("p1");
    assert.equal((await s.call(url)).status, 200);
    w.liveSessions.clear(); // signed out / kicked
    r = await s.call(url);
    assert.equal(r.status, 401);
    assert.match(r.body.error, /sign-in has ended/);
    const locked = airtoken.mint({ title: `l:${LIB}`, profileId: "locked" }).token;
    assert.equal((await s.call(`/air/${locked}/stream/video/${LIB}`)).status, 401);
    const gone = airtoken.mint({ title: `l:${LIB}`, profileId: "deleted" }).token;
    assert.equal((await s.call(`/air/${gone}/stream/video/${LIB}`)).status, 401);
  } finally {
    await s.close();
  }
});

test("middleware: a link asked for while the doors were open does not open them once the wall is closed", async () => {
  const w = world();
  const s = await boot(w);
  try {
    const { token } = airtoken.mint({ title: `l:${LIB}` });
    const url = `/air/${token}/stream/video/${LIB}`;
    assert.equal((await s.call(url)).status, 200);
    w.closed = true;
    assert.equal((await s.call(url)).status, 401);
    // one made by a live session keeps working when closed
    const key = "z".repeat(64);
    w.liveSessions.add(airtoken.sessionDigest(key));
    const signed = airtoken.mint({ title: `l:${LIB}`, profileId: "p1", sessionKey: key }).token;
    assert.equal((await s.call(`/air/${signed}/stream/video/${LIB}`)).status, 200);
  } finally {
    await s.close();
  }
});

test("middleware: everything that is not /air/ passes straight through, untouched", async () => {
  const s = await boot(world());
  try {
    const r = await s.call(`/stream/video/${LIB}`, { headers: { Cookie: "aurora_session=abc" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.air, null);
    assert.equal(r.body.cookie, "aurora_session=abc");
    // (an /air-looking path deeper down is not a link)
    assert.equal((await s.call(`/stream/air/x/stream/video/${LIB}`)).body.air, null);
  } finally {
    await s.close();
  }
});

test("the AirPlay subtitle text: Apple's timestamp map goes into the header, once", () => {
  const { airVtt } = require("../src/routes/stream")._internals;
  const map = "X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000";
  assert.equal(airVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n", 10), `WEBVTT\n${map}\n\n00:00:01.000 --> 00:00:02.000\nhi\n`);
  assert.equal(airVtt("﻿WEBVTT - Title\r\n\r\n1\r\n00:00:01.000 --> 00:00:02.000\r\nhi\r\n", 10), `WEBVTT - Title\n${map}\n\n1\n00:00:01.000 --> 00:00:02.000\nhi\n`);
  const has = "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\ncue";
  assert.equal(airVtt(has, 10), has);
  assert.match(airVtt("00:00:01.000 --> 00:00:02.000\nhi", 10), /^WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000/);
});
