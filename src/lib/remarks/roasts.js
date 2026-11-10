// Wrapped's roast cards: rules over the wrapped stats (telemetry.wrappedFor +
// the route's genres and started/finished), each rule a kind of the bank with
// several takes. PURE apart from the memory object it is handed (the picker's
// shape), which is what makes the takes differ from one visit to the next.
"use strict";

const { pick } = require("./picker");
const { GENRE_WORD } = require("./facts");
const { DAY_NAMES } = require("./situations");

const fmtH = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
};
const dateWord = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-GB", { month: "long", day: "numeric", timeZone: "UTC" }) : null;
};

// [{ kind, fields }], the strongest first.
const rulesFor = (w, name, { kids = false } = {}) => {
  if (kids) return [{ kind: "roast-kids", fields: { n: w.plays || 0 } }];
  const out = [];
  const add = (kind, fields) => out.push({ kind, fields });
  const total = w.totalSec || 0;
  const top = (w.topTitles || [])[0];
  const topShare = top && total > 0 ? top.sec / total : 0;
  if (w.started >= 5 && w.finished > 0 && w.started > w.finished * 2) add("roast-commitment", { n: w.started, m: w.finished });
  else if (w.started >= 8 && w.finished === 0) add("roast-zero-finished", { n: w.started });
  if (w.latestFinish && w.latestFinish.hour >= 1 && w.latestFinish.hour <= 5) add("roast-late-finish", { hour: w.latestFinish.hour, title: w.latestFinish.title });
  if (w.lateNightSessions >= 5) add("roast-late-sessions", { n: w.lateNightSessions });
  if (w.biggestDay && w.biggestDay.sec >= 4 * 3600) add("roast-big-day", { date: dateWord(w.biggestDay.day), hours: fmtH(w.biggestDay.sec) });
  if (w.bestStreak >= 7) add("roast-streak", { n: w.bestStreak });
  if (topShare > 0.4) add("roast-top-share", { title: top.name, pct: Math.round(topShare * 100) });
  const g = (w.topGenres || [])[0];
  const gWord = g && GENRE_WORD[String(g.name).toLowerCase()];
  if (gWord && total > 0 && g.sec / total >= 0.5) add("roast-genre", { genre: gWord, pct: Math.min(100, Math.round((g.sec / total) * 100)) });
  if (w.byDevice && w.byDevice[0] && w.byDevice[0].name === "Mobile" && w.byDevice.length > 1) add("roast-phone", { name });
  if (w.distinctTitles <= 3 && w.plays >= 10) add("roast-variety", { n: w.plays, m: w.distinctTitles });
  if (w.longestSession && w.longestSession.watchedSec >= 3 * 3600) add("roast-longest", { hours: fmtH(w.longestSession.watchedSec), title: w.longestSession.title });
  if (w.plays >= 15 && Number.isInteger(w.topWeekday) && DAY_NAMES[w.topWeekday]) add("roast-weekday", { day: DAY_NAMES[w.topWeekday] });
  return out;
};

// Up to `max` roasts: the two strongest rules, then a varied pick of the rest;
// each rule says one of its takes, a different one from the last visits.
const roastsFrom = (w, name, memory, { kids = false, rng = Math.random, now = Date.now(), max = 4 } = {}) => {
  if (!w || w.empty) return [];
  let rules = rulesFor(w, name, { kids });
  if (rules.length > max) {
    const head = rules.slice(0, 2);
    const rest = rules.slice(2);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    rules = [...head, ...rest];
  }
  const out = [];
  for (const r of rules) {
    if (out.length >= max) break;
    const got = pick([{ kind: r.kind, weight: 1, fields: r.fields }], memory, { now, rng, hold: 0 });
    if (got) out.push(got.text);
  }
  if (!out.length && !kids) {
    const got = pick([{ kind: "roast-clean", weight: 1, fields: { name } }], memory, { now, rng, hold: 0 });
    if (got) out.push(got.text);
  }
  return out;
};

module.exports = { rulesFor, roastsFrom, fmtH };
