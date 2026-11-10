// The scenes the two looks are photographed in, side by side: the same data,
// the same scroll position, the same moment. Used by shoot.js.
//
// A scene: the size it is taken at, the page, what is staged on it (`stage`,
// run in order after the page has settled), which parts are cut out and
// enlarged (`crops`: selectors — each becomes one strip of the crop picture),
// and what a judge is asked to look at (`look` — never which side is which).
"use strict";
const { OPEN } = require("./targets");

const ga = (fn, ...args) => async (page) => { await page.evaluate(([f, a]) => window.__ga[f](...a), [fn, args]); };
const scrollTo = (y) => async (page) => { await page.evaluate((v) => window.scrollTo(0, v), y); };
const wait = (ms) => async (page) => { await page.waitForTimeout(ms); };

const PHONE_BAR = ".nav-items";
const PHONE_TOP = ".nav-gear, .nav-profile";
const ISLAND = ".nav";

const S = [];
const add = (s) => S.push(s);

// ---- phone 402 × 874 ------------------------------------------------------
add({ size: "phone", route: "home", title: "Home, at the top", worst: false,
  crops: [".nav-logo, .nav-gear, .nav-profile", PHONE_BAR, ".hero-actions"],
  look: "The floating buttons at the top, the two buttons on the picture, and the tab bar at the foot with the chosen tab." });
add({ size: "phone", route: "home", title: "Home, scrolled: bright posters pass under the tab bar", worst: true,
  stage: [ga("brightRow", PHONE_BAR, { frac: 0.5 })],
  crops: [PHONE_BAR],
  look: "The tab bar while white and cream posters are behind it: can every word and icon be read, the chosen one too? Does the bar still look like glass?" });
add({ size: "phone", route: "film", title: "A film's page", worst: false,
  crops: [".detail-actions", ".detail-rate", PHONE_BAR],
  look: "The buttons under the title, the rating strip, the tab bar." });
add({ size: "phone", route: "libshow", title: "A show's page, at the episodes", worst: false,
  stage: [scrollTo(520)],
  crops: [".season-island", ".episode:nth-of-type(1), .episode:nth-of-type(2)", PHONE_BAR],
  look: "The season bar, the episode rows, the tab bar over them." });
add({ size: "phone", route: "home", title: "The profile menu, open", worst: false,
  stage: [OPEN.profileMenu],
  crops: [".nav-menu"],
  look: "The menu as a pane of glass over the page: its edge, its depth, how its lines read." });
add({ size: "phone", route: "home", title: "A question sheet, open over bright posters", worst: true,
  stage: [ga("brightRow", PHONE_BAR, { frac: 0.2 }), OPEN.sheet],
  crops: [".look-notice"],
  look: "The sheet and its two buttons; the dimmed page behind it." });
add({ size: "phone", route: "search", title: "Search", worst: false,
  crops: [".search-box, .search-input, input[type='search']", ".chip, .cat-pill", PHONE_BAR],
  look: "The search field, the chips under it, the tab bar with Search chosen." });
add({ size: "phone", route: "settings", title: "Settings", worst: false,
  stage: [scrollTo(300)],
  crops: [".pref-section", PHONE_BAR],
  look: "The panes of settings lying on the sky, and the tab bar over them." });
add({ size: "phone", route: "home", title: "Worst case: a white page under the bars", worst: true,
  stage: [ga("backdrop", "white")],
  crops: [".nav-logo, .nav-gear, .nav-profile", PHONE_BAR],
  look: "Everything behind the glass is plain white. Words and icons on the top buttons and on the tab bar: readable?" });
add({ size: "phone", route: "home", title: "Worst case: white text passing under the bars", worst: true,
  stage: [ga("backdrop", "text")],
  crops: [".nav-logo, .nav-gear, .nav-profile", PHONE_BAR],
  look: "Lines of white text run behind the glass. Do the bar's own words stay apart from the words under them?" });
