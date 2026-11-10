// The Calendar (#/calendar): what is coming up, and what just came out, for
// everything in this person's My List, the shows they follow and the shows
// they watch. The server makes the calendar and every word on it
// (src/media/calendar.js); this screen lays it out. The TV and the phone app
// show the same (tv-native/src/screens/Calendar.tsx, phone/screens/Calendar.tsx,
// their words in tv-native/src/calendar.ts — keep the two in step).
//
// TWO VIEWS, a Month / List switch at the top (the choice stays on this device):
//
//   Month   a real month (2026-11-10, elia: "make it look really like a
//           calendar"): weekdays across the top from this device's first day
//           of the week, six weeks of days, today marked, the other months'
//           days quiet. A day with releases shows them — its posters fanned
//           out like a hand of cards (one poster filling the day on a phone),
//           a coloured edge for the kind (premiere / new episode / in cinemas /
//           out to stream), a mint tick for what the server has, "+2" for
//           more. Days gone by read as out (the posters a little faded).
//           Picking a day lists its releases in full beside the grid (under
//           it on a phone): the List view's rows, Play and Save & watch
//           included. Above: "Next up" — the next release and how far off it
//           is. Arrows move day to day, PageUp / PageDown change month, Enter
//           opens the day; a sideways swipe changes month on a phone.
//   List    the agenda: "Coming up" / "Recently out", day by day (for people
//           who prefer it, and for screen readers). An older server, without
//           the month grid in its answer, gets this view only.
//
// A card opens the title. "Play" plays what the server has; "Save & watch"
// asks for the best copy of what it has not (the title page's own pick and
// request, POST …/calendar/save) — only ever on a press.
import { el, posterImg, toast, restoreScrollY, icons } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { openItem } from "../components.js";
import { navigate } from "../router.js";
import { track } from "../usage.js";
import { CAL_WORDS, KINDS, monthWeeks, cellOf, monthInfo, monthKeys, firstPick, monthOf, monthPick } from "../calgrid.js";

// The screen's own words (tv-native/src/calendar.ts has the same).
export const CALENDAR_TITLE = "Calendar";
const TABS = [["upcoming", "Coming up"], ["recent", "Recently out"]];
const VIEWS = [["month", CAL_WORDS.month], ["list", CAL_WORDS.list]];
const SAVE_WORD = "Save & watch";
const SAVING_WORD = "Saving…";
const PLAY_WORD = "Play";
const FAILED_LINE = "Couldn't load the calendar right now.";
const RETRY_WORD = "Try again";
const SAVE_FAILED = "Couldn't ask for that download right now.";
const BADGES = { have: "On the server", saving: "Saving", waiting: "Waiting for approval" };

const VIEW_KEY = "aurora-cal-view";
// a day narrower than this shows one poster filling it, not a fan of three
const FAN_MIN_CELL = 76;

// kept for the session: Back from a title lands on the same view, tab, month and day
let lastTab = null;
let lastY = 0;
let lastMonth = null;
let lastPick = null;

const readView = () => {
  try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "month"; } catch { return "month"; }
};
const keepView = (v) => {
  try { localStorage.setItem(VIEW_KEY, v); } catch {}
};
const hoverPointer = () => {
  try { return matchMedia("(hover: hover)").matches; } catch { return false; }
};
const reducedMotion = () => {
  try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

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
const timeZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
};
const posterOf = (e) => e.poster || (e.item && e.item.cover) || null;

// the small marks on a poster: a tick for what the server has, an arrow for
// what it is saving, a clock for what waits for the admin
const STATE_MARK = {
  have: icons.check,
  partial: icons.check,
  saving: icons.download,
  waiting: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.6 3.4 2-1 1.7L11 13.4V6h2z"/></svg>',
};

