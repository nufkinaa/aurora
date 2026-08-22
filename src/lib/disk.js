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

// { free, total, freePct } for the volume `dir` lives on, or null when the path
// can't be queried (drive missing/offline, permissions).
const space = async (dir) => {
  try {
    return shape(await fs.promises.statfs(dir));
  } catch {
    return null;
  }
};

// Same, blocking. A local statfs is a sub-millisecond syscall, so this is fine
// on a request path and keeps callers that are otherwise synchronous simple.
const spaceSync = (dir) => {
  try {
    return shape(fs.statfsSync(dir));
  } catch {
    return null;
  }
};

module.exports = { space, spaceSync };
