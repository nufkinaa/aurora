// Download-to-server: turn a chosen torrent source into a permanent library
// file. A viewer requests a download from the detail page; aria2 fetches the
// chosen file, we copy it into the configured library folder (with subtitles and
// a poster), and the scanner indexes it as a normal downloaded title — which
// then seeks and resumes natively like any other local file.
//
// Two policies live here, and only here:
//
//   * APPROVAL IS DISK-GATED, not manual. A request starts on its own as long as
//     the library volume would still be DOWNLOAD_MIN_FREE_PERCENT free once it
//     lands; an admin is only asked when that check fails — see diskGate().
//   * WHAT THE STAGING BYTES ARE FOR. Several episodes of one pack share a
//     single torrent, so deciding when a pack's staging directory can be deleted
//     needs the whole queue in view — see purgeIfUnused().
//
// The engine is aria2 (media/aria2.js). It replaced a hand-rolled WebTorrent
// worker on 2026-07-27: that engine could not reliably report how much of a file
// it had or when it was finished, so progress went backwards and completion had
// to be detected by hashing the staging directory ourselves. Streaming still
// uses WebTorrent, which is good at the different job of serving bytes now.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const scanner = require("./scanner");
const torrent = require("./torrent");
const realtime = require("../realtime");
const notify = require("../lib/notify");
const disk = require("../lib/disk");
let aria2 = require("./aria2"); // `let`: the tests swap in a fake engine (_internals.setEngine)
const imdb = require("./imdb");
const websubs = require("./websubs");
const torrentGate = require("../lib/torrentgate");
const { JsonStore } = require("../lib/jsonstore");
const settings = require("../lib/settings");
const dlslots = require("./dlslots");
const dlrace = require("./dlrace");
const sourceMemory = require("./sourcememory");

const store = new JsonStore(path.join(config.DATA_DIR, "downloads.json"), []);

// How many downloads run at once is the admin's "Downloads at once" setting
// (1–6, default 4 — media/dlslots.js), held at 2 while anyone is watching.
const maxActive = () => dlslots.effectiveMaxActive(settings.data.maxActiveDownloads);
const HOLD_RECHECK_MS = 20 * 1000; // while holding for viewers: look again this often
const ENGINE_QUIET_MS = 60 * 1000; // no failed status call for this long = the engine is healthy
const raceCfg = () => dlrace.resolveConfig(config.DOWNLOAD_RACE);
const MAX_JOBS = 200;      // cap the persisted history
const POLL_MS = 1000;      // how often aria2 is asked where the running jobs are

// Runtime state for running jobs (never persisted): what aria2 calls them, and
// where the finished file has to land.
//   jobId -> { gid, fileIndex (1-based), dir, base, copying }
const active = new Map();

// ---------- helpers ----------
const now = () => new Date().toISOString();

// Who is using the server right now, as far as the queue cares:
//   watching  viewers with a film on screen (realtime's "Watching") plus the
//             live repackaging / transcoding jobs feeding one
//   streams   torrent STREAMS in use (the WebTorrent client, not aria2)
const liveLoad = () => {
  let watching = 0;
  let streams = 0;
  try { for (const c of realtime.clients.values()) if (c.activity === "Watching") watching++; } catch {}
  try { watching += require("./jit").liveCount(); } catch {}
  try { watching += require("./remux").liveCount(); } catch {}
  try {
    const t = Date.now();
    streams = torrent.listTorrents().filter((x) => !x.quiesced && !x.done && (x.downloadSpeed > 0 || t - (x.lastAccess || 0) < 2 * 60 * 1000)).length;
  } catch {}
  return { watching, streams };
};

// What a test replaces to play the queue out without aria2, the network, the
// wall clock or timers. Nothing else reads these.
const seams = {
  clock: () => Date.now(),
  auto: true, // false: no poll timer, no delayed pumps — the test calls poll() / pumpNow()
  load: liveLoad,
  findSources: (job) => torrent.getSources(job.type === "show" ? "series" : "movie", job.imdbId, job.year, job.season, job.episode),
};
const later = (fn, ms) => { if (seams.auto) { const t = setTimeout(fn, ms); t.unref?.(); } };

// Every socket gets the update, each told only whether the job is ITS
// profile's ("mine") — who asked never leaves the server (see publicJob).
const broadcast = (job) =>
  realtime.broadcastEach((c) => ({
    type: "download_update",
    job: publicJobFor(job, { id: c.profileId, name: c.profile }),
  }));

// Is this viewer the profile that requested the job? Newer jobs store the
// profile ID; jobs from before that carry the NAME, so both are accepted.
const isRequester = (job, viewer) =>
  !!(job && job.profile && viewer && ((viewer.id && job.profile === viewer.id) || (viewer.name && job.profile === viewer.name)));

// publicJob plus "mine" for a given viewer — the shape the downloads page,
// the nav pill and the player read.
const publicJobFor = (job, viewer) => ({ ...publicJob(job), mine: isRequester(job, viewer) });

// Strip fields nobody outside needs; keep it small for WS.
const publicJob = (j) => ({
  id: j.id, infoHash: j.infoHash, fileIdx: j.fileIdx, imdbId: j.imdbId || null,
  title: j.title, label: j.label, type: j.type,
  season: j.season, episode: j.episode, quality: j.quality,
  sizeBytes: j.sizeBytes, poster: j.poster, provider: j.provider,
  status: j.status, phase: j.phase || null, copyProgress: j.copyProgress ?? null,
  progress: j.progress || 0, downloadSpeed: j.downloadSpeed || 0,
  peers: j.peers || 0, error: j.error || null, at: j.at,
  approvedAt: j.approvedAt || null, doneAt: j.doneAt || null,
  // Why it's waiting for an admin, and whether the queue started it by itself.
  holdReason: j.holdReason || null, autoApproved: !!j.autoApproved,
  // Whether the requester has opened it since it finished, whether smart
  // downloads queued it, and the library id the finished file was indexed
  // under — the thing "Play" on the downloads page needs. WHO requested it
  // stays server-side (publicJobFor answers "mine" per viewer instead).
  seenAt: j.seenAt || null, smart: !!j.smart, resolvedAt: j.resolvedAt || null,
  libraryId: j.status === "done" && j.destPath ? scanner.idForPath(j.destPath) : null,
  // A second source is being tried beside the first (media/dlrace.js). The
  // card stays ONE card: `progress` above is the leading attempt's. `race` is
  // null whenever no race is on; `raceNote` is the plain sentence left behind
  // when one could not help ("No healthy source was found at 1080p…").
  race: j.race && j.status === "downloading"
    ? {
      state: j.race.state, why: j.race.why || null, at: j.race.at || null,
      attempts: (j.attempts || []).map((a) => ({
        role: a.role, infoHash: a.infoHash, provider: a.provider || null, release: a.release || null,
        sizeBytes: a.sizeBytes || 0, progress: a.progress || 0, downloadSpeed: a.speed || 0,
        etaSec: a.etaSec ?? null, peers: a.peers || 0,
      })),
    }
    : null,
  raceNote: j.raceNote || null,
});

// The requester opened the finished file: the "ready to play" nudge for it
// goes away on every device of theirs. Only the requester can clear it.
const markSeen = (id, viewer) => {
  const job = findJob(id);
  if (!job) return { error: "no such download" };
  if (!isRequester(job, viewer)) return { error: "not your download" };
  if (!job.seenAt) {
    job.seenAt = now();
    store.save();
    broadcast(job);
  }
  return { job: publicJobFor(job, viewer) };
};

// Windows-safe folder/file component.
const safeName = (s) =>
  String(s || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "") // no trailing dot/space (Windows)
    .slice(0, 120) || "Untitled";

const pad2 = (n) => String(n).padStart(2, "0");

const isValidHash = (h) => typeof h === "string" && /^[a-z0-9]{32,40}$/i.test(h);

const SUB_EXT = [".srt", ".vtt", ".ass", ".ssa"];

// The library root a finished job lands in. Falls back to null if nothing is
// configured for that media type.
const destRoot = (type) => {
  const roots = type === "show" ? config.LIBRARIES.shows : config.LIBRARIES.movies;
  return (roots && roots[0]) || null;
};

// ---------- the disk gate (what replaced blanket admin approval) ----------
const gb = (n) => (n / 1e9).toFixed(1);

// Bytes already promised to jobs that are queued or running but not written
// yet: a job at 40% still has 60% of its size to land on the volume. Without
// this, ten simultaneous requests would each see the same free space and all
// pass the gate.
const committedBytes = (excludeId) =>
  store.data.reduce((n, j) => {
    if (j.id === excludeId || !["approved", "downloading"].includes(j.status)) return n;
    // A job in a second-source race has TWO copies on the way: what is left
    // of each attempt counts (the original's own numbers when no race is on).
    if (j.attempts && j.attempts.length > 1) {
      return n + j.attempts.reduce((m, a) => m + Math.max(0, (a.sizeBytes || 0) * (1 - (a.progress || 0))), 0);
    }
    return n + Math.max(0, (j.sizeBytes || 0) * (1 - (j.progress || 0)));
  }, 0);

