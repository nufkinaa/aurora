// The Calendar (#/calendar): what is coming up, and what just came out, for
// everything in this person's My List, the shows they follow and the shows
// they watch. The server makes the calendar and every word on it
// (src/media/calendar.js); this screen lays it out. The TV and the phone app
// show the same (tv-native/src/screens/Calendar.tsx, phone/screens/Calendar.tsx,
// their words in tv-native/src/calendar.ts — keep the two in step).
//
// A card opens the title. "Play" plays what the server has; "Save & watch"
// asks for the best copy of what it has not (the title page's own pick and
// request, POST …/calendar/save) — only ever on a press.
import { el, posterImg, toast, restoreScrollY } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { openItem } from "../components.js";
import { navigate } from "../router.js";
import { track } from "../usage.js";

// The screen's own words (tv-native/src/calendar.ts has the same).
export const CALENDAR_TITLE = "Calendar";
const TABS = [["upcoming", "Coming up"], ["recent", "Recently out"]];
const SAVE_WORD = "Save & watch";
const SAVING_WORD = "Saving…";
const PLAY_WORD = "Play";
const FAILED_LINE = "Couldn't load the calendar right now.";
const RETRY_WORD = "Try again";
const SAVE_FAILED = "Couldn't ask for that download right now.";
const BADGES = { have: "On the server", saving: "Saving", waiting: "Waiting for approval" };

let lastTab = null; // kept for the session: Back from a title lands on the same tab
let lastY = 0;

const tabLabel = (cal, key, label) => {
  const n = cal ? cal.counts[key] : 0;
  return n > 0 ? `${label} · ${n}` : label;
};
const dayHeading = (d) => (d.date ? `${d.label} · ${d.date}` : d.label);
const emptyLine = (cal, tab) => {
  if (!cal || (cal[tab] || []).length) return null;
  return cal.counts.titles ? cal.empty[tab] : cal.empty.noTitles;
};
const firstTab = (cal) => (cal && !cal.upcoming.length && cal.recent.length ? "recent" : "upcoming");
const canPlay = (e) => !!e.play && (e.state === "have" || e.state === "partial");
const afterSave = (e, r) => {
  if (!r || !r.ok) return e;
  const st = r.state === "have" ? "have" : r.state === "waiting" ? "waiting" : "saving";
  return { ...e, state: st, badge: BADGES[st], canSave: false };
};
const locale = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().locale || navigator.language || "en-GB"; } catch { return "en-GB"; }
};

