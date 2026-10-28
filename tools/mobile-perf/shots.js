#!/usr/bin/env node
// Screenshots of every screen at rest, made to be compared pixel for pixel
// between two versions of the site (diff.py).
//
//   node tools/mobile-perf/shots.js --label before
//       [--devices phone-360,phone-390,phone-412,tablet-820,desktop-1440]
//       [--looks glass,legacy] [--themes default] [--routes picker,home,…]
//       [--states top,down1,down3,swiped,typed]
//
// A page that is alive never shows the same pixels twice, so the harness
// holds still everything that moves by itself — the SAME way for every
// version, so what is left to differ is the site:
//
//   the clock        Date is pinned to one evening (the greeting, "NEW" tags)
//   chance           Math.random is seeded
//   CSS motion       animations and transitions jump to their end state
//   the two skies    #glass-sky and #nav-aurora are living canvases; each is
//                    painted once with a fixed gradient and the app's painter
//                    is handed a canvas of its own to draw on, off the page
//   the billboard    its 9-second rotation is not started
//   pictures         held to their plain end state (see FREEZE: on the live
//                    site a picture ends with or without a no-op blur filter
//                    depending on how fast it arrived)
//
// Then, per route: wait until nothing is on the wire and every picture in
// view has arrived, and photograph the viewport — at the top, and (where the
// page is long) one and three screens down, and with the first shelf swiped.
// Writes out/<label>/shots/<device>/<route>.<look>.<theme>.<state>.png
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { argv, list, open, emulate, prime, sleep, outDir, DEVICES } = require("./lib");
const { CACHE } = require("./instance");

const FREEZE = (fixedNow) => {
  // the clock: one fixed evening, moving at real speed from there
  const RealDate = Date;
  const t0 = RealDate.now();
  const now = () => fixedNow + (RealDate.now() - t0);
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(now()); }
    static now() { return now(); }
  }
  window.Date = FakeDate;
  // chance
  let seed = 20261010;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // the billboard's rotation (home.js HERO_DWELL_MS) is never started
  const realInterval = window.setInterval;
  window.setInterval = (fn, ms, ...rest) => (ms === 9000 ? 0 : realInterval(fn, ms, ...rest));
  // the living canvases: a fixed picture on the page, the painter sent elsewhere
  const realGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if ((this.id === "glass-sky" || this.id === "nav-aurora") && type === "2d") {
      if (!this.__still) {
        this.__still = document.createElement("canvas");
        const paintStill = () => {
          const w = Math.max(2, this.clientWidth || 300), h = Math.max(2, this.clientHeight || 150);
          const real = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = realGet;
          Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width").set.call(this, w);
          Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "height").set.call(this, h);
          const c = realGet.call(this, "2d");
          HTMLCanvasElement.prototype.getContext = real;
          const g = c.createLinearGradient(0, 0, w, h);
          g.addColorStop(0, "#0b1030"); g.addColorStop(0.45, "#1f6a5a"); g.addColorStop(0.75, "#5b3fa0"); g.addColorStop(1, "#070811");
          c.fillStyle = g;
          c.fillRect(0, 0, w, h);
        };
        // the app sets width/height on its canvas as it resizes: those writes
        // go to the stand-in, the real one keeps the still picture
        const still = this.__still;
        for (const prop of ["width", "height"]) {
          const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
          Object.defineProperty(this, prop, { get: () => d.get.call(still), set: (v) => d.set.call(still, v), configurable: true });
        }
        this.__paintStill = paintStill;
        paintStill();
        addEventListener("resize", paintStill);
      }
      return realGet.call(this.__still, type, ...rest);
    }
    return realGet.call(this, type, ...rest);
  };
  // CSS motion: straight to the end state
  const css = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; scroll-behavior: auto !important; caret-color: transparent !important; }" +
    // A picture ends in one of three states on the live site, by chance of
    // timing: shown at once (no filter), faded in (no filter), or sharpened in
    // from its placeholder and left with `filter: blur(0px)` — which does not
    // rasterise quite like no filter. Which one is not the site's version
    // speaking, so all pictures are held to the plain state.
    " .img-blurup, .img-fade { animation: none !important; filter: none !important; -webkit-filter: none !important; opacity: 1 !important; background-image: none !important; }";
  const add = () => { const s = document.createElement("style"); s.id = "mp-freeze"; s.textContent = css; (document.head || document.documentElement).append(s); };
  if (document.documentElement) add(); else new MutationObserver((_, mo) => { if (document.documentElement) { mo.disconnect(); add(); } }).observe(document, { childList: true });
};

