// A copy of the household's data on every drive Aurora uses (2026-11-09,
// elia: "we can have a zip copy on all drives the pc has and update them
// every day (of course if the admin allows)").
//
// Built ON the daily backups (lib/backup.js): the same archive format, the
// same "what is copied" rule, the same check, the same rotation code. What
// this adds:
//
//   WHERE   every drive that holds a library folder (lib/drives: the drives
//           in use) gets <drive>/Aurora/.backups/aurora-backup-….tar.gz — next
//           to the drive's Aurora/Movies and Aurora/Shows. A hidden folder
//           (a dot; on Windows the hidden attribute too). The drive that
//           already holds the daily backups (data/backups, or "backupDir")
//           gets no second copy beside them: it is listed as covered by them.
//   WHAT    everything in the data folder that is not films and not a cache:
//           profiles (with their progress and lists), sign-ins, watch
//           history and viewing sessions, settings, reports, requests,
//           drives.json, the download history, usage, avatars — and
//           config.json WITHOUT ITS SECRETS (the admin password, the API
//           keys, the alert tokens, the ping address; .env is left out
//           entirely). Why left out rather than encrypted: see SECRETS below.
//   WHEN    once a day at the time the admin chose (server clock), only when
//           the admin has switched it on (OFF by default), never while
//           somebody watches (it waits), never while a restore is under way.
//   HOW     the archive is made once, then for each drive, one after another,
//           a child process with the lowest CPU and I/O priority (lib/drives/
//           run.js, probe-child.js → drivecopies-ops.js) writes it under a
//           temporary name, reads it back and checks it (the whole file's
//           sha256, then every file inside against its manifest), renames
//           it, and only then rotates that drive's copies: the last 7 dailies
//           and 4 weeklies (copies under a day old and the newest are always
//           kept). A failed copy rotates nothing away.
//   SKIPS   a drive that is not answering (or does not answer in time) is
//           skipped and tried again every 30 minutes; a full drive is skipped
//           with a note; neither is an alarm. A drive whose copy has FAILED
//           for 3 days raises a health warning.
//   RESTORE Admin → Actions → Backups → "Copies on every drive": pick a
//           copy, see what it holds and when it was made, type RESTORE. The
//           copy is fetched and checked, staged in data/.restore-pending, and
//           the server restarts through its supervisor (the keeper, pm2,
//           systemd). At the next start, BEFORE any store is read
//           (lib/restoreboot.js), the current data is copied aside (data/
//           before-restore-<time>/ and a snapshot in the backups folder), and
//           the copy's data files are put in place. Not supervised = no
//           restore from the page (nothing would start the server again);
//           `node src/lib/backup.js restore-live` does it with the server stopped.
//
// SECRETS. The drives are the copies that are meant to outlive this machine
// — a USB disk, a NAS share, a second disk somebody can pull out. Plain
// secrets there would be a leak; encrypted secrets need a key, and a key kept
// on this machine dies with it (the one case the copy is for), a key on the
// drive protects nothing, and a passphrase to remember is how a backup ends
// up unopenable. Every secret config.json holds can be set again in minutes
// (the admin password; the TMDB / OpenRouter keys from their sites; the ntfy
// topic, the Telegram token). The household's data needs none of them, and
// what it holds is already protected the way the server keeps it (passwords
// are scrypt hashes, sign-ins sha256 hashes). The daily backups beside the
// data keep config.json and .env whole, as before.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const lazy = require("./lazy");
const backup = require("./backup");

const configLib = lazy(require, "../config");

const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 3600 * SEC;
const DEFAULT_TIME = "04:00";
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const KEEP = { daily: 7, weekly: 4, monthly: 0 };
const TICK_MS = 5 * MIN;
const RETRY_MS = 30 * MIN;
const ALERT_AFTER_MS = 3 * DAY;
const TIMEOUT = { local: 60 * SEC, network: 120 * SEC, list: 45 * SEC };
const CONFIRM_WORD = "RESTORE";
const PENDING_FILE = "restore-pending.json";
const LAST_FILE = "restore-last.json";
const PENDING_DIR = ".restore-pending";
const MAIN = "main"; // the location id of the daily backups' own folder
// The words of the switch, said the same everywhere it is shown
const SWITCH_LABEL = "Keep a copy of the household's data on every drive";

