// OVERNIGHT: tomorrow's episodes, downloaded ahead and made playable at night
// (elia 2026-11-09: "Prepare tomorrow's episodes overnight … We can even pre
// download."). The rules are media/overnightplan.js; this file gathers the
// facts and does the work.
//
//   DOWNLOADS AHEAD   every hour, day and night: for each person who played a
//                     show in the last two weeks, the episodes they play next
//                     are made sure of (smartdl.ahead — smart downloads' own
//                     path, its per-person switch, the queue's "Next episode"
//                     and "Background" classes, the drives' placement and
//                     reserve, the disk gate). How many ahead follows the
//                     admin's setting and the disk forecast. Shows only.
//
//   THE NIGHT RUN     inside the quiet hours (default 02:00–07:00), once
//                     nobody has watched for ten minutes (presence, stream
//                     requests, viewer encodes — the 1.15.11 data): the plan
//                     is made — the next episodes of the shows people are in,
//                     the top of each person's Continue watching, what somebody
//                     asked for in the last three days and has not watched —
//                     and for each, the devices those people use (their own
//                     reports, media/avcaps.js, seen with their profile on the
//                     title reads; the whole house's when a person has none)
//                     decide whether anything is needed at all
//                     (overnightplan.needsOf). One conversion at a time
//                     (media/prepared.js), at the lowest priority, inside a
//                     disk budget (10% of the free space by default).
//                     Somebody starts watching: it is PAUSED within seconds,
//                     and goes on after three quiet minutes; paused half an
//                     hour, or the quiet hours over: stopped, tried again
//                     when it is quiet (the next night at the latest).
//
//   CLEAN-UP          hourly and with every plan: a prepared file whose title
//                     left the library or was replaced, that everyone it was
//                     made for has finished, or that nothing wanted or played
//                     for a week, goes; so does whatever the budget can no
//                     longer hold (what is not wanted any more first).
//
// The admin's line: "Overnight: 6 episodes prepared, 3 downloaded ahead ·
// next run 02:00" (Admin → Downloads → Overnight), with the switch, the hours
// and the budget behind its Details.
"use strict";
const path = require("path");
const config = require("../config");
const plan = require("./overnightplan");
const prepared = require("./prepared");
const lazy = require("../lib/lazy");
const profilesLib = lazy(require, "../profiles");
const scannerLib = lazy(require, "./scanner");
const identityLib = lazy(require, "./identity");
const discoverLib = lazy(require, "./discover");
const downloadsLib = lazy(require, "./downloads");
const smartdlLib = lazy(require, "./smartdl");
const avcapsLib = lazy(require, "./avcaps");
const playpathLib = lazy(require, "./playpath");
const settingsLib = lazy(require, "../lib/settings");
const cpuworkLib = lazy(require, "./cpuwork");

const DAY = 24 * 3600 * 1000;
const SAW_EVERY_MS = 3600 * 1000;
const DEVICES_PER_PERSON = 12;
const FAIL_AGAIN_MS = DAY; // a conversion that failed is not tried again for a day
const RUNS_KEPT = 14;

const timing = () => plan.timingOf(config.OVERNIGHT);

// Everything that touches the clock or the house: replaceable (the tests).
const deps = {
  now: () => Date.now(),
  busy: () => {
    let why = null;
    try {
      const rt = require("../realtime");
      for (const c of rt.clients.values()) if (rt.presenceOf(c) === "watching") { why = "someone is watching"; break; }
    } catch {}
    if (!why) {
      try {
        // a request for a file's bytes in the last minute is someone watching too (lib/inuse.js)
        const seen = require("../lib/inuse")._internals.seen;
        const t = Date.now();
        for (const at of seen.values()) if (t - at < 60 * 1000) { why = "a title is being streamed"; break; }
      } catch {}
    }
    if (!why) { try { if (cpuworkLib().viewer.busy()) why = "a viewer's stream is being converted"; } catch {} }
    return { busy: !!why, why };
  },
  setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
  clearInterval: (t) => clearInterval(t),
  gather: null, // (tests) what tomorrow needs, handed in — else gatherWants below
};

// ------------------------------------------------------------- what is kept
let state = null;
const theState = () => {
  if (state) return state;
  const { JsonStore } = require("../lib/jsonstore");
  state = new JsonStore(path.join(config.DATA_DIR, "overnight.json"), { devices: {}, ahead: [], runs: [] });
  for (const [k, v] of [["devices", {}], ["ahead", []], ["runs", []]]) {
    if (!state.data[k] || typeof state.data[k] !== typeof v || Array.isArray(state.data[k]) !== Array.isArray(v)) state.data[k] = v;
  }
  return state;
};

