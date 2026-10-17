// The TV's goodbye for its OFFSET transcodes (media/goodbye.js, remux.release,
// torrent-transcode.release): the same "whose goodbye is it" rule as the
// website's jit goodbye (test/jit-warm.test.js) — a viewer's own goodbye
// stops the jobs it was reading, a stranger's stops nothing, and a job
// another viewer asked something of within 20 s is left alone.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const goodbye = require("../src/media/goodbye");
const remux = require("../src/media/remux");
const tt = require("../src/media/torrent-transcode");
const { viewerOf } = require("../src/lib/viewer");

const proc = () => {
  const p = { killed: false, once() {}, kill() { p.killed = true; } };
  return p;
};
const job = (viewers = {}, running = true) => ({ proc: running ? proc() : null, viewers: new Map(Object.entries(viewers)), lastAccess: Date.now() });

test("toStop: nothing for a stranger, for nobody, or for a viewer who never read it", () => {
  const now = 1e9;
  const entries = [["a", job({ "s:alice": now - 1000 })]];
  assert.deepEqual(goodbye.toStop(entries, "s:mallory", now), []);
  assert.deepEqual(goodbye.toStop(entries, null, now), []);
  assert.deepEqual(goodbye.toStop(entries, "", now), []);
  // read too long ago (VIEWER_TTL_MS): not hers any more
  assert.deepEqual(goodbye.toStop([["a", job({ "s:alice": now - goodbye.VIEWER_TTL_MS - 1 })]], "s:alice", now), []);
});

test("toStop: her own goodbye stops her running jobs — every offset of the title — but not one someone else is in", () => {
  const now = 1e9;
  const mine = job({ "s:alice": now - 500 });
  const older = job({ "s:alice": now - 90000 }); // the offset before her last seek
  const shared = job({ "s:alice": now - 500, "s:bob": now - 3000 });
  const done = job({ "s:alice": now - 500 }, false); // finished: nothing runs
  const out = goodbye.toStop([["mine", mine], ["older", older], ["shared", shared], ["done", done]], "s:alice", now);
  assert.deepEqual(out, ["mine", "older"]);
  // she is struck off every one, so a second goodbye is nobody's
  assert.equal(shared.viewers.has("s:alice"), false);
  assert.deepEqual(goodbye.toStop([["shared", shared]], "s:alice", now), []);
});

test("toStop: someone who stopped asking 20 s ago does not hold the job", () => {
  const now = 1e9;
  const j = job({ "s:alice": now - 100, "s:bob": now - goodbye.ABANDONED_MS - 1 });
  assert.deepEqual(goodbye.toStop([["x", j]], "s:alice", now), ["x"]);
});

test("toStop with no viewer at all (the server's own callers): every running job", () => {
  assert.deepEqual(goodbye.toStop([["a", job()], ["b", job({}, false)]], undefined), ["a"]);
});

test("note: remembers who asked, and when; ignores a request with no viewer", () => {
  const j = { proc: null };
  goodbye.note(j, null, 5);
  assert.equal(j.viewers, undefined);
  goodbye.note(j, "v:tv", 5);
  assert.equal(j.viewers.get("v:tv"), 5);
});

test("remux.release: the TV's goodbye stops its offset jobs of THAT file only, killing ffmpeg", () => {
  const jobs = remux._internals.jobs;
  const mtime = 1728000000000.4;
  const d = (id, ss, v = "h264") => path.join(remux.HLS_ROOT, remux.dirName(id, mtime, v, ss));
  const now = Date.now();
  const a0 = job({ "v:tv": now }), a1 = job({ "v:tv": now - 60000 }), other = job({ "v:tv": now });
  const theirs = job({ "s:bob": now });
  jobs.set(d("filmA", 0), a0);
  jobs.set(d("filmA", 600), a1);
  jobs.set(d("filmB", 0), other);
  jobs.set(d("filmC", 0), theirs);
  try {
    assert.equal(remux.release("filmA", mtime, "s:mallory", now), 0, "a stranger");
    assert.equal(a0.proc.killed, false);
    assert.equal(remux.release("filmC", mtime, "v:tv", now), 0, "a film the TV is not in");
    assert.equal(theirs.proc.killed, false);
    assert.equal(remux.release("filmA", mtime, "v:tv", now), 2);
    assert.equal(a0.proc.killed, true);
    assert.equal(a1.proc.killed, true);
    assert.equal(jobs.has(d("filmA", 0)), false);
    assert.equal(other.proc.killed, false, "another file is not touched");
  } finally {
    for (const k of [d("filmA", 0), d("filmA", 600), d("filmB", 0), d("filmC", 0)]) jobs.delete(k);
  }
});

test("remux: the routes' touch and noteViewer say whose a job is", () => {
  const jobs = remux._internals.jobs;
  const mtime = 1728000000000;
  const dir = path.join(remux.HLS_ROOT, remux.dirName("filmT", mtime, "copy", 30));
  const j = { proc: proc(), lastAccess: 0 };
  jobs.set(dir, j);
  try {
    remux.touch("filmT", mtime, "copy", 30, null, 0, "v:one");
    remux.noteViewer(dir, "v:two");
    assert.deepEqual([...j.viewers.keys()].sort(), ["v:one", "v:two"]);
    assert.ok(j.lastAccess > 0);
  } finally {
    jobs.delete(dir);
  }
});

