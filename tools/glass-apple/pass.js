// A look at the other sizes: each opened thing (menu, sheet, peek, toast) and
// the pages that are mostly panes, one photograph each.
//
//   node tools/glass-apple/pass.js <before|after> <outdir> [size,size] [what,what]
"use strict";
const fs = require("fs");
const path = require("path");
const { launch, openPage, go, sleep } = require("./lib");
const { OPEN } = require("./targets");

const WHAT = {
  menu: { route: "home", open: OPEN.profileMenu },
  sheet: { route: "home", open: OPEN.sheet },
  peek: { route: "home", open: OPEN.peek },
  toast: { route: "home", open: OPEN.toast },
  downloads: { route: "downloads" },
  settings: { route: "settings" },
  episodes: { route: "libshow", open: OPEN.pageDown(520) },
  search: { route: "search", open: OPEN.suggest },
  film: { route: "film" },
};

(async () => {
  const [side = "after", out = "pass", sizesArg = "phone-320,phone-375,phone-430,tablet-768,desktop-1280,desktop-1920", whatArg = Object.keys(WHAT).join(",")] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const b = await launch();
  try {
    for (const size of sizesArg.split(",")) {
      const h = await openPage(b, { size, side });
      for (const w of whatArg.split(",")) {
        try {
          await go(h, WHAT[w].route);
          if (WHAT[w].open) await WHAT[w].open(h.page);
          await sleep(700);
          await h.page.screenshot({ path: path.join(out, `${size}.${w}.${side}.png`) });
          console.log(size, w, "ok");
        } catch (e) { console.log(size, w, "FAILED", String(e.message).split("\n")[0]); }
      }
      await h.ctx.close();
    }
  } finally { await b.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
