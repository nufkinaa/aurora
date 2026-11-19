// The design lab: the glass chrome photographed over dark, bright and busy
// pictures, with a variant stylesheet laid over the worktree's own.
//
//   node tools/real-glass/lab.js <outdir> <name> [variant.css|-] [scene,scene] [lens=1|0]
//
// Writes <outdir>/<scene>.<name>.png (whole screen) and <scene>.<name>.<n>.png (crops).
"use strict";
const fs = require("fs");
const path = require("path");
const { launch, openPage, go, settle, sleep, INST, ROOT, SIZES, FREEZE, FIXED_NOW, DEFAULT_SKY, SCRATCH } = require("../glass-apple/lib");
const { HELPERS } = require("../glass-apple/stage");
const cssbundle = require("../../src/lib/cssbundle");

// LIVE=<rules.md>: the same on this PC's own server (real posters), LOOKED AT
// only, signed in as the test profile through the page (its password read
// from the briefs' rules file, never written here). No writes.
const LIVE = "http://localhost:4000";
const openLive = async (b, { size, side, dpr }) => {
  const pw = (fs.readFileSync(process.env.LIVE, "utf8").match(/username claudeqa, password ([^)\s]+)\)/) || [])[1];
  if (!pw) throw new Error("no test password in the rules file");
  const d = SIZES[size];
  const ctx = await b.newContext({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: dpr, isMobile: d.mobile, hasTouch: d.mobile, userAgent: d.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", serviceWorkers: "block" });
  await ctx.addInitScript(FREEZE, [FIXED_NOW, DEFAULT_SKY]);
  await ctx.addInitScript(HELPERS);
  const before = fs.readFileSync(process.env.GA_BEFORE_CSS || path.join(SCRATCH, "before.css"));
  await ctx.route((u) => u.pathname === "/css/aurora.css", (r) => r.fulfill({ status: 200, contentType: "text/css; charset=utf-8", headers: { "cache-control": "no-store" }, body: side === "before" ? before : cssbundle.get(path.join(ROOT, "public", "css")).css }));
  await ctx.route((u) => u.pathname === "/js/glasslens.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", headers: { "cache-control": "no-store" }, body: fs.readFileSync(path.join(ROOT, "public", "js", "glasslens.js")) }));
  const page = await ctx.newPage();
  const pending = new Set();
  page.on("request", (r) => { if (!r.url().startsWith("data:") && !r.url().startsWith("blob:") && r.resourceType() !== "websocket" && r.resourceType() !== "eventsource") pending.add(r); });
  page.on("requestfinished", (r) => pending.delete(r));
  page.on("requestfailed", (r) => pending.delete(r));
  await page.goto(`${LIVE}/`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Claude QA" }).first().click();
  await page.getByPlaceholder("Password").fill(pw);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.waitForSelector(".row .card", { timeout: 30000 });
  const who = await page.evaluate(() => localStorage.getItem("aurora-profile"));
  if (who !== "242da3b05797") throw new Error(`signed in as ${who}, not the test profile`);
  await page.goto(`${LIVE}/#/movies`, { waitUntil: "load" });
  await page.waitForSelector(".grid .card, .row .card", { timeout: 30000 });
  await sleep(1500);
  await page.evaluate(() => document.querySelector(".grid .card, .row .card").click());
  await page.waitForFunction(() => /^#\/(movie|discover\/movie)\//.test(location.hash), null, { timeout: 15000 });
  const film = await page.evaluate(() => location.hash);
  return { ctx, page, pending, inst: { url: LIVE, routes: { home: "#/", libfilm: film, settings: "#/preferences" } } };
};

const syncJs = () => {
  const inst = INST();
  for (const f of ["glasslens.js", "main.js"]) {
    const a = fs.readFileSync(path.join(ROOT, "public", "js", f));
    fs.writeFileSync(path.join(inst.root, "public", "js", f), a);
  }
};
// (the private instance runs this worktree's main.js, which starts the lens
// itself; this PC's own server runs master's, so there it is started here)
const lensOn = async (page) => {
  await page.evaluate(async () => { const m = await import("/js/glasslens.js"); m.initGlassLens(); });
  await page.waitForTimeout(500);
};
const bright = (frac, kinds) => async (page) => { await page.evaluate(([f, k]) => window.__ga.brightRow(".nav-items", { frac: f, ...(k ? { kinds: k } : {}) }), [frac, kinds]); };
const scrollTo = (y) => async (page) => { await page.evaluate((v) => { scrollTo(0, v); scrollBy(0, 1); scrollBy(0, -1); }, y); await page.waitForTimeout(500); };
// a row of the instance's own (busy, colourful) posters under the bar
const busy = (frac) => async (page) => {
  await page.evaluate((f) => {
    const bar = document.querySelector(".nav-items").getBoundingClientRect();
    const rows = [...document.querySelectorAll(".row")].filter((r) => r.querySelector(".card img") && r.getBoundingClientRect().top + scrollY > innerHeight * 0.75);
    const card = rows[1].querySelector(".card img").getBoundingClientRect();
    scrollTo(0, Math.max(0, Math.round(card.top + scrollY + card.height * f - (bar.top + bar.height / 2))));
    scrollBy(0, 1); scrollBy(0, -1);
  }, frac);
  await page.waitForTimeout(700);
};

// (a click on nothing first: the page then knows a mouse is in use, as in real use — a page that has seen
// no pointer at all draws a hovered button as if the keyboard had reached it, filled white)
const hover = (sel) => async (page) => { await page.mouse.click(3, 500); const c = await page.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel); await page.mouse.move(c[0], c[1]); await page.waitForTimeout(500); };

