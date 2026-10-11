#!/usr/bin/env node
// MEMORY: who owns the heap of a warm server.
//
//   node tools/backend-perf/memory.js [--weak] [--ref <commit>] [--label before] [--snapshot] [--without known,recs]
//
//   --without known   start without the well-known titles (cache/search-known.json)
//   --without recs    start without the recommender's title index (cache/recs-titles.json)
//                     — what a "low-power" setting that drops them would save
//   -> docs/qa/backend-efficiency/results/memory[-label].json and tables
//
// Two views:
//   1. by owner     the server's modules are loaded one owner at a time in a
//                   process that serves nothing (inproc/mem-steps.js); after each
//                   step a full collection, and the heap that step left behind.
//                   Beside it: the size of the file it read.
//   2. a snapshot   (--snapshot) of the real, warm server after it has answered
//                   Home / library / search for every profile: bytes by kind of
//                   object, and strings held more than once (the same title,
//                   synopsis or picture address kept by several caches).
const fs = require("fs");
const path = require("path");
const { start } = require("./instance");
const { WORK, round, saveJson, arg, table, sleep } = require("./lib");

// A .heapsnapshot, summarised without loading it into a browser.
const summarise = (file) => {
  const snap = JSON.parse(fs.readFileSync(file, "utf8"));
  const m = snap.snapshot.meta;
  const F = m.node_fields.length;
  const iType = m.node_fields.indexOf("type"), iName = m.node_fields.indexOf("name"), iSelf = m.node_fields.indexOf("self_size");
  const types = m.node_types[0];
  const byType = {};
  const strings = new Map(); // content -> { n, bytes }
  const ctor = new Map();
  const nodes = snap.nodes;
  for (let i = 0; i < nodes.length; i += F) {
    const type = types[nodes[i + iType]];
    const self = nodes[i + iSelf];
    const t = byType[type] || (byType[type] = { n: 0, bytes: 0 });
    t.n++; t.bytes += self;
    if (type === "string" || type === "concatenated string" || type === "sliced string") {
      const s = snap.strings[nodes[i + iName]];
      const r = strings.get(s) || { n: 0, bytes: 0 };
      r.n++; r.bytes += self;
      strings.set(s, r);
    } else if (type === "object") {
      const name = snap.strings[nodes[i + iName]];
      const r = ctor.get(name) || { n: 0, bytes: 0 };
      r.n++; r.bytes += self;
      ctor.set(name, r);
    }
  }
  let dupBytes = 0, dupCount = 0, strBytes = 0;
  const dups = [];
  for (const [s, r] of strings) {
    strBytes += r.bytes;
    if (r.n > 1) { const waste = r.bytes - r.bytes / r.n; dupBytes += waste; dupCount += r.n - 1; dups.push({ sample: s.length > 70 ? `${s.slice(0, 67)}…` : s, length: s.length, copies: r.n, wastedKb: round(waste / 1024, 1) }); }
  }
  dups.sort((a, b) => b.wastedKb - a.wastedKb);
  const total = Object.values(byType).reduce((a, t) => a + t.bytes, 0);
  return {
    totalMb: round(total / 1048576, 1),
    byKind: Object.entries(byType).map(([kind, t]) => ({ kind, count: t.n, mb: round(t.bytes / 1048576, 2), share: `${round((t.bytes / total) * 100, 1)} %` })).sort((a, b) => b.mb - a.mb),
    strings: { mb: round(strBytes / 1048576, 2), distinct: strings.size, heldMoreThanOnceMb: round(dupBytes / 1048576, 2), extraCopies: dupCount },
    topDuplicates: dups.slice(0, 25),
    topConstructors: [...ctor].map(([name, r]) => ({ name, count: r.n, mb: round(r.bytes / 1048576, 2) })).sort((a, b) => b.mb - a.mb).slice(0, 15),
  };
};