// ------------------------------------------------------------- settings
const settings = () => plan.settingsOf(settingsLib().data.overnight);
/** The admin's change → { ok, settings } | { error } */
const setSettings = (body = {}) => {
  const cur = settings();
  const next = { ...cur };
  if (Object.hasOwn(body, "on")) next.on = body.on !== false && body.on !== "false" && body.on !== 0;
  for (const k of ["from", "to"]) {
    if (!Object.hasOwn(body, k)) continue;
    const v = plan.hhmm(body[k]);
    if (!v) return { error: "The hours are written like 02:00." };
    next[k] = v;
  }
  if (next.from === next.to) return { error: "The quiet hours need a start and an end that differ." };
  if (Object.hasOwn(body, "budgetPct")) {
    const n = Number(body.budgetPct);
    if (!Number.isFinite(n) || n < plan.BUDGET_PCT.min || n > plan.BUDGET_PCT.max) return { error: `The disk budget is ${plan.BUDGET_PCT.min}–${plan.BUDGET_PCT.max}% of the free space.` };
    next.budgetPct = Math.round(n);
  }
  if (Object.hasOwn(body, "aheadEpisodes")) {
    const n = Number(body.aheadEpisodes);
    if (![0, 1, 2].includes(n)) return { error: "Downloaded ahead: none, the next episode, or the next two." };
    next.aheadEpisodes = n;
  }
  const clean = plan.settingsOf(next);
  settingsLib().data.overnight = clean;
  settingsLib().save();
  console.log(`[overnight] settings: ${clean.on ? "on" : "off"}, ${clean.from}–${clean.to}, budget ${clean.budgetPct}% of the free space, ${clean.aheadEpisodes} episode${clean.aheadEpisodes === 1 ? "" : "s"} ahead`);
  if (!clean.on && run.job) stopJob("turned off by the admin");
  return { ok: true, settings: clean };
};

// ------------------------------------------------------------- who uses which device
// A title read that names a profile and a device report (routes/avcaps.js
// decisionFor) says "this person plays on this device". Kept per person, a
// few devices each, written at most once an hour per pair.
const sawDevice = (profileId, capsId, now = deps.now()) => {
  try {
    if (!profileId || typeof capsId !== "string" || !/^[0-9a-f]{16}$/.test(capsId)) return;
    const pid = String(profileId).slice(0, 24);
    if (!profilesLib().list().some((p) => p.id === pid)) return;
    const all = theState().data.devices;
    const mine = all[pid] || (all[pid] = {});
    if (now - (mine[capsId] || 0) < SAW_EVERY_MS) return;
    mine[capsId] = now;
    const ids = Object.keys(mine);
    if (ids.length > DEVICES_PER_PERSON) {
      ids.sort((a, b) => mine[a] - mine[b]);
      for (const x of ids.slice(0, ids.length - DEVICES_PER_PERSON)) delete mine[x];
    }
    theState().save();
  } catch {}
};

/** The devices these people play on (seen in the last deviceDays) — the whole house's when none is known for them. */
const devicesFor = (persons, now = deps.now()) => {
  const since = now - timing().deviceDays * DAY;
  const out = new Map();
  const all = theState().data.devices;
  for (const p of persons || []) {
    for (const [id, at] of Object.entries(all[p] || {})) {
      if (at < since || out.has(id)) continue;
      const caps = avcapsLib().lookup(id);
      if (caps) out.set(id, { id, caps, own: true });
    }
  }
  if (!out.size) for (const r of avcapsLib().recent(since)) out.set(r.id, { id: r.id, caps: r.caps, own: false });
  return [...out.values()];
};

// ------------------------------------------------------------- what people watch
// One person's progress rows of the last `days`, each with the episode it is
// (smartdl.episodeOf — the same answer smart downloads use).
const progressRows = (pid, since) => {
  const P = profilesLib();
  const view = P.getProgressView(pid) || {};
  const streams = P.getStreamItems(pid) || {};
  const rows = [];
  for (const [itemId, r] of Object.entries(view)) {
    if (!r || (r.updatedAt || 0) < since) continue;
    let ep = null;
    try { ep = smartdlLib().episodeOf(itemId, streams[itemId]); } catch {}
    rows.push({ itemId, ep, position: r.position || 0, duration: r.duration || 0, finished: !!r.finished, updatedAt: r.updatedAt || 0 });
  }
  return rows;
};

