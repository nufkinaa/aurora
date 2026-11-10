// The Calendar's month grid — the pure half (screens/calendar.js draws it).
// The server sends every day of the months a person can page through
// (src/media/calendar.js `grid`: { from, to, weekStart, weekdays, months,
// byDay }); this file turns one month of it into weeks of cells, says
// which day to pick first and where the keys go. No DOM.
//
// The TV and the phone app do the same with the same words
// (tv-native/src/calendar.ts: CAL_WORDS, KIND_COLORS, monthWeeks, firstPick,
// monthPick … — test/calendar-grid-parity.test.js keeps the two in step).

// The month view's own words (the server makes every other word on it).
export const CAL_WORDS = {
  month: "Month",
  list: "List",
  today: "Today",
  prev: "Previous month",
  next: "Next month",
  nextUp: "Next up",
  premiere: "Premiere",
  episode: "New episode",
  cinema: "In cinemas",
  home: "Out to stream or buy",
  have: "On the server",
};

// The legend under the grid: what a poster's coloured edge means.
export const KINDS = ["premiere", "episode", "cinema", "home"];

const DAY_MS = 86400000;
const keyMs = (key) => Date.parse(`${key}T00:00:00.000Z`);
export const addDays = (key, n) => new Date(keyMs(key) + n * DAY_MS).toISOString().slice(0, 10);
export const monthOf = (key) => key.slice(0, 7);
const weekday = (key) => new Date(keyMs(key)).getUTCDay(); // 0 Sunday

// The weeks (rows of seven day keys) that show month `mk` — four to six of
// them, as many as it needs — starting on the device's first day of the week.
export const monthWeeks = (mk, weekStart = 1) => {
  const first = `${mk}-01`;
  const lead = (weekday(first) - weekStart + 7) % 7;
  const start = addDays(first, -lead);
  const [y, m] = mk.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const rows = Math.ceil((lead + days) / 7);
  return Array.from({ length: rows }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)));
};

// One cell: { key, n, inMonth, past, today, items }
export const cellOf = (grid, key, mk, today) => {
  const d = (grid && grid.byDay && grid.byDay[key]) || null;
  return {
    key,
    n: Number(key.slice(8, 10)),
    inMonth: monthOf(key) === mk,
    past: key < today,
    today: key === today,
    items: (d && d.items) || [],
  };
};

export const monthKeys = (grid) => ((grid && grid.months) || []).map((m) => m.key);
export const monthInfo = (grid, mk) => ((grid && grid.months) || []).find((m) => m.key === mk) || null;

// The day to open on: today when it has something, else the next day that
// does (in this month or a later one), else today.
export const firstPick = (cal) => {
  const grid = cal && cal.grid;
  const today = cal && cal.today;
  if (!grid || !today) return null;
  const days = grid.byDay || {};
  if (days[today] && days[today].items.length) return today;
  const months = monthKeys(grid);
  const last = months.length ? (grid.months[months.length - 1].last || grid.to) : grid.to;
  for (let d = addDays(today, 1); d <= last; d = addDays(d, 1)) if (days[d] && days[d].items.length) return d;
  return today;
};

// The day to pick when the month changes to `to`: today in today's month
// (unless `keepDay`: PageUp / PageDown keep the day of the month), else the
// same day of the month as `pick` (the 31st: that month's last).
export const monthPick = (grid, pick, to, today, keepDay = false) => {
  if (to === monthOf(today) && !keepDay) return today;
  const info = monthInfo(grid, to);
  const lastN = Number(((info && info.last) || `${to}-28`).slice(8, 10));
  return `${to}-${String(Math.min(Number(pick.slice(8, 10)), lastN)).padStart(2, "0")}`;
};

// The colours of the kinds (the CSS's --k-*; the apps use the same).
export const KIND_COLORS = { premiere: "#ffd479", episode: "#8b7bff", cinema: "#ff9a7c", home: "#72d4f4", have: "#8cffbe" };
