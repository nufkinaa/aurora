// The phone's side menu, opened by the tab bar's "More" (2026-11-06/09).
//
// elia: "do we have a way to reach all screens on smaller phone screens where
// the navbar is smaller?" — and then: "if the screen is too small on android
// or iPhone web we can do an hamburger menu like we have on tv (it can also
// look the same)". On a phone the bar holds Home, Movies, Shows, My List,
// More and Search (on a 320 px phone with AI and Saved on, Search had fallen
// off the end of it). More opens the TV's side menu (tv-native
// src/components/NavRail.tsx), made for a finger: it comes in from the left
// over the page, the Aurora mark and wordmark on top, the TV's places in the
// TV's order and words, then every other place a person reaches on the TV or
// the phone app, with Settings and the profile at the foot. Every line wears
// the phone app's icon for it (js/navicons.js; elia 2026-11-10: "on the side
// panel on web mobile put icons also"). The map: docs/web-nav.md.
// The tab itself is in index.html; desktop and tablet never show it.
import { el, $ } from "./ui.js";
import { navigate, hasRoute } from "./router.js";
import { pushScope, popScope } from "./focus.js";
import { navIcon, MIRRORED } from "./navicons.js";
import { state } from "./state.js";

// The menu, top to bottom: [id, words, where it goes, options]. To add a
// place, add a line (its id to TAG below, and its icon to js/navicons.js);
// `when` keeps a line out until it applies.
//   - the TV's rail, in its order and words: Search, Home, Movies, Shows,
//     My List, (Calendar), AI
//   - then, under a hairline, the places the TV and the phone app reach from
//     their Settings and menus (docs/android-phone/NAV.md's set and words)
//   - then the three things that are not pages
//   - at the foot, as on the TV: Settings, and you
export const MENU = [
  ["search", "Search", "#/search"],
  ["home", "Home", "#/", { exact: true }],
  ["movies", "Movies", "#/movies"],
  ["shows", "Shows", "#/shows"],
  ["list", "My List", "#/list"],
  // the release calendar (branch release-calendar): listed once the app has its screen
  ["calendar", "Calendar", "#/calendar", { when: () => hasRoute("#/calendar") }],
  // only when the server has AI (the AI tab's own rule)
  ["pick", "AI", "#/pick", { when: () => { const p = document.getElementById("nav-pick"); return !!p && !p.classList.contains("hidden"); } }],
  "rule",
  ["new", "What's new", "#/new"],
  // (not in children mode: no downloads there)
  ["saved", "Saved on this device", "#/saved", { when: () => !kidsNow() }],
  ["downloads", "My downloads", "#/downloads", { when: () => !kidsNow() }],
  ["remote", "Your TVs", "#/remote"],
  ["household", "Recommended by your household", "#/household"],
  ["wrapped", "Your Aurora Wrapped", "#/wrapped"],
  ["taste", "Swipe your taste", "#/taste"],
  ["apps", "Get the apps", "/install"],
  "rule",
  // the account's own switch (js/childmode.js); "Leave Children mode" while on
  ["children", "Children mode", "event:aurora-child-mode"],
  ["pair", "Sign in a TV", "#/pair", { when: () => !kidsNow() }],
  ["party", "Join a watch party", "event:aurora-join-party"],
  ["report", "Report a problem", "event:aurora-report"],
];
export const FOOT = [
  ["settings", "Settings", "#/preferences"],
  ["profile", "Profile", "profile"],
];
// each line's data-ui id, written out (the controls contract reads literals)
const TAG = { search: "more.search", home: "more.home", movies: "more.movies", shows: "more.shows", list: "more.list", calendar: "more.calendar", pick: "more.pick", new: "more.new", saved: "more.saved", downloads: "more.downloads", remote: "more.remote", household: "more.household", wrapped: "more.wrapped", taste: "more.taste", apps: "more.apps", pair: "more.pair", children: "more.children", party: "more.party", report: "more.report", settings: "more.settings", profile: "more.profile" }; // data-ui

// The screens More lights itself for: the menu's places the bar does not have.
const BAR = new Set(["search", "home", "movies", "shows", "list"]);
const MORE_ROUTES = [...MENU, ...FOOT].filter((m) => Array.isArray(m) && !BAR.has(m[0]) && m[2].startsWith("#/")).map((m) => m[2]);

const tab = () => document.getElementById("nav-more");
const kidsNow = () => !!(state.profile && state.profile.kids);
const hasNew = () => !!document.getElementById("nav-new")?.classList.contains("has-new");
const here = () => location.hash || "#/";
const isHere = (to, exact) => (exact ? here() === to || here() === "#" : here().startsWith(to));

