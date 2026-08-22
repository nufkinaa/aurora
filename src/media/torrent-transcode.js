// On-the-fly transcode for torrent sources the browser can't decode (10-bit
// HEVC / x265 / AV1, or AC-3/DTS audio). We pipe the torrent file's sequential
// read stream straight into ffmpeg and emit HLS: video -> H.264 (or copied,
// when only the audio is the problem), audio -> stereo AAC. Segments cache on
// disk keyed by infoHash+fileIdx; old jobs are pruned to bound disk use.
//
// Reading from a stream (not a seekable file) means ffmpeg transcodes linearly,
// so seeking is limited to what's already been produced — acceptable for a
// source that otherwise wouldn't play at all.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const config = require("../config");

const HLS_ROOT = path.join(config.CACHE_DIR, "torrent-hls");
const MAX_CACHED_JOBS = 3;
const IDLE_MS = 150000; // kill a transcode whose player stopped requesting (>2.5 min)

// Server-survival guards: an uncapped pile of libx264 processes (e.g. a burst
// of TV-remote seeks, each with a new offset) saturates every core and starves
// the event loop — the whole server "freezes" even though nothing crashed.
const MAX_ACTIVE = 2; // concurrent live ffmpeg transcodes
const FFMPEG_THREADS = Math.max(1, os.cpus().length - 2); // leave cores for node
const activeCount = () => {
  let n = 0;
  for (const j of jobs.values()) if (j.proc) n++;
  return n;
};
// Keep node responsive even while ffmpeg runs flat-out.
const deprioritize = (proc) => {
  try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
};

const jobs = new Map(); // dir -> { proc, ready, done, lastAccess }

// Offsets we deliberately abandoned, and when. A request that arrives for one
// is a poll from the player we just moved off — re-creating that job would
// supersede the brand-new stream the viewer was switched to, which is the same
// crash-into-buffering the deferred kill below fixes, just in a tighter window
// (measured: it still reproduced ~1 poll after the retire). Refuse instead.
// Short-lived, so genuinely seeking back to that offset later still works.
const retired = new Map(); // dir -> timestamp
const RETIRED_MS = 5000;

// Drop a job that a newer one replaced: kill ffmpeg, and delete its dir once
// the process has let go of its files — a headless EVENT playlist left on disk
// would stall every future replay at its edge.
const retire = (d, j) => {
  const now = Date.now();
  for (const [k, t] of retired) if (now - t >= RETIRED_MS) retired.delete(k);
  retired.set(d, now);
  if (jobs.get(d) === j) jobs.delete(d);
  const old = j.proc;
  if (!old) return;
  old.once("close", () => {
    setTimeout(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }, 150);
  });
  try { old.kill("SIGKILL"); } catch {}
  console.log(`[torrent-transcode] superseded ${path.basename(d)}`);
};

