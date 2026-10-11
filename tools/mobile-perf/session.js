#!/usr/bin/env node
// What five minutes of browsing costs in data.
//
//   node tools/mobile-perf/session.js --label baseline [--modes auto,saver]
//       [--line fast3g] [--device phone-390] [--minutes 5]
//
// One scripted visit on a phone: Home (read it, scroll it, swipe a shelf),
// a title page, back, Movies (scroll), Search (type), a second title, My
// List, Settings — then back on Home, where the billboard keeps turning,
// until the time is up. Every byte the browser takes off the wire is counted
// (the page's requests and the service worker's), by kind and by minute.
//
//   auto    the app decides by the line it measures (js/net.js)
//   saver   Settings → Data use → Data saver (always the light pictures)
//
// It also answers "does the light mode kick in by itself on a slow line?":
// the connection tier the app settled on is read back at the end
// (<html data-net>), with what it measured.
// Writes out/<label>/session/<line>.<mode>.json
"use strict";
const path = require("path");
const { argv, list, open, emulate, prime, sleep, outDir, writeJson } = require("./lib");

const main = async () => {
  const label = argv("label", "run");
  const modes = list("modes", "auto,saver");
  const lineName = argv("line", "fast3g");
  const device = argv("device", "phone-390");
  const minutes = Number(argv("minutes", 5));
  const dir = outDir(label, "session");
  const ctx = await open();
  const summary = [];
  try {
    for (const mode of modes) {
      const line = await ctx.line(lineName);
      try {
        const { origin, inst } = line;
        const page = await ctx.browser.newPage();
        const cdp = await page.createCDPSession();
        await emulate(page, device);
        await cdp.send("Network.enable");
        await cdp.send("Network.clearBrowserCache");
        await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "cache_storage,service_workers,indexeddb" });
        await prime(page, inst, { look: "glass", extra: mode === "saver" ? { "aurora-data-mode": "saver" } : {} });
        const t0 = Date.now();
        const reqs = new Map();
        const watch = async (session, sw) => {
          await session.send("Network.enable").catch(() => {});
          session.on("Network.requestWillBeSent", (e) => { if (e.request.url.startsWith(origin)) reqs.set((sw ? "s" : "p") + e.requestId, { path: e.request.url.slice(origin.length), type: e.type, sw, at: Date.now() - t0, bytes: 0 }); });
          session.on("Network.loadingFinished", (e) => { const r = reqs.get((sw ? "s" : "p") + e.requestId); if (r) r.bytes = e.encodedDataLength || 0; });
          // a long download is counted as it arrives, not only when it ends
          session.on("Network.dataReceived", (e) => { const r = reqs.get((sw ? "s" : "p") + e.requestId); if (r && !r.done) r.bytes += e.encodedDataLength || 0; });
          session.on("Network.loadingFinished", (e) => { const r = reqs.get((sw ? "s" : "p") + e.requestId); if (r) { r.bytes = e.encodedDataLength || r.bytes; r.done = true; } });
        };
        await watch(cdp, false);
        const onTarget = async (target) => { if (target.type() === "service_worker" && target.url().startsWith(origin)) { try { await watch(await target.createCDPSession(), true); } catch {} } };
        ctx.browser.on("targetcreated", onTarget);

        const vp = page.viewport();
        const scroll = (dy, repeat = 1) => cdp.send("Input.synthesizeScrollGesture", { x: vp.width / 2, y: vp.height * 0.6, yDistance: dy, speed: 1200, gestureSourceType: "touch", repeatCount: repeat, repeatDelayMs: 900 });
        const go = (hash) => page.evaluate((h) => { location.hash = h; }, hash);
        const steps = [];
        const step = async (name, fn) => { const at = Date.now() - t0; await fn().catch((e) => steps.push({ name, error: String(e.message).slice(0, 80) })); steps.push({ name, at }); };

        await step("home", async () => { await page.goto(`${origin}/#/`, { waitUntil: "domcontentloaded", timeout: 120000 }); await page.waitForSelector(".row .card", { timeout: 120000 }); await sleep(8000); });
        await step("home: scroll", async () => { await scroll(-vp.height * 0.8, 4); await sleep(3000); });
        await step("home: swipe a shelf", async () => { await cdp.send("Input.synthesizeScrollGesture", { x: vp.width * 0.8, y: vp.height * 0.5, xDistance: -vp.width * 0.9, speed: 1400, gestureSourceType: "touch", repeatCount: 2, repeatDelayMs: 700 }); await sleep(3000); });
        await step("title (film)", async () => { await go(inst.routes.film); await sleep(12000); });
        await step("back home", async () => { await page.goBack().catch(() => {}); await sleep(5000); });
        await step("movies", async () => { await go("#/movies"); await sleep(6000); await scroll(-vp.height * 0.8, 4); await sleep(4000); });
        await step("search", async () => {
          await go("#/search");
          const input = await page.waitForSelector("#app input", { timeout: 60000, visible: true });
          await input.tap();
          for (const ch of "harbor") { await page.keyboard.type(ch); await sleep(250); }
          await sleep(6000);
        });
        await step("title (series)", async () => { await go(inst.routes.show); await sleep(12000); });
        await step("my list", async () => { await go("#/list"); await sleep(6000); });
        await step("settings", async () => { await go("#/preferences"); await sleep(6000); });
        await step("home again, left open", async () => { await go("#/"); await sleep(Math.max(3000, minutes * 60000 - (Date.now() - t0))); });

        const net = await page.evaluate(() => ({ tier: document.documentElement.dataset.net, fx: document.documentElement.dataset.fx }));
        ctx.browser.off("targetcreated", onTarget);
        const all = [...reqs.values()];
        const kind = (r) => r.sw ? "worker" : r.type === "Script" ? "js" : r.type === "Stylesheet" ? "css" : r.type === "Document" ? "html" : (r.type === "Image" || r.path.startsWith("/img/")) ? "img" : r.path.startsWith("/api/netprobe") ? "probe" : r.path.startsWith("/api/") ? "api" : "other";
        const byKind = {};
        for (const r of all) { const k = (byKind[kind(r)] = byKind[kind(r)] || { n: 0, bytes: 0 }); k.n++; k.bytes += r.bytes; }
        const byMinute = [];
        for (const r of all) { const m = Math.floor(r.at / 60000); byMinute[m] = (byMinute[m] || 0) + r.bytes; }
        const total = all.reduce((a, r) => a + r.bytes, 0);
        const out = { line: lineName, mode, device, minutes, tierAtEnd: net.tier, totalBytes: total, requests: all.length, byKind, byMinuteKB: byMinute.map((b) => Math.round((b || 0) / 1024)), steps, biggest: all.sort((a, b) => b.bytes - a.bytes).slice(0, 15).map((r) => ({ kb: Math.round(r.bytes / 1024), at: Math.round(r.at / 1000), sw: r.sw, path: r.path.slice(0, 100) })) };
        writeJson(path.join(dir, `${lineName}.${mode}.json`), out);
        summary.push({ cell: `${lineName} ${mode}`, MB: +(total / 1048576).toFixed(2), requests: all.length, tier: net.tier, ...Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, `${Math.round(v.bytes / 1024)}K/${v.n}`])) });
        await page.close();
      } finally {
        await line.stop();
      }
    }
  } finally {
    await ctx.close();
  }
  console.table(summary);
};

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
