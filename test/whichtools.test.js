// The helper programs are looked up by ONE child process (lib/whichtools.js)
// instead of one per program, with the same question and the same rules —
// so config.js must get the paths it always got.
const { test } = require("node:test");
const assert = require("node:assert");
const cp = require("child_process");
const path = require("path");

const { locate, parseWhere, parsePosix } = require("../src/lib/whichtools");

// what config.js did before, one program at a time (copied from 1.6.92)
const oneAtATime = (name) => {
  try {
    if (process.platform === "win32") {
      return cp.execSync(`where ${name}.exe`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
        .split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith(".exe")) || null;
    }
    return cp.execSync(`command -v ${name}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], shell: "/bin/sh" }).trim() || null;
  } catch {
    return null;
  }
};

test("`where` output: the first match of each program, in PATH order", () => {
  const text = [
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "D:\\old\\FFMPEG.EXE",
    "C:\\ffmpeg\\bin\\ffprobe.exe",
    "C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python310\\python.exe",
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe",
    "",
  ].join("\r\n");
  assert.deepEqual(parseWhere(text, ["ffmpeg", "ffprobe", "tesseract", "aria2c", "python", "python3"]), {
    ffmpeg: "C:\\ffmpeg\\bin\\ffmpeg.exe",
    ffprobe: "C:\\ffmpeg\\bin\\ffprobe.exe",
    tesseract: null,
    aria2c: null,
    python: "C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python310\\python.exe",
    python3: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe",
  });
  // one name is never another's: python3.exe does not answer for python, nor the reverse
  assert.deepEqual(parseWhere("C:\\x\\python3.exe\r\n", ["python", "python3"]), { python: null, python3: "C:\\x\\python3.exe" });
  assert.deepEqual(parseWhere("C:\\x\\micropython.exe\r\nINFO: Could not find \"python.exe\".\r\n", ["python"]), { python: null });
  assert.deepEqual(parseWhere("", ["ffmpeg"]), { ffmpeg: null });
});

test("`command -v` output: a path, or nothing", () => {
  const text = "ffmpeg=/usr/bin/ffmpeg\nffprobe=/usr/bin/ffprobe\ntesseract=\naria2c=\npython=\npython3=/usr/bin/python3\n";
  assert.deepEqual(parsePosix(text, ["ffmpeg", "ffprobe", "tesseract", "aria2c", "python", "python3"]), {
    ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe", tesseract: null, aria2c: null, python: null, python3: "/usr/bin/python3",
  });
  // a path with "=" in it is kept whole; a line for a name nobody asked about is ignored
  assert.deepEqual(parsePosix("ffmpeg=/opt/a=b/ffmpeg\nother=/x\n", ["ffmpeg"]), { ffmpeg: "/opt/a=b/ffmpeg" });
});

test("on this machine: the same answers as asking one program at a time", () => {
  // node itself is always there; the rest are whatever this machine has (null is an answer too)
  const names = [path.basename(process.execPath).replace(/\.exe$/i, ""), "ffmpeg", "ffprobe", "tesseract", "aria2c", "python", "python3", "no-such-program-aurora"];
  const all = locate(names);
  for (const n of names) assert.equal(all[n], oneAtATime(n), n);
  assert.ok(all[names[0]], "node is on PATH");
  assert.equal(all["no-such-program-aurora"], null);
});

test("one child process for all of them, and never a throw", () => {
  const real = cp.execSync;
  let calls = 0;
  cp.execSync = function (...a) { calls++; return real.apply(this, a); };
  try {
    locate(["ffmpeg", "ffprobe", "tesseract", "aria2c", "python", "python3"]);
    assert.equal(calls, 1);
    calls = 0;
    // nothing found at all (`where` exits 1): every answer is null
    assert.deepEqual(locate(["no-such-program-aurora", "nor-this-one-aurora"]), { "no-such-program-aurora": null, "nor-this-one-aurora": null });
    assert.equal(calls, 1);
    // a name that could be more than a name never reaches a shell
    calls = 0;
    assert.deepEqual(locate(["ffmpeg; echo hi", "a b"]), { "ffmpeg; echo hi": null, "a b": null });
    assert.equal(calls, 0);
    // the lookup itself failing is "not found", as it always was
    cp.execSync = () => { throw new Error("no shell"); };
    assert.deepEqual(locate(["ffmpeg"]), { ffmpeg: null });
  } finally {
    cp.execSync = real;
  }
});

test("config.js: the programs it resolves are the ones a one-by-one lookup finds", () => {
  const config = require("../src/config");
  assert.equal(config.FFMPEG || null, oneAtATime("ffmpeg"));
  assert.equal(config.FFPROBE || null, oneAtATime("ffprobe"));
  assert.equal(config.ffmpegAvailable, !!(oneAtATime("ffmpeg") && oneAtATime("ffprobe")));
});
