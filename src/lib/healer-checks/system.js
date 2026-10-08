// The slow-moving things around the server: the library folders and the
// files in them, backups, the state of the code on disk, whether alerts can
// still get out, the clock, and how fast Aurora's own records are growing.
//
// As in stats.js, the `judge…`/pure functions decide and are unit-tested;
// the `check…` functions gather. Anything that walks a folder or opens files
// goes through ctx.slowly (the healer's every-few-minutes cache), so a round
// stays a matter of milliseconds.
"use strict";
const fs = require("fs");
const path = require("path");
const { fmtBytes, fmtAge, plural, pressFor } = require("./util");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const slowlyOr = (ctx) => ctx.slowly || ((id, fn) => fn());

// ------------------------------------------------------------ library folders

// observed: [{ kind, dir, ok, entries, indexed }] — `entries` is how many
// things the folder holds now, `indexed` how many titles the library has
// from it. prev: { dir: { ok, since } } (persisted, mutated here).
//   missing     the folder cannot be read at all
//   suspicious  it reads as EMPTY while the library has titles from it —
//               what an unmounted drive's mount point looks like. NEVER
//               "the library is empty".
//   back        it was missing last time and is fine now
// "Away" is sticky: once a folder has been seen missing or suspiciously
// empty it stays away while it is empty — a library scan in the meantime
// drops its titles from the index, and that must not turn "the drive is
// unplugged" into "all is well, the folder is just empty". It ends when the
// folder has something in it again, or after a week (then it really is empty).
const EMPTY_ACCEPTED_MS = 7 * 24 * 3600 * 1000;
const judgeRoots = (prev, observed, now) => {
  const out = { missing: [], suspicious: [], back: [], fine: [] };
  for (const r of observed) {
    const was = prev[r.dir];
    const stillAway = !!was && was.ok === false && now - (was.since || now) < EMPTY_ACCEPTED_MS;
    const emptyButIndexed = r.ok && r.entries === 0 && (r.indexed > 0 || stillAway);
    const good = r.ok && !emptyButIndexed;
    const seen = { ...r, indexed: r.indexed || (was && was.indexed) || 0 };
    if (!r.ok) out.missing.push(seen);
    else if (emptyButIndexed) out.suspicious.push(seen);
    else out.fine.push(r);
    if (good && was && was.ok === false && r.entries > 0) out.back.push({ ...r, awayMs: now - (was.since || now) });
    if (!was || was.ok !== good) prev[r.dir] = { ok: good, since: now, indexed: seen.indexed };
    else if (!good && seen.indexed > (was.indexed || 0)) was.indexed = seen.indexed;
  }
  for (const dir of Object.keys(prev)) if (!observed.some((r) => r.dir === dir)) delete prev[dir];
  return out;
};

// files: [{ name, root, size, mtimeMs, duration, exists }] for what the index
// holds. A file under a folder that is away is not judged at all.
//   gone       in the index, not on disk (its folder IS readable)
//   empty      zero bytes
//   truncated  too small to be a video, or far too small for its length
// A file changed in the last ten minutes may still be copying: left alone.
const TINY = 64 * 1024;
const judgeFiles = (files, awayRoots, now) => {
  const away = new Set(awayRoots);
  const out = { gone: [], empty: [], truncated: [], checked: 0 };
  for (const f of files) {
    if (away.has(f.root)) continue;
    out.checked++;
    if (!f.exists) { out.gone.push(f.name); continue; }
    if (now - (f.mtimeMs || 0) < 10 * MIN) continue;
    if (f.size === 0) out.empty.push(f.name);
    else if (f.size < TINY || (f.duration >= 60 && f.size / f.duration < 3000)) out.truncated.push(f.name);
  }
  return out;
};

