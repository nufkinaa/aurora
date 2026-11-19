"use strict";
const { launch, openPage, go, sleep } = require("../glass-apple/lib");
const SEL = ".nav-items,.nav-logo,.nav-profile,.nav-gear,.nav-dl,.nav-remote,.hero-actions .btn:not(.btn-primary),.detail-actions .btn:not(.btn-primary),.player-bottom,.player-top > div,.player-top .pbtn,.upnext,.resume-card,.quality-pill,.party-pill";
(async () => {
  const b = await launch();
  for (const size of ["phone-390", "desktop"]) {
    const h = await openPage(b, { size });
    for (const route of ["home", "libfilm", "libshow", `#/play/${h.inst.lib.film1}`]) {
      await go(h, route);
      await sleep(route.startsWith("#/play") ? 4000 : 500);
      console.log(size, route, "\n" + await h.page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => { const c = getComputedStyle(e), p = getComputedStyle(e, "::before"); return [e.tagName + "." + String(e.className).slice(0, 40), e.offsetWidth + "x" + e.offsetHeight, c.position, c.overflow, c.borderTopLeftRadius, "before:" + p.content + "/" + p.display, c.backdropFilter.slice(0, 40)].join(" | "); }).join("\n"), SEL));
    }
    await h.ctx.close();
  }
  await b.close();
})();
