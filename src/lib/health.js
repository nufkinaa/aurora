// Health alerts: the handful of things that, left alone, end with somebody in
// the house saying "it doesn't work" — a disk filling up, ffmpeg gone, the
// download engine dead with jobs waiting, no backup for two days, the server
// restarting over and over — told to whoever runs the server, once, in a
// sentence a non-engineer can act on, and again as "recovered" when it clears.
//
// How this sits beside what already watches the server:
//   watchdog.js  owns memory and event-loop lag (and restarts under pm2).
//                This READS its numbers and its event list; it measures
//                nothing itself.
//   healer.js    runs every minute, FIXES what it safely can (respawns the
//                download engine, restarts stalled downloads, clears temp
//                files) and shows its round on the admin's Server tab.
//                This asks the same modules the same cheap questions but
//                only speaks when a person is needed, and never acts.
//   notify.js    carries the message (ntfy / Telegram).
//
// Each check answers ok / warn / critical with one sentence. Nothing here
// flaps and nothing nags (see step()): a problem has to be seen on
// consecutive rounds before it is announced, has to stay clear on consecutive
// rounds before "recovered" goes out, is repeated at most once per
// `repeatHours` (12) while it lasts, and a warning that turns critical is
// announced at once. What has been announced is kept in data/health.json, so
// a restart does not announce it all again.
//
// Where an alert goes: the server log ("[health] ALERT …"), ntfy and/or
// Telegram when config.json has them, and GET /api/admin/alerts. NOT Web
// Push: the admin is a password, not a profile, so there is no "the admin's
// phone" to push to — ntfy is that phone.
//
// "The server is down" cannot be noticed from inside the server. Two outside
// halves are offered instead:
//   GET /healthz           200 {ok, uptime, version}, no sign-in, no secrets —
//                          point any uptime monitor at it.
//   "healthPingUrl"        when set, this URL is fetched every 5 minutes for
//                          as long as the server is alive; a dead-man's-switch
//                          service (healthchecks.io and the like) alerts when
//                          the pings STOP.
//
// Nothing starts at require time: server.js calls start().
"use strict";
const fs = require("fs");
const path = require("path");

const GB = 1024 ** 3;
const HOUR = 3600 * 1000;
const TICK_MS = 60 * 1000;
const PING_MS = 5 * 60 * 1000;
const TOOLS_OK_FOR_MS = HOUR; // a tool that ran is not asked again for an hour
const BACKUP_LOOK_MS = 5 * 60 * 1000;
const BOOTS_KEPT = 20;
const EVENTS_KEPT = 50;

const DEFAULTS = {
  diskWarnPercent: 10,
  diskWarnGb: 20,
  diskCriticalPercent: 5,
  diskCriticalGb: 5,
  backupMaxAgeHours: 48,
  repeatHours: 12,
  bootLoopCount: 3,
  bootLoopMinutes: 10,
};
const SEV = { ok: 0, warn: 1, critical: 2 };

// config.json's "health" object over the defaults; nonsense values are ignored.
const thresholds = (over) => {
  const t = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = Number(over && over[k]);
    if (over && over[k] != null && Number.isFinite(v) && v >= 0) t[k] = v;
  }
  return t;
};

