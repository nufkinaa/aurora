// The admin's Activity answer (src/lib/activity.js): pure, from fixture data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { build, splitLabel } = require("../src/lib/activity");

const NOW = new Date(2026, 10, 4, 21, 0, 0).getTime(); // 21:00 local
const iso = (ms) => new Date(ms).toISOString();
const H = 3600 * 1000;
const client = (id, o = {}) => ({ id, ip: "10.0.0.5", device: { device: "TV", browser: "Aurora TV 5.8.4", os: "Xiaomi MiTV" }, profile: "Ann", activity: "Browsing", presence: "browsing", connectedAt: iso(NOW - H), lastSeen: iso(NOW - 2000), ...o });
const sess = (o) => ({ id: Math.random().toString(16).slice(2, 14), profile: "Ann", content: "A film", startedAt: iso(NOW - 2 * H), endedAt: iso(NOW - H), watchedSec: 1800, live: false, ...o });

test("episode labels split into show and episode", () => {
  assert.deepEqual(splitLabel("Only Murders in the Building S2E10"), { title: "Only Murders in the Building", episode: "S2 E10" });
  assert.deepEqual(splitLabel("Arrival"), { title: "Arrival", episode: null });
});

test("now, screens, counts, today, week and recent from one set of fixtures", () => {
  const clients = [
    client("a", { activity: "Watching", details: "Silo S3E1", presence: "watching", playState: "playing", position: 600, mediaDuration: 2700, session: { startedAt: iso(NOW - 20 * 60000), watchedSec: 1180, state: "playing" } }),
    client("b", { profile: "Kim", device: { device: "Mobile", browser: "Chrome", os: "Android" }, activity: "Watching", details: "Arrival", presence: "paused", playState: "paused", position: 3000, mediaDuration: 6983, session: { startedAt: iso(NOW - 90 * 60000), watchedSec: 2900, state: "paused" } }),
    // two tabs of one browser, same person: one row
    client("c", { profile: "Bob", device: { device: "Desktop", browser: "Chrome", os: "Windows" }, presence: "browsing" }),
    client("d", { profile: "Bob", device: { device: "Desktop", browser: "Chrome", os: "Windows" }, presence: "away", visible: false }),
    client("e", { profile: null, presence: "wall", device: { device: "TV", browser: "Aurora TV 5.8.4", os: "Living room" } }),
    client("f", { profile: "Zed", device: { device: "Desktop", browser: "Edge", os: "Windows" }, presence: "away" }),
  ];
  const sessions = [
    sess({ content: "Silo S3E1", startedAt: iso(NOW - 20 * 60000), endedAt: null, watchedSec: 1180, live: true, state: "playing" }),
    sess({ profile: "Kim", content: "Arrival", startedAt: iso(NOW - 90 * 60000), endedAt: null, watchedSec: 2900, live: true, state: "paused" }),
    sess({ content: "Silo S3E0", startedAt: iso(NOW - 3 * H), watchedSec: 2400 }),
    sess({ content: "opened, never played", startedAt: iso(NOW - 4 * H), watchedSec: 2 }),
    sess({ profile: "Kim", content: "Arrival", startedAt: iso(NOW - 26 * H), watchedSec: 1200 }), // yesterday
    sess({ content: "Old film", startedAt: iso(NOW - 9 * 24 * H), watchedSec: 7000 }), // over a week ago
  ];
  const a = build({ now: NOW, clients, sessions });

  assert.deepEqual(a.now.map((r) => [r.profile, r.title, r.episode, r.state]), [["Ann", "Silo", "S3 E1", "playing"], ["Kim", "Arrival", null, "paused"]]);
  assert.equal(a.now[0].sittingSec, 1180);
  assert.equal(a.now[0].duration, 2700);
  assert.deepEqual(a.counts, { watching: 1, paused: 1, screens: 4, away: 1 });
  const bob = a.screens.find((g) => g.profile === "Bob");
  assert.equal(bob.tabs, 2);
  assert.equal(bob.presence, "browsing", "the liveliest of its tabs");
  assert.deepEqual(a.screens.map((g) => g.presence), ["watching", "paused", "browsing", "wall", "away"]);

  assert.equal(a.today.watchSec, 1180 + 2900 + 2400, "today: since local midnight, never-played opens left out");
  assert.equal(a.today.plays, 3);
  assert.deepEqual(a.today.people.map((p) => [p.name, p.watchSec]), [["Ann", 3580], ["Kim", 2900]]);
  assert.equal(a.week.watchSec, 1180 + 2900 + 2400 + 1200);
  assert.equal(a.week.titles.find((t) => t.content === "Arrival").watchSec, 4100);
  assert.deepEqual(a.week.titles.find((t) => t.content === "Arrival").viewers, ["Kim"]);
  assert.equal(a.recent.length, 5, "the never-played one is not a play");
  assert.equal(a.recent[0].live, true);
});