const SCENES = [
  { id: "p-home", size: "phone-390", route: "home", crops: [".nav-logo, .nav-gear, .nav-profile, .nav-dl", ".nav-items", ".hero-actions"] },
  { id: "p-busy", size: "phone-390", route: "home", stage: [busy(0.5)], crops: [".nav-logo, .nav-gear, .nav-profile, .nav-dl", ".nav-items"] },
  { id: "p-bright", size: "phone-390", route: "home", stage: [bright(0.5)], crops: [".nav-items"] },
  { id: "p-title", size: "phone-390", route: "libfilm", crops: [".detail-actions", ".nav-items"] },
  { id: "d-home", size: "desktop", route: "home", crops: [".nav", ".hero-actions"] },
  { id: "d-busy", size: "desktop", route: "home", stage: [busy(0.12)], crops: [".nav"] },
  { id: "d-bright", size: "desktop", route: "home", stage: [bright(0.3, ["cream", "snow", "lemon", "white", "cream", "snow"])], crops: [".nav"] },
  { id: "d-title", size: "desktop", route: "libfilm", crops: [".detail-actions", ".nav"] },
  // the dark sky alone behind the chrome (Settings), and the widths between a phone and a wide desktop
  { id: "p-sky", size: "phone-390", route: "settings", crops: [".nav-logo, .nav-gear, .nav-profile, .nav-dl", ".nav-items"] },
  { id: "d-sky", size: "desktop", route: "settings", crops: [".nav"] },
  { id: "t-home", size: "tablet", route: "home", crops: [".nav", ".hero-actions"] },
  { id: "t-busy", size: "tablet", route: "home", stage: [busy(0.15)], crops: [".nav"] },
  { id: "t7-home", size: "tablet-768", route: "home", crops: [".nav", ".hero-actions"] },
  { id: "t7-title", size: "tablet-768", route: "libfilm", crops: [".detail-actions", ".nav"] },
  // a desktop's pointer resting on a round button, and on a title's button (they take their lens under it)
  { id: "d-hover", size: "desktop", route: "home", stage: [hover(".nav-gear")], crops: [".nav"] },
  { id: "d-title-hover", size: "desktop", route: "libfilm", stage: [hover(".detail-actions .btn:not(.btn-primary)")], crops: [".detail-actions"] },
];

const main = async () => {
  const [out, name, cssFile = "-", only = "", lens = "1"] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  if (!process.env.LIVE) syncJs();
  const css = cssFile !== "-" ? fs.readFileSync(cssFile, "utf-8") : "";
  const pick = only ? only.split(",") : null;
  const scenes = SCENES.filter((s) => !pick || pick.includes(s.id));
  const b = await launch();
  try {
    for (const size of [...new Set(scenes.map((s) => s.size))]) {
      const h = await (process.env.LIVE ? openLive : openPage)(b, { size, side: name === "today" ? "before" : "after", dpr: SIZES[size].mobile && SIZES[size].width <= 720 ? 3 : 2 });
      const { page } = h;
      for (const s of scenes.filter((x) => x.size === size)) {
        await go(h, s.route);
        if (css) await page.addStyleTag({ content: css });
        if (lens === "1" && name !== "today") await lensOn(page);
        for (const step of s.stage || []) { await step(page); await sleep(250); }
        await settle(page, h.pending, { quietMs: 500, capMs: 8000 });
        await sleep(500);
        await page.screenshot({ path: path.join(out, `${s.id}.${name}.png`) });
        const crops = await page.evaluate((sels) => sels.map((sel) => {
          let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
          for (const e of document.querySelectorAll(sel)) {
            const r = e.getBoundingClientRect();
            if (!r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight) continue;
            x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
          }
          if (x1 < x0) return null;
          const pad = 14;
          x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
          return { x: x0, y: y0, width: Math.min(innerWidth, Math.ceil(x1 + pad)) - x0, height: Math.min(innerHeight, Math.ceil(y1 + pad)) - y0 };
        }), s.crops);
        let i = 0;
        for (const c of crops) { if (c) await page.screenshot({ path: path.join(out, `${s.id}.${name}.${i}.png`), clip: c }); i++; }
        console.log(name, s.id, JSON.stringify(await page.evaluate(() => ({ lens: document.documentElement.dataset.lens || null, filters: document.querySelectorAll("#rg-defs filter").length }))));
      }
      await h.ctx.close();
    }
  } finally { await b.close(); }
};
main().catch((e) => { console.error(e); process.exit(1); });
