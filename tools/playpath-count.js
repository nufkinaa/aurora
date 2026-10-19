#!/usr/bin/env node
// How a whole library would play on a few devices — before (the rules the
// players had) and after (media/playpath.js fed by each device's report).
//
//   node tools/playpath-count.js [--meta <metadata-cache.json>] [--streams <torrent-streams.json>]
//                                [--caps <report.json> ...] [--json]
//
// --meta     the probe cache (default: this checkout's data/metadata-cache.json)
// --streams  a torrent source cache (data/cache/torrent-streams.json) — the
//            TV's source picks, read from their release names
// --caps     extra device reports (the JSON a device posts to /api/caps — e.g.
//            the Mi TV's real one, from GET /api/caps/:id); the built-in three
//            are a realistic Mi TV / Amlogic, Chrome on Windows with hardware
//            HEVC, and iPhone Safari.
// Reads files only: nothing is started, nothing is written.
"use strict";
const fs = require("fs");
const path = require("path");
const avcaps = require("../src/media/avcaps");
const pp = require("../src/media/playpath");

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const many = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));

// ------------------------------------------------------------- the devices
const DEVICES = {
  "Mi TV (Amlogic, realistic)": {
    client: "tv", model: "MiTV-AFMU0", sdk: 34,
    video: {
      h264: { profiles: ["baseline", "main", "high"], maxLevel: 51, maxW: 3840, maxH: 2160, maxFps: 60 },
      hevc: { profiles: ["main", "main10"], maxW: 3840, maxH: 2160, maxFps: 60 },
      vp9: { profiles: ["0", "2"], maxW: 3840, maxH: 2160 },
      mpeg2: { maxW: 1920, maxH: 1080 }, mpeg4: {},
    },
    hdr: ["hdr10", "hlg"],
    audio: { decode: ["aac", "ac3", "eac3", "mp3", "opus", "flac", "vorbis", "pcm", "mp2"], passthrough: ["ac3", "eac3", "eac3-joc"], maxChannels: 8 },
    containers: { mp4: true, mkv: true, webm: true, avi: true, ts: true, mov: true },
  },
  "Chrome desktop (Windows, hardware HEVC)": {
    client: "web",
    video: { h264: { profiles: ["baseline", "main", "high"] }, hevc: { profiles: ["main", "main10"] }, vp9: { profiles: ["0", "2"] }, av1: { profiles: ["main"] }, vp8: {} },
    hdr: ["hdr10", "hlg"],
    audio: { decode: ["aac", "mp3", "opus", "vorbis", "flac", "pcm"], passthrough: [] },
    containers: { mp4: ["h264", "hevc", "av1", "vp9"], webm: ["vp8", "vp9", "av1"], mkv: ["h264", "hevc", "vp9", "av1"] },
  },
  "iPhone Safari": {
    client: "web", nativeHls: true,
    video: { h264: { profiles: ["baseline", "main", "high"] }, hevc: { profiles: ["main", "main10"] } },
    hdr: ["hdr10", "hlg", "dv"], dv: [5, 8],
    audio: { decode: ["aac", "ac3", "eac3", "mp3", "flac", "alac", "pcm"], passthrough: [] },
    containers: { mp4: ["h264", "hevc"], mov: ["h264", "hevc"] },
  },
};
for (const f of many("--caps")) {
  const raw = JSON.parse(fs.readFileSync(f, "utf-8"));
  DEVICES[`${raw.model || path.basename(f)} (report)`] = raw;
}

// ------------------------------------------------------------- the rules before
// The TV app (tv-native/src/playback/Player.tsx, the arming block, 5.3.0):
// the file as it is unless its first audio track is not one a browser
// decodes (metadata.js BROWSER_AUDIO_CODECS) → the copy, its sound made AAC.
const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le"]);
const tvBefore = (rec) => {
  const a = (rec.audioStreams || [])[0];
  return a && !BROWSER_AUDIO.has(a.codec) ? "remux" : "direct";
};
// The TV's torrent picks (tv-native/src/playBest.ts): H.265 / AV1 tags → the
// H.264 encode; DTS / DTS-HD / TrueHD / Atmos / DD+ → the copy.
const tvTorrentBefore = (name) => {
  const s = String(name);
  if (/av1/i.test(s) || /x265|h\.?265|hevc/i.test(s)) return "transcode";
  if (/atmos|truehd|dts-?hd|\bDTS\b|ddp|dd\+|e-?ac-?3|eac3/i.test(s)) return "remux";
  return "direct";
};
// The website (public/js/screens/player.js startPlan, 1.8.2): canPlayType per
// codec and container — answered here from the same device report, which is
// what the browser's own answers are — and HEVC in MKV through the copy
// first (on a page without native HLS).
const webPlan = ({ needV, needA, copyable, hevcMkv }) => (!(hevcMkv || needV || needA) ? "direct" : needV && !copyable ? "transcode" : "remux");
const webBefore = (f, caps, nativeHls) => {
  const v = f.video || {};
  const canPlay = (cont, codec) => !!((caps.containers || {})[cont] || []).includes(codec);
  const needV = (v.codec === "h264" && v.bitDepth > 8) || !["h264", "hevc", "av1", "vp9", "vp8", "mpeg4"].includes(v.codec) || !canPlay(f.container, v.codec);
  const a = (f.audio || [])[0];
  const needA = !!a && !BROWSER_AUDIO.has(a.codec) && !(caps.audio.decode || []).includes(a.codec);
  const copyable = (v.codec === "h264" && v.bitDepth <= 8) || (v.codec === "hevc" && (nativeHls || !!caps.video.hevc));
  const hevcMkv = !nativeHls && v.codec === "hevc" && f.container === "mkv" && copyable;
  return webPlan({ needV, needA, copyable, hevcMkv });
};
// After: the same page rules, their inputs from the server's decision.
const webAfter = (f, d, nativeHls) => {
  const needV = !(d.decodes && d.container);
  const needA = d.audio === "convert";
  const copyable = d.decodes && pp.COPYABLE.has(f.video && f.video.codec);
  const hevcMkv = !nativeHls && f.video && f.video.codec === "hevc" && f.container === "mkv" && copyable;
  return webPlan({ needV, needA, copyable, hevcMkv });
};

