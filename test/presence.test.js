// Who is connected, made trustworthy (docs/watch-time.md, src/realtime.js
// "presence"): heartbeats that stop end a client; the page saying goodbye ends
// it at once; a hidden page is "away"; a server restart forgets everyone and
// the clients announce themselves again.
const test = require("node:test");
const assert = require("node:assert/strict");

const realtime = require("../src/realtime");
const telemetry = require("../src/telemetry");
const js = require("../src/lib/jsonstore");

const { handleMessage, missedBeats, beatDeadlineMs } = realtime._internals;
test.after(() => { for (const id of [...realtime.clients.keys()]) if (id.startsWith("pr-")) realtime.clients.delete(id); telemetry.sessions.data.length = 0; js.flushAll(); });

let n = 0;
const add = (extra = {}) => {
  const ws = { authed: true, profileId: null, readyState: 1, sent: [], send(m) { this.sent.push(m); }, closed: null, terminated: false,
    close(code) { this.closed = code; }, terminate() { this.terminated = true; } };
  const c = { id: `pr-${++n}`, ip: "10.2.2.2", device: { device: "Desktop" }, profile: null, activity: "Browsing", connectedAt: new Date().toISOString(), lastSeen: new Date().toISOString(), lastMsgAt: Date.now(), ws, ...extra };
  realtime.clients.set(c.id, c);
  return c;
};
const say = (c, msg, at = Date.now()) => { c.lastMsgAt = at; handleMessage(c, msg, c.ws); };

test("a client that promised a heartbeat and went quiet is ended after 2.5 beats; one that keeps beating is not", () => {
  const now = Date.now();
  const quiet = add();
  const beating = add();
  say(quiet, { type: "hello", profile: "Ann", hb: 60 }, now);
  say(beating, { type: "hello", profile: "Bob", hb: 60 }, now);
  assert.equal(beatDeadlineMs(quiet), 150000);
  assert.equal(missedBeats(now + 140000), 0, "inside the window: nobody");
  say(beating, { type: "presence", visible: true }, now + 120000);
  assert.equal(missedBeats(now + 151000), 1);
  assert.equal(quiet.ws.terminated, true, "the quiet one is ended (its close handler does the rest)");
  assert.equal(quiet.goneWhy, "missed heartbeats");
  assert.equal(beating.ws.terminated, false);
});

test("an old client (no heartbeat promised) is held to the socket ping only, never ended for silence", () => {
  const old = add();
  say(old, { type: "hello", profile: "Ann" }, Date.now() - 3600 * 1000);
  assert.equal(beatDeadlineMs(old), null);
  missedBeats(Date.now());
  assert.equal(old.ws.terminated, false);
});

test("a heartbeat promise is held between 30 s and 5 min", () => {
  const a = add(); const b = add();
  say(a, { type: "hello", profile: "A", hb: 1 });
  say(b, { type: "hello", profile: "B", hb: 99999 });
  assert.equal(a.hb, 30);
  assert.equal(b.hb, 300);
});

test("what a screen is doing: watching, paused, browsing, away, profile wall", () => {
  const c = add();
  assert.equal(realtime.presenceOf(c), "wall", "no profile yet: the profile wall");
  say(c, { type: "hello", profile: "Ann", hb: 60, app: "tv", build: "Aurora TV 5.8.4" });
  assert.equal(realtime.presenceOf(c), "browsing");
  assert.equal(c.app, "tv");
  say(c, { type: "presence", visible: false });
  assert.equal(realtime.presenceOf(c), "away");
  say(c, { type: "presence", visible: true });
  say(c, { type: "activity", action: "Watching", details: "A film", position: 10, duration: 100, played: 0, state: "playing" });
  assert.equal(realtime.presenceOf(c), "watching");
  say(c, { type: "activity", action: "Watching", details: "A film", position: 10, duration: 100, played: 0, state: "paused" });
  assert.equal(realtime.presenceOf(c), "paused");
  const pub = realtime.publicClient(c);
  assert.equal(pub.presence, "paused");
  assert.equal(pub.playState, "paused");
  assert.equal(pub.hb, 60);
  say(c, { type: "activity", action: "Browsing" });
  assert.equal(realtime.presenceOf(c), "browsing");
});

test("the page says goodbye (sendBeacon → bye): its viewing ends and its socket closes now", () => {
  const c = add();
  say(c, { type: "hello", profile: "Ann", hb: 60 });
  say(c, { type: "activity", action: "Watching", details: "Bye film", position: 0, duration: 100, played: 0, state: "playing" });
  const s = telemetry.liveSessionOf(c.id);
  assert.ok(s && s.live);
  assert.equal(realtime.bye(c.id), true);
  assert.equal(s.live, false);
  assert.equal(s.endReason, "left");
  assert.equal(c.ws.closed, 1001);
  assert.equal(realtime.bye("nobody-here"), false);
});

test("the admins hear of a change of what is shown at once, and of the 5-second position reports at most every 20 s", () => {
  const c = add();
  say(c, { type: "hello", profile: "Ann", hb: 60 });
  // (broadcastAdmins stamps adminToldAt on the client each time it is told)
  say(c, { type: "activity", action: "Watching", details: "Tick film", position: 0, duration: 100, played: 0, state: "playing" });
  const first = c.adminToldAt;
  assert.ok(first);
  c.adminToldAt = first - 1000; // a second ago
  say(c, { type: "activity", action: "Watching", details: "Tick film", position: 5, duration: 100, played: 5, state: "playing" });
  assert.equal(c.adminToldAt, first - 1000, "same title, same state, a second later: not told again");
  say(c, { type: "activity", action: "Watching", details: "Tick film", position: 5, duration: 100, played: 0, state: "paused" });
  assert.ok(c.adminToldAt >= first, "paused: told at once");
  c.adminToldAt = Date.now() - realtime._internals.ADMIN_EVERY_MS - 1;
  const stale = c.adminToldAt;
  say(c, { type: "activity", action: "Watching", details: "Tick film", position: 5, duration: 100, played: 0, state: "paused" });
  assert.ok(c.adminToldAt > stale, "and every 20 s regardless");
});

test("a server restart: nobody is remembered; a live session is closed where it last played; the clients' re-announce opens a new one", () => {
  // the restart itself is in test/telemetry-boot.test.js (closed at lastPlayAt);
  // here: the reconnecting client's hello + its remembered activity (the TV
  // sends both on every open, realtime.ts hello()) starts a fresh, honest session
  const c = add();
  say(c, { type: "hello", profile: "Ann", hb: 60, app: "tv" });
  say(c, { type: "activity", action: "Watching", details: "After restart", position: 1200, duration: 2400, played: 0, state: "playing" });
  const s = telemetry.liveSessionOf(c.id);
  assert.equal(s.watchedSec, 0, "nothing is assumed about the time the server was away");
  assert.equal(s.position, 1200);
});
