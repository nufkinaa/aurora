// The rule this branch works under: nothing gains a backdrop filter it did
// not have, and none gets a larger blur. This counts them — every element on
// a page whose computed backdrop-filter is not "none", with today's sheet
// (origin/master) and with this branch's — and prints what differs.
//
//   node tools/glass-apple/bfcount.js [size,size] [route,route]
"use strict";
const { launch, openPage, go, sleep } = require("./lib");
const { OPEN } = require("./targets");

const COUNT = () => {
  const out = {};
  for (const e of document.querySelectorAll("body *")) {
    const c = getComputedStyle(e);
    const f = c.backdropFilter || c.webkitBackdropFilter;
    if (!f || f === "none") continue;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || c.display === "none") continue;
    const key = (e.id ? "#" + e.id : "") + "." + [...e.classList].slice(0, 3).join(".");
    (out[key] = out[key] || { n: 0, f }).n++;
  }
  return out;
};
const blurOf = (f) => { const m = /blur\(([\d.]+)px\)/.exec(f); return m ? Number(m[1]) : 0; };

(async () => {
  const [sizesArg = "phone,tablet,desktop", routesArg = "home,film,libshow,search,settings,movies,downloads"] = process.argv.slice(2);
  const b = await launch();
  let bad = 0;
  try {
    for (const size of sizesArg.split(",")) {
      const got = {};
      for (const side of ["before", "after"]) {
        const h = await openPage(b, { size, side });
        for (const route of routesArg.split(",")) {
          await go(h, route);
          await sleep(400);
          got[`${route}`] = got[`${route}`] || {};
          got[`${route}`][side] = await h.page.evaluate(COUNT);
          if (route === "home") {
            // with a menu, a sheet and a toast open
            await OPEN.profileMenu(h.page); await sleep(300);
            await OPEN.toast(h.page); await sleep(300);
            got["home+menu+toast"] = got["home+menu+toast"] || {};
            got["home+menu+toast"][side] = await h.page.evaluate(COUNT);
          }
        }
        await h.ctx.close();
      }
      for (const [route, s] of Object.entries(got)) {
        const keys = new Set([...Object.keys(s.before), ...Object.keys(s.after)]);
        const nb = Object.values(s.before).reduce((a, x) => a + x.n, 0), na = Object.values(s.after).reduce((a, x) => a + x.n, 0);
        const notes = [];
        for (const k of keys) {
          const x = s.before[k], y = s.after[k];
          if (!x && y) { notes.push(`NEW ${k} ${y.f}`); bad++; }
          else if (x && !y) notes.push(`gone ${k}`);
          else if (y.n > x.n) { notes.push(`MORE ${k} ${x.n}->${y.n}`); bad++; }
          else if (blurOf(y.f) > blurOf(x.f)) { notes.push(`LARGER ${k} ${x.f} -> ${y.f}`); bad++; }
          else if (y.f !== x.f) notes.push(`${k}: ${x.f} -> ${y.f}`);
        }
        console.log(`${size} ${route}: ${nb} -> ${na}${notes.length ? "\n   " + notes.join("\n   ") : ""}`);
      }
    }
  } finally { await b.close(); }
  console.log(bad ? `${bad} place(s) gained or grew a backdrop filter` : "nothing gained a backdrop filter, none grew");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
