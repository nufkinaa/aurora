// Watch party sync math (public/js/partySync.js) against the cases the TV's
// copy (tv-native/src/partySync.ts) is tested with too.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { pathToFileURL } = require("url");
const cases = require("./fixtures/party-sync-cases.json");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "public", "js", "partySync.js")).href);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test("partySync: where the film is, when it starts, what to do about a gap", async () => {
  const s = await load();
  for (const c of cases.targetOf) near(s.targetOf(c.st, c.now), c.want, `targetOf ${JSON.stringify(c)}`);
  for (const c of cases.startsIn) near(s.startsIn(c.st, c.now), c.want, `startsIn ${JSON.stringify(c)}`);
  for (const c of cases.decide) {
    const d = s.decide(c.drift, c.o);
    assert.equal(d.act, c.act, `decide ${JSON.stringify(c)}`);
    assert.equal(d.rate, undefined, "the film's speed is never touched");
  }
  for (const c of cases.landTolerance) assert.equal(s.landTolerance(c.heavy), c.want);
});

test("partySync: the clock, buffered-ahead, ready, the waiting words", async () => {
  const s = await load();
  for (const c of cases.clock) assert.deepEqual(s.clockFrom(c.t0, c.t1, c.now), { rtt: c.rtt, offset: c.offset });
  assert.deepEqual(s.bestClock([{ rtt: 90, offset: 1 }, { rtt: 30, offset: 2 }, null, { rtt: -1, offset: 9 }]), { rtt: 30, offset: 2 });
  for (const c of cases.aheadOf) near(s.aheadOf(c.ranges, c.t), c.want, `aheadOf ${JSON.stringify(c)}`);
  for (const c of cases.readyToGo) assert.equal(s.readyToGo(c.o), c.want, `readyToGo ${JSON.stringify(c)}`);
  for (const c of cases.waitingWords) assert.equal(s.waitingWords(c.names), c.want);
});

test("partySync: the TV's copy has the same constants", async () => {
  const s = await load();
  const ts = require("fs").readFileSync(path.join(__dirname, "..", "tv-native", "src", "partySync.ts"), "utf8");
  for (const [k, v] of Object.entries(s.SYNC)) assert.match(ts, new RegExp(`(^|[^A-Za-z])${k}: ${String(v).split(".").join("[.]")},`, "m"), `SYNC.${k} = ${v} on the TV too`);
});
