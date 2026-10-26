// "Has it really come out, and is this a good copy?" (elia, 2026-10-26:
// "You immediately run to download it even if it's a CAM.") Every marker a
// release name can carry (src/media/releasekind.js), the names that only LOOK
// like one, the ranking that follows (src/media/torrent.js rankList), every
// automatic pick (smartdl, the second-source race), and the title page's
// sentence (src/media/releasestatus.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const kind = require("../src/media/releasekind");
const torrent = require("../src/media/torrent");
const { statusOf } = require("../src/media/releasestatus");
const { pickSource } = require("../src/media/smartdl")._internals;
const dlrace = require("../src/media/dlrace");

const TV = "Torrentio\n1080p";
const read = (title, name = TV) => kind.classify(name, title);
const pre = (title, name) => read(title, name).prerelease;

test("every pre-release marker is read, whatever the separators", () => {
  const cases = [
    ["Some.Film.2026.CAM.x264-GRP", "cam"],
    ["Some.Film.2026.HDCAM.x264-GRP", "cam"],
    ["Some Film (2026) HD-CAM 720p", "cam"],
    ["Some.Film.2026.HQCAM.XviD", "cam"],
    ["Some.Film.2026.CAMRip.x264", "cam"],
    ["Some_Film_2026_NEWCAM_x264", "cam"],
    ["Some Film [2026] [CAM]", "cam"],
    ["Some.Film.2026.TS.x264", "telesync"],
    ["Some.Film.2026.HDTS.x264", "telesync"],
    ["Some.Film.2026.HD-TS.x264", "telesync"],
    ["Some.Film.2026.HQTS.x264", "telesync"],
    ["Some.Film.2026.TELESYNC.x264", "telesync"],
    ["Some.Film.2026.TeleSync.x264", "telesync"],
    ["Some.Film.2026.PreDVD.x264", "telesync"],
    ["Some.Film.2026.PDVDRip.x264", "telesync"],
    ["Some.Film.2026.TC.x264", "telecine"],
    ["Some.Film.2026.HDTC.x264", "telecine"],
    ["Some.Film.2026.TELECINE.x264", "telecine"],
    ["Some.Film.2026.SCR.x264", "screener"],
    ["Some.Film.2026.DVDSCR.x264", "screener"],
    ["Some.Film.2026.BDSCR.x264", "screener"],
    ["Some.Film.2026.WEBSCR.x264", "screener"],
    ["Some.Film.2026.SCREENER.x264", "screener"],
    ["Some.Film.2026.DVDScreener.x264", "screener"],
    ["Some.Film.2026.1080p.HC.HDRip.x264", "hc"],
    ["Some Film 2026 1080p HC WEBRip", "hc"],
  ];
  for (const [title, want] of cases) assert.equal(pre(title), want, title);
  // a marker that says what it is anywhere — even before a year, or with none
  assert.equal(pre("HDCAM Some Film"), "cam");
  assert.equal(pre("[HDTS] Some Film 2026"), "telesync");
  assert.equal(pre("Some Film TELESYNC"), "telesync");
  // Torrentio's own quality word, on the second line of `name`
  assert.equal(pre("Some Film 2026", "Torrentio\nCAM"), "cam");
  assert.equal(pre("Some Film 2026", "Torrentio\nSCR"), "screener");
  assert.equal(pre("Some Film 2026", "Torrentio\nTeleSync"), "telesync");
  // a real cinema copy outranks "HC" when both are there
  assert.equal(pre("Some.Film.2026.HC.HDCAM.x264"), "cam");
});