test("torrent-transcode.release: the same rule for a torrent's transcodes; a bad hash stops nothing", () => {
  const jobs = tt._internals.jobs;
  const hash = "a".repeat(40);
  const now = Date.now();
  const k0 = tt._internals.jobDir(hash, 2, 0), k1 = tt._internals.jobDir(hash, 2, 900), k2 = tt._internals.jobDir(hash, 3, 0);
  const j0 = job({ "v:tv": now }), j1 = job({ "v:tv": now, "v:other": now - 1000 }), j2 = job({ "v:tv": now });
  jobs.set(k0, j0);
  jobs.set(k1, j1);
  jobs.set(k2, j2);
  try {
    assert.equal(tt.release("not-a-hash", 2, "v:tv", now), 0);
    assert.equal(tt.release(hash, 2, "v:nobody", now), 0);
    assert.equal(tt.release(hash, 2, "v:tv", now), 1, "only the transcode nobody else is reading");
    assert.equal(j0.proc.killed, true);
    assert.equal(j1.proc.killed, false);
    assert.equal(j2.proc.killed, false, "another file of the same torrent");
  } finally {
    for (const k of [k0, k1, k2]) jobs.delete(k);
  }
});

test("viewerOf: the TV's tag makes its player and its goodbye ONE viewer, though their user agents differ", () => {
  const req = (h, ip = "10.0.0.5") => ({ ip, headers: h });
  const exo = viewerOf(req({ "user-agent": "ExoPlayerLib/2.x", "x-aurora-viewer": "tvrun12345678" }));
  const okhttp = viewerOf(req({ "user-agent": "okhttp/4.12", "x-aurora-viewer": "tvrun12345678" }));
  assert.equal(exo, okhttp);
  assert.match(exo, /^v:/);
  // the same tag from another address is somebody else
  assert.notEqual(viewerOf(req({ "x-aurora-viewer": "tvrun12345678" }, "10.0.0.9")), exo);
  // without a tag: the browser rule, as before (user agent + address)
  assert.notEqual(viewerOf(req({ "user-agent": "A" })), viewerOf(req({ "user-agent": "B" })));
  assert.match(viewerOf(req({ "user-agent": "A" })), /^d:/);
  // a tag that is not a plain token is ignored
  assert.match(viewerOf(req({ "x-aurora-viewer": "../../../etc", "user-agent": "A" })), /^d:/);
});

// AirPlay (lib/airtoken.js) meets the goodbye: a receiver is a viewer of its
// own, named by its link — never the asker's session, never a TV's tag — and
// its link cannot carry a goodbye, so a receiver stops nobody's job, and the
// asker's goodbye leaves the job the receiver is playing.
test("an AirPlay receiver is its own viewer: not the asker, not a TV tag it sends, one per link", () => {
  const airReq = (n, headers = {}) => ({ ip: "10.0.0.9", headers, air: { viewer: n, title: "l:abc", profile: "p1" } });
  const a = viewerOf(airReq("n1"));
  assert.match(a, /^a:/);
  assert.equal(viewerOf(airReq("n1", { "x-aurora-viewer": "tvtag-12345678", "user-agent": "AppleCoreMedia" })), a, "headers do not change a receiver's identity");
  assert.notEqual(viewerOf(airReq("n2")), a, "another link is another viewer");
  assert.notEqual(viewerOf({ ip: "10.0.0.9", headers: { "x-aurora-viewer": "tvtag-12345678" } }), a);
});

test("the asker's goodbye leaves the job an AirPlay receiver is reading; the receiver has no goodbye at all", async () => {
  const now = 1e9;
  const receiver = viewerOf({ ip: "10.0.0.9", headers: {}, air: { viewer: "n1", title: "l:abc" } });
  const shared = job({ "s:alice": now - 500, [receiver]: now - 2000 });
  assert.deepEqual(goodbye.toStop([["j", shared]], "s:alice", now), [], "the receiver is in this film");
  // the link opens GET/HEAD only — a goodbye beacon through it is refused
  const airtoken = require("../src/lib/airtoken");
  const { token } = airtoken.mint({ title: "l:abc", profileId: "p1" });
  assert.equal(airtoken.allowed(airtoken.verify(token), "POST", "/stream/transcode/abc/jit/bye"), false);
  assert.equal(airtoken.allowed(airtoken.verify(token), "GET", "/stream/transcode/abc/jit/bye"), false);
  // and the middleware hands the routes no TV tag of the request's own
  const mw = airtoken.makeMiddleware({ closed: () => false, profile: (id) => ({ id }), resetDue: () => false, sessionLive: () => true });
  const req = { method: "GET", url: `/air/${token}/stream/transcode/abc/jit/index.m3u8`, headers: { "x-aurora-viewer": "tvtag-12345678" } };
  const res = { setHeader() {}, status() { return res; }, json() { throw new Error("refused"); } };
  await new Promise((next) => mw(req, res, next));
  assert.equal(req.headers["x-aurora-viewer"], undefined);
  assert.ok(req.air.viewer, "the link names its receiver");
});
