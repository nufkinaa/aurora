// Which glass panes are on each screen, how they are placed, and whether
// their ::before / ::after are free (for the rim's ring).
//   node tools/real-glass/full/probe.js [size=desktop] "<selectors>"
"use strict";
const { launch, openPage, go, sleep } = require("../../glass-apple/lib");
const { OPEN } = require("../../glass-apple/targets");
const [size = "desktop", selArg] = process.argv.slice(2);
const SEL = selArg.split(",").map((s) => s.trim()).filter(Boolean);
const SCENES = [
  ["home"], ["home", OPEN.profileMenu], ["home", OPEN.sheet], ["home", OPEN.toast], ["home", OPEN.peek],
  ["search", OPEN.suggest], ["settings"], ["libshow"], ["libfilm"], ["film"], ["downloads"], ["movies"],
  ["#/calendar"], ["#/calendar?grid=1"], ["#/new"],
];
(async () => {
  const b = await launch();
  const out = {};
  try {
    const h = await openPage(b, { size });
    for (const [route, open] of SCENES) {
      try { await go(h, route); if (open) await open(h.page); await sleep(500); } catch (e) { console.log(route, "FAILED", e.message.split("\n")[0]); continue; }
      const r = await h.page.evaluate((sels) => sels.map((s) => {
        const els = [...document.querySelectorAll(s)].filter((e) => e.offsetWidth > 0);
        if (!els.length) return null;
        const pos = new Set(), bf = new Set(), af = new Set();
        for (const e of els) { const cs = getComputedStyle(e); pos.add(cs.position); bf.add(getComputedStyle(e, "::before").content); af.add(getComputedStyle(e, "::after").content); }
        return [s, els.length, [...pos].join("/"), [...bf].join("/"), [...af].join("/")];
      }).filter(Boolean), SEL);
      for (const [s, n, p, bfo, afo] of r) {
        const k = s; out[k] = out[k] || { n: 0, pos: new Set(), before: new Set(), after: new Set(), routes: new Set() };
        out[k].n += n; p.split("/").forEach((x) => out[k].pos.add(x)); bfo.split("/").forEach((x) => out[k].before.add(x)); afo.split("/").forEach((x) => out[k].after.add(x)); out[k].routes.add(route);
      }
    }
    await h.ctx.close();
  } finally { await b.close(); }
  for (const s of SEL) { const o = out[s]; console.log(o ? `${s.padEnd(34)} n=${o.n} pos=${[...o.pos]} before=${[...o.before]} after=${[...o.after]} @${[...o.routes].join(" ")}` : `${s.padEnd(34)} (not seen)`); }
})().catch((e) => { console.error(e); process.exit(1); });
