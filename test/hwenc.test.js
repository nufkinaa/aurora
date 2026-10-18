// Hardware encoding (media/hwenc.js): found out safely, used only when
// switched on, and never in the way when the card says no.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const hw = require("../src/media/hwenc");

const { deps, state } = hw._internals;
const real = { ...deps };
beforeEach(() => {
  Object.assign(deps, real);
  hw._internals.reset();
});

const NV_OK = { encoders: { nvenc: { present: true, encode: true, chain: true, tested: true, decode: { h264: true, hevc: true, hevc10: true } } }, at: 1 };
const f1080 = { codec: "hevc", width: 1920, height: 1080, pixFmt: "yuv420p10le" };

test("the encoder list is read from ffmpeg's own table", () => {
  const have = hw._internals.listEncoders(" V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)\n V..... h264_qsv  x\n A....D aac_mf  x\n");
  assert.ok(have.has("h264_nvenc"));
  assert.ok(have.has("h264_qsv"));
  assert.ok(!have.has("aac_mf"), "audio encoders are not video ones");
});

test("automatic by default: a proven family is used; off and on as set; why is said", () => {
  hw._internals.setResult(NV_OK);
  deps.setting = () => undefined;
  assert.equal(hw.mode(), "auto");
  assert.equal(hw.canUse(f1080), true);
  assert.match(hw.decide(f1080).why, /decoded and encoded on the card/);
  assert.match(hw.sentence(), /In use \(NVIDIA NVENC\)/);
  deps.setting = () => "off";
  assert.equal(hw.canUse(f1080), false);
  assert.match(hw.decide(f1080).why, /switched off/);
  assert.match(hw.sentence(), /Not in use/);
  // a family that works but whose picture was never measured: "on" only
  hw._internals.setResult({ encoders: { vaapi: { present: true, encode: true, chain: true, decode: { h264: true, hevc: true, hevc10: false } } } });
  deps.setting = () => "auto";
  assert.equal(hw.canUse(f1080), false);
  assert.match(hw.decide(f1080).why, /not been measured/);
  deps.setting = () => "on";
  assert.equal(hw.canUse(f1080), true);
});

test("a family whose own ladder arguments fail is reported, never used", async () => {
  deps.ffmpeg = () => "ffmpeg";
  deps.platform = () => "linux";
  deps.exists = () => true;
  deps.run = async (args) => {
    const a = args.join(" ");
    if (args.includes("-encoders")) return { ok: true, out: " V....D h264_vaapi x\n V..... libx264 x\n", err: "" };
    if (a.includes("ladder.ts")) return { ok: false, code: 1, out: "", err: "[h264_vaapi @ 0x1] Driver does not support QVBR\n" };
    return { ok: true, out: "", err: "" };
  };
  const r = await hw.probe();
  assert.equal(r.encoders.vaapi.encode, true);
  assert.equal(r.encoders.vaapi.chain, false);
  assert.match(r.encoders.vaapi.why, /QVBR/);
  deps.setting = () => "auto";
  assert.equal(hw.family(), null);
  assert.equal(hw.canUse(f1080), false);
  assert.match(hw.sentence(), /not used/);
});

test("VA-API and Quick Sync arguments keep the same contract (designed; not run on real hardware here)", () => {
  for (const fam of ["vaapi", "qsv"]) {
    const a = hw._internals.ARGS[fam]({ dims: { w: 1280, h: 720 }, rate: { maxrate: 2200, bufsize: 4400 }, level: 31, fmt: null, cq: 21, onCard: fam === "vaapi" });
    const v = a.videoArgs.join(" ");
    assert.match(v, /-force_key_frames source/, fam);
    assert.match(v, /-fps_mode passthrough/, fam);
    assert.match(v, /-enc_time_base -1/, fam);
    assert.match(v, /-maxrate 2200k -bufsize 4400k/, fam);
    assert.match(v, /-level:v 3\.1/, fam);
    assert.match(v, /1280.*720/, fam);
  }
});

test("a machine with nothing: every probe step failing is just 'none available'", async () => {
  deps.ffmpeg = () => "ffmpeg";
  deps.run = async (args) => (args.includes("-encoders") ? { ok: true, out: " V....D h264_nvenc  x\n", err: "" } : { ok: false, code: 1, out: "", err: "[h264_nvenc @ 0x1] Cannot load nvcuda.dll\n" });
  const r = await hw.probe();
  assert.equal(r.encoders.nvenc.encode, false);
  assert.match(r.encoders.nvenc.why, /nvcuda/);
  deps.setting = () => "auto";
  assert.equal(hw.canUse(f1080), false);
  assert.match(hw.sentence(), /none available/);
});

