#!/usr/bin/env node
// WHO is holding a screen that was left.
//
// leaks.js says which screens stay in memory; this says why. Each route is
// visited N times from Home with a forced collection after the last, and
// then, for that route:
//
//   screens    how many of its `.screen` elements are still alive although
//              they are no longer in the page (counted by the heap itself:
//              every live HTMLElement is listed after a collection)
//   listeners  what is still registered on something that outlives a screen
//              — window, document, <html>, <body>, a media query, the live
//              socket's message table (js/ws.js) — and was registered while
//              that route was on show: by event and by the line that
//              registered it. A listener that closes over a screen's nodes
//              is what keeps the screen.
//   timers     intervals started on that route and still running
//   growth     DOM nodes, listeners (the browser's own count) and heap, per visit
//
//   node tools/mobile-perf/holders.js --label before [--routes film,show,libfilm,search,player] [--visits 5]
// Writes out/<label>/holders.json and prints the table.
"use strict";
const path = require("path");
const { argv, list, open, emulate, prime, sleep, outDir, writeJson } = require("./lib");

// Runs in the page before any of its code.
const census = () => {
  const live = new Map(); // id -> { type, target, site, route }
  let seq = 0;
  const KEY = Symbol("holders");
  const outlives = (t) =>
    t === window || t === document || t === document.documentElement || t === document.body ||
    (typeof MediaQueryList !== "undefined" && t instanceof MediaQueryList) ||
    (typeof VisualViewport !== "undefined" && t instanceof VisualViewport) ||
    (typeof ServiceWorkerContainer !== "undefined" && t instanceof ServiceWorkerContainer);
  const nameOf = (t) => (t === window ? "window" : t === document ? "document" : t === document.documentElement ? "html" : t === document.body ? "body" : t.constructor.name);
  // the first frame in the app's own code, as "screens/details.js:coverDrift"
  const site = () => {
    for (const line of String(new Error().stack || "").split("\n").slice(2)) {
      const m = /at (?:async )?(?:(\S+) \()?https?:\/\/[^/]+\/js\/([^?:)]+)/.exec(line);
      if (!m || /^vendor\//.test(m[2])) continue;
      return `${m[2]}:${(m[1] || "(top)").replace(/^Object\./, "")}`;
    }
    return "?";
  };
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const cap = (o) => !!(o === true || (o && o.capture));
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (fn && outlives(this)) {
      const table = fn[KEY] || (fn[KEY] = new Map());
      const k = `${nameOf(this)}|${type}|${cap(opts)}`;
      if (!table.has(k)) {
        const id = ++seq;
        table.set(k, id);
        live.set(id, { type, target: nameOf(this), site: site(), route: location.hash || "#/" });
        const gone = () => { live.delete(id); table.delete(k); };
        if (opts && opts.once) add.call(this, type, gone, { once: true, capture: cap(opts) });
        if (opts && opts.signal) opts.signal.addEventListener("abort", gone, { once: true });
      }
    }
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    if (fn && fn[KEY]) {
      const k = `${nameOf(this)}|${type}|${cap(opts)}`;
      const id = fn[KEY].get(k);
      if (id) { live.delete(id); fn[KEY].delete(k); }
    }
    return remove.call(this, type, fn, opts);
  };
  const timers = new Map();
  const si = window.setInterval;
  const ci = window.clearInterval;
  window.setInterval = function (fn, ms, ...rest) {
    const id = si.call(window, fn, ms, ...rest);
    timers.set(id, { ms, site: site(), route: location.hash || "#/" });
    return id;
  };
  window.clearInterval = function (id) { timers.delete(id); return ci.call(window, id); };
  window.__holders = { live, timers };
};

const shape = (hash) => hash.replace(/tt\d+/g, ":id").replace(/\/[0-9a-f]{8,}/g, "/:id").replace(/\?.*$/, "");

