// WHOSE GOODBYE IS IT — for the OFFSET transcodes (media/remux.js for library
// files, media/torrent-transcode.js for torrents): the jobs the TV app plays.
//
// The website's player says goodbye to its jit producers (jit.release) when
// it closes, so the encoder is free at once for whatever is played next. The
// TV app sent the same beacon (api.playBye), but a TV plays an offset job —
// one ffmpeg per start or seek — and nothing listened: the job ran on until
// the idle sweep found it 2.5 minutes later, or until the next seek
// superseded it. On a server with two encoders that is a slot held for
// nobody, and the next viewer is told "the server is busy".
//
// THE RULE IS jit.release's, unchanged (and for the same reason: an id in a
// URL is easy to guess). A goodbye stops only what was that viewer's to stop:
//   * nothing at all unless that viewer read this title (any of its jobs)
//     within VIEWER_TTL_MS — a stranger, a request with no viewer at all, or
//     a goodbye for a film the viewer is not in stops nothing;
//   * of the title's running jobs, every one that no OTHER viewer has asked
//     anything of within ABANDONED_MS (20 s — a playing reader asks at least
//     that often); a job someone else is in is left alone.
// Called with `viewer` undefined (the server's own callers, tests) it is the
// plain rule: every running job of the title.
//
// Pure bookkeeping: the callers own the jobs and stop them (the way they
// retire a superseded offset — kill, then remove the stump).
const VIEWER_TTL_MS = 10 * 60 * 1000;
const ABANDONED_MS = 20000;

// `job.viewers`: viewer -> when they last asked this job for anything.
const note = (job, viewer, now = Date.now()) => {
  if (!job || !viewer) return;
  const seen = job.viewers || (job.viewers = new Map());
  seen.set(viewer, now);
  if (seen.size > 32) for (const [v, at] of seen) if (now - at > VIEWER_TTL_MS) seen.delete(v);
};

// entries: [[key, job]] — the jobs of ONE title. → the keys to stop now.
// (The leaving viewer is struck off every one of them either way.)
const toStop = (entries, viewer, now = Date.now()) => {
  const owned = viewer !== undefined;
  if (owned) {
    if (!viewer) return [];
    const mine = entries.some(([, j]) => j.viewers && j.viewers.has(viewer) && now - j.viewers.get(viewer) <= VIEWER_TTL_MS);
    if (!mine) return [];
  }
  const out = [];
  for (const [key, j] of entries) {
    if (owned && j.viewers) {
      j.viewers.delete(viewer);
      let others = false;
      for (const at of j.viewers.values()) if (now - at <= ABANDONED_MS) others = true;
      if (others) continue; // somebody else is in this film
    }
    if (!j.proc) continue; // finished (or never started): nothing runs
    out.push(key);
  }
  return out;
};

module.exports = { note, toStop, VIEWER_TTL_MS, ABANDONED_MS };