const rowOf = (pid, id) => { try { return (profilesLib().getProgressView(pid) || {})[id] || null; } catch { return null; } };
const finishedBy = (id, pid) => plan.isFinished(rowOf(pid, id));
const partWay = (id) => {
  try {
    return profilesLib().list().some((p) => { const r = rowOf(p.id, id); return r && !plan.isFinished(r) && r.position >= 60; });
  } catch { return false; }
};

// The audio track a person starts on (the players' rule: their remembered
// language, else the original language) — the one a prepared file carries.
const startTrack = (item, persons) => {
  const tracks = Array.isArray(item.audioTracks) ? item.audioTracks : [];
  if (tracks.length < 2) return 0;
  try {
    const { sameLanguage } = require("../lib/lang");
    const prof = profilesLib().list().find((p) => p.id === persons[0]);
    const liked = prof && prof.prefs && prof.prefs.audioLang;
    const mine = liked ? tracks.find((t) => sameLanguage(t.language, liked)) : null;
    if (mine) return mine.index || 0;
    const titleItem = item.showId ? scannerLib().findById(item.showId) || item : item;
    const imdbId = titleItem.imdbId || identityLib().imdbIdFor(titleItem);
    const meta = imdbId ? discoverLib().metaCached(titleItem.type === "show" ? "series" : "movie", imdbId) : null;
    const lang = meta && meta.originalLanguage;
    const orig = lang ? tracks.find((t) => sameLanguage(t.language, lang)) : null;
    return orig ? orig.index || 0 : 0;
  } catch {
    return 0;
  }
};

const tonemapOk = () => {
  try {
    const tm = require("./tonemap");
    if (!tm.enabled()) return false;
    const s = tm.supportNow();
    return !(s && s.ok === false); // not measured yet: assumed, and checked when it is made
  } catch { return false; }
};

const epLabel = (title, s, e) => `${title || "?"} · S${s} E${e}`;
const labelOf = (item) => {
  if (!item) return "?";
  if (item.showId || item.season != null) {
    const show = item.showId ? scannerLib().findById(item.showId) : null;
    return epLabel((show && show.title) || item.showTitle || item.title, item.season, item.episode);
  }
  return item.title || "?";
};

