// "Has it really come out, and is there a good copy?" — for one film's title
// page, from what the server already knows: the source list (each copy read
// by media/releasekind.js) and the release dates TMDB gave media/
// availability.js (theatrical vs digital / physical / TV).
//
// The answer is one plain sentence, made HERE so the website and the TV app
// say exactly the same words (they print `line` and `note` as they are):
//
//   good          a real copy exists (anything but a pre-release copy, with
//                 people sharing it) — nothing is said, the page is as always
//   early-only    every copy anyone shares is a cinema recording / screener /
//                 HC: "Not out in good quality yet — only cinema recordings
//                 so far" — and the page offers no big download button
//   not-out       no copy at all, and TMDB says it is not out at home yet:
//                 "Not out to watch at home yet"
//   null          nothing worth saying (a show, no copies and no dates, …)
//
// `note` adds the dates when TMDB has them: "In cinemas since 3 Oct 2026",
// "Out to stream or buy from 14 Nov 2026", "Out to stream or buy since …".
"use strict";

const CINEMA = new Set(["cam", "telesync", "telecine"]);

const fmtDay = (t) => {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return null;
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${d.getUTCDate()} ${m} ${d.getUTCFullYear()}`;
};

// avail: { home, homeAt, theatricalAt } | null (availability.cached)
const datesNote = (avail, now) => {
  if (!avail) return null;
  const { homeAt, theatricalAt } = avail;
  if (homeAt && homeAt > now) return `Out to stream or buy from ${fmtDay(homeAt)}`;
  if (homeAt && homeAt <= now) return `Out to stream or buy since ${fmtDay(homeAt)}`;
  if (theatricalAt && theatricalAt > now) return `In cinemas from ${fmtDay(theatricalAt)}`;
  if (theatricalAt) return `In cinemas since ${fmtDay(theatricalAt)}`;
  return null;
};

// streams: the list as served (cam / prerelease / seeders per row)
// → { state, line, note } | null
const statusOf = ({ type = "movie", streams = [], avail = null, now = Date.now() } = {}) => {
  if (type !== "movie") return null;
  const list = Array.isArray(streams) ? streams : [];
  // only copies someone is sharing count — a dead torrent is not "a copy"
  const counted = list.some((s) => (s.seeders || 0) > 0) ? list.filter((s) => (s.seeders || 0) > 0) : list;
  const early = counted.filter((s) => s.cam || s.prerelease);
  const good = counted.length - early.length;
  const note = datesNote(avail, now);
  if (good > 0) return { state: "good", line: null, note: null };
  if (early.length > 0) {
    const cinemaOnly = early.every((s) => CINEMA.has(s.prerelease || "cam"));
    return {
      state: "early-only",
      line: cinemaOnly
        ? "Not out in good quality yet — only cinema recordings so far"
        : "Not out in good quality yet — only early copies so far",
      note,
    };
  }
  const notHome = avail && avail.home !== true && (avail.theatricalAt || avail.homeAt);
  if (notHome) return { state: "not-out", line: "Not out to watch at home yet", note };
  return null;
};

module.exports = { statusOf, _internals: { fmtDay, datesNote } };
