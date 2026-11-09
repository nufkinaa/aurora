// Download-to-server: turn a chosen torrent source into a permanent library
// file. A viewer requests a download from the detail page; aria2 fetches the
// chosen file, we copy it into the configured library folder (with subtitles and
// a poster), and the scanner indexes it as a normal downloaded title — which
// then seeks and resumes natively like any other local file.
//
// Three policies live here, and only here:
//
//   * APPROVAL IS DISK-GATED, not manual. A request starts on its own as long as
//     the library volume would still be DOWNLOAD_MIN_FREE_PERCENT free once it
//     lands; an admin is only asked when that check fails — see diskGate().
//   * WHO GOES FIRST. A person's request, then the automatic kinds — see
//     "the order" above pump() (the rule itself is media/dlslots.js plan()).
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
const badreleases = require("./badreleases");
const dlhealth = require("./dlhealth");
const dlprio = require("./dlprio");
const dlfallback = require("./dlfallback");
const langcheck = require("./langcheck");
const copylang = require("./copylang");

const store = new JsonStore(path.join(config.DATA_DIR, "downloads.json"), []);

// How many downloads run at once is the admin's "Downloads at once" setting
// (1–6, default 4 — media/dlslots.js), held at 2 while anyone is watching.
const maxActive = () => dlslots.effectiveMaxActive(settings.data.maxActiveDownloads);
const HOLD_RECHECK_MS = 20 * 1000; // while holding for viewers: look again this often
const ENGINE_QUIET_MS = 60 * 1000; // no failed status call for this long = the engine is healthy
const raceCfg = () => dlrace.resolveConfig(config.DOWNLOAD_RACE);
const healthCfg = () => dlhealth.resolveConfig(config.DOWNLOAD_HEALTH);
const prioCfg = () => dlprio.resolveConfig(config.DOWNLOAD_PRIORITY);
const MAX_JOBS = 200;      // cap the persisted history
const POLL_MS = 1000;      // how often aria2 is asked where the running jobs are

// Runtime state for running jobs (never persisted): what aria2 calls them, and
// where the finished file has to land.
//   jobId -> { gid, fileIndex (1-based), dir, base, copying }
const active = new Map();

// ---------- helpers ----------
// (the wall clock through the seam, so a test's clock and the stamps agree)
const now = () => new Date(seams.wall()).toISOString();

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
// The clock every stall and race timer runs on is MONOTONIC: it keeps
// counting at the same pace whatever the wall clock does. A server whose
// clock is set forward by a few minutes (NTP after a boot, a VM restored)
// used to see every running download "stuck for 10 minutes" in one tick.
// `wall` is the real time, for what is persisted or comes from a client.
const mono = () => performance.timeOrigin + performance.now();
const seams = {
  clock: mono,
  wall: () => Date.now(),
  auto: true, // false: no poll timer, no delayed pumps — the test calls poll() / pumpNow()
  load: liveLoad,
  findSources: (job) => torrent.getSources(job.type === "show" ? "series" : "movie", job.imdbId, job.year, job.season, job.episode),
  // the torrents being STREAMED right now (lower-case infoHashes): a download
  // that is also being watched as it lands is "watching now" (media/dlprio.js)
  streaming: () => {
    try {
      const t = Date.now();
      return new Set(torrent.listTorrents().filter((x) => !x.quiesced && t - (x.lastAccess || 0) < 2 * 60 * 1000).map((x) => String(x.infoHash || "").toLowerCase()));
    } catch { return new Set(); }
  },
  // What the finished file itself says, from ffprobe: { video, duration,
  // invalid }. null when it could not be asked (no ffprobe, a timeout) —
  // only a clear "this is not a video" from ffprobe counts against a copy.
  probe: (file) => new Promise((resolve) => {
    if (!config.ffmpegAvailable || !config.FFPROBE) return resolve(null);
    require("child_process").execFile(config.FFPROBE, ["-v", "error", "-show_entries", "format=duration:stream=codec_type:stream_tags=language,title", "-of", "json", file],
      { encoding: "utf-8", timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          if (err.killed || err.signal) return resolve(null);
          return resolve(/invalid data|moov atom not found|EBML header|could not find codec/i.test(String(stderr || "")) ? { invalid: true, video: false, duration: 0 } : null);
        }
        try {
          const j = JSON.parse(stdout || "{}");
          const streams = j.streams || [];
          resolve({
            video: streams.some((x) => x.codec_type === "video"), duration: Number(j.format && j.format.duration) || 0, invalid: false,
            // each audio track's language tag and title (the language check, media/langcheck.js)
            audio: streams.filter((x) => x.codec_type === "audio").map((x) => ({ language: (x.tags && x.tags.language) || null, title: (x.tags && x.tags.title) || null })),
          });
        } catch { resolve(null); }
      });
  }),
  // a hard link instead of a copy into the library (same volume, not Windows)
  link: process.platform !== "win32",
  // The language check (media/langcheck.js): the audio language a person last
  // picked in a player (their profile's prefs.audioLang), and a title's
  // original language (TMDB: cached, else asked once, briefly — no answer
  // means the check for an ordinary download is simply not made).
  personLang: (who) => {
    try {
      const p = require("../profiles").list().find((x) => x.id === who || x.name === who);
      return (p && p.prefs && p.prefs.audioLang) || null;
    } catch { return null; }
  },
  originalLanguage: async (job) => {
    if (!job.imdbId) return null;
    const discover = require("./discover");
    const kind = job.type === "show" ? "series" : "movie";
    const known = discover.metaCached(kind, job.imdbId);
    if (known) return known.originalLanguage || null;
    const meta = await Promise.race([discover.meta(kind, job.imdbId).catch(() => null), new Promise((r) => { const t = setTimeout(() => r(null), 2500); t.unref?.(); })]);
    return (meta && meta.originalLanguage) || null;
  },
  // does this person want to hear when a download of theirs lands (Settings →
  // "Tell me when a download is ready", prefs.readyNotice; on unless switched off)
  readyNotice: (who) => {
    try {
      const p = require("../profiles").list().find((x) => x.id === who || x.name === who);
      return !(p && p.prefs && p.prefs.readyNotice === false);
    } catch { return true; }
  },
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
//
// A finished EPISODE also says where it sits in the library — its show's id and
// the episode's own name — so the TV can put "New: Silo · S1 E3 — <name>" on
// the launcher's row and in a notification, and open the episode straight in
// the player (tv-native homeScreen.ts / DownloadNotices.kt). `lookup` is a
// prebuilt map for a whole listing; one job at a time asks the scanner.
const publicJobFor = (job, viewer, lookup) => {
  const pj = publicJob(job);
  return { ...pj, ...episodeInfo(job, pj.libraryId, lookup), mine: isRequester(job, viewer) };
};
const episodeInfo = (job, libId, lookup) => {
  if (!libId || job.type !== "show") return {};
  const it = lookup ? lookup(libId) : scanner.findById(libId);
  return it && it.showId ? { showId: it.showId, epTitle: it.title || null } : {};
};
// One pass over the library's episodes instead of one per finished job.
const episodeLookup = () => {
  let map = null;
  return (id) => {
    if (!map) {
      map = new Map();
      for (const s of (scanner.index && scanner.index.shows) || []) {
        for (const se of s.seasons || []) for (const ep of se.episodes || []) map.set(ep.id, { showId: s.id, title: ep.title });
      }
    }
    return map.get(id) || null;
  };
};

// The requester's display name: stored with newer jobs; looked up for jobs
// that carry only the id; the stored value itself for the oldest jobs, which
// kept the name (an id is twelve hex characters, a name is not).
const whoAsked = (j) => {
  if (!j) return null;
  if (j.profileName) return j.profileName;
  if (!j.profile) return null;
  try {
    const p = require("../profiles").list().find((x) => x.id === j.profile);
    if (p && p.name) return p.name;
  } catch {}
  return /^[0-9a-f]{12}$/i.test(j.profile) ? null : j.profile;
};
// The others who asked for the same download after it was on its way
// (`also`, profile ids — see create's "same TITLE" join), by name; ids nobody
// has any more are left out, never shown.
const alsoAsked = (j) => {
  if (!j || !Array.isArray(j.also) || !j.also.length) return [];
  let people = [];
  try { people = require("../profiles").list(); } catch {}
  const out = [];
  for (const id of j.also) {
    const p = people.find((x) => x.id === id);
    const name = p && p.name ? p.name : /^[0-9a-f]{12}$/i.test(String(id)) ? null : id;
    if (name && name !== whoAsked(j) && !out.includes(name)) out.push(name);
  }
  return out;
};
// Which automatic kind queued it, for "Automatic · Niso's next episode" on the
// admin's Downloads screen: "next" (smart downloads; the oldest smart jobs
// carry no kind and are these), "follow" (a followed show's new episode),
// "ahead" (the episode after next, downloaded ahead — media/overnight.js), or
// just "auto" for any other (the old My List downloads: no My List tag is sent
// any more, mylistdl-queue.test.js) — null for a download a person asked for.
// (Not `auto`, the stored field, which stays server-side.)
const autoKind = (j) => {
  if (!j.smart && !j.auto) return null;
  const k = j.auto || "next";
  return k === "next" || k === "follow" || k === "ahead" ? k : "auto";
};

