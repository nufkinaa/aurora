// Photographs every scene in scenes.js twice — today's glass (origin/master)
// and this branch's — into <outdir>/scene-NN.before.png / .after.png, with
// scene-NN.json (what it is, where the parts to enlarge are).
//
//   node tools/glass-apple/shoot.js <outdir> [before|after|both] [n,n,…]
//
// jury.py turns the pairs into the blind kit (A/B at random per scene).
"use strict";
const fs = require("fs");
const path = require("path");
const { launch, openPage, go, settle, sleep, SIZES } = require("./lib");
const { SCENES } = require("./scenes");

(async () => {
  const [out = "shots", sideArg = "both", only = ""] = process.argv.slice(2);
  const sides = sideArg === "both" ? ["before", "after"] : [sideArg];
  const pick = only ? only.split(",").map(Number) : null;
  const scenes = SCENES.filter((s) => !pick || pick.includes(s.n));
  fs.mkdirSync(out, { recursive: true });
  const b = await launch();
  // a simulated TV, on only while a scene asks for one (s.tv)
  let tv = null;
  const tvOff = async () => { if (tv) { await tv.stop(); tv = null; await sleep(600); } };
  const tvOn = async (h, state) => {
    if (!tv) {
      const { SimTV } = require("../../test/ui/support/sim-tv");
      tv = new SimTV({ url: h.inst.url, profile: h.inst.profiles.glass, name: "Living room TV", deviceId: "tv-sim-glass-apple" });
      await tv.start();
    }
    if (state === "playing") { await tv.open_(h.inst.lib.film2, { position: 21 }); tv.now.paused = true; } else { tv.now = null; tv.screen = "home"; }
    tv.announce();
  };
  try {
    for (const side of sides) {
      for (const size of [...new Set(scenes.map((s) => s.size))]) {
        const h = await openPage(b, { size, side });
        const { page } = h;
        for (const s of scenes.filter((x) => x.size === size)) {
          const nn = String(s.n).padStart(2, "0");
          try {
            if (s.tv) await tvOn(h, s.tv); else await tvOff();
            await go(h, typeof s.route === "function" ? s.route(h.inst) : s.route);
            for (const step of s.stage || []) { await step(page); await sleep(250); }
            await settle(page, h.pending, { quietMs: 500, capMs: 8000 });
            await sleep(300);
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
              const pad = 14;
              x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
              x1 = Math.min(innerWidth, Math.ceil(x1 + pad)); y1 = Math.min(innerHeight, Math.ceil(y1 + pad));
              return [x0, y0, x1 - x0, y1 - y0];
            }).filter(Boolean), s.crops || []);
            await page.screenshot({ path: path.join(out, `scene-${nn}.${side}.png`) });
            const meta = { n: s.n, size: s.size, width: SIZES[s.size].width, height: SIZES[s.size].height, dpr: SIZES[s.size].dpr, route: s.routeName || s.route, title: s.title, look: s.look, worst: !!s.worst };
            const jf = path.join(out, `scene-${nn}.json`);
            let j = {};
            try { j = JSON.parse(fs.readFileSync(jf, "utf-8")); } catch {}
            j = { ...j, ...meta, crops: { ...(j.crops || {}), [side]: crops }, scrollY: { ...(j.scrollY || {}), [side]: await page.evaluate(() => Math.round(scrollY)) } };
            fs.writeFileSync(jf, JSON.stringify(j, null, 1));
            console.log(side, nn, s.size, s.title, "crops", crops.length);
          } catch (e) { console.log(side, nn, "FAILED", e.message.split("\n")[0]); }
        }
        await tvOff();
        await h.ctx.close();
      }
    }
  } finally { await tvOff().catch(() => {}); await b.close(); }
})();
