#!/usr/bin/env node
// A private, throwaway Aurora instance for the browser tests (test/ui/).
//
//   const { start } = require("../scripts/ui-test-server");
//   const srv = await start();      // { url, port, root, dataDir, library, adminPassword, ... }
//   ...
//   await srv.stop();               // kills the server tree, removes every file
//
//   node scripts/ui-test-server.js  // the same instance by hand, for poking at:
//                                   // prints the address, CTRL-C tears it down
//
// WHY IT LOOKS LIKE THIS. src/config.js resolves everything from the folder
// the code sits in: <root>/config.json, <root>/.env, <root>/data, and
// server.js serves <root>/public and <root>/data/avatars. There is no env var
// or flag for the port, the data dir or the config file. So instead of
// touching the app, the app is given a different <root>:
//
//   <tmp>/aurora-ui-XXXXXX/
//     ui-instance.js                          server.js, copied under another name
//     ui-preload.js                           test/ui/support/server-preload.js, copied
//     package.json, CHANGELOG.md              copied from the repo
//     src/, public/                           copied (a snapshot of the working tree
//                                             as it is right now; the 45 MB TV APK is left out)
//     node_modules                            a junction/symlink to the repo's
//     config.json                             written here: a free port, the library
//                                             below, a made-up admin password, every
//                                             online feature that has a switch turned off
//     data/                                   empty (plus whatever a test seeds)
//     media/movies, media/shows               a tiny library made with ffmpeg
//     tmp/                                    the instance's TEMP, so nothing it
//                                             stages or sweeps is the real server's
//
// Nothing of the owner's is read: not config.json, not .env, not data/. The
// live server on port 4000 is never contacted. On top of that the process is
// started with test/ui/support/server-preload.js, which refuses every
// outbound connection and makes the instance die with its parent.
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn, spawnSync, execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const PRELOAD = path.join(REPO, "test", "ui", "support", "server-preload.js");
const MEDIA_CACHE = path.join(REPO, "test", "ui", ".cache");
const PREFIX = "aurora-ui-";
const ENTRY = "ui-instance.js"; // server.js, under a name that is not the live server's
const LINKS = ["node_modules"]; // links INTO the repo: removed by hand, never followed

// ---------- the library ----------
// Bump when a recipe below changes: the cache is keyed by it.
const MEDIA_VERSION = 4;
const FILM_SECONDS = 60;
const EPISODE_SECONDS = 45;

// The library's titles have made-up IMDb ids, filed where the server keeps
// the ones it has resolved (data/imdb-map.json). With an id a title page
// offers everything it offers for a matched title (X-Ray, Follow); without
// one the server would try to look it up online, which is fenced off.
const IDS = { film1: "tt9000001", film2: "tt9000002", show: "tt9000003", film3: "tt9000004" };
const imdbMapSeed = () => {
  const at = Date.now();
  return {
    "movie|test film one|2020": { imdbId: IDS.film1, at },
    "movie|test film two|2021": { imdbId: IDS.film2, at },
    "movie|test film three|2022": { imdbId: IDS.film3, at },
    "show|test show|": { imdbId: IDS.show, at },
  };
};
// data/cache/certificates.json for a set of age ratings, in the shape
// media/discover.js keeps (v2: `c` the label, `a` the strictest age). This is
// how the kids tests give titles a rating without asking TMDB.
//   certificatesSeed({ film1: 0, film2: 18, show: 7 })
const TITLES = { film1: ["movie", "test film one", 2020], film2: ["movie", "test film two", 2021], film3: ["movie", "test film three", 2022], show: ["show", "test show", null] };
const certificatesSeed = (ages) => {
  const out = {};
  for (const [key, age] of Object.entries(ages)) {
    const [t, n, y] = TITLES[key];
    out[IDS[key]] = { c: age === 0 ? "ALL" : `${age}+`, a: age, t, n, y, at: Date.now(), v: 2 };
  }
  return out;
};

const srt = (tag, seconds) => {
  const t = (s) => `00:00:${String(s).padStart(2, "0")},000`;
  let out = "";
  for (let i = 0, n = 1; i + 2 <= seconds; i += 2, n++) out += `${n}\n${t(i)} --> ${t(i + 2)}\n${tag} cue ${n}\n\n`;
  return out;
};

