// Store writes OFF the event loop (src/lib/jsonstore.js FileWriter): a
// write a timer makes goes through the threadpool — temp file of its own,
// fsync, rename, the same crash-safety — one at a time per store, a burst
// coalesced; a synchronous flush (shutdown) overtakes whatever is under way
// and an older write can never be renamed over a newer one.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { Worker } = require("worker_threads");

const js = require("../src/lib/jsonstore");
const { JsonStore, FileWriter } = js;
const I = js._internals;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aurora-async-"));
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
const forget = (s) => { if (s.saveTimer) clearTimeout(s.saveTimer); if (s.retryTimer) clearTimeout(s.retryTimer); I.instances.delete(s); };
const files = (dir) => fs.readdirSync(dir).sort();
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

// open() made slow (a disk under pressure): the handle's calls are counted
const slowDisk = (ms, calls) => {
  const real = { ...I.aio };
  I.aio.open = async (p, flags) => {
    await new Promise((r) => setTimeout(r, ms));
    const fh = await real.open(p, flags);
    const sync = fh.sync.bind(fh);
    fh.sync = async () => { calls.push("fsync"); return sync(); };
    return fh;
  };
  return () => Object.assign(I.aio, real);
};

test("a timer's write leaves the loop free while the disk is slow, and is durable (fsync) when it lands", async () => {
  const dir = tmp();
  const calls = [];
  const restore = slowDisk(400, calls);
  const s = new JsonStore(path.join(dir, "downloads.json"), []);
  try {
    s.data.push({ id: 1 });
    const t0 = Date.now();
    const p = s.persist();
    const turn = await new Promise((r) => setImmediate(() => r(Date.now() - t0)));
    assert.ok(turn < 100, `the loop turned in ${turn} ms while the write waited 400 ms for the disk`);
    assert.equal(s.dirty, true, "unwritten until it has landed");
    assert.equal(await p, true);
    assert.deepEqual(read(s.filePath), [{ id: 1 }]);
    assert.equal(s.dirty, false);
    assert.ok(calls.includes("fsync"), "fsynced before the rename");
    assert.ok(!files(dir).some((n) => n.endsWith(".tmp")), "no temp file left");
  } finally {
    restore();
    forget(s);
    rm(dir);
  }
});

test("one write at a time per store: a burst during a slow write is ONE more write, with the latest data", async () => {
  const dir = tmp();
  const calls = [];
  const restore = slowDisk(150, calls);
  const s = new JsonStore(path.join(dir, "requests.json"), { n: 0 });
  try {
    s.data.n = 1;
    const first = s.persist();
    for (let i = 2; i <= 30; i++) { s.data.n = i; s.persist(); }
    await first;
    await s.idle();
    assert.equal(read(s.filePath).n, 30);
    assert.equal(s.writes, 2, "the first, then one for everything asked meanwhile");
    assert.equal(s.dirty, false);
  } finally {
    restore();
    forget(s);
    rm(dir);
  }
});

test("a change made while a write is under way keeps the store unwritten until it is written too", async () => {
  const dir = tmp();
  const calls = [];
  const restore = slowDisk(150, calls);
  const s = new JsonStore(path.join(dir, "bans.json"), {});
  try {
    s.data.a = 1;
    const p = s.persist();
    await new Promise((r) => setTimeout(r, 20));
    s.data.b = 2;
    s.save();
    await p;
    assert.equal(s.dirty, true, "b is not on disk yet");
    js.flushAll();
    assert.deepEqual(read(s.filePath), { a: 1, b: 2 });
    assert.equal(s.dirty, false);
  } finally {
    restore();
    forget(s);
    rm(dir);
  }
});

test("a synchronous flush (shutdown) overtakes a slow write under way: the newest data stays, the older write is dropped", async () => {
  const dir = tmp();
  const calls = [];
  const restore = slowDisk(250, calls);
  const s = new JsonStore(path.join(dir, "push.json"), { v: 0 });
  try {
    s.data.v = 1;
    const p = s.persist(); // still opening its temp file
    s.data.v = 2;
    assert.equal(s.flush(), true);
    assert.equal(read(s.filePath).v, 2);
    await p;
    await s.idle();
    assert.equal(read(s.filePath).v, 2, "the older write never landed over it");
    assert.ok(!files(dir).some((n) => n.endsWith(".tmp")), "its temp file was removed");
  } finally {
    restore();
    forget(s);
    rm(dir);
  }
});

