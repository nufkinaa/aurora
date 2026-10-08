// Backups: one small archive a day of everything this household would lose
// if the data folder went away — who the profiles are, what they watched and
// where they stopped, their lists and follows, sign-ins, settings, download
// history, usage stats, and the server's own config.json / .env.
//
// READ THIS FIRST. By default the snapshots are written to data/backups —
// the SAME DISK as the data they copy. That protects against a file going
// corrupt, a bad update, or somebody deleting a profile by mistake. It does
// NOT protect against losing the disk or the machine. Point "backupDir" in
// config.json (or AURORA_BACKUP_DIR) at another drive, a NAS share, or a
// folder that Dropbox / OneDrive / Syncthing carries elsewhere: THAT is what
// makes it a real backup.
//
// The archive holds config.json and .env, so it holds the admin password and
// the API keys. Treat a snapshot like those files.
//
// ---------------------------------------------------------------- format
// aurora-backup-YYYYMMDD-HHMMSS.tar.gz (UTC) — a plain gzip'd ustar archive,
// written by the ~60 lines below with no dependency, so it opens with
// `tar -xzf`, 7-Zip, or a double click on any desktop, with or without
// Aurora. Inside:
//   manifest.json        app version, when, and every file with its size
//                        and sha256
//   data/<file>          the stores, exactly as they were on disk
//   data/usage/…         usage logs
//   data/avatars/…       uploaded profile pictures
//   config/config.json   the server's configuration
//   config/.env          its secrets
//
// ------------------------------------------------------- what is copied
// Every top-level *.json in the data folder EXCEPT the ones listed in
// EXCLUDE_FILES (caches of things the server can work out again), plus the
// folders in INCLUDE_DIRS. "Everything except" on purpose: a store added
// next year is backed up without anyone remembering to list it here. Today
// that means:
//   profiles.json         profiles, PINs/passwords, progress, watchlists,
//                         follows, kids settings, language memory
//   sessions.json         who is signed in on which device
//   settings.json         admin-panel settings (sign-in mode, speed caps…)
//   push.json             Web Push keys and each device's subscription
//   bans.json             banned addresses
//   downloads.json        the download queue and its history
//   requests.json         title requests            (when present)
//   reports.json          problem reports           (when present)
//   intros.json           intro marks set by hand
//   intro-auto.json       detected intros/credits (hours of CPU to redo)
//   imdb-map.json         title → IMDb id matches (tiny; saves re-asking)
//   watch-history.json    the admin's "who watched what" log
//   watch-sessions.json   viewing sessions (analytics)
//   telemetry-hours.json  90 days of hourly load
//   usage/*.jsonl         usage events
//   avatars/*             profile pictures
//   ../config.json, ../.env
// NOT copied (all rebuilt by the server on its own):
//   cache/**              posters, stills, blur placeholders, image
//                         variants, HLS/JIT segments, phone copies,
//                         torrent metadata, catalogue caches (hundreds of MB)
//   metadata-cache.json   ffprobe results     online-metadata.json  fetched art/synopses
//   ocr-failed.json       OCR retry memory    daily.json            when the daily round last ran
//   watchdog.json / health.json               process bookkeeping
//   aria2/**              the downloader's DHT table
//   backups/**            (the snapshots themselves)
//   *.log, *.tmp, *.bak-*, *.corrupt-*        logs and leftovers
//   the media library and anything being downloaded
//
// ------------------------------------------------------------ retention
// Kept: one a day for the last 7 days, then one a week for the 4 weeks
// before those, then one a month for the 3 months before those — fourteen
// files reaching back about three months — plus anything made in the last
// 24 hours. The newest snapshot is never deleted, and only files named like
// a snapshot are ever touched. See prune().
//
// -------------------------------------------------------------- restore
// restore() only ever unpacks into a NEW, empty folder. Putting it back is
// done by hand, with the server stopped:
//   1. node src/lib/backup.js list
//   2. node src/lib/backup.js verify  aurora-backup-20261008-031500.tar.gz
//   3. node src/lib/backup.js restore aurora-backup-20261008-031500.tar.gz C:\aurora-restore
//   4. Stop Aurora (pm2 stop aurora, or close its window).
//   5. Rename data → data.before-restore (keep it until all is well).
//   6. Make a new data folder and copy everything from
//      C:\aurora-restore\data into it. (To keep the posters and other
//      caches rather than have them fetched again, move
//      data.before-restore\cache into the new data folder too.)
//   7. Only when config.json / .env were lost as well: copy them from
//      C:\aurora-restore\config next to server.js.
//   8. Start Aurora. It rebuilds its caches as pages are opened.
// To bring back a single file (say profiles.json), do steps 1-4 and copy
// just that file over the one in data.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { promisify } = require("util");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const FORMAT = "aurora-backup";
const FORMAT_VERSION = 1;
const NAME_RE = /^aurora-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.tar\.gz$/;
const PARTIAL_RE = /^\.aurora-backup-\d{8}-\d{6}\.tar\.gz\.partial$/;
const EXCLUDE_FILES = new Set([
  "metadata-cache.json",
  "online-metadata.json",
  "ocr-failed.json",
  "daily.json",
  "watchdog.json",
  "health.json",
]);
const INCLUDE_DIRS = ["usage", "avatars"];
const MAX_TOTAL_BYTES = 1024 ** 3; // a snapshot is built in memory; state is kilobytes, not this
const DEFAULT_KEEP = { daily: 7, weekly: 4, monthly: 3 };
const DAY_MS = 24 * 3600 * 1000;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------- tar

