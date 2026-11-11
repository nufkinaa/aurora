// How well the words on the glass read, measured.
//
//   node tools/glass-options/contrast.js <a,b,c,d,e> <outdir> [idFilter]
//
// (tools/glass-apple/contrast.js, one run per glass version instead of
// before/after: <outdir>/<version>/…, then
// python tools/glass-apple/contrast.py <outdir>/<version>)
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
const { TARGETS } = require("../glass-apple/targets");

(async () => {
  const [vArg = "a,b,c,d,e", out = "contrast-out", filter = ""] = process.argv.slice(2);
  const sides = vArg.split(",");
  const targets = TARGETS.filter((t) => !filter || filter.split(",").some((f) => t.id.includes(f)));
  const b = await launch();
  try {
    for (const side of sides) {
      const dir = path.join(out, side);
      fs.mkdirSync(dir, { recursive: true });
      const sizes = [...new Set(targets.map((t) => t.size))];
      for (const size of sizes) {
        const h = await openPage(b, { size, side: "after", glass: side === "a" ? null : side });
        const { page } = h;
        for (const t of targets.filter((x) => x.size === size)) {
          try {
            await go(h, t.route);
            if (t.open) { await t.open(page); await sleep(500); await settle(page, h.pending, { quietMs: 400, capMs: 6000 }); }
            for (const kind of t.kinds) {
              if (kind === "art") await page.evaluate(() => window.__ga.whiteArt());
              else await page.evaluate(([k, keep]) => window.__ga.backdrop(k, { keepContent: keep }), [kind, !!t.keepContent]);
              if (t.reopen) { await t.open(page); await sleep(300); }
              await sleep(250);
              const labels = await page.evaluate(([sel, max]) => window.__ga.labels(sel, { max }), [t.roots, t.max || 40]);
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
