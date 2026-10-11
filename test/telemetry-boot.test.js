// At boot telemetry.js closes the viewing sessions a restart left "live".
// It used to save watch-sessions.json after that whether or not there was
// anything to close — the whole history rewritten at every start. Now the
// file is written when a session was closed, or when it does not exist yet.
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const jsonstore = require("../src/lib/jsonstore");
const RealStore = jsonstore.JsonStore;
const telemetryPath = require.resolve("../src/telemetry");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-telboot-"));
after(() => {
  jsonstore.JsonStore = RealStore;
  delete require.cache[telemetryPath];
  fs.rmSync(dir, { recursive: true, force: true });
});

// Load telemetry.js afresh over stand-in stores; returns { sessions, saves }.
const boot = ({ sessions, fileExists }) => {
  const saves = {};
  const stores = {};
  jsonstore.JsonStore = class {
    constructor(filePath, fallback) {
      const name = path.basename(filePath);
      this.filePath = path.join(dir, `${fileExists ? "there" : "absent"}-${name}`);
      if (name === "watch-sessions.json") {
        this.data = sessions;
        if (fileExists) fs.writeFileSync(this.filePath, "[]");
      } else this.data = typeof fallback === "function" ? fallback() : fallback;
      saves[name] = 0;
      stores[name] = this;
    }
    save() { saves[path.basename(this.filePath).replace(/^(there|absent)-/, "")]++; }
    flush() { this.save(); }
  };
  delete require.cache[telemetryPath];
  try { require("../src/telemetry"); } finally { jsonstore.JsonStore = RealStore; }
  return { sessions: stores["watch-sessions.json"].data, saves };
};

const ended = (id) => ({ id, content: "A film", startedAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:30:00.000Z", endedAt: "2026-10-01T10:30:00.000Z", watchedSec: 1800, live: false });

test("nothing was live: the history is not rewritten", () => {
  const list = [ended("a"), ended("b")];
  const snapshot = JSON.stringify(list);
  const r = boot({ sessions: list, fileExists: true });
  assert.equal(r.saves["watch-sessions.json"], 0);
  assert.equal(JSON.stringify(r.sessions), snapshot, "and nothing in it was touched");
});

test("a session the restart left live is closed at its last update, and that is saved", () => {
  const list = [
    { ...ended("a"), live: true, endedAt: null, updatedAt: "2026-10-01T10:20:00.000Z" },
    { id: "c", content: "Another", startedAt: "2026-10-01T11:00:00.000Z", updatedAt: null, endedAt: null, live: true },
    ended("b"),
  ];
  const r = boot({ sessions: list, fileExists: true });
  assert.equal(r.saves["watch-sessions.json"], 1);
  assert.deepEqual(r.sessions.map((s) => [s.id, s.live, s.endedAt]), [
    ["a", false, "2026-10-01T10:20:00.000Z"],
    ["c", false, "2026-10-01T11:00:00.000Z"], // never updated: closed where it started
    ["b", false, "2026-10-01T10:30:00.000Z"],
  ]);
});

test("a fresh data folder still gets its (empty) file", () => {
  const r = boot({ sessions: [], fileExists: false });
  assert.equal(r.saves["watch-sessions.json"], 1);
});
