#!/usr/bin/env node
// A bad line: what the app does when a request stalls, fails, or the
// connection goes away and comes back.
//
//   node tools/mobile-perf/resilience.js --label baseline [--device phone-390]
//
// Each case is one fresh visit with one thing broken on purpose, and a
// record of what a person would see and whether the page still answers a
// tap. Screenshots go beside the JSON (out/<label>/resilience/).
//
//   home-stalls      /api/home is accepted and never answered
//   home-fails       /api/home fails at once (then works on "Try again")
//   state-stalls     the profile's watch state never answers (boot waits on it)
//   pictures-fail    every picture fails
//   picture-stalls   the billboard's picture never arrives; the rest do
//   offline          Home loaded, the worker installed — then the connection
//                    is cut: other screens, a title, Home again; then back
//   lossy            2% of connections dropped (tools/throttle-proxy.js), 3 loads
"use strict";
const path = require("path");
const { argv, open, emulate, prime, clearCaches, sleep, outDir, writeJson } = require("./lib");

const see = (page) => page.evaluate(() => {
  const txt = (sel) => { const n = document.querySelector(sel); return n ? n.textContent.trim().slice(0, 90) : null; };
  return {
    heroTitle: txt(".hero-title"),
    cards: document.querySelectorAll(".row .card, .grid .card").length,
    skeletons: document.querySelectorAll(".skeleton").length,
    fallbackTiles: document.querySelectorAll(".card-fallback").length,
    brokenPictures: [...document.images].filter((i) => i.complete && !i.naturalWidth && i.currentSrc).length,
    pendingPictures: [...document.images].filter((i) => !i.complete).length,
    empty: txt(".empty"),
    banner: txt("#offline-banner"),
    toasts: [...document.querySelectorAll("#toasts > *")].map((t) => t.textContent.trim().slice(0, 80)),
    route: location.hash || "#/",
    screen: !!document.querySelector("#app .screen"),
  };
});