// Which TVs are on (js/remote.js, loaded at idle by main.js): "Your TVs"
// says so, so a phone in the hand finds its TV at a glance.
let remoteMod = null;
const tvLine = () => {
  const list = (remoteMod && remoteMod.getDevices && remoteMod.getDevices()) || [];
  if (!list.length) return null;
  const playing = list.find((d) => d.state && d.state.now);
  if (list.length === 1) return `${list[0].name} · ${playing ? "playing" : "on"}`;
  return `${list.length} on${playing ? " · one playing" : ""}`;
};

let open = null; // { wrap, panel, list }

const row = ([id, words, to, opts = {}]) => {
  const on = to.startsWith("#/") && isHere(to, opts.exact);
  // [offline-look] "Saved on this device" says what is there or under way (js/offlineUi.js)
  const dev = id === "saved" && state.deviceLine ? state.deviceLine() : null;
  const sub = id === "remote" ? tvLine() : dev ? dev.text : null;
  const attrs = {
    class: "nav-more-item focusable" + (on ? " active" : "") + (sub && (!dev || dev.live) ? " live" : "") + (id === "profile" ? " nav-more-profile" : ""),
    "data-ui": TAG[id],
    "data-more": id,
    ...(on ? { "aria-current": "page" } : {}),
  };
  // the line's icon, in a column of its own so the words line up
  let lead = el("span", { class: "nav-more-icon" + (MIRRORED.has(id) ? " flip" : ""), "aria-hidden": "true", html: navIcon(id) });
  if (id === "profile") {
    // you, as the TV draws you: the avatar and your name on a pill
    const chip = document.getElementById("nav-avatar");
    // (the person's avatar is the line's picture; without one, the person glyph)
    if (chip) { lead = chip.cloneNode(true); lead.removeAttribute("id"); lead.setAttribute("aria-hidden", "true"); }
    words = (document.getElementById("nav-profile-name")?.textContent || "").trim() || words;
  }
  if (id === "children" && kidsNow()) words = "Leave Children mode";
  const body = [
    lead,
    el("span", { class: "nav-more-text" },
      el("span", { class: "nav-more-label" }, words),
      sub ? el("span", { class: "nav-more-sub" }, sub) : null),
    id === "new" && hasNew() ? el("i", { class: "nav-more-dot", "aria-hidden": "true" }) : null,
  ];
  // Get the apps is its own page (/install), not a screen of the app
  if (to.startsWith("/")) return el("a", { ...attrs, href: to }, ...body);
  const go = to.startsWith("#/")
    ? () => navigate(to)
    : to === "profile"
      // the profile menu (switch profile, sign out …), from the avatar's chip
      ? () => document.getElementById("nav-profile")?.click()
      // the join and report sheets (main.js listens)
      : () => document.dispatchEvent(new CustomEvent(to.slice(6)));
  return el("button", { ...attrs, type: "button", onclick: () => { close(); go(); } }, ...body);
};

const lines = (list) => {
  const out = [];
  for (const m of list) {
    if (m === "rule") {
      // (no hairline at the top, none twice)
      if (out.length && !out[out.length - 1].classList.contains("nav-more-rule")) out.push(el("div", { class: "nav-more-rule", role: "separator" }));
      continue;
    }
    if (m[3] && m[3].when && !m[3].when()) continue;
    out.push(row(m));
  }
  return out;
};

