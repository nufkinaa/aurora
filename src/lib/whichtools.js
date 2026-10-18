// Where the helper programs live (ffmpeg, ffprobe, tesseract, aria2c, python):
// the full path of each, the way config.js has always asked for it — `where
// NAME.exe` on Windows, `command -v NAME` everywhere else — but asked ONCE for
// all of them instead of once per program.
//
// Why: each question is a blocking child process at boot, before the server
// listens. Five of them cost 0.8-1.1 s of a 5 s boot on a two-core box
// (measured, docs/qa/backend-efficiency: `where` goes through cmd.exe, and
// starting a process on Windows is tens of milliseconds each). One process
// answers the same five questions with the same program and the same rules,
// so the answers cannot differ:
//   Windows  `where a.exe b.exe …` prints the matches of each pattern in the
//            order given, PATH order within a pattern; the first line of a
//            pattern is what `where a.exe` alone prints first.
//   POSIX    `command -v` once per name inside one /bin/sh.
const cp = require("child_process");

const isWindows = process.platform === "win32";

// `where` output -> { name: first match | null }. A line belongs to the
// name it ends with ("…\ffmpeg.exe"); lines that are not an .exe path (the
// "INFO: Could not find…" notes go to stderr, but be strict anyway) are skipped.
const parseWhere = (text, names) => {
  const out = Object.fromEntries(names.map((n) => [n, null]));
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const low = line.toLowerCase();
    if (!low.endsWith(".exe")) continue;
    for (const n of names) {
      const tail = `${n.toLowerCase()}.exe`;
      if (out[n] === null && (low === tail || low.endsWith(`\\${tail}`) || low.endsWith(`/${tail}`))) {
        out[n] = line;
        break;
      }
    }
  }
  return out;
};

// "name=path" lines (path empty when the shell found nothing) -> the same map.
const parsePosix = (text, names) => {
  const out = Object.fromEntries(names.map((n) => [n, null]));
  for (const line of String(text || "").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const n = line.slice(0, i);
    if (n in out && out[n] === null) out[n] = line.slice(i + 1).trim() || null;
  }
  return out;
};

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

// Every name in one child process. Never throws: a name that is not found,
// or a lookup that cannot run at all, is null — as resolveExe always answered.
const locate = (names) => {
  const list = [...new Set(names)].filter((n) => SAFE_NAME.test(n));
  const none = Object.fromEntries(names.map((n) => [n, null]));
  if (!list.length) return none;
  try {
    if (isWindows) {
      let text = "";
      try {
        text = cp.execSync(`where ${list.map((n) => `${n}.exe`).join(" ")}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, windowsHide: true });
      } catch (err) {
        // `where` exits 1 when a pattern had no match; what it did find is still on stdout
        text = String((err && err.stdout) || "");
      }
      return { ...none, ...parseWhere(text, list) };
    }
    // command -v is a shell builtin: one shell, one line per name
    const script = `for n in ${list.join(" ")}; do printf '%s=%s\\n' "$n" "$(command -v "$n")"; done`;
    const text = cp.execSync(script, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], shell: "/bin/sh", timeout: 15000 });
    return { ...none, ...parsePosix(text, list) };
  } catch {
    return none;
  }
};

module.exports = { locate, parseWhere, parsePosix };
