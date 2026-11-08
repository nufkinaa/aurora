// The admin's one-glance answer (2026-11-03, elia: "I only care to see if
// everything works — minor errors I don't really care, as long as the site is
// operational and people can watch normally"): GET /api/admin/summary.
//
// One state for the top of every admin screen:
//   "works"     nothing that stops people watching is wrong
//   "needs-you" something is broken that a person has to act on — each item
//               says what, why, and the one button that fixes it
//   (the page itself says "down" when this route does not answer)
//
// What counts as "needs you" (and nothing else does):
//   1. a health alert at its settled level "critical" (lib/health.js — the
//      same set that pages elia's phone: a disk nearly full, ffmpeg broken,
//      the download engine dead with jobs waiting, no working backup, a
//      restart loop, an overload the watchdog could not fix, a data file in
//      safe mode)
//   2. a healer check that FAILS in a part people watch through (WATCH_CHECKS
//      below: process, playback, encoding, transcoding, streaming, the
//      download queue and engine, disk, library folders, data files) — a fail
//      anywhere else (the log, updates, delivery) is minor
//   3. the event loop stuck: worst delay ≥ 5 s or p99 ≥ 1 s in the last window
//   4. most plays in the last hour failing to start (≥ 3 plays, ≥ half failed)
//   5. under 5 GB free on a library drive
// Everything else that is not fine — health warnings, healer warnings, a busy
// encoder, a slow event loop, slow starts, a stalled download, low-ish disk,
// no supervisor — is "minor": listed only when asked for, never red.
// Waiting work (people to let in, resets, reports, title requests, downloads
// to approve, an update) is not health: it is `waiting`, beside the state.
//
// decide() is pure (test/adminsummary.test.js); gather() reads the modules.
"use strict";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;

const WATCH_CHECKS = new Set(["process", "playback", "encoding", "transcoding", "streaming", "downloads", "aria2", "disk", "library", "stores", "data"]);
const HEALER_AREA = {
  process: "site", playback: "playback", encoding: "streaming", transcoding: "streaming", streaming: "streaming",
  downloads: "downloads", aria2: "downloads", staging: "downloads", dlstats: "downloads",
  disk: "disk", library: "disk", stores: "data", data: "data", backups: "data",
};
const LOOP_BAD = { maxMs: 5000, p99Ms: 1000 };
const LOOP_SLOW_P99 = 200;
const DISK_BAD = 5 * GB;
const DISK_LOW = 20 * GB;
const SLOW_START_MS = 6000;

const RESTART = { label: "Restart Aurora", kind: "restart" };
const go = (label, tab, more) => ({ label, kind: "tab", tab, ...(more ? { more } : {}) });

// health.js check id -> area and fix
const healthMeta = (id) => {
  if (id.startsWith("disk:")) return { area: "disk", fix: go("Free up space", "downloads", "d-disk") };
  if (id.startsWith("store:")) return { area: "data", fix: go("Open Data safety", "actions", "ac-data") };
  if (id.startsWith("backup")) return { area: "data", fix: go("Open Backups", "actions", "ac-backups") };
  if (id === "tools") return { area: "streaming", fix: go("Open Server", "server", "sv-env") };
  if (id === "downloader") return { area: "downloads", fix: RESTART };
  if (id === "process" || id === "restarts") return { area: "site", fix: RESTART };
  return { area: "site", fix: go("Open Server", "server") };
};

