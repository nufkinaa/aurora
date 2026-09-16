// The healer's judgement calls: what counts as a stalled download, how log
// lines group into "what keeps failing", and how a round rolls up.
const test = require("node:test");
const assert = require("node:assert");
const { _internals: h } = require("../src/lib/healer");

const MIN = 60 * 1000;

test("a job with no torrent details after the window is stalled; a young one is not", () => {
  const now = Date.now();
  const job = { status: "downloading", phase: "finding", progress: 0 };
  assert.equal(h.stallReason(job, { startedAt: now - 3 * MIN }, now), null);
  assert.match(h.stallReason(job, { startedAt: now - h.FINDING_STALL_MS - MIN }, now), /torrent details/);
});

test("progress that stopped moving with zero speed is stalled; a moving one is not", () => {
  const now = Date.now();
  const rec = { startedAt: now - 60 * MIN, lastProgressAt: now - h.PROGRESS_STALL_MS - MIN };
  assert.match(h.stallReason({ status: "downloading", phase: "downloading", progress: 0.4, downloadSpeed: 0 }, rec, now), /stuck at 40%/);
  assert.equal(h.stallReason({ status: "downloading", phase: "downloading", progress: 0.4, downloadSpeed: 500000 }, rec, now), null);
  assert.equal(h.stallReason({ status: "downloading", phase: "downloading", progress: 0.4, downloadSpeed: 0 }, { ...rec, lastProgressAt: now - MIN }, now), null);
});

test("a job copying into the library is never called stalled", () => {
  const now = Date.now();
  assert.equal(h.stallReason({ status: "downloading", phase: "copying", progress: 1, downloadSpeed: 0 }, { startedAt: now - 99 * MIN, lastProgressAt: now - 99 * MIN, copying: true }, now), null);
});

test("log lines group by shape: ids, numbers and quoted names collapse", () => {
  const rows = [
    { msg: '[download] a1b2c3 re-queued: "Silo S2E5" the download was removed' },
    { msg: '[download] 9f9f9f re-queued: "Reacher S3E1" the download was removed' },
    { msg: "[aria2] daemon exited (code 1)" },
  ];
  const top = h.topMessages(rows, 2);
  assert.equal(top[0].n, 2, "the two re-queues are one bucket");
  assert.match(top[0].key, /re-queued/);
  assert.equal(top[1].n, 1);
});

test("a round is as bad as its worst check", () => {
  assert.equal(h.worst(["ok", "info", "ok"]), "ok");
  assert.equal(h.worst(["ok", "warn", "info"]), "warn");
  assert.equal(h.worst(["warn", "fail", "ok"]), "fail");
});
