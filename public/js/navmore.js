// The phone tab bar's "More" (2026-11-06, elia: "do we have a way to reach
// all screens on smaller phone screens where the navbar is smaller?").
//
// On a phone the bar holds Home, Movies, Shows, My List, More and Search;
// AI, New and Saved no longer fit beside them at 320–430 px (on a 320 px
// phone with AI and Saved on, Search fell off the end of the bar). Every
// other place is one tap away in this sheet, rising over the bar from More.
// The set, the order and the words are the Android phone app's
// (docs/android-phone/NAV.md; the website's map: docs/web-nav.md).
// The tab itself is in index.html; desktop and tablet never show it.
import { el, $ } from "./ui.js";
import { navigate } from "./router.js";
import { pushScope, popScope } from "./focus.js";

// Line icons in the remote button's style (24 grid, stroke 1.8, round).
const ico = (paths) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
  new: ico('<path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z"/><path d="M18.5 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>'),
  saved: ico('<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M12 7.5v6.5M9.3 11.4 12 14l2.7-2.6M10.5 18.5h3"/>'),
  downloads: ico('<path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 16v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V16"/>'),
  remote: ico('<rect x="7" y="2.5" width="10" height="19" rx="3"/><circle cx="12" cy="8" r="2"/><path d="M10 13h.01M14 13h.01M10 16.5h.01M14 16.5h.01"/>'),
  household: ico('<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="16.8" cy="9.5" r="2.4"/><path d="M15.6 14.7c2.4-.3 4.4 1.3 4.9 4.3"/>'),
  wrapped: ico('<rect x="3.5" y="8.5" width="17" height="12" rx="2"/><path d="M12 8.5v12M3.5 12.5h17"/><path d="M12 8.5c-1.5-3.6-5.5-4.2-5.5-1.6 0 1.6 2.9 1.6 5.5 1.6zM12 8.5c1.5-3.6 5.5-4.2 5.5-1.6 0 1.6-2.9 1.6-5.5 1.6z"/>'),
  taste: ico('<rect x="4" y="5" width="11" height="15" rx="2" transform="rotate(-8 9.5 12.5)"/><path d="M15.5 6.2l2.6.5a2 2 0 0 1 1.6 2.3l-1.8 9.5a2 2 0 0 1-2.3 1.6l-1.2-.2"/>'),
  pick: ico('<path d="M9.5 4.5l1.3 3.7 3.7 1.3-3.7 1.3-1.3 3.7-1.3-3.7-3.7-1.3 3.7-1.3z"/><path d="M16.5 12.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/>'),
  settings: ico('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>'),
  apps: ico('<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><path d="M17 13.5v7M13.5 17h7"/>'),
  pair: ico('<rect x="2.5" y="4.5" width="19" height="12" rx="2"/><path d="M8 20.5h8M12 16.5v4"/><path d="M8.5 10.5h7M12.8 8l2.7 2.5-2.7 2.5"/>'),
  party: ico('<circle cx="8" cy="9" r="2.6"/><circle cx="16" cy="9" r="2.6"/><path d="M3 19c.5-2.8 2.5-4.4 5-4.4 1.6 0 3 .6 4 1.8 1-1.2 2.4-1.8 4-1.8 2.5 0 4.5 1.6 5 4.4"/>'),
  report: ico('<path d="M5 21V4.5M5 4.5h11l-2 4 2 4H5"/>'),
};

// [id, words, where it goes, icon]. The places, in the order of NAV.md; then,
// under a hairline, the three things that are not pages. AI pick is listed
// only when the server has AI (the AI tab's own rule).
export const MORE_PLACES = [
  ["new", "What's new", "#/new", ICON.new],
  ["saved", "Saved on this device", "#/saved", ICON.saved],
  ["downloads", "My downloads", "#/downloads", ICON.downloads],
  ["remote", "Your TVs", "#/remote", ICON.remote],
  ["household", "Recommended by your household", "#/household", ICON.household],
  ["wrapped", "Your Aurora Wrapped", "#/wrapped", ICON.wrapped],
  ["taste", "Swipe your taste", "#/taste", ICON.taste],
  ["pick", "AI pick", "#/pick", ICON.pick],
  ["settings", "Settings", "#/preferences", ICON.settings],
  ["apps", "Get the apps", "/install", ICON.apps],
];
export const MORE_ACTIONS = [
  ["pair", "Sign in a TV", "#/pair", ICON.pair],
  ["party", "Join a watch party", "aurora-join-party", ICON.party],
  ["report", "Report a problem", "aurora-report", ICON.report],
];
// each line's data-ui id, written out (the controls contract reads literals)
const TAG = { new: "more.new", saved: "more.saved", downloads: "more.downloads", remote: "more.remote", household: "more.household", wrapped: "more.wrapped", taste: "more.taste", pick: "more.pick", settings: "more.settings", apps: "more.apps", pair: "more.pair", party: "more.party", report: "more.report" }; // data-ui
// the screens that light the More tab while they are open
const MORE_ROUTES = [...MORE_PLACES, ...MORE_ACTIONS].map(([, , to]) => to).filter((to) => to.startsWith("#/"));

