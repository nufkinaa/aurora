#!/usr/bin/env node
// DIRECT PLAY UNDER MANY VIEWERS: simulated <video> players (lib.directViewer)
// reading real films from the real disk through /stream/video, at a real-time
// rate, from cold regions (never read before by the rig). Some of them can be
// slow remote viewers behind their own throttled line (tools/throttle-proxy.js).
//
//   node tools/streamload/direct.js --movies <folder> --trees before=<dir>,after=<dir>
//        --viewers 10,20,30 --mbit 12 --secs 45 --slow 2 --slow-kbit 18000 --rounds 2
//
// Trees are started side by side and measured in turn (A B A B ...), so the
// noise of a busy PC falls on both. Prints a table and writes JSON to
// docs/qa/server-round/results/direct-<label>.json.
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { REPO, arg, sleep, pct, round, startInstance, readStats, regionState, rng, directViewer } = require("./lib");
const throttle = require(path.join(REPO, "tools", "throttle-proxy.js"));

const movies = arg("movies");
// name=dir[@{config json}] — e.g. after=…@{"diskTypes":{"C:":"unknown"}}
const trees = arg("trees", `after=${REPO}`).split(",").map((s) => { const [name, rest] = s.split(/=(.*)/s); const [dir, cfg] = rest.split("@"); return { name, dir, config: cfg ? JSON.parse(cfg) : {} }; });
const counts = arg("viewers", "10,20").split(",").map(Number);
const mbit = parseFloat(arg("mbit", "12"));
const secs = parseFloat(arg("secs", "45"));
const slow = parseInt(arg("slow", "0"), 10);
const slowKbit = parseInt(arg("slow-kbit", String(Math.round(mbit * 1000 * 1.5))), 10);
const rounds = parseInt(arg("rounds", "1"), 10);
const label = arg("label", "run");
const bytesPerSec = (mbit * 1e6) / 8;

(async () => {
  const insts = [];
  for (const t of trees) {
    const srv = await startInstance({ movies, tree: t.dir, config: t.config });
    insts.push({ ...t, srv });
    console.log(`[${t.name}] up at ${srv.url}, ${srv.films.length} films`);
  }
  // --cold 0: any region (an SSD library small enough to sit in the OS cache)
  const regions = arg("cold", "1") === "0"
    ? { pick: (films, bytes, rand) => { const f = films[Math.floor(rand() * films.length)]; return { film: f, start: Math.floor((rand() * Math.max(0, f.size - bytes)) / 1048576) * 1048576 }; }, note() {}, save() {} }
    : regionState();
  const rand = rng(Date.now() & 0xffff);
  const results = [];
  try {
    for (let round_ = 0; round_ < rounds; round_++) {
      for (const n of counts) {
        for (const inst of round_ % 2 ? [...insts].reverse() : insts) {
          // everybody's bytes: the buffer fill + real time for the window
          const need = Math.ceil(bytesPerSec * (secs + 40));
          const picks = Array.from({ length: n }, () => regions.pick(inst.srv.films, need, rand));
          const proxies = [];
          for (let i = 0; i < Math.min(slow, n); i++) {
            proxies.push(await throttle.start({ listen: 0, to: inst.srv.port, down: slowKbit, up: 2000, latency: 30, quiet: true }));
          }
          const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
          const t0 = Date.now();
          const out = await Promise.all(picks.map((p, i) => {
            const base = i < proxies.length ? `http://127.0.0.1:${proxies[i].port}` : inst.srv.url;
            return directViewer({ base, id: p.film.id, start: p.start, bytesPerSec, secs, agent }).then((r) => ({ ...r, slow: i < proxies.length }));
          }));
          const t1 = Date.now();
          for (const p of proxies) await p.close();
          agent.destroy();
          for (const r of out) regions.note(r.id, r.start, r.start + r.bytes);
          regions.save();
          await sleep(1500);
          const st = readStats(inst.srv.statsFile, t0, t1);
          const row = {
            tree: inst.name, round: round_, viewers: n, mbit, secs,
            startupP50: pct(out.map((r) => r.startupMs), 50), startupMax: Math.max(...out.map((r) => r.startupMs ?? 1e9)),
            stalled: out.filter((r) => r.stalls > 0).length, stalls: out.reduce((a, r) => a + r.stalls, 0),
            stallSec: round(out.reduce((a, r) => a + r.stallMs, 0) / 1000, 1),
            slowStalled: out.filter((r) => r.slow && r.stalls > 0).length,
            errors: out.filter((r) => r.err || (r.status !== 206 && r.status !== 200)).length,
            MBread: round(out.reduce((a, r) => a + r.bytes, 0) / 1e6, 0),
            ...st,
          };
          results.push(row);
          console.log(JSON.stringify(row));
          await sleep(3000);
        }
      }
    }
  } finally {
    for (const i of insts) await i.srv.stop();
  }
  const dir = path.join(REPO, "docs", "qa", "server-round", "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `direct-${label}.json`), JSON.stringify(results, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
