#!/usr/bin/env node
// MEMORY OVER HOURS: does the process grow when a household just uses it?
//
//   node tools/backend-perf/soak.js [--weak] [--minutes 150] [--viewers 3] [--ref <commit>] [--label after]
//   -> docs/qa/backend-efficiency/results/soak[-weak][-label].json and a table
//
// The first 20 minutes nobody is connected. Then, until the end:
//   --viewers devices watching (a progress POST and an `activity` message every 5 s each,
//             a usage batch every 20 s; each "film" lasts 12 minutes, then another starts)
//   once a minute, one device browsing: Home, the library, its state, My List, two
//             searches with suggestions, a title page, 40 pictures (20 distinct per minute,
//             moving through the library), a subtitle file
// Every 5 minutes: a forced collection, then RSS / heap / external memory, open
// handles, and the size of the module-level caches that have no bound of their own
// (inproc/cache-sizes.js). The verdict is the slope of heap-after-collection over
// the busy part, in MB per hour.
const path = require("path");
const http = require("http");
const { start } = require("./instance");
const { REPO, round, saveJson, arg, table, sleep } = require("./lib");
const WebSocket = require(path.join(REPO, "node_modules", "ws"));

const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const req = (srv, i, method, p, body, extra = {}) => new Promise((resolve) => {
  const s = body ? JSON.stringify(body) : null;
  const r = http.request(srv.url + p, { agent, method, headers: { ...srv.session(i), "Accept-Encoding": "gzip, deflate, br", ...(method === "GET" ? { "X-Blur": "1" } : {}), ...(s ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) } : {}), ...extra } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
  r.on("error", () => resolve(0));
  r.end(s || undefined);
});