// May this job start on its own? Yes while the library volume would still be
// at least DOWNLOAD_MIN_FREE_PERCENT free once this download — and everything
// already queued — has landed. Anything we cannot measure answers "no" and goes
// to the admin, rather than quietly filling a disk.
//
// Caveat: a download stages in temp and is copied into the library at the end,
// so a library sharing a volume with temp transiently needs ~2x the file size.
// The percentage headroom absorbs that; it isn't modelled byte-for-byte.
const diskGate = (type, sizeBytes, excludeId) => {
  const min = config.DOWNLOAD_MIN_FREE_PERCENT;
  if (!(min > 0)) return { ok: true }; // 0/disabled = never ask
  const root = destRoot(type);
  const s = root ? disk.spaceSync(root) : null;
  if (!s || s.freePct == null || !s.total) {
    return { ok: false, reason: `Couldn't read free space on ${root || "the library drive"}.` };
  }
  const needed = Math.max(0, sizeBytes || 0) + committedBytes(excludeId);
  const pctAfter = ((s.free - needed) / s.total) * 100;
  if (pctAfter >= min) return { ok: true };
  return {
    ok: false,
    reason:
      `Low disk space: ${gb(s.free)} GB free on ${root}` +
      (needed ? `, ${gb(needed)} GB needed for this and anything queued` : "") +
      ` — that would leave ${Math.max(0, pctAfter).toFixed(1)}% free (minimum ${min}%).`,
  };
};

// Save the external subtitle tracks the stream UI offers for this title next to
// the downloaded video, so a downloaded copy has the SAME choice of subtitles a
// stream did (subtitles bundled inside the torrent are copied separately).
//
// Written as UTF-8 .srt (websubs converts Windows-1255 Hebrew on the way in, so
// what lands on disk reads correctly in any player). The scanner picks sidecars
// up automatically; `<video base>.<Label>.srt` is what makes it label the track
// "Hebrew" / "Hebrew 2" / "English".
const saveExternalSubtitles = async (job, destPath) => {
  if (!job.imdbId) return 0;
  let tracks = [];
  try {
    tracks = await torrent.getSubtitleSources(
      job.type === "show" ? "series" : "movie",
      job.imdbId,
      job.season,
      job.episode
    );
  } catch {
    return 0;
  }
  const { written, duplicates } = await websubs.writeSidecars(tracks, destPath);
  if (written.length) {
    console.log(
      `[download] ${job.id.slice(0, 6)} saved ${written.length} subtitle track(s) for "${job.title}"` +
      (duplicates ? ` (${duplicates} duplicate${duplicates > 1 ? "s" : ""} skipped)` : "")
    );
  }
  return written.length;
};

// Subtitles that came inside the torrent itself. We only asked aria2 for the
// video, so most of these were never fetched — and a few may hold a stray few KB
// because they share a piece with the video's first or last block. Only files
// aria2 reports as COMPLETE are copied: a truncated .srt in the library is worse
// than no .srt, because the player offers it as a real track.
const copyBundledSubtitles = (engineFiles, destPath) => {
  const base = path.basename(destPath, path.extname(destPath));
  let saved = 0;
  for (const f of engineFiles || []) {
    const ext = path.extname(f.path || "").toLowerCase();
    if (!SUB_EXT.includes(ext)) continue;
    if (!f.length || f.completed < f.length) continue;   // partial — skip
    try {
      const tag = safeName(path.basename(f.path, ext)) || "Subtitles";
      const to = path.join(path.dirname(destPath), `${base}.${tag}${ext}`);
      if (fs.existsSync(to)) continue;
      fs.copyFileSync(f.path, to);
      saved++;
    } catch {}
  }
  return saved;
};