const statSoon = (p, ms = 3000) =>
  Promise.race([fs.promises.stat(p).catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);
const readdirSoon = (p, ms = 3000) =>
  Promise.race([fs.promises.readdir(p).catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);

// Every video file the index holds, with what the disk says about it.
// Bounded (a library of tens of thousands of episodes is not stat'ed whole).
const gatherFiles = async (scanner, roots, budget = 6000) => {
  const items = [];
  for (const m of scanner.index.movies || []) items.push(m);
  for (const s of scanner.index.shows || []) for (const se of s.seasons || []) for (const ep of se.episodes || []) items.push(ep);
  const out = [];
  let n = 0;
  for (const it of items) {
    if (n++ >= budget) break;
    const e = scanner.resolve(it.id);
    if (!e) continue;
    const root = (roots.find((r) => require("../libroots").isUnder(e.path, [r.dir])) || {}).dir || null;
    const st = await fs.promises.stat(e.path).catch(() => null);
    out.push({ name: path.basename(e.path), root, size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0, duration: it.duration || 0, exists: !!st });
    if (n % 200 === 0) await new Promise((r) => setImmediate(r));
  }
  return out;
};

// Top-level folders of a library folder that hold video files, none of which
// the index knows: a film or a show copied in and not picked up. Folders
// touched since the last scan are simply "not scanned yet" and wait.
const gatherUnscanned = async (scanner, roots, config, olderThanMs) => {
  const exts = (config.VIDEO_EXTENSIONS || [".mkv", ".mp4"]).map((x) => x.toLowerCase());
  const isVideo = (name) => exts.includes(path.extname(name).toLowerCase());
  const out = [];
  let budget = 4000;
  for (const r of roots) {
    const top = await fs.promises.readdir(r.dir, { withFileTypes: true }).catch(() => []);
    for (const d of top) {
      if (!d.isDirectory() || d.name.startsWith(".") || budget <= 0) continue;
      const dir = path.join(r.dir, d.name);
      const vids = [];
      const walk = async (p, depth) => {
        const ents = await fs.promises.readdir(p, { withFileTypes: true }).catch(() => []);
        for (const e of ents) {
          if (budget-- <= 0) return;
          if (e.isFile() && isVideo(e.name)) vids.push(path.join(p, e.name));
          else if (e.isDirectory() && depth < 2 && !e.name.startsWith(".")) await walk(path.join(p, e.name), depth + 1);
        }
      };
      await walk(dir, 0);
      if (!vids.length || vids.some((v) => scanner.idForPath(v))) continue;
      const st = await fs.promises.stat(vids[0]).catch(() => null);
      if (st && Date.now() - st.mtimeMs > olderThanMs) out.push(d.name);
    }
  }
  return out;
};

const checkLibrary = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  const config = ctx.config || require("../../config");
  const st = ctx.store || require("./store").get();
  const scanner = ctx.scanner || require("../../media/scanner");
  const roots = ctx.roots || require("../libroots").roots();
  if (!roots.length) return { status: "info", summary: "no library folders are configured" };
  // every round: can each folder be read, and does it hold anything?
  const observed = [];
  for (const r of roots) {
    const s = await statSoon(r.dir);
    const names = s && s.isDirectory() ? await readdirSoon(r.dir) : null;
    const indexed = ((r.kind === "movies" ? scanner.index.movies : scanner.index.shows) || []).filter((it) => {
      const e = scanner.resolve(it.id) || (it.seasons && it.seasons[0] && it.seasons[0].episodes[0] && scanner.resolve(it.seasons[0].episodes[0].id));
      return e && require("../libroots").isUnder(e.path, [r.dir]);
    }).length;
    observed.push({ kind: r.kind, dir: r.dir, ok: !!names, entries: names ? names.filter((n) => !n.startsWith(".")).length : 0, indexed });
  }
  const before = JSON.stringify(st.data.roots);
  const j = judgeRoots(st.data.roots, observed, now);
  if (JSON.stringify(st.data.roots) !== before) st.save();
  const findings = [];
  const healed = [];
  let quiet = true; // an unreachable folder is already announced by the health alerts (Disk)
  for (const r of j.missing) {
    findings.push({ level: "fail", title: "A library folder is not there", text: `The ${r.kind} folder ${r.dir} cannot be read — the drive is unplugged, asleep or not mounted. Nothing on it can be played until it is back. Its titles are NOT deleted: progress, watch history and the downloads list are kept, and the library is rescanned the moment the folder returns.`, evidence: `${plural(r.indexed, "title")} in the library come from it`, setting: "Plug the drive back in (or wake / mount it). Nothing else is needed." });
  }
  for (const r of j.suspicious) {
    quiet = false; // health sees a readable folder here and says nothing
    findings.push({ level: "fail", title: "A library folder looks empty", text: `The ${r.kind} folder ${r.dir} can be opened but is EMPTY, while the library has ${plural(r.indexed, "title")} from it. That is what a drive that is not mounted looks like. It is being treated as a missing drive, not as a library somebody emptied.`, evidence: `0 entries on disk, ${r.indexed} in the library`, setting: "Mount the drive. If you really did empty the folder, press Rescan the library.", press: pressFor("rescan") });
  }
  for (const r of j.back) {
    const f = { level: "info", title: "A library folder is back", text: `The ${r.kind} folder ${r.dir} is readable again after ${fmtAge(r.awayMs)}.` };
    if (ctx.repair) {
      const rep = ctx.repair("rescan", { subject: r.dir, why: `${r.dir} came back after ${fmtAge(r.awayMs)}` });
      f.did = rep.sentence;
      if (rep.ran) healed.push(`rescanned the library (${r.dir} came back)`);
      else f.press = rep.press;
    }
    findings.push(f);
  }
  // every few minutes: the files themselves
  const away = [...j.missing, ...j.suspicious].map((r) => r.dir);
  const deep = await slowlyOr(ctx)("library-files", async () => {
    const readable = roots.filter((r) => !away.includes(r.dir));
    const files = ctx.files || await gatherFiles(scanner, roots);
    const verdict = judgeFiles(files, away, Date.now());
    let unscanned = [];
    try { unscanned = ctx.unscanned || await gatherUnscanned(scanner, readable, config, 2 * (config.SCAN_INTERVAL_MS || 10 * MIN) + MIN); } catch {}
    return { ...verdict, unscanned };
  }, 10 * MIN);
  const list = (a) => `${a.slice(0, 4).map((n) => `“${n}”`).join(", ")}${a.length > 4 ? ` and ${a.length - 4} more` : ""}`;
  if (deep.gone.length) findings.push({ level: "warn", title: "Files in the library that are no longer on disk", text: `${list(deep.gone)} ${deep.gone.length === 1 ? "is" : "are"} listed in the library but the file is gone (its folder is fine). They will fail to play until the library is rescanned.`, evidence: plural(deep.gone.length, "file"), press: pressFor("rescan") });
  if (deep.empty.length) findings.push({ level: "warn", title: "Empty video files", text: `${list(deep.empty)} ${deep.empty.length === 1 ? "is" : "are"} zero bytes long — a copy or a download that never wrote anything.`, evidence: plural(deep.empty.length, "file"), setting: "Delete the file and get it again (Downloads → request it)." });
  if (deep.truncated.length) findings.push({ level: "warn", title: "Video files that look cut short", text: `${list(deep.truncated)} ${deep.truncated.length === 1 ? "is" : "are"} far too small for a video of that length — probably a copy that was interrupted.`, evidence: plural(deep.truncated.length, "file"), setting: "Replace the file with a complete copy." });
  if (deep.unscanned.length) findings.push({ level: "warn", title: "New folders the library has not picked up", text: `${list(deep.unscanned)} ${deep.unscanned.length === 1 ? "has" : "have"} video files in ${deep.unscanned.length === 1 ? "it" : "them"} but ${deep.unscanned.length === 1 ? "is" : "are"} not in the library after two scans.`, evidence: plural(deep.unscanned.length, "folder"), press: pressFor("rescan") });
  const status = findings.some((f) => f.level === "fail") ? "fail" : findings.some((f) => f.level === "warn") ? "warn" : "ok";
  const bad = j.missing.length + j.suspicious.length;
  return {
    status, quiet,
    summary: bad
      ? `${bad} of ${roots.length} library folders ${bad === 1 ? "is" : "are"} away: ${[...j.missing, ...j.suspicious].map((r) => r.dir).join(", ")}`
      : `${plural(roots.length, "library folder")} readable · ${plural(deep.checked, "file")} checked: ${deep.gone.length} gone, ${deep.empty.length + deep.truncated.length} damaged, ${deep.unscanned.length} not yet in the library`,
    findings, healed: healed.join("; ") || null,
  };
};

// ------------------------------------------------------------ backups

// x: { enabled, newestAt, newestVerified, newestOkAt, sameDisk, maxAgeH, count }
const judgeBackups = (x, now) => {
  if (!x.enabled) return { status: "info", stale: false, text: "switched off in config.json (\"backups\": false)" };
  if (!x.count) return { status: "ok", stale: false, none: true, text: "no backup has been made yet" };
  const age = now - (x.newestOkAt || 0);
  const stale = !x.newestOkAt || age > x.maxAgeH * HOUR;
  return { status: stale || x.newestVerified === false ? "warn" : "ok", stale, age, broken: x.newestVerified === false, text: null };
};

const checkBackups = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  const config = ctx.config || require("../../config");
  const st = ctx.store || require("./store").get();
  const x = ctx.backup || await slowlyOr(ctx)("backups", async () => {
    const backup = require("../backup");
    if (!config.BACKUPS) return { enabled: false };
    const list = await backup.listVerified();
    const newest = list[0] || null;
    const ok = list.find((s) => s.verified) || null;
    let maxAgeH = 48;
    try { maxAgeH = require("../health")._internals.thresholds(config.HEALTH || {}).backupMaxAgeHours; } catch {}
    return { enabled: true, count: list.length, newestAt: newest ? newest.createdAt : null, newestVerified: newest ? !!newest.verified : null, newestName: newest ? newest.name : null, newestOkAt: ok ? ok.createdAt : null, sameDisk: backup._internals.sameVolume(config.DATA_DIR, config.BACKUP_DIR), maxAgeH };
  }, 10 * MIN);
  const j = judgeBackups(x, now);
  if (j.text && !j.none) return { status: j.status, summary: j.text, quiet: true };
  const findings = [];
  let healed = null;
  if (j.none) {
    // first day of a new server: the daily round makes one; nothing to say yet
    return { status: "ok", summary: j.text, quiet: true };
  }
  if (j.broken) findings.push({ level: "warn", title: "The newest backup is damaged", text: `The newest snapshot (${x.newestName}) does not pass its check — a file inside does not match its checksum. An older good one is ${x.newestOkAt ? `${fmtAge(now - x.newestOkAt)} old` : "not available"}.`, evidence: "checksum mismatch", press: pressFor("backup-now") });
  if (j.stale) {
    const f = { level: "warn", title: "The backups are old", text: `The newest working backup is ${x.newestOkAt ? `${fmtAge(j.age)} old` : "missing"}; one should be made every day (the line is ${x.maxAgeH} hours).`, evidence: `${plural(x.count, "snapshot")} in the folder` };
    if (ctx.repair) {
      const r = ctx.repair("backup-now", { subject: "stale", why: `the newest working backup is ${x.newestOkAt ? fmtAge(j.age) : "missing"} (line: ${x.maxAgeH} h)` });
      f.did = r.sentence;
      if (r.ran) { healed = "started a backup"; if (ctx.forget) ctx.forget("backups"); }
      else f.press = r.press;
    } else f.press = pressFor("backup-now");
    findings.push(f);
  }
  // same disk as the data: worth knowing, said ONCE as a finding, then only in the summary
  if (x.sameDisk !== false && !st.data.notes.backupSameDisk) {
    st.data.notes.backupSameDisk = now;
    st.save();
    findings.push({ level: "info", title: "Backups share a disk with the data", text: "The backup folder is on the same disk as the data it copies. That protects against a damaged file or a mistake, not against losing the disk.", setting: "Set \"backupDir\" in config.json to another drive, a NAS or a synced folder. (Said once; it stays in the summary.)" });
  }
  return {
    status: j.status, quiet: true, // health alerts already announce a stale backup
    summary: `newest working backup ${x.newestOkAt ? `${fmtAge(now - x.newestOkAt)} old` : "missing"} · newest snapshot ${x.newestVerified ? "passes its check" : "FAILS its check"} · ${plural(x.count, "snapshot")}${x.sameDisk !== false ? " · on the same disk as the data" : " · on a different disk from the data"}`,
    findings, healed,
  };
};

