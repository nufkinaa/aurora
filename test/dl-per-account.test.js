// At most 3 downloads running per account at once (elia 2026-10-18: "so one
// user can't download 30 movies at the same time"). Extra ones wait, never
// refused. And the order: a person's own request before the automatic kinds.
const test = require("node:test");
const assert = require("node:assert");
const dlslots = require("../src/media/dlslots");
const { plan, PER_OWNER } = dlslots;

const w = (id, owner, extra = {}) => ({ id, owner, tier: 0, ...extra });
const r = (id, owner, extra = {}) => ({ id, owner, ...extra });

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

test("smart downloads count toward the same limit", () => {
  const p = plan({ cap: 6, running: [r("x", "alice"), r("y", "alice")], waiting: [w("a1", "alice", { tier: dlslots.TIER_AUTO }), w("a2", "alice")] });
  assert.deepEqual(p.start, ["a2"], "her own request first, and then she is at three");
});

test("no owner is not limited; perOwner 0 switches the limit off", () => {
  const p = plan({ cap: 6, running: [r("x", "alice"), r("y", "alice"), r("z", "alice")], waiting: [w("adm", null)] });
  assert.deepEqual(p.start, ["adm"]);
  const off = plan({ cap: 6, running: [], waiting: Array.from({ length: 5 }, (_, i) => w(`a${i}`, "alice")), perOwner: 0 });
  assert.equal(off.start.length, 5);
});

test("the tiers: a person's request, then the automatic kinds — a leftover My List job is just an automatic one", () => {
  assert.equal(dlslots.tierOf({ smart: false }), dlslots.TIER_PERSON);
  assert.equal(dlslots.tierOf({ smart: true }), dlslots.TIER_AUTO, "the next episode, a followed show");
  assert.equal(dlslots.tierOf({ smart: true, auto: "mylist" }), dlslots.TIER_AUTO, "no tier of its own, no giving way");
  for (const gone of ["TIER_MYLIST", "yields", "yieldMode", "YIELD_MODES", "RESUME_QUIET_MS"]) assert.equal(dlslots[gone], undefined, gone);
});

test("the order: people first, then automatic; the queue's own order inside a kind; the cap is the cap", () => {
  const A = (id) => w(id, null, { tier: dlslots.TIER_AUTO });
  const P = (id) => w(id, null, { tier: dlslots.TIER_PERSON });
  const waiting = [A("a2"), P("p2"), A("a1"), P("p1")];
  assert.deepEqual(plan({ cap: 6, waiting }).start, ["p2", "p1", "a2", "a1"]);
  assert.deepEqual(plan({ cap: 3, waiting }).start, ["p2", "p1", "a2"]);
  assert.deepEqual(plan({ cap: 3, running: [r("x", null), r("y", null)], waiting }).start, ["p2"]);
  assert.deepEqual(plan({ cap: 2, running: [r("x", null), r("y", null)], waiting }).start, [], "a full queue starts nothing — and stops nothing");
  assert.deepEqual(Object.keys(plan({ cap: 2, waiting })).sort(), ["overLimit", "start"], "nothing is ever put on hold");
});