const octal = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";

// Split a path over ustar's name (100 bytes) + prefix (155 bytes) fields.
const splitName = (name) => {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  let cut = name.indexOf("/");
  while (cut !== -1) {
    const prefix = name.slice(0, cut);
    const rest = name.slice(cut + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest) return { name: rest, prefix };
    cut = name.indexOf("/", cut + 1);
  }
  return null;
};

const tarHeader = (entryName, size, mtimeMs) => {
  const parts = splitName(entryName);
  if (!parts) throw new Error(`name too long for the archive: ${entryName}`);
  const h = Buffer.alloc(512);
  h.write(parts.name, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii");
  h.write(octal(0, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(Math.max(0, Math.floor(mtimeMs / 1000)), 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii"); // checksum counts as spaces while summing
  h.write("0", 156, 1, "ascii"); // a regular file
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.write(parts.prefix, 345, 155, "utf8");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
};

// entries: [{ name, data: Buffer, mtime }] -> one tar Buffer
const tarPack = (entries) => {
  const out = [];
  for (const e of entries) {
    out.push(tarHeader(e.name, e.data.length, e.mtime || Date.now()));
    out.push(e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) out.push(Buffer.alloc(pad));
  }
  out.push(Buffer.alloc(1024)); // end of archive: two empty blocks
  return Buffer.concat(out);
};

const cstr = (buf, start, len) => {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString("utf8");
};

// tar Buffer -> [{ name, data }]. Throws on anything that is not a clean
// archive of plain files (a damaged header, a size past the end).
const tarUnpack = (buf) => {
  const entries = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) return entries; // end marker
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    const want = parseInt(cstr(h, 148, 8).trim(), 8);
    if (!Number.isFinite(want) || want !== sum) throw new Error(`damaged archive (bad header at byte ${off})`);
    const size = parseInt(cstr(h, 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0 || off + 512 + size > buf.length) throw new Error("damaged archive (a file runs past the end)");
    const type = String.fromCharCode(h[156] || 48);
    const prefix = cstr(h, 345, 155);
    const name = (prefix ? `${prefix}/` : "") + cstr(h, 0, 100);
    if (type === "0") entries.push({ name, data: buf.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("damaged archive (no end marker — the file is cut short)");
};

// ------------------------------------------------------------- naming

const pad2 = (n) => String(n).padStart(2, "0");
const nameFor = (ms) => {
  const d = new Date(ms);
  return `aurora-backup-${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}.tar.gz`;
};
// The time a snapshot's NAME says it was made (ms), or null when the name is
// not a snapshot's.
const timeOf = (name) => {
  const m = NAME_RE.exec(String(name));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(t);
  // 20261340-… is not a date; Date.UTC would quietly roll it over
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return t;
};
const isSnapshotName = (name) => timeOf(name) !== null;

// ---------------------------------------------------------- retention

// Which snapshots stay. Pure: `list` is [{ name, createdAt? }] (createdAt
// defaults to the time in the name), `now` is ms. Returns { keep, remove } as
// arrays of names, newest first. Anything not named like a snapshot is in
// neither list — it is not ours to judge.
//
// Kept: the newest; everything under a day old (a snapshot taken by hand
// before something risky is not replaced by that night's); anything dated in
// the future (a clock that jumped — never delete on a guess); and, walking
// from newest to oldest, the newest snapshot of each of the last `daily`
// days, then of `weekly` further weeks (Monday-based), then of `monthly`
// further months. "Further": a week or month whose newest snapshot an
// earlier rule already keeps does not use up a place (borg's rule, not
// restic's), so 7/4/3 really is fourteen snapshots reaching back three
// months, not eleven reaching back two. Days, weeks and months are counted
// among those THAT HAVE a snapshot — a server that was off for a month keeps
// its last seven dailies, not nothing.
const prune = (list, now = Date.now(), keepRule = {}) => {
  const rule = { ...DEFAULT_KEEP };
  for (const k of Object.keys(DEFAULT_KEEP)) {
    const v = Number(keepRule && keepRule[k]);
    if (Number.isFinite(v) && v >= 0) rule[k] = Math.floor(v);
  }
  const snaps = [];
  for (const it of list || []) {
    const name = it && it.name;
    const fromName = timeOf(name);
    if (fromName === null) continue;
    snaps.push({ name, at: Number.isFinite(it.createdAt) ? it.createdAt : fromName });
  }
  snaps.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  const keep = new Set(); // by the daily / weekly / monthly rules
  const dayOf = (t) => Math.floor(t / DAY_MS);
  const buckets = [
    [rule.daily, (t) => dayOf(t)],
    [rule.weekly, (t) => Math.floor((dayOf(t) + 3) / 7)], // 1970-01-01 was a Thursday
    [rule.monthly, (t) => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }],
  ];
  for (const [count, keyOf] of buckets) {
    const earlier = new Set(keep);
    let taken = 0;
    let lastKey = null;
    for (const s of snaps) {
      if (taken >= count) break;
      if (s.at > now) continue;
      const k = keyOf(s.at);
      if (k === lastKey) continue; // not this period's newest
      lastKey = k;
      if (earlier.has(s.name)) continue; // already kept; this period costs nothing
      keep.add(s.name);
      taken++;
    }
  }
  // on top of the rules, never counted against them
  if (snaps.length) keep.add(snaps[0].name);
  for (const s of snaps) {
    if (s.at > now || now - s.at < DAY_MS) keep.add(s.name);
  }
  return {
    keep: snaps.filter((s) => keep.has(s.name)).map((s) => s.name),
    remove: snaps.filter((s) => !keep.has(s.name)).map((s) => s.name),
  };
};

// ------------------------------------------------------------ collect

const walk = async (abs, rel, out) => {
  let entries;
  try { entries = await fs.promises.readdir(abs, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    if (/\.(tmp|partial)$/i.test(e.name)) continue;
    const childAbs = path.join(abs, e.name);
    const childRel = `${rel}/${e.name}`;
    if (e.isDirectory()) await walk(childAbs, childRel, out);
    else if (e.isFile()) out.push({ abs: childAbs, as: `data/${childRel}` });
  }
};

// The files a snapshot of `dataDir` takes: [{ abs, as }].
const collect = async (dataDir, configFiles = []) => {
  const out = [];
  let top = [];
  try { top = await fs.promises.readdir(dataDir, { withFileTypes: true }); } catch {}
  top.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of top) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".json")) continue;
    if (EXCLUDE_FILES.has(e.name.toLowerCase())) continue;
    out.push({ abs: path.join(dataDir, e.name), as: `data/${e.name}` });
  }
  for (const dir of INCLUDE_DIRS) await walk(path.join(dataDir, dir), dir, out);
  for (const c of configFiles) {
    try {
      if ((await fs.promises.stat(c.abs)).isFile()) out.push({ abs: c.abs, as: c.as });
    } catch {}
  }
  return out;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------- create / verify

// Check an archive against its own manifest: every listed file present, the
// right size, the right sha256, and nothing in the archive the manifest does
// not know. { ok, manifest, files, bytes } or { ok: false, error }.
const verifyBuffer = async (gz) => {
  let entries;
  try {
    entries = tarUnpack(await gunzip(gz));
  } catch (e) {
    return { ok: false, error: `cannot be read: ${e.message}` };
  }
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const raw = byName.get("manifest.json");
  if (!raw) return { ok: false, error: "no manifest.json inside" };
  let manifest;
  try { manifest = JSON.parse(raw.toString("utf8")); } catch { return { ok: false, error: "manifest.json is not valid JSON" }; }
  if (!manifest || manifest.format !== FORMAT || !Array.isArray(manifest.files)) return { ok: false, error: "not an Aurora backup" };
  let bytes = 0;
  for (const f of manifest.files) {
    const data = byName.get(f.path);
    if (!data) return { ok: false, error: `${f.path} is missing from the archive` };
    if (data.length !== f.size) return { ok: false, error: `${f.path} is ${data.length} bytes, the manifest says ${f.size}` };
    if (sha256(data) !== f.sha256) return { ok: false, error: `${f.path} does not match its checksum` };
    bytes += data.length;
  }
  const known = new Set(manifest.files.map((f) => f.path));
  for (const name of byName.keys()) {
    if (name !== "manifest.json" && !known.has(name)) return { ok: false, error: `${name} is in the archive but not in its manifest` };
  }
  return { ok: true, manifest, files: manifest.files.length, bytes, entries: byName };
};

const verify = async (archivePath) => {
  let gz;
  try { gz = await fs.promises.readFile(archivePath); } catch (e) { return { ok: false, error: `cannot be opened: ${e.message}` }; }
  const r = await verifyBuffer(gz);
  if (r.ok) delete r.entries;
  return r;
};

// Make one snapshot of `dataDir` in `backupDir`. Each file is read ONCE into
// memory and the checksum is taken from those same bytes, so a store that is
// saved again while the snapshot is being built cannot make the archive
// disagree with its manifest — the snapshot simply holds the version it read.
// (JsonStore replaces files by rename, so a read never sees half a file.)
// The archive is written under a temporary name, read back and checked, and
// only then given its real name: a file named like a snapshot has always
// passed its check once.
//
// opts: { dataDir, backupDir, configFiles?, version?, now?, hooks? }
// returns { name, path, size, files, bytes, warnings, manifest }
const createSnapshot = async (opts) => {
  const { dataDir, backupDir } = opts;
  if (!dataDir || !backupDir) throw new Error("dataDir and backupDir are required");
  const now = opts.now || Date.now();
  const hooks = opts.hooks || {};
  const wanted = await collect(dataDir, opts.configFiles || []);
  const entries = [];
  const files = [];
  const warnings = [];
  let total = 0;
  for (const w of wanted) {
    let data;
    let st;
    try {
      data = await fs.promises.readFile(w.abs);
      st = await fs.promises.stat(w.abs);
    } catch (e) {
      if (e.code !== "ENOENT") warnings.push(`${w.as} could not be read (${e.code || e.message})`);
      continue; // gone between listing and reading: it was being replaced or removed
    }
    // A store that does not parse is copied all the same (it may be all there
    // is), but said out loud: the caller must not rotate good snapshots away
    // to make room for copies of a broken file.
    if (/^data\/[^/]+\.json$/.test(w.as) && data.length) {
      let ok = true;
      try { JSON.parse(data.toString("utf8")); } catch { ok = false; }
      if (!ok) {
        await sleep(250); // a writer that does not rename could be mid-save
        try {
          const again = await fs.promises.readFile(w.abs);
          JSON.parse(again.toString("utf8"));
          data = again;
          ok = true;
        } catch {}
      }
      if (!ok) warnings.push(`${w.as} is not valid JSON — it was copied as it is`);
    }
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("the state to back up is over 1 GB — something that is not state is in the data folder");
    if (!splitName(w.as)) { warnings.push(`${w.as} has a name too long to archive — skipped`); total -= data.length; continue; }
    files.push({ path: w.as, size: data.length, sha256: sha256(data), mtime: new Date(st.mtimeMs).toISOString() });
    entries.push({ name: w.as, data, mtime: st.mtimeMs });
    if (hooks.afterRead) await hooks.afterRead(w);
  }
  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    app: "aurora",
    version: opts.version || null,
    createdAt: new Date(now).toISOString(),
    host: os.hostname(),
    platform: process.platform,
    note: "data/* goes into Aurora's data folder, config/* next to server.js. See src/lib/backup.js for the restore steps.",
    warnings,
    files,
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
  const gz = await gzip(tarPack([{ name: "manifest.json", data: manifestBuf, mtime: now }, ...entries]), { level: 9 });

  await fs.promises.mkdir(backupDir, { recursive: true });
  const name = nameFor(now);
  const final = path.join(backupDir, name);
  if (fs.existsSync(final)) throw new Error(`${name} already exists`);
  const partial = path.join(backupDir, `.${name}.partial`);
  try {
    await fs.promises.writeFile(partial, gz);
    if (hooks.afterWrite) await hooks.afterWrite(partial);
    const check = await verify(partial); // from the disk, not from memory
    if (!check.ok) throw Object.assign(new Error(`the new snapshot failed its check: ${check.error}`), { verifyFailed: true });
    await fs.promises.rename(partial, final);
  } catch (e) {
    try { await fs.promises.unlink(partial); } catch {}
    throw e;
  }
  return { name, path: final, size: gz.length, files: files.length, bytes: total, warnings, manifest };
};

// Every snapshot in `backupDir`, newest first. Files with any other name are
// not listed (and so can never be pruned, served or restored through here).
const list = async (backupDir) => {
  let names = [];
  try { names = await fs.promises.readdir(backupDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const createdAt = timeOf(name);
    if (createdAt === null) continue;
    try {
      const st = await fs.promises.stat(path.join(backupDir, name));
      if (!st.isFile()) continue;
      out.push({ name, path: path.join(backupDir, name), size: st.size, createdAt, mtimeMs: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
};

// Delete what the retention rule no longer keeps, and half-written leftovers
// older than an hour. Returns the names removed.
const applyRetention = async (backupDir, now = Date.now(), keepRule = {}) => {
  const snaps = await list(backupDir);
  const { remove } = prune(snaps, now, keepRule);
  const removed = [];
  for (const name of remove) {
    if (!isSnapshotName(name)) continue; // belt and braces
    try { await fs.promises.unlink(path.join(backupDir, name)); removed.push(name); } catch {}
  }
  try {
    for (const name of await fs.promises.readdir(backupDir)) {
      if (!PARTIAL_RE.test(name)) continue;
      const abs = path.join(backupDir, name);
      try { if (now - (await fs.promises.stat(abs)).mtimeMs > 3600 * 1000) await fs.promises.unlink(abs); } catch {}
    }
  } catch {}
  return removed;
};

// ------------------------------------------------------------ restore

// Unpack a snapshot into a NEW folder — one that does not exist yet, or is
// empty. Never into live data: swapping it in is the manual procedure at the
// top of this file, done with the server stopped. The archive is checked
// first; a damaged one unpacks nothing.
const restore = async (archivePath, { into } = {}) => {
  if (!into) throw new Error("restore needs a folder to unpack into");
  const target = path.resolve(into);
  let existing = null;
  try { existing = await fs.promises.readdir(target); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (existing && existing.length) throw new Error(`${target} is not empty — restore only unpacks into a new folder`);
  const gz = await fs.promises.readFile(archivePath);
  const check = await verifyBuffer(gz);
  if (!check.ok) throw new Error(`this snapshot is damaged (${check.error}) — nothing was unpacked`);
  const names = ["manifest.json", ...check.manifest.files.map((f) => f.path)];
  for (const name of names) {
    // names come from a file: nothing may climb out of the target folder
    if (!name || name.includes("\\") || name.includes("\0") || path.posix.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) {
      throw new Error(`unsafe path in the archive: ${name}`);
    }
    const abs = path.resolve(target, ...name.split("/"));
    if (abs !== target && !abs.startsWith(target + path.sep)) throw new Error(`unsafe path in the archive: ${name}`);
  }
  await fs.promises.mkdir(target, { recursive: true });
  for (const name of names) {
    const abs = path.resolve(target, ...name.split("/"));
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, check.entries.get(name));
  }
  return { into: target, files: check.manifest.files.length, bytes: check.bytes, manifest: check.manifest };
};

// ------------------------------------------- the live server's side

const live = {
  running: null, // the snapshot in flight (a promise), so two never overlap
  last: null, // { at, ok, name?, error?, warnings?, removed? }
  verified: new Map(), // "name|size|mtime" -> { ok, error? } (for the admin list)
};

const liveOpts = () => {
  const config = require("../config");
  let version = null;
  try { version = require("../../package.json").version; } catch {}
  return {
    dataDir: config.DATA_DIR,
    backupDir: config.BACKUP_DIR,
    version,
    configFiles: [
      { abs: path.join(config.ROOT, "config.json"), as: "config/config.json" },
      { abs: path.join(config.ROOT, ".env"), as: "config/.env" },
    ],
  };
};

// Do the data folder and the backup folder sit on the same volume? (When
// they do, the backup does not survive the disk.) null when it can't be told.
const sameVolume = (a, b) => {
  try {
    const up = (p) => { let cur = path.resolve(p); while (!fs.existsSync(cur) && path.dirname(cur) !== cur) cur = path.dirname(cur); return cur; };
    return fs.statSync(up(a)).dev === fs.statSync(up(b)).dev;
  } catch {
    return null;
  }
};

const tellHealth = (fn) => { try { fn(require("./health")); } catch {} };

// Snapshot the live data folder now. `prune: true` also applies retention —
// unless the snapshot carries warnings (a store that no longer parses): then
// nothing is rotated away, because an older snapshot may hold the last good
// copy.
const createNow = ({ prune: doPrune = true } = {}) => {
  if (live.running) return live.running;
  live.running = (async () => {
    const config = require("../config");
    const opts = liveOpts();
    try {
      // Stores save 1.5 s after a change; write the pending ones first so the
      // snapshot holds what the server knows. flushAll is synchronous and
      // only touches stores with a save already scheduled.
      try { require("./jsonstore").flushAll(); } catch {}
      const snap = await createSnapshot(opts);
      let removed = [];
      if (doPrune && !snap.warnings.length) removed = await applyRetention(opts.backupDir, Date.now(), config.BACKUP_KEEP);
      live.last = { at: Date.now(), ok: true, name: snap.name, size: snap.size, files: snap.files, warnings: snap.warnings, removed };
      console.log(`[backup] ${snap.name} — ${snap.files} files, ${(snap.size / 1024).toFixed(0)} KB, verified${removed.length ? `; removed ${removed.length} old` : ""}`);
      if (snap.warnings.length) {
        console.error(`[backup] ${snap.name} has warnings: ${snap.warnings.join("; ")}`);
        tellHealth((h) => h.raise("backup-failed", "critical",
          `The latest backup found a damaged file (${snap.warnings[0]}). Older backups were kept and may hold the last good copy — look at this before more time passes.`, "Backups"));
      } else {
        tellHealth((h) => h.clear("backup-failed", "Backups are working again: a new one was made and verified."));
      }
      return live.last;
    } catch (e) {
      const error = String((e && e.message) || e).slice(0, 300);
      live.last = { at: Date.now(), ok: false, error };
      console.error(`[backup] failed: ${error}`);
      tellHealth((h) => h.raise("backup-failed", "critical",
        `The backup could not be made (${error}). The previous backups are untouched. Check that the backup folder (${opts.backupDir}) is reachable and has room.`, "Backups"));
      throw e;
    } finally {
      live.running = null;
    }
  })();
  return live.running;
};

// The admin's list: each snapshot with its size, date, and whether it passes
// its check NOW (re-read from disk; remembered until the file changes).
const listVerified = async () => {
  const config = require("../config");
  const snaps = await list(config.BACKUP_DIR);
  const out = [];
  const liveKeys = new Set();
  for (const s of snaps) {
    const key = `${s.name}|${s.size}|${s.mtimeMs}`;
    liveKeys.add(key);
    if (!live.verified.has(key)) {
      const r = await verify(s.path);
      live.verified.set(key, { ok: r.ok, error: r.ok ? null : r.error, files: r.ok ? r.files : null, version: r.ok ? r.manifest.version : null });
    }
    const v = live.verified.get(key);
    out.push({ name: s.name, size: s.size, createdAt: s.createdAt, verified: v.ok, error: v.error, files: v.files, version: v.version });
  }
  for (const k of [...live.verified.keys()]) if (!liveKeys.has(k)) live.verified.delete(k);
  return out;
};

// When the newest snapshot that passes its check was made (ms), or null.
const newestVerifiedAt = async () => {
  for (const s of await listVerified()) if (s.verified) return s.createdAt;
  return null;
};

// The absolute path of a snapshot to hand out, or null. The name has to BE
// one of the names in the folder's listing — it is never joined to a path on
// trust — so "..", separators, drive letters and the rest never reach fs.
const pathForDownload = async (name) => {
  if (typeof name !== "string" || !isSnapshotName(name)) return null;
  const config = require("../config");
  const hit = (await list(config.BACKUP_DIR)).find((s) => s.name === name);
  return hit ? hit.path : null;
};

const status = async () => {
  const config = require("../config");
  const same = sameVolume(config.DATA_DIR, config.BACKUP_DIR);
  return {
    enabled: config.BACKUPS,
    dir: config.BACKUP_DIR,
    sameDiskAsData: same,
    advice: same === false
      ? null
      : "These backups sit on the same disk as the data they copy. They guard against a damaged file or a mistake, not against losing the disk — set \"backupDir\" in config.json to another drive, a NAS or a synced folder.",
    keep: { ...DEFAULT_KEEP, ...(config.BACKUP_KEEP || {}) },
    running: !!live.running,
    last: live.last,
    snapshots: await listVerified(),
  };
};

// The daily round's task (lib/daily.js). Throwing makes daily retry it at
// its next hourly check.
const runDaily = async () => {
  const config = require("../config");
  if (!config.BACKUPS) return "switched off (\"backups\": false)";
  const r = await createNow({ prune: true });
  return `${r.name}, ${r.files} files, ${(r.size / 1024).toFixed(0)} KB${r.warnings.length ? `, ${r.warnings.length} warning(s)` : ""}`;
};

module.exports = {
  createSnapshot, verify, restore, list, prune, applyRetention,
  createNow, listVerified, newestVerifiedAt, pathForDownload, status, runDaily,
  _internals: { tarPack, tarUnpack, splitName, nameFor, timeOf, isSnapshotName, collect, sameVolume, EXCLUDE_FILES, INCLUDE_DIRS, DEFAULT_KEEP, NAME_RE, live },
};

// ---------------------------------------------------------------- CLI
//   node src/lib/backup.js list
//   node src/lib/backup.js create
//   node src/lib/backup.js verify  <file or snapshot name>
//   node src/lib/backup.js restore <file or snapshot name> <new folder>
// Safe to run beside a live server: `create` reads the stores as they are on
// disk (at most 1.5 s behind the server's memory) and never writes to them.
if (require.main === module) {
  (async () => {
    const [cmd, a, b] = process.argv.slice(2);
    const config = require("../config");
    const resolveArchive = (x) => (x && !/[\\/]/.test(x) && isSnapshotName(x) ? path.join(config.BACKUP_DIR, x) : path.resolve(String(x || "")));
    if (cmd === "list") {
      const snaps = await list(config.BACKUP_DIR);
      console.log(`Backups in ${config.BACKUP_DIR}:`);
      if (!snaps.length) console.log("  (none yet)");
      for (const s of snaps) console.log(`  ${s.name}  ${(s.size / 1024).toFixed(0).padStart(7)} KB  ${new Date(s.createdAt).toISOString()}`);
    } else if (cmd === "create") {
      const snap = await createSnapshot(liveOpts());
      console.log(`Wrote ${snap.path} — ${snap.files} files, ${(snap.size / 1024).toFixed(0)} KB, verified.`);
      for (const w of snap.warnings) console.log(`  warning: ${w}`);
    } else if (cmd === "verify" && a) {
      const r = await verify(resolveArchive(a));
      console.log(r.ok ? `OK — ${r.files} files, ${r.bytes} bytes, made ${r.manifest.createdAt} by Aurora ${r.manifest.version || "?"}` : `FAILED — ${r.error}`);
      if (!r.ok) process.exitCode = 1;
    } else if (cmd === "restore" && a && b) {
      const r = await restore(resolveArchive(a), { into: b });
      console.log(`Unpacked ${r.files} files into ${r.into}.`);
      console.log("Nothing live was touched. To put it back: stop Aurora, rename data to data.before-restore,");
      console.log(`copy ${path.join(r.into, "data")} to a new data folder, start Aurora. (Full steps: top of src/lib/backup.js.)`);
    } else {
      console.log("usage: node src/lib/backup.js list | create | verify <file> | restore <file> <new folder>");
      process.exitCode = 1;
    }
  })().catch((e) => {
    console.error(`backup: ${e.message}`);
    process.exit(1);
  });
}