// Fetch the poster and save it as cover.jpg (best-effort; never fatal).
const saveCover = async (posterUrl, destDir) => {
  if (!posterUrl) return;
  try {
    const res = await fetch(posterUrl, {
      headers: { "User-Agent": "Aurora/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 0) fs.writeFileSync(path.join(destDir, "cover.jpg"), buf);
  } catch {}
};

// ---------- job lifecycle ----------
const findJob = (id) => store.data.find((j) => j.id === id);

const activeCount = () => active.size;

const list = () => store.data.map(publicJob);
// The list as one viewer sees it ("mine" per job).
// A finished job whose file the admin has since deleted from the library is
// history nobody wants: it sat on "My downloads" as "Finished — indexing…"
// forever (no library id resolves for a path that is gone). Drop those on
// every listing and tell every open page, so they vanish everywhere at once.
const pruneGone = () => {
  // "Gone" means deleted — not "its drive is unplugged": a file under a
  // library folder that cannot be read right now is kept (lib/libroots.js).
  let away = () => false;
  try { away = require("../lib/libroots").under; } catch {}
  const gone = store.data.filter((j) => j.status === "done" && j.destPath && !fs.existsSync(j.destPath) && !away(j.destPath));
  if (!gone.length) return;
  store.data = store.data.filter((j) => !gone.includes(j));
  store.save();
  for (const j of gone) realtime.broadcastAll({ type: "download_removed", id: j.id });
};
// Read-only views for smart cleanup (media/smartclean.js): the finished
// smart downloads whose files are still on disk, and every job as stored
// (it needs `profile` and `destPath`, which publicJob deliberately hides).
const smartOnDisk = () =>
  store.data.filter((j) => j.smart && j.status === "done" && j.destPath && fs.existsSync(j.destPath));
const rawJobs = () => store.data.slice();
const listFor = (viewer) => {
  pruneGone();
  return store.data.map((j) => publicJobFor(j, viewer));
};

const create = (fields) => {
  const {
    infoHash, fileIdx, type, imdbId, title, label, year, poster,
    quality, sizeBytes, season, episode, provider, seeders, profile, smart,
  } = fields || {};

  // "torrents": false — nothing new is accepted (the route answers 403 before
  // this; smart downloads and follows come straight here).
  if (!torrentGate.enabled()) return { error: torrentGate.MESSAGE };
  if (!isValidHash(infoHash)) return { error: "bad infoHash" };
  if (!destRoot(type === "show" ? "show" : "movie")) {
    return { error: `No ${type === "show" ? "shows" : "movies"} library folder is configured.` };
  }
  if (!aria2.available()) {
    return { error: "The download engine (aria2) isn't installed on the server." };
  }

  // Already downloaded / in library? (title match, same as requests.js)
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const wanted = type === "show" ? "show" : "movie";
  const libHit = scanner.allItems().find(
    (i) => i.type === wanted && norm(i.title) === norm(title)
  );
  // For movies a library hit means "already have it"; for shows a hit doesn't
  // mean this specific episode exists, so we still allow episode downloads.
  if (libHit && wanted === "movie") return { alreadyAvailable: libHit };

  // Dedup on the exact torrent+file, unless the prior attempt failed/declined.
  const dupe = store.data.find(
    (j) => j.infoHash === infoHash && j.fileIdx === (fileIdx || 0) &&
      !["error", "declined", "canceled"].includes(j.status)
  );
  if (dupe) return { job: publicJob(dupe), duplicate: true };
  // …or the exact file some job is already fetching as its SECOND source.
  const racing = store.data.find(
    (j) => j.status === "downloading" && j.attempts && j.attempts[1] &&
      j.attempts[1].infoHash === infoHash && (j.attempts[1].fileIdx || 0) === (fileIdx || 0)
  );
  if (racing) return { job: publicJob(racing), duplicate: true };

  // Approval is only needed when the disk is tight (or unreadable).
  const gate = diskGate(wanted, sizeBytes);

  const { magnet, announce } = torrent.magnetFor(infoHash);
  const job = {
    id: crypto.randomBytes(6).toString("hex"),
    infoHash,
    fileIdx: fileIdx || 0,
    magnet,
    announce,
    type: wanted,
    imdbId: imdbId || null,
    title: String(title || "Untitled").slice(0, 160),
    label: label ? String(label).slice(0, 200) : null,
    year: year || null,
    poster: poster || null,
    quality: quality || null,
    sizeBytes: sizeBytes || 0,
    season: season || null,
    episode: episode || null,
    provider: provider || null,
    seeders: seeders || 0,
    profile: profile ? String(profile).slice(0, 24) : null,
    // The person, for the admin's notification (profile is an id).
    profileName: fields.profileName ? String(fields.profileName).slice(0, 40) : null,
    smart: !!smart, // queued by smart downloads (the next episode), not by hand
    status: gate.ok ? "approved" : "pending",
    // Set when the queue started this itself, so pump() knows it may still send
    // the job back to "pending" if the disk fills before its turn comes up.
    autoApproved: gate.ok,
    approvedAt: gate.ok ? now() : null,
    // Why an admin is being asked (null when nothing is being asked).
    holdReason: gate.ok ? null : gate.reason,
    progress: 0,
    downloadSpeed: 0,
    peers: 0,
    error: null,
    at: now(),
  };
  store.data.unshift(job);
  if (store.data.length > MAX_JOBS) {
    // Drop the oldest FINISHED/dead jobs first; never evict a running one.
    for (let i = store.data.length - 1; i >= 0 && store.data.length > MAX_JOBS; i--) {
      if (!["pending", "approved", "downloading"].includes(store.data[i].status)) {
        store.data.splice(i, 1);
      }
    }
  }
  store.save();
  realtime.broadcastAdmins({ type: "download_new", job: publicJob(job) });

  const size = job.sizeBytes ? ` · ${gb(job.sizeBytes)} GB` : "";
  const what =
    `${job.profileName || job.profile || "Someone"} requested "${job.label || job.title}"` +
    `${job.quality ? ` (${job.quality}${size})` : size}`;
  if (gate.ok) {
    // Nothing to do — tell the admin it's happening, don't ask.
    notify.send("Aurora: download started", `${what} — downloading now.`);
    pump();
  } else {
    // Ping the admin's phone: approval is the only thing between the viewer and
    // their download, so this shouldn't wait for an admin page visit.
    notify.send(
      "Aurora: download needs approval",
      `${what} — ${job.holdReason} Approve it in /admin → Downloads.`
    );
  }
  return { job: publicJob(job), needsApproval: !gate.ok, holdReason: job.holdReason };
};

const approve = (id) => {
  const job = findJob(id);
  if (!job) return { error: "not found" };
  if (!torrentGate.enabled()) return { error: torrentGate.MESSAGE };
  if (!["pending", "error", "canceled", "declined"].includes(job.status)) {
    return { job: publicJob(job) }; // already approved/running/done
  }
  job.status = "approved";
  job.error = null;
  job.approvedAt = now();
  job.holdReason = null;
  // An explicit admin approval overrides the disk gate: pump() must never send
  // this back to "pending", however full the drive is. Deleting titles is the
  // admin's business, and they just said yes with the numbers in front of them.
  job.autoApproved = false;
  store.save();
  broadcast(job);
  pump();
  return { job: publicJob(job) };
};

const decline = (id) => {
  const job = findJob(id);
  if (!job) return { error: "not found" };
  stopActive(id, "declined");
  job.status = "declined";
  job.resolvedAt = now();
  store.save();
  broadcast(job);
  purgeIfUnused(job.infoHash, job.id);
  return { job: publicJob(job) };
};

const cancel = (id) => {
  const job = findJob(id);
  if (!job) return { error: "not found" };
  stopActive(id, "canceled");
  job.status = "canceled";
  job.resolvedAt = now();
  store.save();
  broadcast(job);
  // Order matters: pump() may start a queued sibling on this same pack, so decide
  // about the staging bytes FIRST (purgeIfUnused sees that sibling and keeps them).
  purgeIfUnused(job.infoHash, job.id);
  pump();
  return { job: publicJob(job) };
};

// A viewer taking back their own request: only while it hasn't landed.
const cancelOwn = (id, viewer) => {
  const job = findJob(id);
  if (!job) return { error: "not found" };
  if (!isRequester(job, viewer)) return { error: "not your download" };
  if (!["pending", "approved", "downloading", "error"].includes(job.status)) return { error: "already finished" };
  return cancel(id);
};

// A viewer clearing a DEAD request of their own off the page (failed,
// declined, canceled). "Remove" used to call cancel(), which only flipped a
// failed row to "Canceled" — the row never went anywhere.
const removeOwn = (id, viewer) => {
  const job = findJob(id);
  if (!job) return { error: "not found" };
  if (!isRequester(job, viewer)) return { error: "not your download" };
  if (!["error", "declined", "canceled"].includes(job.status)) return { error: "still in progress" };
  return remove(id);
};

const remove = (id) => {
  const i = store.data.findIndex((j) => j.id === id);
  if (i === -1) return { error: "not found" };
  const { infoHash } = store.data[i];
  stopActive(id, "removed");
  store.data.splice(i, 1);
  store.save();
  // Every open "My downloads" page drops the row now, not on its next reload.
  realtime.broadcastAll({ type: "download_removed", id });
  purgeIfUnused(infoHash, id);
  pump();
  return { ok: true };
};

// How many may run, and whether viewing is what holds it there.
const slotState = () => {
  const load = seams.load();
  return { ...dlslots.startCap({ maxActive: maxActive(), watching: load.watching }), watching: load.watching, maxActive: maxActive() };
};

// Start any approved jobs up to the concurrency cap. Only ever STARTS: a job
// already running is never stopped because the cap came down (the admin
// lowered the setting, or someone pressed Play) — it finishes, new ones wait.
let holdTimer = null;
const pump = () => {
  // "torrents": false — queued jobs stay queued (and untouched: no disk-gate
  // demotion, no admin notification) until the owner switches torrents back on.
  if (!torrentGate.enabled()) return;
  const { cap, holding } = slotState();
  // Held back for viewers with jobs still queued: nothing else will pump when
  // the film ends, so look again shortly.
  if (holding && seams.auto && !holdTimer && store.data.some((j) => j.status === "approved" && !active.has(j.id))) {
    holdTimer = setTimeout(() => { holdTimer = null; pump(); }, HOLD_RECHECK_MS);
    holdTimer.unref?.();
  }
  if (activeCount() >= cap) return;
  const queued = store.data.filter((j) => j.status === "approved" && !active.has(j.id));
  for (const job of queued) {
    if (activeCount() >= cap) break;
    // Re-run the gate at start time for self-started jobs: one may have waited
    // behind MAX_ACTIVE others for hours, and the drive it was measured against
    // can be full by now. An admin-approved job is exempt (see approve()).
    if (job.autoApproved) {
      const gate = diskGate(job.type, job.sizeBytes, job.id);
      if (!gate.ok) {
        job.status = "pending";
        job.approvedAt = null;
        job.holdReason = gate.reason;
        store.save();
        broadcast(job);
        realtime.broadcastAdmins({ type: "download_new", job: publicJob(job) });
        notify.send(
          "Aurora: download needs approval",
          `"${job.label || job.title}" — ${gate.reason} Approve it in /admin → Downloads.`
        );
        continue; // now pending; it won't be picked up again until an admin acts
      }
    }
    startJob(job).catch((e) => fail(job, e && e.message ? e.message : String(e)));
  }
};

const fail = (job, message) => {
  stopActive(job.id, "failed");
  job.status = "error";
  job.error = String(message || "download failed").slice(0, 300);
  job.phase = null;
  job.copyProgress = null;
  job.resolvedAt = now();
  store.save();
  broadcast(job);
  notify.send("Aurora: download failed", `"${job.label || job.title}" — ${job.error}`);
  purgeIfUnused(job.infoHash, job.id); // before pump(), same reason as cancel()
  pump();
};

// ---------- the engine: aria2 ----------
//
// One aria2 download per TORRENT, one job per FILE. Several episodes of a season
// pack are therefore a single download with several files selected, which is how
// aria2 models it and the only arrangement that doesn't fight itself — the
// previous engine ran a client per job over a shared directory and they
// corrupted each other's bookkeeping.

// Folder identity, ignoring a trailing "(2005)". We name new folders
// "<Title> (<Year>)", but a library built by hand usually says just "<Title>" —
// and those are the same show. Comparing them this way is what stops a
// downloaded episode from starting a second, rival copy of a series you already
// have. (This is only about matching; new folders still get the year.)
const folderKey = (name) =>
  String(name || "")
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

// Pick the folder a title belongs in, given what's already on disk. Exported for
// tests: this is the rule that decides whether a download joins your library or
// splits it in two.
const chooseFolder = (existingFolders, title, year) => {
  const wanted = folderKey(title);
  const match = (existingFolders || []).find((f) => folderKey(f) === wanted);
  return match || safeName(safeName(title) + (year ? ` (${year})` : ""));
};

const foldersIn = (root) => {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
};

// Where this job's file belongs in the library, minus the extension (which comes
// from the real file once aria2 has the torrent's details).
const destinationFor = (job) => {
  const root = destRoot(job.type);
  if (!root) throw new Error("no library folder configured");
  const folder = chooseFolder(foldersIn(root), job.title, job.year);
  if (job.type === "show") {
    const s = job.season || 1;
    const e = job.episode || 1;
    return {
      dir: path.join(root, folder, `Season ${pad2(s)}`),
      base: `${safeName(job.title)} S${pad2(s)}E${pad2(e)}`,
    };
  }
  return { dir: path.join(root, folder), base: folder };
};

// Copy the finished file out of staging and into the library. A copy, not a
// move: aria2 may still be writing sibling files in that directory for another
// job, and on Windows renaming a file it holds open fails.
const copyIntoLibrary = (from, to, onBytes) =>
  new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const rs = fs.createReadStream(from);
    const ws = fs.createWriteStream(to);
    let bytes = 0;
    let reported = 0;
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (!err) return resolve();
      try { rs.destroy(); } catch {}
      try { ws.destroy(); } catch {}
      reject(err);
    };
    rs.on("data", (chunk) => {
      bytes += chunk.length;
      const t = Date.now();
      if (onBytes && t - reported >= 1000) { reported = t; try { onBytes(bytes); } catch {} }
    });
    rs.on("error", settle);
    ws.on("error", settle);
    ws.on("finish", () => settle());
    rs.pipe(ws);
  });

