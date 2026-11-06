// The disk forecast (src/media/diskforecast.js): "about 40 days until full at
// this week's pace" from what landed in the library over the last 7 days —
// and the plain words for no growth, a short history, no history at all.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { forecast, eventsFrom, howLong } = require("../src/media/diskforecast");

const GB = 1024 ** 3;
const DAY = 86400e3;
const NOW = Date.parse("2026-11-06T12:00:00Z");
const ago = (d) => NOW - d * DAY;

test("filling: the week's bytes over 7 days, free space over that pace", () => {
  // 70 GB in the last 7 days = 10 GB a day; 400 GB free = 40 days
  const events = [{ at: ago(1), bytes: 30 * GB }, { at: ago(3), bytes: 25 * GB }, { at: ago(6.5), bytes: 15 * GB }, { at: ago(9), bytes: 500 * GB }];
  const f = forecast({ freeBytes: 400 * GB, events, historyStart: ago(60), now: NOW });
  assert.equal(f.state, "filling");
  assert.equal(f.addedBytes, 70 * GB, "only the last 7 days count");
  assert.equal(Math.round(f.paceBytesPerDay / GB), 10);
  assert.equal(Math.round(f.daysLeft), 40);
  assert.equal(f.line, "about 40 days until full at this week's pace");
  assert.equal(f.short, "about 40 days until full");
  assert.match(f.detail, /^70\.0 GB added in the last 7 days \(about 10\.0 GB a day\); 400 GB free\.$/);
});

test("the words for how long: a day, days, months, years", () => {
  assert.equal(howLong(0.3), "less than a day");
  assert.equal(howLong(1.2), "about a day");
  assert.equal(howLong(12.4), "about 12 days");
  assert.equal(howLong(89), "about 89 days");
  assert.equal(howLong(120), "about 4 months");
  assert.equal(howLong(5000), "more than 2 years");
  // nufurora's case: 512 GB disk, 324 GB used = 188 GB free, 2 GB a week
  const f = forecast({ freeBytes: 188 * GB, events: [{ at: ago(2), bytes: 2 * GB }], historyStart: ago(90), now: NOW });
  assert.equal(f.line, "about 22 months until full at this week's pace");
});

test("no growth this week: said plainly, never infinity", () => {
  const f = forecast({ freeBytes: 188 * GB, events: [{ at: ago(20), bytes: 9 * GB }], historyStart: ago(40), now: NOW });
  assert.equal(f.state, "flat");
  assert.equal(f.line, "no growth this week — nothing new was added");
  assert.equal(f.short, "no growth this week");
  assert.equal(f.daysLeft, null);
  assert.ok(!/Infinity|NaN/.test(JSON.stringify(f)));
  // a shrinking library (removals as negative events) is no growth too
  const g = forecast({ freeBytes: 188 * GB, events: [{ at: ago(1), bytes: -5 * GB }], historyStart: ago(40), now: NOW });
  assert.equal(g.state, "flat");
});

test("less than 7 days of history: the pace of the days there are, and it says so", () => {
  const f = forecast({ freeBytes: 100 * GB, events: [{ at: ago(1), bytes: 6 * GB }], historyStart: ago(3), now: NOW });
  assert.equal(f.state, "filling");
  assert.equal(Math.round(f.days), 3);
  assert.equal(Math.round(f.daysLeft), 50, "6 GB in 3 days = 2 GB a day");
  assert.equal(f.line, "about 50 days until full at the pace of the 3 days recorded so far");
  assert.match(f.detail, /Only 3 days of download history so far\./);
  const flat = forecast({ freeBytes: 100 * GB, events: [], historyStart: ago(2.5), now: NOW });
  assert.equal(flat.line, "no growth in the 2 days recorded so far");
  assert.equal(flat.short, "", "the summary line says nothing on a short history");
});

test("under a day of history, no history, no free space measured", () => {
  const f = forecast({ freeBytes: 100 * GB, events: [{ at: ago(0.2), bytes: 50 * GB }], historyStart: ago(0.5), now: NOW });
  assert.equal(f.state, "short-history");
  assert.equal(f.line, "less than a day of downloads recorded — too early to forecast");
  assert.equal(f.short, "");
  const none = forecast({ freeBytes: 100 * GB, events: [], historyStart: null, now: NOW });
  assert.equal(none.state, "no-history");
  assert.equal(none.line, "no downloads recorded yet, so no pace to forecast from");
  const un = forecast({ freeBytes: null, events: [{ at: ago(1), bytes: GB }], historyStart: ago(30), now: NOW });
  assert.equal(un.state, "unmeasured");
  assert.equal(un.short, "");
});

test("the records: finished downloads and finished uploads count; the oldest record of either is where history starts", () => {
  const iso = (t) => new Date(t).toISOString();
  const { events, historyStart } = eventsFrom({
    downloads: [
      { at: iso(ago(30)), status: "done", doneAt: iso(ago(2)), sizeBytes: 4 * GB },
      { at: iso(ago(1)), status: "downloading", sizeBytes: 9 * GB },
      { at: iso(ago(5)), status: "error", sizeBytes: 9 * GB, doneAt: null },
      { at: iso(ago(4)), status: "done", doneAt: iso(ago(3)), sizeBytes: 0 },
      null,
    ],
    uploads: [
      { createdAt: ago(45), status: "done", finishedAt: ago(1), size: 2 * GB },
      { createdAt: ago(2), status: "uploading", size: 7 * GB },
      { createdAt: ago(3), status: "done", updatedAt: ago(3), parts: [{ size: GB }, { size: GB / 2 }] },
    ],
  });
  assert.deepEqual(events.map((e) => e.bytes / GB), [4, 2, 1.5]);
  assert.equal(historyStart, ago(45));
  const f = forecast({ freeBytes: 75 * GB, events, historyStart, now: NOW });
  assert.equal(f.addedBytes, 7.5 * GB);
  assert.equal(Math.round(f.daysLeft), 70);
});
