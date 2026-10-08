// Tone-mapped HDR re-encodes (src/media/tonemap.js): the decision is pure, so
// it is tested here without ffmpeg. The promises this file holds the code to:
// SDR sources and copy jobs get exactly the arguments they always got; only a
// real, mappable HDR source gets a filter; the downscale comes before the
// expensive linear-light step; and the feature can be switched off.
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const tonemap = require("../src/media/tonemap");
const remux = require("../src/media/remux");
const transcode = require("../src/media/torrent-transcode");

const FAST = { ok: true, zscale: true, tonemap: true, mpps: 235 }; // the dev machine
const ON = {}; // an environment with no AURORA_TONEMAP set
const pq = { transfer: "smpte2084", primaries: "bt2020", matrix: "bt2020nc", pixFmt: "yuv420p10le", width: 1920, height: 1080, fps: 24 };
const hlg = { ...pq, transfer: "arib-std-b67", fps: 25 };
const f = (o) => tonemap.filterFor({ available: FAST, env: ON, ...o });

test("an SDR source never gets a filter", () => {
  assert.equal(f({ ...pq, transfer: "bt709", primaries: "bt709", matrix: "bt709" }), null);
  assert.equal(f({ ...pq, transfer: "bt709" }), null); // 10-bit SDR, BT.2020 or not
  assert.equal(f({ ...pq, transfer: null }), null); // unknown = SDR = today's behaviour
  assert.equal(f({ ...pq, transfer: "unknown" }), null);
  assert.equal(f({}), null);
  assert.equal(tonemap.isHdr(null), false);
  assert.equal(tonemap.isHdr({ transfer: "bt2020-10" }), false);
  assert.equal(tonemap.vfFor(null, { scale: "scale=min(1920\\,iw):-2" }), null);
});

test("PQ and HLG each get one chain, told what the input is, ending in BT.709 8-bit", () => {
  const a = f(pq);
  const b = f(hlg);
  assert.equal(typeof a, "string");
  assert.match(a, /zscale=tin=smpte2084:pin=bt2020:min=bt2020nc:t=linear:npl=100:p=bt709/);
  assert.match(b, /zscale=tin=arib-std-b67:pin=bt2020:min=bt2020nc:t=linear:npl=100:p=bt709/);
  for (const c of [a, b]) {
    assert.match(c, /,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p$/);
    assert.equal(c.includes(" "), false);
  }
  assert.equal(tonemap.hdrKind(pq), "pq");
  assert.equal(tonemap.hdrKind(hlg), "hlg");
  assert.equal(tonemap.hdrKind({ transfer: "SMPTE2084" }), "pq");
  // colour tags the probe could not read default to BT.2020; a full-range source says so
  assert.match(f({ ...pq, primaries: null, matrix: undefined }), /pin=bt2020:min=bt2020nc:t=linear/);
  assert.match(f({ ...pq, range: "pc" }), /min=bt2020nc:rin=pc:t=linear/);
  // ...but colours it does not recognise are not guessed at
  assert.equal(f({ ...pq, matrix: "ictcp" }), null);
  assert.equal(f({ ...pq, primaries: "film" }), null);
});

test("the job's own scale comes first — downscale before linearising", () => {
  const full = "scale=min(1920\\,iw):-2";
  const cap = "scale=-2:min(720\\,ih)";
  const a = f({ ...pq, width: 3840, height: 2160, scale: full });
  assert.ok(a.startsWith(full + ",zscale="));
  const b = f({ ...pq, width: 3840, height: 2160, outHeight: 720, scale: cap });
  assert.ok(b.startsWith(cap + ",zscale="));
  for (const c of [a, b]) {
    assert.ok(c.indexOf("scale=") === 0 && c.indexOf("scale=") < c.indexOf("t=linear"));
    assert.equal(c.split(",scale=").length, 1); // one scale, at the front
  }
  // with no scale handed in, the same expressions remux.js uses
  assert.ok(f({ ...pq, width: 3840, height: 2160 }).startsWith(full + ","));
  assert.ok(f({ ...pq, width: 3840, height: 2160, outHeight: 480 }).startsWith("scale=-2:min(480\\,ih),"));
  assert.equal(remux._internals.scaleFor(null), full);
  assert.equal(remux._internals.scaleFor({ h: 720 }), cap);
  assert.equal(transcode._internals.SCALE, full);
});

