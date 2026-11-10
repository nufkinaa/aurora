#!/usr/bin/env node
// The offline worker's first copy of the app, on a far line: how long until
// it is complete, and how many requests it made to get there. Two instances
// (before / after) turn about, each behind its own line.
//
//   node tools/webperf/precache.js --a <state file> --b <state file>
//        [--line slow] [--device desktop|phone] [--n 4]
//
// Per run a fresh context: Home opened cold (no cache, no worker), then the
// line watched until the worker's copy is stamped complete (sw.js
// "/__shell-version"). Reported: the moment it is complete (from the page's
// start), the requests that crossed the line in all by then, and those that
// were the worker re-asking for files the page had already downloaded
// (a module or the stylesheet answered "304 Not Modified").
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { argv, DEVICES, launch, sleep, median } = require("./lib");
const { startFront } = require("../mobile-perf/front");

const LINES = { fast: { rtt: 70, mbit: 50 }, slow: { rtt: 250, mbit: 3 } };

const line = async (inst, { rtt, mbit }, log) => {
  const child = spawn(process.execPath, [path.join(__dirname, "slowproxy.js"), "--to", inst.url, "--rtt", String(rtt), "--mbit", String(mbit)], { stdio: ["ignore", "pipe", "inherit"] });
  process.on("exit", () => { try { process.kill(child.pid); } catch {} });
  const url = await new Promise((resolve) => { let b = ""; child.stdout.on("data", (c) => { b += c; const m = b.match(/\{.*\}/); if (m) resolve(JSON.parse(m[0]).url); }); });
  const front = await startFront(url, { onLog: (e) => log.push(e) });
  return { url: front.url, spki: front.spki, stop: async () => { await front.stop(); try { process.kill(child.pid); } catch {} } };
};

const run = async (inst, browser, L, log, dev) => {
  const D = DEVICES[dev === "phone" ? "phone-390" : "desktop-1440"];
  const ctx = await browser.newContext({ viewport: { width: D.width, height: D.height }, deviceScaleFactor: D.dpr, isMobile: D.mobile, hasTouch: D.mobile, ...(D.ua ? { userAgent: D.ua } : {}), serviceWorkers: "allow", ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: dev === "phone" ? 4 : 1 });
  await page.goto(`${L.url}/robots.txt`);
  await page.evaluate(([id, name]) => {
    localStorage.setItem("aurora-profile", id); localStorage.setItem("aurora-profile-name", JSON.stringify(name));
    localStorage.setItem("aurora-authmode", "open"); localStorage.setItem("aurora-early", "open");
    localStorage.setItem("aurora-nav-hinted", "1"); localStorage.setItem("aurora-kbd-hint", "1"); localStorage.setItem("aurora-data-mode", "full");
  }, [inst.profiles.glass.id, inst.profiles.glass.name]);
  const n0 = log.length;
  const t0 = Date.now();
  await page.goto(`${L.url}/#/`, { waitUntil: "commit" });
  let done = null;
  while (Date.now() - t0 < 90000) {
    const ok = await page.evaluate(async () => { try { const c = await caches.open("aurora-shell-v1"); return !!(await c.match("/__shell-version")); } catch { return false; } }).catch(() => false);
    if (ok) { done = Date.now() - t0; break; }
    await sleep(100);
  }
  const L2 = log.slice(n0).filter((e) => e.t1 <= t0 + (done || 90000));
  const res = { done, requests: L2.length, revalidated: L2.filter((e) => e.status === 304 && /\.(js|css)\?v=/.test(e.url)).length, kb: Math.round(L2.reduce((a, e) => a + e.bytes, 0) / 1024) };
  await ctx.close();
  return res;
};

const main = async () => {
  const dev = argv("device", "desktop");
  const n = Number(argv("n", 4));
  const sides = [];
  for (const k of ["a", "b"]) {
    const inst = JSON.parse(fs.readFileSync(argv(k), "utf8"));
    const log = [];
    const L = await line(inst, LINES[argv("line", "slow")], log);
    const browser = await launch({ extraArgs: [`--ignore-certificate-errors-spki-list=${L.spki}`] });
    sides.push({ k, inst, log, L, browser, out: [] });
  }
  try {
    for (let i = 0; i <= n; i++) {
      for (const s of i % 2 ? [...sides].reverse() : sides) {
        const r = await run(s.inst, s.browser, s.L, s.log, dev);
        if (i > 0) s.out.push(r);
        console.log(`${i ? "#" + i : "warm-up"} ${s.k}: ${JSON.stringify(r)}`);
      }
    }
  } finally {
    for (const s of sides) { await s.browser.close(); await s.L.stop(); }
  }
  for (const s of sides) console.log(`${s.k}: complete at ${median(s.out.map((r) => r.done))} ms, ${median(s.out.map((r) => r.requests))} requests (${median(s.out.map((r) => r.revalidated))} re-asked), ${median(s.out.map((r) => r.kb))} KB (medians of ${n})`);
};
process.on("SIGINT", () => process.exit(130));
main().catch((e) => { console.error(e); process.exit(1); });