const fmtGb = (b) => (b >= 100 * GB ? `${Math.round(b / GB)} GB` : b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const fmtSec = (ms) => (ms == null ? "?" : ms >= 10000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);
const fmtSpeed = (bps) => (bps >= 1024 ** 2 ? `${(bps / 1024 ** 2).toFixed(1)} MB/s` : `${Math.round((bps || 0) / 1024)} KB/s`);
const fmtUp = (sec) => {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
};
const clockOf = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
// how quickly the server picks up a request (the event loop's p99)
const answers = (loop) => (!loop ? "" : (loop.p99Ms || 0) < 20 ? "answers at once" : `answers in ${Math.round(loop.p99Ms)} ms`);

// x: what gather() read (every field may be missing — a module that failed
// to answer is not a fault of the house)
const decide = (x = {}) => {
  const needs = [];
  const minor = [];
  const add = (list, item) => { if (!list.some((i) => i.id === item.id)) list.push(item); };

  // 1. health alerts (settled levels)
  for (const c of x.alerts || []) {
    if (c.level !== "critical" && c.level !== "warn") continue;
    const m = healthMeta(String(c.id || ""));
    const item = { id: `health:${c.id}`, area: m.area, title: c.name || c.id, why: c.message || "", fix: m.fix };
    add(c.level === "critical" ? needs : minor, item);
  }
  // 2. the healer's last round
  for (const c of x.healer || []) {
    if (c.status !== "fail" && c.status !== "warn") continue;
    const area = HEALER_AREA[c.id] || "site";
    const f = (c.findings || []).find((y) => y.level === "fail") || (c.findings || []).find((y) => y.level === "warn") || null;
    const fix = f && f.press ? { label: f.press.label.replace(/^Server → Actions → /, ""), kind: "action", action: f.press.action } : null;
    const item = { id: `healer:${c.id}`, area, title: c.name || c.id, why: (f && f.text) || c.summary || "", ...(fix ? { fix } : {}) };
    // one item per area from health already covers it: the healer's twin goes to minor
    const bad = c.status === "fail" && WATCH_CHECKS.has(c.id) && !needs.some((n) => n.area === area && n.id.startsWith("health:"));
    add(bad ? needs : minor, item);
  }
  // 3. the event loop
  const loop = x.loop || null;
  if (loop && (loop.maxMs >= LOOP_BAD.maxMs || loop.p99Ms >= LOOP_BAD.p99Ms)) {
    add(needs, { id: "loop", area: "site", title: "The server is stalling", why: `It was blocked for up to ${fmtSec(loop.maxMs)} in the last few seconds — pages and video stop answering while it is.`, fix: RESTART });
  } else if (loop && loop.p99Ms >= LOOP_SLOW_P99) {
    add(minor, { id: "loop", area: "site", title: "The server is slow to answer", why: `Requests wait up to ${Math.round(loop.p99Ms)} ms (p99) before they are handled.` });
  }
  // 4. plays that do not start
  const hour = (x.plays && x.plays.hour) || null;
  if (hour && hour.plays >= 3 && hour.startFailures >= Math.ceil(hour.plays / 2)) {
    add(needs, { id: "starts", area: "playback", title: "Plays are not starting", why: `${hour.startFailures} of the last ${hour.plays} plays in the past hour failed to start.`, fix: go("Open the healer", "server", "sv-healer") });
  } else if (hour && hour.startFailures > 0) {
    add(minor, { id: "starts", area: "playback", title: "A play failed to start", why: `${plural(hour.startFailures, "play")} of ${hour.plays} in the past hour did not start.` });
  }
  const starts = x.starts || null;
  if (starts && starts.n >= 5 && starts.p50 >= SLOW_START_MS) {
    add(minor, { id: "slow-starts", area: "playback", title: "Plays start slowly", why: `The median start in the last day took ${fmtSec(starts.p50)} (${starts.n} starts).` });
  }
  // 5. disk
  // 5a. a storage drive in use that is not answering (lib/drives): its titles cannot play
  const inUse = (x.drives || []).filter((d) => d && d.id);
  for (const d of inUse.filter((y) => y.answering === false)) {
    const since = d.downSince ? ` since ${clockOf(d.downSince)}` : "";
    const n = d.titles || 0;
    add(needs, { id: `drive-down:${d.id}`, area: "disk", title: "A storage drive isn't answering", why: `Storage drive ${d.mount} isn't answering${since} — ${plural(n, "title")} can't play. New downloads go to the other drives until it answers again.`, fix: go("Open Drives", "downloads", "d-disk") });
  }
  // with several drives in use, the drives that take new downloads count together
  const pool = inUse.length > 1 ? inUse.filter((d) => d.answering !== false && d.newDownloads !== false && d.free != null && d.total) : null;
  const disks = pool && pool.length
    ? [{ root: pool.length > 1 ? `${pool.length} drives` : pool[0].mount, free: pool.reduce((n, d) => n + d.free, 0), total: pool.reduce((n, d) => n + d.total, 0), pooled: pool.length }]
    : (x.disks || []).filter((d) => d && d.free != null && d.total);
  const lowest = disks.reduce((m, d) => (!m || d.free < m.free ? d : m), null);
  if (lowest && lowest.free < DISK_BAD && !needs.some((n) => n.area === "disk")) {
    add(needs, { id: "disk", area: "disk", title: "A drive is almost full", why: `${fmtGb(lowest.free)} free on ${lowest.root}. Downloads and recordings fail when it runs out.`, fix: go("Free up space", "downloads", "d-disk") });
  } else if (lowest) {
    const pct = (lowest.free / lowest.total) * 100;
    if (lowest.free < DISK_LOW || (x.minFreePct > 0 && pct < x.minFreePct)) {
      add(minor, { id: "disk-low", area: "disk", title: "Disk space is getting low", why: `${fmtGb(lowest.free)} free (${Math.round(pct)} %)${x.minFreePct > 0 && pct < x.minFreePct ? ` — under ${x.minFreePct} %, new downloads wait for your approval` : ""}.` });
    }
  }
  // the rest is minor by definition
  const enc = x.enc || null;
  if (enc && enc.overloaded) add(minor, { id: "encoders", area: "streaming", title: "The encoders are full", why: `${enc.overloadWhy || "an encode is behind real time"} — new viewers wait a moment or get a lower quality.` });
  const jobs = x.downloads || [];
  const active = jobs.filter((j) => j.status === "downloading");
  // (downloads-v2: `health.state` stalled or dead; older servers may say `stalled`)
  const stalled = active.filter((j) => j.stalled || (j.health && (j.health.state === "stalled" || j.health.state === "dead")));
  if (stalled.length) add(minor, { id: "dl-stalled", area: "downloads", title: `${plural(stalled.length, "download")} stalled`, why: stalled.slice(0, 3).map((j) => j.label || j.title).join(", ") });
  const sup = x.supervisor || null;
  if (sup && !sup.supervised) add(minor, { id: "supervisor", area: "site", title: "Nothing restarts the server", why: "A crash lasts until somebody starts it again, and Restart here cannot work. Start it through the keeper (docs/operations.md)." });

  // the five lines under the state
  const worst = (area) => (needs.some((n) => n.area === area) ? "bad" : "ok");
  const pl = (x.plays && x.plays.day) || null;
  const areas = [
    {
      id: "site", label: "Site", level: worst("site") === "bad" || worst("data") === "bad" ? "bad" : "ok",
      line: [x.uptimeSec != null ? `up ${fmtUp(x.uptimeSec)}` : "up", x.version ? `v${x.version}` : "", sup ? (sup.supervised ? `kept running by ${sup.by}` : "not supervised") : ""].filter(Boolean).join(" · "),
    },
    {
      id: "playback", label: "Playback", level: worst("playback"),
      line: [
        x.watchingNow ? `${x.watchingNow} watching now` : "nobody watching now",
        pl && pl.plays ? `${plural(pl.plays, "play")} today` : "no plays today",
        pl && pl.ttff && pl.ttff.p50 != null ? `starts in ${fmtSec(pl.ttff.p50)}` : "",
        pl && pl.startFailures ? `${pl.startFailures} failed` : "",
      ].filter(Boolean).join(" · "),
    },
    {
      id: "streaming", label: "Streaming", level: worst("streaming"),
      line: enc
        ? [
            enc.active ? `${enc.active} encoding` : "nothing encoding",
            enc.active && enc.capacity > 0 && enc.load != null ? `${Math.min(100, Math.round((100 * enc.load) / enc.capacity))} % of capacity` : "",
            enc.overloaded ? "full right now" : "",
            answers(loop),
          ].filter(Boolean).join(" · ")
        : answers(loop),
    },
    {
      id: "disk", label: "Disk", level: worst("disk"),
      // + "about 40 days until full" / "no growth this week" (media/diskforecast.js)
      line: lowest
        ? `${fmtGb(lowest.free)} free${lowest.pooled > 1 ? ` on ${lowest.pooled} drives` : disks.length > 1 ? " on the fullest drive" : ""}${inUse.some((d) => d.answering === false) ? ` · ${plural(inUse.filter((d) => d.answering === false).length, "drive")} not answering` : ""}${x.forecast && x.forecast.short ? ` · ${x.forecast.short}` : ""}`
        : "not measured",
    },
    {
      id: "downloads", label: "Downloads", level: worst("downloads"),
      line: (() => {
        const speed = active.reduce((n, j) => n + (j.downloadSpeed || 0), 0);
        const waiting = jobs.filter((j) => j.status === "approved").length;
        const bits = [active.length ? `${active.length} downloading · ${fmtSpeed(speed)}` : "nothing downloading"];
        if (waiting) bits.push(`${waiting} queued`);
        if (stalled.length) bits.push(`${stalled.length} stalled`);
        return bits.join(" · ");
      })(),
    },
  ];

  const state = needs.length ? "needs-you" : "works";
  const headline = state === "works" ? "Everything works" : needs.length === 1 ? "1 thing needs you" : `${needs.length} things need you`;
  const first = needs[0] || null;
  return {
    state,
    headline,
    reason: first ? `${first.title}: ${first.why}`.replace(/:\s*$/, "") : "People can watch normally.",
    fix: first && first.fix ? first.fix : null,
    needs,
    minor,
    areas,
  };
};

const safe = (fn, fallback = null) => { try { const v = fn(); return v === undefined ? fallback : v; } catch { return fallback; } };
const within = (p, ms, fallback) => Promise.race([Promise.resolve(p).catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms).unref?.())]);