// Nothing on the wire for `quietMs`, every picture in view decoded.
const settle = async (page, pending, { quietMs = 900, capMs = 25000 } = {}) => {
  const t0 = Date.now();
  let quietSince = Date.now();
  for (;;) {
    await sleep(150);
    if (pending.size) quietSince = Date.now();
    const imagesIn = await page.evaluate(() => {
      for (const c of document.querySelectorAll("canvas")) if (c.__paintStill && c.clientWidth && c.__stillW !== c.clientWidth + "x" + c.clientHeight) { c.__stillW = c.clientWidth + "x" + c.clientHeight; c.__paintStill(); }
      return [...document.images].every((i) => {
        const r = i.getBoundingClientRect();
        const inView = r.width > 0 && r.bottom > -50 && r.top < innerHeight + 50 && r.right > -50 && r.left < innerWidth + 50;
        return !inView || (i.complete && (i.naturalWidth > 0 || !i.currentSrc));
      });
    }).catch(() => false);
    if (!imagesIn) quietSince = Date.now();
    if (Date.now() - quietSince > quietMs) return true;
    if (Date.now() - t0 > capMs) return false;
  }
};

const ROUTE_STATES = {
  picker: ["top"],
  home: ["top", "down1", "down3", "swiped"],
  movies: ["top", "down1", "down3"],
  shows: ["top", "down1"],
  search: ["top", "typed"],
  list: ["top"],
  film: ["top", "down1"],
  show: ["top", "down1"],
  libfilm: ["top"],
  libshow: ["top", "down1"],
  settings: ["top", "down1"],
  downloads: ["top"],
};