// Boot sweep: a playlist WITHOUT #EXT-X-ENDLIST whose ffmpeg died with the
// previous server run is a stump — ensure() would happily serve it and every
// replay would stall at its edge (seen live: 8s then freeze). MUST run only
// AFTER this process wins the port (called from server.js's listen callback),
// never at module load: a second/stale instance that will fail to bind would
// otherwise delete the LIVE instance's in-progress transcodes before exiting.
const bootSweep = () => {
  try {
    for (const e of fs.readdirSync(HLS_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const abs = path.join(HLS_ROOT, e.name);
      let done = false;
      try { done = fs.readFileSync(path.join(abs, "index.m3u8"), "utf-8").includes("#EXT-X-ENDLIST"); } catch {}
      if (!done) {
        try { fs.rmSync(abs, { recursive: true, force: true }); console.log(`[torrent-transcode] boot-swept stump ${e.name}`); } catch {}
      }
    }
  } catch {}
};

// Fire-and-forget fetch of the end of the file, where an MKV's seek index
// lives (see the call site). Data is discarded as it arrives — the point is
// purely to make WebTorrent prioritise those pieces — and the read is dropped
// after two minutes so a starved swarm can't leave it hanging around.
const TAIL_BYTES = 3 * 1024 * 1024;
const warmTail = (file) => {
  if (!file || !file.length || file.length <= TAIL_BYTES) return;
  let s;
  try {
    s = file.createReadStream({ start: file.length - TAIL_BYTES });
  } catch {
    return;
  }
  const giveUp = setTimeout(() => { try { s.destroy(); } catch {} }, 120000);
  giveUp.unref?.();
  s.on("data", () => {});
  s.on("end", () => clearTimeout(giveUp));
  s.on("error", () => clearTimeout(giveUp));
};

// Film audio is mastered far quieter than web video: measured across this
// library, integrated loudness sits at -21 to -29 LUFS where YouTube/Netflix
// normalise to -14..-16, which is why everything here sounded low. A flat +4 dB
// with a true-peak limiter fixes the level while PRESERVING dynamics — a quiet
// scene rose by exactly 4.0 dB (-42.6 -> -38.6 LUFS), where `loudnorm` pumped
// that same scene to -15.2 and flattened the film. `level=disabled` stops the
// limiter auto-normalising to full scale, and `latency=true` compensates its
// lookahead so audio can't drift from the picture (verified: audio still starts
// at PTS 0.000). Harmless on a video with no audio track (verified).
const AUDIO_GAIN = "volume=4dB,alimiter=limit=0.7:level=disabled:latency=true";

const jobKey = (infoHash, fileIdx, ss = 0) => `${infoHash}-${fileIdx}-${ss}`;
const jobDir = (infoHash, fileIdx, ss = 0) => path.join(HLS_ROOT, jobKey(infoHash, fileIdx, ss));

const pruneOld = (keepDir) => {
  try {
    const dirs = fs
      .readdirSync(HLS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const abs = path.join(HLS_ROOT, e.name);
        return { abs, mtime: fs.statSync(abs).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const d of dirs.slice(MAX_CACHED_JOBS)) {
      if (d.abs === keepDir) continue;
      // In use? Leave it. `proc` alone isn't enough: a transcode that already
      // FINISHED (short file, or a complete local file) has proc === null while
      // the viewer is still watching its segments, and two more seeks were
      // enough to prune that dir out from under them — playback 404'd and the
      // next poll re-created the job, superseding the seek in flight.
      const j = jobs.get(d.abs);
      if (j && (j.proc || Date.now() - (j.lastAccess || 0) < IDLE_MS)) continue;
      fs.rmSync(d.abs, { recursive: true, force: true });
      jobs.delete(d.abs); // drop the finished-job Map entry along with its dir
    }
  } catch {}
};

// Start (or reuse) a transcode of a WebTorrent `file` to HLS.
//   vcodec "h264" -> transcode video (needed for HEVC/AV1/10-bit)
//   vcodec "copy" -> copy video, only transcode the audio
// Resolves with the job dir once the playlist appears.
//
// ffmpeg reads the torrent's sequential read stream via stdin — NOT the on-disk
// file. WebTorrent fills pieces in swarm order, so the on-disk file has holes
// near the front until late; reading it directly starves ffmpeg at byte 0 even
// while the swarm downloads fast elsewhere. createReadStream instead delivers
// bytes strictly in order (byte 0 first) and blocks until each is verified, so
// ffmpeg never reads a hole. MKV demuxes linearly from a pipe fine (we only
// ever read start-to-end, never seek the input).
const ensure = (file, absPath, infoHash, fileIdx, vcodec = "h264", ss = 0, seek = false) => {
  if (!config.FFMPEG) return Promise.reject(new Error("ffmpeg not available"));
  ss = Math.max(0, Math.floor(Number(ss) || 0));
  // Starting at an offset forces a re-encode: `-ss` + `-c:v copy` can only cut
  // on a keyframe, and the resulting first fragment has a misaligned, partly
  // negative timeline that MSE refuses (see the note in remux.js — same fix,
  // same measurement). The job dir here doesn't encode the codec, so this
  // normalisation is invisible to the segment route.
  if (ss > 0) vcodec = "h264";

  const dir = jobDir(infoHash, fileIdx, ss);
  const playlist = path.join(dir, "index.m3u8");

  // A poll from the stream we just moved off (see `retired`) must not resurrect
  // it: its dir is being torn down, so there is nothing here worth serving.
  if (!seek && Date.now() - (retired.get(dir) || 0) < RETIRED_MS) {
    return Promise.reject(new Error("Transcode was superseded"));
  }


  // A new job for the same file supersedes the old one: the player moved on
  // (far seek / exit-and-resume) — the abandoned ffmpeg would otherwise hold
  // one of the 2 slots for up to 2.5 min, which made "skip, exit, come back,
  // skip again" hit the cap and refuse with "busy transcoding".
  //
  // WHEN it dies matters, and getting that wrong is what broke seeking (found
  // in the Silo S03E04 logs): a job that already HAS a playlist is very likely
  // the one the viewer is watching right now, and the abandoned player keeps
  // polling that playlist for as long as the seek is still waiting. Killing it
  // up-front deleted its dir, so that poll re-created the job — and the
  // re-created job then superseded the job the seek was waiting for. The seek
  // failed and playback restarted with an empty buffer: "the video kept playing
  // until it stopped and just sat there loading."
  //
  // So: a job with no playlist yet cannot have a viewer — kill it immediately
  // and take its slot. A job with a playlist is retired only once THIS job is
  // ready (below), which also means a seek the swarm can't serve leaves
  // playback exactly where it was instead of destroying it.
  //
  // This runs BEFORE the reuse check below so it can't depend on which request
  // arrives first: the player fires its claim and its playlist load together, and
  // if the playlist won that race the claim would short-circuit on reuse and the
  // old offset would keep its slot until it idled out.
  //
  // ONLY a deliberate move by the viewer (`seek`) retires another offset. A
  // background playlist poll must never: measured live on d7c9e306 (a 1-peer
  // swarm) the viewer's @0 job died, hls.js polled its now-missing playlist,
  // that poll RE-CREATED @0 — and the re-creation retired the @1349 job the
  // seek was waiting on, because @1349 had no playlist yet. The seek came back
  // 504 twice while the old audio kept playing. A poll is not the viewer moving.
  const victims = [];
  if (seek) {
    for (const [d, j] of jobs) {
      if (d === dir || !j.proc) continue;
      const base = path.basename(d);
      if (!base.startsWith(`${infoHash}-${fileIdx}-`)) continue;
      if (fs.existsSync(path.join(d, "index.m3u8"))) victims.push([d, j]);
      else retire(d, j);
    }
  }

  const retireVictims = () => {
    for (const [d, j] of victims) if (jobs.get(d) === j) retire(d, j);
  };

  // Reuse an existing job only if it's still valid: process still running, or
  // its playlist still on disk. A finished job whose dir was pruned away leaves
  // a stale resolved promise pointing at a deleted file — drop it and re-create.
  if (jobs.has(dir)) {
    const j = jobs.get(dir);
    if (j.proc || fs.existsSync(playlist)) {
      j.lastAccess = Date.now();
      j.ready.then(retireVictims, () => {}); // this offset is live: the old ones can go
      return j.ready;
    }
    jobs.delete(dir);
  }
  if (fs.existsSync(playlist)) { retireVictims(); return Promise.resolve(dir); }

  // Hard cap on simultaneous transcodes — refuse (the player shows "busy,
  // retry") rather than spawning a third libx264 and freezing the machine. The
  // job THIS request is taking over from doesn't count: it is the same viewer's
  // old position, kept alive only until this one is ready (see above). Counting
  // it meant one viewer could never seek — their own stream held a slot and the
  // seek was refused with "busy transcoding" (measured live).
  if (activeCount() - victims.length >= MAX_ACTIVE) {
    return Promise.reject(new Error("Server is busy transcoding other streams — try again in a moment"));
  }

  fs.mkdirSync(dir, { recursive: true });
  pruneOld(dir);

  const videoArgs =
    vcodec === "copy"
      ? ["-c:v", "copy"]
      : [
          "-c:v", "libx264",
          "-preset", "ultrafast", // must keep up with playback in real time
          "-crf", "23",
          "-pix_fmt", "yuv420p", // fold 10-bit down to 8-bit for browsers
          "-g", "48",
          "-threads", String(FFMPEG_THREADS),
          // 4K sources can't be transcoded in real time anyway — fold anything
          // above 1080p down (never upscale smaller sources).
          "-vf", "scale=min(1920\\,iw):-2",
        ];

  // Two input modes:
  //  • Normal play (ss=0): pipe the torrent's in-order read stream into ffmpeg.
  //    createReadStream makes WebTorrent download sequentially and blocks on
  //    missing pieces, so ffmpeg never reads a hole.
  //  • Seek/resume (ss>0): the pipe can't seek. If the file is COMPLETE on
  //    disk, -ss the local file (fast). Otherwise ffmpeg reads the torrent
  //    THROUGH OUR OWN HTTP RANGE ROUTE: every read blocks until WebTorrent
  //    delivers those exact bytes (and prioritizes them) — so seeking to ANY
  //    minute works, at swarm speed. The old way (-ss on the sparse on-disk
  //    file) read zero-holes as data: garbage/black video on unloaded parts.
  const seeking = ss > 0;
  // `file.done` is set by webtorrent once every piece of the file is verified
  // and — unlike the File.downloaded getter, which walks piece objects and can
  // throw from the piece picker — it can't blow up. A throw here used to leave
  // `complete` false for a file that IS fully on disk, sending an instant local
  // seek down the slow blocking-HTTP path instead.
  let complete = false;
  try { complete = !!file.done; } catch {}
  if (!complete) {
    try { complete = file.length > 0 && file.downloaded >= file.length; } catch {}
  }
  if (seeking) { try { file.select(); } catch {} } // keep downloading the whole file
  // MKV keeps its seek index (Cues) in the LAST ~0.1-1.7 MB of the file —
  // measured across this library 2026-07-25; the hit near the front is only the
  // SeekHead pointer. So ffmpeg cannot resolve `-ss` until those trailing bytes
  // exist, and on a still-downloading torrent the tail is typically the last
  // thing the swarm delivers. That is why seeking to an unloaded point worked
  // only sometimes: it depended on whether the tail happened to be there.
  // Pull it in parallel with ffmpeg's own reads — a read stream is what makes
  // WebTorrent mark those exact pieces critical.
  if (seeking && !complete) warmTail(file);

  const inputArgs = seeking
    ? complete
      ? ["-ss", String(ss), "-i", absPath]
      : ["-ss", String(ss), "-seekable", "1",
         // A single failed read on this (deliberately blocking) route would
         // otherwise kill the whole transcode and strand the viewer; let ffmpeg
         // re-open the connection instead. http-protocol options only, so they
         // stay inside this branch.
         "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
         "-i", `http://127.0.0.1:${config.PORT}/stream/torrent/${infoHash}/${fileIdx}`]
    : ["-fflags", "+genpts", "-i", "pipe:0"];

  const proc = spawn(
    config.FFMPEG,
    [
      "-v", "error",
      ...inputArgs,
      "-map", "0:v:0", "-map", "0:a:0?",
      ...videoArgs,
      "-c:a", "aac", "-ac", "2", "-b:a", "192k", "-af", AUDIO_GAIN,
      // The mpegts muxer's default delay starts segments at PTS ~1.4s.
      // hls.js normalizes that to 0, but NATIVE HLS (iPhone) uses raw PTS —
      // its clock ran 1.4s off from ours, shifting subtitles and the
      // scrubber on iOS while desktop looked perfect. Measured 2026-07-24.
      "-muxdelay", "0", "-muxpreload", "0",
      "-f", "hls",
      "-hls_time", "4", // shorter segments → first frames reach the player sooner
      "-hls_playlist_type", "event",
      "-hls_flags", "independent_segments+temp_file",
      "-hls_segment_filename", path.join(dir, "seg%05d.ts"),
      playlist,
    ],
    { stdio: [seeking ? "ignore" : "pipe", "ignore", "pipe"], windowsHide: true }
  );
  deprioritize(proc);

  let rs = null;
  let inputBytes = 0; // how much of the file actually reached ffmpeg
  if (!seeking) {
    try {
      // recoveringStream, not createReadStream: webtorrent's read path wedges
      // (froze a Silo transcode at 8s live) — this one serves verified pieces
      // straight from disk and self-heals the rest. file._torrent = owner.
      rs = require("./torrent").recoveringStream(file, { torrent: file._torrent });
    } catch (err) {
      try { proc.kill("SIGKILL"); } catch {}
      return Promise.reject(err);
    }
    rs.on("data", (c) => { inputBytes += c.length; });
    rs.on("error", () => {});
    proc.stdin.on("error", () => {}); // EPIPE once ffmpeg exits — expected
    rs.pipe(proc.stdin);
  }

  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  const job = { proc, done: false, lastAccess: Date.now() };
  job.ready = new Promise((resolve, reject) => {
    const started = Date.now();
    // Seeks into not-yet-downloaded territory legitimately wait on the swarm
    // (ffmpeg reads via the blocking HTTP route) — give them up to 5 minutes:
    // "skip to any minute" matters more than a snappy failure. A weak swarm
    // still fails eventually with a clear message.
    const startTimeout = seeking && !complete ? 300000 : 45000;
    const check = setInterval(() => {
      if (fs.existsSync(playlist)) {
        clearInterval(check);
        resolve(dir);
      } else if (Date.now() - started > startTimeout) {
        clearInterval(check);
        reject(new Error("The swarm couldn't deliver that part in time"));
      } else {
        // A client is actively awaiting this seek — keep the idle sweeper
        // away while ffmpeg blocks on swarm reads (touch() only fires on
        // segment requests, which don't exist yet).
        job.lastAccess = Date.now();
      }
    }, 250);

    proc.on("error", (err) => {
      clearInterval(check);
      reject(err);
    });
    proc.on("close", (code) => {
      job.done = true;
      job.proc = null;
      try { rs && rs.destroy(); } catch {}
      // Killed on purpose (idle sweeper / superseded by a newer seek) BEFORE
      // producing a playlist: reject promptly so an awaiting client isn't
      // left hanging for the full start timeout.
      if (code === null && !fs.existsSync(playlist)) {
        clearInterval(check);
        if (jobs.get(dir) === job) jobs.delete(dir);
        reject(new Error("Transcode was superseded"));
        return;
      }
      if (code !== 0 && code !== null) {
        console.error(`[torrent-transcode] ffmpeg exited ${code} (${infoHash.slice(0, 8)}…):`, stderr.slice(-300));
        clearInterval(check);
        // Never keep a partial job: a playlist stump would replay a few
        // seconds then stall forever on every retry. Evict + delete so the
        // next request re-transcodes from scratch.
        if (jobs.get(dir) === job) jobs.delete(dir);
        if (!fs.existsSync(playlist)) {
          reject(new Error("Transcode failed"));
        } else {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        }
        return;
      }
      // STARVATION GUARD (pipe mode): if the input stream died early, ffmpeg
      // sees EOF, exits 0 and finalizes a VALID-looking short playlist — a
      // 9-second "complete movie" was cached live and every open of the
      // episode played 9s and closed. A "success" that consumed meaningfully
      // less than the whole file is a failure: evict + delete.
      if (code === 0 && !seeking && rs && file.length > 0 && inputBytes < file.length * 0.95) {
        console.error(`[torrent-transcode] input starved: ${inputBytes}/${file.length} bytes reached ffmpeg — evicting truncated output (${infoHash.slice(0, 8)}…)`);
        clearInterval(check);
        if (jobs.get(dir) === job) jobs.delete(dir);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    });
  });

  // Evict a failed job so the next request can retry cleanly (otherwise the
  // rejected promise stays cached in the Map and every retry 504s instantly).
  job.ready.catch(() => {
    if (jobs.get(dir) === job) jobs.delete(dir);
    try { rs && rs.destroy(); } catch {}
    try { proc.kill("SIGKILL"); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  // Retire the job(s) this one replaced, but only now that this playlist exists
  // (see the supersede loop). If this job never gets there, they keep running —
  // whatever the viewer was already watching survives the failed seek.
  if (victims.length) job.ready.then(retireVictims, () => {});

  jobs.set(dir, job);
  console.log(`[torrent-transcode] ${infoHash.slice(0, 8)}… file ${fileIdx} (${vcodec}${ss ? ` @${ss}s` : ""})`);
  return job.ready;
};

// Mark a job as still-in-use (called on every playlist/segment request) so the
// idle sweeper doesn't kill a stream the player is actively watching.
const touch = (infoHash, fileIdx, ss = 0) => {
  const job = jobs.get(jobDir(infoHash, fileIdx, ss));
  if (job) job.lastAccess = Date.now();
};

// Kill transcodes whose player has stopped requesting segments (tab closed,
// navigated away). ffmpeg would otherwise keep transcoding the whole file and
// burn CPU for a stream nobody is watching.
setInterval(() => {
  const now = Date.now();
  for (const [dir, job] of jobs) {
    if (job.proc && now - job.lastAccess > IDLE_MS) {
      try { job.proc.kill("SIGKILL"); } catch {}
      jobs.delete(dir);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      console.log(`[torrent-transcode] idle-killed ${path.basename(dir)}`);
    }
  }
}, 30000).unref?.();

// Validate + resolve a request for a playlist or segment file.
const filePath = (infoHash, fileIdx, ss, file) => {
  if (!/^[a-f0-9]{40}$/i.test(infoHash) || !/^\d+$/.test(String(fileIdx)) || !/^\d+$/.test(String(ss))) return null;
  if (!/^(index\.m3u8|seg\d{5}\.ts)$/.test(file)) return null;
  const abs = path.join(HLS_ROOT, jobKey(infoHash, fileIdx, ss), file);
  return fs.existsSync(abs) ? abs : null;
};

module.exports = { ensure, touch, filePath, bootSweep, HLS_ROOT };
