// What applies right now: the viewer's clock and calendar, plus the facts
// about their own viewing (facts.js). PURE.
//
// Weights: a plain everyday line is always in the draw (part of the day 3,
// any time 2), so the remark is not about the same habit every visit; the
// strong, timely things (a month away, 3 am, a holiday, a new episode) weigh
// more, the standing habits (a long list, harsh ratings) less. The picker
// damps a kind each time it is shown, so even a heavy one gives way.
"use strict";

// Where the weekend is Friday and Saturday (the week starts on Sunday).
const FRI_SAT = new Set(["Asia/Jerusalem", "Asia/Tel_Aviv", "Asia/Riyadh", "Asia/Kuwait", "Asia/Qatar",
  "Asia/Bahrain", "Asia/Baghdad", "Asia/Muscat", "Africa/Cairo", "Asia/Amman"]);
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// The viewer's clock from the request: `tzo` is the browser's
// getTimezoneOffset() (minutes; UTC+2 is -120), `tz` its IANA zone name (only
// for which days are the weekend). Neither says anything about the person.
const clockOf = (now, tzo, tz) => {
  const off = Number.isFinite(tzo) && Math.abs(tzo) <= 840 ? tzo : new Date(now).getTimezoneOffset();
  const local = new Date(now - off * 60000);
  const friSat = FRI_SAT.has(String(tz || ""));
  return {
    tzo: off,
    hour: local.getUTCHours(),
    weekday: local.getUTCDay(),
    month: local.getUTCMonth() + 1,
    date: local.getUTCDate(),
    weekend: friSat ? [5, 6] : [6, 0],
    weekStart: friSat ? 0 : 1,
    midweek: friSat ? 2 : 3,
  };
};

const partOfDay = (h) => (h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 23 ? "evening" : "night");

const holidayOf = (c) => {
  if (c.month === 1 && c.date === 1) return "new-year";
  if (c.month === 2 && c.date === 14) return "valentines";
  if (c.month === 4 && c.date === 1) return "april-first";
  if (c.month === 10 && c.date === 31) return "halloween";
  if (c.month === 12 && (c.date === 24 || c.date === 25)) return "christmas";
  if (c.month === 12 && c.date === 31) return "new-years-eve";
  return null;
};

const calendarKinds = (c) => {
  const out = [];
  const add = (kind, weight, fields) => out.push({ kind, weight, fields: fields || {} });
  const h = c.hour;
  const weekend = c.weekend.includes(c.weekday);
  const lastWeekendDay = c.weekend[1];
  add(`everyday-${partOfDay(h)}`, 3);
  add("everyday-any", 2);
  const holiday = holidayOf(c);
  if (holiday) add(holiday, 7);
  if (c.weekday === 5 && c.date === 13) add("friday-13", 6);
  if (h >= 2 && h < 5) add("now-3am", 7);
  if (!weekend) {
    if (h >= 6 && h < 10) add("workday-morning", 3);
    else if (h >= 12 && h < 14) add("lunch", 3);
    else if ((h >= 10 && h < 12) || (h >= 14 && h < 17)) add("work-hours", 3);
    if (c.weekday === c.weekStart && h >= 6) add("week-start", 3, { day: DAY_NAMES[c.weekday] });
    if (c.weekday === c.midweek && h >= 17) add("midweek", 2);
  } else if (h >= 7 && h < 12) add("weekend-morning", 3);
  if (c.weekday === 5 && h >= 17) add("friday-night", 5);
  if (c.weekday === 6 && h >= 11 && h < 18) add("saturday", 4);
  if (c.weekday === lastWeekendDay && h >= 17) add("weekend-ending", 4);
  return out;
};

const kidsKinds = (c) => {
  const h = c.hour;
  const out = [{ kind: "kids-any", weight: 2, fields: {} }];
  const part = h >= 20 || h < 5 ? "kids-late" : h < 12 ? "kids-morning" : h < 17 ? "kids-afternoon" : "kids-evening";
  out.push({ kind: part, weight: 3, fields: {} });
  if (c.weekend.includes(c.weekday) && h >= 6 && h < 20) out.push({ kind: "kids-weekend", weight: 2, fields: {} });
  if (holidayOf(c) && holidayOf(c) !== "april-first" && holidayOf(c) !== "valentines") out.push({ kind: "kids-holiday", weight: 4, fields: {} });
  return out;
};

// facts: see facts.js (every field optional). Returns [{ kind, weight, fields }].
const situationsFor = (facts, clock, { kids = false } = {}) => {
  if (kids) return kidsKinds(clock);
  const out = calendarKinds(clock);
  const f = facts || {};
  const add = (kind, weight, fields) => out.push({ kind, weight, fields: fields || {} });
  const DAY = 86400000;
  if (f.firstVisit) add("first-visit", 8);
  if (f.awayMs >= 28 * DAY) add("away-month", 10);
  else if (f.awayMs >= 7 * DAY) add("away-week", 9);
  if (f.lateLastNight && clock.hour >= 7) add("late-last-night", 6);
  if (f.justBack) add("just-back", 4);
  if (f.todayHours >= 3) add("heavy-today", 5, { n: f.todayHours });
  else if (f.yesterdayHours >= 4) add("heavy-yesterday", 5, { n: f.yesterdayHours });
  if (f.streak >= 5) add("streak", 4, { n: f.streak });
  if (f.newEpisode) add("new-episode", 6, { title: f.newEpisode });
  if (f.finishedSeries) add("finished-series", 6, { title: f.finishedSeries });
  if (f.leftShow) add("left-show", 4, { title: f.leftShow });
  if (f.oneShow) add("one-show", 3, { title: f.oneShow });
  if (f.rewatch) add("rewatch", 3, { title: f.rewatch.title, n: f.rewatch.n });
  if (f.browsingToday >= 3) add("browsing-nothing", 5);
  if (f.myList >= 20) add("mylist-grows", f.myList >= 50 ? 3 : 2, { n: f.myList });
  if (f.genre) add("genre-diet", 2, { genre: f.genre });
  if (f.phoneMostly) add("phone-mostly", 2);
  if (f.nightOwl && !(clock.hour >= 2 && clock.hour < 5)) add("night-owl", 2);
  if (f.sampler) add("sampler", 3);
  if (f.ratings === "harsh") add("harsh-ratings", 2);
  else if (f.ratings === "generous") add("generous-ratings", 2);
  if (f.unwatchedDownloads >= 3) add("downloads-unwatched", 3, { n: f.unwatchedDownloads });
  return out;
};

module.exports = { clockOf, situationsFor, partOfDay, holidayOf, DAY_NAMES };
