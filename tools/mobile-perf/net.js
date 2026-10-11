#!/usr/bin/env node
// A weak line, for real: how long until Home (or another route) is usable,
// what was on the wire before that, and what the visit cost in bytes.
//
//   node tools/mobile-perf/net.js --label baseline
//       [--lines slow3g,regular3g,fast3g,none] [--routes home] [--looks glass]
//       [--device phone-390] [--cpu 4] [--runs 5] [--cache cold,warm] [--loss 0]
//
// The line is tools/throttle-proxy.js (bandwidth + latency on every byte,
// the service worker's included), in front of the HTTP/2 front; the CPU is
// slowed by Chrome (--cpu). Per run, in ms since the navigation began:
//
//   fcp          first contentful paint
//   heroText     the billboard's title is on the page
//   usable       billboard title + the first shelf's cards are on the page
//   heroPicture  the billboard's picture has arrived
//   viewport     every picture in the first screenful has arrived
//   lcp          largest contentful paint (and which element)
//   quiet        nothing has been on the wire for 3 s
//
// and the requests behind them: how many and how many bytes before the first
// paint, before `usable`, before `viewport`, in all — by kind, the service
// worker's own downloads counted separately. Writes out/<label>/net/*.json.
"use strict";
const path = require("path");
const { argv, list, open, emulate, prime, clearCaches, sleep, spread, outDir, writeJson } = require("./lib");

// Runs in the page before any of its own code.
const PROBE = () => {
  const mp = (window.__mp = { paint: {}, lcp: null, cls: 0, shifts: [], marks: {} });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) mp.paint[e.name] = e.startTime; }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        const n = e.element;
        mp.lcp = { t: e.startTime, size: e.size, url: e.url || "", el: n ? `${n.tagName.toLowerCase()}.${String(n.className || "").split(/\s+/).slice(0, 3).join(".")}` : "" };
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        mp.cls += e.value;
        mp.shifts.push({ t: e.startTime, v: e.value, nodes: (e.sources || []).map((s) => s.node && `${s.node.nodeName.toLowerCase()}.${String(s.node.className || "").split(/\s+/).slice(0, 2).join(".")}`) });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
  const mark = (k) => { if (mp.marks[k] == null) mp.marks[k] = performance.now(); };
  const fetched = (url) => {
    try {
      const abs = new URL(url, location.href).href;
      return performance.getEntriesByName(abs).some((e) => e.responseEnd > 0);
    } catch { return false; }
  };
  const tick = () => {
    const title = document.querySelector(".hero-title, .detail-title, .screen h1, .profiles-gate h1, .profile-tile");
    if ((title && title.textContent.trim()) || document.querySelector("#app .screen input, #app .screen .pref-item")) mark("heroText");
    const cards = document.querySelectorAll(".row .card, .grid .card, .profile-tile, .settings-section, .pref-section, .ep-card, .detail-actions .btn, .search-input, .dl-card, .dl-info, .pref-item, .search-popular, .search-hint, #app .screen input, .empty");
    if (mp.marks.heroText != null && cards.length >= 1) mark("usable");
    // the billboard's picture: the first url() its visible layer paints
    const hero = document.querySelector(".hero-backdrop.on, .detail-hero .hero-backdrop, .detail-head");
    if (hero && mp.marks.heroPicture == null) {
      const bg = getComputedStyle(hero).backgroundImage || "";
      const m = /url\("([^"]+)"\)/.exec(bg);
      if (m && !m[1].startsWith("data:") && fetched(m[1])) mark("heroPicture");
      else if (!m && mp.marks.usable != null) mp.noHeroPicture = true;
      // (a picture this probe cannot follow — a title page paints its art through
      // layers the resource timeline names differently: stop waiting for it)
      else if (mp.marks.usable != null && performance.now() - mp.marks.usable > 8000) mp.noHeroPicture = true;
    }
    // every picture of the first screenful
    if (mp.marks.usable != null && mp.marks.viewport == null) {
      const imgs = [...document.querySelectorAll("#app img")].filter((i) => {
        const r = i.getBoundingClientRect();
        return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      });
      const heroOk = mp.marks.heroPicture != null || mp.noHeroPicture || !hero;
      if (heroOk && imgs.every((i) => i.complete && i.naturalWidth > 0)) { mp.viewportImages = imgs.length; mark("viewport"); }
    }
  };
  setInterval(tick, 50);
};