// The household's clock: the server's time zone and locale, so the admin
// page writes "Nov 6, 21:14" in the house's time whatever device it is opened
// on (the downloads' who-and-when, elia 2026-11-08). PURE apart from Intl.
const clock = () => {
  let tz = null, locale = null, hourCycle = null;
  try { const o = new Intl.DateTimeFormat().resolvedOptions(); tz = o.timeZone || null; locale = o.locale || null; } catch {}
  try { hourCycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle || null; } catch {}
  return { tz: tz || "UTC", locale: locale || "en-US", hourCycle };
};

const gather = async () => {
  const config = require("../config");
  const now = Date.now();
  const realtime = require("../realtime");
  let watchingNow = 0;
  // (playing only: a paused player left open is not someone watching)
  safe(() => { for (const c of realtime.clients.values()) if (realtime.presenceOf(c) === "watching") watchingNow++; });
  const pm = safe(() => require("./playmarks"));
  const enc = safe(() => {
    const b = require("../media/encbudget");
    const ex = b.explain();
    let l = null;
    try { l = require("../media/remux").encodeLoad(); } catch {}
    return { limit: ex.limit, capacity: ex.capacity, load: l && l.load != null ? l.load : null, active: (l && l.active) || 0, overloaded: !!ex.overloaded, overloadWhy: ex.overloadWhy || null };
  });
  const roots = safe(() => [...new Set([...config.LIBRARIES.movies, ...config.LIBRARIES.shows])], []);
  const disk = require("./disk");
  const disks = [];
  for (const root of roots) {
    const s = await within(disk.space(root), 1500, null);
    if (s) disks.push({ root, free: s.free, total: s.total });
  }
  const drives = safe(() => require("./drives").summaryFacts(), []);
  // (several drives in use: the forecast is for all of them together)
  const pooled = drives.length > 1 ? drives.filter((d) => d.answering !== false && d.newDownloads !== false && d.free != null) : [];
  const fullest = pooled.length ? { free: pooled.reduce((n, d) => n + d.free, 0) } : disks.reduce((m, d) => (!m || d.free < m.free ? d : m), null);
  const forecast = fullest ? safe(() => require("../media/diskforecast").measure(fullest.free, now)) : null;
  const jobs = safe(() => require("../media/downloads").list(), []);
  const health = safe(() => require("./health").status(), null);
  const healer = safe(() => require("./healer").status(), null);
  const update = await within(require("./updatecheck").check(false), 1500, null);
  let version = null;
  safe(() => { version = require("../../package.json").version; });
  const profilesLib = safe(() => require("../profiles"));
  const people = safe(() => profilesLib.pendingList(), []);
  const resets = safe(() => require("./pwreset").pendingForAdmin().map((r) => {
    const p = profilesLib.list().find((y) => y.id === r.profileId);
    return { id: r.id, name: p ? p.name : "?", requestedAt: r.requestedAt };
  }), []);
  const x = {
    now,
    version,
    uptimeSec: Math.floor(process.uptime()),
    supervisor: safe(() => {
      const by = require("./supervisor").detect();
      return { supervised: !!by, by };
    }),
    alerts: (health && health.checks) || [],
    healer: (healer && healer.last && healer.last.checks) || [],
    loop: safe(() => require("./looplag").read()),
    enc,
    disks,
    drives,
    forecast,
    minFreePct: config.DOWNLOAD_MIN_FREE_PERCENT || 0,
    watchingNow,
    plays: pm ? { hour: safe(() => pm.summarize(pm.list(), now, HOUR)), day: safe(() => pm.summarize(pm.list(), now, DAY)) } : null,
    starts: pm ? safe(() => pm.startSummary()) : null,
    downloads: jobs,
  };
  const out = decide(x);
  return {
    at: now,
    version,
    uptimeSec: x.uptimeSec,
    ...out,
    healerAt: (healer && healer.last && healer.last.at) || null,
    // the work that waits on a person — not health
    waiting: {
      people: people.map((r) => ({ id: r.id, name: r.name, realName: r.realName || null, avatar: r.avatar || null, requestedAt: r.requestedAt || null })),
      resets,
      downloads: jobs.filter((j) => j.status === "pending").map((j) => ({ id: j.id, label: j.label || j.title, by: j.by || null, autoFor: j.autoFor || null, at: j.at || null, sizeBytes: j.sizeBytes || 0, holdReason: j.holdReason || null })),
      reports: safe(() => require("../routes/reports").openCount(), 0),
      requests: safe(() => require("../routes/requests").pendingCount(), 0),
      update: update && !update.error ? { available: !!update.available, restartNeeded: !!update.restartNeeded } : null,
    },
    restart: x.supervisor || { supervised: false, by: null },
    clock: clock(),
  };
};

module.exports = { decide, gather, clock, WATCH_CHECKS, _internals: { LOOP_BAD, LOOP_SLOW_P99, DISK_BAD, DISK_LOW } };