const build = () => {
  const logo = el("div", { class: "nav-more-logo", "aria-hidden": "true" }, el("span", { class: "logo-mark" }), el("span", { class: "nav-more-brand" }, "Aurora"));
  const list = el("div", { class: "nav-more-list" }, lines(MENU));
  const foot = el("div", { class: "nav-more-foot" }, lines(FOOT));
  const panel = el("nav", { class: "nav-more-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Menu" },
    el("div", { class: "nav-more-hues", "aria-hidden": "true" }), logo, list, foot);
  const wrap = el("div", { class: "nav-more-wrap ui-overlay", onclick: (e) => e.target === wrap && close() }, panel);
  // a list longer than the room scrolls: its bottom edge fades while there is more below
  const edge = () => list.classList.toggle("more-below", list.scrollTop + list.clientHeight < list.scrollHeight - 2);
  list.addEventListener("scroll", edge, { passive: true });
  // a finger can push the menu back out to the left, the way it came
  let x0 = null; let y0 = 0; let dx = 0;
  panel.addEventListener("touchstart", (e) => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = 0; }, { passive: true });
  panel.addEventListener("touchmove", (e) => {
    if (x0 == null) return;
    const t = e.touches[0];
    dx = t.clientX - x0;
    if (Math.abs(t.clientY - y0) > Math.abs(dx)) { x0 = null; panel.style.transform = ""; return; } // a scroll
    if (dx < 0) panel.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  panel.addEventListener("touchend", () => {
    if (x0 == null) return;
    x0 = null;
    if (dx < -60) close();
    else panel.style.transform = "";
  });
  return { wrap, panel, list, edge };
};

const onKey = (e) => { if (e.key === "Escape") close(); };
const onBack = (e) => { e.preventDefault(); close(); };
const onHash = () => close();

export const close = () => {
  if (!open) return;
  const { wrap } = open;
  open = null;
  document.removeEventListener("keydown", onKey);
  document.removeEventListener("ui-back", onBack);
  window.removeEventListener("hashchange", onHash);
  popScope(wrap);
  const t = tab();
  if (t) { t.classList.remove("open"); t.setAttribute("aria-expanded", "false"); }
  wrap.classList.add("leaving");
  setTimeout(() => wrap.remove(), 240);
};

export const openMore = () => {
  if (open) return;
  document.querySelector(".nav-menu-wrap")?.remove(); // one menu at a time
  open = build();
  document.body.append(open.wrap);
  open.edge();
  const t = tab();
  if (t) { t.classList.add("open"); t.setAttribute("aria-expanded", "true"); }
  document.addEventListener("keydown", onKey);
  document.addEventListener("ui-back", onBack);
  window.addEventListener("hashchange", onHash);
  pushScope(open.wrap);
  // the screen you are on, in view (the TV's rail starts on it too)
  open.list.querySelector(".nav-more-item.active")?.scrollIntoView({ block: "nearest" });
  // the TV line: js/remote.js is up by now (main.js loads it at idle); the
  // row gains its line when the answer is in
  if (!remoteMod) {
    import("./remote.js").then((m) => {
      remoteMod = m;
      const line = tvLine();
      const text = open && open.panel.querySelector('[data-more="remote"] .nav-more-text');
      if (line && text && !text.querySelector(".nav-more-sub")) {
        text.append(el("span", { class: "nav-more-sub" }, line));
        text.parentElement.classList.add("live");
      }
    }).catch(() => {});
  }
};

export const toggleMore = () => (open ? close() : openMore());

// ---------- the bar fits its words (NAV.md §1) ----------
// Measured, not guessed: the words at their size; if one does not fit, the
// items' side padding shrinks; then the words step down to 10.5 px; then
// More becomes the menu's three lines (its name stays "More"). Each step is
// a class on the bar (responsive.css / glass.css), tried in turn until
// nothing spills.
const FIT = ["fit-pad", "fit-small", "fit-dots"];
// Spills: the bar is wider than its room, or an item's words (or icon) run
// past its padding — the words themselves are measured, not the box, which
// a word can outgrow into its padding without the box saying so.
const spills = (bar) => {
  if (bar.scrollWidth > bar.clientWidth + 1) return true;
  const r = bar.getBoundingClientRect();
  for (const item of bar.children) {
    if (!item.offsetWidth) continue;
    const b = item.getBoundingClientRect();
    if (b.right > r.right + 1 || b.left < r.left - 1) return true;
    const cs = getComputedStyle(item);
    const room = item.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    let w = 0;
    for (const n of item.childNodes) {
      if (n.nodeType === 3) { const range = document.createRange(); range.selectNodeContents(n); w += range.getBoundingClientRect().width; }
      else if (n.nodeType === 1 && !n.classList.contains("nav-new-dot")) w += n.getBoundingClientRect().width;
    }
    if (w > room + 1) return true;
  }
  return false;
};
export const fitBar = () => {
  const bar = document.querySelector(".nav-items");
  const more = tab();
  // only where the bar is a phone's tab bar (More is shown)
  if (!bar || !more || !more.offsetWidth) { if (bar) bar.classList.remove(...FIT); return; }
  bar.classList.remove(...FIT);
  for (const step of FIT) {
    if (!spills(bar)) break;
    bar.classList.add(step);
  }
};

// The tab's own state: lit on a screen it leads to, a dot while there is
// news (the New tab's dot, which the bar no longer shows on a phone).
const paintTab = () => {
  const t = tab();
  if (!t) return;
  t.classList.toggle("active", MORE_ROUTES.some((r) => here().startsWith(r)));
  t.classList.toggle("has-new", hasNew());
};

let started = false;
export const initMore = () => {
  if (started) return;
  started = true;
  paintTab();
  fitBar();
  window.addEventListener("hashchange", () => setTimeout(paintTab, 0));
  const news = document.getElementById("nav-new");
  if (news && typeof MutationObserver !== "undefined") new MutationObserver(paintTab).observe(news, { attributes: true, attributeFilter: ["class"] });
  // a turn, a zoom, the look switched: fit again (once per frame at most)
  let queued = false;
  const refit = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fitBar(); }); };
  window.addEventListener("resize", refit, { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit).catch(() => {});
  if (typeof MutationObserver !== "undefined") new MutationObserver(refit).observe(document.documentElement, { attributes: true, attributeFilter: ["data-look"] });
};

// (for tests: the open menu, if any)
export const sheetNow = () => (open ? $(".nav-more-sheet") : null);