export const renderCalendar = async (root) => {
  const screen = el("div", { class: "screen calendar" });
  root.append(screen);
  if (!state.profile) { navigate("#/"); return; }
  const pid = state.profile.id;
  track("feat", { f: "calendar" });

  const tabs = el("div", { class: "filter-bar hh-tabs cal-tabs" }); // (the segmented track of the household page)
  const note = el("div", { class: "cal-note", role: "status" });
  const body = el("div", { class: "cal-body" });
  screen.append(el("div", { class: "browse-head" }, el("h1", {}, CALENDAR_TITLE)), tabs, note, body);

  let cal = null;

  const paintTabs = () => {
    tabs.replaceChildren(el("div", { class: "hh-tabs-track", role: "tablist", "aria-label": CALENDAR_TITLE },
      ...TABS.map(([key, label]) => el("button", {
        "data-ui": "calendar.tab",
        type: "button",
        role: "tab",
        "aria-selected": lastTab === key ? "true" : "false",
        class: `chip focusable${lastTab === key ? " on" : ""}`,
        onclick: () => {
          if (lastTab === key) return;
          lastTab = key;
          lastY = 0;
          paintTabs();
          paintBody();
        },
      }, tabLabel(cal, key, label)))));
  };

  const badge = (e) => (e.badge ? el("span", { class: `cal-badge ${e.state}` }, e.badge) : null);

  const saveButton = (e) => {
    const btn = el("button", {
      "data-ui": "calendar.save",
      type: "button",
      class: "btn small btn-primary focusable cal-save",
      onclick: async (ev) => {
        ev.stopPropagation();
        btn.disabled = true;
        btn.classList.add("busy");
        btn.textContent = SAVING_WORD;
        let r = null;
        try { r = await api.calendarSave(pid, e.save); } catch (err) {
          toast((err && err.message) || SAVE_FAILED, "⚠️");
        }
        if (r && r.line) toast(r.line, r.ok ? "⬇️" : "🔍");
        if (r && r.ok) {
          replaceEntry(e.key, (x) => afterSave(x, r));
          return;
        }
        if (!btn.isConnected) return;
        btn.disabled = false;
        btn.classList.remove("busy");
        btn.textContent = SAVE_WORD;
      },
    }, SAVE_WORD);
    return btn;
  };

  const entryRow = (e) => {
    const open = () => openItem(e.item);
    const actions = [];
    if (canPlay(e)) {
      actions.push(el("button", {
        "data-ui": "calendar.play",
        type: "button",
        class: "btn small btn-primary focusable cal-play",
        onclick: (ev) => { ev.stopPropagation(); navigate(`#/play/${encodeURIComponent(e.play.id)}`); },
      }, PLAY_WORD));
    }
    if (e.canSave) actions.push(saveButton(e));
    const label = [e.title, e.what, e.detail, e.badge].filter(Boolean).join(", ");
    return el("div", { class: `cal-entry kind-${e.kind}`, "data-key": e.key },
      el("button", {
        "data-ui": "calendar.open",
        type: "button",
        class: "cal-open focusable",
        "aria-label": label,
        onclick: open,
      },
        el("span", { class: "cal-poster" }, (() => {
          const src = e.poster || (e.item && e.item.cover);
          // no picture known: the title in the slot at once, not an empty box
          return src ? posterImg(src, e.title, "cal-poster-img", "cal-poster-fallback", { w: 160 }) : el("div", { class: "cal-poster-fallback" }, el("span", {}, e.title));
        })()),
        el("span", { class: "cal-text" },
          el("span", { class: "cal-title" }, e.title),
          el("span", { class: "cal-what" }, e.what),
          e.detail ? el("span", { class: "cal-detail" }, e.detail) : null,
          el("span", { class: "cal-meta" }, badge(e), e.why ? el("span", { class: "cal-why" }, e.why) : null))),
      actions.length ? el("div", { class: "cal-actions" }, ...actions) : null);
  };

  const replaceEntry = (key, next) => {
    const map = (days) => days.map((d) => (d.items.some((i) => i.key === key) ? { ...d, items: d.items.map((i) => (i.key === key ? next(i) : i)) } : d));
    cal = { ...cal, upcoming: map(cal.upcoming), recent: map(cal.recent) };
    const node = body.querySelector(`.cal-entry[data-key="${CSS.escape(key)}"]`);
    const entry = [...cal.upcoming, ...cal.recent].flatMap((d) => d.items).find((i) => i.key === key);
    if (node && entry) {
      const fresh = entryRow(entry);
      node.replaceWith(fresh);
    }
  };

  const paintBody = () => {
    note.textContent = (cal && cal.empty && cal.empty.pending) || "";
    note.hidden = !note.textContent;
    const days = (cal && cal[lastTab]) || [];
    const empty = emptyLine(cal, lastTab);
    if (empty) {
      body.replaceChildren(el("div", { class: "empty cal-empty" }, el("div", { class: "glyph" }, "🗓️"), empty));
      return;
    }
    body.replaceChildren(...days.map((d) => el("section", { class: "cal-day", "data-day": d.day },
      el("h2", { class: `cal-day-head${d.label === "Today" ? " today" : ""}` }, dayHeading(d)),
      el("div", { class: "cal-list" }, ...d.items.map(entryRow)))));
    if (lastY) restoreScrollY(lastY);
  };

  const failed = () => el("div", { class: "empty" }, el("div", { class: "glyph" }, "📡"), FAILED_LINE,
    el("div", { style: { marginTop: "14px" } }, el("button", { "data-ui": "calendar.retry", class: "btn small focusable", onclick: () => load() }, RETRY_WORD)));

  const load = async () => {
    body.replaceChildren(el("div", { class: "cal-skel" }, ...Array.from({ length: 4 }, () => el("div", { class: "cal-skel-row skeleton" }))));
    try {
      cal = await api.calendar(pid, locale());
    } catch {
      if (!screen.isConnected) return;
      cal = null;
      if (!lastTab) lastTab = "upcoming";
      paintTabs();
      note.hidden = true;
      body.replaceChildren(failed());
      return;
    }
    if (!screen.isConnected) return;
    if (!lastTab) lastTab = firstTab(cal);
    paintTabs();
    paintBody();
  };
  await load();
  return () => { lastY = window.scrollY || document.body.scrollTop || 0; };
};