// Strip fields nobody outside needs; keep it small for WS.
const publicJob = (j) => ({
  id: j.id, infoHash: j.infoHash, fileIdx: j.fileIdx, imdbId: j.imdbId || null,
  title: j.title, label: j.label, type: j.type,
  season: j.season, episode: j.episode, quality: j.quality,
  sizeBytes: j.sizeBytes, poster: j.poster, provider: j.provider, release: j.release || null,
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
  // waiting only because this account already has its downloads running
  accountLimit: j.status === "approved" && overLimit.has(j.id) ? perAccount() : null,
  // Who started it, by NAME only (elia 2026-10-11: "downloads should say who
  // started them"); the profile id stays server-side.
  by: whoAsked(j),
  // …the others who asked for it too, and which automatic kind queued it
  // (then `by` is the person it was for: whose next episode, whose follow).
  alsoBy: alsoAsked(j),
  autoFor: autoKind(j),
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
  // "Get another version" (media/replace.js): this download REPLACES the copy
  // in the library under `libraryId` once it is complete; `replaceWait`: it
  // is complete, and waits for nobody to be playing the old copy.
  replaces: j.replaces ? { id: j.replaces.id, libraryId: j.replaces.libraryId, reason: j.replaces.reason, reasonLabel: j.replaces.reasonLabel || null } : null,
  replaceWait: !!j.replaceWait,
  // Who cancelled it: "self" (the person who asked) or "admin". A cancelled row
  // read just "Canceled", which left a person (and the admin reading a report)
  // guessing who did it (Niso's report, 2026-10-31). Null on older jobs.
  canceledBy: j.status === "canceled" ? j.canceledBy || null : null,
  // ---- downloads v2 (docs/downloads-v2.md, "For the admin screen") ----
  // The plain sentence about what is going on right now, for every client
  // ("No one is sharing this copy right now — trying another"); null when
  // there is nothing to say beyond the status.
  note: LIVE_STATUSES.includes(j.status) ? j.note || null : null,
  // Which class it is in (media/dlprio.js): 0 watching now, 1 asked for,
  // 2 next episode, 3 background — after ageing.
  priority: LIVE_STATUSES.includes(j.status) ? priorityOf(j) : null,
  // Is the copy alive (media/dlhealth.js): starting | ok | slow | stalled |
  // dead, why in words, and whether it counts against "Downloads at once".
  health: j.status === "downloading" && j.health ? { ...j.health } : null,
  // Copies tried for this job, the most it may try, and the copies that
  // were given up on (newest last).
  sources: (j.tried && j.tried.length) || j.retries ? { tried: (j.tried || []).length + 1, max: dlfallback.MAX_SOURCES, retries: j.retries || 0, given: (j.tried || []).map((x) => ({ infoHash: x.h, release: x.rel || null, quality: x.q || null, why: x.why || null })) } : null,
  // Held back for a moment while a "watching now" download goes first.
  heldBack: j.status === "downloading" && j.heldBack ? { ...j.heldBack } : null,
  // Waiting to try again (no copy could be found just now): when.
  retryAt: j.status === "approved" && j.retryAt ? j.retryAt : null,
  // Time left at the speed it has had lately (seconds), null when unknown.
  etaSec: j.status === "downloading" && Number.isFinite(j.etaSec) ? j.etaSec : null,
  // ---- "tell me when it's ready" + the language check ----
  // The sentences every client says when a download lands, from here so the
  // website, the TV and the phone say the same: `readyLine` ("“Film” is ready
  // to watch") and, when the language check has something to say, `langLine`
  // ("This copy doesn't say its language — report it again if it's wrong.").
  readyLine: j.status === "done" ? readyLineOf(j) : null,
  langLine: j.status === "done" ? langLineOf(j) : null,
});
// What the person is told when it lands (publicJob readyLine).
const readyLineOf = (j) => {
  const name = String(j.label || j.title || "").replace(/ — another version$/, "");
  return j.replaces ? `The new version of “${name}” is in — ready to watch` : `“${name}” is ready to watch`;
};
// What the language check found, when it is worth saying (publicJob langLine).
const langLineOf = (j) => {
  const c = j.langCheck;
  if (!c) return null;
  if (c.verdict === "unknown" && isLanguageReplace(j)) return langcheck.UNKNOWN_LINE;
  if (c.verdict === "kept" && (c.has || []).length && (c.want || []).length) return langcheck.lines.keptWrong(c.has, c.want);
  return null;
};

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

// The library root a job lands in. Falls back to null if nothing is
// configured for that media type. One folder: that one, as always. Several
// (more than one drive in use — lib/drives, docs/storage-drives.md): the
// drive with room (keeping its reserve), the fastest of the roomy ones, and
// for a show the drive it already lives on when that has room
// (lib/drives/rules.js pick). `job` (optional): { id, title, sizeBytes }.
const drivesLib = require("../lib/lazy")(require, "../lib/drives");
const rootsOf = (type) => (type === "show" ? config.LIBRARIES.shows : config.LIBRARIES.movies) || [];
// Does the show already have a folder in `root`? From the last library walk's
// listing (a network root is never read on the way to answering), else the disk.
const showFolderIn = (root, title) => {
  let names = null;
  try { names = scanner.rootFolders(root); } catch {}
  if (!names) {
    let net = false;
    try { const o = drivesLib().onPath(root); net = !!(o && o.network); } catch {}
    names = net ? [] : foldersIn(root);
  }
  const want = folderKey(title);
  return names.some((n) => folderKey(n) === want);
};
// Bytes still to land in `root`: jobs on their way there, and — not knowing
// yet where they go — every queued job of the same kind.
const committedOn = (root, type, excludeId) =>
  store.data.reduce((n, j) => {
    if (j.id === excludeId || !["approved", "downloading"].includes(j.status)) return n;
    if (j.destRoot ? j.destRoot !== root : (j.type === "show" ? "show" : "movie") !== (type === "show" ? "show" : "movie")) return n;
    if (j.attempts && j.attempts.length > 1) return n + j.attempts.reduce((m, a) => m + Math.max(0, (a.sizeBytes || 0) * (1 - (a.progress || 0))), 0);
    return n + Math.max(0, (j.sizeBytes || 0) * (1 - (j.progress || 0)));
  }, 0);
// Why this job belongs on the fast drive (top-quality 4K, what someone is
// about to watch, a person's own request — lib/drives/rules.js wantsFast), or
// null: HD copies and automatic or background downloads go where there is
// most room. Only for a real job (the disk gate asks with a sketch of one).
const fastWhy = (job) => {
  if (!job || !job.infoHash) return null;
  try {
    let cls = null;
    try { cls = priorityOf(job).base; } catch {}
    return require("../lib/drives/rules").wantsFast(job, cls).why;
  } catch { return null; }
};
const destPick = (type, job = null) => {
  const roots = rootsOf(type);
  if (roots.length <= 1) return { root: roots[0] || null, why: "the only library folder", full: false };
  try {
    return drivesLib().pickRoot(type === "show" ? "show" : "movie", { sizeBytes: (job && job.sizeBytes) || 0, preferFast: fastWhy(job) }, {
      hasShowAt: (root) => !!(job && job.title && type === "show" && showFolderIn(root, job.title)),
      committedOn: (root) => committedOn(root, type, job && job.id),
    });
  } catch (e) {
    return { root: roots[0], why: `the first folder (${(e && e.message) || e})`, full: false };
  }
};
const destRoot = (type, job = null) => destPick(type, job).root;

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
  const several = rootsOf(type).length > 1;
  const root = destRoot(type, { id: excludeId, sizeBytes });
  const s = root ? disk.spaceSync(root) : null;
  if (!s || s.freePct == null || !s.total) {
    return { ok: false, reason: `Couldn't read free space on ${root || "the library drive"}.` };
  }
  // (several drives: only what is on its way to THIS one counts against it)
  const needed = Math.max(0, sizeBytes || 0) + (several ? committedOn(root, type, excludeId) : committedBytes(excludeId));
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
  // the release that was downloaded (its torrent's file name): the providers'
  // files timed for it are ranked first; its frame rate and length drive the
  // timing repairs (media/websubs.js, media/subsync.js)
  const facts = (await require("./metadata").probeAsync(destPath).catch(() => null)) || {};
  const fps = facts.video && facts.video.fps;
  let tracks = [];
  try {
    tracks = await torrent.getSubtitleSources(
      job.type === "show" ? "series" : "movie",
      job.imdbId,
      job.season,
      job.episode,
      { release: job.release || null, fps }
    );
  } catch {
    return 0;
  }
  const { written, duplicates } = await websubs.writeSidecars(tracks, destPath, { facts: { fps, duration: facts.duration } });
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
    const res = await require("../lib/upstream").fetch(posterUrl, {
      headers: { "User-Agent": "Aurora/1.0" },
      timeoutMs: 15000,
      maxBytes: 12 * 1024 * 1024,
    });
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 0) fs.writeFileSync(path.join(destDir, "cover.jpg"), buf);
  } catch {}
};

// ---------- job lifecycle ----------
const findJob = (id) => store.data.find((j) => j.id === id);

// The copies My List downloads fetched before that feature was removed
// (2026-10-26) are still looked after (media/mylistdl.js): it hears at once
// when one of the jobs it queued back then lands, fails or is cancelled. (It
// also re-reads the queue on its daily pass, so a missed call loses nothing.)
// Required here, not at the top: it requires this module.
const tellMyList = (job) => {
  if (!job || job.auto !== "mylist") return;
  try { require("./mylistdl").onJob(job); } catch (e) {
    console.warn("[mylist] pass failed:", e && e.message ? e.message : e);
  }
};

// A replacement (media/replace.js) keeps its own record of how it went.
const tellReplace = (job) => {
  if (!job || !job.replaces) return;
  try { require("./replace").onJob(job); } catch (e) {
    console.warn("[replace] record not updated:", e && e.message ? e.message : e);
  }
};

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
  const lookup = episodeLookup();
  return store.data.map((j) => publicJobFor(j, viewer, lookup));
};

// What a request's `type` means: "show" or "movie" — or null for a word this
// server does not know. The sources API and the website's episode flow say
// "series" (Cinemeta's word), others "episode" or "tv": every one of them is a
// show. It used to be "show" or else a movie — 15 episodes asked for as
// "series" were filed in the Movies folder (2026-10-28). No type at all is a
// movie as it always was, unless the request names an episode. PURE.
const SHOW_WORDS = new Set(["show", "series", "episode", "tv", "tvshow", "tv-show", "tv_show", "season"]);
const MOVIE_WORDS = new Set(["movie", "film"]);
const typeOf = (type, { season = null, episode = null } = {}) => {
  if (type == null || type === "") return season != null && season !== "" && episode != null && episode !== "" ? "show" : "movie";
  const t = String(type).trim().toLowerCase();
  if (SHOW_WORDS.has(t)) return "show";
  if (MOVIE_WORDS.has(t)) return "movie";
  return null;
};