/** What tomorrow likely needs, and for whom → { wants, considered, notes } */
const gatherWants = async (now = deps.now()) => {
  const t = timing();
  const P = profilesLib();
  const S = scannerLib();
  const byId = new Map();
  const add = (id, reason, at, person, label, episode) => {
    if (!id || String(id).includes("|")) return; // a library title, never a stream
    let w = byId.get(id);
    if (!w) { w = { id, reason, at: at || 0, persons: new Set(), label, episode: !!episode }; byId.set(id, w); }
    if ((plan.REASONS[reason] ?? 9) < (plan.REASONS[w.reason] ?? 9)) w.reason = reason;
    w.at = Math.max(w.at, at || 0);
    if (person) w.persons.add(person);
  };
  for (const p of P.list()) {
    const rows = progressRows(p.id, now - t.activeDays * DAY);
    // 1. the next episodes of the shows this person is in
    for (const sh of plan.activeShows(rows, { now, activeDays: t.activeDays, watchedSec: t.watchedSec })) {
      const m = await discoverLib().meta("series", sh.imdbId).catch(() => null);
      if (m && m.seasons) {
        for (const e of plan.upcoming(m.seasons, sh.anchor, 2, now)) {
          const lib = identityLib().findLibraryPlayable({ imdbId: sh.imdbId, type: "show", title: m.title, year: m.year, season: e.season, episode: e.episode });
          if (lib && lib.id) add(lib.id, "next", sh.anchor.updatedAt, p.id, epLabel(m.title, e.season, e.episode), true);
        }
      } else if (sh.anchor.itemId && !String(sh.anchor.itemId).includes("|")) {
        // no catalogue right now: the library's own next file
        const it = S.findById(sh.anchor.itemId);
        const nx = it && it.showId ? (sh.anchor.finished ? P.nextEpisode(it.showId, it.id) : it) : null;
        if (nx && nx.id) add(nx.id, "next", sh.anchor.updatedAt, p.id, labelOf(nx), true);
      }
    }
    // 2. the top of Continue watching
    let cw = [];
    try { cw = P.continueWatching(p.id) || []; } catch {}
    for (const c of cw.slice(0, t.continueTop)) {
      if (!c || !c.id || !c.videoUrl) continue;
      add(c.id, "continue", (c.progress && c.progress.updatedAt) || now - DAY, p.id, labelOf(c), !!c.showId);
    }
  }
  // 3. what somebody asked for and has not watched yet
  for (const j of downloadsLib().rawJobs()) {
    if (!j || j.status !== "done" || j.smart || !j.destPath) continue;
    const at = Date.parse(j.doneAt || j.at) || 0;
    if (now - at > t.landedDays * DAY) continue;
    const id = S.idForPath(j.destPath);
    if (!id) continue;
    for (const pid of [j.profile, ...(j.also || [])].filter(Boolean)) {
      if (finishedBy(id, pid)) continue;
      add(id, "landed", at, pid, j.label || j.title, j.type === "show");
    }
  }
  const wants = [];
  const notes = [];
  const tm = tonemapOk();
  for (const w of byId.values()) {
    const item = S.findById(w.id);
    if (!item || !item.videoUrl) continue;
    const facts = playpathLib().factsOfItem(item);
    const persons = [...w.persons];
    const track = startTrack(item, persons);
    const devices = devicesFor(persons, now);
    const needs = plan.needsOf(facts, devices, { track, tonemap: tm });
    w.devices = needs.rows;
    if (!needs.kinds.size) {
      notes.push({ id: w.id, label: w.label, reason: w.reason, why: !devices.length ? "no device has reported what it plays yet" : needs.rows.every((r) => r.mode === "direct") ? "every device here plays it as it is" : needs.rows.map((r) => r.why).filter((x, i, a) => a.indexOf(x) === i).join("; ") });
      continue;
    }
    const src = prepared.sourceOf(w.id);
    for (const kind of needs.kinds) {
      wants.push({
        key: prepared.keyOf(w.id, kind), id: w.id, kind,
        bytes: plan.estimateBytes(kind, { sizeBytes: src ? src.size : item.sizeBytes, duration: item.duration, height: item.height }),
        reason: w.reason, at: w.at, label: w.label, persons, audioIndex: track, episode: w.episode, duration: item.duration || 0, facts,
        devices: needs.rows.filter((r) => r.kind === kind).map((r) => `${r.client}${r.model ? ` ${r.model}` : ""}`),
      });
    }
  }
  return { wants, considered: [...byId.values()].map((w) => ({ id: w.id, label: w.label, reason: w.reason, persons: [...w.persons], devices: w.devices || [] })), notes };
};

// ------------------------------------------------------------- downloads ahead
let lastAhead = null;
let aheadRunning = null;
// The fullest library drive's forecast (media/diskforecast.js), as the admin's Disk line has it.
const forecastNow = () => {
  try {
    const disk = require("../lib/disk");
    const roots = [...new Set([...config.LIBRARIES.movies, ...config.LIBRARIES.shows])];
    let minFree = null;
    for (const r of roots) { const s = disk.spaceSync(r); if (s && s.free != null && (minFree == null || s.free < minFree)) minFree = s.free; }
    return minFree == null ? null : require("./diskforecast").measure(minFree);
  } catch { return null; }
};

/** One sweep of the downloads ahead. → { at, depth, why, queued: [...] } */
const sweepAhead = (now = deps.now()) => {
  if (aheadRunning) return aheadRunning;
  aheadRunning = (async () => {
    const s = settings();
    const t = timing();
    const d = plan.aheadDepth({ setting: s.aheadEpisodes, forecast: forecastNow(), timing: t });
    const out = { at: now, depth: d.depth, why: d.why, queued: [], people: 0 };
    lastAhead = out;
    if (!d.depth) return out;
    const st = theState();
    for (const p of profilesLib().list()) {
      if (p.prefs && p.prefs.smartDownloads === false) continue;
      const shows = plan.activeShows(progressRows(p.id, now - t.activeDays * DAY), { now, activeDays: t.activeDays, watchedSec: t.watchedSec });
      if (shows.length) out.people++;
      for (const sh of shows) {
        let r = null;
        try { r = await smartdlLib().ahead(p, { imdbId: sh.imdbId, anchor: sh.anchor, depth: d.depth, now }); } catch (e) { console.warn(`[overnight] downloads ahead for ${p.name}: ${e.message}`); }
        for (const e of (r && r.episodes) || []) {
          if (e.state !== "queued" || !e.jobId) continue;
          const rec = { jobId: e.jobId, at: now, profile: p.id, name: p.name || null, label: epLabel(r.title, e.season, e.episode), nth: e.nth };
          st.data.ahead.push(rec);
          out.queued.push(rec);
        }
      }
    }
    st.data.ahead = st.data.ahead.filter((x) => now - (x.at || 0) < 14 * DAY).slice(-300);
    if (out.queued.length) st.save();
    return out;
  })()
    .catch((e) => { console.warn(`[overnight] downloads ahead failed: ${e.message}`); return null; })
    .finally(() => { aheadRunning = null; });
  return aheadRunning;
};

