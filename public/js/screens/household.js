// "Show all recommended": every title the household recommended to this
// person — the same ranking as Home's row (how many people recommended it,
// then the newest), filtered by person — and, on the second tab, what this
// person recommended and what became of it. js/recommend.js has the words
// and the actions; the TV's screen is tv-native/src/screens/Household.tsx.
import { el, restoreScrollY } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { card } from "../components.js";
import { navigate } from "../router.js";
import { track } from "../usage.js";
import { ROW_TITLE, STATUS_WORDS } from "../recommend.js";

let lastTab = "for"; // "for" | "sent" — kept for the session
let lastFrom = null; // a person's id, or null for Everyone
let lastY = 0;

const EMPTY_FOR = "Nothing recommended to you yet. When someone in your household recommends a film or a show, it shows up here.";
const EMPTY_SENT = "You haven't recommended anything yet. Press Recommend on any film or show.";

export const renderHousehold = async (root, params = {}) => {
  // the address says the tab (#/household, #/household/sent): Back from a
  // title lands on the tab it was opened from
  const asked = params && params.tab === "sent" ? "sent" : "for";
  if (asked !== lastTab) { lastTab = asked; lastY = 0; lastFrom = null; }
  const screen = el("div", { class: "screen household" });
  root.append(screen);
  if (!state.profile) { navigate("#/"); return; }
  const pid = state.profile.id;
  track("feat", { f: "hhrec-all" });

  const count = el("span", { class: "count" });
  const tabs = el("div", { class: "filter-bar hh-tabs" });
  const filters = el("div", { class: "filter-bar hh-filters" });
  const body = el("div");
  screen.append(
    el("div", { class: "browse-head" }, el("h1", {}, ROW_TITLE), count),
    tabs,
    filters,
    body,
  );

  const tab = (id, label) =>
    el("button", {
      "data-ui": "household.tab",
      type: "button",
      role: "tab",
      "aria-selected": lastTab === id ? "true" : "false",
      class: `chip focusable${lastTab === id ? " on" : ""}`,
      onclick: () => {
        if (lastTab === id) return;
        lastTab = id;
        lastY = 0;
        try { history.replaceState(history.state, "", id === "sent" ? "#/household/sent" : "#/household"); } catch {}
        paint();
      },
    }, label);

  const empty = (text) => el("div", { class: "empty hh-empty" }, el("div", { class: "glyph" }, "📨"), text);
  const failed = () => el("div", { class: "empty" }, el("div", { class: "glyph" }, "📡"), "Couldn't load that right now.",
    el("div", { style: { marginTop: "14px" } }, el("button", { class: "btn small focusable", onclick: () => paint() }, "Try again")));

  let seenSent = false;
  const paint = async () => {
    tabs.replaceChildren(el("div", { class: "hh-tabs-track", role: "tablist", "aria-label": ROW_TITLE }, tab("for", "For you"), tab("sent", "You sent")));
    filters.replaceChildren();
    body.replaceChildren(el("div", { class: "grid" }, ...Array.from({ length: 6 }, () => el("div", { class: "grid-skel skeleton" }))));
    if (lastTab === "for") {
      let r = null;
      try { r = await api.household(pid, lastFrom); } catch { body.replaceChildren(failed()); return; }
      if (!screen.isConnected || lastTab !== "for") return;
      // looking at the page counts every recommendation as looked at
      if (!seenSent) { seenSent = true; api.householdSeen(pid).catch(() => {}); }
      const people = r.people || [];
      if (lastFrom && !people.some((p) => p.id === lastFrom)) lastFrom = null;
      // the count is what is shown: one person's, when the filter says so
      count.textContent = r.total ? String(lastFrom ? (r.items || []).length : r.total) : "";
      if (people.length > 1) {
        const chip = (id, label) => el("button", {
          "data-ui": "household.filter",
          type: "button",
          class: `chip focusable${lastFrom === id ? " on" : ""}`,
          "aria-pressed": lastFrom === id ? "true" : "false",
          onclick: () => { if (lastFrom !== id) { lastFrom = id; paint(); } },
        }, label);
        filters.replaceChildren(chip(null, "Everyone"), ...people.map((p) => chip(p.id, p.name)));
      }
      const items = r.items || [];
      if (!items.length) { body.replaceChildren(empty(EMPTY_FOR)); return; }
      body.replaceChildren(el("div", { class: "grid hh-grid" }, ...items.map((i) => card(i, { showKind: true }))));
    } else {
      let r = null;
      try { r = await api.householdSent(pid); } catch { body.replaceChildren(failed()); return; }
      if (!screen.isConnected || lastTab !== "sent") return;
      const items = r.items || [];
      count.textContent = items.length ? String(items.length) : "";
      if (!items.length) { body.replaceChildren(empty(EMPTY_SENT)); return; }
      body.replaceChildren(el("div", { class: "grid hh-sent" }, ...items.map((i) => {
        const { hh, ...cardItem } = i; // (not a recommendation TO this person: no "+")
        return el("div", { class: "hh-sent-item" },
          card(cardItem),
          el("div", { class: "hh-sent-title", "aria-hidden": "true" }, i.title || ""),
          el("ul", { class: "hh-sent-to", "aria-label": `${i.title}: who got it` },
            ...(hh.to || []).map((t) => el("li", { class: `hh-st ${t.status}` },
              el("span", { class: "hh-st-name", title: t.name }, t.name),
              el("span", { class: "hh-st-word" }, STATUS_WORDS[t.status] || STATUS_WORDS.sent)))));
      })));
    }
    if (lastY) restoreScrollY(lastY);
  };
  await paint();
  return () => { lastY = window.scrollY || document.body.scrollTop || 0; };
};
