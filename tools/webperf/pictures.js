#!/usr/bin/env node
// Picture priority on Home: when do the pictures the person can see arrive,
// and when do the ones they cannot see start to compete with them?
//
//   node tools/webperf/pictures.js --instances <A state>,<B state> --labels before,after
//       [--devices phone-390,phone-360,desktop-1440] [--looks glass,legacy]
//       [--lines fast3g,slow3g] [--cpu 4] [--runs 5] [--data full|auto]
//       [--out <file.json>]
//
// First, per instance × device × look, one unmeasured visit that loads every
// picture of Home (the server cuts each to this device's sizes once and keeps
// the cut). Then each run: a fresh browser context, cold (no HTTP cache, no
// service worker, the profile remembered), Chrome's CPU slowdown and line
// emulation, Home opened and left alone (no scroll) until every picture in
// the first screen has arrived plus 3 s. The runs of A and B are interleaved
// (A B, B A, A B…) so whatever else the machine does slows both alike.
//
// Per run (ms from navigation start, the page's own clock):
//   heroArt     the billboard's first picture has arrived (Resource Timing
//               responseEnd; on a portrait phone the earliest size of its
//               poster, elsewhere the backdrop its layer paints)
//   heroSharp   portrait phone only: the large poster that replaces it
//   row1        every picture of the first shelf in view has arrived AND
//               decoded (img.decode() after its load event)
//   visible     every <img> in view likewise, and the billboard
//   visStart    when the last picture in view was asked for
//   heroR, visibleR, offStartR   the same three from Home's own mark
//               "aurora-home-rows" (its first shelves are on the page): what
//               the page did with its pictures, without the boot's noise
//   lcp         largest contentful paint (before the billboard first turns)
//   rows        Home's mark itself
//   offStart    the first picture request that is NOT one the screen shows
//               (offscreen cards, other slides, prefetch, upgrades, the
//               nav tint's probe)
//   offBefore   how many such requests started before the last picture in
//   offKB       view had arrived, and their bytes
//   offTotal    such requests in the whole window
//   visHigh     share of the in-view card pictures Chrome fetched at High
//               priority (CDP, final priority)
//   layouts, layoutMs, taskMs   Chrome's main-thread counters for the window
//
// The made-up library's covers are tiny, and the server keeps a cut under
// 512 bytes for 30 s only (lib/imgvariant.js): they are asked for again from
// here right before each run, so neither side meets a cold cutter.
"use strict";
const { argv, list, DEVICES, launch, newContext, throttle, prime, clearCaches, sleep, median, writeJson } = require("./lib");
const fs = require("fs");
const path = require("path");

const INIT = () => {
  try { performance.setResourceTimingBufferSize(5000); } catch {}
  const w = (window.__pp = { lcps: [], imgs: new Map() });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.lcps.push(e.startTime); }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
  // every <img> load: when it arrived, and when it was decoded
  document.addEventListener("load", (e) => {
    const im = e.target;
    if (!(im instanceof HTMLImageElement)) return;
    const t = performance.now();
    const rec = { loaded: t, decoded: null, src: im.currentSrc || im.src };
    w.imgs.set(im, rec);
    try { im.decode().then(() => { rec.decoded = performance.now(); }, () => { rec.decoded = rec.loaded; }); } catch { rec.decoded = t; }
  }, true);
};

const absolute = (origin, u) => { try { return new URL(u, origin).href; } catch { return u; } };

