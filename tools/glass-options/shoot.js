// The glass versions side by side: the SAME scenes photographed once per
// version (A = today's glass, B Aurora, C Liquid, D Frost, E Clear — the
// version is chosen for the tab as ?glass= would), on the private instance
// (tools/mobile-perf/instance.js), everything that moves held still
// (tools/glass-apple/lib.js). sheet.py lays them out.
//
//   node tools/glass-options/shoot.js <outdir> [a,b,c,d,e] [scene,scene,…]
//
// Writes <outdir>/<scene>.<version>.png and <scene>.json (title, size,
// where the glass is — for the enlarged strips).
"use strict";
const fs = require("fs");
const path = require("path");
const { launch, openPage, go, settle, sleep, SIZES } = require("../glass-apple/lib");
const { OPEN } = require("../glass-apple/targets");

const ga = (fn, ...args) => async (page) => { await page.evaluate(([f, a]) => window.__ga[f](...a), [fn, args]); };
const wait = (ms) => async (page) => { await page.waitForTimeout(ms); };
const click = (sel) => async (page) => { await page.evaluate((s) => document.querySelector(s).click(), sel); };

// the More menu on a phone
const openMore = async (page) => {
  await page.evaluate(() => document.querySelector(".nav-more").click());
  await page.waitForSelector(".nav-more-sheet", { timeout: 8000 });
  await page.waitForTimeout(500);
};
// the Recommend sheet on a title of the library (falls back to the
// question sheet if there is nobody to recommend to)
const openRecommend = async (page) => {
  const ok = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Recommend/.test(x.textContent) && x.getBoundingClientRect().width > 0);
    if (!b) return false;
    b.click();
    return true;
  });
  if (ok) {
    await page.waitForSelector(".rec-people", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(900);
  } else await OPEN.sheet(page);
};
// the player, paused on a bright frame, its Settings menu open
const playerMenu = async (page) => {
  await page.waitForSelector(".player video", { timeout: 25000 });
  await page.evaluate(async () => {
    const v = document.querySelector(".player video");
    const once = (ev, ms) => new Promise((res) => { v.addEventListener(ev, res, { once: true }); setTimeout(res, ms); });
    if (v.readyState < 2) await once("loadeddata", 10000);
    v.pause();
    // a bright frame: a daylight picture laid exactly over the video
    const img = new Image();
    img.src = window.__ga.poster("cream", 1280, 720);
    await img.decode().catch(() => {});
    const r = v.getBoundingClientRect();
    img.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;object-fit:cover;z-index:0;pointer-events:none`;
    v.after(img);
    v.style.visibility = "hidden";
  });
  await page.mouse.move(640, 420);
  await page.mouse.move(660, 440);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const p = document.querySelector(".player");
    p.classList.remove("controls-hidden");
    document.querySelectorAll(".player > .spinner").forEach((n) => n.classList.add("hidden"));
    const b = document.querySelector('[data-ui="player.settings.open"]') || document.querySelector('[data-ui="player.speed.open"]');
    b && b.click();
  });
  await page.waitForSelector(".player .menu", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector(".player").classList.remove("controls-hidden"));
};

const SCENES = [
  { id: "01-phone-home", size: "phone-390", route: "home", title: "Phone · Home: the picture, the greeting, the tab bar",
    crops: [".nav-gear, .nav-profile", ".nav-items"] },
  { id: "02-phone-more", size: "phone-390", route: "home", title: "Phone · the More menu, open", stage: [openMore],
    crops: [".nav-more-sheet"] },
  { id: "03-phone-title", size: "phone-390", route: "libfilm", title: "Phone · a film's page: the buttons",
    crops: [".detail-actions", ".nav-items"] },
  { id: "04-phone-sheet", size: "phone-390", route: "libfilm", title: "Phone · the Recommend sheet, open", stage: [openRecommend],
    crops: [".modal, .look-notice, .rec-sheet, .peek"] },
  { id: "05-desktop-home", size: "desktop", route: "home", title: "Desktop · Home: the top bar over the picture",
    crops: [".nav"] },
  { id: "06-desktop-menu", size: "desktop", route: "home", title: "Desktop · the profile menu, open over bright posters",
    stage: [ga("brightRow", ".nav-items", { frac: 0.75 }), OPEN.profileMenu], crops: [".nav-menu"] },
  { id: "07-desktop-title", size: "desktop", route: "libfilm", title: "Desktop · a film's page",
    crops: [".detail-actions", ".nav"] },
  { id: "08-player-menu", size: "desktop", route: (inst) => `#/play/${inst.lib.film1}`, title: "Player · its menu over a bright frame",
    stage: [playerMenu], crops: [".player .menu", ".player-bottom"] },
  { id: "09-phone-toast", size: "phone-390", route: "home", title: "Phone · a message (toast) over bright posters",
    stage: [ga("brightRow", ".nav-items", { frac: 0.1 }), OPEN.toast, wait(350)], crops: [".toast", ".nav-items"] },
  { id: "10-phone-bright", size: "phone-390", route: "home", title: "Phone · the tab bar over bright posters (worst case)",
    stage: [ga("brightRow", ".nav-items", { frac: 0.5 })], crops: [".nav-items"] },
];

// photograph the page as it stands: the whole screen, and where the glass is
const capture = async (page, s, v, out) => {
  const crops = await page.evaluate((sels) => sels.map((sel) => {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const e of document.querySelectorAll(sel)) {
      const c = getComputedStyle(e);
      if (c.visibility === "hidden" || c.display === "none") continue;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
      x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
    }
    if (x1 < x0) return null;
    const pad = 16;
    x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(innerWidth, Math.ceil(x1 + pad)); y1 = Math.min(innerHeight, Math.ceil(y1 + pad));
    return [x0, y0, x1 - x0, y1 - y0];
  }).filter(Boolean), s.crops || []);
  await page.screenshot({ path: path.join(out, `${s.id}.${v}.png`) });
  const jf = path.join(out, `${s.id}.json`);
  let j = {};
  try { j = JSON.parse(fs.readFileSync(jf, "utf-8")); } catch {}
  j = { ...j, id: s.id, title: s.title, size: s.size, width: SIZES[s.size].width, height: SIZES[s.size].height, dpr: 2, crops: { ...(j.crops || {}), [v]: crops } };
  fs.writeFileSync(jf, JSON.stringify(j, null, 1));
  return crops;
};

