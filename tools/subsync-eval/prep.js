#!/usr/bin/env node
// The subtitle-sync test set (docs/qa/subtitle-sync/REPORT.md, "Test set").
// READ-ONLY on the library: for each item, its first audio track is decoded
// to 8 kHz mono s16 (the centre channel when the layout has one) into
// <scratch>/pcm, its own English text track (not forced / SDH) is extracted
// into <scratch>/ref, an SDH/CC/second English track into <scratch>/ref2
// when there is one, and for the "real" items the sidecar subtitles next to
// the video are COPIED into <scratch>/real/<item>/. Nothing is written into
// the library. The library folders come from config.json (read in-process).
//   node tools/subsync-eval/prep.js
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const config = require("../../src/config");
const { DIR: S } = require("./common");
const FF = config.FFMPEG;
const FP = config.FFPROBE;
// the household's library folders: this tree's config, else the live tree's
// config.json (SUBSYNC_LIBRARY_CONFIG; only its "LIBRARIES" is read)
const libraries = (() => {
  if (config.LIBRARIES && config.LIBRARIES.movies && config.LIBRARIES.movies.length && fs.existsSync(config.LIBRARIES.movies[0])) return config.LIBRARIES;
  try { return JSON.parse(fs.readFileSync(process.env.SUBSYNC_LIBRARY_CONFIG || "C:/elia/aurora/config.json", "utf8")).LIBRARIES || {}; } catch { return {}; }
})();
const lib = (libraries.movies && libraries.movies[0]) || "E:/Downloads/Movies";
const shows = (libraries.shows && libraries.shows[0]) || "E:/Downloads/Shows";
const M = lib.replace(/\\/g, "/") + "/";
const T = shows.replace(/\\/g, "/") + "/";
const ITEMS = [
  [M + "Avatar Fire and Ash (2025)/Avatar Fire and Ash (2025).mkv", "film"],
  [M + "Caught Stealing/Caught Stealing.mkv", "film"],
  [M + "Eternity/Eternity.mkv", "film"],
  [M + "Inception (2010)/Inception (2010).mkv", "film"],
  [M + "Knives Out/Knives Out.mkv", "film"],
  [M + "Project Hail Mary (2026)/Project Hail Mary (2026).mkv", "film"],
  [M + "Regretting You/Regretting You.mkv", "film"],
  [M + "The Ministry of Ungentlemanly Warfare/The Ministry of Ungentlemanly Warfare.mkv", "film"],
  [M + "The Roses/The Roses.mkv", "film"],
  [M + "The Thursday Murder Club/The Thursday Murder Club.mkv", "film"],
  [T + "Silo (2023)/Season 03/Silo S03E01.mkv", "ep"],
  [T + "Silo (2023)/Season 03/Silo S03E02.mkv", "ep"],
  [T + "Silo (2023)/Season 03/Silo S03E05.mkv", "ep"],
  [T + "Ted/Season 01/Ted - Just Say Yes (1x1).mkv", "ep"],
  [T + "Ted/Season 01/Ted - My Two Dads (1x2).mkv", "ep"],
  [T + "Ted/Season 02/Ted S02E06.mkv", "ep"],
  [T + "Spider-Noir (2026)/Season 01/Spider-Noir S01E01.mkv", "ep"],
];
const slug = (v) => path.basename(v).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "_").slice(0, 40);
const run = (args) => new Promise((r) => { const p = spawn(FF, args, { stdio: ["ignore", "ignore", "pipe"] }); let e = ""; p.stderr.on("data", (d) => (e += d)); p.on("close", (c) => r([c, e.slice(-300)])); });
const REAL = {
  "Inception_2010_": /Hebrew|English/, "Caught_Stealing": /Hebrew|English|WEB-DL/, "Knives_Out": /Hebrew|English/,
  "Avatar_Fire_and_Ash_2025_": /Hebrew|English/, "Ted_Just_Say_Yes_1x1_": /Hebrew|English|\(1x1\)\.srt$/, "Silo_S03E02": /Hebrew|English/,
};
(async () => {
  for (const d of ["pcm", "ref", "ref2", "real"]) fs.mkdirSync(path.join(S, d), { recursive: true });
  if (!FF || !FP) throw new Error("ffmpeg / ffprobe not found");
  const meta = {};
  const todo = [...ITEMS];
  const work = async () => {
    while (todo.length) {
      const [v, kind] = todo.shift();
      const s = slug(v);
      const j = JSON.parse(execFileSync(FP, ["-v", "quiet", "-show_entries", "format=duration:stream=index,codec_type,codec_name,channels,channel_layout:stream_tags=language,title:stream_disposition=forced,hearing_impaired", "-of", "json", v]));
      const a = j.streams.filter((x) => x.codec_type === "audio")[0];
      const lay = a.channel_layout || "";
      const fc = /^(3\.0|3\.1|4\.0|4\.1|5\.0|5\.1|6\.0|6\.1|7\.0|7\.1)/.test(lay) || (!lay && a.channels >= 6);
      const dur = +j.format.duration;
      meta[s] = { v, kind, dur, audio: `${a.codec_name}/${lay || a.channels}`, centre: fc };
      const out = path.join(S, "pcm", `${s}.s16`);
      const t0 = Date.now();
      const have = fs.existsSync(out) ? fs.statSync(out).size / 16000 : 0;
      if (Math.abs(have - dur) > 2) {
        const [c, e] = await run(["-v", "error", "-nostdin", "-i", v, "-map", "0:a:0", "-vn", "-sn", "-af", (fc ? "pan=mono|c0=FC," : "") + "aresample=8000:async=1:first_pts=0", "-ac", "1", "-f", "s16le", "-y", out]);
        if (c) console.log("decode fail", s, e);
      }
      const subs = j.streams.filter((x) => x.codec_type === "subtitle");
      const txt = (x) => /subrip|ass|mov_text|webvtt/.test(x.codec_name);
      const plain = (x) => txt(x) && !(x.disposition || {}).hearing_impaired && !(x.disposition || {}).forced && !/sdh|forced|cc\b|\(cc\)/i.test((x.tags || {}).title || "");
      const eng = (x) => /eng/.test((x.tags || {}).language || "") || !(x.tags || {}).language;
      const i1 = subs.findIndex((x) => plain(x) && eng(x));
      const i2 = subs.findIndex((x, k) => k !== i1 && txt(x) && eng(x) && !(x.disposition || {}).forced && !/forced/i.test((x.tags || {}).title || ""));
      meta[s].ref = i1; meta[s].ref2 = i2;
      meta[s].refTitle = i1 >= 0 ? (subs[i1].tags || {}).title || "" : null;
      meta[s].ref2Title = i2 >= 0 ? (subs[i2].tags || {}).title || "" : null;
      for (const [k, dir] of [[i1, "ref"], [i2, "ref2"]]) {
        const f = path.join(S, dir, `${s}.srt`);
        if (k >= 0 && !(fs.existsSync(f) && fs.statSync(f).size > 1000)) await run(["-v", "error", "-nostdin", "-i", v, "-map", `0:s:${k}`, "-f", "srt", "-y", f]);
      }
      if (REAL[s]) {
        const dir = path.dirname(v);
        const base = path.basename(v).replace(/\.[^.]+$/, "");
        const rd = path.join(S, "real", s);
        fs.mkdirSync(rd, { recursive: true });
        for (const f of fs.readdirSync(dir)) {
          if (!/\.(srt|vtt|ass)$/i.test(f)) continue;
          if (!f.startsWith(base) && !REAL[s].test(f)) continue;
          if (!REAL[s].test(f)) continue;
          fs.copyFileSync(path.join(dir, f), path.join(rd, f));
        }
      }
      console.log(s, kind, meta[s].audio, fc ? "FC" : "mix", "ref", i1, meta[s].refTitle, "ref2", i2, meta[s].ref2Title, ((Date.now() - t0) / 1000).toFixed(1) + "s");
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  fs.writeFileSync(path.join(S, "items.json"), JSON.stringify(meta, null, 1));
})();