const runOnce = async (browser, inst, { device, look, line, cpu, data }) => {
  const ctx = await newContext(browser, device);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  try {
    await prime(page, inst, { look, extra: data === "auto" ? {} : { "aurora-data-mode": data } });
    await clearCaches(cdp, inst.url);
    await page.addInitScript(INIT);
    const prio = new Map(); // url -> final priority
    cdp.on("Network.requestWillBeSent", (e) => { if (e.type === "Image") prio.set(e.request.url, { id: e.requestId, p: e.request.initialPriority, first: e.request.initialPriority }); });
    cdp.on("Network.resourceChangedPriority", (e) => { for (const v of prio.values()) if (v.id === e.requestId) v.p = e.newPriority; });
    await throttle(cdp, { line, cpu });
    await cdp.send("Performance.enable").catch(() => {});
    await page.goto(`${inst.url}/#/`, { waitUntil: "commit", timeout: 180000 });
    // until every picture in the first screen is in (or a long time passed)
    const t0 = Date.now();
    const limit = line === "slow3g" ? 150000 : 60000;
    let settledAt = 0;
    for (;;) {
      await sleep(1000);
      const done = await page.evaluate(() => {
        const w = window.__pp;
        if (!document.querySelector(".row .card")) return false;
        const vh = innerHeight, vw = innerWidth;
        for (const im of document.querySelectorAll("img")) {
          const r = im.getBoundingClientRect();
          if (!r.width || !r.height || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
          if (getComputedStyle(im).visibility === "hidden") continue;
          const rec = w.imgs.get(im);
          if (!rec || rec.decoded == null) return false;
        }
        // …and the billboard's picture (a CSS background: Resource Timing)
        const layer = document.querySelector(".hero-backdrop.fade.on");
        if (document.querySelector(".hero") && !layer) return false;
        if (layer) {
          const portrait = matchMedia("(max-width: 900px) and (orientation: portrait)").matches;
          const m = /url\("?([^")]+)"?\)/.exec(layer.style.getPropertyValue(portrait ? "--hero-poster" : "--hero-art") || "");
          if (m) {
            const u = new URL(m[1], location.href).href;
            const e = performance.getEntriesByName(u)[0];
            if (!e || !e.responseEnd) return false;
          }
        }
        return true;
      }).catch(() => false);
      if (done && !settledAt) settledAt = Date.now();
      if (settledAt && Date.now() - settledAt > 3000) break;
      if (Date.now() - t0 > limit) break;
    }
    const res = await page.evaluate((origin) => {
      const w = window.__pp;
      const abs = (u) => { try { return new URL(u, origin).href; } catch { return u; } };
      const vh = innerHeight, vw = innerWidth;
      const res = performance.getEntriesByType("resource");
      const byUrl = new Map();
      for (const r of res) if (!byUrl.has(r.name)) byUrl.set(r.name, r);
      // the billboard: the layer on show, and the picture it paints
      const layer = document.querySelector(".hero-backdrop.fade.on");
      const portrait = matchMedia("(max-width: 900px) and (orientation: portrait)").matches;
      const cssUrl = (v) => { const m = /url\("?([^")]+)"?\)/.exec(v || ""); return m ? abs(m[1]) : null; };
      let heroUrl = null, heroNow = null;
      if (layer) {
        heroNow = cssUrl(layer.style.getPropertyValue(portrait ? "--hero-poster" : "--hero-art"));
        heroUrl = heroNow;
      }
      // the first (small) hero picture: the 400 / backdrop asked for first
      const heroEntries = res.filter((r) => r.initiatorType !== "xmlhttprequest" && r.initiatorType !== "fetch" && /\/img\/ext/.test(r.name));
      const visible = [];
      const shown = new Set();
      for (const im of document.querySelectorAll("img")) {
        const r = im.getBoundingClientRect();
        if (!r.width || !r.height || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
        if (getComputedStyle(im).visibility === "hidden") continue;
        const rec = w.imgs.get(im);
        const row = im.closest(".row");
        const rows = [...document.querySelectorAll(".row")];
        visible.push({ src: abs(im.currentSrc || im.src), row: row ? rows.indexOf(row) : -1, hero: !!im.closest(".hero"), loaded: rec ? rec.loaded : null, decoded: rec ? rec.decoded : null });
        shown.add(abs(im.currentSrc || im.src));
      }
      // the hero layer's pictures count as shown (both sizes of the poster)
      const heroUrls = new Set();
      if (layer) for (const p of ["--hero-poster", "--hero-art", "--hero-blur"]) { const u = cssUrl(layer.style.getPropertyValue(p)); if (u) heroUrls.add(u); }
      // the classic look's poster card, where a narrow screen hides it
      const hp = document.querySelector(".hero-poster");
      const hiddenPoster = hp && hp.getAttribute("src") && hp.offsetParent === null ? abs(hp.currentSrc || hp.src) : null;
      return {
        vh, portrait, heroNow, hiddenPoster,
        heroEnd: heroNow && byUrl.get(heroNow) ? byUrl.get(heroNow).responseEnd : null,
        lcps: w.lcps,
        rowsMark: (performance.getEntriesByName("aurora-home-rows")[0] || {}).startTime || null,
        visible,
        images: res.filter((r) => r.initiatorType === "img" || r.initiatorType === "css" || r.initiatorType === "other" || /\/img\//.test(r.name))
          .filter((r) => /\/img\/|\.(png|jpe?g|webp|avif|gif|svg)(\?|$)/.test(r.name))
          .map((r) => ({ url: r.name, start: r.startTime, end: r.responseEnd, kb: (r.encodedBodySize || r.transferSize || 0) / 1024, init: r.initiatorType })),
        heroUrls: [...heroUrls],
        shown: [...shown],
      };
    }, inst.url);
    // main-thread work over the whole window (layouts: how many, how long)
    const pm = Object.fromEntries(((await cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] }))).metrics || []).map((m) => [m.name, m.value]));
    // the first (small) billboard picture: on a portrait phone the 400 poster
    // asked for first, the large one replacing it later
    const imgs = res.images;
    // the billboard's title, by its picture's address (a catalogue id or a
    // library id); on a portrait phone every size of its poster is the hero
    const key = res.heroNow ? ((/tt\d+/.exec(res.heroNow) || /\/img\/([0-9a-f]{8,})/.exec(res.heroNow) || [])[0] || null) : null;
    const heroPics = imgs.filter((i) => res.heroUrls.includes(i.url) || (res.portrait && key && i.url.includes(key) && /poster/.test(i.url) && i.url !== res.hiddenPoster));
    const shown = new Set([...res.shown, ...res.heroUrls, ...heroPics.map((i) => i.url)]);
    const heroFirst = res.portrait
      ? (heroPics.length ? Math.min(...heroPics.map((i) => i.end)) : null)
      : res.heroEnd;
    const heroSharp = res.portrait ? res.heroEnd : null;
    const cards = res.visible.filter((v) => !v.hero);
    const row1 = cards.filter((v) => v.row === Math.min(...cards.map((c) => (c.row < 0 ? 99 : c.row))));
    // (no card in view — a desktop's billboard fills the first screen: 0)
    const maxOf = (a) => (!a.length ? 0 : a.every((v) => v.decoded != null) ? Math.max(...a.map((v) => v.decoded)) : null);
    const visibleImgs = maxOf(res.visible);
    const loadedOf = (a) => (!a.length ? 0 : a.every((v) => v.loaded != null) ? Math.max(...a.map((v) => v.loaded)) : null);
    const visibleArrived = loadedOf(res.visible) != null && heroFirst != null ? Math.max(loadedOf(res.visible), heroFirst) : null;
    const visibleAll = visibleImgs != null && heroFirst != null ? Math.max(visibleImgs, heroFirst) : null;
    const off = imgs.filter((i) => !shown.has(i.url) && !/\/(favicon|icon|apple-touch|logo)/.test(i.url) && !i.url.startsWith("data:"));
    const offStart = off.length ? Math.min(...off.map((i) => i.start)) : null;
    // (before the last picture in view had ARRIVED: its decoding comes a
    // moment later, and the pictures out of view are let go at the arrival)
    const offBeforeList = visibleArrived != null ? off.filter((i) => i.start < visibleArrived - 1) : off;
    const visCardUrls = new Set(cards.map((c) => c.src));
    let hi = 0, n = 0;
    for (const [u, v] of prio) if (visCardUrls.has(u)) { n++; if (v.p === "High" || v.p === "VeryHigh") hi++; }
    const lcpCut = res.rowsMark != null ? res.rowsMark + 8500 : Infinity;
    const lcps = res.lcps.filter((t) => t < lcpCut);
    return {
      heroArt: heroFirst != null ? Math.round(heroFirst) : null,
      heroSharp: heroSharp != null ? Math.round(heroSharp) : null,
      row1: row1.length ? (maxOf(row1) != null ? Math.round(maxOf(row1)) : null) : null,
      row1n: row1.length,
      visible: visibleAll != null ? Math.round(visibleAll) : null,
      visn: res.visible.length,
      lcp: lcps.length ? Math.round(lcps[lcps.length - 1]) : null,
      rows: res.rowsMark != null ? Math.round(res.rowsMark) : null,
      // the same, from the moment Home's shelves were on the page (its own
      // mark): what the page did with its pictures, without the boot's noise
      heroR: heroFirst != null && res.rowsMark != null ? Math.round(heroFirst - res.rowsMark) : null,
      visibleR: visibleAll != null && res.rowsMark != null ? Math.round(visibleAll - res.rowsMark) : null,
      offStartR: offStart != null && res.rowsMark != null ? Math.round(offStart - res.rowsMark) : null,
      offStart: offStart != null ? Math.round(offStart) : null,
      offBefore: offBeforeList.length,
      offKB: Math.round(offBeforeList.reduce((a, i) => a + i.kb, 0)),
      offTotal: off.length,
      visHigh: n ? +(hi / n).toFixed(2) : null,
      imgReqs: imgs.length,
      layouts: pm.LayoutCount != null ? pm.LayoutCount : null,
      layoutMs: pm.LayoutDuration != null ? Math.round(pm.LayoutDuration * 1000) : null,
      taskMs: pm.TaskDuration != null ? Math.round(pm.TaskDuration * 1000) : null,
      // when the latest picture in view was asked for, and the list of them
      visStart: (() => { const st = res.visible.map((v) => (imgs.find((i) => i.url === v.src) || {}).start).filter((x) => x != null); return st.length ? Math.round(Math.max(...st)) : null; })(),
      visList: res.visible.map((v) => { const e = imgs.find((i) => i.url === v.src) || {}; return `${Math.round(e.start)}-${Math.round(e.end)} dec ${Math.round(v.decoded)} ${v.src.replace(inst.url, "").slice(0, 70)}`; }),
      offList: offBeforeList.slice(0, 40).map((i) => `${Math.round(i.start)} ${i.url.replace(inst.url, "").slice(0, 90)}`),
    };
  } finally {
    await ctx.close().catch(() => {});
  }
};

