// Free-space lookup for a folder. Shared by the admin disk panel and the
// download queue, which auto-approves requests while the library volume still
// has room and only falls back to asking an admin when it doesn't.
const fs = require("fs");

const shape = (s) => ({
  free: s.bavail * s.bsize,
  total: s.blocks * s.bsize,
  // Percentage of the volume still free (0-100), for threshold checks.
  freePct: s.blocks > 0 ? (s.bavail / s.blocks) * 100 : null,
});

// A folder on a NETWORK drive is never asked here: a statfs on a hung NFS
// mount waits for ever (in the thread pool, or on the event loop for the
// Sync form). Its numbers come from lib/drives' last check, made in a child
// process with a deadline — null while it is not answering.
const fromDrives = (dir) => {
  try { return require("./drives").spaceOf(dir); } catch { return undefined; }
};

// { free, total, freePct } for the volume `dir` lives on, or null when the path
// can't be queried (drive missing/offline, permissions).
const space = async (dir) => {
  const net = fromDrives(dir);
  if (net !== undefined) return net;
  try {
    return shape(await fs.promises.statfs(dir));
  } catch {
    return null;
  }
};

// Same, blocking. A local statfs is a sub-millisecond syscall, so this is fine
// on a request path and keeps callers that are otherwise synchronous simple.
const spaceSync = (dir) => {
  const net = fromDrives(dir);
  if (net !== undefined) return net;
  try {
    return shape(fs.statfsSync(dir));
  } catch {
    return null;
  }
};

// Free bytes for the stream routes' "disk nearly full" guards, kept fresh
// OFF the event loop (2026-10-26). Those guards ran a statfsSync on every
// playlist request; "a sub-millisecond syscall" is true of a quiet disk, but
// on this house PC's system disk under an evening's start (a nearly full QLC
// NVMe busy writing stream segments) one call waited 12–22 s with every
// request in the house behind it (docs/qa/capacity-2026-10). Now: the first
// ask for a folder is answered as before (once per process), after that the
// last known value, refreshed in the background when older than maxAgeMs. A
// guard that refuses under 2 GB free cannot be fooled by a few seconds' age.
const free = new Map(); // dir -> { bytes, at, refreshing }
const freeBytesCached = (dir, maxAgeMs = 5000, now = Date.now()) => {
  const hit = free.get(dir);
  if (!hit) {
    const s = spaceSync(dir);
    const bytes = s ? s.free : Infinity;
    free.set(dir, { bytes, at: now, refreshing: false });
    return bytes;
  }
  if (now - hit.at > maxAgeMs && !hit.refreshing) {
    hit.refreshing = true;
    space(dir).then((s) => { hit.bytes = s ? s.free : Infinity; hit.at = Date.now(); }).finally(() => { hit.refreshing = false; });
  }
  return hit.bytes;
};

module.exports = { space, spaceSync, freeBytesCached, _internals: { free } };
