#!/usr/bin/env node
// A PRIVATE Aurora instance built from any git ref, for the load harness.
//
//   const { start } = require("./instance");
//   const srv = await start({ ref: "master", profiles: 12 });
//   srv.url  srv.pid  srv.sessions[i] = { profileId, sid }  srv.snap()  srv.stop()
//
//   node tools/loadtest/instance.js --ref master [--profiles 12] [--media real|gen]
//       the same by hand: prints the address, CTRL-C tears it down
//
// Layout (everything under LT_WORK, default %TEMP%/aurora-agents/srv-loadtest):
//
//   src-<sha>/                    `git archive <sha>` of the code (server.js, src,
//                                 public, scripts, package*.json …), made once per commit
//   deps-<lockhash>/node_modules  `npm ci` of that package-lock.json, made once per lock
//   deps-<lockhash>/i-<sha8>-<n>/ ONE instance: a copy of src-<sha>, its own
//                                 config.json, data/, tmp/. Node finds node_modules
//                                 by walking up to deps-<lockhash>/ — there is NO
//                                 junction or symlink anywhere (COMMON-RULES 2026-10-17).
//   seed-real-<day>/              the safe, non-personal caches copied (read only)
//                                 from the live data folder, once a day
//
// `ref` may also be a directory (another agent's worktree, uncommitted work
// included): its server.js/src/public/package*.json are copied as they are.
//
// Fences (the same as the UI tests'): the live server on :4000 is never
// contacted, nothing of the owner's is written, every outbound connection is
// refused (test/ui/support/server-preload.js of THIS worktree, copied in),
// the instance dies with its parent, aria2c is never needed (no downloads are
// started), notifications are empty. The library (media "real") is the live
// config's `libraries`, read in-process; only that key is read.
"use strict";
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync, execFileSync } = require("child_process");
const { HERE, REPO, WORK, sleep, git } = require("./lib");

const LIVE_ROOT = process.env.LT_LIVE_ROOT || "C:\\elia\\aurora";
const LIVE_DATA = path.join(LIVE_ROOT, "data");
const FENCE = path.join(REPO, "test", "ui", "support", "server-preload.js");
const CODE_PATHS = ["server.js", "src", "public", "scripts", "package.json", "package-lock.json", "CHANGELOG.md", "tools/patch-webtorrent.js"];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const killTree = (child) => {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }
};
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Only ever deletes a folder this harness made, and refuses one with a link in it.
const removeDir = (dir) => {
  if (!dir || !path.resolve(dir).startsWith(path.resolve(WORK)) || !fs.existsSync(dir)) return true;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isSymbolicLink()) throw new Error(`link inside ${d}: refusing to delete`); if (e.isDirectory()) walk(path.join(d, e.name)); } };
  walk(dir);
  for (let i = 0; i < 40; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (!fs.existsSync(dir)) return true;
    sleepSync(150);
  }
  return false;
};