const kindOf = (r) => {
  const p = r.path;
  if (r.sw) return "worker";
  if (r.type === "Document") return "html";
  if (r.type === "Stylesheet") return "css";
  if (r.type === "Script") return "js";
  if (r.type === "Image" || p.startsWith("/img/")) return "img";
  if (p.startsWith("/api/netprobe")) return "probe";
  if (p.startsWith("/api/")) return "api";
  return "other";
};

// One visit: returns the marks and the request log.
const visit = async (browser, ctx, { route, look, device, cpu, cold, capMs }) => {
  const { inst, origin } = ctx;
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await emulate(page, device);
  if (cold) {
    await clearCaches(cdp, origin);
    await prime(page, inst, { look, profile: route !== "picker" });
  }
  const reqs = new Map();
  let lastActivity = Date.now();
  let navStart = null;
  const watch = async (session, sw) => {
    await session.send("Network.enable").catch(() => {});
    session.on("Network.requestWillBeSent", (e) => {
      if (!e.request.url.startsWith(origin)) {
        if (!/^(data|blob|about|chrome)/.test(e.request.url)) reqs.set(`x${e.requestId}`, { url: e.request.url, path: e.request.url, thirdParty: true, sw, t0: e.timestamp, type: e.type });
        return;
      }
      if (navStart == null && e.type === "Document") navStart = e.timestamp;
      reqs.set((sw ? "s" : "p") + e.requestId, { url: e.request.url, path: e.request.url.slice(origin.length), type: e.type, prio: e.request.initialPriority, sw, t0: e.timestamp });
      lastActivity = Date.now();
    });
    session.on("Network.responseReceived", (e) => {
      const r = reqs.get((sw ? "s" : "p") + e.requestId);
      if (!r) return;
      r.status = e.response.status;
      r.fromSW = !!e.response.fromServiceWorker;
      r.fromCache = !!e.response.fromDiskCache || !!e.response.fromPrefetchCache;
      r.proto = e.response.protocol;
      r.enc = (e.response.headers["content-encoding"] || e.response.headers["Content-Encoding"] || "");
      r.cc = (e.response.headers["cache-control"] || e.response.headers["Cache-Control"] || "");
    });
    const done = (e, failed) => {
      const r = reqs.get((sw ? "s" : "p") + e.requestId);
      if (!r) return;
      r.t1 = e.timestamp;
      r.bytes = failed ? 0 : e.encodedDataLength || 0;
      if (failed) r.failed = e.errorText || "failed";
      lastActivity = Date.now();
    };
    session.on("Network.loadingFinished", (e) => done(e, false));
    session.on("Network.loadingFailed", (e) => done(e, true));
    session.on("Network.requestServedFromCache", (e) => { const r = reqs.get((sw ? "s" : "p") + e.requestId); if (r) r.fromCache = true; });
  };
  await watch(cdp, false);
  const onTarget = async (target) => {
    if (target.type() !== "service_worker" || !target.url().startsWith(origin)) return;
    try { await watch(await target.createCDPSession(), true); } catch {}
  };
  browser.on("targetcreated", onTarget);
  for (const t of browser.targets()) await onTarget(t);

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  await page.evaluateOnNewDocument(PROBE);
  const url = `${origin}/${route === "picker" ? "" : inst.routes[route]}`;
  const t0 = Date.now();
  page.goto(url, { waitUntil: "domcontentloaded", timeout: capMs }).catch(() => {});
  // until the first screen is complete and the wire has been quiet for 3 s
  let marks = {};
  for (;;) {
    await sleep(250);
    const mp = await page.evaluate(() => window.__mp || null).catch(() => null);
    if (mp) marks = mp;
    const pending = [...reqs.values()].some((r) => r.t1 == null && r.type !== "WebSocket" && r.type !== "EventSource");
    const quiet = !pending && Date.now() - lastActivity > 3000;
    if (mp && mp.marks.viewport != null && quiet) break;
    if (Date.now() - t0 > capMs) { marks.timedOut = true; break; }
  }
  const quietAt = lastActivity - t0;
  // the connection tier the app settled on (js/net.js), and what it measured
  const tier = await page.evaluate(async () => {
    let info = null;
    try { info = (await import("/js/net.js")).netInfo(); } catch {}
    return { tier: document.documentElement.dataset.net || null, kbps: info && info.kbps, rtt: info && info.rtt, source: info && info.source, toast: [...document.querySelectorAll("#toasts > *")].map((t) => t.textContent.trim().slice(0, 60)) };
  }).catch(() => null);
  browser.off("targetcreated", onTarget);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});

  const log = [...reqs.values()].filter((r) => r.type !== "WebSocket").map((r) => ({
    ...r, kind: r.thirdParty ? "third-party" : kindOf(r),
    start: Math.round((r.t0 - navStart) * 1000), end: r.t1 != null ? Math.round((r.t1 - navStart) * 1000) : null,
  }));
  const until = (ms, by = "end") => {
    const sel = log.filter((r) => ms != null && r[by] != null && r[by] <= ms);
    const kinds = {};
    for (const r of sel) { const k = (kinds[r.kind] = kinds[r.kind] || { n: 0, bytes: 0 }); k.n++; k.bytes += r.bytes || 0; }
    return { n: sel.length, bytes: sel.reduce((a, r) => a + (r.bytes || 0), 0), kinds };
  };
  const m = marks.marks || {};
  const out = {
    fcp: marks.paint ? marks.paint["first-contentful-paint"] ?? null : null,
    heroText: m.heroText ?? null,
    usable: m.usable ?? null,
    heroPicture: m.heroPicture ?? null,
    viewport: m.viewport ?? null,
    viewportImages: marks.viewportImages ?? null,
    lcp: marks.lcp ? marks.lcp.t : null,
    lcpEl: marks.lcp ? `${marks.lcp.el} ${String(marks.lcp.url).replace(origin, "").slice(0, 80)}` : null,
    cls: marks.cls ?? null,
    shifts: (marks.shifts || []).filter((s) => s.v > 0.001).slice(0, 6),
    quiet: quietAt,
    tier,
    timedOut: !!marks.timedOut,
    beforePaint: until(marks.paint ? marks.paint["first-contentful-paint"] : null),
    startedBeforeUsable: until(m.usable, "start"),
    beforeUsable: until(m.usable),
    beforeViewport: until(m.viewport),
    total: until(Infinity),
    thirdParty: log.filter((r) => r.thirdParty).map((r) => r.url),
    failed: log.filter((r) => r.failed && !r.thirdParty).map((r) => `${r.path.slice(0, 60)} ${r.failed}`),
    log: log.sort((a, b) => a.start - b.start).map((r) => ({ s: r.start, e: r.end, kind: r.kind, prio: r.prio, st: r.status, b: r.bytes, sw: r.fromSW ? 1 : 0, c: r.fromCache ? 1 : 0, proto: r.proto, cc: r.cc, enc: r.enc, p: r.path.slice(0, 110) })),
  };
  await page.close().catch(() => {});
  return out;
};

