// A jit producer far ahead of its reader is lowered to the idle priority
// (lib/leadprio.js, Windows). It must be raised again by its READER coming
// near — not only when it publishes its next segment: at the idle priority on
// a busy machine it may publish nothing at all, and then the reader waits on
// it with the one thing that would raise it never happening.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const jit = require("../src/media/jit");
const lp = require("../src/lib/leadprio");
const J = jit._internals;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jitlead-"));
const table = Array.from({ length: 200 }, (_, i) => ({ start: i * 6, dur: 6 }));
const real = { ...lp._deps };
test.after(() => { Object.assign(lp._deps, real); fs.rmSync(tmp, { recursive: true, force: true }); });

test("a reader that comes near an idle-priority producer raises it at once (before: only its next publish could)", async () => {
  const calls = [];
  const prio = { 4242: os.constants.priority.PRIORITY_LOW };
  Object.assign(lp._deps, { platform: () => "win32", get: (pid) => prio[pid], set: (pid, p) => { calls.push([pid, p]); prio[pid] = p; } });
  const dir = path.join(tmp, "copy");
  const job = jit.jobFor(dir, { key: "title-1", table });
  // a copy producer that ran far ahead and was lowered: it has decided
  // segments up to 29 and is starved now (nothing more is published)
  const run = { fromSeg: 10, nextSeg: 30, proc: { pid: 4242, kill() {} }, leadLow: true, leadPrio: os.constants.priority.PRIORITY_BELOW_NORMAL, warm: null };
  job.producers.push(run);
  job.runs.add(run);
  // segment 29 is on disk; the reader asks for it — it is right at the producer's head
  const input = { url: "x", extra: [], fmt: null, audio: 0 };
  J.checkKept(dir, job, input);
  fs.writeFileSync(jit.segPath(dir, 29, null), "seg");
  const file = await jit.ensureSegment(dir, job, input, 29);
  assert.ok(file, "the segment is served");
  assert.deepStrictEqual(calls, [[4242, os.constants.priority.PRIORITY_BELOW_NORMAL]], "raised back to the priority it had");
  assert.strictEqual(run.leadLow, false);
  job.producers.length = 0;
  job.runs.clear();
  J.dropJob(dir);
});