// ---------- attempts ----------
// A job downloads from ONE source — except during a second-source race, when
// a challenger runs beside the original. Each of them is an "attempt": one
// file of one aria2 download, with its own clocks and its own smoothed speed.
//
//   rec.main   the attempt whose source the job carries as its own
//              (job.infoHash / fileIdx / magnet / quality / sizeBytes)
//   rec.ch     the challenger while a race is on, else null
//
// The job's own fields are never a mix: when a challenger takes over (it won,
// or the original died) adopt() copies its source onto the job in one go and
// it becomes rec.main. What is persisted of a race is job.race + job.attempts
// (see persisted()); the rest of an attempt lives only here.
const newAttempt = (role, src, t) => ({
  role,                                   // "original" | "challenger"
  src,                                    // the source: { infoHash, fileIdx, magnet, announce, quality, sizeBytes, provider, seeders, release }
  infoHash: src.infoHash,
  fileIdx: src.fileIdx || 0,
  fileIndex: (src.fileIdx || 0) + 1,      // aria2 numbers files from 1
  gid: null,                              // set once aria2 has the torrent's details
  dead: false,                            // released: late answers about it are ignored
  state: role === "challenger" ? "probing" : null, // challenger: "probing" → "racing"
  startedAt: t,
  metaAt: 0,                              // when the details (the file list) arrived
  connectedAt: 0,                         // first seeder / peer / byte
  seededAt: 0,                            // first REAL seeder or byte (what the probe waits for)
  lastProgressAt: 0,                      // the healer's stall clock
  lastSampleAt: 0,
  speed: 0,                               // smoothed (EWMA over ~60 s) — what every decision uses
  rawSpeed: 0,                            // aria2's instant number — what the card shows
  peers: 0, seeders: 0, connections: 0,
  fraction: 0, completed: 0, length: 0,
});

// The live record of a running job. The getters are what the healer (and
// older code) read off a record: they always answer for the job's own source.
const makeRec = (dest, main) => ({
  dir: dest.dir, base: dest.base,
  copying: false,     // true from the instant an attempt WINS (see claimWin)
  main, ch: null,
  lead: "main",       // whose progress the card shows
  ko: null,           // knockout state: { lead, since }
  preRaceBps: 0,      // the original's smoothed speed when the race began
  raceBusy: false,    // looking up sources for a challenger right now
  raceRetryAt: 0,     // not before this (ms) is a race considered again
  whyNot: null,       // slow, but not raced: why (text, for the healer's line)
  get gid() { return this.main.gid; },
  get fileIndex() { return this.main.fileIndex; },
  get startedAt() { return this.main.startedAt; },
  get lastProgressAt() { return this.main.lastProgressAt; },
});

function* liveAttempts() {
  for (const rec of active.values()) {
    if (!rec.main.dead) yield rec.main;
    if (rec.ch && !rec.ch.dead) yield rec.ch;
  }
}

// One attempt as the plain data dlrace's rules take.
const viewOf = (job, att) => {
  const size = att.length || att.src.sizeBytes || job.sizeBytes || 0;
  return {
    type: job.type, sizeBytes: size,
    startedAt: att.startedAt, metaAt: att.metaAt, connectedAt: att.connectedAt, seededAt: att.seededAt,
    speed: att.speed, fraction: att.fraction,
    // An unknown size is "everything is still to come", never "nothing left".
    remainingBytes: size > 0 ? Math.max(0, size * (1 - att.fraction)) : Infinity,
  };
};
const etaOf = (job, att) => { const v = viewOf(job, att); return dlrace.etaSec(v.remainingBytes, v.speed); };

// What is written to downloads.json for an attempt: enough to show it, and —
// for the challenger — enough to carry on with it after a restart.
const persisted = (job, att) => {
  const eta = etaOf(job, att);
  return {
    role: att.role, infoHash: att.infoHash, fileIdx: att.fileIdx,
    magnet: att.src.magnet, announce: att.src.announce || [],
    quality: att.src.quality || null, sizeBytes: att.length || att.src.sizeBytes || 0,
    provider: att.src.provider || null, seeders: att.src.seeders || 0, release: att.src.release || null,
    bytes: att.completed, progress: att.fraction,
    speed: Math.round(att.speed), etaSec: Number.isFinite(eta) ? Math.round(eta) : null, peers: att.peers,
  };
};

// The job takes a source as its own (the winner's, or the survivor's).
const adopt = (job, src) => {
  job.infoHash = src.infoHash;
  job.fileIdx = src.fileIdx || 0;
  job.magnet = src.magnet;
  job.announce = src.announce || [];
  job.quality = src.quality || job.quality;
  job.sizeBytes = src.sizeBytes || job.sizeBytes;
  job.provider = src.provider || null;
  job.seeders = src.seeders || 0;
};

const clearRace = (job) => { if (job) { job.race = null; delete job.attempts; } };

const setNote = (job, text) => {
  if ((job.raceNote || null) === (text || null)) return;
  job.raceNote = text || null;
  store.save();
  broadcast(job);
};

// File a source's outcome for this title (media/sourcememory.js).
const remember = (job, infoHash, outcome) => {
  try {
    const key = dlrace.titleKey(job);
    if (key) sourceMemory.record(key, infoHash, outcome, seams.clock());
  } catch (e) {
    console.warn("[download] could not remember a source outcome:", e && e.message);
  }
};

const sourceLabel = (src) => src.provider || (src.release ? String(src.release).slice(0, 48) : `${String(src.infoHash).slice(0, 8)}…`);

// Let go of an attempt's download. If another attempt (a sibling episode of
// the same pack, usually) still uses that torrent, only this file is dropped
// from the selection. Resolves when aria2 has been told — purging the staging
// bytes waits on it.
const releaseAttempt = (att) => {
  if (!att || att.dead) return Promise.resolve();
  att.dead = true;
  const others = [...liveAttempts()];
  if (!att.gid) {
    // Still looking for the torrent's details: there is no download to drop a
    // file from, only the hunt itself — stop it, unless someone else is on
    // the same torrent. (startJob / startChallenger tidy up if a GID arrives.)
    if (others.some((o) => o.infoHash === att.infoHash)) return Promise.resolve();
    if (typeof aria2.removeByInfoHash !== "function") return Promise.resolve();
    return Promise.resolve().then(() => aria2.removeByInfoHash(att.infoHash)).catch(() => {});
  }
  const shared = others.some((o) => o.gid === att.gid);
  return Promise.resolve()
    .then(() => (shared ? aria2.select(att.gid, att.fileIndex, false) : aria2.remove(att.gid)))
    .catch(() => {});
};

// aria2 answered with a GID for an attempt that was released meanwhile.
const settleOrphanGid = (att, gid) => {
  const others = [...liveAttempts()];
  if (others.some((o) => (o.gid === gid || o.infoHash === att.infoHash) && o.fileIndex === att.fileIndex)) return;
  const shared = others.some((o) => o.gid === gid || o.infoHash === att.infoHash);
  (shared ? aria2.select(gid, att.fileIndex, false) : aria2.remove(gid)).catch(() => {});
};

const errText = (e) => (e && e.message ? e.message : String(e));

