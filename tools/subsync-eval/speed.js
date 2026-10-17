#!/usr/bin/env node
// How long a speech timeline takes (docs/qa/subtitle-sync/REPORT.md "Speed").
//   node tools/subsync-eval/speed.js <video> [--urgent] [--parts N] [--align <subtitle>] [--compare <parts>]
// The timeline is made fresh (its cache goes to <scratch>/speed-cache, so
// nothing cached counts), through the real ffmpeg, the real workers and the
// real CPU budget (media/cpuwork.js: a background job waits for its place
// and runs at the lowest priority). The library is only read.
// --compare N: also make it in N parts and report how far the two differ.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const config = require("../../src/config");
const speech = require("../../src/media/speech");
const c = require("./common");

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const video = argv[0];
const urgent = argv.includes("--urgent");
const parts = opt("--parts") ? +opt("--parts") : null;
const D = speech._internals.deps;
const dir = c.p("speed-cache");
D.dir = () => dir;
// a probe of our own (the real one keeps a store in data/)
D.probe = async (p) => {
  const j = JSON.parse(execFileSync(config.FFPROBE, ["-v", "quiet", "-show_entries", "format=duration:stream=codec_type,codec_name,channels,channel_layout", "-of", "json", p], { encoding: "utf-8" }));
  return { duration: +j.format.duration, audioStreams: j.streams.filter((s) => s.codec_type === "audio").map((s, index) => ({ index, channels: s.channels, layout: s.channel_layout || null, codec: s.codec_name })) };
};
const clear = () => { fs.rmSync(dir, { recursive: true, force: true }); speech._internals.memo.clear(); };

(async () => {
  clear();
  const meta = await D.probe(video);
  const size = fs.statSync(video).size;
  const busy = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { idle: 0, all: 0 });
  const b0 = busy();
  const t0 = Date.now();
  const cpu0 = process.cpuUsage();
  const res = await speech.timeline(video, { urgent, parts });
  const ms = Date.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const out = {
    video: path.basename(video), dur: Math.round(meta.duration), gb: Math.round((size / 1e9) * 100) / 100,
    audio: `${meta.audioStreams[0].codec}/${meta.audioStreams[0].layout || meta.audioStreams[0].channels}`,
    mode: urgent ? `urgent${parts ? ` (${parts} parts)` : ""}` : "background", ms, nodeCpuMs: Math.round((cpu.user + cpu.system) / 1000),
    frames: res.speech.length,
  };
  const b1 = busy();
  out.machineBusyPct = Math.round((1 - (b1.idle - b0.idle) / Math.max(1, b1.all - b0.all)) * 100); // all cores, this run included
  if (opt("--align")) {
    const cues = c.readSubs(opt("--align"));
    const a0 = Date.now();
    const r = await speech.alignInWorker(res.speech, cues);
    out.alignMs = Date.now() - a0;
    out.lines = cues.length;
    out.verdict = r.verdict;
  }
  if (opt("--compare")) {
    clear();
    const n = +opt("--compare");
    const t1 = Date.now();
    const other = (await speech.timeline(video, { urgent: true, parts: n })).speech;
    out.compareParts = n;
    out.compareMs = Date.now() - t1;
    let sum = 0;
    let worst = 0;
    let big = 0;
    const L = Math.min(other.length, res.speech.length);
    for (let i = 0; i < L; i++) { const d = Math.abs(other[i] - res.speech[i]); sum += d; worst = Math.max(worst, d); if (d > 25) big++; }
    out.compare = { lengths: [res.speech.length, other.length], meanAbs: Math.round((sum / L) * 1000) / 1000, worst, framesOver10pct: big };
  }
  clear();
  console.log(JSON.stringify(out));
  fs.mkdirSync(c.p("results"), { recursive: true });
  fs.appendFileSync(c.p("results", "speed.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...out }) + "\n");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
