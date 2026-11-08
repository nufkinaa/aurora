// The admin's one-glance state (src/lib/adminsummary.js decide()): what turns
// it to "needs you", and what stays a minor note.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { decide } = require("../src/lib/adminsummary");

const GB = 1024 ** 3;
const calm = (o = {}) => ({
  version: "1.15.7",
  uptimeSec: 3 * 86400 + 4 * 3600,
  supervisor: { supervised: true, by: "keeper" },
  alerts: [{ id: "tools", name: "ffmpeg", level: "ok", message: "ffmpeg and ffprobe run" }],
  healer: [{ id: "process", name: "Process", status: "ok", summary: "fine" }],
  loop: { p99Ms: 12, maxMs: 40 },
  enc: { limit: 2, capacity: 6, load: 1.5, active: 1, overloaded: false },
  disks: [{ root: "D:\\Movies", free: 812 * GB, total: 2000 * GB }],
  minFreePct: 10,
  watchingNow: 2,
  plays: { hour: { plays: 4, startFailures: 0 }, day: { plays: 41, startFailures: 0, ttff: { p50: 1800 } } },
  starts: { n: 41, p50: 1800 },
  downloads: [{ id: "a", status: "downloading", downloadSpeed: 4 * 1024 ** 2 }, { id: "b", status: "approved" }],
  ...o,
});

test("a healthy house: Everything works, five lines, nothing minor", () => {
  const s = decide(calm());
  assert.equal(s.state, "works");
  assert.equal(s.headline, "Everything works");
  assert.equal(s.reason, "People can watch normally.");
  assert.equal(s.fix, null);
  assert.deepEqual(s.needs, []);
  assert.deepEqual(s.minor, []);
  assert.deepEqual(s.areas.map((a) => a.id), ["site", "playback", "streaming", "disk", "downloads"]);
  assert.ok(s.areas.every((a) => a.level === "ok"));
  const line = Object.fromEntries(s.areas.map((a) => [a.id, a.line]));
  assert.equal(line.site, "up 3 d 4 h · v1.15.7 · kept running by keeper");
  assert.equal(line.playback, "2 watching now · 41 plays today · starts in 1.8 s");
  assert.equal(line.streaming, "1 encoding · 25 % of capacity · answers at once");
  assert.equal(line.disk, "812 GB free");
  assert.equal(line.downloads, "1 downloading · 4.0 MB/s · 1 queued");
});

test("warnings never turn it red: health and healer warnings, a busy encoder, a slow loop, low-ish disk, a stalled download, no supervisor", () => {
  const s = decide(calm({
    alerts: [{ id: "backup-stale", name: "Backups", level: "warn", message: "no working backup for 2 d" }],
    healer: [
      { id: "errors", name: "Errors in the log", status: "fail", summary: "a crash in the log" },
      { id: "upstream", name: "Upstream providers", status: "warn", summary: "TMDB slow" },
      { id: "playback", name: "Playback health", status: "warn", summary: "stalls up" },
    ],
    loop: { p99Ms: 320, maxMs: 900 },
    enc: { limit: 2, capacity: 6, load: 6, active: 2, overloaded: true, overloadWhy: "an encode is making 0.8 s of film per second" },
    disks: [{ root: "D:\\Movies", free: 15 * GB, total: 2000 * GB }],
    downloads: [{ id: "a", label: "Slow Film", status: "downloading", downloadSpeed: 0, stalled: true }, { id: "b", label: "Gone Film", status: "downloading", downloadSpeed: 0, health: { state: "dead" } }],
    supervisor: { supervised: false, by: null },
    plays: { hour: { plays: 5, startFailures: 1 }, day: { plays: 20, startFailures: 1, ttff: { p50: 7000 } } },
    starts: { n: 20, p50: 7000 },
  }));
  assert.equal(s.state, "works", JSON.stringify(s.needs));
  assert.ok(s.areas.every((a) => a.level === "ok"));
  const ids = s.minor.map((m) => m.id).sort();
  assert.match(s.minor.find((m) => m.id === "dl-stalled").title, /^2 downloads stalled/);
  assert.match(s.minor.find((m) => m.id === "dl-stalled").why, /Slow Film, Gone Film/);
  assert.deepEqual(ids, ["disk-low", "dl-stalled", "encoders", "health:backup-stale", "healer:errors", "healer:playback", "healer:upstream", "loop", "slow-starts", "starts", "supervisor"].sort());
});

test("a critical health alert needs you, with its sentence and the fix", () => {
  const s = decide(calm({ alerts: [{ id: "downloader", name: "Download engine", level: "critical", message: "The download engine has stopped and 3 downloads are waiting." }] }));
  assert.equal(s.state, "needs-you");
  assert.equal(s.headline, "1 thing needs you");
  assert.equal(s.reason, "Download engine: The download engine has stopped and 3 downloads are waiting.");
  assert.deepEqual(s.fix, { label: "Restart Aurora", kind: "restart" });
  assert.equal(s.areas.find((a) => a.id === "downloads").level, "bad");
});