const fmtGb = (bytes) => {
  const g = bytes / GB;
  return g >= 100 ? `${Math.round(g)} GB` : g >= 1 ? `${g.toFixed(g >= 10 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
};
const fmtPct = (p) => (p == null ? "?" : p < 10 ? `${p.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(p)}%`);

// ------------------------------------------- hysteresis and dedup (pure)

const freshState = () => ({ level: "ok", since: 0, message: null, alerted: false, alertedLevel: "ok", lastAlertAt: 0, lastRecoveredAt: 0, pending: null });

// One observation of one check -> the check's new state and what, if
// anything, to say. Pure: (state, { level, message }, now, opts) ->
// { state, action } where action is null | { type: "alert" | "reminder" |
// "recovered", level, message }.
//   confirm     consecutive rounds a worse level must be seen before it counts
//   clearAfter  consecutive ok rounds before a problem counts as over
//   repeatMs    while a problem lasts, say it again no sooner than this; and
//               a problem that comes BACK inside this window is not announced
//               again (it flapped) unless it is worse than what was said.
const step = (prev, obs, now, opts = {}) => {
  const confirm = opts.confirm || 2;
  const clearAfter = opts.clearAfter || 2;
  const repeatMs = opts.repeatMs == null ? DEFAULTS.repeatHours * HOUR : opts.repeatMs;
  const s = { ...freshState(), ...(prev || {}) };
  const level = SEV[obs.level] == null ? "ok" : obs.level;
  const say = (type) => {
    s.alerted = true;
    s.alertedLevel = s.level;
    s.lastAlertAt = now;
    return { type, level: s.level, message: s.message };
  };

  if (level === s.level) {
    s.pending = null;
    if (level === "ok") return { state: s, action: null };
    s.message = obs.message;
    // still wrong: a reminder once the window has passed (this is also where
    // a problem that came back too soon to announce finally gets said)
    if (now - s.lastAlertAt >= repeatMs) return { state: s, action: say(s.alerted ? "reminder" : "alert") };
    return { state: s, action: null };
  }

  const count = s.pending && s.pending.level === level ? s.pending.count + 1 : 1;
  const need = level === "ok" ? clearAfter : SEV[level] > SEV[s.level] ? confirm : 1;
  if (count < need) {
    s.pending = { level, count };
    return { state: s, action: null };
  }

  // the level really changed
  s.pending = null;
  const was = s.level;
  s.level = level;
  s.since = now;
  if (level === "ok") {
    const told = s.alerted;
    s.alerted = false;
    s.message = null;
    s.lastRecoveredAt = now;
    return { state: s, action: told ? { type: "recovered", level: "ok", message: obs.message || null } : null };
  }
  s.message = obs.message;
  if (SEV[level] < SEV[was]) return { state: s, action: null }; // critical eased to warn: no news
  const inWindow = now - s.lastAlertAt < repeatMs;
  if (inWindow && SEV[level] <= SEV[s.alertedLevel]) return { state: s, action: null }; // flapped back; already said
  return { state: s, action: say("alert") };
};

// ------------------------------------------------ decisions (all pure)

// Free space against the thresholds. `prev` (the level it was at) widens the
// way OUT of a level by 10%, so a disk hovering at the line does not flip.
// `byPercent: false` judges by gigabytes alone — for a drive that holds only
// Aurora's own records and backups (megabytes), where "9% free" of a 1 TB
// system disk is 90 GB and nobody's problem. A drive with the media library
// on it is judged by both: downloads are gated on the percentage.
const diskLevel = (space, t, prev = "ok", { byPercent = true } = {}) => {
  if (!space) return "critical";
  const under = (pct, gb, m) => (byPercent && space.freePct != null && space.freePct < pct * m) || space.free < gb * GB * m;
  if (under(t.diskCriticalPercent, t.diskCriticalGb, prev === "critical" ? 1.1 : 1)) return "critical";
  if (under(t.diskWarnPercent, t.diskWarnGb, prev !== "ok" ? 1.1 : 1)) return "warn";
  return "ok";
};

const ROLE_WORDS = { media: "the media library", data: "Aurora's own data", backups: "the backups" };
const diskConsequence = (roles, level) => {
  if (roles.includes("media")) return level === "critical" ? "Downloads will start failing." : "New downloads will soon stop starting on their own — free some space.";
  if (roles.includes("data")) return level === "critical" ? "Aurora may stop saving progress, profiles and settings." : "Free some space before Aurora can no longer save its records.";
  return level === "critical" ? "Backups will start failing." : "Backups will soon stop fitting — free some space.";
};
const joinRoles = (roles) => {
  const words = roles.map((r) => ROLE_WORDS[r] || r);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0];
};

// volumes: [{ id, roles: ["media","data","backups"], dir, space | null }]
// prevLevels: { id: level }. One result per volume.
const decideDisk = (volumes, t, prevLevels = {}) =>
  volumes.map((v) => {
    const name = v.roles.length === 1 && v.roles[0] === "media" ? "The media drive" : `The drive holding ${joinRoles(v.roles)}`;
    if (!v.space) {
      return {
        id: v.id, name: `Disk (${v.roles.join(", ")})`, level: "critical",
        message: `${name} cannot be reached (${v.dir}) — it may be unplugged, asleep or offline. ${v.roles.includes("media") ? "Nothing on it can be played until it is back." : "Aurora cannot save to it."}`,
        recovered: `${name} (${v.dir}) is reachable again.`,
      };
    }
    const level = diskLevel(v.space, t, prevLevels[v.id], { byPercent: v.roles.includes("media") });
    const free = `${fmtPct(v.space.freePct)} free (${fmtGb(v.space.free)})`;
    return {
      id: v.id, name: `Disk (${v.roles.join(", ")})`, level,
      message: level === "ok" ? `${free} on ${v.dir}` : `${name} has ${free}. ${diskConsequence(v.roles, level)}`,
      recovered: `${name} has room again: ${free}.`,
    };
  });

// { ffmpegPath, ffprobePath, ffmpegRuns, ffprobeRuns } — *Runs is true/false,
// or null when it was not tried.
const decideTools = (x) => {
  const base = { id: "tools", name: "ffmpeg", recovered: "ffmpeg and ffprobe are working again." };
  const missing = [!x.ffmpegPath && "ffmpeg", !x.ffprobePath && "ffprobe"].filter(Boolean);
  if (missing.length) {
    return { ...base, level: "warn", message: `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not installed on the server (or not on its PATH). Files that need converting will not play, and subtitles inside video files and thumbnails will be missing.` };
  }
  const broken = [x.ffmpegRuns === false && "ffmpeg", x.ffprobeRuns === false && "ffprobe"].filter(Boolean);
  if (broken.length) {
    return { ...base, level: "critical", message: `${broken.join(" and ")} ${broken.length > 1 ? "are" : "is"} installed but will not start. Files that need converting will not play until it is reinstalled or repaired.` };
  }
  return { ...base, level: "ok", message: "ffmpeg and ffprobe run" };
};

// { available, running, answering, waiting } — `waiting` is how many
// downloads are in flight or approved and queued; `answering` is the RPC
// ping (null when not asked).
const decideDownloader = (x) => {
  const base = { id: "downloader", name: "Download engine", recovered: "The download engine is running again." };
  // "torrents": false in config.json: an engine that is off by design is not
  // a stopped one, whatever is still sitting in the queue.
  if (x.off) return { ...base, level: "ok", message: "switched off in config.json (torrents: false)" };
  const n = x.waiting || 0;
  const jobs = `${n} download${n === 1 ? " is" : "s are"} waiting`;
  if (!n) return { ...base, level: "ok", message: x.available ? "idle — nothing is downloading" : "not installed, and nothing is waiting for it" };
  if (!x.available) return { ...base, level: "warn", message: `${jobs}, but the download engine (aria2) is not installed on the server, so nothing will download.` };
  if (!x.running) return { ...base, level: "critical", message: `The download engine has stopped and ${jobs}. Aurora keeps trying to start it; if no "recovered" message follows, restart Aurora.` };
  if (x.answering === false) return { ...base, level: "critical", message: `The download engine is not responding and ${jobs}. Aurora keeps trying to restart it; if no "recovered" message follows, restart Aurora.` };
  return { ...base, level: "ok", message: `running, ${n} download${n === 1 ? "" : "s"} in hand` };
};

// { enabled, newestAt, firstSeenAt, lastError }
const decideBackup = (x, now, t) => {
  const base = { id: "backup-stale", name: "Backups", recovered: "A fresh, verified backup exists again." };
  if (!x.enabled) return { ...base, level: "ok", message: "switched off in config.json (\"backups\": false)" };
  const maxAge = t.backupMaxAgeHours * HOUR;
  const why = x.lastError ? ` The last attempt said: ${x.lastError}.` : "";
  if (!x.newestAt) {
    if (now - (x.firstSeenAt || now) < maxAge) return { ...base, level: "ok", message: "the first backup has not been made yet" };
    return { ...base, level: "critical", message: `Aurora has no working backup at all. If the data folder were lost today, every profile and all watch history would go with it.${why}` };
  }
  const age = now - x.newestAt;
  const hours = Math.round(age / HOUR);
  const ago = hours < 72 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
  if (age > maxAge * 3) return { ...base, level: "critical", message: `The newest working backup is ${ago} old. Backups have stopped — check that the backup folder is reachable and has room.${why}` };
  if (age > maxAge) return { ...base, level: "warn", message: `There has been no working backup for ${ago} (one is made every day).${why}` };
  return { ...base, level: "ok", message: `newest verified backup is ${ago} old` };
};

// { boots: [ms…], crashes } — crashes is the number of uncaught errors in the
// server's log over the last 15 minutes.
const decideRestarts = (x, now, t) => {
  const base = { id: "restarts", name: "Crashes and restarts", recovered: "Aurora has stayed up — the restarts have stopped." };
  const windowMs = t.bootLoopMinutes * 60 * 1000;
  const recent = (x.boots || []).filter((b) => b <= now && now - b <= windowMs).length;
  if (recent >= t.bootLoopCount) {
    return { ...base, level: "critical", message: `Aurora has started ${recent} times in the last ${t.bootLoopMinutes} minutes. Something keeps making it crash or restart — the log on the admin page says what.` };
  }
  if ((x.crashes || 0) >= 5) {
    return { ...base, level: "warn", message: `Aurora hit ${x.crashes} unexpected errors in the last 15 minutes. It is still running, but something is wrong — the log on the admin page has the details.` };
  }
  return { ...base, level: "ok", message: `${recent} start${recent === 1 ? "" : "s"} in the last ${t.bootLoopMinutes} min, ${x.crashes || 0} unexpected errors in 15 min` };
};

// watchdog.status() -> a verdict. Its numbers, its thresholds, its events.
const decideProcess = (w, now) => {
  const base = { id: "process", name: "Memory and responsiveness", recovered: "Aurora's memory use and responsiveness are back to normal." };
  if (!w || !w.now) return { ...base, level: "ok", message: "no reading yet" };
  const recentEv = (kind) => (w.events || []).some((e) => e.kind === kind && now - e.at < 30 * 60 * 1000);
  if (recentEv("restart loop suspected")) {
    return { ...base, level: "critical", message: "Aurora is overloaded (out of memory or stuck), and restarting itself did not help. It needs someone to look at it." };
  }
  if (recentEv("hard heal skipped")) {
    return { ...base, level: "critical", message: "Aurora is overloaded (out of memory or stuck) and cannot restart itself because it is not running under pm2. Restart it by hand." };
  }
  const mb = Math.round(w.now.rss / 1048576);
  const t = w.thresholds || {};
  if ((t.hardRss && w.now.rss > t.hardRss) || (t.hardLagMs && w.now.lagMs > t.hardLagMs)) {
    return { ...base, level: "warn", message: `Aurora is struggling (${mb} MB of memory, ${w.now.lagMs} ms behind). Playback may stutter; it will try to recover by itself.` };
  }
  return { ...base, level: "ok", message: `${mb} MB, ${w.now.lagMs} ms lag` };
};

// ---------------------------------------------------------- the engine

const live = {
  started: false,
  store: null, // JsonStore over data/health.json: { firstSeenAt, boots, checks, events }
  mem: { firstSeenAt: 0, boots: [], checks: {}, events: [] }, // used until start() (and in tests)
  latest: new Map(), // id -> { id, name, level, message } as last observed
  lastRunAt: 0,
  running: false,
  timer: null,
  pingTimer: null,
  ping: { configured: false, lastAt: 0, lastOk: null, lastError: null },
  tools: { at: 0, ffmpeg: null, ffprobe: null },
  backup: { at: 0, newestAt: null },
  deliver: null, // test seam
};

const data = () => (live.store ? live.store.data : live.mem);
const persist = () => { if (live.store) live.store.save(); };

const TITLES = { alert: { warn: "Aurora: needs attention", critical: "Aurora: URGENT" }, reminder: { warn: "Aurora: still needs attention", critical: "Aurora: still URGENT" } };

// Say it: always the log, the admin's event list, and — once started — every
// notification channel that is configured.
const deliver = (check, action) => {
  const d = data();
  d.events = d.events || [];
  d.events.push({ at: Date.now(), id: check.id, type: action.type, level: action.level, message: action.message });
  while (d.events.length > EVENTS_KEPT) d.events.shift();
  persist();
  if (live.deliver) return void live.deliver(check, action);
  if (action.type === "recovered") console.log(`[health] RECOVERED ${check.id} — ${action.message}`);
  else if (action.level === "critical") console.error(`[health] ALERT critical ${check.id} — ${action.message}`);
  else console.warn(`[health] ALERT warn ${check.id} — ${action.message}`);
  if (!live.started) return; // a module required by a test or a CLI never messages anyone
  try {
    const notify = require("./notify");
    if (action.type === "recovered") notify.send("Aurora: recovered", action.message, { tags: "white_check_mark" });
    else notify.send(TITLES[action.type][action.level], action.message, { tags: action.level === "critical" ? "rotating_light" : "warning", priority: action.level === "critical" ? "urgent" : "high" });
  } catch {}
};

// Feed one round of results through step(). `opts` per result: confirm,
// clearAfter. Exposed for tests with a states object of their own.
const applyResults = (results, now, { states, repeatMs, send }) => {
  for (const r of results) {
    const { state, action } = step(states[r.id], { level: r.level, message: r.message }, now, { confirm: r.confirm, clearAfter: r.clearAfter, repeatMs });
    states[r.id] = state;
    if (!action) continue;
    if (action.type === "recovered") action.message = r.recovered || `${r.name} is fine again.`;
    send(r, action);
  }
};

const cfg = () => {
  const config = require("../config");
  return { config, t: thresholds(config.HEALTH || {}), enabled: config.HEALTH !== false };
};

// ---- gathering the inputs (the only part that touches the machine)

// The nearest folder that exists, so a backup folder not created yet is
// measured by the drive it will be created on.
const existing = (dir) => {
  let cur = path.resolve(dir);
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) cur = path.dirname(cur);
  return cur;
};

const gatherVolumes = async (config) => {
  const disk = require("./disk");
  const wanted = [];
  for (const kind of ["movies", "shows"]) for (const dir of (config.LIBRARIES && config.LIBRARIES[kind]) || []) wanted.push(["media", dir, dir]);
  wanted.push(["data", config.DATA_DIR, config.DATA_DIR]);
  if (config.BACKUPS) wanted.push(["backups", config.BACKUP_DIR, existing(config.BACKUP_DIR)]);
  const byVolume = new Map();
  for (const [role, dir, probe] of wanted) {
    const space = await disk.space(probe);
    let key;
    if (!space) key = `gone:${dir}`;
    else {
      try { key = `dev:${fs.statSync(probe).dev}:${space.total}`; } catch { key = `size:${space.total}`; }
    }
    const v = byVolume.get(key) || { roles: [], dirs: [], space };
    if (!v.roles.includes(role)) v.roles.push(role);
    v.dirs.push(dir);
    byVolume.set(key, v);
  }
  // the id has to survive restarts: the volume's first configured folder
  return [...byVolume.values()].map((v) => ({ id: `disk:${v.dirs[0]}`, roles: v.roles, dir: v.dirs[0], space: v.space }));
};

const runs = (exe) =>
  new Promise((resolve) => {
    if (!exe) return resolve(null);
    try {
      require("child_process").execFile(exe, ["-version"], { timeout: 8000, windowsHide: true }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });

const gatherTools = async (config, now) => {
  const fine = live.tools.ffmpeg !== false && live.tools.ffprobe !== false;
  if (!live.tools.at || !fine || now - live.tools.at > TOOLS_OK_FOR_MS) {
    live.tools = { at: now, ffmpeg: await runs(config.FFMPEG), ffprobe: await runs(config.FFPROBE) };
  }
  return { ffmpegPath: config.FFMPEG, ffprobePath: config.FFPROBE, ffmpegRuns: live.tools.ffmpeg, ffprobeRuns: live.tools.ffprobe };
};

const gatherDownloader = async () => {
  if (!require("./torrentgate").enabled()) return { off: true, available: false, running: false, answering: null, waiting: 0 };
  const aria2 = require("../media/aria2");
  const q = require("../media/downloads").queueHealth();
  const waiting = q.activeCount + q.approvedWaiting;
  const available = aria2.available();
  const running = available && aria2.running();
  let answering = null;
  if (waiting && running) {
    answering = await Promise.race([
      aria2.ping().then(() => true).catch(() => false),
      new Promise((r) => { const t = setTimeout(() => r(false), 6000); t.unref?.(); }),
    ]);
  }
  return { available, running, answering, waiting };
};

const gatherBackup = async (config, now) => {
  const backup = require("./backup");
  if (now - live.backup.at > BACKUP_LOOK_MS) {
    live.backup = { at: now, newestAt: config.BACKUPS ? await backup.newestVerifiedAt() : null };
  }
  const last = backup._internals.live.last;
  return { enabled: config.BACKUPS, newestAt: live.backup.newestAt, firstSeenAt: data().firstSeenAt, lastError: last && !last.ok ? last.error : null };
};

const gatherCrashes = (now) => {
  try {
    return require("./logbuffer").read({ level: "error", limit: 1500 })
      .filter((r) => now - r.t < 15 * 60 * 1000 && /\[uncaughtException\]|\[unhandledRejection\]/.test(r.msg)).length;
  } catch {
    return 0;
  }
};

// One round. Every check is fenced: one that throws is skipped this round
// (its state is left as it was), it never takes the others down.
const run = async () => {
  if (live.running) return;
  live.running = true;
  try {
    const { config, t, enabled } = cfg();
    if (!enabled) return;
    const now = Date.now();
    const d = data();
    d.checks = d.checks || {};
    const results = [];
    const attempt = async (fn) => {
      try { for (const r of [].concat(await fn())) results.push(r); } catch (e) { console.warn(`[health] a check could not run: ${(e && e.message) || e}`); }
    };
    await attempt(async () => {
      const prev = {};
      for (const [id, s] of Object.entries(d.checks)) prev[id] = s.level;
      return decideDisk(await gatherVolumes(config), t, prev);
    });
    await attempt(async () => decideTools(await gatherTools(config, now)));
    // the healer gets three rounds to bring the engine back before anyone is told
    await attempt(async () => ({ ...decideDownloader(await gatherDownloader()), confirm: 3 }));
    await attempt(async () => decideBackup(await gatherBackup(config, now), now, t));
    await attempt(async () => {
      const r = decideRestarts({ boots: d.boots || [], crashes: gatherCrashes(now) }, now, t);
      return { ...r, confirm: 1 }; // a server that keeps dying may not live to see a second round
    });
    await attempt(async () => ({ ...decideProcess(require("./watchdog").status(), now), confirm: 3 }));
    for (const r of results) live.latest.set(r.id, { id: r.id, name: r.name, level: r.level, message: r.message });
    applyResults(results, now, { states: d.checks, repeatMs: t.repeatHours * HOUR, send: deliver });
    // a library folder taken out of config.json leaves no ghost behind
    const seenIds = new Set(results.map((r) => r.id));
    if ([...seenIds].some((id) => id.startsWith("disk:"))) {
      for (const id of Object.keys(d.checks)) if (id.startsWith("disk:") && !seenIds.has(id)) { delete d.checks[id]; live.latest.delete(id); }
    }
    live.lastRunAt = now;
    persist();
  } finally {
    live.running = false;
  }
};

// For other modules with something to say (backup.js: "the snapshot failed
// its check"). Announced at once, and cleared at once by clear().
const raise = (id, level, message, name) => {
  const d = data();
  d.checks = d.checks || {};
  const { t } = cfg();
  const r = { id, name: name || (live.latest.get(id) || {}).name || id, level: level === "warn" ? "warn" : "critical", message, confirm: 1 };
  live.latest.set(id, { id, name: r.name, level: r.level, message });
  applyResults([r], Date.now(), { states: d.checks, repeatMs: t.repeatHours * HOUR, send: deliver });
  persist();
};
const clear = (id, message) => {
  const d = data();
  if (!d.checks || !d.checks[id] || d.checks[id].level === "ok") return;
  const { t } = cfg();
  const name = (live.latest.get(id) || {}).name || id;
  live.latest.set(id, { id, name, level: "ok", message: message || "fine" });
  applyResults([{ id, name, level: "ok", message, recovered: message, clearAfter: 1 }], Date.now(), { states: d.checks, repeatMs: t.repeatHours * HOUR, send: deliver });
  persist();
};

// ------------------------------------------- the dead-man's switch

const pingOnce = async () => {
  const { config } = cfg();
  const url = config.HEALTH_PING_URL;
  if (!url) return;
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10000), headers: { "User-Agent": "Aurora health ping" } });
    live.ping.lastAt = Date.now();
    if (!res.ok && live.ping.lastOk !== false) console.warn(`[health] the health ping URL answered ${res.status}`);
    live.ping.lastOk = res.ok;
    live.ping.lastError = res.ok ? null : `HTTP ${res.status}`;
  } catch (e) {
    if (live.ping.lastOk !== false) console.warn(`[health] the health ping could not be sent: ${(e && e.message) || e}`);
    live.ping.lastAt = Date.now();
    live.ping.lastOk = false;
    live.ping.lastError = String((e && e.message) || e).slice(0, 120);
  }
};

const validPingUrl = (url) => {
  try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
};

// --------------------------------------------------------- lifecycle

const NOWHERE = "health alerts have nowhere to go — set notifications.ntfy.topic or telegram in config.json";

const start = () => {
  if (live.started) return;
  live.started = true;
  const { config, t, enabled } = cfg();
  const { JsonStore } = require("./jsonstore");
  live.store = new JsonStore(path.join(config.DATA_DIR, "health.json"), () => ({ firstSeenAt: Date.now(), boots: [], checks: {}, events: [] }));
  const d = live.store.data;
  if (!d.firstSeenAt) d.firstSeenAt = Date.now();
  d.checks = d.checks || {};
  d.events = d.events || [];
  // The boot counter: this start, written to disk NOW (a server that dies in
  // its first second must still have been counted).
  d.boots = [...(d.boots || []), Date.now()].slice(-BOOTS_KEPT);
  live.store.flush();

  if (enabled) {
    let channels = [];
    try { channels = require("./notify").channels(); } catch {}
    if (!channels.length) console.warn(`[health] ${NOWHERE}`);
    else console.log(`[health] armed — alerts go to ${channels.join(" + ")}; disk warn under ${t.diskWarnPercent}% or ${t.diskWarnGb} GB, critical under ${t.diskCriticalPercent}% or ${t.diskCriticalGb} GB`);
    // a crash loop is judged at once: there may be no "one minute from now"
    try {
      const now = Date.now();
      const r = { ...decideRestarts({ boots: d.boots, crashes: 0 }, now, t), confirm: 1 };
      if (r.level === "critical") {
        live.latest.set(r.id, { id: r.id, name: r.name, level: r.level, message: r.message });
        applyResults([r], now, { states: d.checks, repeatMs: t.repeatHours * HOUR, send: deliver });
        live.store.flush();
      }
    } catch {}
    const first = setTimeout(() => run().catch(() => {}), 30000);
    first.unref?.();
    live.timer = setInterval(() => run().catch((e) => console.warn("[health] round failed:", e && e.message)), TICK_MS);
    live.timer.unref?.();
  } else {
    console.log("[health] alerts are switched off (\"health\": false in config.json)");
  }

  if (config.HEALTH_PING_URL) {
    if (!validPingUrl(config.HEALTH_PING_URL)) {
      console.warn("[health] healthPingUrl is not an http(s) address — no pings will be sent");
    } else {
      live.ping.configured = true;
      const firstPing = setTimeout(() => pingOnce(), 20000);
      firstPing.unref?.();
      live.pingTimer = setInterval(() => pingOnce(), PING_MS);
      live.pingTimer.unref?.();
    }
  }
};

const stop = () => {
  if (live.timer) clearInterval(live.timer);
  if (live.pingTimer) clearInterval(live.pingTimer);
  live.timer = live.pingTimer = null;
  live.started = false;
};

// For GET /api/admin/alerts.
const status = () => {
  const { config, t, enabled } = cfg();
  const d = data();
  let channels = [];
  try { channels = require("./notify").channels(); } catch {}
  const ids = new Set([...Object.keys(d.checks || {}), ...live.latest.keys()]);
  const checks = [...ids].map((id) => {
    const s = (d.checks || {})[id] || freshState();
    const l = live.latest.get(id) || {};
    return {
      id,
      name: l.name || id,
      level: s.level, // the settled level (after hysteresis) — what alerts follow
      observed: l.level || null, // what the last round actually saw
      message: l.message || s.message || null,
      since: s.since || null,
      lastAlertAt: s.lastAlertAt || null,
      lastRecoveredAt: s.lastRecoveredAt || null,
    };
  });
  const worst = checks.reduce((w, c) => (SEV[c.level] > SEV[w] ? c.level : w), "ok");
  return {
    enabled,
    overall: worst,
    lastRunAt: live.lastRunAt || null,
    everyMs: TICK_MS,
    checks,
    events: (d.events || []).slice(-EVENTS_KEPT).reverse(),
    delivery: {
      channels,
      log: true,
      webPush: false,
      webPushWhy: "the admin is a password, not a profile, so there is no admin device to push to",
      warning: channels.length ? null : NOWHERE,
    },
    ping: { configured: live.ping.configured, everyMs: PING_MS, lastAt: live.ping.lastAt || null, lastOk: live.ping.lastOk, lastError: live.ping.lastError },
    healthz: "/healthz",
    thresholds: t,
    boots: (d.boots || []).slice(-BOOTS_KEPT),
    notChecked: ["TMDB key validity and HTTPS certificate expiry (no cheap signal inside the server; an outside monitor on /healthz over https covers the certificate)"],
    backupDir: config.BACKUP_DIR,
  };
};

// GET /healthz — for an uptime monitor outside the house. No sign-in, no
// secrets, no work: if this answers, the process is up and its event loop
// is turning.
let version = null;
const healthz = (req, res) => {
  if (version === null) {
    try { version = require("../../package.json").version; } catch { version = "unknown"; }
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, uptime: Math.floor(process.uptime()), version });
};

module.exports = {
  start, stop, run, status, raise, clear, healthz, pingOnce,
  _internals: { step, freshState, thresholds, diskLevel, decideDisk, decideTools, decideDownloader, decideBackup, decideRestarts, decideProcess, applyResults, validPingUrl, live, DEFAULTS, NOWHERE },
};
