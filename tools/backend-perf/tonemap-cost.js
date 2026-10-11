#!/usr/bin/env node
// What the tone-map timing at boot costs: the server runs it at every start
// (media/tonemap.js: `ffmpeg -filters`, three timed chains 15 s after boot,
// two more at 90 s and two more at 300 s — eight ffmpeg processes).
//
//   node tools/backend-perf/tonemap-cost.js [--weak]
//   -> docs/qa/backend-efficiency/results/tonemap-cost[-weak].json
//
// Each command is the server's own (same filter chain, frame counts and size),
// run here with -benchmark so ffmpeg prints its CPU seconds; --weak pins this
// process (and so ffmpeg) to two cores.
const { execFile } = require("child_process");
const path = require("path");
const { REPO, WEAK, pin, round, saveJson, arg, which, table } = require("./lib");

const FFMPEG = which("ffmpeg");
const run = (args) => new Promise((resolve) => {
  const t0 = process.hrtime.bigint();
  execFile(FFMPEG, ["-benchmark", "-hide_banner", ...args], { windowsHide: true, timeout: 120000, maxBuffer: 16 << 20 }, (err, out, errOut) => {
    const wall = Number(process.hrtime.bigint() - t0) / 1e9;
    const m = /bench: utime=([\d.]+)s stime=([\d.]+)s/.exec(String(errOut) + String(out));
    resolve({ ok: !err, wall, cpu: m ? parseFloat(m[1]) + parseFloat(m[2]) : null });
  });
});

(async () => {
  const weak = !!arg("weak");
  if (weak) pin(process.pid, WEAK.mask);
  // the chain, from the module itself (no server is started: tonemap.js only builds strings here)
  const tonemap = require(path.join(REPO, "src", "media", "tonemap"));
  const chain = (kind) => tonemap._internals.tonemapChain(kind, "bt2020", "bt2020nc", false);
  const cmd = (kind, frames) => ["-v", "info", "-f", "lavfi", "-i", "color=c=gray:s=1280x720:r=24", "-frames:v", String(frames), "-vf", `format=yuv420p10le,${chain(kind)}`, "-f", "null", "-"];
  const steps = [
    ["ffmpeg -filters", ["-v", "info", "-filters"], 15],
    ["hlg chain, 24 frames", cmd("hlg", 24), 15],
    ["pq chain, 216 frames", cmd("pq", 216), 15],
    ["pq chain, 216 frames", cmd("pq", 216), 15],
    ["hlg chain, 24 frames (re-timing)", cmd("hlg", 24), 90],
    ["pq chain, 216 frames (re-timing)", cmd("pq", 216), 90],
    ["hlg chain, 24 frames (re-timing)", cmd("hlg", 24), 300],
    ["pq chain, 216 frames (re-timing)", cmd("pq", 216), 300],
  ];
  const rows = [];
  for (const [what, args, at] of steps) {
    const r = await run(args);
    rows.push({ what, secondsAfterBoot: at, ok: r.ok, cpuSeconds: round(r.cpu, 2), wallSeconds: round(r.wall, 2) });
  }
  const out = { at: new Date().toISOString(), weak, processes: rows.length, cpuSecondsPerBoot: round(rows.reduce((a, r) => a + (r.cpuSeconds || 0), 0), 2), wallSecondsPerBoot: round(rows.reduce((a, r) => a + r.wallSeconds, 0), 2), rows };
  saveJson(`tonemap-cost${weak ? "-weak" : ""}.json`, out);
  console.log(table(rows, [["command", "what"], ["s after boot", "secondsAfterBoot"], ["ran", "ok"], ["CPU s", "cpuSeconds"], ["wall s", "wallSeconds"]]));
  console.log(`\nper boot: ${out.processes} ffmpeg processes, ${out.cpuSecondsPerBoot} CPU seconds, ${out.wallSecondsPerBoot} s of wall time${weak ? " (two cores)" : ""}`);
})().catch((e) => { console.error(e); process.exit(1); });