const deps = {
  now: () => Date.now(),
  config: () => configLib(),
  drives: () => require("./drives"),
  ask: (...a) => require("./drives/run").ask(...a),
  watchingNow: () => { try { return require("./drives").deps.watchingNow(); } catch { return 0; } },
  settings: () => require("./settings"),
  supervisor: () => require("./supervisor"),
  tmpdir: () => os.tmpdir(),
  health: (fn) => { try { fn(require("./health")); } catch {} },
  restartSoon: (reason) => { const t = setTimeout(() => deps.supervisor().requestRestart(reason), 600); t.unref?.(); },
  version: () => { try { return require("../../package.json").version; } catch { return null; } },
};

const live = {
  running: null, // the round in flight (a promise)
  waiting: null, // why the round due now waits
  restoring: null, // { at, name, location } while a restore is being staged
  timer: null,
  state: null,
};

// ---------- settings (data/settings.json: the admin's choice, backed up with the rest) ----------
const getSettings = () => {
  let v = {};
  try { v = deps.settings().data.driveCopies || {}; } catch {}
  return { enabled: v.enabled === true, time: TIME_RE.test(String(v.time || "")) ? v.time : DEFAULT_TIME, enabledAt: Number.isFinite(v.enabledAt) ? v.enabledAt : null };
};
const setSettings = ({ enabled, time } = {}) => {
  if (time != null && !TIME_RE.test(String(time))) return { error: "The time must be HH:MM, 00:00 to 23:59." };
  if (enabled != null && typeof enabled !== "boolean") return { error: "enabled must be true or false." };
  const s = deps.settings();
  const cur = getSettings();
  const next = { enabled: enabled == null ? cur.enabled : enabled, time: time == null ? cur.time : time, enabledAt: cur.enabledAt };
  if (next.enabled && !cur.enabled) next.enabledAt = deps.now();
  if (!next.enabled) next.enabledAt = null;
  s.data.driveCopies = next;
  s.save();
  if (next.enabled !== cur.enabled) console.log(`[drive-copies] ${next.enabled ? `switched on by the admin (daily at ${next.time})` : "switched off by the admin"}`);
  if (!next.enabled) deps.health((h) => h.clear("drive-copies", "The copies on the drives are switched off."));
  return { ok: true, ...getSettings() };
};

// ---------- state (data/backup-state.json, key driveCopies: machine bookkeeping, not backed up) ----------
const config = () => deps.config();
const loadState = () => {
  if (!live.state) {
    const s = backup._internals.readState(config().DATA_DIR).driveCopies;
    live.state = s && typeof s === "object" ? { drives: {}, ...s } : { drives: {} };
    if (!live.state.drives || typeof live.state.drives !== "object") live.state.drives = {};
  }
  return live.state;
};
const saveState = () => backup._internals.writeState(config().DATA_DIR, { driveCopies: loadState() });
const driveState = (id) => {
  const st = loadState();
  if (!st.drives[id]) st.drives[id] = {};
  return st.drives[id];
};

// ---------- when ----------
// The newest moment the copy was due: today at `time` (server clock), or
// yesterday's when today's has not come yet.
const latestScheduled = (now, time) => {
  const [h, m] = String(time).split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  let t = d.getTime();
  if (t > now) { d.setDate(d.getDate() - 1); t = d.getTime(); }
  return t;
};
const nextScheduled = (now, time) => {
  const t = latestScheduled(now, time);
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  return d.getTime();
};
// Is this drive's copy due? Not made since the last scheduled moment, and
// (after a failed or skipped try) its retry time has come.
const isDue = (rec, now, time) => {
  const at = latestScheduled(now, time);
  if (rec.lastOkAt && rec.lastOkAt >= at) return false;
  if (rec.lastAttemptAt && rec.lastAttemptAt >= at && now - rec.lastAttemptAt < RETRY_MS) return false;
  return true;
};