add({ size: "phone", route: "home", title: "A message (toast) over bright posters", worst: true,
  stage: [ga("brightRow", PHONE_BAR, { frac: 0.05 }), OPEN.toast, wait(350)],
  crops: [".toast", PHONE_BAR],
  look: "The message pill above the tab bar and the tab bar itself, both over bright pictures." });

// ---- tablet 1024 × 768 ----------------------------------------------------
add({ size: "tablet", route: "home", title: "Home, at the top", worst: false,
  crops: [ISLAND, ".hero-actions"],
  look: "The bar across the top (logo, tabs, the round buttons) and the buttons on the picture." });
add({ size: "tablet", route: "home", title: "Home, scrolled: bright posters pass under the top bar", worst: true,
  stage: [ga("brightRow", ".nav-items", { frac: 0.35 })],
  crops: [ISLAND],
  look: "The top bar while white and cream posters are behind it: every word, the chosen tab, the round buttons." });
add({ size: "tablet", route: "libshow", title: "A show's page, at the episodes", worst: false,
  stage: [scrollTo(430)],
  crops: [ISLAND, ".season-island", ".episode:nth-of-type(1), .episode:nth-of-type(2)"],
  look: "The top bar, the season bar, the episode rows." });

// ---- desktop 1440 × 900 ---------------------------------------------------
add({ size: "desktop", route: "home", title: "Home, at the top", worst: false,
  crops: [ISLAND, ".hero-actions"],
  look: "The island of tabs in the middle of the top edge, the logo and the round buttons beside it, the buttons on the picture." });
add({ size: "desktop", route: "home", title: "Home, scrolled: bright posters pass under the island", worst: true,
  stage: [ga("brightRow", ".nav-items", { frac: 0.3 })],
  crops: [ISLAND],
  look: "The island and the buttons beside it while white and cream posters are behind them." });
add({ size: "desktop", route: "film", title: "A film's page", worst: false,
  crops: [ISLAND, ".detail-actions", ".detail-rate"],
  look: "The buttons under the title, the rating strip, the island over the picture." });
add({ size: "desktop", route: "home", title: "The profile menu, open over bright posters", worst: true,
  stage: [ga("brightRow", ".nav-items", { frac: 0.75 }), OPEN.profileMenu],
  crops: [".nav-menu", ISLAND],
  look: "The menu hanging from the top right corner over bright pictures: its edge, its depth, how its lines read." });
add({ size: "desktop", route: "home", title: "A question sheet, open", worst: false,
  stage: [OPEN.sheet],
  crops: [".look-notice"],
  look: "The sheet in the middle of the screen and its two buttons; the dimmed page behind it." });
add({ size: "desktop", route: "search", title: "Search, with suggestions open", worst: false,
  stage: [OPEN.suggest, wait(500)],
  crops: [".search-box, .suggest-list", ISLAND],
  look: "The search field and the list that drops from it; the island with Search chosen." });
add({ size: "desktop", route: "settings", title: "Worst case: Settings with the sky at its brightest", worst: true,
  stage: [ga("backdrop", "skybright", { keepContent: true })],
  crops: [ISLAND, ".pref-section"],
  look: "The sky behind everything is one bright green band. The island's words and the words on the panes of settings: readable?" });
add({ size: "desktop", route: "home", title: "Worst case: white text passing under the island", worst: true,
  stage: [ga("backdrop", "text")],
  crops: [ISLAND],
  look: "Lines of white text run behind the island. Do its own words stay apart from the words under them?" });
add({ size: "desktop", route: "movies", title: "Movies: the chips and the grid", worst: false,
  crops: [ISLAND, ".chip, .cat-pill, .source-filter, .picker-btn"],
  look: "The row of chips under the island, the chosen chip, the island with Movies chosen." });

