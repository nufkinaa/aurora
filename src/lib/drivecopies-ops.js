// The part of "a copy of the household's data on every drive" that touches a
// drive (lib/drivecopies.js) — run inside lib/drives/probe-child.js, in its
// OWN process with a deadline and the lowest CPU / I/O priority, never in the
// server: a network drive that stops answering then holds this process, not
// the server's thread pool.
//
//   backupCopy    { dir, src, sha256, size, now, keep, noPrune }
//                 put the staged archive `src` into `dir`: written as a
//                 .partial, fsync'd, read back and checked (the whole file's
//                 sha256, then every file inside against the manifest), only
//                 then renamed to its name — and only then are older copies
//                 rotated away (never on a failed copy, never with noPrune)
//   backupList    { dir }          every copy in `dir`, each checked
//   backupInspect { dir, name }    one copy: checked, with what it holds
//   backupFetch   { dir, name, dst }  one copy, copied to `dst` and checked there
//
// Only names like aurora-backup-YYYYMMDD-HHMMSS.tar.gz are ever read, listed,
// rotated or deleted (lib/backup.js NAME_RE): nothing else in the folder is
// ours to touch.
"use strict";
const fs = require("fs");
const path = require("path");
const backup = require("./backup");

const { sha256, verifyBufferSync, NAME_RE, PARTIAL_RE, timeOf } = backup._internals;
const DAY_MS = 24 * 3600 * 1000;
const DAMAGED_KEPT_MS = 35 * DAY_MS; // a damaged copy is shown, then goes once it is past every window
const PARTIAL_OLD_MS = 3600 * 1000;
// room a copy needs beyond its own size (a drive that full is "full")
const SLACK_BYTES = 8 * 1024 * 1024;

const deps = {
  statfs: (dir) => {
    // (test seam: folders that say they are full)
    const fake = process.env.AURORA_DRIVECOPIES_FAKE_FULL;
    if (fake && path.resolve(dir).toLowerCase().startsWith(path.resolve(fake).toLowerCase())) return { free: 0, total: 1e9 };
    const s = fs.statfsSync(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  },
  afterWrite: null,
  hide: (dir) => {
    // the folder is hidden: a leading dot does it on Linux and macOS; Windows needs the attribute
    if (process.platform !== "win32") return;
    try { require("child_process").spawnSync("attrib", ["+h", dir], { windowsHide: true, timeout: 5000 }); } catch {}
  },
};

const fsyncDir = (dir) => {
  if (process.platform === "win32") return;
  try { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch {}
};

const goodName = (name) => typeof name === "string" && NAME_RE.test(name) && timeOf(name) !== null;

// One copy, checked from the disk.
const checkFile = (abs, name) => {
  let st;
  let buf;
  try { st = fs.statSync(abs); buf = fs.readFileSync(abs); } catch (e) { return { name, ok: false, error: `cannot be read (${e.code || e.message})` }; }
  const r = verifyBufferSync(buf);
  const base = { name, size: st.size, createdAt: timeOf(name), mtimeMs: st.mtimeMs, sha256: sha256(buf) };
  if (!r.ok) return { ...base, ok: false, error: r.error };
  const m = r.manifest;
  return { ...base, ok: true, version: m.version || null, files: m.files.length, summary: m.summary || null, madeAt: m.createdAt || null, secretsLeftOut: Array.isArray(m.secretsLeftOut) ? m.secretsLeftOut : null, kind: m.kind || null };
};

const copiesIn = (dir) => {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!goodName(name)) continue;
    out.push(checkFile(path.join(dir, name), name));
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
};

const spaceOf = (dir) => { try { return deps.statfs(dir); } catch { return { free: null, total: null }; } };

// Rotation, over the copies that pass their check only: a damaged copy never
// holds a daily or weekly place (it would push a good one out), and is left
// where it is — shown as damaged — until it is older than every window.
const rotate = (dir, now, keep) => {
  const copies = copiesIn(dir);
  const good = copies.filter((c) => c.ok);
  const { remove } = backup.prune(good, now, keep);
  const removed = [];
  for (const name of remove) {
    if (!goodName(name)) continue;
    try { fs.unlinkSync(path.join(dir, name)); removed.push(name); } catch {}
  }
  for (const c of copies) {
    if (c.ok || !goodName(c.name) || !(now - c.createdAt > DAMAGED_KEPT_MS)) continue;
    // (only when a newer good copy exists: the last of anything is never thrown away)
    if (!good.some((g) => g.createdAt > c.createdAt)) continue;
    try { fs.unlinkSync(path.join(dir, c.name)); removed.push(c.name); } catch {}
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!PARTIAL_RE.test(name)) continue;
      const abs = path.join(dir, name);
      try { if (now - fs.statSync(abs).mtimeMs > PARTIAL_OLD_MS) fs.unlinkSync(abs); } catch {}
    }
  } catch {}
  return removed;
};