// ---------- the code ----------
const resolveRef = (ref) => {
  if (ref && fs.existsSync(ref) && fs.statSync(ref).isDirectory()) return { kind: "dir", dir: path.resolve(ref), label: `dir:${path.basename(ref)}` };
  const sha = git(["rev-parse", "--verify", `${ref || "HEAD"}^{commit}`]);
  return { kind: "sha", sha, label: `${ref || "HEAD"}@${sha.slice(0, 8)}` };
};
const codeFor = (r) => {
  if (r.kind === "dir") {
    const key = crypto.createHash("md5").update(r.dir).digest("hex").slice(0, 8);
    const dir = path.join(WORK, `src-dir-${key}`);
    removeDir(dir);
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    for (const p of CODE_PATHS) {
      const from = path.join(r.dir, p);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(dir, p), { recursive: true, filter: (s) => !/node_modules|\.apk$/i.test(s) });
    }
    const head = (() => { try { return execFileSync("git", ["-C", r.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })();
    const dirty = (() => { try { return execFileSync("git", ["-C", r.dir, "status", "--porcelain", "--", "server.js", "src", "public"], { encoding: "utf8" }).trim().length > 0; } catch { return null; } })();
    return { dir, head, dirty };
  }
  const dir = path.join(WORK, `src-${r.sha}`);
  if (fs.existsSync(path.join(dir, ".ready"))) return { dir, head: r.sha, dirty: false };
  removeDir(dir);
  fs.mkdirSync(dir, { recursive: true });
  const tar = path.join(dir, "code.tar"); // (extracted by its relative name: GNU tar reads "C:" as a host)
  const have = CODE_PATHS.filter((p) => { try { git(["cat-file", "-e", `${r.sha}:${p}`]); return true; } catch { return false; } });
  git(["archive", "--format=tar", "-o", tar, r.sha, ...have]);
  execFileSync("tar", ["-xf", "code.tar"], { cwd: dir, stdio: "ignore" });
  fs.rmSync(tar, { force: true });
  fs.writeFileSync(path.join(dir, ".ready"), new Date().toISOString());
  return { dir, head: r.sha, dirty: false };
};
const depsFor = (codeDir, log = () => {}) => {
  const lock = fs.readFileSync(path.join(codeDir, "package-lock.json"));
  const key = crypto.createHash("sha256").update(lock).update(fs.readFileSync(path.join(codeDir, "package.json"))).digest("hex").slice(0, 12);
  const dir = path.join(WORK, `deps-${key}`);
  if (fs.existsSync(path.join(dir, ".ready"))) return dir;
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(codeDir, f), path.join(dir, f));
  if (fs.existsSync(path.join(codeDir, "tools", "patch-webtorrent.js"))) fs.copyFileSync(path.join(codeDir, "tools", "patch-webtorrent.js"), path.join(dir, "tools", "patch-webtorrent.js"));
  log(`[lt] npm ci in ${dir} (once per package-lock)`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["ci", "--no-audit", "--no-fund", "--omit=dev"], { cwd: dir, stdio: "pipe", encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`npm ci failed in ${dir}:\n${(r.stderr || "").slice(-2000)}`);
  fs.writeFileSync(path.join(dir, ".ready"), new Date().toISOString());
  return dir;
};

// ---------- the data ----------
// Copied from the live data folder: caches of PUBLIC catalogue facts and of
// what the server worked out about the library's files (probes, intros,
// subtitle languages, pictures). Never: profiles, sessions, history, usage,
// downloads, telemetry, logs, backups, push, avatars, settings.
const SAFE_FILES = ["metadata-cache.json", "imdb-map.json", "online-metadata.json", "intro-auto.json", "intros.json", "sub-langs.json", "sub-audiosync.json"];
const SAFE_CACHE_FILES = ["discover.json", "meta.json", "similar.json", "xray.json", "certificates.json", "availability.json", "recs-titles.json", "search-known.json", "person.json", "person-titles.json", "trailers.json", "skip-segments.json", "poster-fallback.json", "torrent-streams.json", "encode-calibration.json", "tonemap-speed.json", "search-seen.json"];
const SAFE_CACHE_DIRS = ["posters", "posters-web", "blur", "stills", "img-variants", "vtt", "speech"];
// The picture caches are big (posters-web alone is ~650 MB): an instance gets
// HARD links to the seed's files (not junctions or symlinks: a hard link is a
// second name for a file in the seed copy, deleting it deletes only that
// name, and the server replaces cache files by writing new ones).
const linkTree = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) linkTree(a, b);
    else if (e.isFile()) { try { fs.linkSync(a, b); } catch { fs.copyFileSync(a, b); } }
  }
};
const realSeed = ({ refresh = false, log = () => {} } = {}) => {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(WORK, `seed-real-${day}`);
  if (!refresh && fs.existsSync(path.join(dir, ".ready"))) return dir;
  removeDir(dir);
  fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
  log(`[lt] copying the live data folder's safe caches (read only) into ${dir}`);
  for (const f of SAFE_FILES) { const p = path.join(LIVE_DATA, f); if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dir, f)); }
  for (const f of SAFE_CACHE_FILES) { const p = path.join(LIVE_DATA, "cache", f); if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dir, "cache", f)); }
  for (const d of SAFE_CACHE_DIRS) { const p = path.join(LIVE_DATA, "cache", d); if (fs.existsSync(p)) fs.cpSync(p, path.join(dir, "cache", d), { recursive: true }); }
  // old copies
  for (const e of fs.readdirSync(WORK)) if (e.startsWith("seed-real-") && e !== path.basename(dir)) removeDir(path.join(WORK, e));
  fs.writeFileSync(path.join(dir, ".ready"), new Date().toISOString());
  return dir;
};
const liveLibraries = () => {
  // only `libraries` (and the two non-secret scheduling keys) are taken from the live config
  const cfg = JSON.parse(fs.readFileSync(path.join(LIVE_ROOT, "config.json"), "utf8"));
  return { libraries: cfg.libraries, scanIntervalMinutes: cfg.scanIntervalMinutes, autoOcrSubtitles: cfg.autoOcrSubtitles };
};

// The household: N synthetic profiles ("Load 1" … "Load N", ids lt0000000001…),
// one signed-in session each (the sha256 of the sid is what the store keeps).
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const household = (n) => {
  const now = Date.now();
  const colors = ["#e05f2c", "#3a7a4c", "#2c5f8b", "#8b3a2c", "#7a3a8b", "#8b7a2c"];
  const profiles = [], state = {}, access = {}, sessions = {}, handed = [];
  for (let i = 0; i < n; i++) {
    const id = `lt${String(i + 1).padStart(10, "0")}`;
    profiles.push({ id, name: `Load ${i + 1}`, color: colors[i % colors.length], avatar: "🍿", theme: "aurora", prefs: { smartCleanup: false } });
    state[id] = { progress: {}, watchlist: [], ratings: {}, likedGenres: ["Drama", "Comedy", "Thriller"], streamItems: {}, upNextDismissed: {}, titles: {}, likedTitles: [], searches: [] };
    access[id] = [];
    // two devices per profile: a browser and a TV
    for (const kind of ["web", "tv"]) {
      const sid = sha256(`lt-session-${i}-${kind}`);
      sessions[sha256(sid)] = { profileId: id, createdAt: now - 86400e3, lastSeenAt: now, expiresAt: now + 90 * 86400e3, device: kind === "tv" ? { browser: "Aurora TV", os: "Android TV", device: "📺" } : { browser: "Chrome", os: "Windows", device: "💻" }, ip: "127.0.0.1" };
      handed.push({ profileId: id, sid, kind, i });
    }
  }
  return { profiles: { profiles, state, pending: [], access }, sessions, handed };
};

