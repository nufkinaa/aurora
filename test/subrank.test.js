// Which provider subtitles are offered first (media/websubs.js rank), the
// names of the subtitle files inside a torrent (media/torrent.js), and the
// remembered subtitle delay (public/js/subdelay.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const websubs = require("../src/media/websubs");

// Inception's Hebrew list as the providers really answered it (2026-10-17,
// trimmed): Wizdom in its own order with every score 0; OpenSubtitles with two
// Telesyncs timed at 25 fps.
const WZ = [
  "Inception.2010.1080p.AC3.Blu-ray.PS3-TEAM", "Inception.2010.1080p.BDRip.x264.DTS-ViSiON",
  "Inception.2010.1080p.BluRay.DTS.DXVA.x264-TiMPE", "Inception.2010.1080p.BluRay.DTS.x264-CtrlHD",
  "Inception.2010.720p.BRRip.XviD-TiMPE", "Inception.2010.R5.XviD-Rx",
].map((r, i) => ({ provider: "wz", ref: String(i), lang: "heb", langName: "Hebrew", release: r, note: r, score: 0 }));
const OS = [
  { provider: "os", ref: "u1", lang: "heb", langName: "Hebrew", release: "inception.internal.telesync.720p.x264-orc", fps: 25 },
  { provider: "os", ref: "u2", lang: "heb", langName: "Hebrew", release: "Inception.2010.TS.V2.XviD-PrisM", fps: 25 },
  { provider: "os", ref: "u3", lang: "eng", langName: "English", release: "Inception.2010.1080p.BluRay.x264-CtrlHD", fps: 23.976 },
];

test("the release being watched decides the order: same group and source first, cams last", () => {
  const r = websubs.rank(OS, WZ, { release: "Inception.2010.1080p.BluRay.x264-CtrlHD.mkv", fps: 23.976 });
  const heb = r.filter((t) => t.lang === "heb");
  assert.equal(heb[0].release, "Inception.2010.1080p.BluRay.DTS.x264-CtrlHD", "the CtrlHD file first");
  assert.equal(heb[0].label, "Hebrew");
  const last3 = heb.slice(-3).map((t) => t.release);
  assert.ok(last3.every((x) => /telesync|\.TS\.|R5/i.test(x)), `cams and screeners last: ${last3.join(", ")}`);
  assert.deepEqual(heb.map((t) => t.label).slice(0, 3), ["Hebrew", "Hebrew 2", "Hebrew 3"]);
});

test("a WEB-DL from one service prefers that service's files", () => {
  const cands = [
    { provider: "wz", ref: "a", lang: "heb", release: "Silo.S03E03.1080p.ATVP.WEB-DL.DDP5.1.H.264-NTb" },
    { provider: "wz", ref: "b", lang: "heb", release: "Silo.S03E03.720p.HDTV.x264-KILLERS" },
    { provider: "wz", ref: "c", lang: "heb", release: "Silo.S03E03.1080p.WEB.h264-ETHEL" },
  ];
  const r = websubs.rank([], cands, { release: "Silo.S03E03.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv" });
  assert.equal(r[0].ref, "a");
  assert.equal(r[r.length - 1].ref, "b", "the HDTV cut last");
});

test("without a release, the providers' interleaved order stands — except cams, which go last", () => {
  const r = websubs.rank(OS, WZ).filter((t) => t.lang === "heb");
  assert.equal(r[0].provider, "wz");
  assert.ok(!/telesync|\.TS\./i.test(r[0].release + r[1].release));
  assert.ok(/telesync|\.TS\.|R5/i.test(r[r.length - 1].release));
});

test("an edition mismatch costs, a cam costs more", () => {
  const t = "Movie.2019.Extended.1080p.BluRay.x264-GRP";
  assert.ok(websubs.releaseScore(t, "Movie.2019.Extended.1080p.BluRay.x264-OTHER") > websubs.releaseScore(t, "Movie.2019.1080p.BluRay.x264-OTHER"));
  assert.ok(websubs.releaseScore(t, "Movie.2019.HDCAM.x264-GRP") < 0);
});

test("the subtitle files inside a torrent are named by language", () => {
  // torrent.js loads its engine lazily; the helper is plain
  const torrent = require("../src/media/torrent");
  const files = ["Movie.2019.1080p.WEB-DL.mkv", "Subs/2_English.srt", "Subs/3_Hebrew.srt", "Movie.heb.srt", "Movie.en.forced.srt", "Subs/English.SDH.srt", "It.Follows.2014.srt"];
  const subs = torrent.torrentSubtitles({ files: files.map((name) => ({ name })) }, "a".repeat(40));
  assert.deepEqual(subs.map((s) => [s.label, s.lang || null]), [
    ["English", "en"], ["Hebrew", "he"], ["Hebrew 2", "he"], ["English (Forced)", "en"], ["English (SDH)", "en"], ["It.Follows.2014", null],
  ]);
});

// ---------- the remembered delay ----------
const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
};

test("a delay is remembered per title and track, survives a cache-buster, and Reset forgets it", async () => {
  const d = await import("../public/js/subdelay.js");
  const st = memory();
  d.saveDelay(st, "film1", "/stream/subtitle/abc", 1.5);
  d.saveDelay(st, "film1", "/stream/subtitle/def", -0.5);
  assert.equal(d.savedDelay(st, "film1", "/stream/subtitle/abc"), 1.5);
  assert.equal(d.savedDelay(st, "film1", "/stream/subtitle/abc?retry=1700000000000"), 1.5, "a reload's cache-buster is the same track");
  assert.equal(d.savedDelay(st, "film1", "/stream/subtitle/def"), -0.5);
  assert.equal(d.savedDelay(st, "film2", "/stream/subtitle/abc"), 0, "per title");
  d.saveDelay(st, "film1", "/stream/subtitle/abc", 0);
  assert.equal(d.savedDelay(st, "film1", "/stream/subtitle/abc"), 0);
  assert.ok(!JSON.parse(st.getItem(d.SUBDELAY_KEY))["film1|/stream/subtitle/abc"], "0 is no entry at all");
  assert.equal(d.trackKey("x", "/stream/websub?p=os&r=u&retry=5"), "x|/stream/websub?p=os&r=u");
});

test("only the newest delays are kept, and a broken store reads as none", async () => {
  const d = await import("../public/js/subdelay.js");
  const st = memory();
  for (let i = 0; i < d.SUBDELAY_MAX + 20; i++) d.saveDelay(st, `t${i}`, "/s", 1, 1000 + i);
  const all = JSON.parse(st.getItem(d.SUBDELAY_KEY));
  assert.equal(Object.keys(all).length, d.SUBDELAY_MAX);
  assert.ok(!all["t0|/s"] && all[`t${d.SUBDELAY_MAX + 19}|/s`]);
  st.setItem(d.SUBDELAY_KEY, "{nope");
  assert.equal(d.savedDelay(st, "t5", "/s"), 0);
  assert.equal(d.savedDelay(null, "t5", "/s"), 0);
});