const startJob = async (job) => {
  if (active.has(job.id)) return;
  if (!torrentGate.enabled()) throw torrentGate.offError();
  if (!aria2.available()) {
    throw new Error("aria2 is not installed on this server — downloads can't run");
  }
  const dest = destinationFor(job);

  job.status = "downloading";
  job.error = null;
  job.phase = "finding";      // looking for the torrent's details, before any bytes
  job.copyProgress = null;
  store.save();
  broadcast(job);

  // Claim the slot before the first await: two pumps in the same tick would
  // otherwise both start this job.
  const att = newAttempt("original", {
    infoHash: job.infoHash, fileIdx: job.fileIdx || 0, magnet: job.magnet, announce: job.announce,
    quality: job.quality, sizeBytes: job.sizeBytes, provider: job.provider, seeders: job.seeders,
  }, seams.clock());
  const rec = makeRec(dest, att);
  active.set(job.id, rec);
  console.log(`[download] ${job.id.slice(0, 6)} started ${job.infoHash.slice(0, 8)}… "${job.label || job.title}"`);
  // The poller (and with it the race check) has to run WHILE the torrent's
  // details are being looked for, not only after they arrive: a dead source
  // never gets past this point, and it is exactly the one a second source is
  // for. Found with a real torrent, 2026-10-08 — a lone download sat here for
  // five minutes and failed with nothing else tried.
  startPolling();

  let gid;
  try {
    gid = await aria2.add(att.src.magnet, att.infoHash, att.fileIndex);
  } catch (e) {
    if (att.dead) return;     // canceled (or replaced by its challenger) meanwhile
    return attemptFailed(job, rec, att, errText(e));
  }
  if (att.dead) {             // canceled while the details were being fetched
    settleOrphanGid(att, gid);
    return;
  }
  att.gid = gid;
  if (!att.metaAt) att.metaAt = seams.clock();
  if (rec.main === att && !rec.copying) {
    job.phase = "downloading";
    broadcast(job);
  }
  console.log(`[download] ${job.id.slice(0, 6)} aria2 gid ${gid}, file #${att.fileIndex}`);
  startPolling();
};

// An attempt's download reported an error (or could not even be added).
// With a second attempt alive the job does not fail — the other one carries it.
const attemptFailed = (job, rec, att, message) => {
  if (active.get(job.id) !== rec || att.dead) return;
  if (att === rec.ch) {
    challengerOut(job, rec, "failed", `A second source (${sourceLabel(att.src)}) failed: ${message}`);
    return;
  }
  if (att !== rec.main) return;
  if (rec.ch && !rec.copying) {
    promote(job, rec, "failed", `The first source failed (${message}); carrying on with the second.`);
    return;
  }
  fail(job, message);
};

// An attempt's download is gone from aria2 (removed behind our back, or the
// daemon restarted). Nobody's fault: no outcome is remembered.
const attemptVanished = (jobId, att, why) => {
  const rec = active.get(jobId);
  const job = findJob(jobId);
  if (!rec || att.dead || (rec.main !== att && rec.ch !== att)) return;
  if (!job) { requeue(jobId, why); return; }
  if (att === rec.ch) {
    challengerOut(job, rec, null, null);
    return;
  }
  if (rec.ch && !rec.copying) {
    // Same rule as a restart: whoever has more of the file carries on.
    const keep = dlrace.settleOnRestart([{ bytes: rec.main.completed }, { bytes: rec.ch.completed }]);
    if (keep === 1) { promote(job, rec, null, null); return; }
    challengerOut(job, rec, null, null);
  }
  requeue(jobId, why);
};

// ---------- progress ----------
// One timer for all running jobs. aria2 is the only source of truth here:
// files[].completedLength is exactly "bytes of this episode that are on disk".
let poller = null;
let saveCounter = 0;
let engineFailAt = 0;   // the last time a status call failed (see raceEnv)
// All downloads together: the smoothed total and its decaying high-water
// mark — how the race tells "this source is slow" from "the line is full".
const line = { total: 0, at: 0, peak: null };

const startPolling = () => {
  if (poller || !active.size || !seams.auto) return;
  // Never swallow these: a poll that throws means every running job silently
  // stops updating, which looks exactly like a stuck download.
  poller = setInterval(() => {
    poll().catch((e) => console.error("[download] progress poll failed:", e && e.message ? e.message : e));
  }, POLL_MS);
  poller.unref?.();
};

const stopPolling = () => {
  if (poller && !active.size) { clearInterval(poller); poller = null; }
};

// Fold one status answer into an attempt.
const sample = (att, f, st, sharers, t, cfg) => {
  if (f.fraction > att.fraction || !att.lastSampleAt) att.lastProgressAt = t; // the healer's stall clock
  att.fraction = f.fraction;
  att.completed = f.completed;
  att.length = f.length;
  att.peers = st.peers || 0;
  att.seeders = st.seeders != null ? st.seeders : st.peers || 0;
  att.connections = st.connections != null ? st.connections : st.peers || 0;
  att.rawSpeed = st.downloadSpeed || 0;
  if (!att.metaAt) att.metaAt = t;
  if (!att.connectedAt && (att.seeders > 0 || att.connections > 0 || att.rawSpeed > 0 || f.completed > 0)) att.connectedAt = t;
  if (!att.seededAt && (att.seeders > 0 || att.rawSpeed > 0 || f.completed > 0)) att.seededAt = t;
  // aria2's speed is per TORRENT. Episodes of one pack share it, so each
  // attempt riding on the download is credited an equal share.
  const share = att.rawSpeed / Math.max(1, sharers);
  att.speed = att.lastSampleAt ? dlrace.ewma(att.speed, share, t - att.lastSampleAt, cfg.speedTauSec * 1000) : share;
  att.lastSampleAt = t;
};

// Put the job's public numbers where the card reads them: the leading
// attempt's during a race, the only attempt's otherwise.
const publish = (job, rec) => {
  const main = rec.main;
  const ch = rec.ch;
  let lead = main;
  if (ch) {
    if (ch.state === "racing" && ch.lastSampleAt) {
      rec.lead = dlrace.leader(
        { etaMain: etaOf(job, main), etaCh: etaOf(job, ch), fracMain: main.fraction, fracCh: ch.fraction },
        rec.lead
      );
      if (rec.lead === "ch") lead = ch;
    }
    job.attempts = [persisted(job, main), persisted(job, ch)];
  }
  if (!lead.lastSampleAt) return;        // torrent details not in yet
  job.progress = lead.fraction;
  job.downloadSpeed = lead.rawSpeed;
  job.peers = lead.peers;
  // Progress for one file inside a pack only moves when a whole piece of
  // THAT file lands, so there is a real window where the engine is working
  // hard and the number is still 0. Saying "starting" beats showing a 0%
  // that looks like nothing is happening.
  job.phase = lead.completed > 0 ? "downloading" : "starting";
  broadcast(job);
};

const poll = async () => {
  if (!active.size) return stopPolling();
  const cfg = raceCfg();

  // One status call per torrent, however many attempts are riding on it.
  const byGid = new Map();
  for (const [jobId, rec] of active) {
    if (rec.copying) continue;
    for (const att of [rec.main, rec.ch]) {
      if (!att || att.dead || !att.gid) continue;
      if (!byGid.has(att.gid)) byGid.set(att.gid, []);
      byGid.get(att.gid).push({ jobId, att });
    }
  }

  let total = 0;
  for (const [gid, users] of byGid) {
    let st;
    try {
      st = await aria2.status(gid);
    } catch (e) {
      // The download is gone from aria2 (removed behind our back, or the daemon
      // restarted). Put the jobs back in the queue rather than losing them.
      // (An attempt that was released while we were asking is not "gone".)
      if (users.some((u) => !u.att.dead)) engineFailAt = seams.clock();
      for (const u of users) attemptVanished(u.jobId, u.att, e && e.message);
      continue;
    }
    const t = seams.clock();
    total += st.downloadSpeed || 0;

    for (const { jobId, att } of users) {
      const rec = active.get(jobId);
      const job = findJob(jobId);
      // Things moved while we were asking: the job ended, another attempt
      // already WON (rec.copying), or this attempt was released.
      if (!rec || !job || job.status !== "downloading" || rec.copying || att.dead) continue;
      if (rec.main !== att && rec.ch !== att) continue;

      if (st.state === "error") { attemptFailed(job, rec, att, st.error || "aria2 reported an error"); continue; }
      if (st.state === "removed") { attemptVanished(jobId, att, "the download was removed"); continue; }

      const f = aria2.fileProgress(st, att.fileIndex);
      if (!f) continue;                       // torrent details not in yet
      sample(att, f, st, users.length, t, cfg);

      // This attempt's file is complete — even when the torrent as a whole
      // isn't, because a sibling episode is still coming.
      if (f.length > 0 && f.completed >= f.length) claimWin(job, rec, att, f, st);
    }
  }

  const t = seams.clock();
  line.total = line.at ? dlrace.ewma(line.total, total, t - line.at, cfg.speedTauSec * 1000) : total;
  line.at = t;
  line.peak = dlrace.updatePeak(line.peak, line.total, t, cfg);

  for (const [jobId, rec] of active) {
    const job = findJob(jobId);
    if (job && job.status === "downloading" && !rec.copying) publish(job, rec);
  }
  if (++saveCounter % 10 === 0) store.save();

  raceTick(t, cfg);
};

