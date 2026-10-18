// While the server runs, nothing else may write its data folder (incident
// 2026-10-18: a test run inside the live folder wrote test profiles over the
// household's profiles.json through the exit flush).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const jsonstore = require("../src/lib/jsonstore");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aurora-owner-"));

test("a store in a folder owned by another live process writes nothing, flush included", async () => {
  const dir = tmp();
  // a stand-in "server": a live child process whose pid owns the folder
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
  try {
    fs.writeFileSync(path.join(dir, jsonstore.OWNER_FILE), JSON.stringify({ pid: holder.pid, at: new Date().toISOString() }));
    const file = path.join(dir, "thing.json");
    fs.writeFileSync(file, JSON.stringify({ who: "household" }));
    const s = new jsonstore.JsonStore(file, { who: "default" });
    assert.equal(s.data.who, "household", "reading is fine");
    s.data = { who: "test fixture" };
    s.save();
    s.flush();
    await s.idle();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).who, "household", "the owner's file is untouched");
  } finally {
    holder.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with no live owner (a dead pid), writes go ahead as before", async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, jsonstore.OWNER_FILE), JSON.stringify({ pid: 999999, at: "x" }));
    const file = path.join(dir, "thing.json");
    const s = new jsonstore.JsonStore(file, { n: 0 });
    s.data.n = 5;
    s.flush();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).n, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loading profiles.js arms no write (the ghost-state move is the server's boot step)", () => {
  const r = spawnSync(process.execPath, ["-e", `
    const p = require(${JSON.stringify(path.join(ROOT, "src", "profiles.js"))});
    const st = p._internals.store;
    process.stdout.write(JSON.stringify({ timer: !!st.saveTimer, dirty: !!st.dirty, boot: typeof p.bootMaintenance }));
  `], { encoding: "utf8", timeout: 60000, env: { ...process.env, AURORA_DATA_DIR: tmp() } });
  const out = JSON.parse((r.stdout || "").trim().split("\n").pop());
  assert.equal(out.boot, "function");
  assert.equal(out.timer, false, "no save armed at load");
  assert.equal(out.dirty, false);
});