test("every burned-in subtitle marker is read", () => {
  for (const title of [
    "Some.Film.2026.1080p.WEBRip.HARDSUB.x264",
    "Some.Film.2026.1080p.WEBRip.HardSubs.x264",
    "Some.Film.2026.1080p.WEBRip.Hardsubbed",
    "Some Film 2026 Sub ita hardcoded",
    "Some.Film.2026.HARDCODED.ENG.SUBS",
    "Some.Film.2026.KORSUB.1080p.HDRip",
    "Some.Film.2026.KORSUBS.720p",
    "Some.Film.2026.1080p.KOR.SUB.HDRip",
    "Some.Film.2026.1080p.Hard.Sub.x264",
    "Some.Film.2026.1080p.HC.HDRip",
  ]) {
    assert.equal(read(title).hardsub, true, title);
  }
  // burned-in subtitles alone are not a pre-release copy (HC is both)
  assert.equal(read("Some.Film.2026.KORSUB.1080p.HDRip").prerelease, null);
  assert.equal(read("Some.Film.2026.KORSUB.1080p.HDRip").cam, false);
  assert.equal(read("Some.Film.2026.1080p.HC.HDRip").cam, true);
});

test("names that only LOOK like a marker are not one", () => {
  const clean = [
    "Camille.Claudel.1988.1080p.BluRay.x264",          // CAM at the start of a word
    "Cam.2018.1080p.WEB-DL.DD5.1",                      // a film called Cam
    "CAM.2018.1080p.WEBRip.x264",                       // …even in capitals, before its year
    "Scream.2022.1080p.WEB-DL.DD5.1.H.264",             // "SCR" inside a word
    "Scrooged.1988.1080p.BluRay",
    "Ghosts.2021.S01E01.1080p.WEB",                     // "TS" inside a word
    "The.Cats.2026.1080p.WEB-DL",
    "Some.Film.2026.1080p.BluRay.DTS-HD.MA.5.1",        // DTS is not TS
    "Some.Film.2026.1080p.WEB-DL.DDP5.1.Atmos",
    "TS.Eliot.The.Waste.Land.2020.1080p.WEB",           // a title, before the year
    "TC.The.Story.2019.1080p.WEB",
    "Some.Film.2026.1080p.WEB-DL.ts",                   // a file extension
    "movie.ts",
    "Some.Film.2026.1080p.TCM.Broadcast",               // TCM is not TC
    "Some.Film.2026.1080p.HCTV",                        // HCTV is not HC
    "Hardcore.Henry.2015.1080p.BluRay",                 // hardcore is not hardcoded
    "Telescope.2026.1080p.WEB",
    "Camera.Obscura.2026.1080p.WEB",
    "Some.Film.2026.1080p.WEB-DL.Subbed",               // soft subtitles say nothing
    "Some Film 2026 1080p WEB-DL ts",                   // lowercase "ts" is a word fragment, not a marker
    "Cats & Dogs 2001 1080p BluRay",
    "Some.Film.2026.1080p.WEB-DL\n👤 120 💾 2.1 GB ⚙️ TheTSProvider", // the info line is not the name
  ];
  for (const title of clean) {
    const r = read(title);
    assert.equal(r.prerelease, null, `pre-release? ${title}`);
    assert.equal(r.hardsub, false, `burned-in? ${title}`);
    assert.equal(r.cam, false, title);
    assert.equal(r.warning, null, title);
  }
});

test("the words a row shows: badge and sentence, one wording for both apps", () => {
  assert.deepEqual(
    { badge: read("Some.Film.2026.HDCAM").badge, warning: read("Some.Film.2026.HDCAM").warning },
    { badge: "CAM", warning: "CAM — filmed in a cinema" },
  );
  assert.equal(read("Some.Film.2026.HDTS").warning, "TS — recorded in a cinema");
  assert.equal(read("Some.Film.2026.TC").warning, "TC — copied from a cinema reel");
  assert.equal(read("Some.Film.2026.DVDSCR").warning, "Screener — an early preview copy");
  assert.equal(read("Some.Film.2026.HC.HDRip").warning, "HC — an early copy with subtitles burned in");
  assert.equal(read("Some.Film.2026.KORSUB.HDRip").warning, "Subtitles burned into the picture");
  assert.equal(read("Some.Film.2026.KORSUB.HDRip").badge, "BURNED-IN SUBS");
});

// ---------- the ranking ----------
const row = (title, { seeders = 100, size = "2.1 GB", quality = "1080p", hash } = {}) => ({
  name: `Torrentio\n${quality}`,
  title: `${title}\n👤 ${seeders} 💾 ${size} ⚙️ Prov\n🇬🇧`,
  infoHash: (hash || title.replace(/[^a-z0-9]/gi, "")).toLowerCase().padEnd(40, "0").slice(0, 40),
  fileIdx: 0,
});