const tab = () => document.getElementById("nav-more");
const aiOn = () => { const p = document.getElementById("nav-pick"); return !!p && !p.classList.contains("hidden"); };
const hasNew = () => !!document.getElementById("nav-new")?.classList.contains("has-new");

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

let open = null; // { wrap, sheet }

const row = ([id, words, to, icon], here) => {
  const sub = id === "remote" ? tvLine() : null;
  const attrs = {
    class: "nav-more-item focusable" + (to.startsWith("#/") && here.startsWith(to) ? " active" : "") + (sub ? " live" : ""),
    "data-ui": TAG[id],
    "data-more": id,
  };
  const body = [
    el("span", { class: "nav-more-icon", html: icon }),
    el("span", { class: "nav-more-text" },
      el("span", { class: "nav-more-label" }, words),
      sub ? el("span", { class: "nav-more-sub" }, sub) : null),
    id === "new" && hasNew() ? el("i", { class: "nav-more-dot", "aria-hidden": "true" }) : null,
  ];
  // Get the apps is its own page (/install), not a screen of the app
  if (to.startsWith("/")) return el("a", { ...attrs, href: to }, ...body);
  const go = to.startsWith("#/")
    ? () => navigate(to)
    // the join and report sheets (main.js listens)
    : () => document.dispatchEvent(new CustomEvent(to));
  return el("button", { ...attrs, type: "button", onclick: () => { close(); go(); } }, ...body);
};

const build = () => {
  const here = location.hash || "#/";
  const places = MORE_PLACES.filter(([id]) => id !== "pick" || aiOn()).map((p) => row(p, here));
  const actions = MORE_ACTIONS.map((a) => row(a, here));
  const list = el("div", { class: "nav-more-list" }, places, el("div", { class: "nav-more-rule", role: "separator" }), actions);
  const sheet = el("div", { class: "nav-more-sheet", role: "dialog", "aria-modal": "true", "aria-label": "More" }, list);
  const wrap = el("div", { class: "nav-more-wrap ui-overlay", onclick: (e) => e.target === wrap && close() }, sheet);
  // a list longer than the room scrolls: its bottom edge fades while there is more below
  const edge = () => sheet.classList.toggle("more-below", sheet.scrollTop + sheet.clientHeight < sheet.scrollHeight - 2);
  sheet.addEventListener("scroll", edge, { passive: true });
  return { wrap, sheet, edge };
};

// The sheet sits just above the bar, wherever the bar is (it rides the home
// indicator, a browser's own bar, the classic look's flat strip), and keeps
// clear of the top controls on a short screen.
const place = ({ sheet, edge }) => {
  const bar = document.querySelector(".nav-items");
  const top = bar ? bar.getBoundingClientRect().top : window.innerHeight;
  sheet.style.bottom = `${Math.max(0, window.innerHeight - top + 8)}px`;
  const chip = document.getElementById("nav-profile");
  const ceiling = chip ? Math.max(8, chip.getBoundingClientRect().bottom + 8) : 8;
  sheet.style.maxHeight = `${Math.max(160, top - 8 - ceiling)}px`;
  edge();
};

const onKey = (e) => { if (e.key === "Escape") close(); };
const onBack = (e) => { e.preventDefault(); close(); };
const onHash = () => close();
const onResize = () => { if (open) place(open); };

export const close = () => {
  if (!open) return;
  const { wrap } = open;
  open = null;
  document.removeEventListener("keydown", onKey);
  document.removeEventListener("ui-back", onBack);
  window.removeEventListener("hashchange", onHash);
  window.removeEventListener("resize", onResize);
  popScope(wrap);
  const t = tab();
  if (t) { t.classList.remove("open"); t.setAttribute("aria-expanded", "false"); }
  wrap.classList.add("leaving");
  setTimeout(() => wrap.remove(), 160);
};

export const openMore = () => {
  if (open) return;
  document.querySelector(".nav-menu-wrap")?.remove(); // one menu at a time
  open = build();
  document.body.append(open.wrap);
  place(open);
  const t = tab();
  if (t) { t.classList.add("open"); t.setAttribute("aria-expanded", "true"); }
  document.addEventListener("keydown", onKey);
  document.addEventListener("ui-back", onBack);
  window.addEventListener("hashchange", onHash);
  window.addEventListener("resize", onResize);
  pushScope(open.wrap);
  // the TV line: js/remote.js is up by now (main.js loads it at idle); the
  // row gains its line when the answer is in
  if (!remoteMod) {
    import("./remote.js").then((m) => {
      remoteMod = m;
      const line = tvLine();
      const text = open && open.sheet.querySelector('[data-more="remote"] .nav-more-text');
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
// More becomes three dots (its name stays "More"). Each step is a class on
// the bar (responsive.css / glass.css), tried in turn until nothing spills.
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
  const here = location.hash || "#/";
  t.classList.toggle("active", MORE_ROUTES.some((r) => here.startsWith(r)));
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

// (for tests: the open sheet, if any)
export const sheetNow = () => (open ? $(".nav-more-sheet") : null);