const writeChecked = (buf, partial, final, wantSha) => {
  const fd = fs.openSync(partial, "w");
  try {
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (deps.afterWrite) deps.afterWrite(partial); // (test seam: a drive that changes what it was given)
  // read back FROM THE DRIVE: the whole file's checksum, then every file in it
  const back = fs.readFileSync(partial);
  if (back.length !== buf.length || sha256(back) !== wantSha) throw Object.assign(new Error("the copy on the drive does not match the original (its checksum differs)"), { verifyFailed: true });
  const v = verifyBufferSync(back);
  if (!v.ok) throw Object.assign(new Error(`the copy on the drive failed its check: ${v.error}`), { verifyFailed: true });
  fs.renameSync(partial, final);
  fsyncDir(path.dirname(final));
};

const backupCopy = ({ dir, src, sha256: wantSha, size, now = Date.now(), keep = { daily: 7, weekly: 4, monthly: 0 }, noPrune = false }) => {
  const name = path.basename(String(src || ""));
  if (!goodName(name)) throw new Error("not a backup's name");
  const fresh = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  if (fresh) deps.hide(dir);
  const space = spaceOf(dir);
  const need = (Number(size) || 0) * 2 + SLACK_BYTES;
  if (space.free != null && space.free < need) return { skipped: "full", free: space.free, total: space.total, copies: copiesIn(dir) };
  const buf = fs.readFileSync(src);
  if (sha256(buf) !== wantSha) throw new Error("the staged backup changed before it was copied");
  const final = path.join(dir, name);
  const partial = path.join(dir, `.${name}.partial`);
  if (fs.existsSync(final)) {
    // the same copy already there (a retry after a lost answer): fine when it is the same bytes
    const c = checkFile(final, name);
    if (!(c.ok && c.sha256 === wantSha)) throw new Error(`${name} is already on the drive and is not this copy`);
  } else {
    try {
      writeChecked(buf, partial, final, wantSha);
    } catch (e) {
      try { fs.unlinkSync(partial); } catch {}
      if (e && (e.code === "ENOSPC" || e.code === "EDQUOT")) return { skipped: "full", free: spaceOf(dir).free, total: space.total, copies: copiesIn(dir) };
      throw e;
    }
  }
  const removed = noPrune ? [] : rotate(dir, now, keep);
  const after = spaceOf(dir);
  return { ok: true, name, size: buf.length, removed, free: after.free, total: after.total, copies: copiesIn(dir) };
};

const backupList = ({ dir }) => {
  const space = fs.existsSync(dir) ? spaceOf(dir) : { free: null, total: null };
  return { copies: copiesIn(dir), free: space.free, total: space.total };
};

const backupInspect = ({ dir, name }) => {
  if (!goodName(name)) throw new Error("not a backup's name");
  const abs = path.join(dir, name);
  const c = checkFile(abs, name);
  if (!c.ok) return c;
  const v = verifyBufferSync(fs.readFileSync(abs));
  const m = v.manifest;
  return { ...c, manifest: { createdAt: m.createdAt, version: m.version || null, host: m.host || null, platform: m.platform || null, kind: m.kind || null, summary: m.summary || null, warnings: m.warnings || [], secretsLeftOut: m.secretsLeftOut || null, files: m.files.map((f) => ({ path: f.path, size: f.size })) } };
};

const backupFetch = ({ dir, name, dst }) => {
  if (!goodName(name)) throw new Error("not a backup's name");
  const buf = fs.readFileSync(path.join(dir, name));
  const v = verifyBufferSync(buf);
  if (!v.ok) throw new Error(`this copy is damaged (${v.error})`);
  const want = sha256(buf);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const partial = `${dst}.partial`;
  try { writeChecked(buf, partial, dst, want); } catch (e) { try { fs.unlinkSync(partial); } catch {} throw e; }
  return { ok: true, path: dst, size: buf.length, sha256: want };
};

module.exports = { backupCopy, backupList, backupInspect, backupFetch, deps, _internals: { copiesIn, rotate, checkFile, DAMAGED_KEPT_MS, SLACK_BYTES } };
