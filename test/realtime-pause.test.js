// A paused or stopped player has the progress journal written at once
// (src/realtime.js -> profiles.noteStop -> lib/watchjournal.js), not at its
// 30 s cadence: the players go on reporting "Watching" every 5 s while
// paused, with the position standing still; a stop is "Browsing" or a socket
// that goes away while watching.
const test = require("node:test");
const assert = require("node:assert");

const profiles = require("../src/profiles");
const realtime = require("../src/realtime");
const js = require("../src/lib/jsonstore");

test("a report whose position stands still is a pause; moving on is not; Browsing is a stop", () => {
  const told = [];
  const real = profiles.noteStop;
  profiles.noteStop = (pid) => told.push(pid);
  const { handleMessage } = realtime._internals;
  const ws = { authed: true, profileId: "pid-a", send() {}, readyState: 1 };
  const client = { id: "rt-pause-1", ip: "10.9.9.9", device: { device: "TV" }, profile: "Ann", profileId: "pid-a", activity: "Browsing", ws };
  try {
    const watch = (position) => handleMessage(client, { type: "activity", action: "Watching", details: "A film", position, duration: 7200 }, ws);
    watch(100);
    watch(105);
    watch(110);
    assert.deepEqual(told, [], "steady playback tells nothing");
    watch(110); // paused
    assert.deepEqual(told, ["pid-a"], "a position standing still is a pause");
    watch(110);
    assert.equal(told.length, 2, "(told again while it stays paused — the journal writes only what waits)");
    watch(115);
    assert.equal(told.length, 2, "playing again tells nothing");
    handleMessage(client, { type: "activity", action: "Browsing" }, ws);
    assert.equal(told.length, 3, "a stop is told");
    handleMessage(client, { type: "activity", action: "Watching", details: "A film", position: 115, duration: 7200 }, ws);
    assert.equal(told.length, 3, "the first report of a new watch is not a pause");
  } finally {
    profiles.noteStop = real;
    js.flushAll();
  }
});
