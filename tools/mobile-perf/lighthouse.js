#!/usr/bin/env node
// Lighthouse over the signed-in app, route by route.
//
//   node tools/mobile-perf/lighthouse.js --label baseline
//       [--routes picker,home,movies,search,film,show,list,settings,downloads]
//       [--looks glass,legacy] [--profiles mobile] [--cache cold,warm] [--runs 5]
//       [--full]      also accessibility / best-practices / SEO (one extra run per route)
//
// Profiles (--profiles):
//   mobile      Lighthouse's own mobile preset: Moto G Power screen, 4x CPU,
//               "Slow 4G" (150 ms, 1.6 Mbit/s), SIMULATED — the number a
//               person gets from the Lighthouse panel or PageSpeed.
//   weak        a weaker phone on a poor 4G / fast 3G line: 6x CPU, 3 Mbit/s,
//               150 ms — APPLIED (Chrome really slows the page down).
//   regular3g   4x CPU, 1.5 Mbit/s, 300 ms — applied.
//   slow3g      4x CPU, 400 kbit/s, 400 ms — applied.
//
// Cold = no HTTP cache, no service worker, the profile remembered (what a
// phone sees after a deploy or after the browser dropped its cache).
// Warm = the visit right after: HTTP cache and the service worker in place.
//
// Writes out/<label>/lh/<route>.<look>.<profile>.<cache>.json (every run's
// numbers + medians) and one full report per cell (…​.report.json, the run
// closest to the median score).
"use strict";
const fs = require("fs");
const path = require("path");
const { argv, flag, list, open, prime, clearCaches, sleep, median, spread, outDir, writeJson } = require("./lib");

const PROFILES = {
  mobile: { throttlingMethod: "simulate" }, // the preset's own numbers
  weak: { throttlingMethod: "devtools", throttling: { cpuSlowdownMultiplier: 6, requestLatencyMs: 150, downloadThroughputKbps: 3000, uploadThroughputKbps: 1500 } },
  regular3g: { throttlingMethod: "devtools", throttling: { cpuSlowdownMultiplier: 4, requestLatencyMs: 300, downloadThroughputKbps: 1500, uploadThroughputKbps: 750 } },
  slow3g: { throttlingMethod: "devtools", throttling: { cpuSlowdownMultiplier: 4, requestLatencyMs: 400, downloadThroughputKbps: 400, uploadThroughputKbps: 400 } },
};

const num = (lhr, id) => (lhr.audits[id] && typeof lhr.audits[id].numericValue === "number" ? lhr.audits[id].numericValue : null);

