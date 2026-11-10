#!/usr/bin/env node
// Opening a title, measured alone: two instances (before / after) side by
// side, each behind its own far line, the same never-opened titles asked of
// both, turn about. From the moment the address changes to the page's words
// (no skeleton left).
//
//   node tools/webperf/titlebench.js --a <state file> --b <state file>
//        [--line slow] [--device desktop|phone] [--n 10]
//
// Three ways in, each on titles neither page has seen:
//   film     #/discover/movie/<id>, straight
//   series   #/discover/series/<id>, straight
//   hovered  a series whose card was pointed at first (prefetch.js
//            warmTitle, what a hover or a touch does), 300 ms before the tap
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { argv, DEVICES, launch, sleep, median } = require("./lib");
const { startFront } = require("../mobile-perf/front");

const LINES = { fast: { rtt: 70, mbit: 50 }, slow: { rtt: 250, mbit: 3 } };

const line = async (inst, { rtt, mbit }) => {
  const child = spawn(process.execPath, [path.join(__dirname, "slowproxy.js"), "--to", inst.url, "--rtt", String(rtt), "--mbit", String(mbit)], { stdio: ["ignore", "pipe", "inherit"] });
  process.on("exit", () => { try { process.kill(child.pid); } catch {} });
  const url = await new Promise((resolve) => { let b = ""; child.stdout.on("data", (c) => { b += c; const m = b.match(/\{.*\}/); if (m) resolve(JSON.parse(m[0]).url); }); });
  const front = await startFront(url);
  return { url: front.url, spki: front.spki, stop: async () => { await front.stop(); try { process.kill(child.pid); } catch {} } };
};

const open = async (side, inst) => {
  const L = await line(inst, LINES[argv("line", "slow")]);
  const browser = await launch({ extraArgs: [`--ignore-certificate-errors-spki-list=${L.spki}`] });
  const dev = argv("device", "desktop");
  const D = DEVICES[dev === "phone" ? "phone-390" : "desktop-1440"];
  const ctx = await browser.newContext({ viewport: { width: D.width, height: D.height }, deviceScaleFactor: D.dpr, isMobile: D.mobile, hasTouch: D.mobile, ...(D.ua ? { userAgent: D.ua } : {}), serviceWorkers: "allow", ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: dev === "phone" ? 4 : 1 });
  await page.goto(`${L.url}/robots.txt`);
  await page.evaluate(([id, name]) => {
    localStorage.setItem("aurora-profile", id); localStorage.setItem("aurora-profile-name", JSON.stringify(name));
    localStorage.setItem("aurora-authmode", "open"); localStorage.setItem("aurora-early", "open");
    localStorage.setItem("aurora-nav-hinted", "1"); localStorage.setItem("aurora-kbd-hint", "1"); localStorage.setItem("aurora-data-mode", "full");
  }, [inst.profiles.glass.id, inst.profiles.glass.name]);
  await page.goto(`${L.url}/#/`);
  await sleep(15000);
  return { side, page, browser, L };
};

const once = async (s, hash, hover) => {
  await s.page.evaluate(() => { location.hash = "#/"; });
  await sleep(2500);
  if (hover) {
    await s.page.evaluate(async (h) => {
      const id = h.split("/").pop();
      const m = await import("/js/prefetch.js");
      m.warmTitle({ type: "show", imdbId: id, id, source: "stream" });
    }, hash);
    await sleep(300);
  }
  return s.page.evaluate((h) => new Promise((resolve) => {
    const t0 = performance.now();
    location.hash = h;
    const look = () => {
      const app = document.getElementById("app");
      if (location.hash === h && app && app.querySelector(".detail-title, .detail-info h1") && !app.querySelector(".skeleton")) return resolve(Math.round(performance.now() - t0));
      if (performance.now() - t0 > 30000) return resolve(null);
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }), hash);
};

const main = async () => {
  const A = JSON.parse(fs.readFileSync(argv("a"), "utf8"));
  const B = JSON.parse(fs.readFileSync(argv("b"), "utf8"));
  const n = Number(argv("n", 10));
  const sides = [await open("a", A), await open("b", B)];
  const res = { a: { film: [], series: [], hovered: [] }, b: { film: [], series: [], hovered: [] } };
  try {
    for (let i = 0; i < n; i++) {
      const cases = [["film", `#/discover/movie/tt8${100120 + i}`, false], ["series", `#/discover/series/tt8${100320 + i}`, false], ["hovered", `#/discover/series/tt8${100360 + i}`, true]];
      for (const [k, hash, hover] of cases) {
        for (const s of i % 2 ? [...sides].reverse() : sides) res[s.side][k].push(await once(s, hash, hover));
      }
      console.log(`#${i}: a ${res.a.film[i]} / ${res.a.series[i]} / ${res.a.hovered[i]}   b ${res.b.film[i]} / ${res.b.series[i]} / ${res.b.hovered[i]}`);
    }
  } finally {
    for (const s of sides) { await s.browser.close(); await s.L.stop(); }
  }
  for (const k of ["film", "series", "hovered"]) console.log(`${k}: a ${median(res.a[k])} ms, b ${median(res.b[k])} ms (medians of ${n})`);
};
process.on("SIGINT", () => process.exit(130));
main().catch((e) => { console.error(e); process.exit(1); });