// ---------- generated media (media: "gen") ----------
// A small library made with ffmpeg, for machines without the real one (or CI):
// long enough files at real bitrates for the streaming viewers, and many small
// hard-linked films so the grids and search have something to chew on.
const genMedia = ({ films = 300, log = () => {} } = {}) => {
  const dir = path.join(WORK, `media-gen-v1-${films}`);
  const movies = path.join(dir, "movies"), shows = path.join(dir, "shows");
  if (fs.existsSync(path.join(dir, ".ready"))) return { movies, shows };
  removeDir(dir);
  fs.mkdirSync(movies, { recursive: true }); fs.mkdirSync(shows, { recursive: true });
  const ff = (args) => { const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe", windowsHide: true }); if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`); };
  const secs = 600;
  log(`[lt] generating media in ${dir} (a few minutes, once)`);
  const big = [
    // direct play: H.264 + AAC MP4 at ~8 Mbit
    { name: "Lt Direct Eight (2020)", ext: "mp4", v: ["-c:v", "libx264", "-preset", "ultrafast", "-b:v", "8M", "-maxrate", "8M", "-bufsize", "16M", "-g", "48", "-pix_fmt", "yuv420p"], a: ["-c:a", "aac", "-b:a", "128k"], extra: ["-movflags", "+faststart"], size: "1920x1080" },
    // remux (jit copy): H.264 + AC-3 MKV
    { name: "Lt Remux Ac3 (2021)", ext: "mkv", v: ["-c:v", "libx264", "-preset", "ultrafast", "-b:v", "6M", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-pix_fmt", "yuv420p"], a: ["-c:a", "ac3", "-b:a", "384k", "-ac", "6"], extra: [], size: "1920x1080" },
    // direct play at 4K-ish bitrate (25 Mbit) for disk pressure
    { name: "Lt Direct Heavy (2022)", ext: "mp4", v: ["-c:v", "libx264", "-preset", "ultrafast", "-b:v", "25M", "-maxrate", "25M", "-bufsize", "50M", "-g", "48", "-pix_fmt", "yuv420p"], a: ["-c:a", "aac", "-b:a", "128k"], extra: ["-movflags", "+faststart"], size: "1920x1080" },
  ];
  for (const b of big) {
    const d = path.join(movies, b.name);
    fs.mkdirSync(d, { recursive: true });
    ff(["-f", "lavfi", "-i", `testsrc2=size=${b.size}:rate=24:duration=${secs}`, "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${secs}`, ...b.v, ...b.a, ...b.extra, "-shortest", path.join(d, `${b.name}.${b.ext}`)]);
  }
  const small = path.join(dir, "small.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=20", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=20", "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", small]);
  const W1 = ["Silent", "Broken", "Golden", "Last", "Hidden", "Crimson", "Electric", "Paper", "Midnight", "Northern", "Hollow", "Burning", "Quiet", "Wild", "Glass"];
  const W2 = ["River", "Empire", "Garden", "Signal", "Harbor", "Kingdom", "Mirror", "Orchard", "Station", "Voyage", "Shadow", "Promise", "Engine", "Theory", "Summer", "Witness", "Machine", "Canyon", "Lantern", "Parade"];
  for (let i = 0; i < films; i++) {
    const name = `${W1[i % W1.length]} ${W2[Math.floor(i / W1.length) % W2.length]} ${Math.floor(i / 300) || ""}`.trim() + ` (${1975 + (i % 50)})`;
    const d = path.join(movies, name);
    fs.mkdirSync(d, { recursive: true });
    try { fs.linkSync(small, path.join(d, `${name}.mp4`)); } catch { fs.copyFileSync(small, path.join(d, `${name}.mp4`)); }
  }
  for (let s = 0; s < 10; s++) {
    const sd = path.join(shows, `Lt Show ${s + 1}`, "Season 1");
    fs.mkdirSync(sd, { recursive: true });
    for (let e = 1; e <= 8; e++) { const f = path.join(sd, `Lt Show ${s + 1} S01E0${e}.mp4`); try { fs.linkSync(small, f); } catch { fs.copyFileSync(small, f); } }
  }
  fs.writeFileSync(path.join(dir, ".ready"), new Date().toISOString());
  return { movies, shows };
};

// ---------- a library shaped like the household's (media: "cap") ----------
// tools/loadtest/capacity.js. The house library (probed read-only, 2026-10-26:
// 61 files) is web-sized 1080p: median 2.5 Mbit/s, p90 4.2, max 6.4; half
// HEVC 10-bit MKV with E-AC-3 or AAC, half H.264 MP4 with AAC (some AC-3).
// Five 30-minute masters at those bitrates (graphics-card encoders when the
// machine has them: minutes, not hours), each hard-linked under CAP_COPIES
// names so viewers watch different titles (their own ids, jobs and caches;
// the OS page cache is shared, so disk reads are flattered: see the report),
// two subtitle sidecars per title, plus small films and shows for browsing.
const CAP_SECS = 1800;
// v3: the H.264 masters made by x264 (High 4.1), as the house library's H.264 files
// are. v1/v2 made them with the card's own encoder, whose streams the card's DECODER
// refuses under the ladder's -extra_hw_frames 4 (CUDA_ERROR_INVALID_VALUE): their
// encodes fell back to the CPU — a property of those generated files; the house's
// H.264 files decode on the card with the same arguments (REPORT.md).
const CAP_VERSION = 3;
const CAP_COPIES = 8;
const CAP_MASTERS = [
  // direct play everywhere
  { key: "web-h264", name: "Cap Web H264", year: 2020, ext: "mp4", codec: "h264", kbps: 2600, audio: ["-c:a", "aac", "-b:a", "128k"], tenBit: false },
  // web: repackaged (HEVC in MKV); TV: the offset copy (E-AC-3)
  { key: "hevc10-eac3", name: "Cap Release Hevc", year: 2021, ext: "mkv", codec: "hevc", kbps: 2500, audio: ["-c:a", "eac3", "-b:a", "384k", "-ac", "6"], tenBit: true },
  // web: repackaged (AC-3 sound); TV: the offset copy
  { key: "h264-ac3", name: "Cap Episode Ac3", year: 2019, ext: "mp4", codec: "h264", kbps: 4200, audio: ["-c:a", "ac3", "-b:a", "384k", "-ac", "6"], tenBit: false },
  // web: repackaged (HEVC in MKV); TV: direct
  { key: "hevc-aac", name: "Cap Release Aac", year: 2022, ext: "mkv", codec: "hevc", kbps: 2000, audio: ["-c:a", "aac", "-b:a", "160k"], tenBit: false },
  // the heaviest file in the house
  { key: "hevc10-heavy", name: "Cap Heavy Hevc", year: 2023, ext: "mkv", codec: "hevc", kbps: 6400, audio: ["-c:a", "eac3", "-b:a", "640k", "-ac", "6"], tenBit: true },
];
const srtText = (secs, lang) => {
  const out = [];
  const two = (x) => String(x).padStart(2, "0");
  const ts = (t) => `${two(Math.floor(t / 3600))}:${two(Math.floor((t % 3600) / 60))}:${two(Math.floor(t % 60))},${String(Math.round((t % 1) * 1000)).padStart(3, "0")}`;
  const words = lang === "he" ? ["shalom", "laila", "tov", "eifo", "ata", "holech", "achshav", "bevakasha"] : ["hello", "night", "where", "are", "you", "going", "now", "please"];
  const NL = String.fromCharCode(10);
  let k = 1;
  for (let t = 2; t < secs - 3; t += 3.1) { out.push(`${k}${NL}${ts(t)} --> ${ts(t + 2.4)}${NL}${Array.from({ length: 6 }, (_, i) => words[(k + i) % words.length]).join(" ")}${NL}`); k++; }
  return out.join(NL);
};
const genMediaCap = ({ films = 300, log = () => {} } = {}) => {
  const dir = path.join(WORK, `media-cap-v${CAP_VERSION}-${films}`);
  const movies = path.join(dir, "movies"), shows = path.join(dir, "shows");
  if (fs.existsSync(path.join(dir, ".ready"))) return { movies, shows, dir };
  removeDir(dir);
  fs.mkdirSync(movies, { recursive: true }); fs.mkdirSync(shows, { recursive: true });
  const masters = path.join(dir, "masters");
  fs.mkdirSync(masters, { recursive: true });
  const ff = (args) => { const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe", windowsHide: true }); return r.status === 0 ? null : String(r.stderr).slice(-600); };
  log(`[lt] generating the house-shaped library in ${dir} (${CAP_MASTERS.length} x ${CAP_SECS / 60} min masters, once)`);
  for (const m of CAP_MASTERS) {
    const out = path.join(masters, `${m.key}.${m.ext}`);
    const src = ["-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=24:duration=${CAP_SECS}`, "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${CAP_SECS}`];
    const rate = ["-b:v", `${m.kbps}k`, "-maxrate", `${m.kbps}k`, "-bufsize", `${m.kbps * 2}k`];
    const gop = m.codec === "hevc" ? 120 : 96;
    const tail = [...m.audio, ...(m.ext === "mp4" ? ["-movflags", "+faststart"] : []), "-shortest", out];
    // (noise keeps the picture from compressing below the target rate)
    const hw = m.codec === "hevc"
      ? ["-vf", `noise=alls=12:allf=t,format=${m.tenBit ? "p010le" : "yuv420p"}`, "-c:v", "hevc_nvenc", ...(m.tenBit ? ["-profile:v", "main10"] : []), "-rc", "cbr", ...rate, "-g", String(gop)]
      : ["-vf", "noise=alls=12:allf=t,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-level", "4.1", ...rate, "-g", String(gop)];
    const sw = m.codec === "hevc"
      ? ["-vf", `noise=alls=12:allf=t,format=${m.tenBit ? "yuv420p10le" : "yuv420p"}`, "-c:v", "libx265", "-preset", "ultrafast", ...rate, "-x265-params", `keyint=${gop}:min-keyint=${gop}:log-level=error`]
      : ["-vf", "noise=alls=12:allf=t,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "high", "-level", "4.1", ...rate, "-g", String(gop)];
    // an unchanged master of an earlier version is reused (hard link), not made again
    const prev = [1, 2].map((v) => path.join(WORK, `media-cap-v${v}-${films}`, "masters", `${m.key}.${m.ext}`)).find((p) => fs.existsSync(p));
    let err = null;
    if (m.codec !== "h264" && prev) { try { fs.linkSync(prev, out); } catch { fs.copyFileSync(prev, out); } }
    else err = ff([...src, ...hw, ...tail]);
    if (err) { log(`[lt] (no graphics-card encoder for ${m.key}: software instead)`); const e2 = ff([...src, ...sw, ...tail]); if (e2) throw new Error(`ffmpeg: ${e2}`); }
    fs.writeFileSync(path.join(masters, `${m.key}.en.srt`), srtText(CAP_SECS, "en"));
    fs.writeFileSync(path.join(masters, `${m.key}.he.srt`), srtText(CAP_SECS, "he"));
    for (let c = 1; c <= CAP_COPIES; c++) {
      const name = `${m.name}${c > 1 ? ` ${c}` : ""} (${m.year})`;
      const d = path.join(movies, name);
      fs.mkdirSync(d, { recursive: true });
      for (const [from, to] of [[out, `${name}.${m.ext}`], [path.join(masters, `${m.key}.en.srt`), `${name}.English.srt`], [path.join(masters, `${m.key}.he.srt`), `${name}.Hebrew.srt`]]) {
        try { fs.linkSync(from, path.join(d, to)); } catch { fs.copyFileSync(from, path.join(d, to)); }
      }
    }
  }
  const small = path.join(dir, "small.mp4");
  const e3 = ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=20", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=20", "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", small]);
  if (e3) throw new Error(`ffmpeg: ${e3}`);
  const W1 = ["Silent", "Broken", "Golden", "Last", "Hidden", "Crimson", "Electric", "Paper", "Midnight", "Northern", "Hollow", "Burning", "Quiet", "Wild", "Glass"];
  const W2 = ["River", "Empire", "Garden", "Signal", "Harbor", "Kingdom", "Mirror", "Orchard", "Station", "Voyage", "Shadow", "Promise", "Engine", "Theory", "Summer", "Witness", "Machine", "Canyon", "Lantern", "Parade"];
  for (let i = 0; i < films; i++) {
    const name = `${W1[i % W1.length]} ${W2[Math.floor(i / W1.length) % W2.length]} ${Math.floor(i / 300) || ""}`.trim() + ` (${1975 + (i % 50)})`;
    const d = path.join(movies, name);
    fs.mkdirSync(d, { recursive: true });
    try { fs.linkSync(small, path.join(d, `${name}.mp4`)); } catch { fs.copyFileSync(small, path.join(d, `${name}.mp4`)); }
  }
  for (let s = 0; s < 10; s++) {
    const sd = path.join(shows, `Lt Show ${s + 1}`, "Season 1");
    fs.mkdirSync(sd, { recursive: true });
    for (let e = 1; e <= 8; e++) { const f = path.join(sd, `Lt Show ${s + 1} S01E0${e}.mp4`); try { fs.linkSync(small, f); } catch { fs.copyFileSync(small, f); } }
  }
  fs.writeFileSync(path.join(dir, ".ready"), new Date().toISOString());
  return { movies, shows, dir };
};

const harvest = (data, to) => {
  if (!fs.existsSync(path.join(data, "metadata-cache.json"))) return;
  removeDir(to);
  fs.mkdirSync(path.join(to, "cache"), { recursive: true });
  for (const f of SAFE_FILES) { const p = path.join(data, f); if (fs.existsSync(p)) fs.copyFileSync(p, path.join(to, f)); }
  for (const f of SAFE_CACHE_FILES) { const p = path.join(data, "cache", f); if (fs.existsSync(p)) fs.copyFileSync(p, path.join(to, "cache", f)); }
  for (const d of SAFE_CACHE_DIRS) { const p = path.join(data, "cache", d); if (fs.existsSync(p)) fs.cpSync(p, path.join(to, "cache", d), { recursive: true }); }
  fs.writeFileSync(path.join(to, ".ready"), new Date().toISOString());
};

// ---------- machine profiles ----------
// The server on a smaller box, emulated on this one: fewer CPUs (affinity on
// the server and, inherited, every ffmpeg it starts; two logical CPUs that are
// two different cores, as Hyper-Threading pairs 0/1, 2/3 …), a small V8 heap,
// and a hard cap on the server's RAM (Windows: a hard working-set limit —
// the process pages instead of growing; Linux: run under a cgroup is left to
// the caller, the heap cap applies). Clock speed is not emulated: per-core
// figures here are this CPU's (see LOADTEST.md for the scaling).
//   full | 4core | 2core | lowmem | small (= 2core + lowmem) — comma-combinable
const MACHINES = {
  full: {},
  "4core": { cpus: [0, 2, 4, 6] },
  "2core": { cpus: [0, 2] },
  // a root server's eight dedicated cores (nufurora.com: netcup, 8 cores, no GPU)
  "8core": { cpus: [0, 2, 4, 6, 8, 10, 12, 14] },
  // a 4 GB box where the server gets ~300 MB; "starved": less than its working set, it pages
  lowmem: { heapMb: 256, wsMb: 320 },
  starved: { heapMb: 192, wsMb: 140 },
  small: { cpus: [0, 2], heapMb: 256, wsMb: 320 },
  nogpu: { env: { AURORA_HWACCEL: "off", AURORA_GPU: "off" } },
};
const machineProfile = (spec) => {
  const out = { name: spec || "full", cpus: null, heapMb: null, wsMb: null, env: {} };
  for (const k of String(spec || "full").split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = MACHINES[k];
    if (!m) throw new Error(`unknown machine profile ${k} (${Object.keys(MACHINES).join(", ")})`);
    if (m.cpus) out.cpus = m.cpus;
    if (m.heapMb) out.heapMb = m.heapMb;
    if (m.wsMb) out.wsMb = m.wsMb;
    Object.assign(out.env, m.env || {});
  }
  if (out.cpus) { out.mask = out.cpus.reduce((a, c) => a | (1 << c), 0); out.cpuList = out.cpus.join(","); }
  return out;
};
const applyMachine = (pid, mp) => {
  const done = {};
  if (process.platform !== "win32") { if (mp.cpuList) done.affinity = `taskset -c ${mp.cpuList}`; return done; }
  const ps = [];
  if (mp.mask) ps.push(`(Get-Process -Id ${pid}).ProcessorAffinity = ${mp.mask}`);
  if (mp.wsMb) {
    // SetProcessWorkingSetSizeEx(h, min, max, QUOTA_LIMITS_HARDWS_MIN_DISABLE | QUOTA_LIMITS_HARDWS_MAX_ENABLE)
    ps.push(`Add-Type -Namespace LT -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool SetProcessWorkingSetSizeEx(IntPtr h, IntPtr mn, IntPtr mx, int f);'`);
    ps.push(`$p = Get-Process -Id ${pid}; if (-not [LT.K]::SetProcessWorkingSetSizeEx($p.Handle, [IntPtr]${16 * 1048576}, [IntPtr]${mp.wsMb * 1048576}, 6)) { throw 'SetProcessWorkingSetSizeEx failed' }`);
  }
  if (!ps.length) return done;
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", ps.join("; ")], { stdio: "pipe", windowsHide: true });
    if (mp.mask) done.affinity = `mask ${mp.mask} (CPUs ${mp.cpuList})`;
    if (mp.wsMb) done.workingSetMaxMb = mp.wsMb;
  } catch (e) { done.error = String(e.stderr || e.message).slice(0, 300); }
  return done;
};

// ---------- start ----------
const live = new Set();
let hooked = false;
const hook = () => {
  if (hooked) return;
  hooked = true;
  const all = () => { for (const i of [...live]) i.stopSync(); };
  process.on("exit", all);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => { all(); process.exit(130); });
};
// instance folders left by a run that was killed before it could clean up
const sweep = () => {
  for (const e of fs.readdirSync(WORK)) {
    if (!e.startsWith("deps-")) continue;
    const d = path.join(WORK, e);
    for (const i of fs.readdirSync(d)) {
      if (!i.startsWith("i-")) continue;
      const root = path.join(d, i);
      let owner = 0;
      try { owner = Number(fs.readFileSync(path.join(root, ".owner-pid"), "utf8")); } catch {}
      let alive = false;
      try { process.kill(owner, 0); alive = true; } catch (er) { alive = er.code === "EPERM"; }
      if (!alive) removeDir(root);
    }
  }
};

// opts:
//   ref        git ref / sha, or a directory (default HEAD of this worktree)
//   profiles   number of synthetic profiles (default 8)
//   media      "real" (default: the live config's libraries, read only) | "gen" | "cap" (house-shaped, capacity.js)
//   config     extra config.json keys      env  extra environment
//   nodeArgs   extra node flags            verbose  echo the server's output
//   refreshSeed  copy the live caches again
//   keep       keep the instance folder after stop (for a look at data/)
const start = async (opts = {}) => {
  hook();
  sweep();
  const log = opts.log || ((s) => process.stderr.write(s + "\n"));
  const r = resolveRef(opts.ref);
  const code = codeFor(r);
  const deps = depsFor(code.dir, log);
  const id = `i-${(code.head || "dir").slice(0, 8)}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  const root = path.join(deps, id);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ".owner-pid"), String(process.pid));
  const inst = { root, child: null, stopped: false };
  live.add(inst);
  inst.stopSync = () => {
    if (inst.stopped) return;
    inst.stopped = true;
    live.delete(inst);
    killTree(inst.child);
    // generated media: the first instance's probes, intros, subtitle languages and
    // pictures become the seed of the next ones (a settled library, as with "real")
    if (inst.harvest) { try { harvest(path.join(root, "data"), inst.harvest); } catch {} }
    if (!opts.keep) removeDir(root);
  };
  try {
    for (const e of fs.readdirSync(code.dir)) {
      if (e === ".ready" || e === "tools" || e === "package-lock.json") continue;
      fs.cpSync(path.join(code.dir, e), path.join(root, e === "server.js" ? "ui-instance.js" : e), { recursive: true, filter: (s) => !/\.apk$/i.test(s) });
    }
    // the network fence; `network: true` (torrent viewers) replaces it with the orphan guard alone
    if (opts.network) fs.writeFileSync(path.join(root, "lt-fence.js"), fs.readFileSync(FENCE, "utf8").replace(/const realConnect[\s\S]*?(?=const parent = )/, "// (network fence lifted for torrent viewers: tools/loadtest --torrent)" + String.fromCharCode(10)));
    else fs.copyFileSync(FENCE, path.join(root, "lt-fence.js"));
    fs.copyFileSync(path.join(HERE, "probe.js"), path.join(root, "lt-probe.js"));

    const media = opts.media || "real";
    let libraries, prodKeys = {};
    if (media === "gen") { const g = genMedia({ log }); libraries = { movies: [g.movies], shows: [g.shows] }; }
    else if (media === "cap") { const g = genMediaCap({ log }); libraries = { movies: [g.movies], shows: [g.shows] }; }
    else if (path.isAbsolute(media)) libraries = { movies: [path.join(media, "movies")], shows: [path.join(media, "shows")] }; // a library folder of one's own (WSL)
    else { const l = liveLibraries(); libraries = l.libraries; prodKeys = { scanIntervalMinutes: l.scanIntervalMinutes, autoOcrSubtitles: l.autoOcrSubtitles }; }

    const data = path.join(root, "data");
    fs.mkdirSync(path.join(data, "cache"), { recursive: true });
    const genSeed = media === "gen" ? path.join(WORK, "seed-gen-v1") : media === "cap" ? path.join(WORK, `seed-cap-v${CAP_VERSION}`) : path.join(WORK, `seed-dir-${crypto.createHash("md5").update(String(media)).digest("hex").slice(0, 8)}`);
    if (media !== "real" && !fs.existsSync(path.join(genSeed, ".ready"))) inst.harvest = genSeed;
    if (media === "real" || (media !== "real" && !inst.harvest)) {
      const seed = media === "real" ? realSeed({ refresh: opts.refreshSeed, log }) : genSeed;
      for (const e of fs.readdirSync(seed, { withFileTypes: true })) if (e.isFile() && e.name !== ".ready") fs.copyFileSync(path.join(seed, e.name), path.join(data, e.name));
      for (const e of fs.readdirSync(path.join(seed, "cache"), { withFileTypes: true })) {
        const a = path.join(seed, "cache", e.name), b = path.join(data, "cache", e.name);
        if (e.isDirectory()) linkTree(a, b); else fs.copyFileSync(a, b);
      }
    }
    const hh = household(opts.profiles || 8);
    fs.writeFileSync(path.join(data, "profiles.json"), JSON.stringify(hh.profiles));
    fs.writeFileSync(path.join(data, "sessions.json"), JSON.stringify(hh.sessions));
    fs.writeFileSync(path.join(data, "settings.json"), JSON.stringify({ authMode: "closed", myListAutoDelete: false }));
    // the daily round (skip databases, metadata, backup, My List…) is network
    // work or library work: never due during a run
    const never = 4102444800000;
    fs.writeFileSync(path.join(data, "daily.json"), JSON.stringify(Object.fromEntries(["skip-timestamps", "library-metadata", "backup", "backup-drill", "my-list-downloads", "recommendations"].map((k) => [k, { at: never }]))));
    fs.writeFileSync(path.join(data, "downloads.json"), "[]");
    for (const [rel, value] of Object.entries(opts.seed || {})) fs.writeFileSync(path.join(data, rel), typeof value === "string" ? value : JSON.stringify(value));
    fs.mkdirSync(path.join(root, "tmp"), { recursive: true });

    const port = await freePort();
    const probePort = await freePort();
    const adminPassword = `lt-${crypto.randomBytes(9).toString("hex")}`;
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
      port, adminName: "Load Admin", adminPassword, libraries,
      autoOcrSubtitles: false, // needs python + tesseract; would write nothing the household has
      ...Object.fromEntries(Object.entries(prodKeys).filter(([k, v]) => v != null && k !== "autoOcrSubtitles")),
      authMode: "closed",
      aria2Port: await freePort(),
      // What keeps the library folders untouched (see README "Safety"): no
      // downloads (they land in the library, and smart clean-up deletes
      // watched episodes), no OCR (it writes .srt next to videos), no
      // play-ready copies. Backups and the healer's repairs stay off too.
      torrents: !!opts.torrents,
      preconvert: false,
      backups: false,
      healer: { autoRepair: false },
      notifications: {},
      ...(opts.config || {}),
    }, null, 2));

    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(TMDB_|OPENROUTER_|GOOGLE_|AURORA_|VAPID_|TELEGRAM_|NTFY_|pm_|PM2_)/i.test(k) || k === "NODE_OPTIONS" || k === "NODE_TEST_CONTEXT" || k === "NODE_PATH") delete env[k];
    Object.assign(env, { AURORA_UI_PARENT_PID: String(process.pid), LT_PROBE_PORT: String(probePort), TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TMPDIR: path.join(root, "tmp"), ...(opts.env || {}) });
    const mp = machineProfile(opts.machine);
    Object.assign(env, mp.env);
    const args = ["--expose-gc", ...(mp.heapMb ? [`--max-old-space-size=${mp.heapMb}`] : []), ...(opts.nodeArgs || []), "-r", "./lt-fence.js", "-r", "./lt-probe.js", "ui-instance.js"];
    const logLines = [];
    const nodeBin = opts.nodeBin || process.execPath;
    // Linux: taskset from the first instruction; Windows: the affinity is set on the
    // process right after it starts (before it has started any ffmpeg/ffprobe), and
    // every child it starts inherits it
    const [cmd, cmdArgs] = mp.cpuList && process.platform !== "win32" ? ["taskset", ["-c", mp.cpuList, nodeBin, ...args]] : [nodeBin, args];
    const child = spawn(cmd, cmdArgs, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    inst.child = child;
    const applied = applyMachine(child.pid, mp);
    const keep = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line) logLines.push(line);
      if (logLines.length > 5000) logLines.splice(0, logLines.length - 5000);
      if (opts.verbose) process.stdout.write(chunk);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let exited = null;
    child.on("exit", (c, s) => { exited = { code: c, signal: s, at: Date.now() }; if (!inst.stopped) keep(`[lt] THE SERVER EXITED BY ITSELF (code ${c}, signal ${s})`); });

    const url = `http://127.0.0.1:${port}`;
    const probeUrl = `http://127.0.0.1:${probePort}`;
    const t0 = Date.now();
    const deadline = t0 + (opts.bootTimeoutMs || 180000);
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the instance exited (${child.exitCode}) before it was up:\n${logLines.slice(-30).join("\n")}`);
      if (Date.now() > deadline) throw new Error(`the instance did not come up:\n${logLines.slice(-30).join("\n")}`);
      try { const res = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(3000) }); if (res.status === 200) break; } catch {}
      await sleep(100);
    }
    const upMs = Date.now() - t0;
    const probe = async (p) => (await fetch(probeUrl + p, { signal: AbortSignal.timeout(90000) })).json();
    return {
      machine: { ...mp, applied }, url, port, root, dataDir: data, pid: child.pid, ref: r.label, head: code.head, dirty: code.dirty, media, libraries, upMs,
      sessions: hh.handed, adminPassword,
      log: () => logLines.slice(), exited: () => exited,
      snap: (reset = false) => probe(`/snap${reset ? "?reset=1" : ""}`), reset: () => probe("/reset"), gc: () => probe("/gc"),
      stop: async () => inst.stopSync(),
    };
  } catch (err) {
    inst.stopSync();
    throw err;
  }
};

// The data folder's size and file count (what the run made it write).
const dirSize = (dir) => {
  let bytes = 0, files = 0;
  const by = {};
  const walk = (d, key) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      // key: the top-level entry of data/, or cache/<entry>
      const k = key || (e.name === "cache" && e.isDirectory() ? null : e.name);
      if (e.isDirectory()) { walk(p, k || (key === undefined ? null : key)); continue; }
      let s = 0; try { s = fs.statSync(p).size; } catch {}
      bytes += s; files++;
      by[k || e.name] = (by[k || e.name] || 0) + s;
    }
  };
  // data/<x> and data/cache/<y>
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name === "cache") {
      for (const c of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, c.name);
        if (c.isDirectory()) walk(q, `cache/${c.name}`);
        else { let s = 0; try { s = fs.statSync(q).size; } catch {} bytes += s; files++; by[`cache/${c.name}`] = s; }
      }
    } else if (e.isDirectory()) walk(p, e.name);
    else { let s = 0; try { s = fs.statSync(p).size; } catch {} bytes += s; files++; by[e.name] = s; }
  }
  return { bytes, files, by };
};

module.exports = { start, dirSize, resolveRef, household, removeDir, genMedia, genMediaCap, CAP_MASTERS, machineProfile, MACHINES, LIVE_DATA };

if (require.main === module) {
  const { parseArgs } = require("./lib");
  const a = parseArgs();
  start({ ref: a.ref, profiles: Number(a.profiles) || 8, media: a.media, verbose: !!a.verbose, refreshSeed: !!a["refresh-seed"] })
    .then((srv) => {
      console.log(`\n  Private Aurora instance (load harness)\n\n    ref      ${srv.ref}${srv.dirty ? " (uncommitted changes)" : ""}\n    App      ${srv.url}\n    pid      ${srv.pid}\n    media    ${srv.media}: ${JSON.stringify(srv.libraries)}\n    session  X-Session for profile ${srv.sessions[0].profileId}: in ${srv.root} (sessions are synthetic)\n    up in    ${srv.upMs} ms\n\n  CTRL-C stops it and removes the folder.\n`);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
