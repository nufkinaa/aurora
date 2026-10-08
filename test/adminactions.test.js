// The admin page's Actions tab: a fixed list, never a shell.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const actions = require("../src/lib/adminactions");
const { ACTIONS, emptyDir, isExclusive } = actions._internals;

const waitFor = async (id, ms = 60000) => {
  const until = Date.now() + ms;
  for (;;) {
    const r = actions.getRun(id);
    if (r && r.status !== "running") return r;
    if (Date.now() > until) throw new Error("the run did not finish");
    await new Promise((res) => setTimeout(res, 50));
  }
};

test("every action is fully described and its id is unique", () => {
  const ids = new Set();
  for (const a of ACTIONS) {
    assert.match(a.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(!ids.has(a.id), `duplicate id ${a.id}`);
    ids.add(a.id);
    assert.ok(a.group && a.title && a.about, a.id);
    assert.ok(a.kind === "command" || a.kind === "task", a.id);
    if (a.kind === "command") {
      assert.ok(Array.isArray(a.steps) && a.steps.length, a.id);
      for (const s of a.steps) {
        assert.equal(typeof s.cmd, "string");
        assert.ok(Array.isArray(s.args));
      }
    } else assert.equal(typeof a.run, "function", a.id);
  }
});

test("the list handed to the page carries no functions and says what each command runs", () => {
  const l = actions.list();
  assert.equal(l.actions.length, ACTIONS.length);
  const json = JSON.parse(JSON.stringify(l));
  assert.deepEqual(json.actions, l.actions);
  const install = l.actions.find((a) => a.id === "npm-install");
  assert.ok(install.long, "a command is exclusive");
  // on Windows npm runs through a shell as one constant string
  assert.match(install.runs.join(" "), /npm(\.cmd)? install --omit=dev/);
  assert.ok(l.actions.find((a) => a.id === "restart").confirm, "restart asks first");
});

test("an unknown id is refused, and nothing a caller sends becomes a command", () => {
  for (const id of ["", "nope", "git-status; rm -rf /", "../../etc/passwd", "__proto__", "constructor"]) {
    const r = actions.start(id);
    assert.equal(r.status, 404, id);
    assert.ok(!r.run);
  }
});

test("an in-process action runs and keeps its output", async () => {
  // A stand-in registered for this test only: running a real action here
  // would act on the developer's own data (the first version of this test
  // wiped the live "declined files" list).
  const { byId } = actions._internals;
  byId.set("test-echo", { id: "test-echo", group: "Test", title: "Echo", about: "test", kind: "task", run: async (log) => { log("working" + String.fromCharCode(10)); return "Said hello."; } });
  try {
    const r = actions.start("test-echo");
    assert.ok(r.run && r.run.id);
    const done = await waitFor(r.run.id);
    assert.equal(done.status, "ok");
    assert.match(done.output, /working\s+Said hello\./);
    assert.ok(actions.list().runs.some((x) => x.id === r.run.id));
  } finally {
    byId.delete("test-echo");
  }
});

test("a command runs with its fixed arguments; a second command waits its turn", async () => {
  const a = actions.start("git-status");
  assert.ok(a.run, JSON.stringify(a));
  // while it runs, another command is refused with the name of the one in flight
  const b = actions.start("patch-webtorrent");
  if (b.status) {
    assert.equal(b.status, 409);
    assert.match(b.error, /still running/);
  } else await waitFor(b.run.id);
  const done = await waitFor(a.run.id);
  assert.match(done.output, /^\$ git(\.exe)? log -5/m);
  assert.ok(["ok", "failed"].includes(done.status)); // "failed" only where the folder is not a git checkout
  // the lock is released: a quick task and a new command both start
  assert.equal(actions.list().busy, null);
});

test("a task that throws is recorded as failed, with the reason", async () => {
  const spare = ACTIONS.find((a) => a.id === "notify-test");
  const notify = require("../src/lib/notify");
  const real = notify.channels;
  notify.channels = () => [];
  try {
    const r = actions.start(spare.id);
    const done = await waitFor(r.run.id);
    assert.equal(done.status, "failed");
    assert.match(done.output, /No alert channel/);
  } finally {
    notify.channels = real;
  }
});

test("commands are exclusive, quick tasks are not (except the update)", () => {
  assert.equal(isExclusive(ACTIONS.find((a) => a.id === "self-test")), true);
  assert.equal(isExclusive(ACTIONS.find((a) => a.id === "update-all")), true);
  assert.equal(isExclusive(ACTIONS.find((a) => a.id === "rescan")), false);
});

test("emptyDir removes files, leaves folders, and reports what it freed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-actions-"));
  fs.writeFileSync(path.join(dir, "a.bin"), Buffer.alloc(1000));
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "b.bin"), Buffer.alloc(500));
  const [n, bytes] = emptyDir(dir);
  assert.equal(n, 2);
  assert.equal(bytes, 1500);
  assert.ok(fs.existsSync(path.join(dir, "sub")));
  assert.deepEqual(fs.readdirSync(path.join(dir, "sub")), []);
  assert.deepEqual(emptyDir(path.join(dir, "missing")), [0, 0]);
  fs.rmSync(dir, { recursive: true, force: true });
});