test("a healer fail where people watch needs you (and names its button); its health twin is not counted twice", () => {
  const s = decide(calm({
    healer: [{ id: "library", name: "Library folders and files", status: "fail", summary: "1 folder away", findings: [{ level: "fail", text: "The shows folder cannot be read.", press: { action: "rescan", label: "Server → Actions → Rescan the library" } }] }],
  }));
  assert.equal(s.state, "needs-you");
  assert.equal(s.needs[0].title, "Library folders and files");
  assert.equal(s.needs[0].why, "The shows folder cannot be read.");
  assert.deepEqual(s.needs[0].fix, { label: "Rescan the library", kind: "action", action: "rescan" });

  const both = decide(calm({
    alerts: [{ id: "disk:D:\\Movies", name: "Disk (movies)", level: "critical", message: "3 GB left" }],
    healer: [{ id: "disk", name: "Disk", status: "fail", summary: "3 GB left" }],
  }));
  assert.equal(both.needs.length, 1);
  assert.equal(both.headline, "1 thing needs you");
  assert.deepEqual(both.needs[0].fix, { label: "Free up space", kind: "tab", tab: "downloads", more: "d-disk" });
  assert.ok(both.minor.some((m) => m.id === "healer:disk"));
});

test("a stuck event loop, plays that do not start and an almost full drive need you", () => {
  const s = decide(calm({
    loop: { p99Ms: 40, maxMs: 7200 },
    plays: { hour: { plays: 6, startFailures: 3 }, day: { plays: 30, startFailures: 3, ttff: { p50: 2000 } } },
    disks: [{ root: "D:\\Movies", free: 2 * GB, total: 2000 * GB }, { root: "E:\\Shows", free: 900 * GB, total: 2000 * GB }],
  }));
  assert.equal(s.state, "needs-you");
  assert.equal(s.headline, "3 things need you");
  assert.deepEqual(s.needs.map((n) => n.id), ["loop", "starts", "disk"]);
  assert.match(s.needs[0].why, /blocked for up to 7\.2 s/);
  assert.match(s.needs[1].why, /3 of the last 6 plays/);
  assert.match(s.needs[2].why, /2\.0 GB free on D:\\Movies/);
  assert.equal(s.areas.find((a) => a.id === "disk").line, "2.0 GB free on the fullest drive");
});

test("missing inputs are not faults: an empty read still answers Everything works", () => {
  const s = decide({});
  assert.equal(s.state, "works");
  assert.equal(s.areas.length, 5);
  assert.equal(s.areas.find((a) => a.id === "disk").line, "not measured");
});

test("the Disk line carries the forecast's few words (media/diskforecast.js), and only when there are some", () => {
  const line = (forecast) => decide(calm({ forecast })).areas.find((a) => a.id === "disk").line;
  assert.equal(line({ state: "filling", short: "about 40 days until full" }), "812 GB free · about 40 days until full");
  assert.equal(line({ state: "flat", short: "no growth this week" }), "812 GB free · no growth this week");
  assert.equal(line({ state: "short-history", short: "" }), "812 GB free");
  assert.equal(line(null), "812 GB free");
});

// ---- storage drives (lib/drives): several in use, one not answering ----
test("drives: several in use — the Disk line counts the ones that take new downloads together", () => {
  const s = decide(calm({
    drives: [
      { id: "/", mount: "/", free: 105 * GB, total: 502 * GB, answering: true, newDownloads: true },
      { id: "/mnt/storagespace", mount: "/mnt/storagespace", network: true, free: 990 * GB, total: 1000 * GB, answering: true, newDownloads: true },
      { id: "/mnt/old", mount: "/mnt/old", free: 2 * GB, total: 500 * GB, answering: true, newDownloads: false },
    ],
  }));
  assert.equal(s.state, "works", "a full drive that takes no new downloads is nobody's emergency");
  const line = Object.fromEntries(s.areas.map((a) => [a.id, a.line]));
  assert.equal(line.disk, `${Math.round((1095 * GB) / GB)} GB free on 2 drives`);
});

test("drives: one not answering — Needs you, with when and how many titles", () => {
  const since = new Date(2026, 10, 8, 15, 42).getTime();
  const s = decide(calm({
    drives: [
      { id: "/", mount: "/", free: 105 * GB, total: 502 * GB, answering: true, newDownloads: true },
      { id: "/mnt/storagespace", mount: "/mnt/storagespace", network: true, free: null, total: null, answering: false, downSince: since, newDownloads: true, titles: 37 },
    ],
  }));
  assert.equal(s.state, "needs-you");
  assert.equal(s.needs[0].id, "drive-down:/mnt/storagespace");
  assert.equal(s.needs[0].title, "A storage drive isn't answering");
  assert.equal(s.needs[0].why, "Storage drive /mnt/storagespace isn't answering since 15:42 — 37 titles can't play. New downloads go to the other drives until it answers again.");
  assert.equal(s.reason, `A storage drive isn't answering: ${s.needs[0].why}`);
  const disk = s.areas.find((a) => a.id === "disk");
  assert.equal(disk.level, "bad");
  assert.match(disk.line, /105 GB free · 1 drive not answering/);
});
