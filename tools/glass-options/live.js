// The same scenes as shoot.js, on this PC's own server (real posters, real
// pictures), LOOKED AT only, signed in as the test profile "Claude QA"
// through the page (its password read from the briefs' COMMON-RULES.md,
// never written here). No writes: pages are opened and photographed; a
// menu is opened and the page reloaded.
//
//   node tools/glass-options/live.js <outdir> <rules.md> [a,e] [scene,…]
//
// The live server serves its own stylesheet: "a" is photographed with the
// bundle of origin/master's public/css (GA_BEFORE_CSS / the scratch
// before.css, as tools/glass-apple/lib.js), "e" with this worktree's own
// (built by src/lib/cssbundle), both answered for /css/aurora.css.
"use strict";
const fs = require("fs");
const path = require("path");
const { launch, settle, sleep, SIZES, FREEZE, FIXED_NOW, DEFAULT_SKY, ROOT, SCRATCH } = require("../glass-apple/lib");
const cssbundle = require("../../src/lib/cssbundle");
const { HELPERS } = require("../glass-apple/stage");
const { SCENES, capture } = require("./shoot");

const LIVE = "http://localhost:4000";
// the scenes that show nothing but the profile's own pages (the Recommend
// sheet lists the household's people, the player would start a stream:
// those two are taken on the private instance only)
const LIVE_OK = ["01", "02", "03", "05", "06", "07", "09", "10"];

(async () => {
  const [out = "live", rulesFile, vArg = "a,e", only = ""] = process.argv.slice(2);
  const pw = (fs.readFileSync(rulesFile, "utf8").match(/username claudeqa, password ([^)\s]+)\)/) || [])[1];
  if (!pw) throw new Error("no test password in the rules file");
  const versions = vArg.split(",");
  const pick = only ? only.split(",") : null;
  const scenes = SCENES.filter((s) => LIVE_OK.some((n) => s.id.startsWith(n)) && (!pick || pick.some((p) => s.id.startsWith(p))));
  fs.mkdirSync(out, { recursive: true });
  const b = await launch();
  try {
    for (const size of [...new Set(scenes.map((s) => s.size))]) {
      const d = SIZES[size];
      const ctx = await b.newContext({
        viewport: { width: d.width, height: d.height }, deviceScaleFactor: 2, isMobile: d.mobile, hasTouch: d.mobile,
        ...(d.ua ? { userAgent: d.ua } : {}), serviceWorkers: "block",
      });
      await ctx.addInitScript(FREEZE, [FIXED_NOW, DEFAULT_SKY]);
      await ctx.addInitScript(HELPERS);
      let side = "a";
      const before = fs.readFileSync(process.env.GA_BEFORE_CSS || path.join(SCRATCH, "before.css"));
      await ctx.route((u) => u.pathname === "/css/aurora.css", (r) => r.fulfill({ status: 200, contentType: "text/css; charset=utf-8", headers: { "cache-control": "no-store" }, body: side === "a" ? before : cssbundle.get(path.join(ROOT, "public", "css")).css }));
      const page = await ctx.newPage();
      const pending = new Set();
      page.on("request", (r) => { if (!r.url().startsWith("data:") && !r.url().startsWith("blob:") && r.resourceType() !== "websocket" && r.resourceType() !== "eventsource") pending.add(r); });
      page.on("requestfinished", (r) => pending.delete(r));
      page.on("requestfailed", (r) => pending.delete(r));
      page.on("pageerror", (e) => console.error("page error:", e.message));
      // sign in as the test profile
      await page.goto(`${LIVE}/`, { waitUntil: "load" });
      await page.getByRole("button", { name: "Claude QA" }).first().click();
      await page.getByPlaceholder("Password").fill(pw);
      await page.getByRole("button", { name: "Unlock" }).click();
      await page.waitForSelector(".row .card", { timeout: 30000 });
      const who = await page.evaluate(() => localStorage.getItem("aurora-profile"));
      if (who !== "242da3b05797") throw new Error(`signed in as ${who}, not the test profile`);
      // a film of the library, for the title page
      // (the first card of Movies, opened: its page's address)
      await page.goto(`${LIVE}/#/movies`, { waitUntil: "load" });
      await page.waitForSelector(".grid .card, .row .card", { timeout: 30000 });
      await sleep(1500);
      await page.evaluate(() => document.querySelector(".grid .card, .row .card").click());
      await page.waitForFunction(() => /^#\/(movie|discover\/movie)\//.test(location.hash), null, { timeout: 15000 });
      const film = await page.evaluate(() => location.hash);
      console.log("film page", film);
      for (const v of versions) {
        side = v;
        for (const s of scenes.filter((x) => x.size === size)) {
          try {
            const route = s.route === "home" ? "#/" : s.route === "libfilm" ? film : null;
            if (!route) throw new Error(`no route for ${s.route}`);
            await page.goto(`${LIVE}/robots.txt`, { waitUntil: "load" });
            pending.clear();
            await page.goto(`${LIVE}/${route}`, { waitUntil: "load" });
            await settle(page, pending);
            for (const step of s.stage || []) { await step(page); await sleep(250); }
            await settle(page, pending, { quietMs: 500, capMs: 8000 });
            await sleep(400);
            const crops = await capture(page, s, v, out);
            console.log(v, s.id, "crops", crops.length);
          } catch (e) { console.log(v, s.id, "FAILED", e.message.split("\n")[0]); }
        }
      }
      await ctx.close();
    }
  } finally { await b.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