// ------------------------------------------------------------ update state

// What package-lock.json says should be installed against what npm recorded
// as installed (node_modules/.package-lock.json, which npm rewrites on every
// install). Developer-only packages are skipped — the server installs with
// --omit=dev — and so are optional ones. Returns the names out of step.
// Why this and not file dates: a `git pull` touches package-lock.json only
// when it changed, but a checkout or a copy resets every date; versions do
// not lie either way.
const lockDrift = (lock, installed) => {
  const want = (lock && lock.packages) || {};
  const have = (installed && installed.packages) || null;
  if (!have) return null; // never installed with a modern npm: nothing to compare
  const out = [];
  for (const [p, meta] of Object.entries(want)) {
    if (!p || !p.startsWith("node_modules/") || !meta || meta.dev || meta.optional || meta.devOptional || meta.peer) continue;
    const got = have[p];
    if (!got) out.push(`${p.slice(13)} (missing)`);
    else if (meta.version && got.version && meta.version !== got.version) out.push(`${p.slice(13)} (${got.version} installed, ${meta.version} wanted)`);
  }
  return out;
};

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
let driftMemo = { key: "", drift: null };
const gatherDrift = (root) => {
  const a = path.join(root, "package-lock.json");
  const b = path.join(root, "node_modules", ".package-lock.json");
  let key = "";
  try { key = `${fs.statSync(a).mtimeMs}|${fs.existsSync(b) ? fs.statSync(b).mtimeMs : 0}`; } catch { return null; }
  if (key === driftMemo.key) return driftMemo.drift;
  const drift = lockDrift(readJson(a), readJson(b));
  driftMemo = { key, drift };
  return drift;
};