const create = (fields) => {
  const {
    infoHash, fileIdx, imdbId, title, label, year, poster,
    quality, sizeBytes, season, episode, provider, seeders, profile, smart, release,
  } = fields || {};
  const type = typeOf((fields || {}).type, { season, episode });
  if (!type) return { error: `Unknown download type "${String((fields || {}).type).slice(0, 20)}" — say "movie" or "show".` };
  // "Get another version": the copy in the library it replaces. Only
  // media/replace.js sets it, with everything already checked — the routes
  // never pass a client's body through as this.
  const replaces = fields && fields.replaces && typeof fields.replaces === "object" && fields.replaces.libraryId ? fields.replaces : null;

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
  // (a remake shares its title: with both IMDb ids known, they must match)
  const libHit = scanner.allItems().find(
    (i) => i.type === wanted && norm(i.title) === norm(title) && !(imdbId && i.imdbId && String(i.imdbId).toLowerCase() !== String(imdbId).toLowerCase())
  );
  // For movies a library hit means "already have it"; for shows a hit doesn't
  // mean this specific episode exists, so we still allow episode downloads.
  // (A replacement is FOR a title in the library: that is the point of it.)
  if (libHit && wanted === "movie" && !replaces) return { alreadyAvailable: libHit };
  // A replacement never piggybacks on another job: the same source already
  // on its way for somebody else is refused (finished ones are history).
  if (replaces) {
    const busy = store.data.find((j) => sameHash(j.infoHash, infoHash) && j.fileIdx === (fileIdx || 0) && LIVE_STATUSES.includes(j.status));
    if (busy) return { error: "That version is already being downloaded — pick another one, or wait for it to finish." };
  }

  // Dedup on the exact torrent+file, unless the prior attempt failed/declined.
  const dupe = !replaces && store.data.find(
    (j) => j.infoHash === infoHash && j.fileIdx === (fileIdx || 0) &&
      !["error", "declined", "canceled"].includes(j.status)
  );
  if (dupe) {
    // A person pressing Download on the very source a (former) My List
    // download is fetching or fetched: the job is THEIRS from now on — a hand
    // request, which no automatic cleanup may touch (mylistdl.js, smartclean.js).
    if (dupe.auto === "mylist" && !smart) {
      dupe.auto = null;
      dupe.smart = false;
      if (profile) {
        dupe.profile = String(profile).slice(0, 24);
        dupe.profileName = fields.profileName ? String(fields.profileName).slice(0, 40) : null;
      }
      store.save();
      broadcast(dupe);
      console.log(`[download] ${dupe.id.slice(0, 6)} "${dupe.label || dupe.title}" was a My List download — asked for by hand now, so it is kept like any other`);
      pump(); // …and it moves up the queue, with the other hand requests
    }
    return { job: publicJob(dupe), duplicate: true };
  }
  // …or the exact file some job is already fetching as its SECOND source.
  const racing = !replaces && store.data.find(
    (j) => j.status === "downloading" && j.attempts && j.attempts[1] &&
      j.attempts[1].infoHash === infoHash && (j.attempts[1].fileIdx || 0) === (fileIdx || 0)
  );
  if (racing) return { job: publicJob(racing), duplicate: true };
  // …or the same TITLE at the same resolution, already on its way from
  // another copy (two people pressing Download on one episode, a person
  // asking for the episode smart downloads already fetch): one download, not
  // two copies in the library. The second person hears when it lands too; a
  // person's request makes a smart one theirs to keep (no tidy-up).
  const sameTitle = !replaces && imdbId && store.data.find((j) =>
    LIVE_STATUSES.includes(j.status) && !j.replaces && j.imdbId && String(j.imdbId).toLowerCase() === String(imdbId).toLowerCase() &&
    j.type === type && (type !== "show" || (Number(j.season) === Number(season) && Number(j.episode) === Number(episode))) &&
    dlfallback.resolutionOf(j.quality) === dlfallback.resolutionOf(quality));
  if (sameTitle) {
    let changed = false;
    if (!smart && sameTitle.smart) { sameTitle.smart = false; sameTitle.auto = null; changed = true; }
    const who = profile ? String(profile).slice(0, 24) : null;
    if (who && who !== sameTitle.profile && !(sameTitle.also || []).includes(who)) { (sameTitle.also = sameTitle.also || []).push(who); changed = true; }
    if (changed) { store.save(); broadcast(sameTitle); pump(); }
    console.log(`[download] ${sameTitle.id.slice(0, 6)} "${sameTitle.label || sameTitle.title}" asked for again (another copy) — joined the download already on its way`);
    return { job: publicJob(sameTitle), duplicate: true };
  }

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
    // The release name the source was listed under (the admin's "copies of
    // one title" tells two downloads of a film apart by it — media/copies.js).
    release: release ? String(release).slice(0, 200) : null,
    seeders: seeders || 0,
    profile: profile ? String(profile).slice(0, 24) : null,
    // The person, for the admin's notification (profile is an id).
    profileName: fields.profileName ? String(fields.profileName).slice(0, 40) : null,
    smart: !!smart, // queued by smart downloads (the next episode), not by hand
    // which automatic kind: "next" (smart downloads) or "follow" (a followed
    // show's new episode) — its priority class (media/dlprio.js)
    // (or "ahead": the episode after next, downloaded ahead overnight —
    // media/overnight.js; the Background class)
    ...(smart && ["next", "follow", "ahead"].includes(fields.auto) ? { auto: fields.auto } : {}),
    ...(replaces ? { replaces: { ...replaces } } : {}),
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
  const what = job.replaces
    ? `${job.profileName || job.profile || "Someone"} asked for another version of "${job.label || job.title}" (${job.replaces.reasonLabel || job.replaces.reason})` +
      `${job.quality ? ` — ${job.quality}${size}` : size}`
    : `${job.profileName || job.profile || "Someone"} requested "${job.label || job.title}"` +
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
  delete job.canceledBy;
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
  tellMyList(job);
  tellReplace(job);
  endOfJob(job);
  purgeIfUnused(job.infoHash, job.id);
  return { job: publicJob(job) };
};

// `by`: who took it back, "self" (the person who asked) or "admin". This is the
// ONLY place a job becomes "canceled": nothing automatic does (a timeout, a stall
// or a failed copy is `fail()`, status "error"; the disk gate holds a job "pending").
const cancel = (id, by = null) => {
  const job = findJob(id);
  if (!job) return { error: "not found" };
  stopActive(id, "canceled");
  job.status = "canceled";
  if (by === "self" || by === "admin") job.canceledBy = by;
  else delete job.canceledBy;
  delete job.replaceWait;
  job.resolvedAt = now();
  store.save();
  broadcast(job);
  tellMyList(job);
  tellReplace(job);
  // Order matters: pump() may start a queued sibling on this same pack, so decide
  // about the staging bytes FIRST (purgeIfUnused sees that sibling and keeps them).
  endOfJob(job);
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
  return cancel(id, "self");
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

const remove = (id, { by = null } = {}) => {
  const i = store.data.findIndex((j) => j.id === id);
  if (i === -1) return { error: "not found" };
  const { infoHash } = store.data[i];
  const gone = store.data[i];
  stopActive(id, "removed");
  store.data.splice(i, 1);
  endOfJob(gone);
  // a replacement taken off the queue before it landed: cancelled
  if (gone.replaces && LIVE_STATUSES.includes(gone.status)) tellReplace({ ...gone, status: "canceled", canceledBy: by });
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

// ---------- the order ----------
// The rule is media/dlprio.js plan() (classes, ageing, "watching now" first);
// this is the queue as plan() takes it.
//
// WHAT "RUNNING AT ONCE" MEANS (downloads v2): the jobs that HOLD A SLOT —
// every running job except one that is stalled (nothing arriving: it keeps
// looking for peers in the engine, but the next job starts beside it) or
// slow while the line has room. Episodes riding on ONE torrent (a season
// pack) are one slot between them.
const waitingJobs = () => {
  const t = seams.wall();
  return store.data.filter((j) => j.status === "approved" && !active.has(j.id) && !(j.retryAt && Date.parse(j.retryAt) > t));
};
// The torrents being streamed right now, asked at most every few seconds
// (a listing of 200 jobs asks once, not 200 times).
let streamingCache = { at: 0, set: new Set() };
const streamingNow = () => {
  const t = seams.clock();
  if (t - streamingCache.at > 3000) streamingCache = { at: t, set: seams.streaming() };
  return streamingCache.set;
};
// A job's class right now (after ageing) — media/dlprio.js.
const priorityOf = (j) => {
  const t = seams.wall();
  const base = dlprio.baseClass(j, t, streamingNow());
  const waited = j.status === "approved" ? t - (Date.parse(j.approvedAt || j.at) || t) : 0;
  const cls = dlprio.effectiveClass(base, waited, prioCfg());
  return { cls, base, label: dlprio.LABELS[cls], urgent: cls === dlprio.NOW };
};
const keyOf = (j) => String((j && j.infoHash) || (j && j.id) || "").toLowerCase();
const holdsSlot = (rec) => !rec || rec.copying || rec.heldBack || !rec.health || rec.health.holdsSlot !== false;
const queueView = () => {
  const { cap, holding, maxActive: setting } = slotState();
  const holders = [];
  const parked = [];
  let slowFree = 0;
  for (const [id, rec] of active) {
    const j = findJob(id);
    const h = { id, owner: ownerOf(j), key: keyOf(j), cls: j ? priorityOf(j).cls : dlprio.PERSON };
    // (slow-but-alive ones stop counting only up to PARKED_LIVE of them: a
    // day when every copy is slow must not start the whole queue at once)
    const slowOne = rec.health && rec.health.state === "slow";
    if (holdsSlot(rec) || (slowOne && ++slowFree > dlslots.PARKED_LIVE)) holders.push(h); else parked.push(h);
  }
  const waiting = waitingJobs().map((j) => ({
    id: j.id, owner: ownerOf(j), key: keyOf(j), cls: priorityOf(j).cls,
    since: Date.parse(j.approvedAt || j.at) || 0,
  }));
  return { cap, setting, holding, holders, parked, waiting, perOwner: perAccount() };
};
// Whose download it is, for the per-account limit: the profile that asked.
const ownerOf = (j) => (j && j.profile ? String(j.profile) : null);
// How many downloads one account may have running at once (dlslots.plan).
// Settings key `maxDownloadsPerAccount` (0 = no limit); 3 by default.
const perAccount = () => {
  const v = Number(settings.data.maxDownloadsPerAccount);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : dlslots.PER_OWNER;
};
// Jobs waiting only because their account already has its share running.
const overLimit = new Set();

// Start the jobs whose turn it is, up to the concurrency cap — a person's
// request first, the automatic kinds after (dlslots.plan). A running job is
// never stopped because the cap came down (the admin lowered the setting, or
// someone pressed Play) — it finishes, new ones wait.
let holdTimer = null;
const pump = () => {
  // "torrents": false — queued jobs stay queued (and untouched: no disk-gate
  // demotion, no admin notification) until the owner switches torrents back on.
  if (!torrentGate.enabled()) return;
  const view = queueView();
  // Held back for viewers with jobs still queued: nothing else will pump when
  // the film ends, so look again shortly.
  if (view.holding && seams.auto && !holdTimer && view.waiting.length) {
    holdTimer = setTimeout(() => { holdTimer = null; pump(); }, HOLD_RECHECK_MS);
    holdTimer.unref?.();
  }
  const p = dlprio.plan(view, prioCfg());

  // jobs that wait only for their account's turn: say so on the job
  const was = new Set(overLimit);
  overLimit.clear();
  for (const id of p.overLimit || []) overLimit.add(id);
  for (const id of new Set([...was, ...overLimit])) { if (was.has(id) !== overLimit.has(id)) { const j = findJob(id); if (j) broadcast(j); } }
  let demoted = false;
  for (const id of p.start) {
    const job = findJob(id);
    if (!job || job.status !== "approved" || active.has(id)) continue;
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
        demoted = true;
        continue; // now pending; it won't be picked up again until an admin acts
      }
    }
    startJob(job).catch((e) => fail(job, e && e.message ? e.message : String(e)));
  }
  // The slot a refused job did not take belongs to the next in line.
  if (demoted) return pump();
  scheduleRetry();
};

// A job waiting to try again (no copy could be found a moment ago) is not in
// the queue until its time comes; one timer brings the queue back then.
let retryTimer = null;
let retryTimerAt = 0;
const scheduleRetry = () => {
  if (!seams.auto) return;
  const t = seams.wall();
  let soonest = Infinity;
  for (const j of store.data) {
    if (j.status !== "approved" || !j.retryAt) continue;
    const at = Date.parse(j.retryAt);
    if (at > t && at < soonest) soonest = at;
  }
  if (!Number.isFinite(soonest)) return;
  if (retryTimer && retryTimerAt <= soonest) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimerAt = soonest;
  retryTimer = setTimeout(() => { retryTimer = null; retryTimerAt = 0; pump(); }, Math.max(1000, soonest - t + 500));
  retryTimer.unref?.();
};

// Everything a job leaves behind when it ends (done, failed, cancelled,
// declined, removed): the copies it set aside (their staging bytes), the
// other downloads it was holding back, its own hold-back record.
const endOfJob = (job) => {
  if (!job) return;
  if (preempt && preempt.jobId === job.id) endPreempt("the download it was for has ended");
  if (preempt && preempt.victims.has(job.id)) releaseVictim(job.id);
  delete job.heldBack;
  delete job.urgentUntil;
  const shelved = job.shelved || [];
  delete job.shelved;
  for (const sh of shelved) purgeIfUnused(sh.infoHash, job.id);
};