// THE WIN. An attempt's file is complete (aria2 has hash-checked every piece
// of it). This function is synchronous from the check to the record, and the
// record — rec.copying — is what every other path tests first, so exactly one
// attempt per job can ever get past it:
//
//   1. rec.copying = true            (the win is recorded; a second attempt
//                                     finishing in this same poll, or the next,
//                                     returns at the first line)
//   2. the job takes the winner's source as its own; the race is cleared
//   3. the loser is released and its staging purged (purgeIfUnused keeps a
//      pack a sibling episode still wants)
//   4. the queue is written to disk NOW, so a crash during the copy restarts
//      with one attempt, the winner
//   5. only then does the copy into the library start (completeJob)
//
// poll() also skips every job whose rec.copying is set, so nothing about a
// finished race is even asked of aria2 again.
const claimWin = (job, rec, att, file, engineStatus) => {
  if (rec.copying) return false;
  rec.copying = true;

  const loser = att === rec.main ? rec.ch : rec.main;
  const raced = !!rec.ch || (job.raceCount || 0) > 0;
  const loserHash = rec.ch ? loser.infoHash : null;
  const hadRace = !!rec.ch;
  if (hadRace && att !== rec.main) {
    adopt(job, { ...att.src, sizeBytes: att.length || att.src.sizeBytes });
    job.secondSourceWon = true; // for the healer's download statistics
    att.role = "original";
    att.state = null;
    rec.main = att;
  }
  rec.ch = null;
  rec.ko = null;
  rec.lead = "main";
  clearRace(job);
  if (raced) remember(job, att.infoHash, "won");
  if (hadRace) {
    job.raceNote = null;
    remember(job, loserHash, "lost");
    console.log(`[download] ${job.id.slice(0, 6)} race won by ${att.infoHash.slice(0, 8)}…, ${loserHash.slice(0, 8)}… cancelled`);
    releaseAttempt(loser).then(() => purgeIfUnused(loserHash, job.id));
    store.flush();
  }

  completeJob(job, rec, file, engineStatus).catch((e) => {
    rec.copying = false;
    fail(job, errText(e));
  });
  return true;
};

// The bytes are all there: copy the file into the library, bring its subtitles
// and poster along, and let the scanner see it.
const completeJob = async (job, rec, file, engineStatus) => {
  const ext = path.extname(file.path) || ".mkv";
  const destPath = path.join(rec.dir, `${rec.base}${ext}`);

  job.phase = "copying";
  job.progress = 1;
  job.downloadSpeed = 0;
  job.copyProgress = 0;
  broadcast(job);

  const startedAt = Date.now();
  await copyIntoLibrary(file.path, destPath, (bytes) => {
    job.copyProgress = file.length ? Math.min(1, bytes / file.length) : 0;
    broadcast(job);
  });

  // Never let a short file into the library — the scanner would index it as a
  // playable title.
  const copied = fs.statSync(destPath).size;
  if (copied < file.length) {
    try { fs.unlinkSync(destPath); } catch {}
    throw new Error(`copied only ${copied} of ${file.length} bytes`);
  }
  const secs = (Date.now() - startedAt) / 1000;
  console.log(`[download] ${job.id.slice(0, 6)} copied ${(copied / 1e6).toFixed(0)} MB in ${secs.toFixed(0)}s`);

  copyBundledSubtitles(engineStatus && engineStatus.files, destPath);
  await finish(job, destPath);
};

// A job whose download vanished (daemon restart, removed behind our back) goes
// back in the queue instead of being lost or failed.
const requeue = (jobId, why) => {
  const job = findJob(jobId);
  stopActive(jobId);
  if (!job || job.status !== "downloading") return;
  console.warn(`[download] ${jobId.slice(0, 6)} re-queued: ${why || "download vanished"}`);
  job.status = "approved";
  job.phase = null;
  store.save();
  broadcast(job);
  later(pump, 2000);
};

// Stop a job's download(s) without changing its status. If a sibling job is
// still using that torrent, only this job's file is dropped from the selection.
// A challenger goes with it: a job that is not running has no race.
function stopActive(id, why) {
  const rec = active.get(id);
  if (!rec) return;
  active.delete(id);
  stopPolling();
  if (why) console.log(`[download] ${id.slice(0, 6)} ${why}`);
  const ch = rec.ch;
  rec.ch = null;
  releaseAttempt(rec.main);
  if (ch) {
    clearRace(findJob(id));
    releaseAttempt(ch).then(() => purgeIfUnused(ch.infoHash, id));
  }
}

// Delete a pack's staging bytes once NOTHING in the queue wants them. Only this
// module can make that call: aria2 knows what is downloading, but the jobs that
// matter are the queued ones it hasn't been told about yet. "Wants" includes a
// job fetching that torrent as its second source.
const LIVE_STATUSES = ["pending", "approved", "downloading"];
const sameHash = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const jobWants = (j, infoHash) =>
  sameHash(j.infoHash, infoHash) || (j.attempts || []).some((a) => sameHash(a.infoHash, infoHash));
function purgeIfUnused(infoHash, exceptId) {
  if (!infoHash) return;
  const stillWanted = store.data.some(
    (j) => j.id !== exceptId && LIVE_STATUSES.includes(j.status) && jobWants(j, infoHash)
  );
  if (stillWanted) return;
  // The job itself still wants it when it is the source it now carries (the
  // loser of a race is purged by hash while its job lives on).
  const self = exceptId && findJob(exceptId);
  if (self && LIVE_STATUSES.includes(self.status) && active.has(self.id) && sameHash(self.infoHash, infoHash)) return;
  aria2.purge(infoHash).catch(() => {});
}

// ---------- the second-source race (rules: media/dlrace.js) ----------

// The challenger is out: cancelled, remembered (when it was its fault), its
// staging purged. The job carries on with its original, as if nothing happened.
const challengerOut = (job, rec, outcome, note) => {
  const ch = rec.ch;
  if (!ch) return;
  rec.ch = null;
  rec.ko = null;
  rec.lead = "main";
  rec.raceRetryAt = outcome === "probe" || outcome === "failed" ? 0 : seams.clock() + raceCfg().retryMin * 60 * 1000;
  clearRace(job);
  if (outcome) remember(job, ch.infoHash, outcome);
  job.raceNote = note || null;
  console.log(`[download] ${job.id.slice(0, 6)} second source ${ch.infoHash.slice(0, 8)}… dropped${outcome ? ` (${outcome})` : ""}`);
  releaseAttempt(ch).then(() => purgeIfUnused(ch.infoHash, job.id));
  store.save();
  broadcast(job);
};

// The challenger takes over: the original is cancelled (and remembered, when
// it was its fault), the job carries the challenger's source from here on.
const promote = (job, rec, oldOutcome, note) => {
  const ch = rec.ch;
  const old = rec.main;
  if (!ch) return;
  const oldHash = old.infoHash;
  adopt(job, { ...ch.src, sizeBytes: ch.length || ch.src.sizeBytes });
  ch.role = "original";
  ch.state = null;
  rec.main = ch;
  rec.ch = null;
  rec.ko = null;
  rec.lead = "main";
  clearRace(job);
  if (oldOutcome) remember(job, oldHash, oldOutcome);
  job.raceNote = note || null;
  job.progress = ch.fraction;
  job.downloadSpeed = ch.rawSpeed;
  job.peers = ch.peers;
  job.phase = !ch.gid ? "finding" : ch.completed > 0 ? "downloading" : "starting";
  console.log(`[download] ${job.id.slice(0, 6)} now on its second source ${ch.infoHash.slice(0, 8)}… (first: ${oldHash.slice(0, 8)}…${oldOutcome ? `, ${oldOutcome}` : ""})`);
  releaseAttempt(old).then(() => purgeIfUnused(oldHash, job.id));
  store.save();
  broadcast(job);
};

// Every source some OTHER live job is fetching (its own, and its challenger).
const otherSources = (exceptId) => {
  const out = [];
  for (const j of store.data) {
    if (j.id === exceptId || !LIVE_STATUSES.includes(j.status)) continue;
    const running = j.status === "downloading";
    out.push({ infoHash: j.infoHash, fileIdx: j.fileIdx || 0, running });
    const ch = j.attempts && j.attempts[1];
    if (ch) out.push({ infoHash: ch.infoHash, fileIdx: ch.fileIdx || 0, running });
  }
  return out;
};

// What the rules need to know about the server right now.
const raceEnv = (t) => {
  const load = seams.load();
  let races = 0;
  for (const r of active.values()) if (r.ch || r.raceBusy) races++;
  return {
    torrentsOn: torrentGate.enabled(),
    engineHealthy: aria2.available() && (typeof aria2.running !== "function" || aria2.running()) && t - engineFailAt > ENGINE_QUIET_MS,
    watching: load.watching,
    streamActive: load.streams > 0,
    capBps: dlrace.parseRate(settings.data.aria2MaxDownload),
    totalBps: line.total,
    peakBps: line.peak ? line.peak.bps : 0,
    racesRunning: races,
  };
};