// The downloads ahead and where they are: [{ …record, status, doneAt }]
const aheadJobs = () => {
  const jobs = new Map(downloadsLib().rawJobs().map((j) => [j.id, j]));
  return theState().data.ahead.map((r) => {
    const j = jobs.get(r.jobId);
    return { ...r, status: j ? j.status : "gone", doneAt: j && j.doneAt ? Date.parse(j.doneAt) || null : null };
  });
};
const aheadLanded = (now = deps.now()) => aheadJobs().filter((r) => r.status === "done" && r.doneAt && now - r.doneAt < DAY).length;

// ------------------------------------------------------------- the run
const run = {
  job: null,        // { want, ctl, place, paused, pausedAt, startedAt, stopping }
  queue: [],        // wants still to make tonight, in order
  forced: false,    // the admin's Run now
  planAt: 0,
  planning: null,
  lastPlan: null,
  lastBusyAt: 0,
  busyWhy: null,
  current: null,    // tonight's record: { startedAt, why, made: [], failed: [], stopped: [] }
  failed: new Map(), // key -> { at, why }
};
let timer = null;
let ticking = false;

const openRun = (now, why) => {
  run.current = { startedAt: now, why, made: [], failed: [], stopped: [], endedAt: null };
  console.log(`[overnight] run begins (${why})`);
  sweepAhead(now); // the downloads ahead go first: what lands tonight is prepared tonight
};
const closeRun = (now, why) => {
  const c = run.current;
  if (!c) return;
  c.endedAt = now;
  c.end = why;
  const st = theState();
  st.data.runs.unshift({ ...c, made: c.made.slice(0, 50), failed: c.failed.slice(0, 20), stopped: c.stopped.slice(0, 20) });
  st.data.runs = st.data.runs.slice(0, RUNS_KEPT);
  st.save();
  const gb = c.made.reduce((n, m) => n + (m.bytes || 0), 0) / 1e9;
  console.log(`[overnight] run ends (${why}): ${c.made.length} prepared (${gb.toFixed(1)} GB), ${c.failed.length} failed, ${c.stopped.length} stopped`);
  run.current = null;
  run.forced = false;
  run.queue = [];
  run.planAt = 0;
};

const tidyWith = (wantedKeys, now) => {
  const t = timing();
  const gone = plan.cleanup(prepared.list(), {
    mtimeOf: (id) => { const s = prepared.sourceOf(id); return s ? s.mtime : null; },
    finished: finishedBy,
    partWay,
    playing: (id) => { try { return require("../lib/inuse").streamingNow(id); } catch { return false; } },
    wanted: wantedKeys,
  }, { now, staleDays: t.staleDays });
  let freed = 0;
  for (const g of gone) freed += prepared.remove(g.key, g.why);
  return { removed: gone, freed };
};