// ---- desktop 2560 × 1440 --------------------------------------------------
add({ size: "desktop-2560", route: "home", title: "Home, at the top", worst: false,
  crops: [ISLAND, ".hero-actions"],
  look: "The island, logo and round buttons on a large screen; the buttons on the picture." });
add({ size: "desktop-2560", route: "home", title: "Home, scrolled: bright posters pass under the island", worst: true,
  stage: [ga("brightRow", ".nav-items", { frac: 0.3 })],
  crops: [ISLAND],
  look: "The island and the buttons beside it while white and cream posters are behind them." });
add({ size: "desktop-2560", route: "libshow", title: "A show's page, at the episodes", worst: false,
  stage: [scrollTo(700)],
  crops: [ISLAND, ".season-island", ".episode:nth-of-type(1), .episode:nth-of-type(2)"],
  look: "The island, the season bar, the episode rows on a large screen." });

// ---- the player (it takes the same material: the dock, the top buttons) ----
// A library film from the fixture, held on one frame with the controls up.
const playerHeld = async (page) => {
  await page.waitForSelector(".player video", { timeout: 25000 });
  await page.evaluate(async () => {
    const v = document.querySelector(".player video");
    const once = (ev, ms) => new Promise((res) => { v.addEventListener(ev, res, { once: true }); setTimeout(res, ms); });
    if (v.readyState < 2) await once("loadeddata", 10000);
    v.pause();
    v.currentTime = 4;
    await once("seeked", 6000);
    v.pause();
  });
  await page.mouse.move(640, 420);
  await page.mouse.move(660, 440);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const p = document.querySelector(".player");
    p.classList.remove("controls-hidden");
    // the clock of the wall, the spinner: nothing that differs between two takes
    document.querySelectorAll(".player > .spinner").forEach((n) => n.classList.add("hidden"));
  });
};
add({ size: "desktop", route: (inst) => `#/play/${inst.lib.film1}`, routeName: "play", title: "The player, paused, its controls showing", worst: false,
  stage: [playerHeld],
  crops: [".player-top", ".player-bottom"],
  look: "The dock of controls at the foot and the buttons at the top, over the film." });

// ---- the Remote screen (remote.css; a simulated TV is on: `tv`) -------------
// shoot.js keeps a SimTV (test/ui/support/sim-tv.js) on the instance for
// these and takes it off again for every other scene (a TV that is on puts a
// Remote button in the bar).
const remoteView = (view, mode) => async (page) => {
  await page.waitForSelector(".remote-screen", { timeout: 20000 });
  await page.waitForSelector('.remote-screen[data-state="playing"]', { timeout: 20000 });
  await page.locator(`.rm-seg-btn[data-view="${view}"]`).click();
  if (mode) await page.locator(`.rm-seg-btn[data-mode="${mode}"]`).click();
  await page.waitForTimeout(1200);
};
add({ size: "phone", route: "#/remote", routeName: "remote", tv: "playing", title: "The remote, a film paused on the TV", worst: false,
  stage: [remoteView("now")],
  crops: [".rm-top", ".rm-transport, .rm-chips", ".rm-dock"],
  look: "The round buttons, the row of pills under them, the TV's name at the top and the dock at the foot, over the film's own colours." });
add({ size: "phone", route: "#/remote", routeName: "remote", tv: "playing", title: "The remote, the touchpad", worst: false,
  stage: [remoteView("pad", "touch")],
  crops: [".rm-padmode", ".rm-touch", ".rm-keys, .rm-dock"],
  look: "The large pad, the three keys under it, the dock." });
add({ size: "phone", route: "#/remote", routeName: "remote", tv: "playing", title: "The remote, the arrow buttons", worst: false,
  stage: [remoteView("pad", "buttons")],
  crops: [".rm-padmode", ".rm-dpad", ".rm-keys, .rm-dock"],
  look: "The round pad with OK in its middle, the three keys, the dock." });

S.forEach((s, i) => { s.n = i + 1; });
module.exports = { SCENES: S };