// An unmeasured visit first, per instance × device × look: the server cuts
// every picture to the sizes this device asks for once and keeps the cut
// (/img/ext, ?w=), so the measured runs compare the site, not a cold cutter.
const warmUp = async (browser, inst, { device, look, data }) => {
  const ctx = await newContext(browser, device);
  const page = await ctx.newPage();
  try {
    await prime(page, inst, { look, extra: data === "auto" ? {} : { "aurora-data-mode": data } });
    await page.goto(`${inst.url}/#/`, { waitUntil: "load", timeout: 120000 });
    await page.waitForSelector(".row .card", { timeout: 60000 });
    await sleep(1500);
    // (a touch lets every waiting picture go — ui.js)
    await page.evaluate(() => window.dispatchEvent(new Event("pointerdown")));
    await sleep(500);
    await page.evaluate(() => { for (const im of document.querySelectorAll("img")) im.loading = "eager"; });
    await page.waitForFunction(() => [...document.querySelectorAll("img")].every((i) => !i.getAttribute("src") || i.complete), null, { timeout: 120000, polling: 500 }).catch(() => {});
    await sleep(6000); // the idle upgrades and the nav tint's probe
    // (the test library's covers are tiny, and the server's variant cache
    // keeps a cut under 512 bytes for 30 s only — lib/imgvariant.js — so they
    // are asked for again right before each measured run: see `rewarm`)
    return await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((u) => /\/img\/[0-9a-f]{8,}\?/.test(u)));
  } finally {
    await ctx.close().catch(() => {});
  }
};