const fail = (job, message) => {
  stopActive(job.id, "failed");
  job.status = "error";
  job.error = String(message || "download failed").slice(0, 300);
  job.phase = null;
  job.copyProgress = null;
  job.resolvedAt = now();
  delete job.replaceWait;
  store.save();
  broadcast(job);
  notify.send("Aurora: download failed", `"${job.label || job.title}" — ${job.error}${job.replaces ? " The copy in the library stays as it was." : ""}`);
  tellMyList(job);
  tellReplace(job);
  endOfJob(job);
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
  // A replacement lands where the copy it replaces is, under that file's name.
  if (job.replaces && job.replaces.path) {
    const p = job.replaces.path;
    return { dir: path.dirname(p), base: path.basename(p, path.extname(p)) };
  }
  const pick = destPick(job.type, job);
  const root = pick.root;
  if (!root) throw new Error("no library folder configured");
  if (rootsOf(job.type).length > 1) {
    job.destRoot = root;
    console.log(`[download] ${String(job.id || "").slice(0, 6)} goes to ${root} (${pick.why})`);
  }
  // (a network root's folders from the last walk: no blocking read of a mount that may hang)
  let listing = null;
  try { const o = drivesLib().onPath(root); if (o && o.network) listing = scanner.rootFolders(root) || []; } catch {}
  const folder = chooseFolder(listing || foldersIn(root), job.title, job.year);
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
// job, and on Windows renaming a file it holds open fails. `to` is the TEMP
// name (see "landing in the library" below); it settles once the file is
// closed, so the link/rename that follows never races our own write handle.
//
// On the same volume (and not on Windows) it is a HARD LINK instead: the
// same bytes under a second name, in no time and with no second copy on the
// disk — a 15 GB film used to be read and written again at the very end
// (minutes of disk at full tilt, and twice its size free for that time). A
// finished file is never written again by aria2 (every piece of it is
// verified), so the library's name for it is safe when the staging folder is
// purged. Windows keeps the copy: there aria2 holds its files open in a way
// that a second name could keep the staging folder from being deleted.
const copyIntoLibrary = (from, to, onBytes) =>
  new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (seams.link) {
      try {
        try { fs.unlinkSync(to); } catch {}
        fs.linkSync(from, to);
        try { onBytes && onBytes(fs.statSync(to).size); } catch {}
        return resolve({ linked: true });
      } catch {}
      // (another volume, a file system without links: copy)
    }
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
    ws.on("close", () => settle());
    rs.pipe(ws);
  });

// ---------- landing in the library: never over another file ----------
// Two downloads of one title (two sources of one episode, a film fetched
// again, two requests racing) used to be written to the SAME name: the
// second truncated and rewrote the first, even while somebody was playing
// it. Now nothing in this module ever writes over a file:
//
//   * the name is chosen when the bytes are ready (landingName): the usual
//     "<base><ext>" when it is free, else "<base> (2)<ext>", "(3)"… — both
//     copies stay, and the admin's copies list decides which one goes. A
//     name is taken when a video of that name exists in ANY container (a
//     "Show S01E02.mp4" already there is the same episode). A film's folder
//     holds one film: a new download into a folder that already has a video
//     is always a copy. Choosing the name and putting the file there are one
//     synchronous step, so two jobs finishing together cannot pick the same
//     one. (The scanner keeps indexing the original: scanner.js sorts a
//     "(N)" copy after the files it copies.)
//   * the bytes are written to a hidden temp file in the same folder
//     (".aurora-dl-<job>.part" — not a video extension, so no scan sees it)
//     and only a complete file is put in place: placeNoClobber links it
//     under its final name, which fails if that name exists, instead of a
//     rename that would replace it. A reader never sees half a file.
const COPY_LIMIT = 99;
const tempNameFor = (jobId) => `.aurora-dl-${jobId}.part`;
const TEMP_RE = /^\.aurora-dl-([0-9a-f]{6,24})\.part$/i;

const videoExts = () => (config.VIDEO_EXTENSIONS && config.VIDEO_EXTENSIONS.length ? config.VIDEO_EXTENSIONS : [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v"]);
const hasVideo = (dir) => {
  try {
    return fs.readdirSync(dir).some((f) => videoExts().includes(path.extname(f).toLowerCase()));
  } catch { return false; }
};
// Is there a "<dir>/<name>.<any video ext>"? (existsSync is case-blind
// where the file system is.)
const nameTaken = (dir, name, ext) =>
  [...new Set([String(ext).toLowerCase(), ...videoExts()])].some((e) => fs.existsSync(path.join(dir, `${name}${e}`)));
// → { path, copyOf } — the first free name, and (for the log) the name it is a copy of.
const landingName = (dir, base, ext, { movie = false } = {}) => {
  if (!nameTaken(dir, base, ext) && !(movie && hasVideo(dir))) {
    return { path: path.join(dir, `${base}${ext}`), copyOf: null };
  }
  for (let n = 2; n <= COPY_LIMIT; n++) {
    const name = `${base} (${n})`;
    if (!nameTaken(dir, name, ext)) return { path: path.join(dir, `${name}${ext}`), copyOf: base };
  }
  throw new Error(`more than ${COPY_LIMIT} copies of "${base}" in ${dir}`);
};

// Put the finished temp file at `dest` only if nothing is there. A hard link
// fails on an existing name (EEXIST) — no window between the check and the
// write; a drive without hard links (FAT, some shares) gets the check and a
// rename. → true when placed, false when the name was taken after all.
const placeNoClobber = (tmp, dest) => {
  try {
    fs.linkSync(tmp, dest);
  } catch (e) {
    if (e && e.code === "EEXIST") return false;
    if (fs.existsSync(dest)) return false;
    fs.renameSync(tmp, dest);
    return true;
  }
  try { fs.unlinkSync(tmp); } catch {}
  return true;
};

// A temp file left by a crash in the middle of a copy (its job is not
// running any more): removed the next time a download lands in that folder.
const sweepTemps = (dir, exceptJobId) => {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const f of names) {
    const m = TEMP_RE.exec(f);
    if (!m || m[1] === exceptJobId || active.has(m[1])) continue;
    try { fs.unlinkSync(path.join(dir, f)); console.log(`[download] removed a left-over partial copy ${f}`); } catch {}
  }
};

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
  job.release = src.release ? String(src.release).slice(0, 200) : job.release || null;
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
  require("../lib/tel/timings").downloadStarted(job); // [analytics] asked → approved → started
  job.error = null;
  if (!job.firstStartedAt) job.firstStartedAt = now();
  delete job.retryAt;
  job.health = { state: "starting", code: "finding", why: null, countsAsRunning: true, since: now() };
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
  return runAttempt(job, rec, att);
};

// Ask the engine for one attempt's file and wait for the torrent's details.
// The wait is long on purpose (META_WAIT_MS): when a copy is dead is decided
// by the stall rules (media/dlhealth.js), which take it away — that ends the
// wait too (the attempt is `dead` by then and the answer is ignored).
const META_WAIT_MS = 6 * 3600 * 1000;
const runAttempt = async (job, rec, att) => {
  let gid;
  try {
    gid = await aria2.add(att.src.magnet, att.infoHash, att.fileIndex, { metaTimeoutMs: META_WAIT_MS });
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
//
// What the error MEANS decides what happens next (dlfallback.classifyError):
//   disk     the drive is full — the job waits for room (another copy would
//            not help), keeping what it has
//   dup      the engine already has this torrent — the job is queued again
//            and joins it
//   broken   this copy's data or details are bad — it is filed as broken
//            here and the job moves to the next copy
//   source   it just did not work — the next copy
const attemptFailed = (job, rec, att, message, code = null) => {
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
  const kind = dlfallback.classifyError(code, message);
  if (kind === "disk") return holdForDisk(job, message);
  // (three times at most: an engine that keeps saying "already there" while
  // nothing of ours is there is treated like any other failure)
  if (kind === "dup" && (job.dupTries = (job.dupTries || 0) + 1) <= 3) { requeue(job.id, message); return; }
  switchNow(job, rec, {
    kind: kind === "broken" ? "fake" : "failed",
    why: kind === "broken" ? `the copy's data was damaged (${message})` : message,
  });
};

// The drive filled up under a running download: it waits, with what it has,
// for an admin or for room — never failed (another copy would not fit
// either). It starts again by itself once the disk gate passes (healthTick).
const holdForDisk = (job, message) => {
  stopActive(job.id, `held: the disk is full (${message})`);
  const root = job.destRoot || destRoot(job.type);
  job.status = "pending";
  job.approvedAt = null;
  job.diskHold = true;
  job.phase = null;
  job.holdReason = `The disk is full — this download carries on by itself when there is room again${root ? ` on ${root}` : ""}.`;
  job.note = null;
  store.save();
  broadcast(job);
  realtime.broadcastAdmins({ type: "download_new", job: publicJob(job) });
  notify.send("Aurora: disk full", `"${job.label || job.title}" stopped: the disk is full. It carries on by itself when there is room, or approve it in /admin → Downloads.`);
  pump();
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
  // The speed shown is THIS file's share, smoothed over about a minute: the
  // engine's number is the whole torrent's (three episodes of a pack each
  // showed the pack's speed) and jumps every second, and every client works
  // its "N min left" out from it.
  job.downloadSpeed = Math.round(lead.speed || 0);
  job.peers = lead.peers;
  // the real size of the file once the torrent says (the listing's is a guess)
  if (lead === main && main.length > 0 && main.length !== job.sizeBytes) job.sizeBytes = main.length;
  const eta = etaOf(job, lead);
  job.etaSec = Number.isFinite(eta) ? Math.round(eta) : null;
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

      if (st.state === "error") { attemptFailed(job, rec, att, st.error || "aria2 reported an error", st.errorCode); continue; }
      if (st.state === "removed") { attemptVanished(jobId, att, "the download was removed"); continue; }

      // The first look at the torrent's files: is the one we were told to
      // fetch really the film / this episode (not a sample, not a fake)?
      if (!att.filesChecked && st.files && st.files.length && !(aria2._internals && aria2._internals.isMetadataPlaceholder && aria2._internals.isMetadataPlaceholder(st.files))) {
        att.filesChecked = true;
        if (checkTorrentFiles(job, rec, att, st)) continue;
      }

      // aria2 says the download is COMPLETE: every selected file is in and
      // verified. With --seed-time=0 it then reports completedLength 0 for
      // the files (measured on the rig, aria2 1.37: 28.6 MiB done while
      // active, "0 of 28.6 MiB" once complete) — so a download that finished
      // between two polls used to read as 0% and sit there for good.
      if (st.state === "complete") {
        const done = (st.files || []).find((x) => x.index === att.fileIndex && x.selected && x.length > 0);
        if (done) {
          const f = { ...done, completed: done.length, fraction: 1 };
          sample(att, f, { ...st, downloadSpeed: 0 }, users.length, t, cfg);
          claimWin(job, rec, att, f, st);
          continue;
        }
      }

      const f = aria2.fileProgress(st, att.fileIndex);
      if (!f) continue;                       // torrent details not in yet
      sample(att, f, st, users.length, t, cfg);
      // what the availability check needs (dlhealth.availability)
      att.engine = { files: st.files, pieceLength: st.pieceLength, numPieces: st.numPieces, bitfield: st.bitfield };

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

  healthTick(t);
  raceTick(t, cfg);
  preemptTick(t);
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
    if (e && e.quiet) return;
    // the bytes are all there and they are not the film: the next copy
    if (e && e.fakeFile && active.get(job.id) === rec) return switchNow(job, rec, { kind: "fake", why: e.message });
    if (e && e.wrongLanguage && active.get(job.id) === rec) return switchNow(job, rec, { kind: "language", why: e.message, lead: e.lead });
    fail(job, errText(e));
  });
  return true;
};