const main = async () => {
  const ART = fs.readdirSync(CACHE).filter((d) => d.startsWith("art-")).map((d) => path.join(CACHE, d)).sort().pop();
  const STILLS = fs.readdirSync(ART).filter((f) => f.startsWith("still-")).sort();
  const only = argv("states") ? list("states", "") : null; // e.g. --states top
  const label = argv("label", "shots");
  const devices = list("devices", "phone-360,phone-390,phone-412,tablet-820,desktop-1440");
  const looks = list("looks", "glass,legacy");
  const themes = list("themes", "default");
  const routes = list("routes", Object.keys(ROUTE_STATES).join(","));
  const FIXED_NOW = new Date("2026-10-10T19:30:00").getTime();
  const EXTRA_WAIT = Number(argv("extra-wait", 0));
  const IMG_CACHE = argv("img-cache") ? path.resolve(argv("img-cache")) : null;
  if (IMG_CACHE) fs.mkdirSync(IMG_CACHE, { recursive: true });
  // Software drawing (--disable-gpu). With the GPU rasteriser the same picture
  // bytes in the same box came out two ways, a few levels of colour apart,
  // about one picture in ten per load; the software one is repeatable.
  const ctx = await open({ extraArgs: ["--disable-gpu"] });
  const problems = [];
  let n = 0;
  try {
    for (const device of devices) {
      const dir = outDir(label, path.join("shots", device));
      // Twice: the first pass is not photographed. It makes the server cut
      // every picture to this device's sizes and draw its blur-up
      // placeholders (both happen in the background the first time a picture
      // is asked for, and a page looks different until they exist).
      for (const pass of ["warm", "shoot"]) for (const look of looks) for (const theme of (pass === "warm" ? themes.slice(0, 1) : themes)) {
        const page = await ctx.browser.newPage();
        const cdp = await page.createCDPSession();
        await emulate(page, device);
        const pending = new Set();
        page.on("request", (r) => { if (!/^(data|blob):/.test(r.url()) && r.resourceType() !== "websocket") pending.add(r); });
        page.on("requestfinished", (r) => pending.delete(r));
        page.on("requestfailed", (r) => pending.delete(r));
        page.on("pageerror", (e) => problems.push(`${device} ${look}: page error ${e.message}`));
        await page.evaluateOnNewDocument(FREEZE, FIXED_NOW);
        // (with --img-cache: the warm pass's pictures must not answer the
        // photographed pass from the browser's own cache — see below)
        if (IMG_CACHE && pass === "shoot") await cdp.send("Network.clearBrowserCache");
        // (and the offline worker would answer pictures itself, where the
        // page's own interception never sees them: both sides go without it)
        if (IMG_CACHE) await page.setBypassServiceWorker(true);
        // Episode stills: a version of the site that fetches them straight
        // from the catalogue's host (every version before they were routed
        // through the server) would get nothing here — no host but this
        // machine resolves — and its series pages would be photographed
        // without stills. So that one host is answered from the fixture's
        // pictures, the same file the server-side stand-in would hand out.
        await page.setRequestInterception(true);
        page.on("request", (r) => {
          if (r.isInterceptResolutionHandled()) return;
          let u = null;
          try { u = new URL(r.url()); } catch {}
          if (u && u.host === "episodes.metahub.space") {
            const file = STILLS[parseInt(crypto.createHash("md5").update(u.pathname).digest("hex").slice(0, 8), 16) % STILLS.length];
            return void r.respond({ status: 200, contentType: "image/jpeg", body: fs.readFileSync(path.join(ART, file)) }).catch(() => {});
          }
          // --img-cache <dir>: every picture the photographed pass asks for
          // is answered with the bytes the FIRST such request got, shared by
          // every run that names the same folder. Two instances (two versions
          // of the site) cut and encode their pictures each on their own, and
          // on a machine short of memory the server sometimes refuses to cut
          // one and sends the original instead: the same picture, other
          // bytes, a few levels of colour apart — a difference between the
          // two SERVERS' moods, not between the two sites. (Not in the warm
          // pass, which is there to let each server make its cuts.)
          if (IMG_CACHE && pass === "shoot" && u && /^\/img\//.test(u.pathname)) {
            const key = path.join(IMG_CACHE, crypto.createHash("sha1").update(u.pathname + u.search + "|" + device).digest("hex"));
            return void (async () => {
              try {
                if (fs.existsSync(key + ".json")) {
                  const meta = JSON.parse(fs.readFileSync(key + ".json", "utf-8"));
                  return await r.respond({ status: 200, contentType: meta.type, headers: { "cache-control": "no-store" }, body: fs.readFileSync(key + ".bin") });
                }
                const res = await fetch(ctx.inst.url + u.pathname + u.search, { headers: { accept: r.headers().accept || "*/*" } });
                const body = Buffer.from(await res.arrayBuffer());
                const type = res.headers.get("content-type") || "application/octet-stream";
                if (res.status === 200 && !fs.existsSync(key + ".json")) {
                  const tmp = `${key}.${process.pid}.tmp`;
                  fs.writeFileSync(tmp, body);
                  fs.renameSync(tmp, key + ".bin");
                  fs.writeFileSync(key + ".json", JSON.stringify({ type }));
                }
                await r.respond({ status: res.status, contentType: type, headers: { "cache-control": "no-store" }, body });
              } catch (e) { if (process.env.SHOTS_DEBUG) console.error("img-cache:", e.message); r.continue().catch(() => {}); }
            })();
          }
          r.continue().catch(() => {});
        });
        for (const route of routes) {
          // "Full quality" data mode: the connection tier is then fixed, not
          // measured — a measured tier would decide by this machine's mood
          // whether pictures are fetched at 1x or 2x, and the two sets of
          // screenshots would differ for that reason alone.
          await prime(page, ctx.inst, { look, profile: route !== "picker", extra: { "aurora-data-mode": "full", ...(theme !== "default" ? { "aurora-theme": theme } : {}) } });
          pending.clear();
          await page.goto(`${ctx.origin}/${route === "picker" ? "" : ctx.inst.routes[route]}`, { waitUntil: "load", timeout: 60000 });
          for (const state of (ROUTE_STATES[route] || ["top"]).filter((st) => !only || only.includes(st))) {
            if (state === "down1") await page.evaluate(() => window.scrollTo(0, Math.round(innerHeight * 1.2)));
            if (state === "down3") await page.evaluate(() => window.scrollTo(0, Math.round(innerHeight * 3)));
            if (state === "swiped") {
              await page.evaluate(() => {
                window.scrollTo(0, 0);
                const rows = [...document.querySelectorAll(".row-scroller")];
                if (rows[1]) rows[1].scrollLeft = 520;
                (rows[1] || document.body).scrollIntoView({ block: "center" });
              });
            }
            if (state === "typed") {
              const input = await page.$("input[type=search], .search-input, input.focusable");
              if (input) { await input.click(); await page.keyboard.type("harbor", { delay: 20 }); await sleep(900); }
            }
            const ok = await settle(page, pending);
            if (pass === "warm") { await sleep(400); continue; }
            if (!ok) problems.push(`${device} ${route}.${look}.${theme}.${state}: did not settle`);
            await sleep(700); // blur-up placeholders are dropped 500 ms after a picture lands
            // --extra-wait <ms>: what arrives on its own a little later (the
            // New tab's dot at the first idle moment, a picture upgraded once
            // the viewer has been still 2.5 s) is in the picture too
            if (EXTRA_WAIT) await sleep(EXTRA_WAIT);
            await page.screenshot({ path: path.join(dir, `${route}.${look}.${theme}.${state}.png`), captureBeyondViewport: false });
            n++;
          }
        }
        await page.close();
      }
      process.stdout.write(`  ${device}: done (${n} so far)\n`);
    }
  } finally {
    await ctx.close();
  }
  if (problems.length) console.log("\nProblems:\n  " + [...new Set(problems)].join("\n  "));
  console.log(`\n${n} screenshots in ${path.join("out", label, "shots")}`);
};

if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
module.exports = { FREEZE, settle };