// Is the small fix to the torrent library in place? (tools/patch-webtorrent.js
// writes the marker; an `npm install` puts the unpatched file back.)
const patchApplied = (root) => {
  try { return /AURORA-PATCH/.test(fs.readFileSync(path.join(root, "node_modules", "webtorrent", "lib", "torrent.js"), "utf8")); } catch { return null; }
};

// x: { available, behind, restartNeeded, running, local, offline, drift: [..]|null, patched: true|false|null }
const judgeUpdates = (x) => {
  const findings = [];
  if (x.restartNeeded) findings.push({ level: "warn", title: "A restart is pending", text: `The code on disk is newer than the code that is running (${String(x.running || "").slice(0, 7)} is running, ${String(x.local || "").slice(0, 7)} is on disk). Fixes that were pulled are not live until Aurora restarts.`, evidence: "running commit ≠ on-disk commit", press: pressFor("restart") });
  if (x.drift && x.drift.length) findings.push({ level: "warn", title: "Dependencies are out of step", text: `${plural(x.drift.length, "package")} in node_modules ${x.drift.length === 1 ? "does" : "do"} not match package-lock.json: ${x.drift.slice(0, 4).join(", ")}${x.drift.length > 4 ? "…" : ""}. An update changed the dependencies and they were not installed.`, evidence: `${x.drift.length} out of step`, press: pressFor("npm-install") });
  if (x.available) findings.push({ level: "info", title: "An update is available", text: `GitHub has a newer version${x.behind ? ` (${plural(x.behind, "commit")} ahead of this server)` : ""}.`, press: pressFor("update-all") });
  return findings;
};