test("Dolby Vision without an HDR10/HLG base layer is left alone", () => {
  assert.equal(f({ ...pq, dv: { profile: 5, compat: 0 } }), null);
  assert.equal(f({ ...pq, dv: { profile: 5, compat: null } }), null);
  assert.equal(f({ ...pq, dv: { profile: null, compat: null } }), null); // a DV record we cannot read
  assert.equal(f({ ...pq, dv: { profile: 10, compat: 0 } }), null); // AV1 DV, no base
  assert.equal(f({ ...pq, dv: { profile: 8, compat: 2 } }), null); // SDR base
  assert.equal(tonemap.decide({ ...pq, dv: { profile: 5, compat: 0 }, available: FAST, env: ON }).why, "dolby-vision-base");
  // profile 8.1 / 7 carry a real HDR10 picture, 8.4 an HLG one: those map
  assert.match(f({ ...pq, dv: { profile: 8, compat: 1 } }), /tin=smpte2084/);
  assert.match(f({ ...pq, dv: { profile: 7, compat: 6 } }), /tin=smpte2084/);
  assert.match(f({ ...hlg, dv: { profile: 8, compat: 4 } }), /tin=arib-std-b67/);
  assert.match(f({ ...pq, dv: { profile: 8, compat: null } }), /tin=smpte2084/);
});

test("kill switch: AURORA_TONEMAP=0 turns it off", () => {
  for (const v of ["0", "off", "false", "no", " OFF "]) {
    assert.equal(tonemap.filterFor({ ...pq, available: FAST, env: { AURORA_TONEMAP: v } }), null);
    assert.equal(tonemap.enabled({ AURORA_TONEMAP: v }), false);
  }
  for (const v of [undefined, "", "1", "auto", "force"]) assert.equal(tonemap.enabled({ AURORA_TONEMAP: v }), true);
  assert.equal(tonemap.mode({}), "auto");
  assert.equal(tonemap.mode({ AURORA_TONEMAP: "force" }), "force");
});

test("an ffmpeg without the filters (or an unprobed one) never gets the chain", () => {
  assert.equal(tonemap.filterFor({ ...pq, env: ON }), null);
  assert.equal(tonemap.filterFor({ ...pq, env: ON, available: null }), null);
  assert.equal(tonemap.filterFor({ ...pq, env: ON, available: { ok: false, zscale: false, tonemap: true, mpps: 0 } }), null);
  assert.equal(tonemap.filterFor({ ...pq, env: ON, available: { ok: true } }), null); // works but never timed
  assert.equal(tonemap.decide({ ...pq, env: ON, available: { ok: false } }).why, "unsupported");
  // even forced, a missing filter is a missing filter
  assert.equal(tonemap.filterFor({ ...pq, env: { AURORA_TONEMAP: "force" }, available: { ok: false } }), null);
});