const findFfmpeg = () => {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  try {
    const win = process.platform === "win32";
    const out = execFileSync(win ? "where" : "which", [win ? "ffmpeg.exe" : "ffmpeg"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
  } catch { return null; }
};

const ff = (ffmpeg, args) => {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf-8", windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}): ${r.stderr || r.error}\n  ffmpeg ${args.join(" ")}`);
};

// H.264 with a keyframe every second (seeks land where they are asked to),
// the test pattern with its running clock burnt in, a tone per audio track.
const video = (seconds, hue = 0, size = "640x360") => [
  "-f", "lavfi", "-i", `testsrc=size=${size}:rate=25:duration=${seconds}${hue ? `,hue=h=${hue}` : ""}`,
];
const tone = (seconds, hz) => ["-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`];
const H264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "25", "-keyint_min", "25", "-sc_threshold", "0"];
const AAC = ["-c:a", "aac", "-b:a", "96k", "-ac", "2"];
// AC-3: sound no desktop browser decodes. A file that carries it cannot be
// played as it is, so the player asks the server to repackage it (hls.js).
const AC3 = ["-c:a", "ac3", "-b:a", "128k", "-ac", "2"];

const mp4 = (ffmpeg, out, seconds, hz, hue, size) =>
  ff(ffmpeg, [...video(seconds, hue, size), ...tone(seconds, hz), ...H264, ...AAC,
    "-metadata:s:a:0", "language=eng", "-movflags", "+faststart", "-shortest", out]);

const cover = (ffmpeg, out, color) =>
  ff(ffmpeg, ["-f", "lavfi", "-i", `color=c=${color}:size=400x600:duration=1`, "-frames:v", "1", "-q:v", "4", out]);

// Everything a test might want, built once into <cache>/media-<recipe>/ and
// copied into each instance. `extras/` holds titles a test adds mid-run.
const buildMedia = (dir, ffmpeg) => {
  const mk = (...p) => { const d = path.join(dir, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const write = (file, text) => fs.writeFileSync(file, text, "utf-8");

  // Film One: MP4 (H.264 + AAC), which the browser plays as the file itself.
  // English and Hebrew subtitles as sidecar files.
  let d = mk("movies", "Test Film One (2020)");
  mp4(ffmpeg, path.join(d, "Test Film One (2020).mp4"), FILM_SECONDS, 440, 0);
  write(path.join(d, "Test Film One (2020).English.srt"), srt("EN", FILM_SECONDS));
  write(path.join(d, "Test Film One (2020).Hebrew.srt"), srt("HE", FILM_SECONDS));
  cover(ffmpeg, path.join(d, "cover.jpg"), "0x8b3a2c");

  // Film Two: MKV, H.264 video, two AC-3 audio tracks (eng, heb) and two
  // embedded text subtitle tracks (eng, heb). Chrome can open MKV and decode
  // the picture, but not AC-3, so this title goes through the server's
  // repackaging ("jit": video copied, audio to AAC) and plays through hls.js:
  // the path seeking, audio switching and stall recovery are tested on.
  d = mk("movies", "Test Film Two (2021)");
  const en = path.join(dir, "en.srt");
  const he = path.join(dir, "he.srt");
  write(en, srt("EN", FILM_SECONDS));
  write(he, srt("HE", FILM_SECONDS));
  ff(ffmpeg, [
    ...video(FILM_SECONDS, 120), ...tone(FILM_SECONDS, 330), ...tone(FILM_SECONDS, 660), "-i", en, "-i", he,
    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:0", "-map", "4:0",
    ...H264, ...AC3, "-c:s", "srt",
    "-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=English",
    "-metadata:s:a:1", "language=heb", "-metadata:s:a:1", "title=Hebrew",
    "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=heb",
    "-disposition:a:0", "default", "-disposition:a:1", "0", "-disposition:s:0", "0", "-disposition:s:1", "0",
    path.join(d, "Test Film Two (2021).mkv"),
  ]);
  fs.rmSync(en); fs.rmSync(he);
  cover(ffmpeg, path.join(d, "cover.jpg"), "0x2c5f8b");

  // Test Show: one season, three short MP4 episodes, sidecar subtitles on
  // each (a subtitle choice has to carry from one episode to the next). A
  // different tone per episode: identical audio would read as one long intro.
  // Episode 3 is 1080p: the show page plays a downloaded episode straight
  // from its card only at 1080p or better (a smaller copy opens its sources).
  d = mk("shows", "Test Show", "Season 1");
  for (let e = 1; e <= 3; e++) {
    const base = `Test Show S01E0${e}`;
    mp4(ffmpeg, path.join(d, `${base}.mp4`), EPISODE_SECONDS, 300 + e * 170, e * 70, e === 3 ? "1920x1080" : undefined);
    write(path.join(d, `${base}.English.srt`), srt(`EN e${e}`, EPISODE_SECONDS));
    write(path.join(d, `${base}.Hebrew.srt`), srt(`HE e${e}`, EPISODE_SECONDS));
  }
  cover(ffmpeg, path.join(dir, "shows", "Test Show", "cover.jpg"), "0x3a7a4c");

  // Added to a running instance by the live-data test.
  d = mk("extras", "movies", "Test Film Three (2022)");
  mp4(ffmpeg, path.join(d, "Test Film Three (2022).mp4"), 12, 520, 200);
};

const mediaDir = () => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg was not found on PATH (or FFMPEG_PATH): the UI tests build their library with it");
  const key = crypto.createHash("md5").update(`${MEDIA_VERSION}|${FILM_SECONDS}|${EPISODE_SECONDS}`).digest("hex").slice(0, 10);
  const dir = path.join(MEDIA_CACHE, `media-${key}`);
  if (fs.existsSync(path.join(dir, ".ready"))) return dir;
  // Built beside the final name and renamed in: two test files starting at
  // once can never see (or copy) half a library.
  const building = `${dir}.building-${process.pid}`;
  fs.rmSync(building, { recursive: true, force: true });
  fs.mkdirSync(building, { recursive: true });
  buildMedia(building, ffmpeg);
  fs.writeFileSync(path.join(building, ".ready"), new Date().toISOString());
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(building, dir);
  } catch {
    fs.rmSync(building, { recursive: true, force: true }); // someone else got there first
  }
  // older recipes
  for (const e of fs.readdirSync(MEDIA_CACHE)) {
    if (e.startsWith("media-") && path.join(MEDIA_CACHE, e) !== dir && !e.includes(".building-")) {
      fs.rmSync(path.join(MEDIA_CACHE, e), { recursive: true, force: true });
    }
  }
  return dir;
};

// ---------- the instance folder ----------
const pidAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Remove an instance folder. The links into the repo go first, by rmdir /
// unlink (neither can ever delete what a link points at), and the recursive
// delete only runs once no link is left in the folder's top level.
const removeRoot = (root) => {
  if (!root || !path.basename(root).startsWith(PREFIX) || !fs.existsSync(root)) return true;
  for (const name of LINKS) {
    const p = path.join(root, name);
    let st = null;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isSymbolicLink()) throw new Error(`${p} is not a link: refusing to delete it`);
    try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); }
  }
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isSymbolicLink()) throw new Error(`unexpected link ${path.join(root, e.name)}: refusing to delete through it`);
  }
  // Windows lets go of a killed process's files a beat late.
  for (let i = 0; i < 40; i++) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    if (!fs.existsSync(root)) return true;
    sleepSync(150);
  }
  return !fs.existsSync(root);
};