// ---------- where ----------
const isFsRoot = (p) => path.parse(path.resolve(p)).root === path.resolve(p);
// <drive>/Aurora/.backups — the Aurora folder a library folder sits in when
// there is one (Aurora made <mount>/Aurora/Movies when the drive was taken
// into use); else <mount>/Aurora. A Linux system disk ("/") is not written
// at its top: the folder goes beside its first library folder instead.
const dirFor = (drive) => {
  const libs = (drive.folders || []).filter((f) => f.kind === "movies" || f.kind === "shows").map((f) => f.dir);
  for (const dir of libs) {
    const parent = path.dirname(dir);
    if (path.basename(parent).toLowerCase() === "aurora") return path.join(parent, ".backups");
  }
  if (process.platform !== "win32" && isFsRoot(drive.mount) && libs.length) return path.join(path.dirname(libs[0]), "Aurora", ".backups");
  return path.join(drive.mount, "Aurora", ".backups");
};

const targets = async () => {
  const drives = deps.drives();
  let list = [];
  try { list = await drives.list(); } catch { list = []; }
  const cfg = config();
  let mainOn = null;
  // (the daily backups switched off in config.json cover nothing)
  try { if (cfg.BACKUPS !== false) mainOn = drives.onPath(cfg.BACKUP_DIR); } catch {}
  return list.filter((d) => d.inUse && !d.gone).map((d) => {
    const covered = !!(mainOn && mainOn.drive && mainOn.drive.id === d.id);
    return { id: d.id, name: d.name, mount: d.mount, network: !!d.network, answering: d.answering !== false, paused: !!d.paused, free: d.free, total: d.total, covered, dir: covered ? cfg.BACKUP_DIR : dirFor(d) };
  });
};

// ---------- what (config.json without its secrets) ----------
const SECRET_KEY_RE = /(pass(word)?|secret|token|api[-_]?key|apikey|private[-_]?key|topic|credential)s?$/i;
const secretKeys = () => {
  try { return Object.entries(require("./configcheck").SCHEMA).filter(([, spec]) => spec[2] === true).map(([k]) => k); } catch { return ["adminPassword", "tmdbApiKey", "openrouterApiKey", "notifications", "healthPingUrl"]; }
};
// -> { buf, left: ["adminPassword", "passwordReset.email.smtp.user"…] } or { buf: null } when it does not parse
const stripSecrets = (raw) => {
  let cfg;
  try { cfg = JSON.parse(raw.toString("utf8")); } catch { return { buf: null, left: ["config.json (it could not be read, so it was left out)"] }; }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return { buf: null, left: ["config.json"] };
  const left = [];
  for (const k of secretKeys()) if (Object.prototype.hasOwnProperty.call(cfg, k)) { delete cfg[k]; left.push(k); }
  const sweep = (o, at) => {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      if (SECRET_KEY_RE.test(k) && typeof o[k] !== "object") { delete o[k]; left.push(at + k); continue; }
      sweep(o[k], `${at}${k}.`);
    }
  };
  sweep(cfg, "");
  return { buf: Buffer.from(JSON.stringify(cfg, null, 2) + "\n"), left };
};

// The archive, made once per round in a temporary folder.
const stage = async (now) => {
  const cfg = config();
  try { require("./jsonstore").flushAll(); } catch {}
  const dir = fs.mkdtempSync(path.join(deps.tmpdir(), "aurora-drive-copies-"));
  let left = [".env"];
  const snap = await backup.createSnapshot({
    dataDir: cfg.DATA_DIR,
    backupDir: dir,
    now,
    version: deps.version(),
    previousSummary: loadState().lastSummary || null,
    configFiles: [{ abs: path.join(cfg.ROOT, "config.json"), as: "config/config.json", transform: (raw) => { const r = stripSecrets(raw); left = [...left, ...r.left]; return r.buf; } }],
    manifestExtra: {
      kind: "drive-copy",
      get secretsLeftOut() { return left; },
      note: "A copy of the household's data from Aurora (src/lib/drivecopies.js). data/* goes into Aurora's data folder. config/config.json is the server's settings WITHOUT its secrets (the admin password, API keys, alert tokens) — put those back by hand; .env is not in this copy.",
    },
  });
  const buf = fs.readFileSync(snap.path);
  return { dir, path: snap.path, name: snap.name, size: snap.size, sha256: backup._internals.sha256(buf), warnings: snap.warnings, summary: snap.summary, secretsLeftOut: left };
};