test("a synchronous write waits for a rename already under way in another thread, so the older file cannot land last", async () => {
  const dir = tmp();
  const file = path.join(dir, "x.json");
  const older = path.join(dir, "x.json.older.tmp");
  fs.writeFileSync(older, JSON.stringify({ v: "older" }));
  const w = new FileWriter(file);
  w.renaming = older; // as if a threadpool rename of `older` is on its way
  const worker = new Worker(`
    const fs = require("fs");
    const { workerData } = require("worker_threads");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    fs.renameSync(workerData.from, workerData.to);
  `, { eval: true, workerData: { from: older, to: file } });
  try {
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    w.writeSync(JSON.stringify({ v: "newer" }));
    assert.ok(Date.now() - t0 >= 100, "it waited for the rename");
    await new Promise((r) => worker.once("exit", r));
    assert.equal(read(file).v, "newer");
  } finally {
    rm(dir);
  }
});

test("a timer-driven write that fails is not forgotten: unsaved, tried again later, and lands", async (t) => {
  const dir = tmp();
  const real = { ...I.aio };
  let fail = 1;
  I.aio.open = (p, f) => (fail-- > 0 ? Promise.reject(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })) : real.open(p, f));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = new JsonStore(path.join(dir, "reports.json"), { reports: [] });
  const saved = console.error;
  console.error = () => {};
  try {
    s.data.reports.push(1);
    s.save();
    t.mock.timers.tick(I.DEBOUNCE_MS);
    await s.idle();
    assert.ok(s.unsavedSince > 0 && s.dirty);
    t.mock.timers.tick(I.RETRY_LATER_MS);
    await s.idle();
    assert.equal(s.dirty, false);
    assert.deepEqual(read(s.filePath), { reports: [1] });
  } finally {
    console.error = saved;
    t.mock.timers.reset();
    Object.assign(I.aio, real);
    forget(s);
    rm(dir);
  }
});

test("a cache is written off the loop without fsync; a last-good copy is taken off the loop too", async () => {
  const dir = tmp();
  const calls = [];
  const restore = slowDisk(1, calls);
  try {
    const c = new JsonStore(path.join(dir, "cache", "similar.json"), {});
    c.data.a = 1;
    await c.persist();
    assert.ok(!calls.includes("fsync"), "a cache is rebuilt, not fsynced");
    forget(c);
    const s = new JsonStore(path.join(dir, "intros.json"), {});
    s.data.a = 1;
    await s.persist();
    await s.idle();
    assert.deepEqual(read(path.join(dir, "intros.json.good1")), { a: 1 }, "a last-good copy, read back and named");
    forget(s);
  } finally {
    restore();
    rm(dir);
  }
});

test("a process killed while writing off the loop flat out never leaves an unreadable store", { timeout: 120000 }, async () => {
  const dir = tmp();
  const file = path.join(dir, "busy.json");
  const writer = path.join(dir, "writer.js");
  fs.writeFileSync(writer, `
    const { JsonStore } = require(${JSON.stringify(path.join(__dirname, "..", "src", "lib", "jsonstore.js"))});
    const s = new JsonStore(${JSON.stringify(file)}, { n: 0, pad: [] });
    for (let i = 0; i < 4000; i++) s.data.pad[i] = "row " + i + " ".repeat(40);
    s.data.n++; s.flush();
    process.stdout.write("ready\\n");
    const go = () => { s.data.n++; s.persist().then(go); };
    go();
  `);
  try {
    let last = 0;
    for (let round = 0; round < 8; round++) {
      const child = spawn(process.execPath, [writer], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      await new Promise((resolve) => child.stdout.once("data", resolve));
      await new Promise((r) => setTimeout(r, 40 + round * 23));
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(d.pad.length, 4000);
      assert.ok(d.n >= last);
      last = d.n;
    }
  } finally {
    rm(dir);
  }
});
