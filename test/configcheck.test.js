// lib/configcheck.js and lib/resources.js — config.json checked at boot, and
// what the machine gives the server (the checks on the Health card).
const test = require("node:test");
const assert = require("node:assert/strict");

const configcheck = require("../src/lib/configcheck");
const resources = require("../src/lib/resources");

// ---------- config.json at boot ----------
test("config: unknown keys are warned (with a guess), bad values refused with the default named", () => {
  const cfg = {
    port: 4000, scanIntervalMinutes: "10", torrents: "false", prewarmStream: false,
    rateLimits: "sometimes", libraries: { movies: ["D:/M"], shows: "D:/S" }, _comment: "x",
    tmdbApiKey: 12345, http: { headersTimeoutSec: 5 },
  };
  const r = configcheck.check(cfg, { apply: true, log: false });
  const by = Object.fromEntries(r.problems.map((p) => [p.key, p]));
  assert.equal(by.prewarmStream.level, "warn");
  assert.match(by.prewarmStream.message, /did you mean "prewarmStreams"/);
  assert.equal(by.scanIntervalMinutes.level, "warn", "a number in quotes still works: a warning");
  assert.equal(by.torrents.level, "refused", '"false" in quotes would have meant ON');
  assert.match(by.torrents.message, /default: true/);
  assert.equal(by.rateLimits.level, "refused");
  assert.equal(by.libraries.level, "refused");
  assert.equal(by.tmdbApiKey.level, "refused");
  assert.ok(!by.tmdbApiKey.message.includes("12345"), "a secret's value is never repeated");
  assert.ok(!("_comment" in by) && !("http" in by) && !("port" in by));
  // refused keys are gone: their defaults apply
  assert.ok(!("torrents" in cfg) && !("rateLimits" in cfg) && !("libraries" in cfg));
  assert.equal(cfg.port, 4000);
});

test("config: the shapes this repo documents pass (config.example.json)", () => {
  const ex = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "config.example.json"), "utf8"));
  assert.deepEqual(configcheck.check(ex, { log: false }).problems, []);
});

// ---------- the machine ----------
test("resources: the open-file limit is read from /proc/self/limits and sets maxConnections", () => {
  const limits = "Limit                     Soft Limit           Hard Limit           Units\nMax open files            1024                 524288               files\n";
  const realPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    assert.deepEqual(resources.fdLimit(() => limits), { soft: 1024, hard: 524288 });
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform });
  }
  assert.equal(resources.maxConnectionsFor({ soft: 1024 }), 768);
  assert.equal(resources.maxConnectionsFor({ soft: Infinity }), null);
  assert.equal(resources.maxConnectionsFor(null), null);
});

test("resources: memory available is MemAvailable on Linux (not the cache-blind freemem)", () => {
  const realPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    assert.equal(resources.memAvailable(() => "MemTotal:       16000000 kB\nMemFree:          200000 kB\nMemAvailable:    9000000 kB\n"), 9000000 * 1024);
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform });
  }
  assert.ok(resources.memAvailable() > 0, "this machine's own reading");
});

test("resources: the checks list Node, disk and config", () => {
  resources._internals.reset();
  const s = resources.status();
  const ids = s.checks.map((c) => c.id);
  assert.ok(ids.includes("node") && ids.includes("config") && ids.includes("memory"));
  if (process.platform === "linux") assert.ok(ids.includes("files"), "the open-file limit is read on Linux");
  assert.ok(["ok", "warn", "critical"].includes(s.worst));
});
