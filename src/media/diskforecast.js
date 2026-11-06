// "About 40 days until full at this week's pace" (admin → Downloads, and the
// Disk line of the admin's summary). nufurora's disk is 512 GB; this says how
// long the space that is left lasts at the rate the library has been growing.
//
// Pace = the bytes that came INTO the library over the last 7 days: every
// finished download (data/downloads.json — status "done", doneAt, sizeBytes)
// and every finished "Add your own file" (data/uploads.json — status "done",
// finishedAt, size). Nothing is subtracted: deletions are not recorded
// anywhere cheap to read, so the pace is the honest upper bound (a download
// whose file was deleted again drops out by itself — the queue prunes a
// finished job whose file is gone).
//
// History: how far back the records go is the oldest job of either kind.
// Under a day of records says so instead of guessing; under 7 days uses what
// there is and says how many days that was. No growth is "no growth this
// week", never "infinite days".
//
// forecast() is pure (test/diskforecast.test.js); measure() reads the queues.
"use strict";

const DAY = 86400e3;
const GB = 1024 ** 3;
const WINDOW_DAYS = 7;

const fmtGb = (b) => (b >= 100 * GB ? `${Math.round(b / GB)} GB` : b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.max(0, Math.round(b / 1024 ** 2))} MB`);

// "about 40 days" / "about 3 months" / "more than 2 years" / "less than a day"
const howLong = (days) => {
  if (days < 1) return "less than a day";
  if (days < 1.5) return "about a day";
  if (days < 90) return `about ${Math.round(days)} days`;
  if (days < 730) return `about ${Math.round(days / 30.4)} months`;
  return "more than 2 years";
};

// events: [{ at: ms, bytes }] — what landed in the library and when.
// historyStart: ms of the oldest record there is (null: none at all).
// → { state, line, short, detail, addedBytes, days, paceBytesPerDay, daysLeft, freeBytes }
//   state: "filling" | "flat" | "short-history" | "no-history" | "unmeasured"
//   line:  the sentence for the Downloads screen
//   short: the few words for the summary's Disk line ("" = say nothing there)
//   detail: the numbers behind it, for Details and Copy for Claude
const forecast = ({ freeBytes, events = [], historyStart = null, now = Date.now(), windowDays = WINDOW_DAYS } = {}) => {
  const base = { addedBytes: 0, days: 0, paceBytesPerDay: 0, daysLeft: null, freeBytes: freeBytes == null ? null : freeBytes };
  if (!(typeof freeBytes === "number" && freeBytes >= 0 && Number.isFinite(freeBytes))) {
    return { ...base, freeBytes: null, state: "unmeasured", line: "free space not measured, so no forecast", short: "", detail: "" };
  }
  const windowStart = now - windowDays * DAY;
  const first = events.reduce((m, e) => (e && e.at > 0 && (m == null || e.at < m) ? e.at : m), historyStart > 0 ? historyStart : null);
  if (first == null) {
    return { ...base, state: "no-history", line: "no downloads recorded yet, so no pace to forecast from", short: "", detail: `${fmtGb(freeBytes)} free; nothing has been downloaded or added yet.` };
  }
  const since = Math.max(windowStart, Math.min(first, now));
  const days = (now - since) / DAY;
  const addedBytes = events.reduce((n, e) => (e && e.at >= since && e.at <= now && e.bytes > 0 ? n + e.bytes : n), 0);
  const partial = days < windowDays - 1e-9;
  const whole = Math.max(1, Math.floor(days));
  const span = partial ? `the ${whole === 1 ? "day" : `${whole} days`} recorded so far` : `the last ${windowDays} days`;
  if (days < 1) {
    return { ...base, addedBytes, days, state: "short-history", line: "less than a day of downloads recorded — too early to forecast", short: "",
      detail: `${fmtGb(addedBytes)} added since the records start (under a day ago); ${fmtGb(freeBytes)} free.` };
  }
  if (addedBytes <= 0) {
    return { ...base, days, state: "flat", line: partial ? `no growth in ${span}` : "no growth this week — nothing new was added",
      short: partial ? "" : "no growth this week", detail: `Nothing was added in ${span}; ${fmtGb(freeBytes)} free.` };
  }
  const paceBytesPerDay = addedBytes / days;
  const daysLeft = freeBytes / paceBytesPerDay;
  const when = howLong(daysLeft);
  const pace = partial ? `the pace of ${span}` : "this week's pace";
  return {
    ...base, addedBytes, days, paceBytesPerDay, daysLeft, state: "filling",
    line: `${when} until full at ${pace}`,
    short: `${when} until full`,
    detail: `${fmtGb(addedBytes)} added in ${span} (about ${fmtGb(paceBytesPerDay)} a day); ${fmtGb(freeBytes)} free.${partial ? ` Only ${whole === 1 ? "1 day" : `${whole} days`} of download history so far.` : ""}`,
  };
};

const ms = (v) => (typeof v === "number" ? v : Date.parse(v) || 0);

// The records → { events, historyStart }. Pure: downloads are the raw jobs
// (media/downloads.js rawJobs), uploads the upload jobs (media/uploads.js).
const eventsFrom = ({ downloads = [], uploads = [] } = {}) => {
  const events = [];
  let historyStart = null;
  const seen = (t) => { if (t > 0 && (historyStart == null || t < historyStart)) historyStart = t; };
  for (const j of downloads) {
    if (!j) continue;
    seen(ms(j.at));
    if (j.status === "done" && j.sizeBytes > 0) {
      const t = ms(j.doneAt);
      if (t > 0) { events.push({ at: t, bytes: j.sizeBytes }); seen(t); }
    }
  }
  for (const u of uploads) {
    if (!u) continue;
    seen(ms(u.createdAt));
    const size = u.size != null ? u.size : (u.parts || []).reduce((n, p) => n + (p.size || 0), 0);
    if (u.status === "done" && size > 0) {
      const t = ms(u.finishedAt || u.updatedAt);
      if (t > 0) { events.push({ at: t, bytes: size }); seen(t); }
    }
  }
  return { events, historyStart };
};

// The forecast for `freeBytes` (the fullest library drive) from the live queues.
const measure = (freeBytes, now = Date.now()) => {
  let downloads = [];
  let uploads = [];
  try { downloads = require("./downloads").rawJobs(); } catch {}
  try { uploads = require("./uploads").list().jobs || []; } catch {}
  return forecast({ freeBytes, ...eventsFrom({ downloads, uploads }), now });
};

module.exports = { forecast, eventsFrom, measure, howLong, fmtGb, WINDOW_DAYS };
