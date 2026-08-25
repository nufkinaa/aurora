// Compatibility remux/transcode for library files, as HLS:
//   vcodec "copy" - video copied (no quality loss, fast), audio -> stereo AAC.
//     For files whose AUDIO the browser can't decode (AC-3, E-AC-3, DTS...).
//   vcodec "h264" - video -> H.264 too, for files whose VIDEO the device can't
//     decode (HEVC/AV1/10-bit on phones and most desktops).
// `ss` starts the job at an offset — the file is complete on disk, so unlike
// torrent streams any offset works (resume + far seek).
// Segments cache on disk; old jobs are pruned to bound disk usage.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const config = require("../config");

const HLS_ROOT = path.join(config.CACHE_DIR, "hls");
const MAX_CACHED_JOBS = 3;
const IDLE_MS = 150000; // kill a remux whose player stopped requesting (>2.5 min)

// Server-survival guards (same rationale as torrent-transcode.js): uncapped
// libx264 processes starve the event loop and "freeze" the whole server.
const MAX_ACTIVE_TRANSCODES = 2; // concurrent live h264 jobs (copy jobs are cheap)
const FFMPEG_THREADS = Math.max(1, os.cpus().length - 2);

const jobs = new Map(); // dir -> {proc, done, heavy, lastAccess}

// Offsets we deliberately abandoned, and when. A request that arrives for one is
// a poll from the player we just moved off; re-creating that job would supersede
// the brand-new stream the viewer was switched to (measured on the torrent side:
// it still reproduced one poll after the retire). Refuse instead. Short-lived,
// so genuinely seeking back to that offset later still works.
const retired = new Map(); // dir -> timestamp
const RETIRED_MS = 5000;

// Drop a job that a newer one replaced: kill ffmpeg, and delete its dir once the
// process has let go of its files (a headless EVENT playlist left behind would
// stall every future replay at its edge).
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
  console.log(`[remux] superseded ${path.basename(d)}`);
};

// Boot sweep: unfinished playlists from a previous server run are stumps that
// stall every replay at their edge — any playlist without #EXT-X-ENDLIST is
// garbage. MUST run only AFTER this process wins the port (called from
// server.js's listen callback), never at module load: a second/stale instance
// that will fail to bind would otherwise delete the LIVE instance's
// in-progress transcodes (legitimately ENDLIST-less) before exiting.
const bootSweep = () => {
  try {
    for (const e of fs.readdirSync(HLS_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const abs = path.join(HLS_ROOT, e.name);
      let done = false;
      try { done = fs.readFileSync(path.join(abs, "index.m3u8"), "utf-8").includes("#EXT-X-ENDLIST"); } catch {}
      if (!done) {
        try { fs.rmSync(abs, { recursive: true, force: true }); console.log(`[remux] boot-swept stump ${e.name}`); } catch {}
      }
    }
  } catch {}
};

const activeTranscodes = () => {
  let n = 0;
  for (const j of jobs.values()) if (j.proc && j.heavy) n++;
  return n;
};

// A job that STARTS AT AN OFFSET must re-encode the video — copying it is not
// an option YET. Two measured failures, one per era:
// - 2026-07-25: `-ss` + `-c:v copy` emitted a partly NEGATIVE timeline
//   (fragment 0 at PTS -2.81..1.57) — MSE dropped it, hls.js re-appended in a
//   loop, playback starved after every skip.
// - 2026-08-25: with `-avoid_negative_ts make_zero` the starvation is GONE
//   (sandbox-verified, sustained playback) — but the copied timeline starts
//   at a POSITIVE offset (seg0 PTS began at 9.3s for -ss 22), and the
//   player's `startPosition: 0` made hls.js hunt a position that doesn't
//   exist for ~20s before its gap-jump kicked in; the clock then lies to the
//   scrubber by the same offset. make_zero only fixes negatives.
// The prize is real (a copy seek would start in ~0.1-2s instead of paying a
// libx264 encode — the server side measured 117ms cold) but it needs the
// PTS-honest design: serve the segments' true content-time PTS and have the
// player map its clock from PTS instead of assuming 0 = ss. Until that lands,
// offset jobs re-encode: exact requested second, clean 0-based timeline.
// Both the playlist and the segment route must agree on this, or they compute
// different job dirs and every segment 404s.
const effectiveVcodec = (vcodec, ss) => (ss > 0 ? "h264" : vcodec);

// Level-match film audio to web expectations — see the note in
// torrent-transcode.js for the measurements behind these numbers.
const AUDIO_GAIN = "volume=4dB,alimiter=limit=0.7:level=disabled:latency=true";

// Job dir name. The bare `${id}-${mtime}` form is the original audio-only
// remux (existing cached jobs stay valid); transcodes and offset jobs get a
// suffixed dir so a cached video-copy job is never served where h264 is needed.
const dirName = (id, mtime, vcodec = "copy", ss = 0) =>
  vcodec === "copy" && !ss
    ? `${id}-${Math.floor(mtime)}`
    : `${id}-${Math.floor(mtime)}-${vcodec}-${ss}`;

const jobDir = (id, mtime, vcodec, ss) => path.join(HLS_ROOT, dirName(id, mtime, vcodec, ss));

// Keep an actively-watched job alive (called on segment/playlist requests).
const touch = (id, mtime, vcodec, ss) => {
  const job = jobs.get(jobDir(id, mtime, vcodec, ss));
  if (job) job.lastAccess = Date.now();
};

// Kill remuxes whose player has gone away so ffmpeg doesn't keep running.
setInterval(() => {
  const now = Date.now();
  for (const [dir, job] of jobs) {
    if (job.proc && now - (job.lastAccess || 0) > IDLE_MS) {
      try { job.proc.kill("SIGKILL"); } catch {}
      jobs.delete(dir);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      console.log(`[remux] idle-killed ${path.basename(dir)}`);
    }
  }
}, 30000).unref?.();

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
      // In use? Leave it. `proc` alone isn't enough: a job that already FINISHED
      // has proc === null while the viewer is still watching its segments, and
      // two more seeks were enough to prune that dir out from under them.
      const j = jobs.get(d.abs);
      if (j && (j.proc || Date.now() - (j.lastAccess || 0) < IDLE_MS)) continue;
      fs.rmSync(d.abs, { recursive: true, force: true });
      jobs.delete(d.abs); // drop the finished-job Map entry along with its dir
    }
  } catch {}
};