const candidateView = (job, rec) => ({
  ...viewOf(job, rec.main),
  searchable: dlrace.searchable(job),
  challengersStarted: job.raceCount || 0,
  retryAt: rec.raceRetryAt,
  racing: !!rec.ch,
});

// Start the challenger. It does NOT take a "downloads at once" slot — it
// lives inside its job's record, and `active` (what pump() counts) has one
// entry per job.
const startChallenger = (job, rec, source, why, t) => {
  const { magnet, announce } = torrent.magnetFor(source.infoHash);
  const ch = newAttempt("challenger", {
    infoHash: source.infoHash, fileIdx: source.fileIdx || 0, magnet, announce,
    quality: source.quality || job.quality, sizeBytes: source.sizeBytes || 0,
    provider: source.provider || null, seeders: source.seeders || 0, release: source.release || null,
  }, t);
  rec.ch = ch;
  rec.ko = null;
  rec.lead = "main";
  rec.preRaceBps = rec.main.speed;
  job.raceCount = (job.raceCount || 0) + 1;
  job.race = { state: "probing", why, at: now() };
  job.attempts = [persisted(job, rec.main), persisted(job, ch)];
  job.raceNote = null;
  // The original is what made this necessary; if it wins after all, "won"
  // replaces this.
  remember(job, job.infoHash, "stalled");
  store.save();
  broadcast(job);
  console.log(`[download] ${job.id.slice(0, 6)} trying a second source ${ch.infoHash.slice(0, 8)}… (${sourceLabel(ch.src)}) — ${why}`);

  Promise.resolve()
    .then(() => aria2.add(magnet, ch.infoHash, ch.fileIndex))
    .then((gid) => {
      if (ch.dead) return settleOrphanGid(ch, gid);
      ch.gid = gid;
      if (!ch.metaAt) ch.metaAt = seams.clock();
      startPolling();
    }, (e) => {
      if (ch.dead) return;
      attemptFailed(job, rec, ch, errText(e));
    });
};

// A slow job was picked: look up its title's other sources, choose one, check
// the disk with BOTH copies counted, start it. Everything is re-checked after
// the lookup — it can take a while, and the job may have finished, been
// cancelled, or someone may have pressed Play.
const beginRace = async (job, rec, why) => {
  const main = rec.main;
  const cfg = raceCfg();
  const still = () => active.get(job.id) === rec && rec.main === main && !main.dead && !rec.copying && !rec.ch && job.status === "downloading";
  const notNow = () => { rec.raceRetryAt = seams.clock() + cfg.retryMin * 60 * 1000; };
  rec.raceBusy = true;
  try {
    let found;
    try {
      found = await seams.findSources(job);
    } catch (e) {
      if (still()) { notNow(); console.warn(`[download] ${job.id.slice(0, 6)} no second source: the source list could not be fetched (${errText(e)})`); }
      return;
    }
    if (!still()) return;
    rec.raceBusy = false;       // (raceEnv counts lookups in flight; not this one twice)
    const t = seams.clock();
    if (!dlrace.shouldRace(candidateView(job, rec), raceEnv(t), cfg, t).race) return;

    const pick = dlrace.chooseChallenger({
      job, streams: found && found.streams, history: sourceMemory.forTitle(dlrace.titleKey(job)),
      live: otherSources(job.id), cfg, now: t,
    });
    if (!pick.source) {
      notNow();
      console.log(`[download] ${job.id.slice(0, 6)} no second source: ${pick.reason}`);
      // The honest ending: nothing else at this resolution is healthy. The job
      // is NOT moved to another resolution; it keeps its original.
      setNote(job, pick.exhausted ? dlrace.exhaustedNote(pick.resolution) : `No second source: ${pick.reason}.`);
      return;
    }
    // The disk gate with both copies counted: committedBytes() already holds
    // what is left of this job's original; the challenger's size is added.
    const gate = diskGate(job.type, pick.source.sizeBytes);
    if (!gate.ok) {
      notNow();
      setNote(job, "A second source was found, but there is not enough free disk space to fetch two copies.");
      return;
    }
    startChallenger(job, rec, pick.source, why, t);
  } finally {
    rec.raceBusy = false;
  }
};

// Once per poll, after every attempt has its fresh numbers: move the races
// that are on, then see whether one should start.
const raceTick = (t, cfg) => {
  for (const [id, rec] of [...active]) {
    const ch = rec.ch;
    const job = findJob(id);
    if (!ch || rec.copying || !job || job.status !== "downloading") continue;

    // 5. the probe
    if (ch.state === "probing") {
      const verdict = dlrace.probeVerdict(ch, t, cfg);
      if (verdict === "pass") {
        ch.state = "racing";
        ch.racingAt = t;
        if (job.race) job.race.state = "racing";
        store.save();
        broadcast(job);
        console.log(`[download] ${id.slice(0, 6)} second source connected — racing`);
      } else if (verdict === "fail") {
        challengerOut(job, rec, "probe", `A second source (${sourceLabel(ch.src)}) did not connect.`);
      }
      continue;
    }

    // 8. early knockout — on time remaining
    const etaMain = etaOf(job, rec.main);
    const etaCh = etaOf(job, ch);
    const ko = dlrace.knockout({ etaMain, etaCh, prev: rec.ko, now: t }, cfg);
    rec.ko = ko.state;
    if (ko.drop === "main") { promote(job, rec, "lost", null); continue; }
    if (ko.drop === "ch") { challengerOut(job, rec, "lost", `A second source (${sourceLabel(ch.src)}) was tried and was slower.`); continue; }

    // …and the reverse: a race that adds nothing is stopped
    if (dlrace.noGain({
      preRaceBps: rec.preRaceBps, mainBps: rec.main.speed, chBps: ch.speed,
      racingMs: t - (ch.racingAt || t), remainingMain: viewOf(job, rec.main).remainingBytes, etaCh,
    }, cfg)) {
      challengerOut(job, rec, null, "A second source was tried and made no difference — the connection, not the source, is the limit.");
    }
  }

  if (!cfg.enabled) return;
  const env = raceEnv(t);
  const cands = [];
  for (const [id, rec] of active) {
    const job = findJob(id);
    if (!job || job.status !== "downloading" || rec.copying || rec.ch || rec.raceBusy) continue;
    const d = dlrace.shouldRace(candidateView(job, rec), env, cfg, t);
    rec.whyNot = d.slow && d.blocked ? d.blocked.text : null;
    // 10. the lifetime limit is reached and it is still slow: say so, and
    // leave it to the healer's stall handling.
    if (d.slow && d.blocked && d.blocked.code === "limit") {
      setNote(job, dlrace.limitNote(job.raceCount || 0, dlrace.resolutionOf(job.quality)));
    }
    if (d.race) cands.push({ job, rec, why: d.slow, smart: !!job.smart, startedAt: rec.main.startedAt });
  }
  const pick = dlrace.pickJobToRace(cands);
  if (pick) {
    beginRace(pick.job, pick.rec, pick.why).catch((e) => console.error("[download] could not start a second source:", errText(e)));
  }
};

// Deep diagnostics for the admin panel: what aria2 says about every live
// download, which is now the whole truth about them.
const stats = async () => {
  if (!aria2.available()) return [];
  const live = await aria2.activeDownloads().catch(() => []);
  return live.map((d) => ({
    infoHash: d.infoHash || null,
    downloadSpeed: Number(d.downloadSpeed || 0),
    connections: Number(d.connections || 0),
    seeders: Number(d.numSeeders || 0),
    completed: Number(d.completedLength || 0),
    total: Number(d.totalLength || 0),
    files: (d.files || [])
      .filter((f) => f.selected === "true")
      .map((f) => ({
        name: path.basename(f.path),
        completed: Number(f.completedLength),
        length: Number(f.length),
      })),
  }));
};