let lastPlanSig = null;
/** Make tonight's plan (and tidy up). → the plan's summary */
const replan = async (now = deps.now()) => {
  const s = settings();
  const t = timing();
  const g = await (deps.gather || gatherWants)(now);
  const runningKey = run.job ? run.job.want.key : null;
  const freshFail = (k) => { const f = run.failed.get(k); return f && now - f.at < FAIL_AGAIN_MS ? f : null; };
  const wants = g.wants.filter((w) => w.key !== runningKey && !freshFail(w.key));
  const have = new Map(prepared.list().map((r) => [r.key, { bytes: r.bytes || 0, madeAt: r.madeAt || 0, usedAt: r.usedAt || 0 }]));
  const free = prepared.freeBytes();
  const used = prepared.usedBytes();
  const budget = plan.budgetBytes({ freeBytes: free, preparedBytes: used, pct: s.budgetPct, headroomBytes: t.headroomBytes });
  // (the conversion under way has its room promised)
  const promised = run.job ? run.job.want.bytes || 0 : 0;
  const f = plan.fit({ wants, have, budget: Math.max(0, budget - promised) });
  const wanted = new Set([...f.keep, ...f.make.map((w) => w.key), ...(runningKey ? [runningKey] : [])]);
  const tidy = tidyWith(wanted, now);
  const playing = (id) => { try { return require("../lib/inuse").streamingNow(id); } catch { return false; } };
  for (const e of f.evict) {
    const rec = prepared.list().find((r) => r.key === e.key);
    if (rec && !playing(rec.id)) prepared.remove(e.key, e.why);
  }
  run.queue = f.make;
  const summary = (w) => ({ key: w.key, id: w.id, label: w.label, kind: w.kind, bytes: w.bytes, reason: w.reason, persons: w.persons, devices: w.devices || [] });
  run.lastPlan = {
    at: now, free, used, budget,
    make: f.make.map(summary),
    keep: f.keep,
    skip: [...f.skip.map((w) => ({ ...summary(w), why: w.why })), ...g.wants.filter((w) => freshFail(w.key)).map((w) => ({ ...summary(w), why: `failed lately: ${freshFail(w.key).why}` }))],
    removed: [...tidy.removed, ...f.evict],
    notes: g.notes,
    considered: g.considered.length,
  };
  // (said when it changes: it is made again every quarter of an hour)
  const sig = `${g.considered.length}|${f.make.map((w) => w.key).join(",")}|${f.keep.length}|${f.skip.length}`;
  if (sig !== lastPlanSig) console.log(`[overnight] plan: ${g.considered.length} title${g.considered.length === 1 ? "" : "s"} looked at, ${f.make.length} to prepare, ${f.keep.length} already prepared, ${f.skip.length} over the budget (${(budget / 1e9).toFixed(1)} GB budget, ${(used / 1e9).toFixed(1)} GB used)`);
  lastPlanSig = sig;
  return run.lastPlan;
};

const label = (w) => `${w.label} (${w.kind === "h264" ? "1080p H.264" : "copy"})`;

const startNext = (now) => {
  const w = run.queue.shift();
  if (!w) return;
  const job = { want: w, ctl: null, place: null, paused: false, pausedAt: 0, startedAt: now, stopping: null };
  run.job = job;
  (async () => {
    let place = null;
    try {
      place = await cpuworkLib().background.gate(w.kind === "h264" ? "encode" : "prepare", {
        label: `overnight: ${label(w)}`,
        // the viewers' encoders are falling behind: this one goes first
        onShed: () => stopJob("the server needed the CPU for a viewer"),
      });
    } catch (e) {
      if (run.job === job) run.job = null;
      return void console.warn(`[overnight] could not get a place to work: ${e.message}`);
    }
    if (run.job !== job || job.stopping) { place.release(); if (run.job === job) run.job = null; return; }
    job.place = place;
    const ctl = await prepared.start(w, { threads: cpuworkLib().background.threads() });
    if (run.job !== job) { if (ctl && ctl.stop) ctl.stop("no longer wanted"); place.release(); return; }
    if (!ctl || ctl.error) {
      place.release();
      run.job = null;
      const why = (ctl && ctl.error) || "it would not start";
      run.failed.set(w.key, { at: deps.now(), why });
      if (run.current) run.current.failed.push({ label: label(w), why });
      return void console.warn(`[overnight] ${label(w)}: not made — ${why}`);
    }
    job.ctl = ctl;
    console.log(`[overnight] preparing ${label(w)} for ${w.persons.length} ${w.persons.length === 1 ? "person" : "people"} (${plan.REASON_WORDS[w.reason] || w.reason}; ${(w.devices || []).join(", ") || "the house's devices"})`);
    if (job.stopping) ctl.stop(job.stopping);
    const r = await ctl.done;
    place.release();
    if (run.job === job) run.job = null;
    if (r.ok) {
      if (run.current) run.current.made.push({ label: label(w), kind: w.kind, bytes: r.bytes, ms: r.ms, id: w.id });
      console.log(`[overnight] ready: ${label(w)} — ${(r.bytes / 1e9).toFixed(2)} GB in ${Math.round(r.ms / 1000)} s`);
    } else if (r.stopped) {
      if (run.current) run.current.stopped.push({ label: label(w), why: r.stopped });
      console.log(`[overnight] stopped ${label(w)}: ${r.stopped} — it is tried again when it is quiet`);
      run.queue.unshift(w);
    } else {
      run.failed.set(w.key, { at: deps.now(), why: r.error });
      if (run.current) run.current.failed.push({ label: label(w), why: r.error });
      console.warn(`[overnight] failed ${label(w)}: ${r.error}`);
    }
  })().catch((e) => { if (run.job === job) run.job = null; console.warn(`[overnight] ${label(w)}: ${e.message}`); });
};

