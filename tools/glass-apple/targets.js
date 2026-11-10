// The glass surfaces that carry words, and how each is brought up. Shared by
// the contrast measure (contrast.js) and the photographs (shoot.js).
"use strict";

// page-side openers ---------------------------------------------------------
const OPEN = {
  profileMenu: async (page) => {
    await page.evaluate(() => document.querySelector(".nav-profile").click());
    await page.waitForSelector(".nav-menu", { timeout: 8000 });
  },
  sheet: async (page) => {
    await page.evaluate(async () => {
      const m = await import("/js/ui.js");
      m.confirmSheet({ title: "Remove “Test Film One”?", text: "The copy on the server goes; your place in it is kept, and it can be downloaded again.", ok: "Remove", cancel: "Keep it" });
    });
    await page.waitForSelector(".look-notice", { timeout: 8000 });
  },
  toast: async (page) => {
    await page.evaluate(async () => {
      document.querySelectorAll(".toast").forEach((t) => t.remove());
      const m = await import("/js/ui.js");
      m.toast("Added to My List", "✅", { label: "Undo", onClick() {} });
    });
    await page.waitForSelector(".toast", { timeout: 8000 });
  },
  peek: async (page) => {
    await page.evaluate(() => {
      const c = [...document.querySelectorAll(".card")].find((n) => n.getBoundingClientRect().top > 0 && n.querySelector("img"));
      c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    });
    await page.waitForSelector(".peek", { timeout: 8000 });
  },
  suggest: async (page) => {
    const input = await page.waitForSelector(".search-box input, input.search-input, input[type='search']", { timeout: 8000 });
    await input.click();
    await input.type("te", { delay: 60 });
    await page.waitForSelector(".suggest-list", { timeout: 8000 }).catch(() => {});
  },
  pageDown: (y) => async (page) => { await page.evaluate((v) => scrollTo(0, v), y); },
};

const CHROME = ["white", "poster", "mid", "text", "skybright", "black"];
const OVER = ["white", "text", "skybright", "black"]; // what floats over a dimmed page
const SKY = ["sky", "skybright"]; // what lies in the page: only the sky is behind
const ART = ["art"]; // a button on a picture: the picture turned white

const T = [];
const add = (t) => T.push(t);
for (const size of ["phone", "phone-320"]) {
  add({ id: `tabbar.${size}`, name: `Tab bar (${size === "phone" ? "phone 402" : "phone 320"})`, size, route: "home", roots: ".nav-items .nav-item", kinds: CHROME });
}
add({ id: "topbuttons.phone", name: "Top buttons: settings (phone 402)", size: "phone", route: "home", roots: ".nav-gear", kinds: CHROME });
add({ id: "menu.phone", name: "Profile menu (phone 402)", size: "phone", route: "home", open: OPEN.profileMenu, roots: ".nav-menu", kinds: OVER });
add({ id: "sheet.phone", name: "Confirm sheet (phone 402)", size: "phone", route: "home", open: OPEN.sheet, roots: ".look-notice", kinds: OVER });
add({ id: "toast.phone", name: "Toast (phone 402)", size: "phone", route: "home", open: OPEN.toast, reopen: true, roots: ".toast", kinds: CHROME });
add({ id: "peek.phone", name: "Peek sheet (phone 402)", size: "phone", route: "home", open: OPEN.peek, roots: ".peek .peek-body", kinds: OVER });
add({ id: "herobtn.phone", name: "Details button on the hero (phone 402)", size: "phone", route: "home", roots: ".hero-actions .btn:not(.btn-primary)", kinds: ART });
add({ id: "titlebtn.phone", name: "Buttons on a title page (phone 402)", size: "phone", route: "film", roots: ".detail-actions .btn:not(.btn-primary), .detail-rate", kinds: ART });
add({ id: "settings.phone", name: "Settings panes (phone 402)", size: "phone", route: "settings", roots: ".pref-section", kinds: SKY, keepContent: true, max: 30 });
add({ id: "episodes.phone", name: "Episodes and the season bar (phone 402)", size: "phone", route: "libshow", open: OPEN.pageDown(520), roots: ".episode, .season-island", kinds: SKY, keepContent: true, max: 30 });
add({ id: "chips.phone", name: "Chips (phone 402)", size: "phone", route: "movies", roots: ".chip, .cat-pill, .source-filter, .picker-btn", kinds: SKY, keepContent: true, max: 30 });

for (const size of ["tablet", "desktop", "desktop-2560"]) {
  const n = { tablet: "tablet 1024", desktop: "desktop 1440", "desktop-2560": "desktop 2560" }[size];
  add({ id: `navisland.${size}`, name: `Nav island, logo, profile (${n})`, size, route: "home", roots: ".nav-items .nav-item, .nav-logo, .nav-profile, .nav-gear", kinds: CHROME });
}
add({ id: "menu.desktop", name: "Profile menu (desktop 1440)", size: "desktop", route: "home", open: OPEN.profileMenu, roots: ".nav-menu", kinds: OVER });
add({ id: "sheet.desktop", name: "Confirm sheet (desktop 1440)", size: "desktop", route: "home", open: OPEN.sheet, roots: ".look-notice", kinds: OVER });
add({ id: "toast.desktop", name: "Toast (desktop 1440)", size: "desktop", route: "home", open: OPEN.toast, reopen: true, roots: ".toast", kinds: CHROME });
add({ id: "peek.desktop", name: "Peek sheet (desktop 1440)", size: "desktop", route: "home", open: OPEN.peek, roots: ".peek .peek-body", kinds: OVER });
add({ id: "suggest.desktop", name: "Search suggestions (desktop 1440)", size: "desktop", route: "search", open: OPEN.suggest, roots: ".suggest-list, .search-box", kinds: SKY, keepContent: true });
add({ id: "herobtn.desktop", name: "Details button on the hero (desktop 1440)", size: "desktop", route: "home", roots: ".hero-actions .btn:not(.btn-primary)", kinds: ART });
add({ id: "titlebtn.desktop", name: "Buttons on a title page (desktop 1440)", size: "desktop", route: "film", roots: ".detail-actions .btn:not(.btn-primary), .detail-rate", kinds: ART });
add({ id: "settings.desktop", name: "Settings panes (desktop 1440)", size: "desktop", route: "settings", roots: ".pref-section", kinds: SKY, keepContent: true, max: 30 });
add({ id: "episodes.desktop", name: "Episodes and the season bar (desktop 1440)", size: "desktop", route: "libshow", open: OPEN.pageDown(420), roots: ".episode, .season-island", kinds: SKY, keepContent: true, max: 30 });
add({ id: "chips.desktop", name: "Chips (desktop 1440)", size: "desktop", route: "movies", roots: ".chip, .cat-pill, .source-filter, .picker-btn", kinds: SKY, keepContent: true, max: 30 });

module.exports = { TARGETS: T, OPEN };
