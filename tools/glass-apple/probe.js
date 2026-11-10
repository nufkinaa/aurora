// What the page is made of, where the glass sits: node tools/glass-apple/probe.js <size> <route>
"use strict";
const { launch, openPage, go } = require("./lib");
(async () => {
  const [size = "phone", route = "home"] = process.argv.slice(2);
  const b = await launch();
  try {
    const h = await openPage(b, { size });
    await go(h, route);
    const out = await h.page.evaluate(async () => {
      const cs = (s) => { const e = document.querySelector(s); if (!e) return null; const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return { z: c.zIndex, pos: c.position, bg: c.backgroundImage.slice(0, 120), bf: c.backdropFilter, color: c.color, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }; };
      const sel = [".nav", ".nav-items", ".nav-item.active", ".nav-logo", ".nav-gear", ".nav-profile", "#glass-sky", ".hero", ".hero img", ".hero-actions .btn:not(.btn-primary)", ".detail-hero", ".detail-hero img", ".detail-actions .btn:not(.btn-primary)", ".row", ".card", ".card img", "#toasts", ".chip", ".cat-pill", ".pref-section", ".episode", ".season-island", ".detail-rate", ".search-box", ".season-pill"];
      const o = {};
      for (const s of sel) o[s] = cs(s);
      let same = null;
      try { const m = await import("/js/ui.js"); same = typeof m.toast; } catch (e) { same = "ERR " + e.message; }
      o.importUi = same;
      o.scrollH = document.documentElement.scrollHeight;
      o.rows = [...document.querySelectorAll(".row")].slice(0, 6).map((r) => { const q = r.getBoundingClientRect(); const c = r.querySelector(".card"); const cr = c ? c.getBoundingClientRect() : null; return [Math.round(q.top + scrollY), Math.round(q.height), cr ? Math.round(cr.top + scrollY) : null, cr ? Math.round(cr.height) : null, r.className]; });
      return o;
    });
    console.log(JSON.stringify(out, null, 1));
    await h.ctx.close();
  } finally { await b.close(); }
})();
