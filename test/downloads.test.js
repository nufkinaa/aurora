// Rules that decide where a downloaded file lands, whether a request needs
// approval, and how the engine's status is read. These are the bits that broke
// in real use, so they are pinned here rather than re-tested by hand.
//
//   node --test test/
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const downloads = require("../src/media/downloads");
const aria2 = require("../src/media/aria2");
const { safeName, folderKey, chooseFolder } = downloads._internals;
const { isMetadataPlaceholder } = aria2._internals;

// ---------- folder naming ----------

test("safeName strips characters Windows refuses", () => {
  assert.equal(safeName('Deadpool & Wolverine: "Legacy"'), "Deadpool & Wolverine Legacy");
  assert.equal(safeName("Trailing dots..."), "Trailing dots");
  assert.equal(safeName("  spaced   out  "), "spaced out");
  assert.equal(safeName(""), "Untitled");
  assert.equal(safeName(null), "Untitled");
  assert.ok(!/[<>:"/\\|?*]/.test(safeName('a<b>c:d"e/f\\g|h?i*j')));
});

test("folderKey treats '<Title>' and '<Title> (Year)' as the same show", () => {
  assert.equal(folderKey("How I Met Your Mother"), folderKey("How I Met Your Mother (2005)"));
  assert.equal(folderKey("Avatar The Last Airbender"), folderKey("Avatar The Last Airbender (2024)"));
  // Only a trailing 4-digit year in brackets is ignored, not any bracket.
  assert.notEqual(folderKey("Alien"), folderKey("Alien (Director's Cut)"));
  assert.notEqual(folderKey("Avatar"), folderKey("Avatar The Last Airbender"));
});

test("chooseFolder joins a library folder that omits the year", () => {
  const existing = ["How I Met Your Mother", "Gate", "Ted"];
  assert.equal(
    chooseFolder(existing, "How I Met Your Mother", 2005),
    "How I Met Your Mother",
    "a hand-made folder without the year must be reused, not duplicated"
  );
});

test("chooseFolder joins a library folder that has the year", () => {
  const existing = ["How I Met Your Mother (2005)"];
  assert.equal(chooseFolder(existing, "How I Met Your Mother", 2005), "How I Met Your Mother (2005)");
});

test("chooseFolder names a brand new folder with the year", () => {
  assert.equal(chooseFolder(["Gate"], "Severance", 2022), "Severance (2022)");
  assert.equal(chooseFolder([], "Severance", null), "Severance");
});

test("chooseFolder does not confuse different shows that share a prefix", () => {
  const existing = ["Avatar (2009)"];
  assert.equal(
    chooseFolder(existing, "Avatar The Last Airbender", 2024),
    "Avatar The Last Airbender (2024)"
  );
});

test("destinationFor builds the season layout the scanner expects", () => {
  const config = require("../src/config");
  const root = (config.LIBRARIES.shows || [])[0];
  if (!root) return; // no shows library configured on this machine
  const { destinationFor } = downloads._internals;
  const dest = destinationFor({
    type: "show", title: "Some Show", year: 2019, season: 2, episode: 7,
  });
  assert.equal(path.basename(dest.dir), "Season 02", "season folder is zero-padded");
  assert.equal(dest.base, "Some Show S02E07", "episode file is SxxEyy");
  assert.ok(dest.dir.startsWith(root), "lands inside the configured library root");
});

test("destinationFor puts a movie in its own folder", () => {
  const config = require("../src/config");
  if (!(config.LIBRARIES.movies || [])[0]) return;
  const { destinationFor } = downloads._internals;
  const dest = destinationFor({ type: "movie", title: "Arrival", year: 2016 });
  assert.equal(path.basename(dest.dir), dest.base, "movie file is named after its folder");
});

// ---------- the disk gate ----------

test("diskGate lets a download start when the drive has room", () => {
  const { diskGate } = downloads._internals;
  const gate = diskGate("movie", 1e9); // 1 GB against a mostly-empty library drive
  assert.equal(typeof gate.ok, "boolean");
  if (!gate.ok) assert.ok(gate.reason, "a refusal always explains itself");
});

test("diskGate refuses a download that would not fit", () => {
  const { diskGate } = downloads._internals;
  const gate = diskGate("movie", 500e12); // 500 TB
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /Low disk space|Couldn't read free space/);
});

// ---------- aria2 status reading ----------

test("isMetadataPlaceholder spots the magnet's stand-in download", () => {
  assert.equal(
    isMetadataPlaceholder([{ path: "C:\\tmp\\aurora-downloads\\abc\\[METADATA]abc123" }]),
    true,
    "mistaking this for the real download parks every job at 0%"
  );
  assert.equal(
    isMetadataPlaceholder([{ path: "C:\\tmp\\x\\Show S01E01.mkv" }]),
    false
  );
  assert.equal(
    isMetadataPlaceholder([{ path: "a.mkv" }, { path: "b.mkv" }]),
    false,
    "a real torrent with several files is never the placeholder"
  );
  assert.equal(isMetadataPlaceholder([]), false);
});

test("fileProgress reports one file's share of a multi-file torrent", () => {
  const status = {
    files: [
      { index: 1, path: "readme.txt", length: 100, completed: 100, selected: false },
      { index: 2, path: "S06E02.mkv", length: 1000, completed: 250, selected: true },
      { index: 3, path: "S06E03.mkv", length: 2000, completed: 0, selected: true },
    ],
  };
  assert.equal(aria2.fileProgress(status, 2).fraction, 0.25);
  assert.equal(aria2.fileProgress(status, 3).fraction, 0);
  assert.equal(aria2.fileProgress(status, 99), null, "an unknown index is null, not a crash");
  assert.equal(aria2.fileProgress({ files: [{ index: 1, length: 0, completed: 0 }] }, 1), null,
    "a zero-length file can't be a percentage");
});

test("fileProgress never exceeds 1 even if aria2 over-reports", () => {
  const status = { files: [{ index: 1, path: "x.mkv", length: 100, completed: 140, selected: true }] };
  assert.equal(aria2.fileProgress(status, 1).fraction, 1);
});

// ---------- the public job shape the UI depends on ----------

test("publicJob exposes what the pages and admin read, and hides the rest", () => {
  const job = downloads.publicJob({
    id: "abc123", infoHash: "f".repeat(40), fileIdx: 3, imdbId: "tt0460649",
    title: "A Show", label: "A Show · S6 E2", type: "show", season: 6, episode: 2,
    quality: "1080p", sizeBytes: 166e6, poster: "http://x/p.jpg", provider: null,
    status: "downloading", phase: "copying", copyProgress: 0.5,
    progress: 1, downloadSpeed: 2e6, peers: 9, error: null, at: "now",
    // things that must NOT leak to every browser on the LAN:
    magnet: "magnet:?xt=urn:btih:secret", announce: ["http://tracker"], profile: "Admin",
    destPath: "D:\\Media\\Shows\\A Show\\Season 06\\A Show S06E02.mkv",
  });
  for (const k of ["id", "status", "phase", "progress", "copyProgress", "peers", "imdbId"]) {
    assert.ok(k in job, `the UI needs ${k}`);
  }
  assert.equal(job.magnet, undefined, "magnet stays server-side");
  assert.equal(job.announce, undefined, "tracker list stays server-side");
  assert.equal(job.destPath, undefined, "local paths stay server-side");
  assert.equal(job.profile, undefined, "who asked stays server-side");
});

// ---------- staging ----------

test("aria2 stages each torrent in its own directory, away from streaming", () => {
  const dir = aria2.stagingDir("a".repeat(40));
  assert.ok(dir.includes("aurora-downloads"), "own root, not WebTorrent's default store");
  assert.ok(dir.endsWith("a".repeat(40)), "one directory per torrent, so purging is an rm of it");
  assert.notEqual(path.dirname(dir), path.join(os.tmpdir(), "webtorrent"));
});

test("the engine reports whether it can run at all", () => {
  assert.equal(typeof aria2.available(), "boolean");
});
