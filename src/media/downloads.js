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
const aria2 = require("./aria2");
const websubs = require("./websubs");
const { JsonStore } = require("../lib/jsonstore");

const store = new JsonStore(path.join(config.DATA_DIR, "downloads.json"), []);

const MAX_ACTIVE = 2;      // concurrent downloads
const MAX_JOBS = 200;      // cap the persisted history
const POLL_MS = 1000;      // how often aria2 is asked where the running jobs are

// Runtime state for running jobs (never persisted): what aria2 calls them, and
// where the finished file has to land.
//   jobId -> { gid, fileIndex (1-based), dir, base, copying }
const active = new Map();

// ---------- helpers ----------
const now = () => new Date().toISOString();

const broadcast = (job) => realtime.broadcastAll({ type: "download_update", job: publicJob(job) });

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
});

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

const create = (fields) => {
  const {
    infoHash, fileIdx, type, imdbId, title, label, year, poster,
    quality, sizeBytes, season, episode, provider, seeders, profile,
  } = fields || {};

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
    `${job.profile || "Someone"} requested "${job.label || job.title}"` +
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

const remove = (id) => {
  const i = store.data.findIndex((j) => j.id === id);
  if (i === -1) return { error: "not found" };
  const { infoHash } = store.data[i];
  stopActive(id, "removed");
  store.data.splice(i, 1);
  store.save();
  purgeIfUnused(infoHash, id);
  pump();
  return { ok: true };
};

// Start any approved jobs up to the concurrency cap.
const pump = () => {
  if (activeCount() >= MAX_ACTIVE) return;
  const queued = store.data.filter((j) => j.status === "approved" && !active.has(j.id));
  for (const job of queued) {
    if (activeCount() >= MAX_ACTIVE) break;
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

const startJob = async (job) => {
  if (active.has(job.id)) return;
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
  active.set(job.id, { gid: null, fileIndex: (job.fileIdx || 0) + 1, ...dest, copying: false });
  console.log(`[download] ${job.id.slice(0, 6)} started ${job.infoHash.slice(0, 8)}… "${job.label || job.title}"`);

  const gid = await aria2.add(job.magnet, job.infoHash, (job.fileIdx || 0) + 1);
  const rec = active.get(job.id);
  if (!rec) {                 // canceled while the details were being fetched
    await aria2.remove(gid).catch(() => {});
    return;
  }
  rec.gid = gid;
  job.phase = "downloading";
  broadcast(job);
  console.log(`[download] ${job.id.slice(0, 6)} aria2 gid ${gid}, file #${rec.fileIndex}`);
  startPolling();
};

// ---------- progress ----------
// One timer for all running jobs. aria2 is the only source of truth here:
// files[].completedLength is exactly "bytes of this episode that are on disk".
let poller = null;
let saveCounter = 0;

const startPolling = () => {
  if (poller || !active.size) return;
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

const poll = async () => {
  if (!active.size) return stopPolling();

  // One status call per torrent, however many jobs are riding on it.
  const byGid = new Map();
  for (const [jobId, rec] of active) {
    if (!rec.gid || rec.copying) continue;
    if (!byGid.has(rec.gid)) byGid.set(rec.gid, []);
    byGid.get(rec.gid).push(jobId);
  }

  for (const [gid, jobIds] of byGid) {
    let st;
    try {
      st = await aria2.status(gid);
    } catch (e) {
      // The download is gone from aria2 (removed behind our back, or the daemon
      // restarted). Put the jobs back in the queue rather than losing them.
      for (const id of jobIds) requeue(id, e && e.message);
      continue;
    }

    for (const jobId of jobIds) {
      const rec = active.get(jobId);
      const job = findJob(jobId);
      if (!rec || !job || job.status !== "downloading") continue;

      if (st.state === "error") { fail(job, st.error || "aria2 reported an error"); continue; }
      if (st.state === "removed") { requeue(jobId, "the download was removed"); continue; }

      const f = aria2.fileProgress(st, rec.fileIndex);
      if (!f) continue;                       // torrent details not in yet

      job.progress = f.fraction;
      job.downloadSpeed = st.downloadSpeed;
      job.peers = st.peers;
      // Progress for one file inside a pack only moves when a whole piece of
      // THAT file lands, so there is a real window where the engine is working
      // hard and the number is still 0. Saying "starting" beats showing a 0%
      // that looks like nothing is happening.
      job.phase = f.completed > 0 ? "downloading" : "starting";
      broadcast(job);
      if (++saveCounter % 10 === 0) store.save();

      // This job's file is complete — even when the torrent as a whole isn't,
      // because a sibling episode is still coming.
      if (f.length > 0 && f.completed >= f.length) {
        rec.copying = true;
        completeJob(job, rec, f, st).catch((e) => {
          rec.copying = false;
          fail(job, e && e.message ? e.message : String(e));
        });
      }
    }
  }
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
  active.delete(jobId);
  stopPolling();
  if (!job || job.status !== "downloading") return;
  console.warn(`[download] ${jobId.slice(0, 6)} re-queued: ${why || "download vanished"}`);
  job.status = "approved";
  job.phase = null;
  store.save();
  broadcast(job);
  setTimeout(pump, 2000);
};

// Stop a job's download without changing its status. If a sibling job is still
// using that torrent, only this job's file is dropped from the selection.
function stopActive(id, why) {
  const rec = active.get(id);
  if (!rec) return;
  active.delete(id);
  stopPolling();
  if (why) console.log(`[download] ${id.slice(0, 6)} ${why}`);
  if (!rec.gid) return;
  const shared = [...active.values()].some((r) => r.gid === rec.gid);
  (async () => {
    if (shared) await aria2.select(rec.gid, rec.fileIndex, false).catch(() => {});
    else await aria2.remove(rec.gid).catch(() => {});
  })();
}

// Delete a pack's staging bytes once NOTHING in the queue wants them. Only this
// module can make that call: aria2 knows what is downloading, but the jobs that
// matter are the queued ones it hasn't been told about yet.
const LIVE_STATUSES = ["pending", "approved", "downloading"];
function purgeIfUnused(infoHash, exceptId) {
  if (!infoHash) return;
  const stillWanted = store.data.some(
    (j) => j.id !== exceptId && j.infoHash === infoHash && LIVE_STATUSES.includes(j.status)
  );
  if (stillWanted) return;
  aria2.purge(infoHash).catch(() => {});
}

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
  store.save();
  broadcast(job);

  // Index it into the library and tell everyone.
  scanner.scan();
  scanner.enrich();
  realtime.broadcastAll({ type: "library_updated" });
  console.log(`[download] ${job.id.slice(0, 6)} done "${job.title}"`);
  notify.send("Aurora: download ready", `"${job.label || job.title}" is downloaded and in the library.`);
  // The file is safely in the library now, so the staging copy can go — unless a
  // sibling episode from the same pack still needs it.
  purgeIfUnused(job.infoHash, job.id);
  pump();
};

// On boot, resume anything that was approved/downloading when we stopped. The
// staging bytes survive a restart, and aria2 continues from them.
const resume = () => {
  let any = false;
  for (const job of store.data) {
    if (job.status === "downloading" || job.status === "approved") {
      job.status = "approved";
      job.progress = 0;
      job.downloadSpeed = 0;
      job.peers = 0;
      job.phase = null;
      job.copyProgress = null;
      any = true;
    }
  }
  if (any) {
    store.save();
    // Defer so the server finishes booting before we hit the network.
    setTimeout(pump, 4000);
  }
};

module.exports = {
  list, create, approve, decline, cancel, remove, resume, publicJob, stats,
  // Pure helpers, exported so test/downloads.test.js can pin the rules that
  // decide where a file lands and whether a request needs approval.
  _internals: { safeName, folderKey, chooseFolder, diskGate, destinationFor },
};
