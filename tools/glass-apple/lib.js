// Shared by tools/glass-apple: one headless Chrome (GPU-backed, so
// backdrop-filter is drawn the way a real one draws it), a signed-in page on
// the private instance (tools/mobile-perf/instance.js), everything that moves
// by itself held still, and a switch between "today's glass" and the new one.
//
// The switch: both sides are photographed against the SAME server. For the
// "before" side the one stylesheet the site loads (/css/aurora.css) is
// answered from a saved copy of origin/master's bundle, and any other file
// this branch changed from `git show origin/master:<file>`; everything else —
// data, pictures, scripts — is byte for byte the same on both sides.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { launch, prime, sleep } = require("../webperf/lib");
const { HELPERS } = require("./stage");

const ROOT = path.resolve(__dirname, "..", "..");
const INST = () => JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "mobile-perf", ".cache", "instance.json"), "utf-8"));
const SCRATCH = process.env.GA_SCRATCH || path.join(process.env.TEMP || "/tmp", "aurora-agents", "glass-apple");

const UA_PHONE = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const UA_TABLET = "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SIZES = {
  "phone-320": { width: 320, height: 640, dpr: 3, mobile: true, ua: UA_PHONE },
  "phone-375": { width: 375, height: 812, dpr: 3, mobile: true, ua: UA_PHONE },
  "phone": { width: 402, height: 874, dpr: 3, mobile: true, ua: UA_PHONE },
  "phone-390": { width: 390, height: 844, dpr: 3, mobile: true, ua: UA_PHONE },
  "phone-430": { width: 430, height: 932, dpr: 3, mobile: true, ua: UA_PHONE },
  "tablet-768": { width: 768, height: 1024, dpr: 2, mobile: true, ua: UA_TABLET },
  "tablet": { width: 1024, height: 768, dpr: 2, mobile: true, ua: UA_TABLET },
  "desktop-1280": { width: 1280, height: 720, dpr: 1, mobile: false },
  "desktop": { width: 1440, height: 900, dpr: 1, mobile: false },
  "desktop-1920": { width: 1920, height: 1080, dpr: 1, mobile: false },
  "desktop-2560": { width: 2560, height: 1440, dpr: 1, mobile: false },
};

// The same stillness tools/mobile-perf/shots.js uses (FREEZE there): the
// clock pinned, chance seeded, the billboard's rotation not started, the two
// living canvases painted once, CSS motion at its end state, pictures plain.
// `sky`: the colours the still sky is painted with (a worst-case scene asks
// for a bright band).
const FREEZE = ([fixedNow, sky]) => {
  const RealDate = Date;
  const t0 = RealDate.now();
  const now = () => fixedNow + (RealDate.now() - t0);
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(now()); }
    static now() { return now(); }
  }
  window.Date = FakeDate;
  let seed = 20261010;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const realInterval = window.setInterval;
  window.setInterval = (fn, ms, ...rest) => (ms === 9000 ? 0 : realInterval(fn, ms, ...rest));
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
          const stops = (window.__gaSky || sky);
          stops.forEach((col, i) => g.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), col));
          c.fillStyle = g;
          c.fillRect(0, 0, w, h);
        };
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
  const css = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; scroll-behavior: auto !important; caret-color: transparent !important; }" +
    " .img-blurup, .img-fade { animation: none !important; filter: none !important; -webkit-filter: none !important; opacity: 1 !important; background-image: none !important; isolation: auto !important; }";
  const add = () => { const s = document.createElement("style"); s.id = "mp-freeze"; s.textContent = css; (document.head || document.documentElement).append(s); };
  if (document.documentElement) add(); else new MutationObserver((_, mo) => { if (document.documentElement) { mo.disconnect(); add(); } }).observe(document, { childList: true });
};

const DEFAULT_SKY = ["#0b1030", "#1f6a5a", "#5b3fa0", "#070811"];
const FIXED_NOW = new Date("2026-10-10T19:30:00").getTime();

