#!/usr/bin/env node
// HOW FAR AHEAD OF ITS VIEWER A COPY STREAM RUNS: one viewer per path — the
// TV's offset copy (/stream/transcode/:id/<ss>/index.m3u8?v=copy, remux.js)
// and the website's jit copy (/stream/transcode/:id/jit/index.m3u8) — each
// reading at real time with a 60 s buffer, for --mins minutes. Then: how much
// the instance's data/cache/hls and data/cache/jit hold, and the CPU its
// ffmpeg children used.
//
//   node tools/streamload/ahead.js --movies <folder> --trees before=<dir>,after=<dir> [--mins 4]
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");
const { REPO, arg, sleep, round, startInstance } = require("./lib");

const movies = arg("movies");
const trees = arg("trees").split(",").map((s) => { const [name, dir] = s.split("="); return { name, dir }; });
const mins = parseFloat(arg("mins", "4"));
const BUFFER = 60;

const get = (url) => new Promise((resolve) => {
  http.get(url, (res) => {
    const parts = [];
    res.on("data", (d) => parts.push(d));
    res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts) }));
  }).on("error", () => resolve({ status: 0, body: Buffer.alloc(0) }));
});
const dirBytes = (d) => {
  let n = 0;
  try {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
    }
  } catch {}
  return n;
};
const childCpu = (ppid) => new Promise((resolve) => {
  execFile("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe' AND ParentProcessId=${ppid}" | ForEach-Object { "$($_.ProcessId) $($_.UserModeTime + $_.KernelModeTime)" }`], { windowsHide: true }, (e, so) => {
    resolve(String(so || "").trim().split(/\r?\n/).filter(Boolean).map((l) => l.trim().split(/\s+/).map(Number)).map(([pid, t]) => ({ pid, cpu: t / 1e7 })));
  });
});

// a player: segments in order, a refreshed playlist (an EVENT playlist grows)
const watch = async (base, playlistPath, until) => {
  let got = 0;
  let film = 0; // seconds of film in hand
  const t0 = Date.now();
  let uris = [];
  let durs = [];
  let lastList = 0;
  while (Date.now() < until) {
    if (Date.now() - lastList > 6000 || got >= uris.length) {
      const pl = await get(base + playlistPath);
      lastList = Date.now();
      const lines = pl.body.toString().split("\n");
      uris = []; durs = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /^#EXTINF:([\d.]+)/.exec(lines[i]);
        if (m && lines[i + 1]) { durs.push(parseFloat(m[1])); uris.push(lines[i + 1].trim()); }
      }
    }
    const played = (Date.now() - t0) / 1000;
    if (film - played >= BUFFER || got >= uris.length) { await sleep(500); continue; }
    const dir = playlistPath.replace(/[^/]*$/, "");
    const r = await get(base + dir + uris[got]);
    if (r.status === 200) { film += durs[got]; got++; } else await sleep(1000);
  }
  return { segments: got, filmSec: round(film, 0) };
};

(async () => {
  const insts = [];
  for (const t of trees) insts.push({ ...t, srv: await startInstance({ movies, tree: t.dir }) });
  await sleep(60000);
  const rows = [];
  try {
    await Promise.all(insts.map(async (inst) => {
      const film = inst.srv.films.find((f) => /Greenland/.test(f.title)) || inst.srv.films[0];
      const until = Date.now() + mins * 60000;
      const cpu = new Map();
      let on = true;
      const sampler = (async () => { while (on) { for (const c of await childCpu(inst.srv.pid)) cpu.set(c.pid, Math.max(cpu.get(c.pid) || 0, c.cpu)); await sleep(3000); } })();
      const [offset, jitv] = await Promise.all([
        watch(inst.srv.url, `/stream/transcode/${film.id}/600/index.m3u8?v=copy&seek=1`, until),
        watch(inst.srv.url, `/stream/transcode/${film.id}/jit/index.m3u8`, until),
      ]);
      on = false;
      await sampler;
      const cache = path.join(inst.srv.dataDir, "cache");
      const row = {
        tree: inst.name, film: film.title, mins,
        offsetViewer: offset, jitViewer: jitv,
        hlsMB: round(dirBytes(path.join(cache, "hls")) / 1048576, 0),
        jitMB: round(dirBytes(path.join(cache, "jit")) / 1048576, 0),
        ffmpegCpuSec: round([...cpu.values()].reduce((a, b) => a + b, 0), 1),
        log: inst.srv.log().filter((l) => /paused|resumed|parked/.test(l)).slice(-4),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }));
  } finally {
    for (const i of insts) await i.srv.stop();
  }
  const dir = path.join(REPO, "docs", "qa", "server-round", "results");
  fs.writeFileSync(path.join(dir, `ahead-${arg("label", "run")}.json`), JSON.stringify(rows, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