// What a run is boiled down to.
const digest = (lhr, origin) => {
  const a = lhr.audits;
  const reqs = ((a["network-requests"] || {}).details || {}).items || [];
  const byType = {};
  let thirdParty = 0;
  for (const r of reqs) {
    const t = r.resourceType || "Other";
    const b = (byType[t] = byType[t] || { n: 0, bytes: 0 });
    b.n++;
    b.bytes += r.transferSize || 0;
    if (!String(r.url).startsWith(origin) && !/^(data|blob|about|chrome)/.test(String(r.url))) thirdParty++;
  }
  const lcpEl = (((a["largest-contentful-paint-element"] || {}).details || {}).items || [])
    .flatMap((t) => t.items || [])
    .map((i) => i.node && { selector: i.node.selector, snippet: String(i.node.snippet || "").slice(0, 200) })
    .filter(Boolean)[0] || null;
  const lcpPhases = (((a["largest-contentful-paint-element"] || {}).details || {}).items || [])
    .flatMap((t) => t.items || [])
    .filter((i) => i.phase)
    .map((i) => ({ phase: i.phase, ms: Math.round(i.timing) }));
  const shifts = (((a["layout-shifts"] || {}).details || {}).items || [])
    .slice(0, 5)
    .map((i) => ({ score: +Number(i.score).toFixed(4), node: i.node && i.node.selector }));
  const main = Object.fromEntries((((a["mainthread-work-breakdown"] || {}).details || {}).items || []).map((i) => [i.group, Math.round(i.duration)]));
  const bootup = (((a["bootup-time"] || {}).details || {}).items || []).slice(0, 8)
    .map((i) => ({ url: String(i.url).replace(origin, ""), total: Math.round(i.total), scripting: Math.round(i.scripting), parse: Math.round(i.scriptParseCompile) }));
  const wasted = (id) => {
    const d = (a[id] || {}).details || {};
    return { bytes: Math.round(d.overallSavingsBytes || 0), items: (d.items || []).slice(0, 6).map((i) => ({ url: String(i.url || "").replace(origin, "").slice(0, 90), wasted: Math.round(i.wastedBytes || 0), total: Math.round(i.totalBytes || 0) })) };
  };
  const longTasks = (((a["long-tasks"] || {}).details || {}).items || []).slice(0, 8)
    .map((i) => ({ url: String(i.url).replace(origin, ""), ms: Math.round(i.duration), at: Math.round(i.startTime) }));
  return {
    score: lhr.categories.performance ? Math.round(lhr.categories.performance.score * 100) : null,
    fcp: num(lhr, "first-contentful-paint"),
    lcp: num(lhr, "largest-contentful-paint"),
    tbt: num(lhr, "total-blocking-time"),
    cls: num(lhr, "cumulative-layout-shift"),
    si: num(lhr, "speed-index"),
    tti: num(lhr, "interactive"),
    mpfid: num(lhr, "max-potential-fid"),
    ttfb: num(lhr, "server-response-time"),
    bytes: num(lhr, "total-byte-weight"),
    requests: reqs.length,
    byType,
    thirdParty,
    dom: num(lhr, "dom-size"),
    mainThread: main,
    mainThreadTotal: num(lhr, "mainthread-work-breakdown"),
    bootup,
    lcpEl,
    lcpPhases,
    shifts,
    longTasks,
    unusedJs: wasted("unused-javascript"),
    unusedCss: wasted("unused-css-rules"),
    images: { responsive: wasted("uses-responsive-images"), offscreen: wasted("offscreen-images"), modern: wasted("modern-image-formats"), optimized: wasted("uses-optimized-images") },
    renderBlocking: (((a["render-blocking-resources"] || {}).details || {}).items || []).map((i) => ({ url: String(i.url).replace(origin, ""), bytes: i.totalBytes, ms: Math.round(i.wastedMs || 0) })),
    benchmarkIndex: lhr.environment && lhr.environment.benchmarkIndex,
    warnings: lhr.runWarnings || [],
    categories: Object.fromEntries(Object.entries(lhr.categories).map(([k, c]) => [k, c.score == null ? null : Math.round(c.score * 100)])),
    failing: Object.values(a).filter((x) => x.score !== null && x.score < 0.9 && x.scoreDisplayMode !== "informative" && x.scoreDisplayMode !== "notApplicable" && x.scoreDisplayMode !== "manual").map((x) => x.id),
  };
};