(async () => {
  const instFiles = list("instances", "");
  const labels = list("labels", instFiles.map((_, i) => `v${i}`).join(","));
  const insts = instFiles.map((f) => JSON.parse(fs.readFileSync(path.resolve(f), "utf8")));
  const devices = list("devices", "phone-390");
  const looks = list("looks", "glass,legacy");
  const lines = list("lines", "fast3g");
  const cpus = list("cpu", "4").map(Number);
  const runs = Number(argv("runs", 5));
  const data = argv("data", "full");
  const out = argv("out", path.join(__dirname, "out", `pictures-${Date.now()}.json`));
  const browser = await launch();
  const warmed = new Set();
  const rewarmList = new Map();
  const result = { when: new Date().toISOString(), labels, data, cells: [] };
  const KEYS = ["heroArt", "heroSharp", "row1", "visible", "visStart", "heroR", "visibleR", "offStartR", "lcp", "rows", "offStart", "offBefore", "offKB", "offTotal", "visHigh", "imgReqs", "layouts", "layoutMs", "taskMs"];
  try {
    for (const device of devices) for (const look of looks) for (const line of lines) for (const cpu of cpus) {
      const cell = { device, look, line, cpu, runs: labels.map(() => []) };
      const wkey = `${device}|${look}`;
      if (!warmed.has(wkey)) {
        warmed.add(wkey);
        // (an instance listed twice — two modes of one — is warmed once)
        for (const [i, inst] of insts.entries()) if (instFiles.indexOf(instFiles[i]) !== i) rewarmList.set(`${i}|${wkey}`, rewarmList.get(`${instFiles.indexOf(instFiles[i])}|${wkey}`)); else rewarmList.set(`${i}|${wkey}`, (await warmUp(browser, inst, { device, look, data }).catch(() => [])) || []);
      }
      for (let r = 0; r < runs; r++) {
        // alternate which side goes first
        const order = labels.map((_, i) => i);
        if (r % 2) order.reverse();
        for (const i of order) {
          await Promise.all((rewarmList.get(`${i}|${wkey}`) || []).map((u) => fetch(u).then((r) => r.arrayBuffer()).catch(() => null)));
          const m = await runOnce(browser, insts[i], { device, look, line, cpu, data }).catch((e) => ({ error: String(e.message || e) }));
          cell.runs[i].push(m);
          process.stdout.write(`${device} ${look} ${line} x${cpu} run ${r + 1} ${labels[i]}: ${KEYS.map((k) => `${k}=${m[k]}`).join(" ")}${m.error ? " ERR " + m.error : ""}\n`);
        }
      }
      cell.median = labels.map((_, i) => Object.fromEntries(KEYS.map((k) => [k, median(cell.runs[i].map((m) => m[k]))])));
      result.cells.push(cell);
      writeJson(out, result);
      console.log(`== ${device} ${look} ${line} x${cpu} medians`);
      labels.forEach((l, i) => console.log(`   ${l.padEnd(8)} ${KEYS.map((k) => `${k}=${cell.median[i][k]}`).join(" ")}`));
    }
  } finally {
    await browser.close();
  }
  writeJson(out, result);
  console.log(`wrote ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