test("the list: clean copies first, burned-in subtitles after them, cinema copies last — still listed, marked", () => {
  const list = torrent._internals.rankList([
    row("Film.2026.1080p.HDCAM.x264", { seeders: 3000, hash: "a" }),
    row("Film.2026.1080p.KORSUB.HDRip", { seeders: 2000, hash: "b" }),
    row("Film.2026.720p.WEB-DL.x264", { seeders: 4, quality: "720p", hash: "c" }),
    row("Film.2026.1080p.DVDSCR", { seeders: 900, hash: "d" }),
    row("Film.2026.1080p.WEB-DL.x264", { seeders: 40, hash: "e" }),
  ], "movie");
  assert.deepEqual(list.map((s) => s.infoHash[0]), ["e", "c", "b", "a", "d"]);
  assert.equal(list.filter((s) => s.recommended).length, 1);
  assert.equal(list[0].recommended, true, "the ★ Best is a clean copy, however few seed it");
  const cam = list.find((s) => s.infoHash[0] === "a");
  assert.deepEqual([cam.cam, cam.prerelease, cam.badge, cam.warning], [true, "cam", "CAM", "CAM — filmed in a cinema"]);
  assert.equal(list.find((s) => s.infoHash[0] === "b").hardsub, true);
  // the old CAM tag is gone from `tags` (the badge says it once)
  assert.ok(!cam.tags.includes("CAM"));
});

test("nothing but cinema copies: no ★ Best at all; burned-in only: that one is the Best", () => {
  const cams = torrent._internals.rankList([
    row("Film.2026.1080p.HDCAM", { seeders: 3000, hash: "a" }),
    row("Film.2026.HDTS", { seeders: 50, hash: "b" }),
    row("Film.2026.1080p.HC.HDRip", { seeders: 500, hash: "c" }),
  ], "movie");
  assert.equal(cams.some((s) => s.recommended), false);
  assert.equal(cams.length, 3, "still listed");
  const hard = torrent._internals.rankList([row("Film.2026.1080p.KORSUB.HDRip", { hash: "k" })], "movie");
  assert.equal(hard[0].recommended, true);
  // a dub is never the Best either
  const dub = torrent._internals.rankList([
    { ...row("Film.2026.1080p.WEB-DL.DUBBED", { hash: "d", seeders: 900 }), title: "Film.2026.1080p.WEB-DL.DUBBED\n👤 900 💾 2 GB ⚙️ P\n🇮🇹" },
    row("Film.2026.1080p.WEB-DL", { hash: "e", seeders: 3 }),
  ], "movie");
  assert.equal(dub.find((s) => s.recommended).infoHash[0], "e");
});

test("the value score sinks a pre-release copy and pushes burned-in subtitles under every clean one", () => {
  const v = torrent._internals.valueScore;
  const base = { quality: "1080p", seeders: 100, sizeBytes: 2 * 1024 ** 3 };
  assert.equal(v({ ...base, cam: true }), -1e6);
  assert.equal(v({ ...base, prerelease: "screener" }), -1e6);
  assert.ok(v({ ...base, hardsub: true, seeders: 3000 }) < v({ ...base, quality: "SD", seeders: 0 }));
});

test("the cache version moved: lists ranked by the old rules are recomputed", () => {
  assert.ok(torrent._internals.STREAMS_V >= 6);
  assert.equal(torrent._internals.liveStreams({ at: Date.now(), v: 5, streams: [] }, Date.now()), false);
});

// ---------- every automatic pick ----------
test("smart downloads (and follows, which use the same pick) never start a pre-release copy; burned-in only without a clean one", () => {
  const S = (o) => ({ infoHash: "x".repeat(40), quality: "1080p", ...o });
  assert.equal(pickSource([S({ cam: true, prerelease: "cam", recommended: false })], null), null);
  assert.equal(pickSource([S({ prerelease: "screener" })], null), null);
  assert.equal(pickSource([S({ cam: true }), S({ prerelease: "hc", hardsub: true })], "1080p"), null);
  const clean = S({ infoHash: "c".repeat(40), quality: "720p" });
  const hard = S({ infoHash: "h".repeat(40), hardsub: true, recommended: true });
  assert.equal(pickSource([hard, clean], "1080p"), clean, "a clean 720p before a burned-in 1080p");
  assert.equal(pickSource([hard], "1080p"), hard);
});