const main = async () => {
  const label = argv("label", "run");
  const lines = list("lines", "slow3g,regular3g,fast3g");
  const routes = list("routes", "home");
  const looks = list("looks", "glass");
  const device = argv("device", "phone-390");
  const cpu = Number(argv("cpu", 4));
  const runs = Number(argv("runs", 5));
  const caches = list("cache", "cold,warm");
  const loss = Number(argv("loss", 0));
  const dir = outDir(label, "net");
  const ctx = await open();
  const summary = [];
  try {
    // the server's picture sizes for this device, made once (see lighthouse.js)
    for (const route of routes) for (const look of looks) {
      const page = await ctx.browser.newPage();
      await emulate(page, device);
      for (const extra of [{}, { "aurora-data-mode": "saver" }]) {
        await prime(page, ctx.inst, { look, profile: route !== "picker", extra });
        await page.goto(`${ctx.origin}/${route === "picker" ? "" : ctx.inst.routes[route]}`, { waitUntil: "networkidle2", timeout: 90000 }).catch(() => {});
        await sleep(1500);
      }
      await page.close();
    }
    for (const lineName of lines) {
      const line = await ctx.line(lineName, { loss });
      const capMs = lineName === "slow3g" ? 240000 : 120000;
      try {
        for (const route of routes) for (const look of looks) {
          const cell = { cold: [], warm: [] };
          for (let n = 0; n < runs; n++) {
            for (const cache of ["cold", "warm"].filter((c) => caches.includes(c))) {
              const r = await visit(ctx.browser, line, { route, look, device, cpu, cold: cache === "cold", capMs });
              cell[cache].push(r);
              process.stdout.write(`  ${lineName} ${route}.${look}.${cache} #${n + 1}: fcp ${Math.round(r.fcp)} text ${Math.round(r.heroText)} usable ${Math.round(r.usable)} heroPic ${Math.round(r.heroPicture)} viewport ${Math.round(r.viewport)} lcp ${Math.round(r.lcp)} quiet ${r.quiet} | ${r.total.n} req ${Math.round(r.total.bytes / 1024)} KB | tier ${r.tier && r.tier.tier} (${r.tier && Math.round(r.tier.kbps)} kbit/s, ${r.tier && r.tier.source})${r.timedOut ? " TIMED OUT" : ""}${r.thirdParty.length ? " THIRD-PARTY " + r.thirdParty.length : ""}\n`);
              if (cache === "cold") await sleep(1500);
            }
          }
          for (const cache of Object.keys(cell)) {
            const rs = cell[cache];
            if (!rs.length) continue;
            const m = (f) => spread(rs.map(f));
            const out = {
              line: lineName, route, look, cache, device, cpu, loss, runs: rs.length,
              fcp: m((r) => r.fcp), heroText: m((r) => r.heroText), usable: m((r) => r.usable), heroPicture: m((r) => r.heroPicture),
              viewport: m((r) => r.viewport), lcp: m((r) => r.lcp), cls: m((r) => r.cls), quiet: m((r) => r.quiet),
              beforePaint: { n: m((r) => r.beforePaint.n), bytes: m((r) => r.beforePaint.bytes) },
              beforeUsable: { n: m((r) => r.beforeUsable.n), bytes: m((r) => r.beforeUsable.bytes) },
              beforeViewport: { n: m((r) => r.beforeViewport.n), bytes: m((r) => r.beforeViewport.bytes) },
              total: { n: m((r) => r.total.n), bytes: m((r) => r.total.bytes) },
              lcpEl: rs[0].lcpEl,
              tiers: rs.map((r) => r.tier && `${r.tier.tier}/${Math.round(r.tier.kbps)}`),
              sample: rs[Math.floor(rs.length / 2)],
            };
            writeJson(path.join(dir, `${lineName}.${route}.${look}.${cache}.json`), out);
            const md = (x) => (x && x.median != null ? Math.round(x.median) : null);
            summary.push({ cell: `${lineName}.${route}.${look}.${cache}`, fcp: md(out.fcp), text: md(out.heroText), usable: md(out.usable), heroPic: md(out.heroPicture), viewport: md(out.viewport), lcp: md(out.lcp), quiet: md(out.quiet), req: md(out.total.n), kb: Math.round(out.total.bytes.median / 1024) });
          }
        }
      } finally {
        await line.stop();
      }
    }
  } finally {
    await ctx.close();
  }
  console.table(summary);
};

if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
module.exports = { visit, PROBE };
