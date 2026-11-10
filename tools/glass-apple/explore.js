// A quick look: node tools/glass-apple/explore.js <before|after> <outdir> <size,size> <route,route> [scrollY]
"use strict";
const fs = require("fs");
const path = require("path");
const { launch, openPage, go, settle, sleep } = require("./lib");
(async () => {
  const [side, out, sizes, routes, scroll] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const b = await launch();
  try {
    for (const size of sizes.split(",")) {
      const h = await openPage(b, { size, side });
      for (const route of routes.split(",")) {
        await go(h, route);
        if (scroll) { await h.page.evaluate((y) => window.scrollTo(0, Number(y)), scroll); await settle(h.page, h.pending); }
        await sleep(600);
        await h.page.screenshot({ path: path.join(out, `${size}.${route}${scroll ? "." + scroll : ""}.${side}.png`) });
        console.log(size, route, "ok");
      }
      await h.ctx.close();
    }
  } finally { await b.close(); }
})();