// The bytes are all there: copy the file into the library, bring its subtitles
// and poster along, and let the scanner see it.
const completeJob = async (job, rec, file, engineStatus) => {
  const ext = path.extname(file.path) || ".mkv";
  // The library file takes the title's name; the release's own name is kept
  // on the job — it is what tells which providers' subtitles fit it, and the
  // admin's copies apart (media/copies.js). ONE field: the name the source was
  // listed under, set by create()/adopt(); a job that came without one (an
  // older client, a source with no name) takes the name of the file it wrote.
  if (!job.release) job.release = path.basename(file.path).slice(0, 200);

  // Is it a film at all? A copy whose bytes are all there can still be a
  // fake (random bytes, a renamed sample): ffprobe says, before anything
  // lands in the library (dlfallback.checkProbe).
  const facts = await seams.probe(file.path);
  const bad = dlfallback.checkProbe(facts, job, file.length);
  if (bad) throw Object.assign(new Error(bad), { fakeFile: true });
  if (active.get(job.id) !== rec) throw Object.assign(new Error("stopped before it was copied"), { quiet: true });
  // Is it in the language it was fetched for? (media/langcheck.js) A copy
  // that clearly is not goes no further: the next copy.
  const lang = await languageGate(job, facts);
  if (lang) throw Object.assign(new Error(lang.why), { wrongLanguage: true, lead: lang.lead });
  if (active.get(job.id) !== rec) throw Object.assign(new Error("stopped before it was copied"), { quiet: true });

  job.phase = "copying";
  job.progress = 1;
  job.downloadSpeed = 0;
  job.copyProgress = 0;
  job.etaSec = null;
  broadcast(job);

  // A destination on a network drive is asked first, in a child process
  // with a deadline (lib/drives): the landing below makes blocking calls
  // there, and a drive that stopped answering would hold the server.
  if (!job.replaces) {
    try {
      const o = await drivesLib().confirm(rec.dir);
      if (o && o.network && !o.answering) {
        const again = destinationFor(job);
        if (again.dir === rec.dir) throw Object.assign(new Error(`the storage drive ${o.drive.mount} isn't answering`), { driveDown: true });
        console.log(`[download] ${job.id.slice(0, 6)} ${o.drive.mount} isn't answering — lands on ${job.destRoot || "another drive"} instead`);
        rec.dir = again.dir;
        rec.base = again.base;
      }
    } catch (e) { if (e && e.driveDown) throw e; }
  }
  fs.mkdirSync(rec.dir, { recursive: true });
  sweepTemps(rec.dir, job.id);
  // The bytes go to a hidden temp name in the destination folder; only a
  // complete file is put in place, under a name nothing else has (see
  // "landing in the library" above).
  const tmp = path.join(rec.dir, tempNameFor(job.id));
  let destPath = null;
  try {
    const startedAt = Date.now();
    await copyIntoLibrary(file.path, tmp, (bytes) => {
      job.copyProgress = file.length ? Math.min(1, bytes / file.length) : 0;
      broadcast(job);
    });

    // Never let a short file into the library — the scanner would index it as a
    // playable title.
    const copied = fs.statSync(tmp).size;
    if (copied < file.length) throw new Error(`copied only ${copied} of ${file.length} bytes`);
    // Canceled or removed while it was copying: nothing lands.
    if (active.get(job.id) !== rec) throw Object.assign(new Error("stopped while copying"), { quiet: true });
    const secs = (Date.now() - startedAt) / 1000;
    console.log(`[download] ${job.id.slice(0, 6)} copied ${(copied / 1e6).toFixed(0)} MB in ${secs.toFixed(0)}s`);

    if (job.replaces) {
      // THE SWAP (media/replace.js): the old copy goes, this one takes its
      // name and its library id — or, while someone plays the old copy, this
      // waits finished and hidden, its download slot handed back.
      destPath = await require("./replace").land(job, {
        tmp, ext, dir: rec.dir, base: rec.base,
        stillWanted: () => findJob(job.id) === job && job.status === "downloading",
        waiting: (on) => {
          if (on) job.replaceWait = true;
          else delete job.replaceWait;
          store.save();
          broadcast(job);
          tellReplace(job);
        },
        releaseSlot: () => {
          if (active.get(job.id) !== rec) return;
          stopActive(job.id, "complete — the slot is free while it waits to replace the old copy");
          Promise.resolve().then(pump);
        },
      });
      if (!destPath) throw Object.assign(new Error("cancelled before it replaced the old copy"), { quiet: true });
    } else

    // The name is chosen now, with the complete file in hand, and the file
    // put there in the same synchronous step. The loop is for a name that
    // something outside this process created between the two.
    for (let tries = 0; ; tries++) {
      const pick = landingName(rec.dir, rec.base, ext, { movie: job.type !== "show" });
      if (placeNoClobber(tmp, pick.path)) {
        destPath = pick.path;
        if (pick.copyOf) {
          job.copyOf = pick.copyOf;
          console.log(`[download] ${job.id.slice(0, 6)} "${job.label || job.title}" is already in the library as "${pick.copyOf}" — kept beside it as "${path.basename(destPath)}" (the admin's copies list decides which stays)`);
        }
        break;
      }
      if (tries >= COPY_LIMIT) throw new Error(`could not find a free name for "${rec.base}"`);
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if (e && e.quiet) {
      console.log(`[download] ${job.id.slice(0, 6)} ${e.message} — nothing was put in the library`);
      return;
    }
    throw e;
  }

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
  sameHash(j.infoHash, infoHash) || (j.attempts || []).some((a) => sameHash(a.infoHash, infoHash)) ||
  // a copy set aside with bytes worth resuming (downloads v2: switchSource)
  (j.shelved || []).some((a) => sameHash(a.infoHash, infoHash));
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
      // (a release somebody reported bad here is never the second source)
      job, streams: ((found && found.streams) || []).filter((x) => !x.badHere), history: sourceMemory.forTitle(dlrace.titleKey(job)),
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
    if (!job || job.status !== "downloading" || rec.copying || rec.ch || rec.raceBusy || rec.heldBack || rec.switching) continue;
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

// ====================================================================
// downloads v2 (docs/downloads-v2.md): health, the next copy, priority
// ====================================================================
const lc = (s) => String(s || "").toLowerCase();
const isoAt = (wallMs) => new Date(wallMs).toISOString();
const gbText = (n) => (n > 0 ? (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`) : "");
const minutesText = (ms) => {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 90 ? `${m} min` : `${(ms / 3600e3).toFixed(1).replace(/\.0$/, "")} h`;
};
const sourceDesc = (src) => [src.quality, gbText(src.sizeBytes)].filter(Boolean).join(" · ");

// ---------- is the file the torrent hands us the right one? ----------
// The first look at a copy's file list (media/dlfallback.js checkFiles): the
// listed file may be a sample, an extra, another episode, or the torrent may
// be a fake (a program, an archive, no video at all). → true when the copy
// was given up on (the caller skips it for this poll).
const checkTorrentFiles = (job, rec, att, st) => {
  if (att !== rec.main) return false;        // a second source is judged by its probe
  const files = st.files.map((f) => ({ index: f.index, path: f.path, length: f.length }));
  const v = dlfallback.checkFiles(files, {
    type: job.type, season: job.season, episode: job.episode,
    sizeBytes: att.src.sizeBytes || job.sizeBytes, fileIndex: att.fileIndex,
  });
  if (v.verdict === "ok") return false;
  if (v.verdict === "switch") {
    const from = att.fileIndex;
    const f = files.find((x) => x.index === v.fileIndex);
    att.fileIndex = v.fileIndex;
    att.fileIdx = v.fileIndex - 1;
    att.src = { ...att.src, fileIdx: v.fileIndex - 1 };
    job.fileIdx = v.fileIndex - 1;
    if (f && f.length) att.src.sizeBytes = f.length;
    store.save();
    console.log(`[download] ${job.id.slice(0, 6)} "${job.label || job.title}": ${v.why} — fetching ${f ? path.basename(f.path) : `file #${v.fileIndex}`} instead`);
    // the other file in, the listed one out (unless a sibling job wants it)
    const others = [...liveAttempts()].filter((o) => o !== att && o.gid === att.gid);
    Promise.resolve()
      .then(() => aria2.select(att.gid, v.fileIndex, true))
      .then(() => (others.some((o) => o.fileIndex === from) ? null : aria2.select(att.gid, from, false)))
      .catch((e) => console.warn(`[download] ${job.id.slice(0, 6)} could not change the file: ${errText(e)}`));
    return false;
  }
  switchNow(job, rec, { kind: "fake", why: v.why });
  return true;
};

// ---------- health: stalled jobs stop holding a slot ----------
const AVAIL_EVERY_MS = 30 * 1000;   // the availability check, at most this often per stalled download
const DISK_RECHECK_MS = 60 * 1000;  // a download held for a full disk: look for room this often
let diskCheckedAt = 0;
// The line and the admin's cap have room: a slow download may stop counting
// against "Downloads at once" (if everything is slow because the line is
// full, starting more would only make each one slower).
const lineFree = () => {
  const capBps = dlrace.parseRate(settings.data.aria2MaxDownload);
  if (capBps > 0 && line.total >= capBps * 0.8) return false;
  const peak = line.peak ? line.peak.bps : 0;
  if (peak >= 1024 * 1024 && line.total >= peak * 0.8) return false;
  return true;
};

const GOING_FIRST = "Going first — someone is watching the episode before it";
const HELD_BACK = "Paused for a moment — an episode someone is watching goes first";
// The sentence a running job carries for what its health means.
const healthNote = (job, rec, v) => {
  if (rec.heldBack) return HELD_BACK;
  if (v.state === "stalled" || (v.state === "dead" && rec.ch)) {
    if (v.code === "no-meta" || v.code === "no-peers") return "No one is sharing this copy right now — still looking";
    return "Nothing is arriving from this copy right now — still trying";
  }
  if (v.state === "slow" && !v.holdsSlot) return `Slow copy (${String(v.why || "").replace(/^slow — /, "")}) — other downloads go ahead meanwhile`;
  if (preempt && preempt.jobId === job.id) return GOING_FIRST;
  return job.fallbackNote || null;
};
const setNoteText = (job, text) => {
  if ((job.note || null) === (text || null)) return false;
  job.note = text || null;
  return true;
};

const healthTick = (t) => {
  const cfg = healthCfg();
  const env = { lineFree: lineFree() };
  let slotsChanged = false;
  for (const [id, rec] of [...active]) {
    const job = findJob(id);
    if (!job || job.status !== "downloading" || rec.copying || rec.switching) continue;
    if (rec.heldBack) continue;      // held back on purpose (pre-empting): its slowness is ours
    const att = rec.main;
    const was = rec.health ? rec.health.holdsSlot : true;
    const v = dlhealth.assess(att, t, cfg, env);
    rec.health = v;
    if (was !== v.holdsSlot) slotsChanged = true;
    const prev = job.health || {};
    // Inside one stalled stretch the reason can flip every second (a peer
    // connects for a moment, the engine dials its own address): the first
    // reason and its sentence stay until the state itself changes.
    const steady = prev.state === v.state && v.state === "stalled";
    const pub = { state: v.state, code: steady ? prev.code : v.code, why: steady ? prev.why : v.why, countsAsRunning: v.holdsSlot, since: isoAt(seams.wall() - (t - v.since)) };
    let changed = prev.state !== pub.state || prev.code !== pub.code || prev.countsAsRunning !== pub.countsAsRunning;
    if (changed) {
      job.health = pub;
      if (v.state !== "ok" && v.state !== "starting") console.log(`[download] ${id.slice(0, 6)} "${job.label || job.title}" is ${v.state}${v.why ? `: ${v.why}` : ""}${v.holdsSlot ? "" : " — not counted as running"}`);
    }
    if (setNoteText(job, healthNote(job, rec, steady ? { ...v, code: pub.code } : v))) changed = true;
    if (changed) broadcast(job);
    // stalled with people connected: do they even have what is missing?
    if (v.state === "stalled" && att.gid && att.connections > 0 && att.engine && typeof aria2.peers === "function" && t - (att.availAt || 0) >= AVAIL_EVERY_MS) {
      att.availAt = t;
      checkAvailability(att);
    }
    if (v.state !== "stalled") att.availLowSince = 0;
    // dead: the next copy (unless a second source is already being raced —
    // that IS the next copy, media/dlrace.js)
    if (v.state === "dead" && !rec.ch && !rec.raceBusy) switchNow(job, rec, { kind: "dead", why: v.why, code: v.code });
  }
  shelveExcess(t);
  if (t - diskCheckedAt >= DISK_RECHECK_MS) { diskCheckedAt = t; diskRecheck(); }
  if (slotsChanged) Promise.resolve().then(pump);
};

const checkAvailability = (att) => {
  Promise.resolve()
    .then(() => aria2.peers(att.gid))
    .then((ps) => {
      if (att.dead || !att.engine) return;
      const a = dlhealth.availability({ ...att.engine, fileIndex: att.fileIndex, peers: ps });
      att.avail = a;
      if (a != null && a < 1) { if (!att.availLowSince) att.availLowSince = seams.clock(); } else att.availLowSince = 0;
    })
    .catch(() => {});
};

// More stalled downloads in the engine than it should carry (PARKED_LIVE):
// the ones stalled longest come out and try again in a few minutes — or,
// when they have been stalled most of the way to "dead", move to their next
// copy now.
const PARK_OUT_MS = 10 * 60 * 1000;
const shelveExcess = (t) => {
  const parked = [];
  for (const [id, rec] of active) {
    if (rec.copying || rec.switching || rec.heldBack || rec.ch || !rec.health || rec.health.holdsSlot) continue;
    if (rec.health.state !== "stalled" && rec.health.state !== "dead") continue;
    parked.push({ id, rec, since: rec.health.since });
  }
  if (parked.length <= dlslots.PARKED_LIVE) return;
  parked.sort((a, b) => a.since - b.since);
  const cfg = healthCfg();
  for (const { id, rec } of parked.slice(0, parked.length - dlslots.PARKED_LIVE)) {
    const job = findJob(id);
    if (!job) continue;
    if (t - rec.health.since >= Math.min(cfg.bytesDeadMs, cfg.metaDeadMs) / 2) {
      switchNow(job, rec, { kind: "dead", why: rec.health.why || "nothing arrived" });
      continue;
    }
    stopActive(id, "stalled, and the engine already carries enough stalled downloads — trying again in a few minutes");
    job.status = "approved";
    job.phase = null;
    job.retryAt = isoAt(seams.wall() + PARK_OUT_MS);
    job.note = "No one is sharing this copy right now — trying again in a few minutes";
    store.save();
    broadcast(job);
  }
  scheduleRetry();
};

// A download held for a full disk carries on once the disk gate passes.
const diskRecheck = () => {
  let any = false;
  for (const j of store.data) {
    if (j.status !== "pending" || !j.diskHold) continue;
    if (!diskGate(j.type, j.sizeBytes, j.id).ok) continue;
    j.status = "approved";
    j.approvedAt = j.approvedAt || now();
    j.holdReason = null;
    delete j.diskHold;
    j.autoApproved = true;
    console.log(`[download] ${j.id.slice(0, 6)} "${j.label || j.title}": there is room on the disk again — carrying on`);
    broadcast(j);
    any = true;
  }
  if (any) { store.save(); Promise.resolve().then(pump); }
};

// ---------- the next copy ----------
// Partial bytes worth keeping when a copy is given up on: if it comes back,
// the job carries on from them instead of starting over.
const KEEP_MIN_BYTES = 200e6;
const KEEP_MIN_FRACTION = 0.05;
const BACKOFF_MIN = [15, 30, 60, 120, 240];   // waiting rounds when no copy is left: ~7.75 h for a person's download
const AUTO_RETRIES = 3;                        // …1 h 45 min for an automatic one
const triedSet = (job) => new Set([...(job.tried || []).map((x) => lc(x.h)), ...(job.shelved || []).map((x) => lc(x.infoHash))]);
// Never the copy a "Get another version" is replacing.
const excludeFor = (job) => {
  const out = new Set();
  if (job.replaces && job.replaces.oldInfoHash) out.add(lc(job.replaces.oldInfoHash));
  return out;
};
const acceptFor = (job) => {
  const r = job.replaces;
  const fit = job.langFit ? { wanted: job.langFit.want || [], wrong: job.langFit.wrong || [] } : null;
  if (!r && !fit) return null;
  const rk = badreleases._internals.relKey;
  const old = r && r.oldRelease ? rk(r.oldRelease) : null;
  // a copy whose NAME says it is in a language not wanted is not tried
  // (media/copylang.js judge: "same" as the copy given up on, or "other")
  return (s) => !(old && s.release && rk(s.release) === old) && !(fit && ["same", "other"].includes(copylang.judge(s, fit)));
};
// The next copy for a job, from a fresh source list. A job looking for a
// language (`langFit`) takes a copy whose name says that language first.
const pickNext = (job, streams, oldHash) => {
  const args = {
    job, tried: triedSet(job), exclude: excludeFor(job), live: otherSources(job.id), accept: acceptFor(job),
    original: { dubbed: false, hardsub: false, ...((streams || []).find((x) => sameHash(x.infoHash, oldHash)) || {}) },
  };
  if (job.langFit) {
    const fit = { wanted: job.langFit.want || [], wrong: job.langFit.wrong || [] };
    const right = (streams || []).filter((s) => copylang.judge(s, fit) === "right");
    if (right.length) {
      const first = dlfallback.chooseFallback({ ...args, streams: right });
      if (first.source) return first;
    }
  }
  return dlfallback.chooseFallback({ ...args, streams: streams || [] });
};

// ---------- the language check (media/langcheck.js) ----------
// What a job's copy should be in: { want, wrong } (ISO 639-1 codes), or null
// when nothing is asked of it.
//   "Wrong language" (media/replace.js) - what the request said: the person's
//     language and the title's own, not the language of the copy replaced
//   any other download - the language the person last picked in a player and
//     the title's original language (a Hebrew speaker's English film in
//     English is right), only when both are known
const uniqLangs = (list) => [...new Set(list.map((x) => require("../lib/lang").iso1(x)).filter(Boolean))];
const isLanguageReplace = (job) => !!(job.replaces && job.replaces.reason === "language");
const langWish = async (job) => {
  if (job.langFit) return job.langFit;
  if (isLanguageReplace(job)) {
    const r = job.replaces;
    if (r.lang) return { want: uniqLangs(r.lang.want || []), wrong: uniqLangs(r.lang.wrong || []) };
    // (a request from before the check stored what it was after)
    let original = null;
    try { original = await seams.originalLanguage(job); } catch {}
    return { want: uniqLangs([seams.personLang(r.by), original]), wrong: [] };
  }
  const mine = job.profile ? seams.personLang(job.profile) : null;
  if (!require("../lib/lang").iso1(mine)) return null;
  let original = null;
  try { original = await seams.originalLanguage(job); } catch {}
  if (!original) return null;
  return { want: uniqLangs([mine, original]), wrong: [] };
};
// Called with the finished file's ffprobe facts, before it lands. -> null (it
// lands) or { why, lead } (it does not: the next copy). What was found is kept
// on the job (`langCheck`) for the line the person is told (publicJob
// langLine).
//   "Wrong language" replacement: right -> swap; wrong -> the next copy;
//     unknown (untagged audio) -> swap, and the person is told so plainly.
//   any other download: only when its tracks say their language; wrong ->
//     the next copy, or - when there is no other copy to try - it lands as it
//     is and says so (a whole download thrown away for nothing is worse).
const languageGate = async (job, facts) => {
  const audio = facts && Array.isArray(facts.audio) ? facts.audio : null;
  const replace = isLanguageReplace(job);
  if (!replace && !(audio && audio.some((t) => langcheck.trackLangs(t).length))) return null;
  const wish = await langWish(job);
  if (!wish || (!wish.want.length && !wish.wrong.length)) {
    if (replace) job.langCheck = { verdict: "unknown", has: [], want: [] };
    return null;
  }
  const v = langcheck.verdict({ audio, release: job.release, want: wish.want, wrong: wish.wrong });
  console.log(`[download] ${job.id.slice(0, 6)} language check: ${v.verdict} (has ${v.has.join(",") || "nothing tagged"}; wants ${wish.want.join(",") || "-"}${wish.wrong.length ? `; not ${wish.wrong.join(",")}` : ""})`);
  if (v.verdict !== "wrong") {
    job.langCheck = { verdict: v.verdict, has: v.has, want: wish.want };
    return null;
  }
  const next = { want: wish.want, wrong: uniqLangs([...wish.wrong, ...v.has]) };
  if (!replace) {
    // is there another copy to try? None: it lands as it is.
    const was = job.langFit;
    job.langFit = next;
    let pick = null;
    if ((job.tried || []).length + 1 < dlfallback.MAX_SOURCES) {
      try {
        const found = await seams.findSources(job);
        pick = pickNext({ ...job, tried: [...(job.tried || []), { h: lc(job.infoHash) }] }, (found && found.streams) || [], job.infoHash);
      } catch { pick = null; }
    }
    if (!pick || !pick.source) {
      if (was) job.langFit = was; else delete job.langFit;
      job.langCheck = { verdict: "kept", has: v.has, want: wish.want };
      return null;
    }
  }
  job.langFit = next;
  job.langCheck = { verdict: "wrong", has: v.has, want: wish.want };
  return { why: `its sound is in ${langcheck._internals.list(v.has, "and")}`, lead: langcheck.lines.lead(v.has, wish.want) };
};
// A source as the job carries it.
const asSource = (s) => {
  const { magnet, announce } = torrent.magnetFor(s.infoHash);
  return {
    infoHash: s.infoHash, fileIdx: s.fileIdx || 0, magnet, announce,
    quality: s.quality || null, sizeBytes: s.sizeBytes || 0, provider: s.provider || null,
    seeders: s.seeders || 0, release: s.release || null,
  };
};

const LEADS = {
  dead: "No one was sharing that copy",
  fake: "That copy was fake or broken",
  failed: "That copy failed",
  language: "That copy was in the wrong language",
};
// Give up on the job's copy and move to the next one — inside its running
// slot, so it keeps its place. `kind`: "dead" (nobody sharing it), "fake"
// (not the film, or damaged), "failed" (the engine gave up on it), "language"
// (its sound is not in the language wanted: media/langcheck.js; `lead` says
// which).
const switchSource = async (job, rec, { kind, why, lead }) => {
  if (rec.switching || active.get(job.id) !== rec) return;
  rec.switching = true;
  const old = rec.main;
  try {
    const key = dlrace.titleKey(job);
    const wall = seams.wall();
    // 1. what is remembered about the copy that let this title down
    // (a copy in another language downloaded fine: nothing against its source)
    if (kind !== "language") remember(job, old.infoHash, kind === "dead" ? "stalled" : "failed");
    if (key) {
      try {
        badreleases.record(key, { infoHash: old.infoHash, release: job.release || old.src.release || null, reason: kind === "dead" ? "dead" : kind === "language" ? "language" : "fake", auto: true, byName: "Aurora" }, wall);
      } catch (e) { console.warn("[download] could not file the copy:", errText(e)); }
    }
    const tried = (job.tried || []).filter((x) => !sameHash(x.h, old.infoHash));
    tried.push({
      h: lc(old.infoHash), fileIdx: old.fileIdx || 0, rel: job.release || old.src.release || null, q: job.quality || old.src.quality || null,
      size: old.length || old.src.sizeBytes || 0, provider: old.src.provider || null, seeders: old.src.seeders || 0,
      kind, why: String(why || "").slice(0, 160), at: isoAt(wall),
    });
    job.tried = tried;
    // 2. its bytes: kept when worth resuming (a dead swarm can come back)
    const keep = kind === "dead" && (old.completed || 0) > 0 && (old.completed || 0) >= Math.min(KEEP_MIN_BYTES, Math.max(1, KEEP_MIN_FRACTION * (old.length || 0)));
    if (keep) {
      job.shelved = [...(job.shelved || []).filter((x) => !sameHash(x.infoHash, old.infoHash)),
        { ...old.src, infoHash: old.infoHash, fileIdx: old.fileIdx || 0, sizeBytes: old.length || old.src.sizeBytes || 0, bytes: old.completed, fraction: old.fraction, at: isoAt(wall) }];
    }
    console.log(`[download] ${job.id.slice(0, 6)} "${job.label || job.title}": giving up on ${String(old.infoHash).slice(0, 8)}… (${kind}: ${why})${keep ? ` — keeping its ${gbText(old.completed)} in case it comes back` : ""}`);
    // 3. let go of it now: it stops using the engine while the next is found
    await releaseAttempt(old);
    if (active.get(job.id) !== rec || job.status !== "downloading") return;
    // 4. the next copy
    let pick;
    if (tried.length >= dlfallback.MAX_SOURCES) {
      pick = { source: null, reason: `${tried.length} copies were tried` };
    } else {
      let found = null;
      try { found = await seams.findSources(job); } catch (e) { found = null; pick = { source: null, reason: `the list of copies could not be fetched (${errText(e)})` }; }
      if (active.get(job.id) !== rec || job.status !== "downloading") return;
      if (found) {
        pick = pickNext(job, (found && found.streams) || [], old.infoHash);
      }
    }
    if (!pick || !pick.source) {
      if (!keep) purgeAfterSwitch(job, old.infoHash);
      return waitAndRetry(job, rec, (pick && pick.reason) || "no other copy");
    }
    // 5. the disk has to take it
    const gate = diskGate(job.type, pick.source.sizeBytes, job.id);
    if (!gate.ok) {
      if (!keep) purgeAfterSwitch(job, old.infoHash);
      stopActive(job.id, "the next copy does not fit on the disk");
      return demote(job, gate.reason);
    }
    // 6. switch, in place
    const src = asSource(pick.source);
    adopt(job, src);
    if (!keep) purgeAfterSwitch(job, old.infoHash);
    const att = newAttempt("original", src, seams.clock());
    rec.main = att;
    rec.health = null;
    rec.whyNot = null;
    job.phase = "finding";
    job.progress = 0;
    job.downloadSpeed = 0;
    job.peers = 0;
    job.etaSec = null;
    job.health = { state: "starting", code: "finding", why: null, countsAsRunning: true, since: isoAt(wall) };
    job.fallbackNote = `${lead || LEADS[kind] || LEADS.failed} — now trying another${sourceDesc(src) ? ` (${sourceDesc(src)})` : ""}`;
    job.note = job.fallbackNote;
    store.save();
    broadcast(job);
    console.log(`[download] ${job.id.slice(0, 6)} now on copy ${tried.length + 1} of at most ${dlfallback.MAX_SOURCES}: ${String(src.infoHash).slice(0, 8)}… (${sourceLabel(src)}, ${sourceDesc(src)}${pick.warm ? ", already downloading for a sibling" : ""})`);
    runAttempt(job, rec, att).catch((e) => console.error("[download] next copy did not start:", errText(e)));
  } finally {
    rec.switching = false;
  }
};
// (fire and forget, never an unhandled rejection)
const switchNow = (job, rec, opts) =>
  switchSource(job, rec, opts).catch((e) => console.error(`[download] ${job.id.slice(0, 6)} could not move to another copy:`, errText(e)));
// The copy given up on is not the job's own any more: its bytes go (unless a
// sibling still wants them).
const purgeAfterSwitch = (job, infoHash) => {
  const wanted = store.data.some((j) => j.id !== job.id && LIVE_STATUSES.includes(j.status) && jobWants(j, infoHash));
  if (!wanted && !(job.shelved || []).some((x) => sameHash(x.infoHash, infoHash)) && !sameHash(job.infoHash, infoHash)) aria2.purge(infoHash).catch(() => {});
};

// No copy left to try right now: the job steps out of the engine and waits
// (BACKOFF_MIN), then tries again — the copy it has the most bytes of, else
// the next of the copies it tried. In the end it says so plainly.
const waitAndRetry = (job, rec, reason) => {
  const base = priorityOf(job).base;
  const max = base <= dlprio.PERSON ? BACKOFF_MIN.length : AUTO_RETRIES;
  job.retries = (job.retries || 0) + 1;
  const n = (job.tried || []).length;
  const copies = `${n} cop${n === 1 ? "y" : "ies"}`;
  // Every copy tried was in the wrong language (media/langcheck.js): trying
  // them again later would only fetch the same files again.
  if (n && !(job.shelved || []).length && (job.tried || []).every((x) => x.kind === "language")) {
    job.fallbackNote = null;
    return fail(job, langcheck.lines.none((job.langFit && job.langFit.want) || [], n));
  }
  if (job.retries > max) {
    const since = Date.parse(job.firstStartedAt || job.approvedAt || job.at) || seams.wall();
    job.fallbackNote = null;
    const last = (job.tried || [])[(job.tried || []).length - 1];
    const over = minutesText(seams.wall() - since);
    return fail(job, !last || last.kind === "dead"
      ? `No one is sharing this right now — tried ${copies} over ${over}. Try again later.`
      : `It would not download — tried ${copies} over ${over} (last: ${last.why || last.kind}). Try again later.`);
  }
  // what to try when the time comes
  // (a copy found in the wrong language is never tried again: it would be
  // the same file)
  const pool = [
    ...(job.shelved || []).slice().sort((a, b) => (b.bytes || 0) - (a.bytes || 0)).map((x) => ({ ...x, fileIdx: x.fileIdx || 0 })),
    ...(job.tried || []).filter((x) => x.kind !== "language" && !(job.shelved || []).some((y) => sameHash(y.infoHash, x.h))).map((x) => ({
      infoHash: x.h, fileIdx: x.fileIdx || 0, quality: x.q, sizeBytes: x.size, provider: x.provider, seeders: x.seeders, release: x.rel,
    })),
  ];
  const next = pool.length ? pool[(job.retries - 1) % pool.length] : null;
  if (next) adopt(job, asSource(next));
  stopActive(job.id, `no copy left to try right now (${reason}) — waiting`);
  const delay = BACKOFF_MIN[Math.min(job.retries - 1, BACKOFF_MIN.length - 1)] * 60 * 1000;
  job.status = "approved";
  job.phase = null;
  job.downloadSpeed = 0;
  job.peers = 0;
  job.etaSec = null;
  delete job.health;
  job.retryAt = isoAt(seams.wall() + delay);
  job.fallbackNote = null;
  job.note = `No one is sharing any copy of this right now (${copies} tried) — trying again in about ${minutesText(delay)}`;
  store.save();
  broadcast(job);
  console.log(`[download] ${job.id.slice(0, 6)} "${job.label || job.title}": ${reason}; round ${job.retries} of ${max} — again in ${minutesText(delay)}${next ? ` with ${String(next.infoHash).slice(0, 8)}…` : ""}`);
  Promise.resolve().then(pump);
};

// Back to "waiting for approval" because of the disk (the same as pump's).
const demote = (job, reason) => {
  job.status = "pending";
  job.approvedAt = null;
  job.holdReason = reason;
  job.phase = null;
  store.save();
  broadcast(job);
  realtime.broadcastAdmins({ type: "download_new", job: publicJob(job) });
  notify.send("Aurora: download needs approval", `"${job.label || job.title}" — ${reason} Approve it in /admin → Downloads.`);
  Promise.resolve().then(pump);
};

// ---------- watching now: urgency ----------
// A live job for this exact episode (or film) is what somebody is about to
// watch: class NOW until `untilWall` (wall-clock ms). → the ids marked.
const URGENT_MAX_MS = 6 * 3600e3;
const markUrgent = (match, untilWall, why = "someone is watching") => {
  if (!match || !match.imdbId) return [];
  const t = seams.wall();
  const hits = store.data.filter((j) => LIVE_STATUSES.includes(j.status) && j.imdbId && lc(j.imdbId) === lc(match.imdbId) &&
    (match.season == null || (j.type === "show" && Number(j.season) === Number(match.season) && Number(j.episode) === Number(match.episode))));
  let fresh = false;
  for (const j of hits) {
    const was = (j.urgentUntil || 0) > t;
    j.urgentUntil = Math.max(j.urgentUntil || 0, Math.min(untilWall, t + URGENT_MAX_MS));
    if (!was) {
      fresh = true;
      delete j.preemptTried;
      console.log(`[download] ${j.id.slice(0, 6)} "${j.label || j.title}" goes first: ${why}`);
      broadcast(j);
    }
  }
  if (fresh) { store.save(); Promise.resolve().then(pump); }
  return hits.map((j) => j.id);
};
// While an episode plays: its NEXT episode, if it is in the queue — the next
// number in the season, else the first of the next season.
const urgentAfter = ({ imdbId, season, episode }, untilWall) => {
  if (!imdbId || !(Number(season) >= 0) || !(Number(episode) > 0)) return [];
  const live = store.data.filter((j) => LIVE_STATUSES.includes(j.status) && j.type === "show" && j.imdbId && lc(j.imdbId) === lc(imdbId));
  if (!live.length) return [];
  const s = Number(season);
  const e = Number(episode);
  const same = live.find((j) => Number(j.season) === s && Number(j.episode) === e + 1);
  const nextSeason = same ? null : live.find((j) => Number(j.season) === s + 1 && Number(j.episode) === 1);
  const target = same || nextSeason;
  if (!target) return [];
  return markUrgent({ imdbId, season: target.season, episode: target.episode }, untilWall, "the episode before it is playing");
};

// ---------- pre-empting (media/dlprio.js) ----------
// One NOW download at a time may hold the others back.
let preempt = null;          // { jobId, startedAt (mono), victims: Map(jobId → gids) }
let preemptEndedAt = 0;

const victimList = (job, cfg) => {
  const wall = seams.wall();
  const running = [];
  for (const [id, rec] of active) {
    if (id === job.id || rec.copying || !rec.main.gid) continue;
    const j = findJob(id);
    if (!j || j.status !== "downloading") continue;
    running.push({ id, cls: priorityOf(j).cls, key: keyOf(j), heldMs: dlprio.heldWithin(j.heldSpans, wall, cfg) });
  }
  return dlprio.victims({ urgentKeys: new Set([keyOf(job)]), running }, cfg);
};
const hold = (id, urgent, cfg) => {
  const rec = active.get(id);
  const j = findJob(id);
  if (!rec || !j) return;
  const gids = [rec.main.gid, rec.ch && rec.ch.gid].filter(Boolean);
  for (const g of gids) aria2.limit(g, cfg.trickleBps).catch(() => {});
  rec.heldBack = true;
  const wall = seams.wall();
  j.heldBack = { since: isoAt(wall), for: urgent.label || urgent.title };
  j.heldSpans = [...(j.heldSpans || []).filter((s) => (s.to || wall) > wall - cfg.victimWindowMs), { from: wall }];
  j.note = HELD_BACK;
  preempt.victims.set(id, gids);
  broadcast(j);
};
function releaseVictim(id) {
  if (!preempt) return;
  const gids = preempt.victims.get(id) || [];
  preempt.victims.delete(id);
  for (const g of gids) aria2.limit(g, 0).catch(() => {});
  const rec = active.get(id);
  if (rec) {
    rec.heldBack = false;
    if (rec.main.hs) rec.main.hs.slowSince = 0;   // its slow minutes were ours
  }
  const j = findJob(id);
  if (j) {
    const wall = seams.wall();
    const spans = j.heldSpans || [];
    if (spans.length && !spans[spans.length - 1].to) spans[spans.length - 1].to = wall;
    delete j.heldBack;
    j.note = j.fallbackNote || null;
    broadcast(j);
  }
}
function endPreempt(why) {
  if (!preempt) return;
  const p = preempt;
  for (const id of [...p.victims.keys()]) releaseVictim(id);
  preempt = null;
  preemptEndedAt = seams.clock();
  const j = findJob(p.jobId);
  if (j && j.note === GOING_FIRST) { j.note = j.fallbackNote || null; broadcast(j); }
  console.log(`[download] ${p.jobId.slice(0, 6)} no longer holds the others back (${why}) — after ${minutesText(preemptEndedAt - p.startedAt)}`);
  store.save();
  Promise.resolve().then(pump);
}
const preemptTick = (t) => {
  const cfg = prioCfg();
  if (preempt) {
    const job = findJob(preempt.jobId);
    const rec = active.get(preempt.jobId);
    let end = null;
    if (!job || job.status !== "downloading" || !rec) end = "it ended";
    else if (rec.copying) end = "it is in";
    else if (priorityOf(job).cls !== dlprio.NOW) end = "nobody is waiting for it now";
    else if (rec.health && (rec.health.state === "stalled" || rec.health.state === "dead")) end = "it stalled";
    else if (t - preempt.startedAt >= cfg.preemptMaxMs) end = "the most a hold may last";
    else if (dlprio.liveVerdict({ runMs: t - preempt.startedAt, etaMs: etaOf(job, rec.main) * 1000 }, cfg) === "end") {
      end = "it turned out not to be quick";
      job.preemptTried = true;
    }
    if (end) return endPreempt(end);
    // downloads started meanwhile are held too; a person's that used up its
    // share of waiting is let go
    const want = new Set(victimList(job, cfg));
    for (const id of [...preempt.victims.keys()]) if (!want.has(id)) releaseVictim(id);
    for (const id of want) if (!preempt.victims.has(id)) hold(id, job, cfg);
    return;
  }
  if (preemptEndedAt && t - preemptEndedAt < cfg.cooldownMs) return;
  for (const [id, rec] of active) {
    const job = findJob(id);
    if (!job || job.status !== "downloading" || rec.copying || job.preemptTried || !rec.main.gid) continue;
    if (priorityOf(job).cls !== dlprio.NOW) continue;
    if (rec.health && !rec.health.holdsSlot) continue;
    const q = dlprio.quickEstimate({
      sizeBytes: Math.max(0, (rec.main.length || job.sizeBytes || 0) - (rec.main.completed || 0)),
      seeders: Math.max(job.seeders || 0, rec.main.seeders || 0),
      lineBps: line.peak ? line.peak.bps : 0,
    }, cfg);
    if (!q.quick) continue;
    const vs = victimList(job, cfg);
    if (!vs.length) continue;
    preempt = { jobId: id, startedAt: t, victims: new Map() };
    for (const v of vs) hold(v, job, cfg);
    job.note = GOING_FIRST;
    broadcast(job);
    console.log(`[download] ${id.slice(0, 6)} "${job.label || job.title}" is quick (about ${minutesText(q.etaMs)}) and someone is watching — holding back ${vs.length} other download${vs.length === 1 ? "" : "s"}`);
    break;
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
  delete job.replaceWait;
  job.doneAt = now();
  require("../lib/tel/timings").downloadDone(job); // [analytics] started → in the library
  job.raceNote = null;
  job.note = null;
  job.fallbackNote = null;
  delete job.health;
  delete job.retryAt;
  endOfJob(job);
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
  realtime.libraryUpdated();
  // An episode's intro / recap / credits go on file NOW, while nobody is
  // watching yet — not on its first play, and not whenever the background
  // fill reaches it. Fire-and-forget; the audio pass still runs after
  // enrichment and its answer, measured on the file, wins where it has one.
  if (job.type === "show") {
    const libId = scanner.idForPath(destPath);
    if (libId) require("./introdetect").fillEpisode(libId).catch(() => {});
    // and its own sound is next in line for the audio pass (not whenever the
    // whole-library rounds reach it)
    if (libId) { try { require("./introdetect").landed(libId); } catch {} }
  }
  // A play-ready copy, when this household's devices need one (preconvert.js
  // decides — most of the time the answer is "no", and nothing is made).
  {
    const libId = scanner.idForPath(destPath);
    if (libId) require("./preconvert").consider(libId);
  }
  // No Hebrew subtitles anywhere, for somebody who watches with Hebrew ones:
  // one is translated in the background (media/subai.js; only with an AI key)
  try { require("./subai").landed(destPath, [job.profile, ...(job.also || [])].filter(Boolean)); } catch {}
  // Aurora's share of that drive is counted again shortly (lib/drives recountSoon), not at the 6-hour round
  try { drivesLib().recountSoon(destPath); } catch {}
  console.log(`[download] ${job.id.slice(0, 6)} done "${job.title}"`);
  tellMyList(job);
  tellReplace(job);
  if (job.replaces) notify.send("Aurora: copy replaced", `"${job.label || job.title}" — ${job.replaces.byName || "someone"} replaced the copy (${job.replaces.reasonLabel || job.replaces.reason}).`);
  else notify.send("Aurora: download ready", `"${job.label || job.title}" is downloaded and in the library.`);
  // …and the person who asked for it hears on the devices where they switched
  // notifications on — unless they said no under Settings ("Tell me when a
  // download is ready", prefs.readyNotice). A smart download nobody asked for
  // stays quiet, as it does in the apps. What the language check found is
  // said either way (langLine).
  const langLine = langLineOf(job);
  const askers = [...new Set([...(job.smart ? [] : [job.profile]), ...(job.also || [])].filter(Boolean))];
  for (const who of askers) {
    const ready = seams.readyNotice(who);
    if (!ready && !langLine) continue;
    try {
      const libId = scanner.idForPath(destPath);
      const base = job.replaces ? "The new version is in — ready to watch." : "Downloaded and ready to watch.";
      require("../lib/push").send(who, {
        title: job.type === "show" && job.season ? `${job.title} · S${job.season} E${job.episode}` : job.title,
        body: ready ? (langLine ? `${base} ${langLine}` : base) : langLine,
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
  const approved = waitingJobs();
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
    // downloads v2: the queue judges stalls itself (media/dlhealth.js) and
    // moves dead copies on (the healer must not restart them with the same
    // copy); how many are stalled / slow / held back / waiting to retry
    healthManaged: true,
    stalled: [...active.values()].filter((r) => r.health && (r.health.state === "stalled" || r.health.state === "dead")).length,
    slow: [...active.values()].filter((r) => r.health && r.health.state === "slow").length,
    notCounted: [...active.values()].filter((r) => !holdsSlot(r)).length,
    heldBack: [...active.values()].filter((r) => r.heldBack).length,
    preempting: preempt ? preempt.jobId : null,
    retrying: store.data.filter((j) => j.status === "approved" && j.retryAt && Date.parse(j.retryAt) > Date.now()).length,
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
    for (const a of j.shelved || []) if (a.infoHash) out.add(String(a.infoHash).toLowerCase());
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
    // downloads v2: of those, the ones that count against the setting
    // (a stalled or slow-with-room one does not; a pack's episodes count once)
    counted: new Set([...active].filter(([, r]) => holdsSlot(r)).map(([id]) => keyOf(findJob(id)))).size,
    notCounted: [...active.values()].filter((r) => !holdsSlot(r)).length,
    parkedLive: dlslots.PARKED_LIVE, nowExtra: dlslots.NOW_EXTRA,
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
      // (My List downloads, removed 2026-10-26, could leave a job "on hold":
      // it is an ordinary queued job now and carries on from its bytes.)
      delete job.held;
      delete job.stalledRestarts;
      delete job.stalledBytes;
      // (downloads v2: what lived only in the running engine starts over —
      // a fresh grace, no hold-back; what was decided stays: the copies
      // tried and set aside, the wait before trying again, the urgency)
      delete job.health;
      delete job.heldBack;
      delete job.dupTries;
      if (job.heldSpans) for (const sp of job.heldSpans) if (!sp.to) sp.to = Date.now();
      if (job.note && !job.retryAt) job.note = job.fallbackNote || null;
      // (a replacement that was waiting for the old copy to be free fetches
      // and copies again — its hidden file is swept — and waits again)
      delete job.replaceWait;
      // (progress is kept as it was — the engine continues from the staging
      // bytes, and the disk gate counts what is still to come)
      job.downloadSpeed = 0;
      job.peers = 0;
      job.phase = null;
      job.copyProgress = null;
      job.etaSec = null;
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
  list, listFor, create, approve, decline, cancel, cancelOwn, removeOwn, remove, resume, publicJob, publicJobFor, stats, markSeen, pruneGone, diskGate,
  queueHealth, liveInfoHashes, restartJob, pumpNow, smartOnDisk, rawJobs, slots, setMaxActive,
  markUrgent, urgentAfter,
  // Pure helpers, exported so test/downloads.test.js can pin the rules that
  // decide where a file lands and whether a request needs approval — and the
  // seams test/dlrace-queue.test.js uses to play the queue out against a fake
  // engine (never in a running server).
  _internals: {
    safeName, folderKey, chooseFolder, diskGate, destinationFor, store, typeOf,
    landingName, placeNoClobber, tempNameFor, nameTakenAny: nameTaken,
    active, seams, line, resume: () => resume(), poll: () => poll(), raceTick: () => raceTick(seams.clock(), raceCfg()),
    healthTick: () => healthTick(seams.clock()), preemptTick: () => preemptTick(seams.clock()),
    preempt: () => preempt, endPreempt: (why) => endPreempt(why), resetPreempt: () => { preempt = null; preemptEndedAt = 0; },
    setEngine: (engine) => { aria2 = engine; },
  },
};