const checkUpdates = async (ctx = {}) => {
  const config = ctx.config || require("../../config");
  const x = ctx.update || await slowlyOr(ctx)("updates", async () => {
    const uc = require("../updatecheck");
    const r = await uc.check(false); // its own cache: GitHub is asked once an hour at most
    let behind = null;
    if (r.available && r.remote) {
      // only when that commit is already here (after a fetch); never a fetch from this check
      const n = await uc._internals.git(["rev-list", "--count", `HEAD..${r.remote}`]);
      if (n && /^\d+$/.test(n)) behind = Number(n);
    }
    return { available: !!r.available, behind, restartNeeded: !!r.restartNeeded, running: r.running, local: r.local, offline: r.error === "offline", drift: gatherDrift(config.ROOT), patched: require("../torrentgate").enabled() ? patchApplied(config.ROOT) : null };
  });
  const findings = judgeUpdates(x);
  let healed = null;
  if (x.patched === false) {
    const f = { level: "warn", title: "The download engine's patch is missing", text: "The small fix Aurora applies to its torrent library is not in place — an install put the original file back. Without it, streaming from a torrent can wedge under load. Once re-applied it takes effect at the next restart.", evidence: "no AURORA-PATCH marker in node_modules/webtorrent/lib/torrent.js" };
    if (ctx.repair) {
      const r = ctx.repair("patch-webtorrent", { subject: "missing", why: "the patch marker is missing from the installed torrent library" });
      f.did = r.sentence;
      if (r.ran) { healed = "re-applied the download engine patch (live after a restart)"; if (ctx.forget) ctx.forget("updates"); }
      else f.press = r.press;
    } else f.press = pressFor("patch-webtorrent");
    findings.push(f);
  }
  const bits = [
    x.offline ? "GitHub could not be asked" : x.available ? `an update is available${x.behind ? ` (${x.behind} commits)` : ""}` : "up to date with GitHub",
    x.restartNeeded ? "restart pending" : "running the code that is on disk",
    x.drift == null ? "dependencies not comparable" : x.drift.length ? `${x.drift.length} dependencies out of step` : "dependencies match the lock file",
  ];
  return { status: findings.some((f) => f.level === "warn") ? "warn" : "ok", summary: bits.join(" · "), findings, healed };
};