// The file is in the library — record it, fetch the poster, index it.
const finish = async (job, destPath) => {
  const destDir = path.dirname(destPath);

  // Poster (movies get their own folder; a show's cover lives at the show root,
  // one level up from the Season folder, written once).
  const coverDir = job.type === "show" ? path.dirname(destDir) : destDir;
  const coverPath = path.join(coverDir, "cover.jpg");
  if (!fs.existsSync(coverPath)) await saveCover(job.poster, coverDir);

  // Same subtitle choice the stream offered (best-effort; never fatal).
  await saveExternalSubtitles(job, destPath).catch(() => {});

  stopActive(job.id); // releases the aria2 download if no sibling job needs it
  job.status = "done";
  job.progress = 1;
  job.downloadSpeed = 0;
  job.phase = null;
  job.copyProgress = null;
  job.destPath = destPath;
  job.doneAt = now();
  job.raceNote = null;
  store.save();

  // The viewer picked this title BY IMDb id; file that under the name the
  // scanner is about to index it as, so the library copy is recognised as
  // this exact title everywhere (detail page, Continue Watching, Up Next)
  // instead of being re-guessed from a folder name. Only now, with the file
  // really in the library — a declined or canceled job must not seed it.
  imdb.remember(job.title, job.type, job.year, job.imdbId);
  // Index it into the library FIRST, so the "done" update below already
  // carries the library id (the downloads page's Play button), then tell
  // everyone. (The scan also folds any history watched as a stream into the
  // new file's title — profiles.js.)
  scanner.scan();
  broadcast(job);
  scanner.enrich();
  realtime.broadcastAll({ type: "library_updated" });
  // An episode's intro / recap / credits go on file NOW, while nobody is
  // watching yet — not on its first play, and not whenever the background
  // fill reaches it. Fire-and-forget; the audio pass still runs after
  // enrichment and its answer, measured on the file, wins where it has one.
  if (job.type === "show") {
    const libId = scanner.idForPath(destPath);
    if (libId) require("./introdetect").fillEpisode(libId).catch(() => {});
  }
  // A play-ready copy, when this household's devices need one (preconvert.js
  // decides — most of the time the answer is "no", and nothing is made).
  {
    const libId = scanner.idForPath(destPath);
    if (libId) require("./preconvert").consider(libId);
  }
  console.log(`[download] ${job.id.slice(0, 6)} done "${job.title}"`);
  notify.send("Aurora: download ready", `"${job.label || job.title}" is downloaded and in the library.`);
  // …and the person who asked for it (or whose follow / smart download
  // fetched it) hears on the devices where they switched notifications on.
  if (job.profile) {
    try {
      const libId = scanner.idForPath(destPath);
      require("../lib/push").send(job.profile, {
        title: job.type === "show" && job.season ? `${job.title} · S${job.season} E${job.episode}` : job.title,
        body: "Downloaded and ready to watch.",
        url: libId ? `/#/play/${libId}` : "/#/downloads",
        tag: `dl-${job.id}`,
      });
    } catch (e) {
      console.warn("[push] not sent:", e && e.message);
    }
  }
  // The file is safely in the library now, so the staging copy can go — unless a
  // sibling episode from the same pack still needs it.
  purgeIfUnused(job.infoHash, job.id);
  pump();
};

// ---------- what the healer (lib/healer.js) reads and may do ----------
// The queue as a health picture: running jobs with their live records (the
// stall clocks live there), how long the oldest approved job has waited with
// a free slot, how many died in the last hour, whether the poller that
// should be ticking actually is.
const queueHealth = () => {
  const nowMs = Date.now();
  const activeJobs = [];
  for (const [id, rec] of active) {
    const job = findJob(id);
    if (job) activeJobs.push({ job, rec, racing: !!rec.ch, raceState: rec.ch ? rec.ch.state : null, whyNot: rec.whyNot });
  }
  const approved = store.data.filter((j) => j.status === "approved" && !active.has(j.id));
  const oldestApproved = approved.reduce((m, j) => Math.max(m, nowMs - (Date.parse(j.approvedAt || j.at) || nowMs)), 0);
  const slots = slotState();
  return {
    active: activeJobs,
    activeCount: active.size,
    // The number of jobs that may run RIGHT NOW (the setting, or 2 while
    // someone is watching) — what "a slot is free" has to be measured against.
    maxActive: slots.cap,
    maxActiveSetting: slots.maxActive,
    holding: slots.holding,
    watching: slots.watching,
    races: activeJobs.filter((a) => a.racing).length,
    approvedWaiting: approved.length,
    oldestApprovedAgeMs: oldestApproved,
    pending: store.data.filter((j) => j.status === "pending").length,
    errorsLastHour: store.data.filter((j) => j.status === "error" && nowMs - (Date.parse(j.resolvedAt || j.at) || 0) < 3600e3).length,
    lastError: (store.data.find((j) => j.status === "error") || {}).error || null,
    doneLastDay: store.data.filter((j) => j.status === "done" && nowMs - (Date.parse(j.doneAt) || 0) < 86400e3).length,
    pollerExpected: [...active.values()].some((r) => !r.copying && (r.main.gid || (r.ch && r.ch.gid))),
    pollerRunning: !!poller,
  };
};
// Every torrent some live job still wants — its own source and, during a
// race, its second one. Staging folders outside this set belong to nobody.
const liveInfoHashes = () => {
  const out = new Set();
  for (const j of store.data) {
    if (!LIVE_STATUSES.includes(j.status)) continue;
    if (j.infoHash) out.add(String(j.infoHash).toLowerCase());
    for (const a of j.attempts || []) if (a.infoHash) out.add(String(a.infoHash).toLowerCase());
  }
  return out;
};
// Start over on a job that has stopped moving: drop its aria2 download (the
// staging bytes stay, aria2 continues from them) and queue it again. Never
// while a second source is being tried — the race is the remedy then, and
// restarting the original would throw its head start away.
const restartJob = (id, why) => {
  const job = findJob(id);
  if (!job || job.status !== "downloading") return false;
  const rec = active.get(id);
  if (rec && (rec.ch || rec.raceBusy || rec.copying)) return false;
  remember(job, job.infoHash, "stalled");
  stopActive(id, `restarted by the healer: ${why}`);
  job.status = "approved";
  job.phase = null;
  job.downloadSpeed = 0;
  job.peers = 0;
  store.save();
  broadcast(job);
  later(pump, 1500);
  return true;
};
const pumpNow = () => { if (!torrentGate.enabled()) return; try { pump(); startPolling(); } catch (e) { console.error("[download] pump failed:", e && e.message); } };

// ---------- "Downloads at once" (the admin's setting) ----------
// What the admin card shows.
const slots = () => {
  const s = slotState();
  return {
    maxActive: s.maxActive, min: dlslots.MIN_ACTIVE, max: dlslots.MAX_ACTIVE,
    cap: s.cap, holding: s.holding, watching: s.watching, holdAt: dlslots.WATCH_HOLD,
    active: active.size,
    queued: store.data.filter((j) => j.status === "approved" && !active.has(j.id)).length,
  };
};
// Change it. Takes effect at once: a raise pumps the queue; a lower number
// stops nothing — pump() only ever starts jobs.
const setMaxActive = async (value) => {
  const n = dlslots.parseMaxActive(value);
  if (n == null) return { error: `Downloads at once must be a whole number from ${dlslots.MIN_ACTIVE} to ${dlslots.MAX_ACTIVE}.` };
  settings.data.maxActiveDownloads = n;
  settings.save();
  let applied = false;
  try {
    if (aria2.running() && typeof aria2.applyEnginePlan === "function") applied = !!(await aria2.applyEnginePlan()).applied;
  } catch (e) {
    console.warn("[download] could not tell the running engine about the new limit:", errText(e));
  }
  pumpNow();
  return { ok: true, maxActive: n, applied };
};

// On boot, resume anything that was approved/downloading when we stopped. The
// staging bytes survive a restart, and aria2 continues from them.
const resume = () => {
  let any = false;
  const dropped = [];
  for (const job of store.data) {
    if (job.status === "downloading" || job.status === "approved") {
      // Stopped in the middle of a second-source race: the attempt with more
      // of the file on disk carries on alone, the other is dropped.
      if (job.attempts && job.attempts.length > 1) {
        const keep = dlrace.settleOnRestart(job.attempts);
        const gone = job.attempts[1 - keep];
        if (keep === 1) adopt(job, job.attempts[1]);
        console.log(`[download] ${job.id.slice(0, 6)} was mid-race at shutdown — carrying on with ${String(job.infoHash).slice(0, 8)}…`);
        dropped.push([gone.infoHash, job.id]);
      }
      clearRace(job);
      job.status = "approved";
      job.progress = 0;
      job.downloadSpeed = 0;
      job.peers = 0;
      job.phase = null;
      job.copyProgress = null;
      any = true;
    } else if (job.race || job.attempts) {
      clearRace(job);
      any = true;
    }
  }
  for (const [hash, id] of dropped) purgeIfUnused(hash, id);
  if (any) {
    store.save();
    // Defer so the server finishes booting before we hit the network.
    later(pump, 4000);
  }
};

module.exports = {
  list, listFor, create, approve, decline, cancel, cancelOwn, removeOwn, remove, resume, publicJob, publicJobFor, stats, markSeen, pruneGone,
  queueHealth, liveInfoHashes, restartJob, pumpNow, smartOnDisk, rawJobs, slots, setMaxActive,
  // Pure helpers, exported so test/downloads.test.js can pin the rules that
  // decide where a file lands and whether a request needs approval — and the
  // seams test/dlrace-queue.test.js uses to play the queue out against a fake
  // engine (never in a running server).
  _internals: {
    safeName, folderKey, chooseFolder, diskGate, destinationFor, store,
    active, seams, line, poll: () => poll(), raceTick: () => raceTick(seams.clock(), raceCfg()),
    setEngine: (engine) => { aria2 = engine; },
  },
};