const main = async () => {
  const label = argv("label", "run");
  const routes = list("routes", "picker,home,movies,search,film,show,list,settings,downloads");
  const looks = list("looks", "glass,legacy");
  const profiles = list("profiles", "mobile");
  const caches = list("cache", "cold,warm");
  const runs = Number(argv("runs", 5));
  const full = flag("full");
  const dir = outDir(label, "lh");

  const { default: lighthouse } = await import("lighthouse");
  const { inst, origin, browser, close, protocol } = await open();
  console.log(`  ${origin} (${protocol}) -> ${inst.url}`);
  // The server makes a picture's ?w= size the first time it is asked for
  // (ffmpeg, ~1 s each) and keeps it. A server that has been up for a day has
  // them all; so one unmeasured visit per route and look comes first.
  if (!flag("no-warmup")) {
    for (const route of routes) {
      for (const look of looks) {
        const page = await browser.newPage();
        await page.setViewport({ width: 412, height: 823, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true });
        await prime(page, inst, { look, profile: route !== "picker" });
        await page.goto(`${origin}/${route === "picker" ? "" : inst.routes[route]}`, { waitUntil: "networkidle2", timeout: 90000 }).catch(() => {});
        await sleep(1500);
        await page.close();
      }
    }
  }
  const summary = [];
  try {
    for (const route of routes) {
      for (const look of looks) {
        for (const profile of profiles) {
          const cell = {};
          for (const cache of caches) cell[cache] = [];
          let best = {};
          for (let n = 0; n < runs; n++) {
            // cold then warm, as one visit follows another on a real phone
            for (const cache of ["cold", "warm"].filter((c) => caches.includes(c))) {
              const page = await browser.newPage();
              const cdp = await page.createCDPSession();
              if (cache === "cold") {
                await clearCaches(cdp, origin);
                await prime(page, inst, { look, profile: route !== "picker" });
              } else if (!caches.includes("cold")) {
                // warm asked for alone: make the first visit here, unmeasured
                await clearCaches(cdp, origin);
                await prime(page, inst, { look, profile: route !== "picker" });
                await page.goto(`${origin}/${route === "picker" ? "" : inst.routes[route]}`, { waitUntil: "networkidle0" }).catch(() => {});
                await sleep(2500);
                await page.goto("about:blank");
              }
              const url = `${origin}/${route === "picker" ? "" : inst.routes[route]}`;
              const onlyCategories = full && n === 0 ? ["performance", "accessibility", "best-practices", "seo"] : ["performance"];
              const result = await lighthouse(url, {
                output: "json",
                logLevel: "error",
                onlyCategories,
                disableStorageReset: true, // the harness decides what is cold
                formFactor: "mobile",
                ...PROFILES[profile],
              }, undefined, page);
              const d = digest(result.lhr, origin);
              cell[cache].push(d);
              if (!best[cache] || n === 0) best[cache] = result.lhr;
              process.stdout.write(`  ${route}.${look}.${profile}.${cache} #${n + 1}: score ${d.score} fcp ${Math.round(d.fcp)} lcp ${Math.round(d.lcp)} tbt ${Math.round(d.tbt)} cls ${d.cls.toFixed(3)} si ${Math.round(d.si)} req ${d.requests} ${Math.round(d.bytes / 1024)}KB\n`);
              // let the worker finish installing before the warm run measures it
              if (cache === "cold" && caches.includes("warm")) await sleep(2500);
              await page.close().catch(() => {});
            }
          }
          for (const cache of Object.keys(cell)) {
            const rs = cell[cache];
            const m = (k) => spread(rs.map((r) => r[k]));
            const out = {
              route, look, profile, cache, runs: rs.length,
              score: m("score"), fcp: m("fcp"), lcp: m("lcp"), tbt: m("tbt"), cls: m("cls"), si: m("si"), tti: m("tti"), mpfid: m("mpfid"),
              bytes: m("bytes"), requests: m("requests"), dom: m("dom"), mainThreadTotal: m("mainThreadTotal"),
              thirdParty: Math.max(...rs.map((r) => r.thirdParty)),
              benchmarkIndex: median(rs.map((r) => r.benchmarkIndex)),
              sample: rs[0],
              all: rs.map(({ score, fcp, lcp, tbt, cls, si, tti, bytes, requests, lcpEl }) => ({ score, fcp, lcp, tbt, cls, si, tti, bytes, requests, lcpEl: lcpEl && lcpEl.selector })),
            };
            const base = `${route}.${look}.${profile}.${cache}`;
            writeJson(path.join(dir, `${base}.json`), out);
            if (best[cache]) fs.writeFileSync(path.join(dir, `${base}.report.json`), JSON.stringify(best[cache]));
            summary.push({ cell: base, score: out.score.median, fcp: Math.round(out.fcp.median), lcp: Math.round(out.lcp.median), tbt: Math.round(out.tbt.median), cls: +out.cls.median.toFixed(3), si: Math.round(out.si.median), kb: Math.round(out.bytes.median / 1024), req: out.requests.median });
          }
        }
      }
    }
  } finally {
    await close();
  }
  console.table(summary);
};

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
