// The watch journal under a HARD KILL (kill -9 / TerminateProcess) and a
// graceful stop, with the real profiles.js in a private root (its own data/):
// a child process plays a film (a progress save every 20 ms, a seek every
// 50 saves), is killed at a random moment, and a fresh process reads what
// survived. Each time: profiles.json and the journal load without recovery,
// the household is whole, and the resume point is at least the last one that
// was urgent (a seek) more than the debounce before the kill — and never
// beyond the last save. A graceful stop keeps the very last save, in
// profiles.json itself (what an older build would read).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const REPO = path.join(__dirname, "..");
let root;

const CHILD = `
const profiles = require("./src/profiles");
const js = require("./src/lib/jsonstore");
js.ownSignals(true);
const mode = process.argv[2];
if (mode === "read") {
  const st = profiles.stateOf("ann");
  const rec = js.status().recoveries.length;
  process.stdout.write(JSON.stringify({ film: st.progress.film || null, rows: Object.keys(st.progress).length, profiles: profiles.list().length, recoveries: rec, boot: profiles._internals.journal().stats.boot }) + "\\n");
  process.exit(0);
}
let pos = 100, n = 0;
const tick = () => {
  n++;
  const seek = n % 50 === 0;
  if (seek) pos += 600; else pos += 1;
  profiles.setProgress("ann", "film", pos, 100000, null);
  process.stdout.write((seek ? "urgent " : "ack ") + pos + "\\n");
};
setInterval(tick, 20);
process.stdin.on("data", (d) => { if (String(d).includes("quit")) { js.flushAll(); process.stdout.write("bye\\n"); process.exit(0); } });
`;

const env = () => {
  const e = { ...process.env, NODE_PATH: path.join(REPO, "node_modules") };
  for (const k of Object.keys(e)) if (/^(AURORA_|TMDB_|NODE_OPTIONS|NODE_TEST_CONTEXT)/.test(k)) delete e[k];
  return e;
};
const read = () => {
  const r = spawnSync(process.execPath, ["child.js", "read"], { cwd: root, env: env(), encoding: "utf8", timeout: 60000 });
  const line = (r.stdout || "").trim().split(/\r?\n/).pop();
  try { return JSON.parse(line); } catch { throw new Error(`reader said: ${r.stdout}\n${r.stderr}`); }
};
const run = (opts) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["child.js", "run"], { cwd: root, env: env(), stdio: ["pipe", "pipe", "pipe"] });
  const acks = []; // { pos, urgent, at }
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const m = /^(ack|urgent) (\d+)$/.exec(line);
      if (m) acks.push({ pos: +m[2], urgent: m[1] === "urgent", at: Date.now() });
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const started = Date.now();
  const wait = setInterval(() => {
    if (!acks.length || Date.now() - acks[0].at < opts.runMs) return;
    clearInterval(wait);
    const killedAt = Date.now();
    if (opts.graceful) child.stdin.write("quit\n");
    else child.kill("SIGKILL");
    child.on("exit", () => resolve({ acks, killedAt, stderr, started }));
  }, 5);
});

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-journal-crash-"));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ port: 0, libraries: { movies: [], shows: [] }, onlineMetadata: false, autoOcrSubtitles: false, notifications: {}, authMode: "open" }));
  const progress = {};
  for (let i = 0; i < 300; i++) progress[`old${i}`] = { position: i, duration: 6000, finished: false, updatedAt: 1000 + i };
  fs.writeFileSync(path.join(root, "data", "profiles.json"), JSON.stringify({
    profiles: [{ id: "ann", name: "Ann" }, { id: "bob", name: "Bob" }],
    state: { ann: { progress, titles: {}, streamItems: {} } }, pending: [], access: {},
  }));
  fs.writeFileSync(path.join(root, "child.js"), CHILD);
});
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

test("killed at random moments: the household is whole and the resume point is never behind the last durable seek", { timeout: 240000 }, async () => {
  let prevLast = 0;
  for (let round = 0; round < 6; round++) {
    const runMs = 3000 + Math.floor(Math.random() * 5000); // (the run's first save is a seek back to 100: durable after the debounce)
    const r = await run({ runMs });
    assert.ok(r.acks.length > 10, `the child played (${r.stderr.slice(0, 300)})`);
    const got = read();
    assert.equal(got.recoveries, 0, "nothing had to be recovered");
    assert.equal(got.profiles, 2, "the household is whole");
    assert.ok(got.rows >= 300, `the history is whole (${got.rows})`);
    const last = r.acks[r.acks.length - 1].pos;
    // the newest seek that had the debounce + a generous margin to reach the
    // disk (the write is off the loop: on a loaded machine it can take a while)
    const durable = r.acks.filter((a) => a.urgent && r.killedAt - a.at > 6000).pop();
    const floor = durable ? durable.pos : 0;
    if (round === 0 && !got.film) { prevLast = r.acks[r.acks.length - 1].pos; continue; } // killed before the first save ever reached the disk: nothing to check yet
    assert.ok(got.film, "the film's row survived");
    assert.ok(got.film.position >= floor, `round ${round}: resume ${got.film.position} is not behind the last durable seek ${floor}`);
    // never beyond the last save — of this run, or (nothing of this run reached the disk yet) of the one before
    assert.ok(got.film.position <= Math.max(last, prevLast), `round ${round}: resume ${got.film.position} is not beyond the last save ${last}`);
    prevLast = last;
  }
});

test("a graceful stop keeps the very last save — in profiles.json itself, for an older build", { timeout: 120000 }, async () => {
  const r = await run({ runMs: 1500, graceful: true });
  const last = r.acks[r.acks.length - 1].pos;
  const got = read();
  assert.equal(got.film.position, last);
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "profiles.json"), "utf8"));
  assert.equal(onDisk.state.ann.progress.film.position, last, "profiles.json holds it (no journal needed)");
  const j = JSON.parse(fs.readFileSync(path.join(root, "data", "watch-journal.json"), "utf8"));
  assert.deepEqual(j.rows, {}, "and the journal is empty");
});