// ------------------------------------------------------------ alert delivery

// channels: ["ntfy", …]; outcomes: { ntfy: { lastOkAt, lastFailAt, lastError, failsInARow } }
// push: { ok, fail, gone, subs }
const judgeDelivery = (channels, outcomes, push, now) => {
  const findings = [];
  if (!channels.length) {
    findings.push({ level: "info", title: "Alerts have nowhere to go", text: "No alert channel is set up, so nobody is told when something breaks — it only shows on this page.", setting: "Add \"notifications\": { \"ntfy\": { \"topic\": \"…\" } } (or Telegram) to config.json." });
  }
  for (const ch of channels) {
    const o = outcomes[ch];
    if (!o || (!o.lastOkAt && !o.lastFailAt)) continue;
    if (o.lastFailAt > (o.lastOkAt || 0)) {
      findings.push({ level: "warn", title: `Alerts through ${ch} are failing`, text: `The last alert sent through ${ch} did not get out (${o.lastError || "no reason given"}), ${fmtAge(now - o.lastFailAt)} ago${o.lastOkAt ? `; the last one that did was ${fmtAge(now - o.lastOkAt)} ago` : "; none has ever got through since the server started keeping count"}. If something breaks now, you may not hear about it.`, evidence: `${o.failsInARow || 1} failed in a row`, setting: "Check \"notifications\" in config.json, then prove it:", press: pressFor("notify-test") });
    }
  }
  if (push && push.fail >= 5 && push.fail > push.ok) {
    findings.push({ level: "warn", title: "Phone notifications are failing in bulk", text: `${push.fail} of the last ${push.fail + push.ok} notifications to phones and browsers failed in the last day.`, evidence: `${push.ok} sent, ${push.fail} failed, ${push.gone} subscriptions dropped`, setting: "Look at the Clock line, and set \"pushContact\" in config.json to \"mailto:you@example.com\"." });
  }
  return findings;
};

const checkDelivery = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  const st = ctx.store || require("./store").get();
  const notify = ctx.notify || require("../notify");
  const channels = notify.channels();
  // what this process saw, over what the last one left behind
  const seen = notify.outcomes ? notify.outcomes() : {};
  const known = st.data.delivery;
  let changed = false;
  for (const [ch, o] of Object.entries(seen)) {
    const k = known[ch] || {};
    const next = { lastOkAt: Math.max(o.lastOkAt || 0, k.lastOkAt || 0), lastFailAt: Math.max(o.lastFailAt || 0, k.lastFailAt || 0), lastError: o.lastFailAt >= (k.lastFailAt || 0) ? o.lastError : k.lastError, failsInARow: o.failsInARow };
    if (JSON.stringify(next) !== JSON.stringify(k)) { known[ch] = next; changed = true; }
  }
  if (changed) st.save();
  const signals = ctx.signals || require("../signals");
  const tally = signals.byKey("push", DAY, now);
  const push = { ok: tally.get("ok") || 0, gone: tally.get("gone") || 0, fail: [...tally].filter(([k]) => k.startsWith("fail:")).reduce((n, [, c]) => n + c, 0), subs: 0 };
  try { push.subs = ctx.subs != null ? ctx.subs : (require("../push")._internals.store.data.subs || []).length; } catch {}
  const findings = judgeDelivery(channels, known, push, now);
  const chLine = channels.length
    ? channels.map((ch) => { const o = known[ch]; return !o || (!o.lastOkAt && !o.lastFailAt) ? `${ch}: nothing sent yet` : o.lastFailAt > (o.lastOkAt || 0) ? `${ch}: last send FAILED ${fmtAge(now - o.lastFailAt)} ago` : `${ch}: last sent ${fmtAge(now - o.lastOkAt)} ago`; }).join(" · ")
    : "no alert channel";
  return {
    status: findings.some((f) => f.level === "warn") ? "warn" : channels.length ? "ok" : "info",
    summary: `${chLine} · push: ${plural(push.subs, "device")}, ${push.ok} sent and ${push.fail} failed in 24 h`,
    findings,
  };
};