const short = (e) => String((e && e.message) || e || "").slice(0, 300);
const copyRows = (copies) => (copies || []).slice(0, 20).map((c) => ({ name: c.name, size: c.size, createdAt: c.createdAt, ok: !!c.ok, error: c.ok ? null : c.error || "damaged", summary: c.summary || null, version: c.version || null, kind: c.kind || null }));

// One drive: the copy, its check, its rotation — in a child process.
const copyTo = async (t, staged, now) => {
  const rec = driveState(t.id);
  rec.lastAttemptAt = now;
  rec.dir = t.dir;
  const skip = (why, note) => { Object.assign(rec, { result: "skipped", why, note, error: null }); };
  if (t.paused) { skip("paused", "The drive is being tuned — tried again in half an hour."); return rec; }
  if (!t.answering) { skip("not-answering", "The drive isn't answering — tried again every half hour."); return rec; }
  const res = await deps.ask("backupCopy", { dir: t.dir, src: staged.path, sha256: staged.sha256, size: staged.size, now, keep: KEEP, noPrune: staged.warnings.length > 0 },
    { timeoutMs: t.network ? TIMEOUT.network : TIMEOUT.local, key: `${t.id}:drive-copy`, low: true });
  if (res && res.ok && res.result && res.result.ok) {
    const r = res.result;
    Object.assign(rec, { result: "ok", why: null, note: staged.warnings.length ? "Copied, but older copies were kept: this backup has warnings." : null, error: null, lastOkAt: now, lastName: r.name, lastSize: r.size, free: r.free, total: r.total, removed: r.removed || [], copies: copyRows(r.copies) });
  } else if (res && res.ok && res.result && res.result.skipped === "full") {
    skip("full", "The drive is full — no copy today; older copies are kept.");
    Object.assign(rec, { free: res.result.free, total: res.result.total, copies: copyRows(res.result.copies) });
  } else if (res && (res.timeout || res.busy)) {
    skip("not-answering", `The drive did not answer in ${Math.round((t.network ? TIMEOUT.network : TIMEOUT.local) / SEC)} s — tried again in half an hour.`);
  } else {
    Object.assign(rec, { result: "failed", why: null, note: null, error: short(res && res.error) || "the copy failed", lastFailedAt: now });
  }
  return rec;
};

const restoringNow = () => !!live.restoring || fs.existsSync(path.join(config().DATA_DIR, PENDING_FILE));

// A round: every drive whose copy is due (or every drive, `force`).
const run = ({ force = false, why = "the daily copy" } = {}) => {
  if (live.running) return live.running;
  live.running = (async () => {
    const now = deps.now();
    const { time } = getSettings();
    const all = (await targets()).filter((t) => !t.covered);
    const due = all.filter((t) => force || isDue(driveState(t.id), now, time));
    if (!due.length) return { made: 0, skipped: 0, failed: 0, drives: 0 };
    let staged;
    try {
      staged = await stage(now);
    } catch (e) {
      const st = loadState();
      st.lastRun = { at: now, ok: false, error: short(e), why };
      saveState();
      console.error(`[drive-copies] the copy could not be made: ${short(e)}`);
      throw e;
    }
    let made = 0; let skipped = 0; let failed = 0;
    try {
      for (const t of due) {
        if (restoringNow()) break; // (a restore was asked for meanwhile)
        const rec = await copyTo(t, staged, now);
        if (rec.result === "ok") made++;
        else if (rec.result === "skipped") skipped++;
        else failed++;
        saveState();
      }
    } finally {
      try { fs.rmSync(staged.dir, { recursive: true, force: true }); } catch {}
    }
    const st = loadState();
    if (made && !staged.warnings.length) st.lastSummary = staged.summary;
    st.lastRun = { at: now, ok: failed === 0, why, name: staged.name, size: staged.size, warnings: staged.warnings, made, skipped, failed, drives: due.length, secretsLeftOut: staged.secretsLeftOut };
    saveState();
    console.log(`[drive-copies] ${staged.name} (${Math.round(staged.size / 1024)} KB): copied to ${made} of ${due.length} drive(s)${skipped ? `, ${skipped} skipped` : ""}${failed ? `, ${failed} FAILED` : ""}`);
    judge(all, now);
    return st.lastRun;
  })().finally(() => { live.running = null; });
  return live.running;
};