// Ensure an HLS remux/transcode job exists for this video. Resolves with the
// job dir once the playlist file is available (job continues in background).
const ensure = (videoPath, id, { vcodec = "copy", ss = 0, seek = false } = {}) => {
  let mtime = 0;
  try {
    mtime = fs.statSync(videoPath).mtimeMs;
  } catch {
    return Promise.reject(new Error("Video not found"));
  }
  ss = Math.max(0, Math.floor(Number(ss) || 0));
  vcodec = effectiveVcodec(vcodec, ss);
  const heavy = vcodec === "h264";

  const dir = jobDir(id, mtime, vcodec, ss);
  const playlist = path.join(dir, "index.m3u8");

  // A poll from the stream we just moved off (see `retired`) must not resurrect
  // it: its dir is being torn down, so there is nothing here worth serving.
  if (!seek && Date.now() - (retired.get(dir) || 0) < RETIRED_MS) {
    return Promise.reject(new Error("Transcode was superseded"));
  }

  // A new job for a file whose previous job is still running means the player
  // moved on (far seek / resume) — the old ffmpeg is abandoned but would hold
  // its concurrency slot and keep writing segments for up to IDLE_MS, which
  // made the 2-slot cap reject the very next seek ("part isn't ready yet").
  //
  // The kill is DEFERRED for any job that already has a playlist, because that
  // is probably the stream the viewer is watching right now and its player keeps
  // polling that playlist while the seek waits. Deleting it up-front made the
  // poll re-create the job, which then superseded the job the seek wanted — the
  // seek failed and playback restarted with an empty buffer (diagnosed on the
  // torrent side; identical structure here). A job with no playlist yet has no
  // viewer, so it can go immediately and free its slot.
  // Two devices transcoding the SAME file at once would fight over this — an
  // acceptable trade for seeks that always work.
  // ONLY a deliberate move by the viewer (`seek`) retires another offset — a
  // background playlist poll that re-creates a died job would otherwise kill the
  // seek in flight (diagnosed on the torrent side; identical structure here).
  const samePrefix = `${id}-${Math.floor(mtime)}`;
  const victims = [];
  if (seek) {
    for (const [d, j] of jobs) {
      if (d === dir || !j.proc) continue;
      const base = path.basename(d);
      if (base !== samePrefix && !base.startsWith(`${samePrefix}-`)) continue;
      if (fs.existsSync(path.join(d, "index.m3u8"))) victims.push([d, j]);
      else retire(d, j);
    }
  }

  const retireVictims = () => {
    for (const [d, j] of victims) if (jobs.get(d) === j) retire(d, j);
  };

  // Finished or in-progress job with a playlist already on disk. Checked AFTER
  // the loop above so a deliberate move still retires what it replaces no matter
  // which request lands first (the player fires its claim and its playlist load
  // together).
  if (fs.existsSync(playlist)) {
    // A playlist request means a player is still on this stream — mark it in
    // use, or the idle sweeper kills ffmpeg mid-watch. Only segment requests
    // used to count, and hls.js stops fetching those once its buffer is full
    // (or the viewer pauses), which reaped the transcode out from under it.
    const running = jobs.get(dir);
    if (running) running.lastAccess = Date.now();
    retireVictims();
    return Promise.resolve(dir);
  }

  // Reuse an in-flight job only if it's still valid (running, or playlist still
  // present) — a finished job whose dir was pruned leaves a stale promise.
  if (jobs.has(dir)) {
    const j = jobs.get(dir);
    if (j.proc) {
      j.lastAccess = Date.now();
      j.ready.then(retireVictims, () => {});
      return j.ready;
    }
    jobs.delete(dir);
  }

  // Hard cap on simultaneous h264 transcodes — refuse rather than spawning
  // another libx264 and freezing the machine. The jobs THIS request is taking
  // over from don't count: they are the same viewer's old position, kept alive
  // only until this one is ready (see above). Counting them meant one viewer
  // watching a transcode could never seek — their own stream held a slot and
  // their seek was refused with "busy transcoding" (measured live).
  const handoff = victims.reduce((n, [, j]) => n + (j.heavy ? 1 : 0), 0);
  if (heavy && activeTranscodes() - handoff >= MAX_ACTIVE_TRANSCODES) {
    return Promise.reject(new Error("Server is busy transcoding other streams — try again in a moment"));
  }

  fs.mkdirSync(dir, { recursive: true });
  pruneOld(dir);

  const videoArgs = heavy
    ? [
        "-c:v", "libx264",
        "-preset", "ultrafast", // must keep up with playback in real time
        "-crf", "23",
        "-pix_fmt", "yuv420p", // fold 10-bit down to 8-bit for browsers
        "-g", "48",
        "-threads", String(FFMPEG_THREADS),
        // 4K sources can't be transcoded in real time anyway — fold anything
        // above 1080p down (never upscale smaller sources).
        "-vf", "scale=min(1920\\,iw):-2",
      ]
    : ["-c:v", "copy"];

  const proc = spawn(
    config.FFMPEG,
    [
      "-v", "error",
      // -ss before -i: fast input seek; the file is complete so any offset works
      ...(ss > 0 ? ["-ss", String(ss)] : []),
      "-i", videoPath,
      "-map", "0:v:0", "-map", "0:a:0",
      ...videoArgs,
      "-c:a", "aac", "-ac", "2", "-b:a", "192k", "-af", AUDIO_GAIN,
      // PTS must start at 0: native HLS players (iPhone) use raw segment PTS
      // for the clock; the muxer's default ~1.4s delay skewed subtitles and
      // the scrubber on iOS relative to desktop. Measured 2026-07-24.
      "-muxdelay", "0", "-muxpreload", "0",
      "-f", "hls",
      "-hls_time", "6",
      // Short first segments so playback can start as soon as ~2s is encoded
      // instead of waiting for a full 6s segment. (Going below 2 buys nothing:
      // segments can only split on keyframes and -g 48 makes a 2s GOP.)
      "-hls_init_time", "2",
      "-hls_playlist_type", "event",
      "-hls_flags", "independent_segments+temp_file",
      "-hls_segment_filename", path.join(dir, "seg%05d.ts"),
      playlist,
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
  );
  // Keep node responsive: ffmpeg yields CPU to the server under contention.
  try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}

  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  const job = { proc, done: false, heavy, lastAccess: Date.now() };
  job.ready = new Promise((resolve, reject) => {
    // resolve as soon as the playlist appears so playback starts immediately
    const started = Date.now();
    const check = setInterval(() => {
      if (fs.existsSync(playlist)) {
        clearInterval(check);
        resolve(dir);
      } else if (Date.now() - started > 20000) {
        clearInterval(check);
        reject(new Error("Remux did not start in time"));
      }
    }, 100); // the playlist gate is on every seek's critical path — poll tight

    proc.on("error", (err) => {
      clearInterval(check);
      reject(err);
    });
    proc.on("close", (code) => {
      job.done = true;
      job.proc = null;
      // code null = killed on purpose (idle sweeper) — not a failure.
      if (code !== 0 && code !== null) {
        console.error(`Remux failed for ${videoPath}:`, stderr.slice(-300));
        clearInterval(check);
        // A partial playlist is a stump that stalls on every replay — evict
        // and delete so the next request re-remuxes from scratch.
        if (jobs.get(dir) === job) jobs.delete(dir);
        if (!fs.existsSync(playlist)) {
          reject(new Error("Remux failed"));
        } else {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        }
      } else if (code === 0) {
        console.log(`Remux complete: ${path.basename(videoPath)}`);
      }
    });
  });

  // Evict a failed job (kill ffmpeg, drop from the Map) so one bad file doesn't
  // stay permanently unplayable via a cached rejected promise.
  job.ready.catch(() => {
    if (jobs.get(dir) === job) jobs.delete(dir);
    try { proc.kill("SIGKILL"); } catch {}
  });

  // Retire the job(s) this one replaced, but only now that this playlist exists
  // (see the supersede loop). If this job never gets there, they keep running —
  // whatever the viewer was already watching survives the failed seek.
  if (victims.length) job.ready.then(retireVictims, () => {});

  jobs.set(dir, job);
  return job.ready;
};

const filePath = (dir, file) => {
  // strict names only: index.m3u8 / segNNNNN.ts
  if (!/^(index\.m3u8|seg\d{5}\.ts)$/.test(file)) return null;
  if (!/^[a-z0-9]+-\d+(-(?:h264|copy)-\d+)?$/.test(dir)) return null;
  const abs = path.join(HLS_ROOT, dir, file);
  return fs.existsSync(abs) ? abs : null;
};

module.exports = { ensure, touch, filePath, dirName, effectiveVcodec, bootSweep, HLS_ROOT };
