// How a file plays on a device (media/playpath.js) — the decision table over
// many file × device combinations — and the device reports it decides from
// (media/avcaps.js: the closed vocabulary, the clamps, the id).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const avcaps = require("../src/media/avcaps");
const pp = require("../src/media/playpath");

// ---------------------------------------------------------------- devices
// The realistic Mi TV / Amlogic profile (the orchestrator's device dump
// replaces it in the device checks): HEVC Main10 HDR10, H.264 High 5.1,
// VP9 Profile 2, no AV1, AC-3 / E-AC-3 passthrough.
const MITV = avcaps.normalize({
  client: "tv",
  model: "MiTV-AFMU0",
  sdk: 34,
  video: {
    h264: { profiles: ["baseline", "main", "high"], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 },
    hevc: { profiles: ["main", "main10"], maxW: 3840, maxH: 2160, maxFps: 60 },
    vp9: { profiles: ["0", "2"], maxW: 3840, maxH: 2160 },
    mpeg2: { maxW: 1920, maxH: 1080 },
    mpeg4: {},
  },
  hdr: ["hdr10", "hlg"],
  audio: { decode: ["aac", "ac3", "eac3", "mp3", "opus", "flac", "vorbis", "pcm", "mp2"], passthrough: ["ac3", "eac3", "eac3-joc"], maxChannels: 8 },
  containers: { mp4: true, mkv: true, webm: true, avi: true, ts: true, mov: true },
  display: { w: 1920, h: 1080, hz: 60, modes: [[1920, 1080, 60], [1920, 1080, 50], [1920, 1080, 24], [1920, 1080, 23.976]] },
});
const MITV_DTS = avcaps.normalize({ ...JSON.parse(JSON.stringify(MITV)), audio: { ...MITV.audio, passthrough: [...MITV.audio.passthrough, "dts", "dtshd", "truehd"] } });
const MITV_NO_PASS = avcaps.normalize({ ...JSON.parse(JSON.stringify(MITV)), audio: { decode: ["aac", "mp3", "opus", "flac", "vorbis", "pcm"], passthrough: [] } });
const CHROME = avcaps.normalize({
  client: "web",
  video: {
    h264: { profiles: ["baseline", "main", "high"] },
    hevc: { profiles: ["main", "main10"] },
    vp9: { profiles: ["0", "2"] },
    av1: { profiles: ["main"] },
    vp8: {},
  },
  hdr: ["hdr10", "hlg"],
  audio: { decode: ["aac", "mp3", "opus", "vorbis", "flac", "pcm"], passthrough: [] },
  containers: { mp4: ["h264", "hevc", "av1", "vp9"], webm: ["vp8", "vp9", "av1"], mkv: ["h264", "hevc", "vp9", "av1"] },
});
const CHROME_NO_HEVC = avcaps.normalize({ ...JSON.parse(JSON.stringify(CHROME)), video: { h264: { profiles: ["baseline", "main", "high"] }, vp9: { profiles: ["0", "2"] }, av1: { profiles: ["main"] } }, containers: { mp4: ["h264", "av1", "vp9"], webm: ["vp9", "av1"], mkv: ["h264", "vp9", "av1"] } });
const IPHONE = avcaps.normalize({
  client: "web",
  video: { h264: { profiles: ["baseline", "main", "high"] }, hevc: { profiles: ["main", "main10"] } },
  hdr: ["hdr10", "hlg", "dv"],
  dv: [5, 8],
  audio: { decode: ["aac", "ac3", "eac3", "mp3", "flac", "alac", "pcm"], passthrough: [] },
  containers: { mp4: ["h264", "hevc"], mov: ["h264", "hevc"] },
});
const FIREFOX = avcaps.normalize({
  client: "web",
  video: { h264: { profiles: ["baseline", "main", "high"] }, vp9: { profiles: ["0", "2"] }, av1: { profiles: ["main"] }, vp8: {} },
  audio: { decode: ["aac", "mp3", "opus", "vorbis", "flac"], passthrough: [] },
  containers: { mp4: ["h264", "vp9", "av1"], webm: ["vp8", "vp9", "av1"] },
});