// A health warning only for a copy that keeps FAILING (not a drive that is
// down or full: the drives card already says so, and that is not this).
const judge = (all, now) => {
  const s = getSettings();
  const bad = all.filter((t) => {
    const rec = driveState(t.id);
    if (rec.result !== "failed") return false;
    const since = rec.lastOkAt || s.enabledAt || now;
    return now - since >= ALERT_AFTER_MS;
  });
  deps.health((h) => {
    if (bad.length) h.raise("drive-copies", "warn", `The copy of the household's data could not be written to ${bad.map((t) => t.mount).join(", ")} for 3 days (${driveState(bad[0].id).error}). The older copies there are kept.`, "Backups");
    else h.clear("drive-copies", "The copies of the household's data on the drives are being written again.");
  });
};

// The timer's look: switched on, due, nobody watching, no restore, no other backup running.
const tick = async () => {
  const s = getSettings();
  if (!s.enabled) { live.waiting = null; return "off"; }
  if (live.running) return "running";
  if (restoringNow()) { live.waiting = "a restore is under way"; return "restoring"; }
  const now = deps.now();
  const all = (await targets()).filter((t) => !t.covered);
  if (!all.some((t) => isDue(driveState(t.id), now, s.time))) { live.waiting = null; return "not due"; }
  if (deps.watchingNow() > 0) { live.waiting = "someone is watching — the copy waits until nobody is"; return "watching"; }
  if (backup._internals.live.running) { live.waiting = "the daily backup is running"; return "busy"; }
  live.waiting = null;
  await run({ why: "the daily copy" }).catch(() => {});
  return "ran";
};

const start = () => {
  if (live.timer) return;
  const first = setTimeout(() => tick().catch(() => {}), 4 * MIN);
  first.unref?.();
  live.timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  live.timer.unref?.();
};
const stop = () => { if (live.timer) clearInterval(live.timer); live.timer = null; };

// "Make a copy now": every drive, whatever the clock says (but not during a restore).
const runNow = async () => {
  if (restoringNow()) return { error: "A restore is under way — no copies are made until it is done.", status: 409 };
  try {
    const r = await run({ force: true, why: "made by the admin" });
    return { ok: true, run: r };
  } catch (e) {
    return { error: `The copy could not be made: ${short(e)}`, status: 500 };
  }
};

// ---------- for the admin ----------
// The daily backups' own folder, each snapshot checked (remembered until the file changes).
const mainChecked = new Map(); // "name|size|mtime" -> { ok, error }
const mainCopies = async (dir) => {
  let snaps = [];
  try { snaps = await backup.list(dir); } catch {}
  const out = [];
  for (const s of snaps.slice(0, 30)) {
    const key = `${s.name}|${s.size}|${s.mtimeMs}`;
    if (!mainChecked.has(key)) { const v = await backup.verify(s.path); mainChecked.set(key, { ok: v.ok, error: v.ok ? null : v.error }); }
    const v = mainChecked.get(key);
    out.push({ name: s.name, size: s.size, createdAt: s.createdAt, verified: v.ok, error: v.error });
  }
  return out;
};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