// What "before" is: origin/master's look by default. For a second round,
// GA_BEFORE_REF names the commit to compare against and GA_BEFORE_CSS the
// bundle built from that commit's public/css (src/lib/cssbundle get()).
const BEFORE_REF = process.env.GA_BEFORE_REF || "origin/master";
let beforeCache = null;
const beforeFiles = () => {
  if (beforeCache) return beforeCache;
  beforeCache = {
    bundle: fs.readFileSync(process.env.GA_BEFORE_CSS || path.join(SCRATCH, "before.css")),
    git: (rel) => execFileSync("git", ["-C", ROOT, "show", `${BEFORE_REF}:${rel}`], { maxBuffer: 64 << 20 }),
  };
  return beforeCache;
};
// Files outside the bundle that this branch changed (the "before" side gets
// origin/master's copy of each).
const BEFORE_FILES = (process.env.GA_BEFORE_FILES || "public/css/remote.css").split(",").filter(Boolean);

// The private instance serves a SNAPSHOT of public/ taken when it started
// (scripts/ui-test-server.js). The stylesheets this branch edits are copied
// over that snapshot before a page opens, so "after" is the working tree as
// it is now; the bundle rebuilds itself within two seconds of a change.
let synced = false;
const syncCss = async () => {
  if (synced) return;
  synced = true;
  const inst = INST();
  let changed = 0;
  for (const dir of ["css"]) {
    const from = path.join(ROOT, "public", dir), to = path.join(inst.root, "public", dir);
    for (const f of fs.readdirSync(from)) {
      if (!f.endsWith(".css")) continue;
      const a = fs.readFileSync(path.join(from, f));
      let b = null;
      try { b = fs.readFileSync(path.join(to, f)); } catch {}
      if (!b || !a.equals(b)) { fs.writeFileSync(path.join(to, f), a); changed++; }
    }
  }
  if (changed) await sleep(2300);
};

// side: "before" (origin/master's look) | "after" (this worktree)
// dpr: another device pixel ratio than the size's own (lighter photographs)
const openPage = async (browser, { size = "phone", side = "after", sky = DEFAULT_SKY, look = "glass", extra = {}, freeze = true, reducedMotion = false, dpr = null } = {}) => {
  const d = SIZES[size];
  if (!d) throw new Error(`unknown size ${size}`);
  await syncCss();
  const inst = INST();
  const ctx = await browser.newContext({
    viewport: { width: d.width, height: d.height },
    deviceScaleFactor: dpr || d.dpr,
    isMobile: d.mobile,
    hasTouch: d.mobile,
    ...(d.ua ? { userAgent: d.ua } : {}),
    serviceWorkers: "block",
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  if (freeze) await ctx.addInitScript(FREEZE, [FIXED_NOW, sky]);
  await ctx.addInitScript(HELPERS);
  if (side === "before") {
    const b = beforeFiles();
    await ctx.route((u) => u.pathname === "/css/aurora.css", (r) => r.fulfill({ status: 200, contentType: "text/css; charset=utf-8", headers: { "cache-control": "no-store" }, body: b.bundle }));
    for (const rel of BEFORE_FILES) {
      const url = "/" + rel.replace("public/", "");
      await ctx.route((u) => u.pathname === url, (r) => r.fulfill({ status: 200, contentType: rel.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", headers: { "cache-control": "no-store" }, body: b.git(rel) }));
    }
  }
  const page = await ctx.newPage();
  const pending = new Set();
  page.on("request", (r) => { if (!r.url().startsWith("data:") && !r.url().startsWith("blob:") && r.resourceType() !== "websocket" && r.resourceType() !== "eventsource") pending.add(r); });
  page.on("requestfinished", (r) => pending.delete(r));
  page.on("requestfailed", (r) => pending.delete(r));
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await prime(page, inst, { look, profile: true, extra: { "aurora-data-mode": "full", ...extra } });
  return { ctx, page, inst, pending, size: d };
};

const settle = async (page, pending, { quietMs = 800, capMs = 20000 } = {}) => {
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

// A full load every time: a change of route alone would leave the last
// scene's menu, sheet or backdrop standing on the page.
const go = async (h, route) => {
  await h.page.goto(`${h.inst.url}/robots.txt`, { waitUntil: "load", timeout: 60000 });
  h.pending.clear();
  await h.page.goto(`${h.inst.url}/${h.inst.routes[route] != null ? h.inst.routes[route] : route}`, { waitUntil: "load", timeout: 60000 });
  await settle(h.page, h.pending);
};

module.exports = { ROOT, INST, SCRATCH, SIZES, launch, openPage, syncCss, settle, go, sleep, DEFAULT_SKY, FREEZE, FIXED_NOW };
