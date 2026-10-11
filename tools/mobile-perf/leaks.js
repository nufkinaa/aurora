#!/usr/bin/env node
// Which screen leaks: each route visited six times from Search (a small
// screen), a forced garbage collection after every visit, and what is left —
// DOM nodes and listeners that grow with every visit are held by something.
//
//   node tools/mobile-perf/leaks.js --label baseline
// Writes out/<label>/leaks.json
"use strict";
const path = require("path");
const { argv, open, emulate, prime, sleep, outDir, writeJson } = require("./lib");

(async () => {
  const label = argv("label", "run");
  const ctx = await open();
  const out = {};
  try {
    const page = await ctx.browser.newPage();
    const cdp = await page.createCDPSession();
    await emulate(page, "phone-390");
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");
    await prime(page, ctx.inst, { look: "glass" });
    await page.goto(`${ctx.origin}/#/search`, { waitUntil: "networkidle2" });
    await sleep(6000); // the other screens' code has been warmed by now
    const m = async () => {
      await cdp.send("HeapProfiler.collectGarbage"); await sleep(250); await cdp.send("HeapProfiler.collectGarbage");
      const x = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((k) => [k.name, k.value]));
      return { nodes: x.Nodes, listeners: x.JSEventListeners, heapKB: Math.round(x.JSHeapUsedSize / 1024) };
    };
    const routes = { home: "#/", movies: "#/movies", shows: "#/shows", list: "#/list", film: ctx.inst.routes.film, show: ctx.inst.routes.show, libfilm: ctx.inst.routes.libfilm, settings: "#/preferences", downloads: "#/downloads", "new": "#/new", player: `#/play/${ctx.inst.lib.film1}` };
    for (const [name, hash] of Object.entries(routes)) {
      const seen = [];
      for (let i = 0; i < 6; i++) {
        await page.evaluate((h) => { location.hash = h; }, hash);
        await sleep(name === "player" ? 2500 : 1300);
        if (name === "player") await page.goBack().catch(() => {});
        await page.evaluate(() => { location.hash = "#/search"; });
        await sleep(900);
        seen.push(await m());
      }
      // growth per visit over the last four (the first two fill caches)
      const per = (k) => Math.round((seen[5][k] - seen[1][k]) / 4);
      out[name] = { perVisit: { nodes: per("nodes"), listeners: per("listeners"), heapKB: per("heapKB") }, seen };
      console.log(`  ${name}: +${out[name].perVisit.nodes} nodes, +${out[name].perVisit.listeners} listeners, +${out[name].perVisit.heapKB} KB per visit`);
    }
    await page.close();
  } finally { await ctx.close(); }
  writeJson(path.join(outDir(label, "."), "leaks.json"), out);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