// ---------------------------------------------------------------- files
const file = (o) => ({
  container: "mkv",
  width: 1920,
  height: 1080,
  video: { codec: "h264", bitDepth: 8, hdr: null, fps: 23.976, profile: null, dvProfile: null, dvCompat: null, ...(o.video || {}) },
  audio: o.audio || [{ index: 0, codec: "aac", channels: 2 }],
  ...(o.container ? { container: o.container } : {}),
  ...(o.width ? { width: o.width, height: o.height } : {}),
});
const H264_AAC_MP4 = file({ container: "mp4" });
const H264_AC3_MKV = file({ audio: [{ index: 0, codec: "ac3", channels: 6 }] });
const HEVC10_EAC3_MKV = file({ video: { codec: "hevc", bitDepth: 10, profile: "Main 10" }, audio: [{ index: 0, codec: "eac3", channels: 6 }] });
const HEVC10_ATMOS = file({ video: { codec: "hevc", bitDepth: 10 }, audio: [{ index: 0, codec: "eac3", channels: 6, atmos: true }] });
const HEVC_HDR10_TRUEHD = file({ width: 3840, height: 2160, video: { codec: "hevc", bitDepth: 10, hdr: "hdr10" }, audio: [{ index: 0, codec: "truehd", channels: 8, atmos: true }] });
const HEVC_DTS = file({ video: { codec: "hevc", bitDepth: 10 }, audio: [{ index: 0, codec: "dts", channels: 6 }] });
const HEVC_DTSHD = file({ video: { codec: "hevc", bitDepth: 10 }, audio: [{ index: 0, codec: "dtshd", channels: 8 }] });
const AV1_OPUS_MKV = file({ video: { codec: "av1", bitDepth: 10 }, audio: [{ index: 0, codec: "opus", channels: 6 }] });
const VP9_P2_WEBM = file({ container: "webm", video: { codec: "vp9", bitDepth: 10 }, audio: [{ index: 0, codec: "opus", channels: 2 }] });
const HI10P = file({ video: { codec: "h264", bitDepth: 10, profile: "High 10" } });
const DV_P5 = file({ container: "mp4", video: { codec: "hevc", bitDepth: 10, hdr: "dolby-vision", dvProfile: 5, dvCompat: 0 }, audio: [{ index: 0, codec: "eac3", channels: 6, atmos: true }] });
const DV_P8 = file({ video: { codec: "hevc", bitDepth: 10, hdr: "dolby-vision", dvProfile: 8, dvCompat: 1 }, audio: [{ index: 0, codec: "eac3", channels: 6 }] });
const MPEG2_AVI = file({ container: "avi", width: 720, height: 576, video: { codec: "mpeg2", bitDepth: 8, fps: 25 }, audio: [{ index: 0, codec: "mp2", channels: 2 }] });
const UHD_H264_120 = file({ width: 3840, height: 2160, video: { codec: "h264", fps: 120 } });
const VC1 = file({ video: { codec: "vc1" } });

const d = (f, caps, opts) => pp.decide(f, caps, opts);
const shape = (r) => `${r.mode}/${r.video}/${r.audio}`;