const pauseJob = (why) => {
  const job = run.job;
  if (!job || job.paused) return;
  if (!job.ctl) return stopJob(`${why || "someone is watching"} before it began`);
  job.paused = true;
  job.pausedAt = deps.now();
  console.log(`[overnight] paused ${label(job.want)} — ${why || "someone is watching"}`);
  job.ctl.pause().then((ok) => { if (!ok && run.job === job) stopJob("it could not be paused, so it was stopped"); });
};
const resumeJob = () => {
  const job = run.job;
  if (!job || !job.paused || !job.ctl) return;
  job.paused = false;
  console.log(`[overnight] going on with ${label(job.want)} — nobody is watching`);
  job.ctl.resume();
};
const stopJob = (why) => {
  const job = run.job;
  if (!job || job.stopping) return;
  job.stopping = why;
  if (job.ctl) job.ctl.stop(why);
  else { run.job = null; run.queue.unshift(job.want); if (run.current) run.current.stopped.push({ label: label(job.want), why }); }
};

/** One look (every TIMING.tickMs). Exported for the tests: they drive it by hand. */
const tick = async () => {
  if (ticking) return null;
  ticking = true;
  try {
    const now = deps.now();
    const s = settings();
    const t = timing();
    const inside = plan.inWindow(now, s);
    const b = deps.busy();
    if (b.busy) { run.lastBusyAt = now; run.busyWhy = b.why; }
    const quietMs = run.lastBusyAt ? now - run.lastBusyAt : Infinity;
    const allowed = s.on && (inside || run.forced);
    if (allowed && !run.current) openRun(now, run.forced ? "Run now" : "the quiet hours");
    if (!allowed && run.current && !run.job) closeRun(now, s.on ? "the quiet hours are over" : "turned off");
    if (allowed && !run.planning && now - run.planAt >= t.planEveryMs && !b.busy) {
      run.planAt = now;
      run.planning = replan(now).catch((e) => console.warn(`[overnight] plan failed: ${e.message}`)).finally(() => { run.planning = null; });
    }
    const job = run.job ? { running: true, paused: run.job.paused, pausedMs: run.job.paused ? now - run.job.pausedAt : 0 } : null;
    const action = plan.step({ on: s.on, inWindow: inside, forced: run.forced, busy: b.busy, quietMs, job, pending: run.queue.length > 0 && !run.planning, timing: t });
    switch (action) {
      case "start": startNext(now); break;
      case "pause": pauseJob(b.why); break;
      case "resume": resumeJob(); break;
      case "stop": stopJob(!allowed ? (s.on ? "the quiet hours are over" : "turned off") : "paused for too long — someone is still watching"); break;
      case "idle":
        // Run now, and nothing left to do: that run is over
        if (run.forced && run.planAt && !run.planning && !run.queue.length && !run.job) closeRun(now, "everything is done");
        break;
      default: break;
    }
    return action;
  } finally {
    ticking = false;
  }
};

/** The admin's Run now: tonight's run, now (nobody may be watching all the same). */
const runNow = () => {
  if (!settings().on) return { error: "Overnight preparation is off — turn it on first." };
  run.forced = true;
  run.planAt = 0;
  tick();
  return { ok: true, waiting: deps.busy().busy ? "It starts when nobody is watching." : null };
};

// ------------------------------------------------------------- for the title read
/** The prepared file this device plays for this title (/api/item?caps=), or null. */
const preparedFor = (id, capsId, original) => {
  if (!original || original.mode === "direct") return null;
  const caps = avcapsLib().lookup(String(capsId || ""));
  if (!caps) return null;
  return prepared.forItem(id, caps, original);
};

// ------------------------------------------------------------- the admin's view
const stateWord = (now = deps.now()) => {
  if (run.job) return run.job.paused ? "paused" : "running";
  const s = settings();
  if (s.on && (plan.inWindow(now, s) || run.forced) && run.queue.length && now - run.lastBusyAt < timing().quietStartMs) return "waiting";
  return "idle";
};

