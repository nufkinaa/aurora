// At most 3 downloads running per account at once (elia 2026-10-18: "so one
// user can't download 30 movies at the same time"). Extra ones wait, never refused.
const test = require("node:test");
const assert = require("node:assert");
const { plan, PER_OWNER } = require("../src/media/dlslots");

const w = (id, owner, extra = {}) => ({ id, owner, tier: 0, yields: false, held: false, progress: 0, ...extra });
const r = (id, owner, extra = {}) => ({ id, owner, yields: false, locked: false, stalled: false, progress: 0.1, startedAt: 1, ...extra });

test("the default is 3 per account", () => assert.equal(PER_OWNER, 3));

test("one account asking for 30 gets 3 running; the free slots go to others", () => {
  const waiting = Array.from({ length: 30 }, (_, i) => w(`a${i}`, "alice")).concat([w("b0", "bob"), w("b1", "bob")]);
  const p = plan({ cap: 6, running: [], waiting });
  assert.deepEqual(p.start.filter((id) => id.startsWith("a")).length, 3);
  assert.deepEqual(p.start.filter((id) => id.startsWith("b")), ["b0", "b1"]);
  assert.equal(p.overLimit.length, 27, "the rest of alice's wait, flagged as over the account's limit");
});

test("running jobs count: an account with 3 running starts nothing more", () => {
  const p = plan({ cap: 6, running: [r("x", "alice"), r("y", "alice"), r("z", "alice")], waiting: [w("a", "alice"), w("b", "bob")] });
  assert.deepEqual(p.start, ["b"]);
  assert.deepEqual(p.overLimit, ["a"]);
});

test("My List and smart downloads count toward the same limit", () => {
  const p = plan({ cap: 6, running: [r("x", "alice", { yields: true }), r("y", "alice")], waiting: [w("a1", "alice"), w("a2", "alice")] });
  assert.deepEqual(p.start, ["a1"]);
});

test("no owner (admin Start now) is not limited; perOwner 0 switches the limit off", () => {
  const p = plan({ cap: 6, running: [r("x", "alice"), r("y", "alice"), r("z", "alice")], waiting: [w("adm", null)] });
  assert.deepEqual(p.start, ["adm"]);
  const off = plan({ cap: 6, running: [], waiting: Array.from({ length: 5 }, (_, i) => w(`a${i}`, "alice")), perOwner: 0 });
  assert.equal(off.start.length, 5);
});

test("an over-limit job does not count as a download that needs the queue (My List, 'slots' mode)", () => {
  // (in the default "always" mode a My List job waits while ANY download runs — that rule is unchanged)
  const p = plan({ cap: 6, mode: "slots", running: [r("x", "alice"), r("y", "alice"), r("z", "alice")], waiting: [w("a", "alice"), w("m", "bob", { yields: true, tier: 2 })] });
  assert.equal(p.blocked, false);
  assert.deepEqual(p.start, ["m"]);
});