test("the table: file × device", () => {
  const rows = [
    // file, device, expected mode/video/audio
    [H264_AAC_MP4, MITV, "direct/direct/decode"],
    [H264_AAC_MP4, CHROME, "direct/direct/decode"],
    [H264_AAC_MP4, IPHONE, "direct/direct/decode"],
    [H264_AAC_MP4, FIREFOX, "direct/direct/decode"],
    // AC-3: the TV passes it through; Chrome cannot hear it (remux); iPhone decodes it but cannot open MKV
    [H264_AC3_MKV, MITV, "direct/direct/passthrough"],
    [H264_AC3_MKV, MITV_NO_PASS, "remux/copy/convert"],
    [H264_AC3_MKV, CHROME, "remux/copy/convert"],
    [H264_AC3_MKV, IPHONE, "remux/copy/decode"],
    [H264_AC3_MKV, FIREFOX, "remux/copy/convert"],
    // HEVC Main10 + E-AC-3 (most of the household library)
    [HEVC10_EAC3_MKV, MITV, "direct/direct/passthrough"],
    [HEVC10_EAC3_MKV, CHROME, "remux/copy/convert"],
    [HEVC10_EAC3_MKV, CHROME_NO_HEVC, "transcode/encode/convert"],
    [HEVC10_EAC3_MKV, IPHONE, "remux/copy/decode"],
    [HEVC10_EAC3_MKV, FIREFOX, "transcode/encode/convert"],
    // Atmos in E-AC-3 (JOC): passed through as E-AC-3 JOC
    [HEVC10_ATMOS, MITV, "direct/direct/passthrough"],
    // 4K HDR10 TrueHD Atmos: the Mi TV shows HDR10 but takes no TrueHD → the sound is the problem
    [HEVC_HDR10_TRUEHD, MITV, "remux/copy/convert"],
    [HEVC_HDR10_TRUEHD, MITV_DTS, "direct/direct/passthrough"],
    // DTS: "maybe" on the Mi TV — both ways
    [HEVC_DTS, MITV, "remux/copy/convert"],
    [HEVC_DTS, MITV_DTS, "direct/direct/passthrough"],
    [HEVC_DTSHD, MITV_DTS, "direct/direct/passthrough"],
    // AV1: no decoder on the Mi TV → encoded; Chrome plays it as it is
    [AV1_OPUS_MKV, MITV, "transcode/encode/decode"],
    [AV1_OPUS_MKV, CHROME, "direct/direct/decode"],
    // VP9 Profile 2 in WebM
    [VP9_P2_WEBM, MITV, "direct/direct/decode"],
    [VP9_P2_WEBM, CHROME, "direct/direct/decode"],
    [VP9_P2_WEBM, IPHONE, "transcode/encode/convert"],
    // Hi10P: nowhere
    [HI10P, MITV, "transcode/encode/decode"],
    [HI10P, CHROME, "transcode/encode/decode"],
    // Dolby Vision profile 5 (no fallback): only where DV shows
    [DV_P5, MITV, "transcode/encode/passthrough"],
    [DV_P5, IPHONE, "direct/direct/decode"],
    [DV_P5, CHROME, "transcode/encode/convert"],
    // Dolby Vision profile 8: its HDR10 layer on the Mi TV
    [DV_P8, MITV, "direct/direct/passthrough"],
    // old formats
    [MPEG2_AVI, MITV, "direct/direct/decode"],
    [MPEG2_AVI, CHROME, "transcode/encode/convert"],
    [VC1, MITV, "transcode/encode/decode"],
    // over the decoder's limits
    [UHD_H264_120, MITV, "transcode/encode/decode"],
  ];
  const wrong = [];
  for (const [f, caps, want] of rows) {
    const r = d(f, caps);
    if (shape(r) !== want) wrong.push(`${JSON.stringify(f.video)} ${f.container} ${f.audio[0].codec} on ${caps.client}/${caps.model || "-"}: got ${shape(r)} want ${want} — ${r.why.join(" | ")}`);
  }
  assert.deepEqual(wrong, []);
});

test("passthrough forms: Atmos rides as E-AC-3 JOC, DTS-HD falls back to its DTS core", () => {
  assert.equal(d(HEVC10_ATMOS, MITV).form, "eac3-joc");
  const noJoc = avcaps.normalize({ ...JSON.parse(JSON.stringify(MITV)), audio: { decode: ["aac"], passthrough: ["ac3", "eac3"] } });
  assert.equal(d(HEVC10_ATMOS, noJoc).form, "eac3");
  const dtsOnly = avcaps.normalize({ ...JSON.parse(JSON.stringify(MITV)), audio: { decode: ["aac"], passthrough: ["dts"] } });
  assert.equal(d(HEVC_DTSHD, dtsOnly).form, "dts");
  assert.equal(d(HEVC_DTSHD, dtsOnly).mode, "direct");
});

