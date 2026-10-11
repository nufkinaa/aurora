#!/usr/bin/env node
// What, exactly, keeps a left screen alive: the shortest chain of references
// from the heap's roots to a `.screen` / `.player` element that is no longer
// in the page — read from a heap snapshot after a forced collection.
//
// holders.js lists the usual suspects (listeners on window/document, the
// socket's handlers, intervals). When a screen is still alive and none of
// those is left, this says who has it.
//
//   node tools/mobile-perf/retainers.js --route player [--visits 3] [--match 'class="player'] [--paths 3]
//       [--device desktop-1440] [--query Test]   (Search: what is typed on each visit)
// Prints the chains; writes out/<label>/retainers.<route>.json
"use strict";
const path = require("path");
const { argv, open, emulate, prime, sleep, outDir, writeJson } = require("./lib");

const snapshot = async (cdp) => {
  const chunks = [];
  const on = (e) => chunks.push(e.chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", on);
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  cdp.off("HeapProfiler.addHeapSnapshotChunk", on);
  return JSON.parse(chunks.join(""));
};

// Shortest chains from the roots to the nodes `want` picks.
const chains = (snap, want, max) => {
  const { node_fields: NF, edge_fields: EF, node_types: NT, edge_types: ET } = snap.snapshot.meta;
  const N = NF.length, E = EF.length;
  const f = (name) => NF.indexOf(name);
  const [nType, nName, nEdges, nDet] = [f("type"), f("name"), f("edge_count"), f("detachedness")];
  const [eType, eName, eTo] = [EF.indexOf("type"), EF.indexOf("name_or_index"), EF.indexOf("to_node")];
  const { nodes, edges, strings } = snap;
  const count = nodes.length / N;
  const firstEdge = new Uint32Array(count + 1);
  for (let i = 0, e = 0; i < count; i++) { firstEdge[i] = e; e += nodes[i * N + nEdges]; firstEdge[i + 1] = e; }
  const name = (i) => strings[nodes[i * N + nName]];
  const type = (i) => NT[0][nodes[i * N + nType]];
  const from = new Int32Array(count).fill(-1);
  const via = new Int32Array(count).fill(-1);
  const seen = new Uint8Array(count);
  const queue = new Uint32Array(count);
  let head = 0, tail = 0;
  queue[tail++] = 0; seen[0] = 1;
  while (head < tail) {
    const i = queue[head++];
    for (let e = firstEdge[i]; e < firstEdge[i + 1]; e++) {
      const t = ET[0][edges[e * E + eType]];
      if (t === "weak" || t === "shortcut") continue; // neither keeps anything alive
      const to = edges[e * E + eTo] / N;
      if (seen[to]) continue;
      seen[to] = 1; from[to] = i; via[to] = e;
      queue[tail++] = to;
    }
  }
  const edgeLabel = (e) => {
    const t = ET[0][edges[e * E + eType]];
    const v = edges[e * E + eName];
    return t === "element" || t === "hidden" ? `[${v}]` : `${strings[v]}`;
  };
  const out = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (!seen[i] || !want(name(i), nDet >= 0 ? nodes[i * N + nDet] : 0, type(i))) continue;
    total++;
    if (out.length >= max) continue;
    const chain = [];
    for (let at = i; at > 0 && from[at] >= 0; at = from[at]) chain.unshift({ by: edgeLabel(via[at]), what: `${type(at)} ${String(name(at)).slice(0, 90)}` });
    out.push(chain);
  }
  return { total, chains: out };
};

(async () => {
  const label = argv("label", "run");
  const route = argv("route", "player");
  const visits = Number(argv("visits", 3));
  const match = argv("match", route === "player" ? 'class="player' : 'class="screen');
  const ctx = await open();
  try {
    const all = { home: "#/", movies: "#/movies", ...ctx.inst.routes, settings: "#/preferences", player: `#/play/${ctx.inst.lib.film1}` };
    const hash = all[route];
    const page = await ctx.browser.newPage();
    const cdp = await page.createCDPSession();
    await emulate(page, argv("device", "phone-390"));
    await cdp.send("HeapProfiler.enable");
    await prime(page, ctx.inst, { look: "glass" });
    const base = route === "home" ? "#/downloads" : "#/";
    await page.goto(`${ctx.origin}/${base}`, { waitUntil: "networkidle2" });
    await sleep(7000);
    for (let i = 0; i < visits; i++) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await sleep(route === "player" ? 3000 : 1600);
      if (route === "search" && argv("query", "")) {
        await page.evaluate((q) => { const i = document.querySelector('.screen input[type="search"]'); if (i) { i.focus(); i.value = q; i.dispatchEvent(new Event("input", { bubbles: true })); } }, argv("query", ""));
        await sleep(1500);
      }
      if (route === "player") await page.goBack().catch(() => {});
      await page.evaluate((h) => { location.hash = h; }, base);
      await sleep(1200);
    }
    // somewhere that holds no screen of the kind looked for
    await page.evaluate(() => { location.hash = "#/downloads"; });
    await sleep(1500);
    await cdp.send("HeapProfiler.collectGarbage"); await sleep(300); await cdp.send("HeapProfiler.collectGarbage");
    const snap = await snapshot(cdp);
    // a detached element whose opening tag matches (V8 names an element by its tag: `<div class="player …">`)
    const r = chains(snap, (name, detachedness) => detachedness === 2 && String(name).includes(match), Number(argv("paths", 3)));
    console.log(`\n${route}: ${r.total} detached element(s) matching ${JSON.stringify(match)} are reachable from the roots after ${visits} visits`);
    r.chains.forEach((chain, n) => {
      console.log(`\n  chain ${n + 1}:`);
      for (const step of chain) console.log(`    --${step.by}-->  ${step.what}`);
    });
    writeJson(path.join(outDir(label, "."), `retainers.${route}.json`), r);
    await page.close();
  } finally { await ctx.close(); }
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