test("speed gate: only where the encode stays comfortably above real time", () => {
  const uhd = { ...pq, width: 3840, height: 2160 };
  // the measured machine: every 24fps case passes...
  for (const outHeight of [0, 720, 480]) {
    assert.ok(f({ ...uhd, outHeight }), `2160p→${outHeight || 1080} @24`);
    assert.ok(f({ ...pq, outHeight }), `1080p→${outHeight || 1080} @24`);
  }
  // ...high frame rates only at the small sizes
  assert.equal(f({ ...uhd, fps: 60 }), null);
  assert.equal(f({ ...pq, fps: 50 }), null);
  assert.ok(f({ ...pq, fps: 50, outHeight: 720 }));
  assert.equal(tonemap.decide({ ...uhd, fps: 60, available: FAST, env: ON }).why, "too-slow");
  // a host a third as fast: 2160p→1080p is refused, the capped renditions of a 1080p file still pass
  const slow = { ...FAST, mpps: 80 };
  assert.equal(tonemap.filterFor({ ...uhd, available: slow, env: ON }), null);
  assert.equal(tonemap.filterFor({ ...pq, available: slow, env: ON }), null);
  assert.ok(tonemap.filterFor({ ...pq, outHeight: 720, available: slow, env: ON }));
  // another encode already running: twice the headroom is asked for
  assert.equal(f({ ...uhd, busy: true }), null);
  assert.ok(f({ ...pq, outHeight: 720, busy: true }));
  // the knobs
  assert.ok(tonemap.filterFor({ ...uhd, fps: 60, available: FAST, env: { AURORA_TONEMAP: "force" } }));
  assert.equal(tonemap.filterFor({ ...uhd, available: FAST, env: { AURORA_TONEMAP_MIN_SPEED: "2.5" } }), null);
  assert.ok(tonemap.filterFor({ ...uhd, available: slow, env: { AURORA_TONEMAP_MIN_SPEED: "0.5" } }));
  // unknown size is priced as 2160p, unknown frame rate as 30
  const p = tonemap.predictSpeed({ mpps: 235 });
  assert.ok(Math.abs(p - tonemap.predictSpeed({ width: 3840, height: 2160, fps: 30, mpps: 235 })) < 1e-9);
  // the model against the measured table (fps at 235 MP/s), never optimistic by more than 2%
  const measured = [[3840, 2160, 0, 50], [3840, 2160, 720, 73], [3840, 2160, 480, 93], [1920, 1080, 0, 73], [1920, 1080, 720, 131], [1920, 1080, 480, 208]];
  for (const [width, height, outHeight, fps] of measured) {
    const predicted = tonemap.predictSpeed({ width, height, outHeight, fps: 1, mpps: 235 });
    assert.ok(predicted <= fps * 1.02 && predicted >= fps * 0.8, `${width}x${height}→${outHeight}: ${predicted.toFixed(0)} vs ${fps}`);
  }
});

test("output size follows the job's scale rule", () => {
  assert.deepEqual(tonemap.outDims(3840, 2160, 0), { srcW: 3840, srcH: 2160, outW: 1920, outH: 1080 });
  assert.deepEqual(tonemap.outDims(3840, 1600, 0), { srcW: 3840, srcH: 1600, outW: 1920, outH: 800 });
  assert.deepEqual(tonemap.outDims(1280, 720, 0), { srcW: 1280, srcH: 720, outW: 1280, outH: 720 }); // never upscaled
  assert.deepEqual(tonemap.outDims(3840, 2160, 720), { srcW: 3840, srcH: 2160, outW: 1280, outH: 720 });
  assert.deepEqual(tonemap.outDims(854, 480, 720), { srcW: 854, srcH: 480, outW: 854, outH: 480 });
});