export const renderCalendar = async (root) => {
  const screen = el("div", { class: "screen calendar" });
  root.append(screen);
  if (!state.profile) { navigate("#/"); return; }
  const pid = state.profile.id;
  track("feat", { f: "calendar" });

  let view = readView();
  const switcher = el("div", { class: "hh-tabs cal-views" });
  const tabs = el("div", { class: "filter-bar hh-tabs cal-tabs" }); // (the segmented track of the household page)
  const note = el("div", { class: "cal-note", role: "status" });
  const body = el("div", { class: "cal-body" });
  screen.append(el("div", { class: "browse-head cal-head" }, el("h1", {}, CALENDAR_TITLE), switcher), tabs, note, body);

  let cal = null;
  let month = null; // the month view's live parts, while it is on screen

  // ---------- the Month / List switch ----------
  const hasGrid = () => !!(cal && cal.grid && cal.grid.byDay && Array.isArray(cal.grid.months) && cal.grid.months.length);
  const paintSwitch = () => {
    // (an older server has no month grid: the list is all there is)
    switcher.hidden = !hasGrid();
    switcher.replaceChildren(el("div", { class: "hh-tabs-track", role: "tablist", "aria-label": CALENDAR_TITLE },
      ...VIEWS.map(([key, label]) => el("button", {
        "data-ui": "calendar.view",
        type: "button",
        role: "tab",
        "aria-selected": view === key ? "true" : "false",
        class: `chip focusable${view === key ? " on" : ""}`,
        onclick: () => {
          if (view === key) return;
          view = key;
          keepView(key);
          lastY = 0;
          paintSwitch();
          paintBody();
        },
      }, label))));
  };

  // ---------- the list view's tabs ----------
  const paintTabs = () => {
    tabs.hidden = view !== "list" && hasGrid();
    if (tabs.hidden) return;
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

  // ---------- one release, in full (both views) ----------
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
          const src = posterOf(e);
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

  // A Save & watch answer: the entry changes everywhere it is listed.
  const replaceEntry = (key, next) => {
    const map = (days) => days.map((d) => (d.items.some((i) => i.key === key) ? { ...d, items: d.items.map((i) => (i.key === key ? next(i) : i)) } : d));
    // (the grid's days are changed in place: the month view on screen reads them)
    let day = null;
    const byDay = cal.grid && cal.grid.byDay;
    if (byDay) {
      for (const [k, d] of Object.entries(byDay)) {
        if (d.items.some((i) => i.key === key)) { d.items = d.items.map((i) => (i.key === key ? next(i) : i)); day = k; }
      }
    }
    cal = { ...cal, upcoming: map(cal.upcoming), recent: map(cal.recent) };
    const entry = (day && cal.grid.byDay[day].items.find((i) => i.key === key))
      || [...cal.upcoming, ...cal.recent].flatMap((d) => d.items).find((i) => i.key === key);
    const node = body.querySelector(`.cal-entry[data-key="${CSS.escape(key)}"]`);
    if (node && entry) node.replaceWith(entryRow(entry));
    if (month && day) month.refreshDay(day);
  };

  // ---------- the list view ----------
  const paintList = () => {
    const days = (cal && cal[lastTab]) || [];
    const empty = emptyLine(cal, lastTab);
    if (empty) {
      body.replaceChildren(el("div", { class: "empty cal-empty" }, el("div", { class: "glyph" }, "🗓️"), empty));
      return;
    }
    body.replaceChildren(...days.map((d) => el("section", { class: "cal-day", "data-day": d.day },
      el("h2", { class: `cal-day-head${d.label === "Today" ? " today" : ""}` }, dayHeading(d)),
      el("div", { class: "cal-list" }, ...d.items.map(entryRow)))));
  };

  // ---------- the month view ----------
  const paintMonth = () => {
    const grid = cal.grid;
    const today = cal.today;
    const months = monthKeys(grid);
    let pick = lastPick && grid.byDay[lastPick] && months.includes(monthOf(lastPick)) ? lastPick : firstPick(cal);
    if (!months.includes(monthOf(pick))) pick = `${months.includes(monthOf(today)) ? monthOf(today) : months[0]}-01`;
    let shown = lastMonth && months.includes(lastMonth) ? lastMonth : monthOf(pick);
    if (monthOf(pick) !== shown) pick = shown === monthOf(today) ? today : `${shown}-01`;
    lastPick = pick;
    lastMonth = shown;
    let fan = true; // three posters a day, or one filling it (set from the grid's width)

    // the next release: a line that takes you to its day
    const nextUp = (() => {
      const n = cal.next;
      if (!n || !grid.byDay[n.day]) return null;
      const e = grid.byDay[n.day].items.find((i) => i.key === n.key) || null;
      const src = e && posterOf(e);
      return el("button", {
        "data-ui": "calendar.next",
        type: "button",
        class: `calg-next focusable k-${n.kind || "episode"}`,
        "aria-label": `${CAL_WORDS.nextUp}: ${n.title}, ${n.what}, ${n.when}`,
        onclick: () => pickDay(n.day, { focus: true }),
      },
        el("span", { class: "calg-next-pic" }, src ? posterImg(src, n.title, "calg-img", "calg-img-fallback", { w: 64, eager: true }) : null),
        el("span", { class: "calg-next-text" },
          el("span", { class: "calg-next-eyebrow" }, CAL_WORDS.nextUp),
          el("span", { class: "calg-next-line" },
            el("span", { class: "calg-next-title" }, n.title),
            el("span", { class: "calg-next-what" }, n.what))),
        el("span", { class: "calg-next-when" }, n.when));
    })();

    // the month's heading, its line and the arrows
    const monthName = el("span", { class: "calg-mname" });
    const yearName = el("span", { class: "calg-year" });
    const heading = el("h2", { class: "calg-month", id: "calg-month", "aria-live": "polite" }, monthName, " ", yearName);
    const line = el("p", { class: "calg-line" });
    const arrow = (dir) => el("button", {
      "data-ui": "calendar.month",
      type: "button",
      class: "calg-arrow focusable",
      "aria-label": dir < 0 ? CAL_WORDS.prev : CAL_WORDS.next,
      title: dir < 0 ? CAL_WORDS.prev : CAL_WORDS.next,
      html: dir < 0 ? icons.chevronLeft : icons.chevronRight,
      onclick: () => goMonth(dir),
    });
    const prev = arrow(-1);
    const next = arrow(1);
    const todayBtn = el("button", {
      "data-ui": "calendar.today",
      type: "button",
      class: "chip focusable calg-today",
      onclick: () => pickDay(today, { focus: false }),
    }, CAL_WORDS.today);
    const bar = el("div", { class: "calg-bar" }, heading, line, todayBtn, el("div", { class: "calg-nav" }, prev, next));

    // the weekdays, from this device's first day of the week
    const weekdays = el("div", { class: "calg-wk", role: "row" },
      ...grid.weekdays.map((w) => el("div", { class: "calg-wd", role: "columnheader", "aria-label": w.short },
        el("span", { class: "calg-wd-short", "aria-hidden": "true" }, w.short),
        el("span", { class: "calg-wd-narrow", "aria-hidden": "true" }, w.narrow))));
    const sheetHolder = el("div", { class: "calg-sheets" });
    const gridEl = el("div", { class: "calg-grid", role: "grid", "aria-labelledby": "calg-month" }, weekdays, sheetHolder);
    // nothing in the list at all: the empty month says how to fill it
    const blank = cal.counts.titles ? null : el("div", { class: "calg-blank" },
      el("div", { class: "calg-blank-card" }, el("div", { class: "calg-blank-icon", html: icons.plus }), el("p", {}, cal.empty.noTitles)));
    const legend = el("div", { class: "calg-legend", "aria-hidden": "true" },
      ...KINDS.map((k) => el("span", { class: `calg-key k-${k}` }, el("i"), CAL_WORDS[k])),
      el("span", { class: "calg-key calg-key-have" }, el("i", { html: icons.check }), CAL_WORDS.have));
    const panel = el("aside", { class: "calg-panel" });
    const main = el("div", { class: "calg-main" }, bar, el("div", { class: "calg-frame" }, gridEl, blank), legend);
    // (next up sits over the day's list beside the grid; above the grid when there is one column)
    const wrap = el("div", { class: "calg" }, nextUp, main, panel);
    body.replaceChildren(wrap);

    // ---- one day ----
    const ariaFor = (c) => {
      const d = grid.byDay[c.key];
      const head = d ? dayHeading(d) : c.key;
      return c.items.length ? `${head}: ${c.items.map((e) => `${e.title}, ${e.what}`).join("; ")}` : head;
    };
    const picture = (e) => {
      const src = posterOf(e);
      const mark = STATE_MARK[e.state];
      return el("span", { class: `calg-pic k-${e.kind}${e.state && e.state !== "none" ? ` s-${e.state}` : ""}` },
        src
          ? posterImg(src, e.title, "calg-img", "calg-img-fallback", { w: fan ? 64 : 80 })
          : el("span", { class: "calg-img-fallback" }, el("span", {}, e.title)),
        mark ? el("span", { class: "calg-st", html: mark }) : null);
    };
    const inRange = (key) => months.includes(monthOf(key));
    const dayButton = (c) => {
      const pics = c.items.slice(0, fan ? 3 : 1);
      const more = c.items.length - pics.length;
      const live = inRange(c.key);
      const cls = ["calg-day", c.inMonth ? "" : "other", c.past ? "past" : "", c.today ? "today" : "", c.items.length ? "has" : "", c.items.some((e) => e.kind === "premiere") ? "prem" : "",
        c.key === pick ? "sel" : "", live ? "focusable" : "off", `n${Math.min(pics.length, 3)}`].filter(Boolean).join(" ");
      return el("button", {
        type: "button",
        class: cls,
        "data-ui": "calendar.day",
        "data-day": c.key,
        tabindex: c.key === pick ? "0" : "-1",
        "aria-current": c.today ? "date" : null,
        "aria-label": ariaFor(c),
        disabled: live ? null : true,
        onclick: () => {
          if (c.key === pick && monthOf(c.key) === shown) { openDay(); return; }
          pickDay(c.key, { focus: false });
        },
      },
        el("span", { class: "calg-num" }, String(c.n)),
        pics.length ? el("span", { class: "calg-pics" }, ...pics.map(picture)) : null,
        more > 0 ? el("span", { class: "calg-more" }, `+${more}`) : null);
    };
    const cellFor = (key, i) => {
      // (the picked day is said on the cell: ARIA has no aria-selected for a button)
      const cell = el("div", { class: "calg-cell", role: "gridcell", "aria-selected": key === pick ? "true" : "false" }, dayButton(cellOf(grid, key, shown, today)));
      cell.style.setProperty("--i", String(i));
      return cell;
    };

    // ---- a month's weeks ----
    let sheet = null;
    // A new month under a mouse that has not moved: the site's hover-is-focus
    // (focus.js) would hand the focus to whichever day lands under it, away from
    // the day the keys just picked. Until the mouse moves, its "mouseover" on
    // the new days stops here.
    let still = false;
    const onMouseMove = (e) => { if (e.movementX || e.movementY) still = false; };
    const onMouseOver = (e) => { if (still && sheet && sheet.contains(e.target)) e.stopPropagation(); };
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseover", onMouseOver, true);
    const paintSheet = (anim) => {
      const weeks = monthWeeks(shown, grid.weekStart);
      const fresh = el("div", { class: `calg-sheet${fan ? " fan" : " fill"}` },
        ...weeks.map((w, r) => el("div", { class: "calg-row", role: "row" }, ...w.map((key, c) => cellFor(key, r + c)))));
      if (anim && !reducedMotion()) fresh.classList.add(anim);
      // (a new month under a mouse that has not moved: see `still` below)
      if (sheet) still = hoverPointer();
      if (sheet) sheet.replaceWith(fresh);
      else sheetHolder.append(fresh);
      sheet = fresh;
      const info = monthInfo(grid, shown);
      monthName.textContent = info ? info.month : shown;
      yearName.textContent = info ? info.year : "";
      line.textContent = (info && info.line) || (cal.counts.titles ? cal.empty.month || "" : "");
      line.classList.toggle("quiet", !(info && info.line));
      prev.disabled = months.indexOf(shown) <= 0;
      next.disabled = months.indexOf(shown) >= months.length - 1;
    };
    const buttonOf = (key) => sheet && sheet.querySelector(`.calg-day[data-day="${key}"]`);

    // ---- the picked day, in full ----
    const paintPanel = () => {
      const d = grid.byDay[pick] || { label: pick, date: null, items: [] };
      const head = el("h2", { class: `calg-panel-head${pick === today ? " today" : ""}` },
        el("span", { class: "calg-panel-label" }, d.label),
        d.date ? el("span", { class: "calg-panel-date" }, d.date) : null);
      panel.classList.toggle("past", pick < today);
      panel.replaceChildren(head, d.items.length
        ? el("div", { class: "cal-list" }, ...d.items.map(entryRow))
        : el("p", { class: "calg-panel-empty" }, (cal.counts.titles ? cal.empty.day : cal.empty.noTitles) || ""));
      if (!reducedMotion()) {
        panel.classList.remove("swap");
        void panel.offsetWidth; // (restart the short fade: one element, once per pick)
        panel.classList.add("swap");
      }
    };

    const pickDay = (key, { focus = false } = {}) => {
      if (!grid.byDay[key] || !inRange(key)) return;
      const to = monthOf(key);
      const was = pick;
      pick = key;
      lastPick = key;
      if (to !== shown) {
        const dir = to > shown ? "from-next" : "from-prev";
        shown = to;
        lastMonth = to;
        paintSheet(dir);
      } else {
        const a = buttonOf(was);
        if (a) { a.classList.remove("sel"); a.tabIndex = -1; if (a.parentElement) a.parentElement.setAttribute("aria-selected", "false"); }
        const b = buttonOf(key);
        if (b) { b.classList.add("sel"); b.tabIndex = 0; if (b.parentElement) b.parentElement.setAttribute("aria-selected", "true"); }
      }
      paintPanel();
      if (focus) {
        const b = buttonOf(key);
        if (b) b.focus({ preventScroll: true });
      }
    };
    const goMonth = (dir, keepDay = false) => {
      const i = months.indexOf(shown) + dir;
      if (i < 0 || i >= months.length) return;
      // the same day of the month there (the 31st: that month's last), today in today's month
      pickDay(monthPick(grid, pick, months[i], today, keepDay), { focus: false });
    };
    // Enter on the picked day: into its releases
    const openDay = () => {
      const first = panel.querySelector(".cal-open");
      if (!first) return;
      if (matchMedia("(max-width: 1099px)").matches) panel.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
      first.focus({ preventScroll: true });
    };

    // ---- the keyboard ----
    const KEY_STEP = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const onKey = (ev) => {
      const from = ev.target && ev.target.closest && ev.target.closest(".calg-day");
      if (!from || !sheet || !sheet.contains(from)) return;
      const at = from.dataset.day;
      if (ev.key in KEY_STEP) {
        // the six weeks on screen: an arrow off their edge leaves the grid
        // (a remote reaches the arrows above and the day's list beside)
        const cells = [...sheet.querySelectorAll(".calg-day")];
        const i = cells.indexOf(from);
        const step = KEY_STEP[ev.key];
        const j = i + step;
        const sameRow = Math.abs(step) !== 1 || Math.floor(j / 7) === Math.floor(i / 7);
        if (j < 0 || j >= cells.length || !sameRow) return;
        const key = cells[j].dataset.day;
        if (!inRange(key)) return;
        ev.preventDefault();
        pickDay(key, { focus: true });
      } else if (ev.key === "PageUp" || ev.key === "PageDown") {
        ev.preventDefault();
        if (at !== pick) pickDay(at);
        goMonth(ev.key === "PageUp" ? -1 : 1, true);
        const b = buttonOf(pick);
        if (b) b.focus({ preventScroll: true });
      } else if (ev.key === "Home" || ev.key === "End") {
        ev.preventDefault();
        const row = from.closest(".calg-row");
        const days = row ? [...row.querySelectorAll(".calg-day:not(.off)")] : [];
        const b = ev.key === "Home" ? days[0] : days[days.length - 1];
        if (b) pickDay(b.dataset.day, { focus: true });
      }
    };
    // the site's own arrow-key walker (focus.js) gives way inside the grid
    const onNavMove = (ev) => {
      const a = document.activeElement;
      if (!a || !a.classList || !a.classList.contains("calg-day") || !sheet || !sheet.contains(a)) return;
      const cells = [...sheet.querySelectorAll(".calg-day")];
      const i = cells.indexOf(a);
      const step = { left: -1, right: 1, up: -7, down: 7 }[ev.detail];
      const j = i + step;
      const sameRow = Math.abs(step) !== 1 || Math.floor(j / 7) === Math.floor(i / 7);
      if (j >= 0 && j < cells.length && sameRow && inRange(cells[j].dataset.day)) ev.preventDefault();
    };
    sheetHolder.addEventListener("keydown", onKey);
    document.addEventListener("nav-move", onNavMove);

    // ---- a sideways swipe on a phone ----
    let touch = null;
    gridEl.addEventListener("touchstart", (ev) => {
      const t = ev.touches[0];
      touch = ev.touches.length === 1 ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
    }, { passive: true });
    gridEl.addEventListener("touchend", (ev) => {
      if (!touch) return;
      const t = ev.changedTouches[0];
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      const quick = Date.now() - touch.at < 800;
      touch = null;
      if (quick && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.6) goMonth(dx < 0 ? 1 : -1);
    }, { passive: true });

    // ---- the grid's width: a fan of posters, or one filling the day ----
    const fanFits = () => {
      const w = sheetHolder.clientWidth || gridEl.clientWidth || window.innerWidth;
      return w / 7 >= FAN_MIN_CELL;
    };
    fan = fanFits();
    paintSheet(lastY ? null : "enter");
    paintPanel();
    let ro = null;
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(() => {
        const f = fanFits();
        if (f !== fan) { fan = f; paintSheet(null); }
      });
      ro.observe(sheetHolder);
    }

    month = {
      refreshDay: (key) => {
        const b = buttonOf(key);
        if (b) b.replaceWith(dayButton(cellOf(grid, key, shown, today)));
      },
      stop: () => {
        document.removeEventListener("nav-move", onNavMove);
        window.removeEventListener("mousemove", onMouseMove, true);
        window.removeEventListener("mouseover", onMouseOver, true);
        if (ro) ro.disconnect();
      },
    };
  };

  // ---------- painting ----------
  const stopMonth = () => {
    if (month) month.stop();
    month = null;
  };
  const paintBody = () => {
    note.textContent = (cal && cal.empty && cal.empty.pending) || "";
    note.hidden = !note.textContent;
    stopMonth();
    paintTabs();
    screen.classList.toggle("cal-month-view", view === "month" && hasGrid());
    if (view === "month" && hasGrid()) paintMonth();
    else paintList();
    if (lastY) restoreScrollY(lastY);
  };

  const failed = () => el("div", { class: "empty" }, el("div", { class: "glyph" }, "📡"), FAILED_LINE,
    el("div", { style: { marginTop: "14px" } }, el("button", { "data-ui": "calendar.retry", class: "btn small focusable", onclick: () => load() }, RETRY_WORD)));

  const load = async () => {
    stopMonth();
    body.replaceChildren(view === "month"
      ? el("div", { class: "calg-skel" }, el("div", { class: "calg-skel-bar skeleton" }), el("div", { class: "calg-skel-grid" }, ...Array.from({ length: 35 }, () => el("div", { class: "skeleton" }))))
      : el("div", { class: "cal-skel" }, ...Array.from({ length: 4 }, () => el("div", { class: "cal-skel-row skeleton" }))));
    paintSwitch();
    try {
      cal = await api.calendar(pid, locale(), timeZone());
    } catch {
      if (!screen.isConnected) return;
      cal = null;
      if (!lastTab) lastTab = "upcoming";
      paintSwitch();
      tabs.hidden = true;
      note.hidden = true;
      body.replaceChildren(failed());
      return;
    }
    if (!screen.isConnected) return;
    if (!lastTab) lastTab = firstTab(cal);
    paintSwitch();
    paintBody();
  };
  await load();
  return () => {
    lastY = window.scrollY || document.body.scrollTop || 0;
    stopMonth();
  };
};