(async () => {
  const weak = !!arg("weak");
  const ref = arg("ref") === true ? undefined : arg("ref");
  const label = arg("label") === true ? undefined : arg("label");
  const out = { at: new Date().toISOString(), ref: ref || "working tree", weak };

  const without = arg("without") && arg("without") !== true ? String(arg("without")).split(",") : [];
  const seed = { ...(without.includes("known") ? { "cache/search-known.json": null } : {}), ...(without.includes("recs") ? { "cache/recs-titles.json": null } : {}) };
  out.without = without;
  const r = await start({ weak, ref, seed, probe: "off", script: path.join(__dirname, "inproc", "mem-steps.js") });
  const line = r.log.find((l) => l.startsWith("EFF_MEM_STEPS "));
  if (!line) throw new Error(`mem-steps did not report:\n${r.log.slice(-20).join("\n")}`);
  out.byOwner = JSON.parse(line.slice("EFF_MEM_STEPS ".length));
  console.log(`\nheap by owner (after a full collection; baseline ${out.byOwner.baseline.heapMb} MB heap / ${out.byOwner.baseline.rssMb} MB RSS, end ${out.byOwner.end.heapMb} MB heap / ${out.byOwner.end.rssMb} MB RSS)\n`);
  console.log(table(out.byOwner.steps, [["owner", "name"], ["file MB", "onDiskMb"], ["heap MB", "heapMb"], ["RSS MB", "rssMb"], ["load ms", "ms"], ["CPU ms", "cpuMs"]]));

  if (arg("snapshot")) {
    const srv = await start({ weak, ref, seed, loop: false, config: { scanIntervalMinutes: 24 * 60 } });
    try {
      await srv.waitWarm();
      await srv.waitQuiet();
      // a household's worth of use: every profile opens Home, the library, its state, a few searches
      for (let i = 0; i < srv.ds.sessions.length; i++) {
        const h = srv.session(i);
        const p = srv.profile(i);
        for (const u of [`/api/home?profile=${p}`, "/api/library", `/api/profiles/${p}/state`, "/api/search?v=2&q=silent", "/api/search/suggest?v=2&q=go", `/api/profiles/${p}/watchlist`]) {
          try { await (await fetch(srv.url + u, { headers: h })).arrayBuffer(); } catch {}
        }
      }
      await sleep(3000);
      const before = (await srv.gc()).mem;
      const file = path.join(WORK, `warm-${Date.now()}.heapsnapshot`);
      await srv.probe(`/heapsnapshot?file=${encodeURIComponent(file)}`);
      out.warm = { rssMb: round(before.rss / 1048576, 1), heapUsedMb: round(before.heapUsed / 1048576, 1), externalMb: round(before.external / 1048576, 1), arrayBuffersMb: round(before.arrayBuffers / 1048576, 1) };
      out.snapshot = summarise(file);
      fs.rmSync(file, { force: true });
      console.log(`\nwarm server after use by ${srv.ds.sessions.length} profiles: RSS ${out.warm.rssMb} MB, heap ${out.warm.heapUsedMb} MB, external ${out.warm.externalMb} MB\n`);
      console.log(table(out.snapshot.byKind.slice(0, 12), [["kind of object", "kind"], ["count", "count"], ["MB", "mb"], ["share", "share"]]));
      console.log(`\nstrings: ${out.snapshot.strings.mb} MB in ${out.snapshot.strings.distinct} distinct; ${out.snapshot.strings.heldMoreThanOnceMb} MB is extra copies of a string already held\n`);
      console.log(table(out.snapshot.topDuplicates.slice(0, 15), [["string (start)", "sample"], ["chars", "length"], ["copies", "copies"], ["wasted KB", "wastedKb"]]));
    } finally { await srv.stop(); }
  }
  const f = saveJson(`memory${weak ? "-weak" : ""}${without.length ? `-without-${without.join("-")}` : ""}${label ? `-${label}` : ""}.json`, out);
  console.log(`\n${path.relative(process.cwd(), f)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