// Folders left by a run that was killed before it could clean up.
const sweepStale = () => {
  let swept = 0;
  for (const e of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith(PREFIX)) continue;
    const root = path.join(os.tmpdir(), e.name);
    let owner = 0;
    try { owner = Number(fs.readFileSync(path.join(root, ".owner-pid"), "utf-8")); } catch {}
    if (pidAlive(owner)) continue;
    // (no owner file: only once it is old enough not to be a start in progress)
    if (!owner) { try { if (Date.now() - fs.statSync(root).mtimeMs < 10 * 60 * 1000) continue; } catch { continue; } }
    try { if (removeRoot(root)) swept++; } catch {}
  }
  return swept;
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });

const getJson = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });

const killTree = (child) => {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
};

const live = new Set(); // instances this process started and has not stopped
const stopAllSync = () => { for (const inst of [...live]) inst.stopSync(); };
let hooked = false;
const hookExit = () => {
  if (hooked) return;
  hooked = true;
  process.on("exit", stopAllSync);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    process.on(sig, () => { stopAllSync(); process.exit(130); });
  }
};

// opts:
//   seed            { "relative/path/in/data.json": object | string } written before boot,
//                   on top of the default (the library's IMDb ids, see imdbMapSeed)
//   config          extra keys merged into config.json
//   waitForLibrary  (default true) resolve only once every file has been probed
//   verbose         echo the server's output
const start = async (opts = {}) => {
  hookExit();
  sweepStale();
  const media = mediaDir();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  fs.writeFileSync(path.join(root, ".owner-pid"), String(process.pid));
  const inst = { root, child: null, stopped: false };
  live.add(inst);
  const log = [];
  inst.stopSync = () => {
    if (inst.stopped) return;
    inst.stopped = true;
    live.delete(inst);
    killTree(inst.child);
    try {
      if (!removeRoot(root)) process.stderr.write(`[ui-test] could not remove ${root}\n`);
    } catch (e) { process.stderr.write(`[ui-test] could not remove ${root}: ${e.message}\n`); }
  };

  try {
    for (const f of ["package.json", "CHANGELOG.md"]) {
      if (fs.existsSync(path.join(REPO, f))) fs.copyFileSync(path.join(REPO, f), path.join(root, f));
    }
    // server.js and the preload go in under other names, and the process is
    // started from inside the folder with relative paths, so its command line
    // reads `node -r ./ui-preload.js ui-instance.js`: nothing in it says
    // "server.js" or "aurora". That is deliberate. Restarting the real server
    // by "stop every node whose command line mentions server.js" is a common
    // habit, and it took a private instance down mid-test twice (exit code
    // 0xFFFFFFFF, the mark of PowerShell's Stop-Process) before this.
    fs.copyFileSync(path.join(REPO, "server.js"), path.join(root, ENTRY));
    fs.copyFileSync(PRELOAD, path.join(root, "ui-preload.js"));
    fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
    fs.cpSync(path.join(REPO, "public"), path.join(root, "public"), {
      recursive: true,
      filter: (src) => !/\.apk$/i.test(src),
    });
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");

    const library = { movies: path.join(root, "media", "movies"), shows: path.join(root, "media", "shows") };
    fs.cpSync(path.join(media, "movies"), library.movies, { recursive: true });
    fs.cpSync(path.join(media, "shows"), library.shows, { recursive: true });
    const dataDir = path.join(root, "data");
    fs.mkdirSync(path.join(dataDir, "cache"), { recursive: true });
    fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
    const seed = { "imdb-map.json": imdbMapSeed(), ...(opts.seed || {}) };
    for (const [rel, value] of Object.entries(seed)) {
      if (value == null) continue; // (a test can drop a default seed with null)
      const file = path.join(dataDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf-8");
    }

    const port = await freePort();
    const adminPassword = `ui-test-${crypto.randomBytes(9).toString("hex")}`;
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
      port,
      adminName: "Test Admin",
      adminPassword,
      libraries: { movies: [library.movies], shows: [library.shows] },
      scanIntervalMinutes: 24 * 60, // rescans happen when a test asks for one
      autoOcrSubtitles: false,
      onlineMetadata: false,
      skipDatabases: false,
      prewarmStreams: false,
      authMode: "open",
      aria2Port: await freePort(),
      notifications: {},
      ...(opts.config || {}),
    }, null, 2));

    // The instance's environment: the caller's, minus anything that could
    // carry the owner's secrets or make the app think pm2 is watching it.
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (/^(TMDB_|OPENROUTER_|GOOGLE_|AURORA_|VAPID_|TELEGRAM_|NTFY_|pm_|PM2_)/i.test(k) || k === "NODE_OPTIONS" || k === "NODE_TEST_CONTEXT") delete env[k];
    }
    Object.assign(env, {
      AURORA_UI_PARENT_PID: String(process.pid),
      TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TMPDIR: path.join(root, "tmp"),
    });

    const child = spawn(process.execPath, ["-r", "./ui-preload.js", ENTRY], {
      cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", // its own group, so the tree can be signalled
    });
    inst.child = child;
    const keep = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line) log.push(line);
      if (log.length > 5000) log.splice(0, log.length - 5000);
      if (opts.verbose || process.env.UI_VERBOSE) process.stdout.write(chunk);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    // A server that goes away under a test is the first thing to know about.
    child.on("exit", (code, signal) => {
      if (!inst.stopped) keep(`[ui-test] THE SERVER EXITED BY ITSELF (code ${code}, signal ${signal})`);
    });

    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 40000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the test server exited (${child.exitCode}) before it was up:\n${log.slice(-30).join("\n")}`);
      if (Date.now() > deadline) throw new Error(`the test server did not come up in 40s:\n${log.slice(-30).join("\n")}`);
      try { if ((await getJson(`${url}/api/ping`)).status === 200) break; } catch {}
      await new Promise((r) => setTimeout(r, 120));
    }
    // "Up" for a test means the library is complete: every file probed, so
    // durations, audio tracks and embedded subtitles are all in the answers.
    if (opts.waitForLibrary !== false) {
      for (;;) {
        if (Date.now() > deadline) throw new Error(`the library was not ready in 40s:\n${log.slice(-30).join("\n")}`);
        try {
          const { body } = await getJson(`${url}/api/library`);
          if (body && body.enriched && body.movies.length && body.movies.every((m) => m.duration > 0)) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    return {
      url, port, root, dataDir, library, adminPassword, media,
      extras: path.join(media, "extras"),
      log: () => log.slice(),
      pid: child.pid,
      stop: async () => { inst.stopSync(); },
    };
  } catch (err) {
    inst.stopSync();
    throw err;
  }
};

module.exports = { start, sweepStale, removeRoot, mediaDir, certificatesSeed, IDS, FILM_SECONDS, EPISODE_SECONDS, PREFIX };

if (require.main === module) {
  start({ verbose: process.argv.includes("--verbose") }).then((srv) => {
    console.log(`\n  Private Aurora instance\n\n    App     ${srv.url}\n    Admin   ${srv.url}/admin   password: ${srv.adminPassword}\n    Files   ${srv.root}\n\n  CTRL-C stops it and removes the folder.\n`);
  }).catch((err) => { console.error(err.message); process.exit(1); });
}