test("the whole NVIDIA chain is tried step by step", async () => {
  deps.ffmpeg = () => "ffmpeg";
  const seen = [];
  deps.run = async (args) => {
    seen.push(args.join(" "));
    if (args.includes("-encoders")) return { ok: true, out: " V....D h264_nvenc x\n V....D hevc_nvenc x\n", err: "" };
    // the card decodes 8-bit but not 10-bit HEVC
    if (args.join(" ").includes("hevc10.mp4") && args.includes("-hwaccel")) return { ok: false, code: 1, out: "", err: "no" };
    return { ok: true, out: "", err: "" };
  };
  const r = await hw.probe();
  assert.deepEqual(r.encoders.nvenc.decode, { h264: true, hevc: true, hevc10: false });
  assert.ok(seen.some((s) => s.includes("scale_cuda")), "the decode → scale → encode chain on the card");
  assert.equal(r.encoders.nvenc.chain, true, "the ladder's own arguments ran");
  assert.ok(seen.some((s) => s.includes("-force_key_frames source") && s.includes("h264_nvenc") && s.includes("ladder.ts")), "step 3 runs the very arguments a viewer gets");
  assert.equal(hw.family(), "nvenc");
  assert.equal(hw.gpuDecodes({ codec: "hevc", pixFmt: "yuv420p10le" }), false);
  assert.equal(hw.gpuDecodes({ codec: "hevc", pixFmt: "yuv420p" }), true);
  assert.equal(hw.gpuDecodes({ codec: "h264", pixFmt: "yuv420p10le" }), false, "10-bit H.264: not on NVDEC");
  assert.equal(hw.gpuDecodes({ codec: "mpeg4", pixFmt: "yuv420p" }), false);
});

test("arguments keep jit's contract: source keyframes, own timestamps, size, ceiling, level", () => {
  hw._internals.setResult(NV_OK);
  const a = hw.nvencArgs(f1080, { dims: { w: 1280, h: 720 }, rate: { maxrate: 2200, bufsize: 4400 }, level: 31 });
  const v = a.videoArgs.join(" ");
  assert.deepEqual(a.inputArgs.slice(0, 4), ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]);
  assert.match(v, /-c:v h264_nvenc/);
  assert.match(v, /-force_key_frames source/);
  assert.match(v, /-forced-idr 1/);
  assert.match(v, /-fps_mode passthrough/);
  assert.match(v, /-enc_time_base -1/);
  assert.match(v, /scale_cuda=1280:720:interp_algo=lanczos:format=yuv420p/);
  assert.match(v, /-maxrate 2200k -bufsize 4400k/);
  assert.match(v, /-level:v 3\.1/);
  assert.ok(!/global_header/.test(v));
  const fm = hw.nvencArgs({ ...f1080, codec: "mpeg4", pixFmt: "yuv420p" }, { dims: { w: 640, h: 480 }, rate: { maxrate: 1000, bufsize: 2000 }, level: 30, fmt: "fmp4" });
  assert.deepEqual(fm.inputArgs, [], "a source the card cannot decode is decoded by the CPU");
  assert.match(fm.videoArgs.join(" "), /scale=640:480,format=yuv420p/);
  assert.match(fm.videoArgs.join(" "), /\+global_header/);
});

test("the card refusing a session puts hardware aside for a while; other failures do not", () => {
  hw._internals.setResult(NV_OK);
  deps.setting = () => "auto";
  let now = 1000;
  deps.now = () => now;
  assert.equal(hw.noteExit(1, "Invalid data found when processing input"), false);
  assert.equal(hw.canUse(f1080), true);
  assert.equal(hw.noteExit(1, "[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: out of memory (10): (no details)"), true);
  assert.equal(hw.canUse(f1080), false);
  assert.ok(hw.status().refused);
  now += 61 * 1000;
  assert.equal(hw.canUse(f1080), true);
  assert.equal(hw.status().fallbacks, 1);
});

test("sessions: what the boot check opened at once, or the config's number", () => {
  hw._internals.setResult({ encoders: { nvenc: { ...NV_OK.encoders.nvenc, parallel: 7 } } });
  assert.equal(hw.capacity(), 6);
  assert.match(hw.status().sessions.why, /7 opened at once/);
  hw._internals.setResult({ encoders: { nvenc: { ...NV_OK.encoders.nvenc, parallel: 5 } } });
  assert.equal(hw.capacity(), 4, "a GeForce limit of 5: one kept for other programs");
  hw._internals.setResult(NV_OK);
  assert.equal(hw.capacity(), hw.DEFAULT_SESSIONS);
  deps.sessionsSet = () => 10;
  assert.equal(hw.capacity(), 10);
});

test("sessions are counted while their process runs, and capped", () => {
  hw._internals.setResult(NV_OK);
  deps.setting = () => "auto";
  deps.sessionsSet = () => 2;
  const { EventEmitter } = require("events");
  const procs = [new EventEmitter(), new EventEmitter()];
  hw.track({}, procs[0]);
  assert.equal(hw.canUse(f1080), true);
  hw.track({}, procs[1]);
  assert.equal(hw.busy(), 2);
  assert.equal(hw.canUse(f1080), false, "no session left");
  procs[0].emit("close", 0);
  assert.equal(hw.busy(), 1);
  assert.equal(hw.canUse(f1080), true);
});
