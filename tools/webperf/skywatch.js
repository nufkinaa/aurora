#!/usr/bin/env node
// Does the sky behind the pages keep moving while the page is scrolled?
// (elia, 2026-11-10, on a desktop: "when scrolling the background stops and
// then comes back".) Every paint of #glass-sky is counted and timed, at rest
// and through a wheel scroll, per window size.
//
//   node tools/webperf/skywatch.js --instance <state file> [--label x]
//       [--sizes 1440x900,1920x1080,2560x1440,3840x2160] [--cpu 1] [--gpu]
//       [--route "#/"] [--rest 5000] [--scroll 6000]
//
// Reported per size: paints a second at rest and while scrolling, the median
// and the worst gap between two paints in each, and what one paint costs.
"use strict";
const fs = require("fs");
const path = require("path");
const { OUT, argv, flag, launch, throttle, prime, sleep, median, writeJson } = require("./lib");

const WATCH = () => {
  // the sky tells of each paint itself (aurora-sky.js) — on the page's thread
  // or in a worker — with what it cost and when, on the painter's own clock.
  // The code before the worker (label "before") is timed from outside instead:
  // the canvas's clearRect opens a paint, its last drawImage closes it.
  window.__auroraSkyWatch = true;
  const w = (window.__sky = { paints: [], told: [], open: 0 });
  window.addEventListener("aurora-sky-paint", (e) => w.told.push([e.detail.at, e.detail.cost, performance.now()]));
  const P = CanvasRenderingContext2D.prototype;
  const clear = P.clearRect, draw = P.drawImage;
  P.clearRect = function (...a) {
    if (this.canvas && this.canvas.id === "glass-sky") w.open = performance.now();
    return clear.apply(this, a);
  };
  P.drawImage = function (...a) {
    const r = draw.apply(this, a);
    if (w.open && this.canvas && this.canvas.id === "glass-sky") {
      const now = performance.now();
      w.paints.push([w.open, now - w.open]);
      w.open = 0;
    }
    return r;
  };
};

// The painter's clock, set to the page's: a paint is heard no earlier than
// it was made, so the smallest (heard - made) is the difference of the clocks.
const told = (list) => {
  const off = Math.min(...list.map(([at, , heard]) => heard - at));
  return list.map(([at, cost]) => [at + off, cost]);
};

const stats = (paints, from, to) => {
  const p = paints.filter(([t]) => t >= from && t <= to);
  const gaps = [];
  let prev = from;
  for (const [t] of p) { gaps.push(t - prev); prev = t; }
  gaps.push(to - prev);
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    perSec: Math.round((p.length / ((to - from) / 1000)) * 10) / 10,
    gapP50: Math.round(median(gaps) || 0),
    gapP95: Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0),
    gapMax: Math.round(Math.max(0, ...gaps)),
    cost: Math.round((median(p.map((x) => x[1])) || 0) * 10) / 10,
    costMax: Math.round(Math.max(0, ...p.map((x) => x[1])) * 10) / 10,
  };
};

(async () => {
  const inst = JSON.parse(fs.readFileSync(argv("instance"), "utf8"));
  const label = argv("label", "skywatch");
  const sizes = argv("sizes", "1440x900,1920x1080,2560x1440,3840x2160").split(",").map((s) => s.split("x").map(Number));
  const cpu = Number(argv("cpu", "1"));
  const rest = Number(argv("rest", "5000"));
  const scrollMs = Number(argv("scroll", "6000"));
  const browser = await launch({ extraArgs: flag("gpu") ? ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist"] : [] });
  const out = [];
  for (const [width, height] of sizes) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: "allow" });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await page.addInitScript(WATCH);
    await prime(page, inst, { look: "glass" });
    await throttle(cdp, { line: "none", cpu });
    await page.goto(`${inst.url}/${argv("route", "#/")}`, { waitUntil: "load" });
    await page.waitForSelector(".row .card, .grid .card", { timeout: 30000 });
    await page.waitForSelector("#glass-sky.on", { timeout: 15000 });
    await sleep(4000); // the sky tunes its pace over its first paints
    await page.mouse.move(Math.round(width / 2), Math.round(height / 2));
    const t = () => page.evaluate(() => performance.now());
    const r0 = await t();
    await sleep(rest);
    const r1 = await t();
    // a steady hand on a wheel: a notch of 100 px every 90 ms, down then up
    const s0 = await t();
    const until = Date.now() + scrollMs;
    let dir = 1, n = 0;
    while (Date.now() < until) {
      await page.mouse.wheel(0, 100 * dir);
      await sleep(90);
      if (++n % 30 === 0) dir = -dir;
    }
    const s1 = await t();
    await sleep(1500);
    const a1 = await t();
    const d = await page.evaluate(() => ({ paints: window.__sky.paints, told: window.__sky.told, worker: (() => { try { document.getElementById("glass-sky").getContext("2d"); return false; } catch { return true; } })(), gl: (() => { try { const g = document.createElement("canvas").getContext("webgl"); const e = g.getExtension("WEBGL_debug_renderer_info"); return g.getParameter(e.UNMASKED_RENDERER_WEBGL); } catch { return "?"; } })() }));
    const paints = d.told.length ? told(d.told) : d.paints;
    const res = { size: `${width}x${height}`, worker: d.worker, rest: stats(paints, r0, r1), scroll: stats(paints, s0, s1), after: stats(paints, s1, a1), gl: d.gl };
    out.push(res);
    console.log(JSON.stringify(res));
    await ctx.close();
  }
  await browser.close();
  writeJson(path.join(OUT, label, "skywatch.json"), out);
})().catch((e) => { console.error(e); process.exit(1); });