(async () => {
  const label = argv("label", "run");
  const visits = Number(argv("visits", 5));
  const ctx = await open();
  const all = { home: "#/", movies: "#/movies", ...ctx.inst.routes, settings: "#/preferences", player: `#/play/${ctx.inst.lib.film1}` };
  const names = list("routes", "film,show,libfilm,search,player,home,movies");
  const out = {};
  try {
    for (const name of names) {
      const hash = all[name];
      if (!hash) { console.log(`  (no route "${name}")`); continue; }
      // a fresh page per route: what is left at the end is this route's
      const page = await ctx.browser.newPage();
      const cdp = await page.createCDPSession();
      await emulate(page, "phone-390");
      await cdp.send("Performance.enable");
      await cdp.send("HeapProfiler.enable");
      await prime(page, ctx.inst, { look: "glass" });
      await page.evaluateOnNewDocument(census);
      const base = name === "home" ? "#/movies" : "#/";
      await page.goto(`${ctx.origin}/${base}`, { waitUntil: "networkidle2" });
      await sleep(7000); // the other screens' code has been warmed by now
      const metrics = async () => {
        await cdp.send("HeapProfiler.collectGarbage"); await sleep(250); await cdp.send("HeapProfiler.collectGarbage");
        const x = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((k) => [k.name, k.value]));
        return { nodes: x.Nodes, listeners: x.JSEventListeners, heapKB: Math.round(x.JSHeapUsedSize / 1024) };
      };
      // the socket's message table (js/ws.js): handlers per message type
      const socket = () => page.evaluate(async () => {
        const ws = await import("/js/ws.js");
        return ws._listeners ? Object.fromEntries([...ws._listeners].map(([k, v]) => [k, v.size]).filter(([, n]) => n)) : null;
      });
      const visit = async () => {
        await page.evaluate((h) => { location.hash = h; }, hash);
        await sleep(name === "player" ? 3000 : 1600);
        if (name === "search") {
          // a search screen that was used: type, wait for results
          await page.evaluate(() => { const i = document.querySelector('.screen input[type="search"]'); if (i) { i.value = "the"; i.dispatchEvent(new Event("input", { bubbles: true })); } });
          await sleep(1200);
        }
        if (name === "player") await page.goBack().catch(() => {});
        await page.evaluate((h) => { location.hash = h; }, base);
        await sleep(1100);
      };
      await visit(); // the first one fills caches and loads the screen's code
      const m0 = await metrics();
      const s0 = await socket();
      for (let i = 0; i < visits; i++) await visit();
      const m1 = await metrics();
      const s1 = await socket();
      // every live element after a collection; the ones that are a screen (or the player) and not in the page
      const proto = await page.evaluateHandle(() => HTMLElement.prototype);
      const objects = await page.queryObjects(proto);
      const detached = await page.evaluate((els) => {
        const by = {};
        for (const e of els) {
          if (e.isConnected || !e.classList) continue;
          if (!(e.classList.contains("screen") || e.classList.contains("player"))) continue;
          if (e.parentNode) continue; // only the root of what is held
          const k = "." + [...e.classList].join(".");
          by[k] = (by[k] || 0) + 1;
        }
        return by;
      }, objects);
      await objects.dispose(); await proto.dispose();
      const held = await page.evaluate(() => ({
        live: [...window.__holders.live.values()],
        timers: [...window.__holders.timers.values()],
      }));
      const mine = (r) => shape(r.route) === shape(hash);
      const group = (rows, key) => {
        const by = {};
        for (const r of rows.filter(mine)) { const k = key(r); by[k] = (by[k] || 0) + 1; }
        return Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]));
      };
      const socketGrowth = s0 && s1 ? Object.fromEntries(Object.keys({ ...s0, ...s1 }).map((k) => [k, (s1[k] || 0) - (s0[k] || 0)]).filter(([, n]) => n)) : null;
      out[name] = {
        route: shape(hash), visits: visits + 1,
        detachedScreens: detached,
        listenersLeft: group(held.live, (r) => `${r.target} "${r.type}"  ←  ${r.site}`),
        socketHandlersGrowth: socketGrowth,
        timersLeft: group(held.timers, (r) => `every ${r.ms} ms  ←  ${r.site}`),
        perVisit: { nodes: Math.round((m1.nodes - m0.nodes) / visits), listeners: Math.round((m1.listeners - m0.listeners) / visits), heapKB: Math.round((m1.heapKB - m0.heapKB) / visits) },
      };
      const o = out[name];
      const total = Object.values(o.detachedScreens).reduce((a, b) => a + b, 0);
      console.log(`\n${name}  (${o.route}, ${o.visits} visits)`);
      console.log(`  per visit: +${o.perVisit.nodes} nodes, +${o.perVisit.listeners} listeners, +${o.perVisit.heapKB} KB`);
      console.log(`  screens left alive outside the page: ${total}${total ? "  " + JSON.stringify(o.detachedScreens) : ""}`);
      for (const [k, n] of Object.entries(o.listenersLeft)) console.log(`  listener ×${n}  ${k}`);
      if (socketGrowth) for (const [k, n] of Object.entries(socketGrowth)) console.log(`  socket handler ${n > 0 ? "+" : ""}${n} over ${visits} visits  "${k}"`);
      for (const [k, n] of Object.entries(o.timersLeft)) console.log(`  interval ×${n}  ${k}`);
      await page.close();
    }
  } finally { await ctx.close(); }
  writeJson(path.join(outDir(label, "."), "holders.json"), out);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