const main = async () => {
  const [out = "shots", vArg = "a,b,c,d,e", only = ""] = process.argv.slice(2);
  const versions = vArg.split(",");
  const pick = only ? only.split(",") : null;
  const scenes = SCENES.filter((s) => !pick || pick.some((p) => s.id.startsWith(p)));
  fs.mkdirSync(out, { recursive: true });
  const b = await launch();
  try {
    for (const v of versions) {
      for (const size of [...new Set(scenes.map((s) => s.size))]) {
        const h = await openPage(b, { size, side: "after", glass: v === "a" ? null : v, dpr: 2 });
        const { page } = h;
        for (const s of scenes.filter((x) => x.size === size)) {
          try {
            await go(h, typeof s.route === "function" ? s.route(h.inst) : s.route);
            const got = await page.evaluate(() => document.documentElement.dataset.glass || "a");
            if (got !== v) throw new Error(`version ${got} on the page, ${v} asked`);
            for (const step of s.stage || []) { await step(page); await sleep(250); }
            await settle(page, h.pending, { quietMs: 500, capMs: 8000 });
            await sleep(400);
            const crops = await capture(page, s, v, out);
            console.log(v, s.id, "crops", crops.length);
          } catch (e) { console.log(v, s.id, "FAILED", e.message.split("\n")[0]); }
        }
        await h.ctx.close();
      }
    }
  } finally { await b.close(); }
};
module.exports = { SCENES, capture };
if (require.main === module) main();
