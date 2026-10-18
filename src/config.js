// Central configuration: config.json + resolved tool paths + data dirs.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const CACHE_DIR = path.join(DATA_DIR, "cache");

for (const dir of [DATA_DIR, CACHE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Secrets live in .env (gitignored), loaded here so nothing sensitive ever
// needs to be committed. Plain KEY=VALUE lines, # comments; real environment
// variables always win over the file.
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^(["'])(.*)\1$/, "$2");
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
} catch {} // no .env is fine — everything it carries is optional

let userConfig = {};
try {
  userConfig = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf-8"));
} catch (err) {
  console.warn("config.json missing or invalid, using defaults:", err.message);
}
// Every key checked (lib/configcheck.js): an unknown one is a warning, a bad
// value is refused — taken out here, so its default applies — with a line
// that says which, why and what the default is. Never a crash.
try {
  const configcheck = require("./lib/configcheck");
  configcheck.remember(configcheck.check(userConfig, { apply: true }));
} catch (e) {
  console.warn("[config] the settings could not be checked:", e && e.message);
}

// Resolve a binary to a full path. spawn() does not use a shell, so PATH shims
// that satisfy execSync can fail there — always use full paths. Cross-platform:
// `where` on Windows, `command -v` on macOS/Linux (ffmpeg from apt/brew lives
// on PATH with no .exe suffix, so the old Windows-only `where NAME.exe` found
// nothing there → "ffmpeg MISSING" despite it being installed).
//
// All of them are found by ONE child process (lib/whichtools.js): the same
// `where` / `command -v`, asked once for every program instead of once each.
// Every question was a blocking process start before the server listened —
// 0.8-1.1 s together on a two-core box (docs/qa/backend-efficiency).
const isWindows = process.platform === "win32";
const TOOLS = ["ffmpeg", "ffprobe", "tesseract", "aria2c", "python", "python3"];
let located = null;
const resolveExe = (name) => {
  const whichtools = require("./lib/whichtools");
  if (!TOOLS.includes(name)) return whichtools.locate([name])[name] || null;
  if (!located) located = whichtools.locate(TOOLS);
  return located[name] || null;
};

const FFMPEG = resolveExe("ffmpeg");
const FFPROBE = resolveExe("ffprobe");

const TESSERACT =
  resolveExe("tesseract") ||
  (isWindows && fs.existsSync("C:\\Program Files\\Tesseract-OCR\\tesseract.exe")
    ? "C:\\Program Files\\Tesseract-OCR\\tesseract.exe"
    : null);

// aria2c drives download-to-library (streaming stays on WebTorrent). It is a
// purpose-built torrent client, so it answers the two questions our own engine
// never could reliably: exactly how many bytes of THIS file are on disk, and
// whether it is finished. Resolved from PATH, from winget's package directory
// (winget only updates PATH for new shells, and the server is usually already
// running when it's installed), or from an explicit "aria2Path" in config.json.
const ARIA2 = (() => {
  if (userConfig.aria2Path && fs.existsSync(userConfig.aria2Path)) return userConfig.aria2Path;
  const onPath = resolveExe("aria2c");
  if (onPath) return onPath;
  if (!isWindows) return null;
  const candidates = [];
  const wingetPackages = path.join(
    process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  try {
    for (const dir of fs.readdirSync(wingetPackages)) {
      if (!/^aria2\./i.test(dir)) continue;
      const pkg = path.join(wingetPackages, dir);
      for (const sub of fs.readdirSync(pkg)) {
        candidates.push(path.join(pkg, sub, "aria2c.exe"));
      }
    }
  } catch {}
  candidates.push("C:\\Program Files\\aria2\\aria2c.exe");
  return candidates.find((p) => fs.existsSync(p)) || null;
})();

const PYTHON = (() => {
  // `python` is often absent on Linux (only `python3` exists); try both.
  const p = resolveExe("python") || resolveExe("python3");
  if (!p) return null;
  try {
    const v = execSync(`"${p}" --version 2>&1`, { encoding: "utf-8", shell: isWindows ? undefined : "/bin/sh" });
    return /Python 3/.test(v) ? p : null;
  } catch {
    return null;
  }
})();

module.exports = {
  ROOT,
  DATA_DIR,
  CACHE_DIR,
  PORT: userConfig.port || 4000,
  LIBRARIES: {
    movies: (userConfig.libraries && userConfig.libraries.movies) || [],
    shows: (userConfig.libraries && userConfig.libraries.shows) || [],
  },
  SCAN_INTERVAL_MS: (userConfig.scanIntervalMinutes || 10) * 60 * 1000,
  AUTO_OCR: userConfig.autoOcrSubtitles !== false,
  ONLINE_METADATA: userConfig.onlineMetadata !== false,
  // Intro / recap / credits timestamps from the public databases (SkipDB,
  // TheIntroDB) where Aurora's own detector has nothing — see
  // media/skipsegments.js. Only IMDb id + season + episode + runtime leave
  // the server. `"skipDatabases": false` turns it off.
  SKIP_DATABASES: userConfig.skipDatabases !== false,
  TMDB_KEY: process.env.TMDB_API_KEY || userConfig.tmdbApiKey || null,
  // Admin panel password. No default: unset means the admin panel (and every
  // admin API/WS surface) stays locked for everyone until one is configured.
  ADMIN_PASSWORD: process.env.AURORA_ADMIN_PASSWORD || userConfig.adminPassword || null,
  // What the UI calls whoever runs this server ("Ask <name> to approve you").
  ADMIN_NAME: userConfig.adminName || "the admin",
  // AI recommender (OpenRouter). Absent key = the whole feature stays dark:
  // the route reports it off and the client never shows the tab, so it cannot
  // affect anything until it's deliberately switched on. Env var wins so the
  // key doesn't have to live in a file that gets shared around.
  OPENROUTER_KEY: process.env.OPENROUTER_API_KEY || userConfig.openrouterApiKey || null,
  // Small + cheap on purpose: this job is "name some titles for a mood", which
  // does not need a frontier model. But it does need taste and it does need to
  // obey a constraint. Measured on this server, same 14-item prompt, timed to
  // the last byte of the body (not to headers — that mistake made the first
  // round of these numbers look ten times too good):
  //   meta-llama/llama-3.3-70b-instruct         22-36s   too slow, very variable
  //   openai/gpt-4.1-mini                        13.1s   good picks, 1/14 broke the era rule
  //   mistralai/mistral-small-24b-instruct-2501    ~9s   rambling reasons, a show in a films-only
  //                                                      list, one `why` of literal "undefined"
  //   google/gemini-2.5-flash-lite                4.3s   fast and useless: 14/14 broke the era rule
  //   google/gemini-2.5-flash                     4.4s   0/14 broke it, sharpest picks of the lot
  // Flash wins on speed AND quality, at roughly half a cent per search. Override
  // with "aiModel" in config.json.
  AI_MODEL: userConfig.aiModel || "google/gemini-2.5-flash",
  TORRENTS: userConfig.torrents !== false,
  // These two were documented and read by their modules but never exported,
  // so the settings did nothing (found 2026-10-08). "preconvert": false stops
  // play-ready copies being made after a download; "offlineCacheGb" caps the
  // disk the phone-download copies may use (default 8).
  preconvert: userConfig.preconvert !== false,
  offlineCacheGb: userConfig.offlineCacheGb,
  // Who a push service may contact about this server: "mailto:you@example.com"
  // or an https URL. Apple is strict about it; see lib/push.js.
  PUSH_CONTACT: process.env.AURORA_PUSH_CONTACT || userConfig.pushContact || null,
  // Join the recommended source's swarm the moment its sources list opens, so
  // pressing Play lands on a warm torrent. "prewarmStreams": false disables.
  PREWARM: userConfig.prewarmStreams !== false,
  // Download requests start on their own; an admin is only asked when the
  // library volume would be left with less than this much free space (percent).
  // Override with "downloadMinFreePercent" in config.json (0 = always start).
  DOWNLOAD_MIN_FREE_PERCENT:
    typeof userConfig.downloadMinFreePercent === "number" ? userConfig.downloadMinFreePercent : 10,
  // The second-source race for slow downloads (media/dlrace.js): unset = on
  // with its defaults, false = off, an object overrides individual thresholds
  // (the names are dlrace.DEFAULTS'). Passed through as written; dlrace's
  // resolveConfig() is what reads it.
  DOWNLOAD_RACE: userConfig.downloadRace,
  NOTIFICATIONS: userConfig.notifications || {},
  // ---- backups (lib/backup.js) ----
  // Where the daily snapshot of the household's state is written. The default
  // sits beside the data it protects, which guards against a corrupt file or
  // a mistake but NOT against losing the disk — point "backupDir" (or
  // AURORA_BACKUP_DIR) at another drive, a NAS share or a synced folder for
  // that. `"backups": false` switches the daily snapshot off.
  BACKUP_DIR: path.resolve(ROOT, process.env.AURORA_BACKUP_DIR || userConfig.backupDir || path.join(DATA_DIR, "backups")),
  // A SECOND place every snapshot is copied to (and verified in): another
  // drive, a NAS share, a synced folder. With the default backup folder
  // beside the data, this is what survives the disk. "backupMirrorDir" in
  // config.json, or AURORA_BACKUP_MIRROR_DIR. Unset = no second copy.
  BACKUP_MIRROR_DIR: (process.env.AURORA_BACKUP_MIRROR_DIR || userConfig.backupMirrorDir)
    ? path.resolve(ROOT, process.env.AURORA_BACKUP_MIRROR_DIR || userConfig.backupMirrorDir)
    : null,
  BACKUPS: userConfig.backups !== false,
  // How many snapshots are kept: { "daily": 7, "weekly": 4, "monthly": 3 }.
  BACKUP_KEEP: userConfig.backupKeep && typeof userConfig.backupKeep === "object" ? userConfig.backupKeep : {},
  // ---- health alerts (lib/health.js) ----
  // Thresholds, all optional: { "diskWarnPercent": 10, "diskWarnGb": 20,
  // "diskCriticalPercent": 5, "diskCriticalGb": 5, "backupMaxAgeHours": 48,
  // "repeatHours": 12 }. `"health": false` switches the alerts off.
  HEALTH: userConfig.health === false ? false : (userConfig.health && typeof userConfig.health === "object" ? userConfig.health : {}),
  // ---- the healer (lib/healer.js) ----
  // { "autoRepair": false }   checks still run, nothing is repaired by itself
  // { "off": ["backup-now"] } single automatic repairs switched off, by name
  //                            (sweep-streams, patch-webtorrent, rescan,
  //                            backup-now, jit-forget-changed)
  // { "ai": true }            with an OpenRouter key set: a never-seen error
  //                            may be explained by the model, once, in two
  //                            sentences (advice only; default off)
  HEALER: userConfig.healer && typeof userConfig.healer === "object" ? userConfig.healer : {},
  // Dead-man's switch: a URL fetched every five minutes while the server is
  // alive (healthchecks.io and the like alert when the pings STOP).
  HEALTH_PING_URL: process.env.AURORA_HEALTH_PING_URL || userConfig.healthPingUrl || null,
  // Extra Web Push hosts allowed beyond the built-in browser push services
  // (lib/push.js): ["push.example.com", "*.push.example.net"].
  PUSH_HOSTS: Array.isArray(userConfig.pushHosts) ? userConfig.pushHosts : [],
  // Sign-in rollout FALLBACK (prompt 10). The live value is managed from the
  // admin panel and stored in data/settings.json — see src/lib/authmode.js.
  // This config value only applies when settings carry no authMode (fresh
  // data dir, or recovery after deleting settings.json). Legacy names
  // "hybrid"/"required" are accepted and read as transition/closed.
  AUTH_MODE: ["open", "transition", "closed", "hybrid", "required"].includes(userConfig.authMode)
    ? userConfig.authMode
    : "open",
  // An MP4 whose index is at the end of the file is served with it in front
  // (media/faststart.js — nothing on disk changes). "serveFaststart": false
  // serves every file byte for byte as it is.
  SERVE_FASTSTART: userConfig.serveFaststart !== false,
  // The TV player's start-up tuning, handed to the app as it is asked for
  // (lib/tvtuning.js — checked there). Nothing set: the app's own values.
  TV_PLAYER: userConfig.tvPlayer || null,
  // The TV's rendering switches (native components, render fixes), per TV
  // model if wanted (lib/tvtuning.js — checked there). Nothing set: all off.
  TV_RENDER: userConfig.tvRender || null,
  // ---- staying healthy (srv-resilience) ----
  // Per-client rate limits on the public endpoints that cost something
  // (lib/ratelimit.js): "log" (default: count what would be refused, refuse
  // nothing), "enforce", "off", or { "mode", "groups": { name: { rate, burst, mode } } }.
  RATE_LIMITS: userConfig.rateLimits,
  // Outside providers (lib/upstream.js): per-host overrides,
  // { "hosts": { "api.themoviedb.org": { "concurrency": 4, "timeoutMs": 8000 } } }.
  UPSTREAM: userConfig.upstream && typeof userConfig.upstream === "object" ? userConfig.upstream : {},
  // The HTTP server's own limits (lib/httplimits.js):
  // { "headersTimeoutSec": 20, "requestTimeoutSec": 120, "keepAliveTimeoutSec": 75 }.
  HTTP: userConfig.http && typeof userConfig.http === "object" ? userConfig.http : {},
  // The reverse proxies whose X-Forwarded-For is believed (lib/ratelimit.js),
  // beyond this machine itself: ["172.17.0.1", "10.0.0.0/8"].
  TRUST_PROXY: Array.isArray(userConfig.trustProxy) ? userConfig.trustProxy : [],
  // WebSocket limits (realtime.js): { "maxPerAddress": 64, "maxMessageKb": 64, "mode" } (64 sockets an address, LAN addresses 4x; the mode follows "rateLimits").
  WS: userConfig.ws && typeof userConfig.ws === "object" ? userConfig.ws : {},
  FFMPEG,
  FFPROBE,
  TESSERACT,
  PYTHON,
  ARIA2,
  aria2Available: !!ARIA2,
  // RPC port for our own aria2c instance. Only bound on localhost.
  ARIA2_PORT: userConfig.aria2Port || 6801,
  ffmpegAvailable: !!(FFMPEG && FFPROBE),
  ocrAvailable: !!(FFMPEG && FFPROBE && TESSERACT && PYTHON),
  VIDEO_EXTENSIONS: [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v"],
  SUBTITLE_EXTENSIONS: [".srt", ".vtt"],
  IMAGE_EXTENSIONS: [".jpg", ".jpeg", ".png", ".webp"],
  EXTRA_EXTENSIONS: [".apk"],
};