test('"Surround sound: Stereo only": nothing is passed through — decoded here, or made AAC', () => {
  const stereo = { prefs: { surround: "stereo" } };
  const r = d(HEVC10_EAC3_MKV, MITV, stereo);
  assert.equal(r.mode, "direct");
  assert.equal(r.audio, "decode"); // the Mi TV has an E-AC-3 decoder
  assert.match(r.why.join(" "), /stereo only/);
  // no decoder for DTS: the server makes it AAC
  assert.equal(shape(d(HEVC_DTS, MITV_DTS, stereo)), "remux/copy/convert");
  // AAC is not touched by the setting
  assert.equal(shape(d(H264_AAC_MP4, MITV, stereo)), "direct/direct/decode");
});

test("the chosen audio track decides (a multi-dub file)", () => {
  const f = file({ audio: [{ index: 0, codec: "aac", channels: 2 }, { index: 1, codec: "dts", channels: 6 }] });
  assert.equal(d(f, MITV).mode, "direct");
  assert.equal(d(f, MITV, { track: 1 }).mode, "remux");
  assert.deepEqual(d(f, MITV).tracks, [{ index: 0, audio: "decode" }, { index: 1, audio: "convert" }]);
});

test("profiles: a report that lists none means the codec's base profiles only", () => {
  const bare = avcaps.normalize({ client: "tv", video: { hevc: {}, h264: {} }, audio: { decode: ["aac"] }, containers: { mkv: true } });
  assert.equal(d(file({ video: { codec: "hevc", bitDepth: 8 } }), bare).mode, "direct");
  assert.equal(d(file({ video: { codec: "hevc", bitDepth: 10 } }), bare).mode, "transcode");
  assert.equal(d(file({}), bare).mode, "direct");
  // a higher profile's decoder plays the lower ones
  const hi10 = avcaps.normalize({ client: "tv", video: { h264: { profiles: ["high10"] } }, audio: { decode: ["aac"] }, containers: { mkv: true } });
  assert.equal(d(file({ video: { profile: "Main" } }), hi10).mode, "direct");
  assert.equal(d(HI10P, hi10).mode, "direct");
});

test("resolution limits read either way round (a portrait clip on a landscape decoder)", () => {
  const capped = avcaps.normalize({ client: "tv", video: { h264: { maxW: 1920, maxH: 1080 } }, audio: { decode: ["aac"] }, containers: { mp4: true } });
  assert.equal(d(file({ container: "mp4", width: 1080, height: 1920 }), capped).mode, "direct");
  assert.equal(d(file({ container: "mp4", width: 3840, height: 2160 }), capped).mode, "transcode");
});

test("HDR: a TV with no HDR gets the tone-mapped encode; a browser tone maps by itself", () => {
  const sdrTv = avcaps.normalize({ ...JSON.parse(JSON.stringify(MITV)), hdr: [] });
  const r = d(HEVC_HDR10_TRUEHD, sdrTv);
  assert.equal(r.mode, "transcode");
  assert.match(r.why.join(" "), /hdr10 and this screen shows no hdr10/);
  const sdrWeb = avcaps.normalize({ ...JSON.parse(JSON.stringify(CHROME)), hdr: [] });
  assert.equal(d(file({ container: "mp4", video: { codec: "hevc", bitDepth: 10, hdr: "hdr10" } }), sdrWeb).mode, "direct");
  // DV of an unprobed profile: its HDR10 layer is assumed (profile 7/8)
  const dvUnknown = file({ video: { codec: "hevc", bitDepth: 10, hdr: "dolby-vision" } });
  assert.equal(d(dvUnknown, MITV).mode, "direct");
  assert.match(d(dvUnknown, MITV).why.join(" "), /assumed 7\/8/);
});