const main = async () => {
  const label = argv("label", "run");
  const device = argv("device", "phone-390");
  const dir = outDir(label, "resilience");
  const ctx = await open();
  const { inst, origin } = ctx;
  const out = {};
  const fresh = async ({ worker = false } = {}) => {
    const page = await ctx.browser.newPage();
    const cdp = await page.createCDPSession();
    await emulate(page, device);
    await clearCaches(cdp, origin);
    await prime(page, inst, { look: "glass" });
    // (the page's own requests are what is being broken: no worker in the way)
    if (!worker) await page.evaluateOnNewDocument(() => { try { Object.defineProperty(navigator.serviceWorker, "register", { value: () => Promise.reject(new Error("off for this test")) }); } catch {} });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 120)));
    return { page, cdp, errors };
  };
  const rule = async (page, fn) => {
    await page.setRequestInterception(true);
    page.on("request", (r) => { if (r.isInterceptResolutionHandled()) return; if (fn(r) !== true) r.continue().catch(() => {}); });
  };
  const shot = (page, name) => page.screenshot({ path: path.join(dir, `${name}.png`) }).catch(() => {});
  const tapMovies = async (page) => {
    const t0 = Date.now();
    try {
      const tab = await page.$('.nav-item[data-route="#/movies"]');
      await tab.tap();
      await page.waitForSelector(".grid .card", { timeout: 15000 });
      return { ok: true, ms: Date.now() - t0 };
    } catch (e) { return { ok: false, ms: Date.now() - t0, why: String(e.message).slice(0, 60) }; }
  };

  try {
    { // ---- home-stalls
      const { page, errors } = await fresh();
      await rule(page, (r) => /\/api\/home/.test(r.url())); // held: never continued
      await page.goto(`${origin}/#/`, { waitUntil: "domcontentloaded" });
      const at = {};
      for (const s of [5, 20, 60]) { await sleep((s - (Object.keys(at).length ? Number(Object.keys(at).pop()) : 0)) * 1000); at[s] = await see(page); }
      await shot(page, "home-stalls-60s");
      out["home-stalls"] = { after5s: at[5], after20s: at[20], after60s: at[60], thenMovies: await tapMovies(page), errors };
      await page.close();
    }
    { // ---- home-fails
      const { page, errors } = await fresh();
      let fail = true;
      let asked = 0;
      await rule(page, (r) => { if (/\/api\/home/.test(r.url())) { asked++; if (fail) { r.abort("connectionreset").catch(() => {}); return true; } } });
      const t0 = Date.now();
      await page.goto(`${origin}/#/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".empty", { timeout: 30000 }).catch(() => {});
      const failedAfter = Date.now() - t0;
      const seen = await see(page);
      await shot(page, "home-fails");
      fail = false;
      const btn = await page.$(".empty .btn");
      if (btn) await btn.tap();
      const back = await page.waitForSelector(".row .card", { timeout: 20000 }).then(() => true, () => false);
      out["home-fails"] = { requestsMade: asked, errorShownAfterMs: failedAfter, seen, tryAgainWorks: back, errors };
      await page.close();
    }
    { // ---- state-stalls
      const { page, errors } = await fresh();
      await rule(page, (r) => /\/api\/profiles\/[^/]+\/state/.test(r.url()));
      await page.goto(`${origin}/#/`, { waitUntil: "domcontentloaded" });
      await sleep(20000);
      const seen = await see(page);
      await shot(page, "state-stalls-20s");
      out["state-stalls"] = { after20s: seen, note: "boot awaits the watch state before the first screen", errors };
      await page.close();
    }
    { // ---- pictures-fail
      const { page, errors } = await fresh();
      await rule(page, (r) => { if (/\/img\//.test(r.url())) { r.abort("failed").catch(() => {}); return true; } });
      await page.goto(`${origin}/#/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".row .card", { timeout: 30000 });
      await sleep(6000);
      const seen = await see(page);
      await shot(page, "pictures-fail");
      out["pictures-fail"] = { seen, thenMovies: await tapMovies(page), errors };
      await page.close();
    }
    { // ---- picture-stalls
      const { page, errors } = await fresh();
      let held = 0;
      await rule(page, (r) => { if (/\/img\//.test(r.url()) && /w=(7|8|9|1[0-9])\d\d/.test(r.url()) && r.resourceType() === "image") { held++; return true; } });
      await page.goto(`${origin}/#/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".row .card", { timeout: 30000 });
      await sleep(8000);
      const seen = await see(page);
      await shot(page, "picture-stalls");
      out["picture-stalls"] = { held, seen, thenMovies: await tapMovies(page), errors };
      await page.close();
    }
    { // ---- offline, then back
      const { page, cdp, errors } = await fresh({ worker: true });
      await page.goto(`${origin}/#/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".row .card", { timeout: 30000 });
      // the worker registers once the first screen is done, then copies the app
      const workerReady = await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 40000))]));
      await sleep(8000);
      const cut = async (offline) => {
        const cond = { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
        await cdp.send("Network.emulateNetworkConditions", cond);
        for (const t of ctx.browser.targets()) {
          if (t.type() === "service_worker" && t.url().startsWith(origin)) { try { const s = await t.createCDPSession(); await s.send("Network.enable"); await s.send("Network.emulateNetworkConditions", cond); } catch {} }
        }
      };
      await cut(true);
      const steps = {};
      await sleep(4000);
      steps.homeAfterCut = await see(page);
      steps.movies = await tapMovies(page);
      steps.moviesSeen = await see(page);
      await shot(page, "offline-movies");
      await page.evaluate((h) => { location.hash = h; }, inst.routes.film);
      await sleep(5000);
      steps.title = await see(page);
      await shot(page, "offline-title");
      await page.evaluate(() => { location.hash = "#/"; });
      await sleep(4000);
      steps.homeAgain = await see(page);
      await shot(page, "offline-home");
      // a reload with no connection: does the app open at all?
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(6000);
      steps.reloadOffline = await see(page);
      await shot(page, "offline-reload");
      await cut(false);
      await sleep(9000);
      steps.afterReconnect = await see(page);
      await page.evaluate(() => { location.hash = "#/movies"; });
      steps.moviesAfterReconnect = await page.waitForSelector(".grid .card", { timeout: 20000 }).then(() => true, () => false);
      out.offline = { workerReady, ...steps, errors };
      await page.close();
    }
    { // ---- lossy line
      const line = await ctx.line("fast3g", { loss: 2 });
      const loads = [];
      try {
        for (let n = 0; n < 3; n++) {
          const page = await ctx.browser.newPage();
          const cdp = await page.createCDPSession();
          await emulate(page, device);
          await clearCaches(cdp, line.origin);
          await prime(page, line.inst, { look: "glass" });
          const failed = [];
          page.on("requestfailed", (r) => failed.push(`${r.url().replace(line.origin, "").slice(0, 60)} ${r.failure() && r.failure().errorText}`));
          const t0 = Date.now();
          await page.goto(`${line.origin}/#/`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
          const usable = await page.waitForSelector(".row .card", { timeout: 60000 }).then(() => Date.now() - t0, () => null);
          await sleep(12000);
          loads.push({ usableMs: usable, failedRequests: failed.length, failed: failed.slice(0, 8), seen: await see(page).catch(() => null) });
          await page.close();
        }
      } finally { await line.stop(); }
      out.lossy = { loads };
    }
  } finally {
    await ctx.close();
  }
  writeJson(path.join(dir, "resilience.json"), out);
  for (const [k, v] of Object.entries(out)) console.log(`\n${k}\n  ${JSON.stringify(v).slice(0, 1400)}`);
};

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