// ------------------------------------------------------------ clock

// skews: [ms] — (a server's Date header) − (this machine's clock), from
// HTTPS answers the healer already had (its Upstream check). The median, so
// one provider with a wrong clock does not decide. Date headers are whole
// seconds, so anything under a few seconds is noise.
const judgeClock = (skews) => {
  const s = (skews || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return { status: "info", skewMs: null };
  const skewMs = s[Math.floor(s.length / 2)];
  const off = Math.abs(skewMs);
  return { status: off > 120000 ? "fail" : off > 45000 ? "warn" : "ok", skewMs };
};

const checkClock = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  const reading = ctx.reading === undefined ? null : ctx.reading; // { skews, at }
  if (!reading || !reading.skews || !reading.skews.length || now - reading.at > 30 * MIN) {
    return { status: "info", summary: "no reading yet — the clock is compared with the Upstream check's answers, and none has arrived" };
  }
  const j = judgeClock(reading.skews);
  const sec = Math.round(Math.abs(j.skewMs) / 1000);
  const dir = j.skewMs > 0 ? "behind" : "ahead";
  if (j.status === "ok") return { status: "ok", summary: `within ${Math.max(sec, 1)} s of the outside world (${reading.skews.length} answers compared)` };
  return {
    status: j.status,
    summary: `the server's clock is ${fmtSkew(sec)} ${dir}`,
    findings: [{ level: j.status, title: "The server's clock is wrong", text: `This machine's clock is ${fmtSkew(sec)} ${dir} of the real time. More than about two minutes breaks notifications to phones (their signature expires) and sign-in with Google.`, evidence: `${j.skewMs > 0 ? "+" : "−"}${sec} s against ${reading.skews.length} outside servers`, setting: "Windows: Settings → Time & language → Date & time → Sync now (and switch on “Set time automatically”). Linux: timedatectl set-ntp true." }],
  };
};
const fmtSkew = (sec) => (sec >= 120 ? `${Math.round(sec / 60)} minutes` : `${sec} seconds`);

// ------------------------------------------------------------ data growth

// What is "big" for each kind of thing Aurora keeps.
const SANE = { store: 25 * 1024 ** 2, usage: 120 * 1024 ** 2, log: 200 * 1024 ** 2, perf: 20 * 1024 ** 2 };

// samples: [{ at, bytes }] oldest first. Fast = grew by half AND by 5 MB in a day.
const growthOf = (samples, now) => {
  const s = (samples || []).filter((x) => now - x.at <= DAY + HOUR);
  if (s.length < 2 || now - s[0].at < 6 * HOUR) return { fast: false, perDay: null };
  const first = s[0];
  const last = s[s.length - 1];
  const perDay = ((last.bytes - first.bytes) / Math.max(1, last.at - first.at)) * DAY;
  return { fast: perDay >= 5 * 1024 ** 2 && first.bytes > 0 && perDay / first.bytes >= 0.5, perDay };
};

// items: [{ name, kind, bytes }]; history: { name: [{at, bytes}] } (mutated: one sample an hour, two days kept)
const judgeGrowth = (items, history, now) => {
  const big = [];
  const fast = [];
  for (const it of items) {
    const h = history[it.name] || (history[it.name] = []);
    if (!h.length || now - h[h.length - 1].at >= HOUR) h.push({ at: now, bytes: it.bytes });
    while (h.length > 50) h.shift();
    if (it.bytes > (SANE[it.kind] || SANE.store)) big.push(it);
    const g = growthOf(h, now);
    if (g.fast) fast.push({ ...it, perDay: g.perDay });
  }
  for (const k of Object.keys(history)) if (!items.some((i) => i.name === k)) delete history[k];
  return { big, fast };
};

