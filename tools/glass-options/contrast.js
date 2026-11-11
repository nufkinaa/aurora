// How well the words on the glass read, measured.
//
//   node tools/glass-options/contrast.js <a,e> <outdir> [idFilter]
//
// (tools/glass-apple/contrast.js, "a" = today's look from origin/master's
// stylesheet, "e" = this worktree's: <outdir>/<a|e>/…, then
// python tools/glass-options/contrast.py <outdir> a,e)
//
// For every surface in targets.js and every backdrop it can meet (a white
// poster, a bright one, a mid grey that today's tone flip does not catch,
// white text passing under, the sky's bright band, black): the backdrop is
// staged, each run of letters and each icon is located and its colour read,
// then the words are taken off and the surface is photographed — what is
// left is exactly what each letter is drawn on. contrast.py turns the
// photographs into WCAG contrast ratios (the worst 1 % of the pixels behind
// each word, so one ghost of a letter under a label counts).
"use strict";
const fs = require("fs");
const path = require("path");
const { launch, openPage, go, settle, sleep } = require("../glass-apple/lib");
const { TARGETS: BASE } = require("../glass-apple/targets");

// The player's glass (glass-apple's targets have none): a library film held
// on one frame with the controls up, a daylight picture laid exactly over
// the video ("frame": the brightest picture a film can show), the Settings
// menu opened for the menu.
const playerOpen = (menu) => async (page) => {
  await page.waitForSelector(".player video", { timeout: 25000 });
  await page.evaluate(async () => {
    const v = document.querySelector(".player video");
    const once = (ev, ms) => new Promise((res) => { v.addEventListener(ev, res, { once: true }); setTimeout(res, ms); });
    if (v.readyState < 2) await once("loadeddata", 10000);
    v.pause();
  });
  await page.mouse.move(200, 300);
  await page.mouse.move(220, 320);
  await sleep(300);
  await page.evaluate(() => {
    document.querySelector(".player").classList.remove("controls-hidden");
    document.querySelectorAll(".player > .spinner").forEach((n) => n.classList.add("hidden"));
  });
  if (menu) {
    await page.evaluate(() => { const b = document.querySelector('[data-ui="player.settings.open"]'); b && b.click(); });
    await page.waitForSelector(".player .menu", { timeout: 8000 });
  }
  await sleep(400);
  await page.evaluate(() => document.querySelector(".player").classList.remove("controls-hidden"));
};
const frame = async (page) => {
  await page.evaluate(async () => {
    const v = document.querySelector(".player video");
    if (!v || document.getElementById("ga-frame")) return;
    const img = new Image();
    img.id = "ga-frame";
    img.src = window.__ga.poster("white", 1280, 720);
    await img.decode().catch(() => {});
    const r = v.getBoundingClientRect();
    img.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;object-fit:cover;z-index:0;pointer-events:none`;
    v.after(img);
    v.style.visibility = "hidden";
  });
  await sleep(400);
};
const play = (inst) => `#/play/${inst.lib.film1}`;
const EXTRA = [];
for (const size of ["desktop", "phone"]) {
  EXTRA.push({ id: `playerdock.${size}`, name: `Player: the dock and the top pills (${size === "phone" ? "phone 402" : "desktop 1440"})`, size, route: play, open: playerOpen(false), roots: ".player-bottom, .player-top, .resume-card", kinds: ["frame"] });
  EXTRA.push({ id: `playermenu.${size}`, name: `Player: the Settings menu (${size === "phone" ? "phone 402" : "desktop 1440"})`, size, route: play, open: playerOpen(true), roots: ".player .menu", kinds: ["frame"] });
}
const TARGETS = [...BASE, ...EXTRA];

(async () => {
  const [vArg = "a,e", out = "contrast-out", filter = ""] = process.argv.slice(2);
  const sides = vArg.split(",");
  const targets = TARGETS.filter((t) => !filter || filter.split(",").some((f) => t.id.includes(f)));
  const b = await launch();
  try {
    for (const side of sides) {
      const dir = path.join(out, side);
      fs.mkdirSync(dir, { recursive: true });
      const sizes = [...new Set(targets.map((t) => t.size))];
      for (const size of sizes) {
        const h = await openPage(b, { size, side: side === "a" ? "before" : "after" });
        const { page } = h;
        for (const t of targets.filter((x) => x.size === size)) {
          try {
            await go(h, typeof t.route === "function" ? t.route(h.inst) : t.route);
            if (t.open) { await t.open(page); await sleep(500); await settle(page, h.pending, { quietMs: 400, capMs: 6000 }); }
            for (const kind of t.kinds) {
              if (kind === "frame") await frame(page);
              else if (kind === "art") await page.evaluate(() => window.__ga.whiteArt());
              else await page.evaluate(([k, keep]) => window.__ga.backdrop(k, { keepContent: keep }), [kind, !!t.keepContent]);
              if (t.reopen) { await t.open(page); await sleep(300); }
              await sleep(250);
              // (a word scrolled out of its pane — a long menu — is not on show:
              // only the words whose middle lies inside one of the panes count)
              const labels = await page.evaluate(([sel, max]) => {
                const panes = [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect());
                return window.__ga.labels(sel, { max }).filter((l) => {
                  const cx = l.rect[0] + l.rect[2] / 2, cy = l.rect[1] + l.rect[3] / 2;
                  return panes.some((r) => cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom);
                });
              }, [t.roots, t.max || 40]);
              if (!labels.length) { console.log(side, t.id, kind, "NO LABELS"); continue; }
              const vp = page.viewportSize();
              let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
              for (const l of labels) { x0 = Math.min(x0, l.rect[0]); y0 = Math.min(y0, l.rect[1]); x1 = Math.max(x1, l.rect[0] + l.rect[2]); y1 = Math.max(y1, l.rect[1] + l.rect[3]); }
              const clip = { x: Math.max(0, Math.floor(x0 - 6)), y: Math.max(0, Math.floor(y0 - 6)) };
              clip.width = Math.min(vp.width, Math.ceil(x1 + 6)) - clip.x;
              clip.height = Math.min(vp.height, Math.ceil(y1 + 6)) - clip.y;
              const base = path.join(dir, `${t.id}.${kind}`);
              await page.screenshot({ path: base + ".seen.png", clip });
              await page.evaluate((sel) => window.__ga.hideLabels(sel), t.roots);
              await sleep(120);
              await page.screenshot({ path: base + ".bare.png", clip });
              await page.evaluate(() => window.__ga.showLabels());
              fs.writeFileSync(base + ".json", JSON.stringify({ id: t.id, name: t.name, size: t.size, kind, side, dpr: h.size.dpr, clip, labels }));
              console.log(side, t.id, kind, labels.length);
            }
          } catch (e) { console.log(side, t.id, "FAILED", e.message.split("\n")[0]); }
        }
        await h.ctx.close();
      }
    }
  } finally { await b.close(); }
})();