const status = (now = deps.now()) => {
  const s = settings();
  const t = timing();
  const files = prepared.list();
  const readyIds = new Map();
  for (const r of files) if (!readyIds.has(r.id)) readyIds.set(r.id, r);
  let episodes = 0;
  let films = 0;
  for (const r of readyIds.values()) { if (r.episode) episodes++; else films++; }
  const word = stateWord(now);
  const ahead = aheadJobs();
  const landed = aheadLanded(now);
  const made = run.current ? run.current.made.length : 0;
  const nextRunAt = plan.nextStart(now, s);
  const line = plan.statusLine({
    on: s.on, prepared: { episodes, films }, ahead: landed, aheadOn: s.aheadEpisodes > 0,
    nextRunAt, state: word, making: run.job ? `${made + 1} of ${made + 1 + run.queue.length}` : null,
  });
  const free = prepared.freeBytes();
  const used = prepared.usedBytes();
  const nameOf = (pid) => { try { const p = profilesLib().list().find((x) => x.id === pid); return p ? p.name : pid; } catch { return pid; } };
  const names = (list) => [...new Set((list || []).map(nameOf))];
  return {
    line,
    state: word,
    busyWhy: word === "paused" || word === "waiting" ? run.busyWhy : null,
    settings: s,
    defaults: plan.DEFAULTS,
    inWindow: plan.inWindow(now, s),
    nextRunAt,
    windowEndAt: plan.windowEnd(now, s),
    budget: { pct: s.budgetPct, bytes: plan.budgetBytes({ freeBytes: free, preparedBytes: used, pct: s.budgetPct, headroomBytes: t.headroomBytes }), usedBytes: used, freeBytes: free },
    making: run.job ? { label: label(run.job.want), kind: run.job.want.kind, progress: run.job.ctl ? run.job.ctl.progress() : 0, paused: run.job.paused, since: run.job.startedAt } : null,
    queue: run.queue.map((w) => ({ label: label(w), bytes: w.bytes, reason: w.reason })),
    prepared: files.map((r) => ({ key: r.key, id: r.id, label: r.label, kind: r.kind, bytes: r.bytes, madeAt: r.madeAt, usedAt: r.usedAt || null, ms: r.ms, reason: r.reason, people: names(r.persons), height: (r.facts && r.facts.height) || 0 })),
    plan: run.lastPlan ? { ...run.lastPlan, make: run.lastPlan.make.map((w) => ({ ...w, people: names(w.persons) })), skip: run.lastPlan.skip.map((w) => ({ ...w, people: names(w.persons) })) } : null,
    ahead: {
      landedDay: landed,
      onTheWay: ahead.filter((r) => ["pending", "approved", "downloading"].includes(r.status)).length,
      last: lastAhead,
      recent: ahead.slice(-20).reverse(),
    },
    runs: theState().data.runs.slice(0, 7),
    current: run.current ? { ...run.current } : null,
    devices: Object.entries(theState().data.devices).map(([pid, ids]) => ({ person: nameOf(pid), devices: Object.keys(ids).map((id) => { const c = avcapsLib().lookup(id); return c ? `${c.client}${c.model ? ` ${c.model}` : ""}` : `${id} (forgotten)`; }) })),
    timing: t,
  };
};

// ------------------------------------------------------------- start
let aheadTimer = null;
let tidyTimer = null;
const start = () => {
  if (timer) return;
  try { prepared.reconcile(); } catch {}
  const t = timing();
  timer = deps.setInterval(() => { tick().catch(() => {}); }, t.tickMs);
  // the downloads ahead: a while after boot, then every hour
  const first = setTimeout(() => { if (settings().aheadEpisodes > 0) sweepAhead(); }, 5 * 60 * 1000);
  first.unref?.();
  aheadTimer = deps.setInterval(() => { if (settings().aheadEpisodes > 0) sweepAhead(); }, t.aheadEveryMs);
  // the clean-up, by the day too (what has been watched since goes)
  tidyTimer = deps.setInterval(() => {
    try {
      const w = run.lastPlan ? new Set([...run.lastPlan.keep, ...run.lastPlan.make.map((x) => x.key)]) : new Set();
      if (!run.job) tidyWith(w, deps.now());
    } catch {}
  }, 3600 * 1000);
};
const stop = () => {
  for (const x of [timer, aheadTimer, tidyTimer]) if (x) deps.clearInterval(x);
  timer = aheadTimer = tidyTimer = null;
  if (run.job) stopJob("the server is stopping");
};

module.exports = {
  start, stop, tick, runNow, status, settings, setSettings, sawDevice, devicesFor, preparedFor, sweepAhead, replan, gatherWants,
  _internals: { deps, run, theState, setState: (s) => { state = s; }, aheadJobs, progressRows, closeRun, reset: () => { run.job = null; run.queue = []; run.forced = false; run.planAt = 0; run.planning = null; run.lastPlan = null; run.lastBusyAt = 0; run.current = null; run.failed.clear(); lastAhead = null; } },
};
