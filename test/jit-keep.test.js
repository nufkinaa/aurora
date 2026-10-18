// What an idle jit job made is kept, and only served again when it was made
// the same way (media/jit.js checkKept); the cache on disk is bounded
// (sweepDisk): garbage and stale dirs go, then the least recently used,
// never a dir a job holds.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("../src/config");
const jit = require("../src/media/jit");
const { sigOf, MADE, KEEP_MS, jobs } = jit._internals;

let tmp;
const realCache = config.CACHE_DIR;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jitkeep-"));
  config.CACHE_DIR = tmp;
  fs.mkdirSync(path.join(tmp, "jit"), { recursive: true });
});
after(() => {
  for (const d of [...jobs.keys()]) if (d.startsWith(tmp)) jit._internals.dropJob(d);
  config.CACHE_DIR = realCache;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const table = { key: "abc-1", table: [{ start: 0, dur: 6 }, { start: 6, dur: 6 }, { start: 12, dur: 6 }], durationSec: 18 };
const copyInput = { url: "film.mkv", extra: [], fmt: null, audio: 0 };
const encInput = (crf) => ({ ...copyInput, enc: { videoArgs: ["-c:v", "libx264", "-crf", String(crf)], audioRate: "192k", essential: true, cost: 1 } });
const mkDir = (name, { made = null, segs = [0, 1], ageMs = 0, bytes = 1000 } = {}) => {
  const dir = path.join(tmp, "jit", name);
  fs.mkdirSync(dir, { recursive: true });
  for (const k of segs) fs.writeFileSync(jit.segPath(dir, k, null), Buffer.alloc(bytes, k + 1));
  fs.mkdirSync(path.join(dir, "p3"), { recursive: true });
  fs.writeFileSync(path.join(dir, "p3", "g000001.ts"), "scratch");
  fs.writeFileSync(path.join(dir, "seg00002.ts.4.part"), "half");
  if (made) {
    fs.writeFileSync(path.join(dir, MADE), JSON.stringify(made));
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(path.join(dir, MADE), t, t);
  }
  return dir;
};
const settle = () => new Promise((r) => setTimeout(r, 150));

test("a dir with no manifest is never served: it starts empty", async () => {
  const dir = mkDir("nomade-1");
  const job = jit.jobFor(dir, table);
  assert.equal(fs.existsSync(jit.segPath(dir, 0, null)), false);
  assert.equal(job.keptSig, null);
  jit._internals.dropJob(dir);
});

test("a copy's kept segments are served again without a producer", async () => {
  const sig = sigOf(copyInput);
  const dir = mkDir("keep-copy", { made: { algo: 2, sig } });
  const job = jit.jobFor(dir, table);
  assert.equal(job.keptSig, sig);
  await settle();
  assert.equal(fs.existsSync(path.join(dir, "p3")), false, "producer scratch is not kept");
  assert.equal(fs.existsSync(path.join(dir, "seg00002.ts.4.part")), false);
  const file = await jit.ensureSegment(dir, job, copyInput, 1);
  assert.equal(file, jit.segPath(dir, 1, null));
  assert.equal(job.producers.length, 0, "nothing had to be made");
  assert.equal(fs.readFileSync(file)[0], 2);
  jit._internals.dropJob(dir);
});

test("an encode's kept segments are dropped when this job encodes differently", async () => {
  const dir = mkDir("keep-enc", { made: { algo: 2, sig: sigOf(encInput(18)) } });
  const same = jit.jobFor(dir, table, { enc: true });
  jit._internals.checkKept(dir, same, encInput(18));
  assert.ok(fs.existsSync(jit.segPath(dir, 0, null)), "made the same way: kept");
  jit._internals.dropJob(dir);
  // the next job of the dir decides other arguments (say, tone mapping now on)
  const other = jit.jobFor(dir, table, { enc: true });
  jit._internals.checkKept(dir, other, encInput(23));
  assert.equal(fs.existsSync(jit.segPath(dir, 0, null)), false, "made differently: started afresh");
  assert.equal(jit._internals.readMade(dir).sig, sigOf(encInput(23)));
  jit._internals.dropJob(dir);
});

test("the signature names what makes the bytes", () => {
  assert.notEqual(sigOf(copyInput), sigOf({ ...copyInput, vtagHvc1: true }));
  assert.notEqual(sigOf(copyInput), sigOf({ ...copyInput, audio: 1 }));
  assert.notEqual(sigOf(encInput(18)), sigOf({ ...encInput(18), enc: { ...encInput(18).enc, inputArgs: ["-hwaccel", "cuda"] } }));
  assert.equal(sigOf(encInput(18)), sigOf(encInput(18)));
});

test("sweepDisk: garbage and stale dirs go, then the oldest over budget; a live job's dir never", async () => {
  for (const d of fs.readdirSync(path.join(tmp, "jit"))) fs.rmSync(path.join(tmp, "jit", d), { recursive: true, force: true });
  const sig = sigOf(copyInput);
  const garbage = mkDir("s-garbage");
  const oldRule = mkDir("s-oldrule", { made: { algo: 1, sig } });
  const stale = mkDir("s-stale", { made: { algo: 2, sig }, ageMs: KEEP_MS + 60000 });
  const older = mkDir("s-older", { made: { algo: 2, sig }, ageMs: 3600 * 1000, bytes: 4000 });
  const newer = mkDir("s-newer", { made: { algo: 2, sig }, ageMs: 60 * 1000, bytes: 4000 });
  const live = mkDir("s-live", { bytes: 4000 });
  jit.jobFor(live, table); // (a job in memory: emptied by jobFor, then held)
  fs.writeFileSync(jit.segPath(live, 0, null), Buffer.alloc(4000));
  const aside = path.join(tmp, "jit", "s-x.del-abc1");
  fs.mkdirSync(aside);
  const r = await jit.sweepDisk({ budget: 13000, free: () => Infinity });
  for (const d of [garbage, oldRule, stale, aside]) assert.equal(fs.existsSync(d), false, path.basename(d));
  assert.equal(fs.existsSync(older), false, "over budget: least recently used first");
  assert.ok(fs.existsSync(newer), "the newer kept dir fits the budget");
  assert.ok(fs.existsSync(jit.segPath(live, 0, null)), "a live job's dir is never touched");
  assert.ok(r.removed >= 4);
  jit._internals.dropJob(live);
});

test("sweepDisk: a disk short of space gives up kept dirs even under budget", async () => {
  const sig = sigOf(copyInput);
  const a = mkDir("f-a", { made: { algo: 2, sig }, ageMs: 1000 });
  let free = 0;
  await jit.sweepDisk({ budget: 1e12, minFree: 10, free: () => free });
  assert.equal(fs.existsSync(a), false);
  const b = mkDir("f-b", { made: { algo: 2, sig }, ageMs: 1000 });
  free = 100;
  await jit.sweepDisk({ budget: 1e12, minFree: 10, free: () => free });
  assert.ok(fs.existsSync(b));
});