test("the colour probe: ffprobe JSON → facts, Dolby Vision record included", () => {
  const hdr10 = tonemap.parseProbe(JSON.stringify({
    streams: [{ codec_type: "video", codec_name: "hevc", width: 3840, height: 2160, pix_fmt: "yuv420p10le", color_range: "tv", color_space: "bt2020nc", color_transfer: "smpte2084", color_primaries: "bt2020", avg_frame_rate: "24000/1001", r_frame_rate: "24000/1001" }],
  }));
  assert.equal(hdr10.transfer, "smpte2084");
  assert.equal(hdr10.matrix, "bt2020nc");
  assert.equal(hdr10.dv, null);
  assert.ok(Math.abs(hdr10.fps - 23.976) < 0.001);
  assert.ok(tonemap.isHdr(hdr10));

  const dv5 = tonemap.parseProbe({
    streams: [{ codec_type: "video", codec_name: "hevc", width: 3840, height: 2160, pix_fmt: "yuv420p10le", color_transfer: "smpte2084", avg_frame_rate: "0/0", r_frame_rate: "25/1",
      side_data_list: [{ side_data_type: "DOVI configuration record", dv_version_major: 1, dv_profile: 5, dv_level: 6, rpu_present_flag: 1, el_present_flag: 0, bl_present_flag: 1, dv_bl_signal_compatibility_id: 0 }] }],
  });
  assert.deepEqual(dv5.dv, { profile: 5, compat: 0 });
  assert.equal(dv5.fps, 25);
  assert.equal(tonemap.isHdr(dv5), false);

  const dv81 = tonemap.parseProbe({ streams: [{ color_transfer: "smpte2084", side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 8, dv_bl_signal_compatibility_id: 1 }] }] });
  assert.equal(tonemap.isHdr(dv81), true);

  const sdr = tonemap.parseProbe({ streams: [{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", color_transfer: "bt709" }] });
  assert.equal(tonemap.isHdr(sdr), false);
  assert.equal(tonemap.parseProbe("not json"), null);
  assert.equal(tonemap.parseProbe({ streams: [] }), null);
});

// The arguments both encoders built BEFORE tone mapping existed, copied from
// the code as it was (1b375da). An SDR job — vf null — must still produce them.
const T = String(Math.max(1, os.cpus().length - 2));
const BEFORE_FULL = ["-c:v", "libx264", "-preset", "superfast", "-crf", "18", "-pix_fmt", "yuv420p", "-g", "48", "-threads", T, "-vf", "scale=min(1920\\,iw):-2"];
const BEFORE_CAP = (h, maxrate, bufsize) => ["-c:v", "libx264", "-preset", "superfast", "-crf", "18", "-pix_fmt", "yuv420p", "-g", "48", "-threads", T, "-vf", `scale=-2:min(${h}\\,ih)`, "-maxrate", maxrate, "-bufsize", bufsize];

test("SDR and copy jobs: the ffmpeg video arguments are exactly what they were", () => {
  const r = remux._internals.videoArgsFor;
  assert.deepStrictEqual(r("h264"), BEFORE_FULL);
  assert.deepStrictEqual(r("h264", null), BEFORE_FULL);
  assert.deepStrictEqual(r("h264-720"), BEFORE_CAP(720, "2200k", "4400k"));
  assert.deepStrictEqual(r("h264-480"), BEFORE_CAP(480, "1000k", "2000k"));
  assert.deepStrictEqual(r("copy"), ["-c:v", "copy"]);
  assert.deepStrictEqual(r("copy", "anything"), ["-c:v", "copy"]); // a copy job cannot be filtered
  const t = transcode._internals.videoArgsFor;
  assert.deepStrictEqual(t("h264"), BEFORE_FULL);
  assert.deepStrictEqual(t("copy"), ["-c:v", "copy"]);
  assert.deepStrictEqual(t("copy", "anything"), ["-c:v", "copy"]);
  // and what an SDR source's facts turn into is null → those same arguments
  const sdr = { transfer: "bt709", primaries: "bt709", matrix: "bt709", width: 3840, height: 2160, fps: 24 };
  assert.deepStrictEqual(r("h264", tonemap.filterFor({ ...sdr, available: FAST, env: ON })), BEFORE_FULL);
});

test("an HDR job swaps the one -vf for the chain and changes nothing else", () => {
  for (const [v, before, outHeight] of [["h264", BEFORE_FULL, 0], ["h264-720", BEFORE_CAP(720, "2200k", "4400k"), 720]]) {
    const scale = remux._internals.scaleFor(outHeight ? { h: outHeight } : null);
    const vf = f({ ...pq, width: 3840, height: 2160, outHeight, scale });
    const args = remux._internals.videoArgsFor(v, vf);
    assert.equal(args.filter((a) => a === "-vf").length, 1);
    assert.equal(args.length, before.length);
    const i = args.indexOf("-vf") + 1;
    assert.equal(args[i], vf);
    assert.deepStrictEqual(args.filter((_, k) => k !== i), before.filter((_, k) => k !== i));
  }
  const vf = f({ ...pq, scale: transcode._internals.SCALE });
  const args = transcode._internals.videoArgsFor("h264", vf);
  assert.equal(args.filter((a) => a === "-vf").length, 1);
  assert.equal(args[args.indexOf("-vf") + 1], vf);
});

test("a source whose tone-mapped job died in its filters goes back to the plain encode", () => {
  const facts = { ...pq };
  assert.equal(tonemap.veto(facts, "Conversion failed!"), false); // not a filter failure: nothing changes
  assert.equal(facts.veto, undefined);
  assert.equal(tonemap.veto(facts, "[Parsed_zscale_1 @ 0x1] code 3074: no path between colorspaces"), true);
  assert.equal(tonemap.vfFor(facts, { scale: "scale=min(1920\\,iw):-2" }), null);
  assert.equal(tonemap.veto(null, "zscale"), false);
});
