#!/usr/bin/env node
// WATCHING AGAIN AFTER A PAUSE: one viewer reads 10 segments of an encoded
// rendition (?v=h264-720) somewhere in a film, goes away for longer than the
// idle reaper waits (jit IDLE_MS 150 s + its 30 s tick), and comes back to the
// same 10 segments — the pause-and-resume, the second viewer of the evening.
// Before: everything was re-encoded. After: kept segments are served.
//
//   node tools/streamload/rewatch.js --movies <folder> --trees before=<dir>,after=<dir> [--pause 200]
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { REPO, arg, sleep, round, startInstance } = require("./lib");

const movies = arg("movies");
const trees = arg("trees").split(",").map((s) => { const [name, dir] = s.split("="); return { name, dir }; });
const pauseSec = parseInt(arg("pause", "200"), 10);
const v = arg("v", "h264-720");

const get = (url) => new Promise((resolve) => {
  const t0 = Date.now();
  http.get(url, (res) => {
    const parts = [];
    res.on("data", (d) => parts.push(d));
    res.on("end", () => resolve({ status: res.statusCode, ms: Date.now() - t0, body: Buffer.concat(parts) }));
  }).on("error", () => resolve({ status: 0, ms: Date.now() - t0, body: Buffer.alloc(0) }));
});

const pass = async (srv, film, uris) => {
  const out = [];
  for (const u of uris) {
    const r = await get(`${srv.url}/stream/transcode/${film.id}/jit/${u}`);
    out.push({ status: r.status, ms: r.ms, bytes: r.body.length });
  }
  return out;
};

(async () => {
  const insts = [];
  for (const t of trees) insts.push({ ...t, srv: await startInstance({ movies, tree: t.dir }) });
  await sleep(60000); // calibration
  const rows = [];
  try {
    // both trees in parallel: the same film, the same stretch, the same pause
    await Promise.all(insts.map(async (inst) => {
      const film = inst.srv.films.find((f) => /Knives/.test(f.title)) || inst.srv.films[0];
      const pl = await get(`${inst.srv.url}/stream/transcode/${film.id}/jit/index.m3u8?v=${v}`);
      const uris = pl.body.toString().split("\n").filter((l) => /^seg\d+/.test(l));
      const from = Math.floor(uris.length / 3);
      const ten = uris.slice(from, from + 10);
      const first = await pass(inst.srv, film, ten);
      await sleep(pauseSec * 1000);
      const second = await pass(inst.srv, film, ten);
      const sum = (a) => a.reduce((x, r) => x + r.ms, 0);
      const row = {
        tree: inst.name, film: film.title, v, pauseSec,
        firstMs: sum(first), againMs: sum(second),
        againFirstSegMs: second[0].ms, againStatuses: [...new Set(second.map((r) => r.status))],
        sameBytes: first.every((r, i) => r.bytes === second[i].bytes),
        keptLog: inst.srv.log().filter((l) => /kept|idle-killed/.test(l)).slice(-3),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }));
  } finally {
    for (const i of insts) await i.srv.stop();
  }
  const dir = path.join(REPO, "docs", "qa", "server-round", "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rewatch-${arg("label", "run")}.json`), JSON.stringify(rows, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