const folderBytes = async (dir, budget = { left: 5000 }) => {
  let total = 0;
  const ents = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of ents) {
    if (budget.left-- <= 0) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(p, budget);
    else { const st = await fs.promises.stat(p).catch(() => null); if (st) total += st.size; }
  }
  return total;
};

const checkGrowth = async (ctx = {}) => {
  const now = ctx.now || Date.now();
  const config = ctx.config || require("../../config");
  const st = ctx.store || require("./store").get();
  const r = await slowlyOr(ctx)("growth", async () => {
    const items = ctx.items ? ctx.items.slice() : [];
    if (!ctx.items) {
      const names = await fs.promises.readdir(config.DATA_DIR).catch(() => []);
      for (const f of names) {
        const kind = /\.json$/.test(f) ? "store" : /\.log$/.test(f) ? "log" : null;
        if (!kind) continue;
        const s = await fs.promises.stat(path.join(config.DATA_DIR, f)).catch(() => null);
        if (s && s.isFile()) items.push({ name: f, kind, bytes: s.size });
      }
      items.push({ name: "usage/", kind: "usage", bytes: await folderBytes(path.join(config.DATA_DIR, "usage")) });
      items.push({ name: "cache/perf/", kind: "perf", bytes: await folderBytes(path.join(config.CACHE_DIR, "perf")) });
    }
    // the one thing here that is DESIGNED to be trimmed: usage keeps three
    // monthly files; older months are deleted (lib/usage.js prune)
    let trimmed = null;
    try {
      const usage = ctx.usage || require("../usage");
      const before = (await fs.promises.readdir(usage.DIR).catch(() => [])).filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f)).length;
      if (before > (usage.KEEP_MONTHS || 3)) { usage.prune(); trimmed = `deleted ${plural(before - (usage.KEEP_MONTHS || 3), "old month")} of usage statistics (three are kept)`; }
    } catch {}
    const j = judgeGrowth(items, st.data.growth, Date.now());
    st.save();
    return { items, ...j, trimmed };
  }, 30 * MIN);
  const findings = [];
  for (const it of r.big) {
    findings.push({
      level: "warn", title: `${it.name} is large`, text: it.kind === "log"
        ? `${it.name} has grown to ${fmtBytes(it.bytes)}. It is written by whatever starts Aurora (pm2 or a start script), not by Aurora — the healer does not touch it.`
        : it.kind === "usage"
          ? `The usage statistics folder holds ${fmtBytes(it.bytes)}. Each month is capped at 30 MB and only three months are kept, so this should not happen.`
          : `${it.name} is ${fmtBytes(it.bytes)}. It is rewritten whole on every save, so saving gets slower as it grows.`,
      evidence: fmtBytes(it.bytes),
      setting: it.kind === "log" ? "Stop Aurora, delete or rotate the file, start it again (pm2: pm2 flush)." : "Nothing to press — tell whoever maintains Aurora; this file should not get this big.",
    });
  }
  for (const it of r.fast) {
    if (r.big.some((b) => b.name === it.name)) continue;
    findings.push({ level: "warn", title: `${it.name} is growing fast`, text: `${it.name} is growing by about ${fmtBytes(it.perDay)} a day (now ${fmtBytes(it.bytes)}).`, evidence: `${fmtBytes(it.perDay)} per day`, setting: it.kind === "log" ? "Something is logging in a loop — Server → Logs says what." : "Server → Logs may say what is writing so much." });
  }
  const total = r.items.reduce((n, i) => n + i.bytes, 0);
  const top = r.items.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 3).map((i) => `${i.name} ${fmtBytes(i.bytes)}`).join(", ");
  return {
    status: findings.length ? "warn" : "ok",
    summary: `${fmtBytes(total)} of records, statistics and logs${top ? ` (${top})` : ""}`,
    findings, healed: r.trimmed,
  };
};

module.exports = {
  checkLibrary, checkBackups, checkUpdates, checkDelivery, checkClock, checkGrowth,
  _internals: { judgeRoots, judgeFiles, judgeBackups, lockDrift, judgeUpdates, judgeDelivery, judgeClock, growthOf, judgeGrowth, patchApplied, gatherDrift, SANE },
};
