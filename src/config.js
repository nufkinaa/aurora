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

// Resolve a binary to a full path. spawn() does not use a shell, so PATH shims
// that satisfy execSync can fail there — always use full paths. Cross-platform:
// `where` on Windows, `command -v` on macOS/Linux (ffmpeg from apt/brew lives
// on PATH with no .exe suffix, so the old Windows-only `where NAME.exe` found
// nothing there → "ffmpeg MISSING" despite it being installed).
const isWindows = process.platform === "win32";
const resolveExe = (name) => {
  try {
    if (isWindows) {
      return execSync(`where ${name}.exe`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.toLowerCase().endsWith(".exe"));
    }
    // POSIX: command -v prints the resolved path (or nothing) for the first
    // match on PATH; run it through the shell since it's a shell builtin.
    return execSync(`command -v ${name}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: "/bin/sh",
    }).trim() || null;
  } catch {
    return null;
  }
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
  // Join the recommended source's swarm the moment its sources list opens, so
  // pressing Play lands on a warm torrent. "prewarmStreams": false disables.
  PREWARM: userConfig.prewarmStreams !== false,
  // Download requests start on their own; an admin is only asked when the
  // library volume would be left with less than this much free space (percent).
  // Override with "downloadMinFreePercent" in config.json (0 = always start).
  DOWNLOAD_MIN_FREE_PERCENT:
    typeof userConfig.downloadMinFreePercent === "number" ? userConfig.downloadMinFreePercent : 10,
  NOTIFICATIONS: userConfig.notifications || {},
  // Sign-in rollout switch (prompt 10). THE escape hatch: one config line +
  // restart moves between modes, in either direction.
  //   "open"     — today's behavior, no accounts anywhere (default)
  //   "hybrid"   — accounts exist; pre-session /api/profiles returns [] (the
  //                wall is hidden) but legacy profile-token flows and old TV
  //                builds keep working end-to-end
  //   "required" — every profile-parameterized read needs a session that
  //                owns the profile; flip only after the TV ships a login
  AUTH_MODE: ["open", "hybrid", "required"].includes(userConfig.authMode)
    ? userConfig.authMode
    : "open",
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