const status = async () => {
  const s = getSettings();
  const cfg = config();
  const now = deps.now();
  const ts = await targets();
  const st = loadState();
  const main = await mainCopies(cfg.BACKUP_DIR);
  const drives = ts.map((t) => {
    if (t.covered) {
      const newest = main.find((m) => m.verified);
      return {
        id: t.id, name: t.name, mount: t.mount, network: t.network, dir: t.dir, covered: true, answering: t.answering,
        status: newest ? "ok" : "never", lastOkAt: newest ? newest.createdAt : null, lastSize: newest ? newest.size : null, lastName: newest ? newest.name : null,
        note: "The daily backups are on this drive already.",
        copies: main.slice(0, 20).map((m) => ({ name: m.name, size: m.size, createdAt: m.createdAt, ok: !!m.verified, error: m.verified ? null : m.error })),
      };
    }
    const rec = st.drives[t.id] || {};
    const status = rec.result === "ok" ? "ok" : rec.result === "failed" ? "failed" : rec.result === "skipped" ? "skipped" : "never";
    return {
      id: t.id, name: t.name, mount: t.mount, network: t.network, dir: t.dir, covered: false, answering: t.answering,
      status, why: rec.why || null, note: rec.note || null, error: rec.error || null,
      lastOkAt: rec.lastOkAt || null, lastAttemptAt: rec.lastAttemptAt || null, lastName: rec.lastName || null, lastSize: rec.lastSize || null,
      free: rec.free != null ? rec.free : t.free, total: rec.total != null ? rec.total : t.total,
      copies: rec.copies || [],
    };
  });
  let supervised = null;
  try { supervised = deps.supervisor().detect(); } catch {}
  const allDone = drives.filter((d) => !d.covered).every((d) => d.lastOkAt && d.lastOkAt >= latestScheduled(now, s.time));
  return {
    label: SWITCH_LABEL,
    enabled: s.enabled, time: s.time, enabledAt: s.enabledAt,
    serverClock: `${String(new Date(now).getHours()).padStart(2, "0")}:${String(new Date(now).getMinutes()).padStart(2, "0")}`,
    nextAt: s.enabled ? (allDone ? nextScheduled(now, s.time) : Math.max(now, latestScheduled(now, s.time))) : null,
    running: !!live.running, waiting: s.enabled ? live.waiting : null, restoring: restoringNow(),
    keep: KEEP, lastRun: st.lastRun || null,
    mainDir: cfg.BACKUP_DIR,
    drives,
    supervised,
    lastRestore: readJson(path.join(cfg.DATA_DIR, LAST_FILE)),
    confirmWord: CONFIRM_WORD,
  };
};

// "Check the copies": every drive's copies read back and checked again now.
const check = async () => {
  const ts = (await targets()).filter((t) => !t.covered);
  for (const t of ts) {
    const rec = driveState(t.id);
    if (!t.answering || t.paused) continue;
    const res = await deps.ask("backupList", { dir: t.dir }, { timeoutMs: TIMEOUT.list, key: `${t.id}:drive-copy`, low: true });
    if (res && res.ok) { rec.copies = copyRows(res.result.copies); rec.checkedAt = deps.now(); }
  }
  saveState();
  return status();
};

const locationOf = async (location) => {
  const cfg = config();
  const ts = await targets();
  if (location === MAIN) {
    const t = ts.find((x) => x.covered);
    return { id: MAIN, name: t ? `${t.name} (the daily backups)` : "The daily backups", dir: cfg.BACKUP_DIR, network: false, answering: true };
  }
  const t = ts.find((x) => x.id === location);
  if (!t) return null;
  if (t.covered) return { id: MAIN, name: `${t.name} (the daily backups)`, dir: cfg.BACKUP_DIR, network: false, answering: true };
  return t;
};