// ------------------------------------------------------------- what it costs
// thread-seconds of server CPU per second of film (this PC, ffmpeg 6.0,
// -benchmark, docs/qa/tv-av/REPORT.md): the copy with its sound made AAC
// stereo, and a 1080p H.264 encode from 10-bit HEVC (the encode budget's own
// model says 1.23 for the same job — media/encbudget.js COST_REF)
const COST = { direct: 0, remux: 0.034, transcode: 1.23 };

// ------------------------------------------------------------- the library
const metaFile = opt("--meta") || path.join(__dirname, "..", "data", "metadata-cache.json");
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf-8")) : {};
const files = Object.entries(meta)
  .filter(([, r]) => r && r.video)
  .map(([p, r]) => ({
    path: p,
    rec: r,
    item: {
      container: path.extname(p).slice(1).toLowerCase(),
      width: r.width, height: r.height, video: r.video,
      audio: (r.audioStreams || [])[0] || null,
      audioTracks: (r.audioStreams || []).length > 1 ? r.audioStreams : undefined,
    },
  }));

const out = { library: files.length, devices: {} };
for (const [name, raw] of Object.entries(DEVICES)) {
  const caps = avcaps.normalize(raw);
  const nativeHls = !!raw.nativeHls;
  const before = { direct: 0, remux: 0, transcode: 0 };
  const after = { direct: 0, remux: 0, transcode: 0 };
  const extra = { passthrough: 0, surroundKept: 0 };
  const changed = [];
  const cpuSec = { before: 0, after: 0 }; // server CPU (thread-seconds) to watch every file once
  for (const f of files) {
    const facts = pp.factsOfItem(f.item);
    const d = pp.decide(facts, caps);
    const b = caps.client === "tv" ? tvBefore(f.rec) : webBefore(facts, caps, nativeHls);
    const a = caps.client === "tv" ? d.mode : webAfter(facts, d, nativeHls);
    before[b]++;
    after[a]++;
    cpuSec.before += COST[b] * (f.rec.duration || 0);
    cpuSec.after += COST[a] * (f.rec.duration || 0);
    if (a === "direct" && d.audio === "passthrough") {
      extra.passthrough++;
      if (((facts.audio || [])[0] || {}).channels > 2) extra.surroundKept++;
    }
    if (a !== b) changed.push(`${path.basename(f.path)}: ${b} → ${a} (${d.why.join(" · ")})`);
  }
  const hours = files.reduce((s, f) => s + (f.rec.duration || 0), 0) / 3600;
  out.devices[name] = { before, after, ...extra, changed, cpuMinutesBefore: Math.round(cpuSec.before / 60), cpuMinutesAfter: Math.round(cpuSec.after / 60), libraryHours: Math.round(hours * 10) / 10 };
}

// ------------------------------------------------------------- torrent picks (the TV)
const streamsFile = opt("--streams");
if (streamsFile && fs.existsSync(streamsFile)) {
  const all = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o.streams)) return void all.push(...o.streams);
    for (const v of Object.values(o)) walk(v);
  };
  walk(JSON.parse(fs.readFileSync(streamsFile, "utf-8")));
  const caps = avcaps.normalize(DEVICES["Mi TV (Amlogic, realistic)"]);
  const before = { direct: 0, remux: 0, transcode: 0 };
  const after = { direct: 0, remux: 0, transcode: 0 };
  for (const s of all) {
    const name = `${s.filename || ""} ${String(s.title || "").split("\n")[0]}`;
    before[tvTorrentBefore(name)]++;
    after[pp.decide(pp.factsOfRelease(name, s.quality), caps).mode]++;
  }
  out.torrents = { sources: all.length, before, after };
}

if (args.includes("--json")) {
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
} else {
  console.log(`library: ${out.library} files`);
  for (const [name, r] of Object.entries(out.devices)) {
    const fmt = (c) => `direct ${c.direct} · remux ${c.remux} · transcode ${c.transcode}`;
    console.log(`\n${name}\n  before: ${fmt(r.before)}\n  after:  ${fmt(r.after)}`);
    console.log(`  passthrough (as it is, to the TV / soundbar): ${r.passthrough} (surround kept: ${r.surroundKept})`);
    console.log(`  server CPU to watch all ${r.libraryHours} h once: ${r.cpuMinutesBefore} → ${r.cpuMinutesAfter} thread-minutes`);
    for (const c of r.changed.slice(0, 8)) console.log(`    ${c}`);
    if (r.changed.length > 8) console.log(`    … ${r.changed.length - 8} more`);
  }
  if (out.torrents) {
    const t = out.torrents;
    console.log(`\nMi TV torrent sources (${t.sources}, read off their names)\n  before: direct ${t.before.direct} · remux ${t.before.remux} · transcode ${t.before.transcode}\n  after:  direct ${t.after.direct} · remux ${t.after.remux} · transcode ${t.after.transcode}`);
  }
}