test("the facts of a library item (the /api/item answer)", () => {
  const item = {
    container: "mkv", width: 1920, height: 800,
    video: { codec: "hevc", bitDepth: 10, hdr: null, fps: 23.976, profile: "Main 10" },
    audio: { index: 0, codec: "eac3", channels: 6, profile: "Dolby Digital Plus + Dolby Atmos", atmos: true },
    audioTracks: [{ index: 0, codec: "eac3", channels: 6 }, { index: 1, codec: "dts", channels: 6 }],
  };
  const f = pp.factsOfItem(item);
  assert.equal(f.container, "mkv");
  assert.equal(f.video.codec, "hevc");
  assert.equal(f.video.fps, 23.976);
  assert.equal(f.audio.length, 2);
  assert.equal(f.audio[0].atmos, true);
  assert.equal(pp.decide(f, MITV).form, "eac3-joc");
  assert.equal(pp.decide(f, MITV).fps, 23.976);
  // one track: the item's `audio`
  assert.deepEqual(pp.factsOfItem({ container: "m4v", video: { codec: "h264" }, audio: { codec: "pcm_s16le", channels: 2 } }).audio[0].codec, "pcm");
  assert.equal(pp.factsOfItem({ container: "m4v", video: { codec: "h264" } }).container, "mp4");
  assert.equal(pp.factsOfItem(null), null);
  // DTS-HD named in the profile
  assert.equal(pp.audioName("dts", "DTS-HD MA"), "dtshd");
  assert.equal(pp.audioName("dts", "DTS"), "dts");
});

test("the facts of a torrent release name (a guess)", () => {
  const f = pp.factsOfRelease("Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv", "2160p");
  assert.equal(f.video.codec, "hevc");
  assert.equal(f.video.hdr, "dolby-vision");
  assert.equal(f.video.dvCompat, 1);
  assert.equal(f.audio[0].codec, "eac3");
  assert.equal(f.audio[0].atmos, true);
  assert.equal(f.height, 2160);
  assert.equal(f.guessed, true);
  assert.equal(pp.decide(f, MITV).mode, "direct"); // its HDR10 layer, E-AC-3 JOC passed through
  const g = pp.factsOfRelease("Film.2019.1080p.BluRay.x264.DTS-HD.MA.5.1-GRP", "1080p");
  assert.deepEqual([g.video.codec, g.audio[0].codec, g.container], ["h264", "dtshd", "mkv"]);
  assert.equal(pp.decide(g, MITV).mode, "remux");
  assert.equal(pp.factsOfRelease("Film.2019.1080p.WEBRip.x264.AAC-YTS.mp4 Film 2019", "1080p").container, "mp4");
  assert.equal(pp.factsOfRelease("Film.2019.2160p.BluRay.REMUX.HEVC.TrueHD.7.1.Atmos-FGT").audio[0].codec, "truehd");
  assert.equal(pp.factsOfRelease("Film 1999 DVDRip XviD AC3").audio[0].codec, "ac3");
  assert.equal(pp.factsOfRelease("Film.2022.1080p.AV1.Opus").video.codec, "av1");
  // a 10-bit x265 release: Main10
  assert.equal(pp.factsOfRelease("Show.S01E01.1080p.x265.10bit").video.bitDepth, 10);
});

test("every answer says why, line by line", () => {
  const r = d(HEVC10_EAC3_MKV, CHROME);
  assert.ok(r.why.some((l) => /^video: hevc main10/.test(l)));
  assert.ok(r.why.some((l) => /^audio: eac3 neither decoded nor passed through/.test(l)));
  assert.ok(r.why.some((l) => /sound becomes AAC stereo/.test(l)));
  assert.equal(pp.decide(null, MITV), null);
  assert.equal(pp.decide(H264_AAC_MP4, null), null);
});

