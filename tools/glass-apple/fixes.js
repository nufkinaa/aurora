// Three things looked at after the first pass:
//   1. the hero's tag pill ("SERIES" / "FILM") over a white picture — a
//      photograph with its letters and one without, so the letters' colour
//      can be read against the pill's own ground;
//   2. the remote's sheet on a phone — does its blur draw;
//   3. the sign-in sheet's sentence (.claim-dim) — no box of its own.
//
//   node tools/glass-apple/fixes.js <before|after|both> <outdir> [size,size]
"use strict";
const fs = require("fs");
const path = require("path");
const { launch, openPage, go, settle, sleep } = require("./lib");

const clipOf = (page, sel, pad = 0) => page.evaluate(([s, p]) => {
  const e = document.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  if (!r.width) return null;
  return { x: Math.max(0, r.x - p), y: Math.max(0, r.y - p), width: r.width + 2 * p, height: r.height + 2 * p };
}, [sel, pad]);

(async () => {
  const [sideArg = "both", out = "fixes-out", sizesArg = "phone,phone-320,desktop"] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const sides = sideArg === "both" ? ["before", "after"] : [sideArg];
  const b = await launch();
  const facts = [];
  try {
    for (const size of sizesArg.split(",")) {
      for (const side of sides) {
        const h = await openPage(b, { size, side });
        const p = h.page;
        const name = (what) => path.join(out, `${size}.${what}.${side}.png`);

        // 1. the tag pill, Home and a title page, over white and as it is
        for (const [route, sel] of [["home", ".hero .hero-kicker"], ["film", ".detail-info .hero-kicker"], ["libshow", ".detail-info .hero-kicker"]]) {
          await go(h, route);
          await sleep(500);
          for (const art of ["asis", "white"]) {
            if (art === "white") { await p.evaluate(() => window.__ga.whiteArt()); await sleep(500); }
            const clip = await clipOf(p, sel, 0);
            if (!clip) { console.log(size, side, route, art, "no tag on screen"); continue; }
            const css = await p.evaluate((s) => { const c = getComputedStyle(document.querySelector(s)); return { color: c.color, bg: c.backgroundColor, bf: c.backdropFilter || c.webkitBackdropFilter, font: c.fontSize + "/" + c.fontWeight }; }, sel);
            await p.screenshot({ path: name(`tag-${route}-${art}`), clip });
            await p.evaluate((s) => document.querySelector(s).style.setProperty("color", "transparent", "important"), sel);
            await p.screenshot({ path: name(`tag-${route}-${art}-ground`), clip });
            await p.evaluate((s) => document.querySelector(s).style.removeProperty("color"), sel);
            const wide = await clipOf(p, sel, 90);
            await p.screenshot({ path: name(`tag-${route}-${art}-wide`), clip: wide });
            facts.push({ size, side, what: `tag-${route}-${art}`, ...css });
          }
          if (route === "home") {
            await p.screenshot({ path: name("home-white") });
            // the worst case with nothing in the way: a plain white sheet right
            // behind a copy of the pill (no fade of the hero's over it)
            const pc = await p.evaluate((s) => {
              const e = document.querySelector(s), r = e.getBoundingClientRect();
              const w = document.createElement("div");
              w.style.cssText = `position:fixed;left:${r.x - 30}px;top:${r.y - 30}px;width:${r.width + 60}px;height:${r.height + 60}px;background:#fff;z-index:99990`;
              const c = e.cloneNode(true);
              const cs = getComputedStyle(e);
              c.style.cssText = `position:fixed;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;margin:0;z-index:99991;box-sizing:border-box;display:${cs.display};padding:${cs.padding};font:${cs.font};letter-spacing:${cs.letterSpacing};text-transform:${cs.textTransform};border-radius:${cs.borderRadius};line-height:${cs.lineHeight};color:transparent`;
              c.id = "ga-pill-copy";
              document.body.append(w, c);
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            }, sel);
            await sleep(200);
            await p.screenshot({ path: name("tag-home-purewhite-ground"), clip: pc });
            await p.evaluate(() => { document.getElementById("ga-pill-copy").style.color = ""; });
            await p.screenshot({ path: name("tag-home-purewhite"), clip: pc });
            await p.screenshot({ path: name("tag-home-purewhite-wide"), clip: { x: Math.max(0, pc.x - 30), y: pc.y - 30, width: pc.width + 60, height: pc.height + 60 } });
            facts.push({ size, side, what: "tag-home-purewhite", ...(await p.evaluate(() => { const c = getComputedStyle(document.getElementById("ga-pill-copy")); return { color: c.color, bg: c.backgroundColor }; })) });
          }
        }

        // 2. the remote's sheet
        await go(h, "#/remote");
        await sleep(800);
        const more = await p.$('[data-ui="remote.more"]');
        if (more) {
          // something sharp and bright behind where the sheet will sit
          await p.evaluate(() => {
            const d = document.createElement("div");
            d.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:46vh;z-index:2;display:grid;align-content:space-around;justify-items:center;font:800 26px/1 system-ui;color:#fff;background:repeating-linear-gradient(90deg,#fff 0 6px,#0b0d18 6px 28px,#ffd24a 28px 34px,#0b0d18 34px 60px)";
            for (let i = 0; i < 5; i++) { const t = document.createElement("div"); t.textContent = "CONTROLS BEHIND THE SHEET"; t.style.cssText = "background:#0b0d18;padding:4px 10px"; d.append(t); }
            document.querySelector(".remote-screen").append(d);
          });
          await p.screenshot({ path: name("remote") });
          await more.click();
          await sleep(900);
          const f = await p.evaluate(() => {
            const w = document.querySelector(".rm-sheet-wrap"), s = document.querySelector(".rm-sheet");
            if (!w || !s) return null;
            const cw = getComputedStyle(w), cs = getComputedStyle(s);
            return { wrapAnim: cw.animationName, wrapOpacity: cw.opacity, anims: w.getAnimations().map((a) => a.animationName || a.transitionProperty), sheetBf: cs.backdropFilter || cs.webkitBackdropFilter, sheetBg: cs.backgroundImage !== "none" ? cs.backgroundImage.slice(0, 120) : cs.backgroundColor };
          });
          await p.screenshot({ path: name("remote-sheet") });
          facts.push({ size, side, what: "remote-sheet", ...f });
        } else console.log(size, side, "remote: no More button");

        // 3. the sign-in sheet's sentence
        await go(h, "home");
        const ok = await p.evaluate(async () => {
          const src = [...document.querySelectorAll("script[type=module]")].map((s) => s.src).find(Boolean) || "";
          const q = src.includes("?") ? src.slice(src.indexOf("?")) : "";
          const m = await import("/js/claim.js" + q);
          m.showClaimModal({ suggestedUsername: "glass", hasPassword: true, name: "Glass" }, () => {});
          return true;
        }).catch((e) => String(e));
        await sleep(700);
        const cd = await p.evaluate(() => {
          const e = document.querySelector(".claim-dim");
          if (!e) return null;
          const c = getComputedStyle(e);
          return { bg: c.backgroundColor, bf: c.backdropFilter || c.webkitBackdropFilter, color: c.color };
        });
        await p.screenshot({ path: name("claim") });
        facts.push({ size, side, what: "claim-dim", opened: ok, ...cd });
        await h.ctx.close();
        console.log(size, side, "ok");
      }
    }
  } finally { await b.close(); }
  fs.writeFileSync(path.join(out, "facts.json"), JSON.stringify(facts, null, 1));
  for (const f of facts) console.log(JSON.stringify(f));
})().catch((e) => { console.error(e); process.exit(1); });
