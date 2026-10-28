// The player on a phone, in both looks: its menus and its dock fit the screen.
//
// Found 2026-10-19 (docs/qa/player-options/REPORT.md, "Known, not changed"):
// in the classic (legacy) look at 390 px the Subtitles menu was 371 px wide
// and stood 17 px off the left edge, and the dock's last icon was cut off by
// the right edge. The glass look was right. This holds both looks at the two
// common phone widths (390 x 844, 375 x 667): every menu inside the screen
// with a margin on both sides, every visible dock button inside the screen.
//
// SHOTS=<folder>: also write a screenshot of each case there (the
// integration's before/after pictures).
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");

const ui = suite();
const SHOTS = process.env.SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
};
// FIT_LOG=<file>: the measurements, one JSON line per case (to compare two runs)
const log = (name, m) => { if (process.env.FIT_LOG) fs.appendFileSync(process.env.FIT_LOG, JSON.stringify({ name, ...m }) + "\n"); };

// Everything that is showing in the bottom dock, and the open menu.
const measure = (page) => page.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left * 10) / 10, right: Math.round(b.right * 10) / 10, width: Math.round(b.width * 10) / 10 }; };
  const shown = (el) => { const s = getComputedStyle(el); const b = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && b.width > 0 && b.height > 0; };
  const menu = document.querySelector(".player .menu");
  const dock = [...document.querySelectorAll(".player .player-controls .pbtn")].filter(shown);
  // what clips the dock: the nearest ancestor that hides overflow
  const clipOf = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX !== "visible" || s.overflow !== "visible") return r(p);
    }
    return { left: 0, right: innerWidth, width: innerWidth };
  };
  return {
    vw: document.documentElement.clientWidth,
    menu: menu ? r(menu) : null,
    dock: dock.map((b) => ({ label: b.getAttribute("aria-label") || b.className, ...r(b), clip: clipOf(b) })),
  };
});

for (const [name, viewport] of [["390", { width: 390, height: 844 }], ["375", { width: 375, height: 667 }]]) {
  for (const look of ["glass", "legacy"]) {
    ui.test(`phone ${name} px, ${look}: the Subtitles and Settings menus and the dock fit the screen`, { viewport }, async ({ page, srv, api, signIn, freshProfile, lib }) => {
      const me = await freshProfile();
      if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
      await signIn(me);
      await player.open(page, srv, lib.film1.id);
      await player.wake(page);
      let m = await measure(page);
      await shot(page, `${look}-${name}-dock`);
      log(`${look}-${name}-dock`, m);
      assert.ok(m.dock.length >= 3, `the dock is there: ${JSON.stringify(m.dock)}`);
      for (const b of m.dock) {
        const right = Math.min(m.vw, b.clip.right);
        const left = Math.max(0, b.clip.left);
        assert.ok(b.left >= left - 0.5 && b.right <= right + 0.5, `${b.label} is cut off: ${JSON.stringify(b)} (screen ${m.vw})`);
      }
      // a toast (here an Undo one, which takes taps) sits above the dock, not on it:
      // in the classic look it stood on the dock's second row — over Next episode
      // and Settings — and took their taps for six seconds (localplay.test.js)
      const t = await page.evaluate(async () => {
        const { toast } = await import("/js/ui.js");
        toast("Removed “Holiday Film”", "🗑", { label: "Undo", onClick() {} });
        const el = document.querySelector("#toasts .toast:last-child");
        await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {})));
        const r = el.getBoundingClientRect();
        const d = document.querySelector(".player .player-bottom").getBoundingClientRect();
        return { toast: { top: r.top, bottom: r.bottom }, dockTop: d.top };
      });
      await shot(page, `${look}-${name}-toast`);
      assert.ok(t.toast.bottom <= t.dockTop + 0.5, `the toast stands on the dock: ${JSON.stringify(t)}`);
      await player.wake(page);
      for (const label of ["Subtitles", "Settings"]) {
        await player.menu(page, label, { all: true });
        // the menu grows in (an animation): measure it where it comes to rest
        await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest(".player .menu")).map((a) => a.finished.catch(() => {}))));
        await page.waitForFunction(() => { const el = document.querySelector(".player .menu"); if (!el) return false; const w = el.getBoundingClientRect().width; const ok = window.__fitW === w; window.__fitW = w; return ok; }, null, { polling: 100 });
        m = await measure(page);
        await shot(page, `${look}-${name}-${label.toLowerCase()}-menu`);
        log(`${look}-${name}-${label.toLowerCase()}-menu`, m);
        assert.ok(m.menu, `the ${label} menu is open`);
        assert.ok(m.menu.left >= 4 && m.menu.right <= m.vw - 4, `the ${label} menu fits the screen with a margin: ${JSON.stringify(m.menu)} (screen ${m.vw})`);
        await page.keyboard.press("Escape");
        await page.waitForSelector(".player .menu", { state: "detached" });
      }
    });
  }
}

ui.run({ concurrency: 2 });