test("the second-source race never takes a pre-release copy, nor burned-in subtitles for a clean original", () => {
  const cfg = dlrace.resolveConfig(undefined);
  const job = { infoHash: "a".repeat(40), quality: "1080p", sizeBytes: 2e9 };
  const S = (c, o = {}) => ({ infoHash: c.repeat(40), fileIdx: 0, quality: "1080p", sizeBytes: 2e9, seeders: 50, ...o });
  const streams = [S("a"), S("b", { prerelease: "telesync", cam: true }), S("c", { hardsub: true }), S("d")];
  const r = dlrace.chooseChallenger({ job, streams, history: {}, live: [], cfg, now: Date.now() });
  assert.equal(r.source.infoHash, "d".repeat(40));
  const none = dlrace.chooseChallenger({ job, streams: streams.slice(0, 3), history: {}, live: [], cfg, now: Date.now() });
  assert.equal(none.source, null);
  // an original that has burned-in subtitles may race another one
  const hardJob = dlrace.chooseChallenger({ job, streams: [S("a", { hardsub: true }), S("c", { hardsub: true })], history: {}, live: [], cfg, now: Date.now() });
  assert.equal(hardJob.source.infoHash, "c".repeat(40));
});

// ---------- the title page's sentence ----------
test("release status: good copies say nothing; only cinema copies say so plainly; nothing and not out at home says that", () => {
  const now = Date.UTC(2026, 9, 26);
  const DAY = 86400e3;
  const good = [{ seeders: 5 }, { seeders: 900, cam: true, prerelease: "cam" }];
  assert.deepEqual(statusOf({ streams: good, now }), { state: "good", line: null, note: null });
  const cams = [{ seeders: 900, cam: true, prerelease: "cam" }, { seeders: 30, cam: true, prerelease: "telesync" }, { seeders: 0 }];
  assert.deepEqual(statusOf({ streams: cams, now, avail: { home: false, homeAt: null, theatricalAt: now - 20 * DAY } }), {
    state: "early-only",
    line: "Not out in good quality yet — only cinema recordings so far",
    note: "In cinemas since 6 Oct 2026",
  });
  // a dead clean torrent is not a good copy
  assert.equal(statusOf({ streams: cams, now }).state, "early-only");
  // screeners / HC: "early copies", not "cinema recordings"
  assert.equal(statusOf({ streams: [{ seeders: 9, cam: true, prerelease: "screener" }], now }).line, "Not out in good quality yet — only early copies so far");
  // a home date to come, and one that has passed
  assert.equal(statusOf({ streams: cams, now, avail: { home: false, homeAt: now + 19 * DAY, theatricalAt: now - 20 * DAY } }).note, "Out to stream or buy from 14 Nov 2026");
  assert.equal(statusOf({ streams: cams, now, avail: { home: true, homeAt: now - DAY, theatricalAt: now - 40 * DAY } }).note, "Out to stream or buy since 25 Oct 2026");
  // no copies at all
  assert.deepEqual(statusOf({ streams: [], now, avail: { home: false, homeAt: null, theatricalAt: now + 5 * DAY } }), {
    state: "not-out", line: "Not out to watch at home yet", note: "In cinemas from 31 Oct 2026",
  });
  assert.equal(statusOf({ streams: [], now }), null, "no copies and no dates: nothing to say");
  assert.equal(statusOf({ streams: [], now, avail: { home: true, homeAt: now - DAY, theatricalAt: now - 50 * DAY } }), null);
  assert.equal(statusOf({ type: "series", streams: cams, now }), null, "a show: not this page's question");
  // burned-in subtitles are a real copy
  assert.equal(statusOf({ streams: [{ seeders: 4, hardsub: true }], now }).state, "good");
});
