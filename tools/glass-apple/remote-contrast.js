// The Remote screen: how well every word and icon on its pads reads, on the
// title's usual art and on an all-white picture (the worst ground it can get).
//
//   node tools/glass-apple/remote-contrast.js <outdir> <lookname> <before|after>
//   python tools/glass-apple/remote-contrast.py <outdir> <lookname> [<lookname> ...]
//
// "before" draws with the stylesheets of GA_BEFORE_REF / GA_BEFORE_CSS (see
// lib.js), "after" with the working tree, so several commits can be measured
// side by side — one run and one look name each. Three views are measured
// (now playing, the touchpad, the arrow buttons) with a simulated TV on the
// private instance; each is photographed as it is and with its words and
// icons taken off, as contrast.js does.
"use strict";
const path = require("path"), fs = require("fs");
const { launch, openPage, go, settle, sleep, INST } = require("./lib");
const { SimTV } = require("../../test/ui/support/sim-tv.js");
const PANES = ".rm-icon-btn, .rm-picker, .rm-skip, .rm-chip, .rm-seg, .rm-touch, .rm-dpad, .rm-key, .rm-dock";
const BARE = ".rm-now, .rm-view-now .rm-sub, .rm-view-now .rm-title, .rm-times, .rm-kicker, .rm-subtitle";
(async () => {
  const [out, look, side] = process.argv.slice(2);
  const dir = path.join(out, look); fs.mkdirSync(dir, { recursive: true });
  const inst = INST();
  const tv = new SimTV({ url: inst.url, profile: inst.profiles.glass, name: "Living room TV", deviceId: "tv-sim-glass-apple" });
  await tv.start();
  const b = await launch();
  try {
    const h = await openPage(b, { size: "phone", side });
    const { page } = h;
    await tv.open_(inst.lib.film2, { position: 21 }); tv.now.paused = true; tv.announce();
    await go(h, "#/remote");
    await page.waitForSelector('.remote-screen[data-state="playing"]', { timeout: 20000 });
    await sleep(2500); await settle(page, h.pending);
    const views = [["now", null], ["pad", "touch"], ["pad", "buttons"]];
    for (const art of ["usual", "white"]) {
      if (art === "white") {
        await page.evaluate(async () => {
          const img = document.querySelector(".rm-backdrop img");
          const url = window.__ga.poster("white", 320, 180);
          img.src = url; Object.defineProperty(img, "src", { get: () => url, set: () => {}, configurable: true });
          await img.decode().catch(() => {});
        });
        await sleep(1500);
      }
      for (const [view, mode] of views) {
        await page.locator(`.rm-seg-btn[data-view="${view}"]`).click(); await sleep(500);
        if (mode) { await page.locator(`.rm-seg-btn[data-mode="${mode}"]`).click().catch(() => {}); await sleep(500); }
        await page.mouse.move(2, 400); await sleep(700);
        const id = `${view}${mode ? "-" + mode : ""}.${art}`;
        const res = {};
        for (const [grp, sel] of [["panes", PANES], ["film", BARE]]) {
          const labels = await page.evaluate(([s]) => window.__ga.labels(s, { max: 80 }).map((l) => l), [sel]);
          res[grp] = labels;
        }
        // which pane each label sits on
        const named = await page.evaluate(([s, ls]) => ls.map((l) => { const e = document.elementFromPoint(l.rect[0] + l.rect[2] / 2, l.rect[1] + l.rect[3] / 2); const p = e && e.closest(s); const q = e && e.closest(".rm-ok, .rm-seg-btn, .rm-vol-btn, .rm-pad-hint, .rm-chip, .rm-key, .rm-skip, .rm-icon-btn, .rm-picker, .rm-dkey"); return (q ? q.className : p ? p.className : "?").replace(/focusable|rm-t\b/g, "").replace(/\s+/g, " ").trim(); }), [PANES, res.panes]);
        res.panes.forEach((l, i) => (l.where = named[i]));
        await page.screenshot({ path: path.join(dir, id + ".seen.png") });
        await page.evaluate(([a, c]) => window.__ga.hideLabels(a + ", " + c), [PANES, BARE]);
        await sleep(150);
        await page.screenshot({ path: path.join(dir, id + ".bare.png") });
        await page.evaluate(() => window.__ga.showLabels());
        fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify({ id, dpr: h.size.dpr, ...res }));
        console.log(look, id, res.panes.length, res.film.length);
      }
    }
    await page.evaluate(() => { try { localStorage.removeItem("aurora-remote-view"); localStorage.removeItem("aurora-remote-pad"); } catch {} });
    await h.ctx.close();
  } finally { await b.close(); await tv.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