(async () => {
  const weak = !!arg("weak");
  const minutes = +arg("minutes", 150);
  const viewers = +arg("viewers", 3);
  const ref = arg("ref") === true ? undefined : arg("ref");
  const label = arg("label") === true ? undefined : arg("label");
  const srv = await start({ weak, ref, probe: "light", loop: true });
  const ds = srv.ds;
  const samples = [];
  const counts = { requests: 0, failed: 0 };
  const sample = async (phase) => {
    await srv.gc();
    const c = await srv.exec(path.join(__dirname, "inproc", "cache-sizes.js"));
    const s = await srv.snap();
    samples.push({ minute: round((Date.now() - t0) / 60000, 1), phase, rssMb: c.rssMb, heapMb: c.heapUsedMb, externalMb: c.externalMb, handles: c.handles, loopP99Ms: s.loopDelay ? round(s.loopDelay.p99, 1) : null, sizes: c.sizes });
    process.stderr.write(`[soak] ${samples[samples.length - 1].minute} min ${phase}: RSS ${c.rssMb} MB, heap ${c.heapUsedMb} MB, handles ${c.handles}\n`);
  };
  let t0 = Date.now();
  try {
    await srv.waitWarm();
    await srv.waitQuiet();
    t0 = Date.now();
    const end = t0 + minutes * 60000;
    const idleUntil = t0 + Math.min(20, minutes / 4) * 60000;
    let stop = false;
    // --- the viewers
    const viewer = async (i) => {
      const profile = srv.profile(i);
      await sleep(Math.max(0, idleUntil - Date.now()) + i * 1700);
      let film = i * 31;
      while (!stop) {
        const ws = new WebSocket(srv.url.replace("http", "ws"), { headers: srv.session(i) });
        await new Promise((r) => { ws.on("open", r); ws.on("error", r); });
        try { ws.send(JSON.stringify({ type: "hello", profile: `Viewer ${i + 1}`, profileId: profile })); } catch {}
        const item = ds.sample.films[film++ % ds.sample.films.length];
        const until = Date.now() + 12 * 60000;
        let pos = 60, beat = 0;
        while (!stop && Date.now() < until) {
          pos += 5; beat++;
          const st = await req(srv, i, "POST", `/api/profiles/${profile}/progress`, { itemId: item, position: pos, duration: 6000 });
          counts.requests++; if (st !== 200) counts.failed++;
          try { ws.send(JSON.stringify({ type: "activity", action: "Watching", details: `Film ${film}`, position: pos, duration: 6000 })); } catch {}
          if (beat % 4 === 0) { await req(srv, i, "POST", "/api/usage", { profile, sid: `soak${i}`, device: "desktop", look: "glass", events: [{ n: "route", t: Date.now(), p: { r: "/watch/:id", ms: 70 } }] }); counts.requests++; }
          await sleep(5000);
        }
        try { ws.close(); } catch {}
      }
    };
    // --- the one who browses
    const browser = async () => {
      await sleep(Math.max(0, idleUntil - Date.now()));
      const i = viewers;
      const profile = srv.profile(i);
      const lib = await (await fetch(`${srv.url}/api/library`, { headers: srv.session(i) })).json();
      const covers = lib.movies.filter((m) => m.cover && m.cover.startsWith("/img/"));
      const subs = lib.movies.filter((m) => (m.subtitles || []).some((s) => !s.embedded));
      const words = ["silent", "golden", "river", "mid", "brok", "electric", "paper", "wild", "glass", "iron", "frozen", "lucky", "velvet", "harbor", "station"];
      let round_ = 0;
      while (!stop) {
        const k = round_++;
        const paths = [`/api/home?profile=${profile}`, "/api/library", `/api/profiles/${profile}/state`, `/api/profiles/${profile}/watchlist`,
          `/api/search/suggest?v=2&q=${words[k % words.length].slice(0, 3)}`, `/api/search?v=2&q=${words[k % words.length]}`, `/api/search?v=2&q=${words[(k * 7 + 3) % words.length]}%20${k % 9}`,
          `/api/item/${ds.sample.films[k % ds.sample.films.length]}`, `/api/discover/meta/movie/${ds.sample.catalogue[k % ds.sample.catalogue.length].imdbId}`];
        for (let j = 0; j < 20; j++) { const c = covers[(k * 20 + j) % covers.length].cover; paths.push(`${c}?w=256`, c); }
        if (subs.length) paths.push(subs[k % subs.length].subtitles.find((s) => !s.embedded).url);
        for (const p of paths) { const st = await req(srv, i, "GET", p); counts.requests++; if (!st || st >= 500) counts.failed++; }
        await sleep(60000);
      }
    };
    const work = [...Array.from({ length: viewers }, (_, i) => viewer(i)), browser()];
    await sample("idle");
    while (Date.now() < end) {
      await sleep(Math.min(5 * 60000, Math.max(1000, end - Date.now())));
      await sample(Date.now() <= idleUntil + 1000 ? "idle" : "in use");
    }
    stop = true;
    await Promise.race([Promise.all(work), sleep(8000)]);
    const busy = samples.filter((s) => s.phase === "in use");
    // least-squares slope of heap-after-collection, MB per hour (the first busy sample is the ramp: left out)
    const fit = (list, key) => {
      const pts = list.slice(1).map((s) => [s.minute / 60, s[key]]);
      if (pts.length < 3) return null;
      const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      return round(pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0), 2);
    };
    const first = busy[1] || busy[0] || samples[0];
    const last = samples[samples.length - 1];
    const grew = Object.keys(last.sizes).map((k) => ({ cache: k, atStart: first.sizes[k], atEnd: last.sizes[k] })).filter((r) => r.atStart !== r.atEnd);
    const out = { at: new Date().toISOString(), ref: ref || "working tree", weak, minutes, viewers, requests: counts.requests, failed: counts.failed,
      heapSlopeMbPerHour: fit(busy, "heapMb"), rssSlopeMbPerHour: fit(busy, "rssMb"), idle: samples.filter((s) => s.phase === "idle").map((s) => ({ minute: s.minute, rssMb: s.rssMb, heapMb: s.heapMb })),
      first: { minute: first.minute, rssMb: first.rssMb, heapMb: first.heapMb, handles: first.handles }, last: { minute: last.minute, rssMb: last.rssMb, heapMb: last.heapMb, handles: last.handles }, grew, samples };
    const f = saveJson(`soak${weak ? "-weak" : ""}${label ? `-${label}` : ""}.json`, out);
    console.log(table(samples, [["minute", "minute"], ["phase", "phase"], ["RSS MB", "rssMb"], ["heap MB", "heapMb"], ["external MB", "externalMb"], ["handles", "handles"], ["loop p99 ms", "loopP99Ms"]]));
    console.log(`\n${counts.requests} requests (${counts.failed} failed). In use: heap ${out.heapSlopeMbPerHour} MB/hour, RSS ${out.rssSlopeMbPerHour} MB/hour.\n`);
    console.log(table(grew, [["cache", "cache"], ["entries at the start of use", "atStart"], ["at the end", "atEnd"]]));
    console.log(`\n${path.relative(process.cwd(), f)}`);
  } finally { await srv.stop(); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