// "See what it holds": one copy, read back and checked, with its numbers and files.
const inspect = async ({ location, name } = {}) => {
  if (!backup._internals.isSnapshotName(name)) return { error: "That is not the name of a copy.", status: 400 };
  const loc = await locationOf(location);
  if (!loc) return { error: "That drive is not one Aurora uses — reload.", status: 404 };
  if (loc.answering === false) return { error: "That drive isn't answering right now.", status: 503 };
  const res = await deps.ask("backupInspect", { dir: loc.dir, name }, { timeoutMs: TIMEOUT.list, key: `${loc.id}:drive-copy-read`, low: true });
  if (!res || !res.ok) return { error: res && res.timeout ? "The drive did not answer in time." : `The copy could not be read: ${short(res && res.error)}`, status: 502 };
  const r = res.result;
  if (!r.ok) return { ok: false, location: loc.id, locationName: loc.name, name, createdAt: r.createdAt, size: r.size, damaged: true, error: `This copy is damaged: ${r.error}` };
  return { ok: true, location: loc.id, locationName: loc.name, name, createdAt: r.createdAt, size: r.size, version: r.manifest.version, host: r.manifest.host, kind: r.manifest.kind, summary: r.manifest.summary, warnings: r.manifest.warnings, secretsLeftOut: r.manifest.secretsLeftOut, files: r.manifest.files };
};

// Restore: fetched, checked, staged; the next start puts it in place
// (lib/restoreboot.js) — so no store of the running server can write its
// memory over it.
const restore = async ({ location, name, confirm } = {}) => {
  if (String(confirm || "").trim().toUpperCase() !== CONFIRM_WORD) return { error: `Nothing was restored — type ${CONFIRM_WORD} to confirm.`, status: 400 };
  let by = null;
  try { by = deps.supervisor().detect(); } catch {}
  if (!by) return { error: `${deps.supervisor().NOT_SUPERVISED} Nothing was restored: the server could not start again by itself. With Aurora stopped, run: node src/lib/backup.js restore-live <copy>.`, status: 409 };
  if (restoringNow()) return { error: "A restore is already under way.", status: 409 };
  if (live.running) return { error: "A copy is being written to the drives right now — try again in a minute.", status: 409 };
  if (backup._internals.live.running) return { error: "The daily backup is running right now — try again in a minute.", status: 409 };
  const look = await inspect({ location, name });
  if (look.error) return look;
  if (!look.ok) return { error: look.error, status: 409 };
  const cfg = config();
  live.restoring = { at: deps.now(), name, location: look.location };
  const pendingDir = path.join(cfg.DATA_DIR, PENDING_DIR);
  let requestedAt = null;
  try {
    fs.rmSync(pendingDir, { recursive: true, force: true });
    const loc = await locationOf(location);
    const dst = path.join(pendingDir, name);
    const res = await deps.ask("backupFetch", { dir: loc.dir, name, dst }, { timeoutMs: TIMEOUT.network, key: `${loc.id}:drive-copy-read`, low: true });
    if (!res || !res.ok) throw new Error(res && res.timeout ? "the drive did not answer in time" : short(res && res.error));
    const v = await backup.verify(dst);
    if (!v.ok) throw new Error(`the fetched copy failed its check: ${v.error}`);
    requestedAt = deps.now();
    require("./jsonstore").atomicWriteSync(path.join(cfg.DATA_DIR, PENDING_FILE), JSON.stringify({
      name, archive: path.join(PENDING_DIR, name), sha256: res.result.sha256, location: look.location, locationName: look.locationName,
      createdAt: look.createdAt, summary: look.summary, requestedAt, by,
    }, null, 1));
  } catch (e) {
    live.restoring = null;
    try { fs.rmSync(pendingDir, { recursive: true, force: true }); } catch {}
    return { error: `Nothing was restored: ${short(e)}`, status: 500 };
  }
  console.log(`[drive-copies] restore of ${name} from ${look.locationName} staged by the admin — restarting through ${by}`);
  deps.restartSoon(`restore of ${name} from a backup`);
  return { ok: true, restarting: true, by, name, createdAt: look.createdAt, summary: look.summary, requestedAt };
};

module.exports = {
  start, stop, tick, run, runNow, status, check, inspect, restore, getSettings, setSettings,
  SWITCH_LABEL, CONFIRM_WORD, KEEP,
  deps,
  _internals: { live, latestScheduled, nextScheduled, isDue, dirFor, stripSecrets, targets, stage, copyTo, loadState, judge, RETRY_MS, PENDING_FILE, LAST_FILE, PENDING_DIR, reset: () => { live.state = null; live.running = null; live.waiting = null; live.restoring = null; } },
};