// ---------------------------------------------------------------- reports
test("reports: a closed vocabulary — unknown words dropped, numbers clamped", () => {
  const caps = avcaps.normalize({
    client: "tv",
    model: "<script>alert(1)</script> Mi TV",
    sdk: 3400,
    video: { hevc: { profiles: ["main10", "MAIN", "bogus"], maxW: 1e9, maxH: 2160, maxFps: "60" }, wmv9: {}, h264: true, av1: "yes" },
    hdr: ["HDR10", "hlg", "hdr11"],
    dv: [8, 5, 5, 99, "x"],
    audio: { decode: ["aac", "AAC", "mp9"], passthrough: ["eac3-joc", "dts", 7], maxChannels: 100 },
    containers: { mkv: true, mp4: ["h264", "nope"], flv: true },
    display: { w: 1920, h: 1080, hz: 60, modes: [[1920, 1080, 23.976], [0, 0, 0], "x"] },
    extra: { anything: 1 },
  });
  assert.equal(caps.model.includes("<"), false);
  assert.equal(caps.sdk, 0);
  assert.deepEqual(caps.video.hevc, { profiles: ["main", "main10"], maxH: 2160, maxFps: 60 });
  assert.deepEqual(caps.video.h264, { profiles: [] });
  assert.equal("wmv9" in caps.video, false);
  assert.equal("av1" in caps.video, false);
  assert.deepEqual(caps.hdr, ["hdr10", "hlg"]);
  assert.deepEqual(caps.dv, [5, 8]);
  assert.deepEqual(caps.audio, { decode: ["aac"], passthrough: ["dts", "eac3-joc"] });
  assert.deepEqual(caps.containers, { mkv: ["h264", "hevc"], mp4: ["h264"] });
  assert.deepEqual(caps.display.modes, [[1920, 1080, 23.976]]);
  assert.equal("extra" in caps, false);
  for (const bad of [null, "x", [], {}, { client: "phone" }]) assert.equal(avcaps.normalize(bad), null);
});

test("reports: the same report, the same id — whatever order it was written in", () => {
  const a = avcaps.normalize({ client: "web", video: { h264: {}, hevc: { profiles: ["main10", "main"] } }, audio: { decode: ["opus", "aac"] }, containers: { mp4: ["hevc", "h264"] } });
  const b = avcaps.normalize({ containers: { mp4: ["h264", "hevc"] }, audio: { decode: ["aac", "opus"] }, video: { hevc: { profiles: ["main", "main10"] }, h264: {} }, client: "web" });
  assert.equal(avcaps.idOf(a), avcaps.idOf(b));
  assert.match(avcaps.idOf(a), /^[0-9a-f]{16}$/);
  const c = avcaps.normalize({ client: "web", video: { h264: {} }, audio: { decode: ["aac"] } });
  assert.notEqual(avcaps.idOf(a), avcaps.idOf(c));
});

test("reports: kept, looked up by id, a few hundred at most", () => {
  const mem = { data: {}, saves: 0, save() { this.saves++; } };
  avcaps._setStore(mem);
  try {
    const k = avcaps.remember({ client: "tv", video: { h264: {} }, audio: { decode: ["aac"] }, containers: { mkv: true } }, 1000);
    assert.match(k.id, /^[0-9a-f]{16}$/);
    assert.deepEqual(avcaps.lookup(k.id), k.caps);
    assert.equal(avcaps.lookup("nope"), null);
    assert.equal(avcaps.lookup("../../etc/passwd"), null);
    assert.equal(avcaps.lookup("0123456789abcdef"), null);
    // the same report again within the hour: no write
    const saves = mem.saves;
    avcaps.remember({ client: "tv", video: { h264: {} }, audio: { decode: ["aac"] }, containers: { mkv: true } }, 2000);
    assert.equal(mem.saves, saves);
    assert.equal(avcaps.remember({ client: "fridge" }), null);
    for (let i = 0; i < avcaps.MAX_KEPT + 20; i++) avcaps.remember({ client: "web", model: `m${i}`, video: { h264: {} } }, 10000 + i);
    assert.equal(Object.keys(mem.data).length, avcaps.MAX_KEPT);
    // the oldest went first
    assert.equal(avcaps.lookup(k.id), null);
  } finally {
    avcaps._setStore(null);
  }
});
