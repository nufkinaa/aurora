// Nothing moved: every element's box with today's stylesheet ("before",
// GA_BEFORE_CSS) and with this worktree's, on the screens that carry the glass
// chrome. Real glass gives some surfaces `position: relative` (for the rim's
// ring) — this is the proof that no child was placed against something else.
//
//   node tools/real-glass/layout-same.js
"use strict";
const { launch, openPage, go, sleep } = require("../glass-apple/lib");
const { OPEN } = require("../glass-apple/targets");

const boxes = () => [...document.querySelectorAll("body *")].filter((e) => !e.closest("#rg-defs") && !e.closest("canvas")).map((e) => {
  const r = e.getBoundingClientRect();
  return [e.tagName + "." + String(e.className && e.className.baseVal != null ? e.className.baseVal : e.className).slice(0, 50), Math.round(r.left * 2) / 2, Math.round(r.top * 2) / 2, Math.round(r.width * 2) / 2, Math.round(r.height * 2) / 2];
});

// Every rim is its own surface's: the ring (::before) of each real-glass
// surface is as big as the surface. (A surface that is not placed would
// hand its ring to whatever is placed above it — at 721–1260 px the island's
// ring was the whole top bar's.)
const SCOPE = ".nav-items,.nav-logo,.nav-profile,.nav-gear,.nav-dl,.nav-remote,.hero-actions .btn:not(.btn-primary),.detail-actions .btn:not(.btn-primary),.player-bottom,.player-top > div,.player-top .pbtn,.upnext,.resume-card,.quality-pill,.party-pill" +
  // (the second pass: every glass pane in the page wears the ring too)
  ",.menu,.nav-menu,.dropdown,.suggest-list,.toast,.peek,.look-notice,.party-panel,.trailer-box,.search-box,.claim-modal,.pref-section,.pair-card,.request-sent,.dl-callout,.detail-rate,.season-island,.calg-panel,.calg-next,.wn-card,.hero-unmute,.hero-pick,.episode,.source-row-wrap,.taste-tile,.party-strip-item,.profile-tile,.cal-entry,.chip,.cat-pill,.season-pill,.source-filter,.picker-btn,.hero-kicker,.calg-arrow,.episode-wrap > .ep-action,.btn:not(.btn-primary),.modal,.login-card";
const rings = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetWidth > 0).flatMap((e) => (e.matches(".dl-row") ? ["::before", "::after"] : ["::before"]).map((which) => [e, which])).filter(([e, which]) => which === "::before" || e.matches(".dl-row")).map(([e, which]) => {
  const p = getComputedStyle(e, which);
  // (a pane's own pseudo-element that is not the ring: the download row's state stripe)
  if (e.matches(".dl-row") && which === "::before") return null;
  if (p.content === "none") return null;
  const pad = p.boxSizing === "border-box" ? 0 : 1;
  const w = parseFloat(p.width) + pad * (parseFloat(p.paddingLeft) + parseFloat(p.paddingRight)), h = parseFloat(p.height) + pad * (parseFloat(p.paddingTop) + parseFloat(p.paddingBottom));
  // (the ring fills the surface inside its border, if it has one)
  const ok = getComputedStyle(e).position !== "static" && Math.abs(w - e.offsetWidth) <= 2.5 && Math.abs(h - e.offsetHeight) <= 2.5;
  return ok ? null : `${e.tagName}.${String(e.className).slice(0, 40)} ${e.offsetWidth}x${e.offsetHeight} ring ${Math.round(w)}x${Math.round(h)} ${getComputedStyle(e).position}`;
}).filter(Boolean);

(async () => {
  const b = await launch();
  let bad = 0;
  try {
    for (const size of ["phone-390", "phone-320", "tablet-768", "tablet", "desktop-1280", "desktop"]) {
      const sides = {};
      for (const side of ["before", "after"]) {
        const h = await openPage(b, { size, side });
        sides[side] = {};
        const ROUTES = ["home", "libfilm", "libshow", "film", "downloads", `#/play/${h.inst.lib.film1}`, "settings", "movies", "#/calendar", "#/calendar?grid=1", "#/new", "search", "menu", "sheet", ...(size.startsWith("phone") ? ["more"] : [])];
        for (const route of ROUTES) {
          // (open things: the profile menu, a sheet, the phone's side menu, the search field with suggestions)
          if (route === "menu") { await go(h, "home"); await OPEN.profileMenu(h.page); await sleep(500); }
          else if (route === "sheet") { await go(h, "home"); await OPEN.sheet(h.page); await sleep(500); }
          else if (route === "more") { await go(h, "home"); await h.page.click(".nav-more"); await sleep(900); }
          else if (route === "search") { await go(h, "search"); await OPEN.suggest(h.page); await sleep(800); }
          else await go(h, route);
          if (route.startsWith("#/play")) {
            await h.page.waitForSelector(".player video", { timeout: 25000 });
            await h.page.evaluate(() => { const v = document.querySelector(".player video"); v.pause(); v.currentTime = 5; document.querySelector(".player").classList.remove("controls-hidden"); });
            await sleep(1500);
            await h.page.evaluate(() => document.querySelector(".player").classList.remove("controls-hidden"));
          }
          await sleep(600);
          sides[side][route] = await h.page.evaluate(boxes);
          if (side === "after") {
            // (the party pill is hidden until a party is on: shown for the check)
            const wrong = await h.page.evaluate(([f, sel]) => { document.querySelectorAll(".party-pill.hidden").forEach((n) => n.classList.remove("hidden")); return new Function("sel", `return (${f})(sel)`)(sel); }, [rings.toString(), SCOPE]);
            for (const w of wrong) { console.log("   RING NOT ITS SURFACE'S:", size, route, w); bad++; }
            await h.page.evaluate(() => document.querySelectorAll(".party-pill").forEach((n) => n.classList.add("hidden")));
          }
        }
        await h.ctx.close();
      }
      for (const route of Object.keys(sides.before)) {
        const A = sides.before[route], B = sides.after[route];
        let diff = 0;
        const n = Math.min(A.length, B.length);
        for (let i = 0; i < n; i++) {
          // (the same tag: classes change as pictures arrive)
          if (A[i][0].split(".")[0] !== B[i][0].split(".")[0]) { diff = -1; break; }
          if (A[i].slice(1).join() !== B[i].slice(1).join()) { if (diff < 6) console.log("   moved:", JSON.stringify(A[i]), "->", JSON.stringify(B[i].slice(1))); diff++; }
        }
        if (diff || A.length !== B.length) bad++;
        console.log(size, route, "elements", A.length, B.length, diff === -1 ? "DIFFERENT TREE" : `moved ${diff}`);
      }
    }
  } finally { await b.close(); }
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
