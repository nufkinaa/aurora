"use strict";
// Test-impact tracer. Loaded with NODE_OPTIONS="--require <abs path>/tools/ci/trace-preload.cjs"
// and AURORA_TRACE_DIR=<folder>. It records, per test file, every repo file the test's
// processes load or read, so CI can later run only the tests a change can reach.
//
// Who is who:
//  - the `node --test` runner itself: no NODE_TEST_CONTEXT, no AURORA_TRACE_TEST -> does nothing;
//  - a test file's process: the runner sets NODE_TEST_CONTEXT; argv[1] is the test file;
//    we put AURORA_TRACE_TEST in the env so everything it spawns is credited to it;
//  - anything a test spawns (a server, a script, a worker): inherits AURORA_TRACE_TEST.
//
// What is recorded (one line per new path, appended to <dir>/<pid>-<thread>.log):
//   t <test file>        first line: who this process works for
//   r <abs path>         a CommonJS module load, fs read/open/stat/exists/access/copy source
//   d <abs path>         a directory listing (readdir/opendir); "D" for a recursive one
//   c <abs path>         the source of fs.cp/cpSync: for a folder, everything under it
//   x <command>          a child process that is not node (ffmpeg, where, ...)
// ESM loads are recorded by trace-esm-hooks.mjs into <pid>-esm<thread>.log.
// Paths are normalised and filtered later by build-test-map.js (repo-relative, forward
// slashes, git-tracked files only), so this file stays small and cheap.
//
// It must never change behaviour: every hook calls the original with the original
// arguments and returns its result; recording errors are swallowed.

let dir = process.env.AURORA_TRACE_DIR;
const testContext = process.env.NODE_TEST_CONTEXT;
let owner = process.env.AURORA_TRACE_TEST;

if (dir && (owner || (testContext && process.argv[1]))) {
  try { start(); } catch (e) { if (process.env.AURORA_TRACE_DEBUG) process.stderr.write(`trace: ${e && e.stack}\n`); }
}

function start() {
  const fs = require("fs");
  const path = require("path");
  const Module = require("module");
  const { threadId, isMainThread } = require("worker_threads");

  const ROOT = path.resolve(__dirname, "..", "..");
  const win = process.platform === "win32";
  const rootCmp = (win ? ROOT.toLowerCase() : ROOT) + path.sep;

  if (!owner) {
    owner = path.relative(ROOT, path.resolve(process.argv[1])).split(path.sep).join("/");
    process.env.AURORA_TRACE_TEST = owner;
    process.env.AURORA_TRACE_DIR = dir = path.resolve(dir); // children may start somewhere else
    // how long this test file took, for the time estimates in CI's summary
    process.on("exit", () => out(`e ${Math.round(process.uptime() * 1000)}`));
  }

  // Keep the originals: our own writes must not go through the hooks.
  const o = {
    openSync: fs.openSync, writeSync: fs.writeSync, mkdirSync: fs.mkdirSync, existsSync: fs.existsSync,
  };
  let fd = -1;
  function out(line) {
    if (fd < 0) {
      try {
        o.mkdirSync(dir, { recursive: true });
        fd = o.openSync(path.join(dir, `${process.pid}-${threadId}.log`), "a");
        o.writeSync(fd, `t ${owner}\n`);
      } catch { fd = -2; }
    }
    if (fd >= 0) { try { o.writeSync(fd, line + "\n"); } catch { /* ignore */ } }
  }

  const seen = new Set();
  function toPath(p) {
    if (typeof p === "string") return p;
    if (p instanceof URL) return p.protocol === "file:" ? require("url").fileURLToPath(p) : null;
    if (Buffer.isBuffer(p)) return p.toString();
    return null; // file descriptors and the like
  }
  function rec(kind, p) {
    try {
      const s = toPath(p);
      if (!s) return;
      // (keyed on the resolved path: a relative name means another file after a chdir)
      const abs = path.resolve(s);
      const key = kind + abs;
      if (seen.has(key)) return;
      seen.add(key);
      const cmp = win ? abs.toLowerCase() : abs;
      if (!cmp.startsWith(rootCmp) && cmp + path.sep !== rootCmp) return; // outside the repo
      if (cmp.includes(`${path.sep}node_modules${path.sep}`) || cmp.includes(`${path.sep}.git${path.sep}`)) return;
      out(`${kind} ${abs}`);
    } catch { /* ignore */ }
  }
  // Only a pure write ("w", "a", "wx", ...) is not a read; "r", "r+", "w+", "a+" all read.
  const readFlags = (flags) => {
    if (flags == null) return true;
    if (typeof flags === "number") return (flags & 3) !== fs.constants.O_WRONLY;
    const f = String(flags);
    return !/^[wa]/.test(f) || f.includes("+");
  };

  // --- CommonJS module loads (require of .js/.json/.node, require(esm) too)
  const load = Module.prototype.load;
  Module.prototype.load = function (filename) { rec("r", filename); return load.apply(this, arguments); };

  // --- fs
  const wrap1 = (obj, name, kind = "r") => {
    const f = obj[name];
    if (typeof f !== "function") return;
    obj[name] = function (p) { rec(kind, p); return f.apply(this, arguments); };
    Object.defineProperties(obj[name], Object.getOwnPropertyDescriptors(f));
  };
  const wrapOpen = (obj, name) => {
    const f = obj[name];
    if (typeof f !== "function") return;
    obj[name] = function (p, flags) { if (readFlags(typeof flags === "function" ? undefined : flags)) rec("r", p); return f.apply(this, arguments); };
    Object.defineProperties(obj[name], Object.getOwnPropertyDescriptors(f));
  };
  const wrapDir = (obj, name) => {
    const f = obj[name];
    if (typeof f !== "function") return;
    obj[name] = function (p, opts) { rec(opts && typeof opts === "object" && opts.recursive ? "D" : "d", p); return f.apply(this, arguments); };
    Object.defineProperties(obj[name], Object.getOwnPropertyDescriptors(f));
  };
  for (const n of ["readFileSync", "readFile", "statSync", "stat", "lstatSync", "lstat", "existsSync", "exists",
    "accessSync", "access", "createReadStream", "copyFileSync", "copyFile", "readlinkSync", "readlink"]) wrap1(fs, n);
  // cp of a folder copies everything under it: the test depends on all of it ("c").
  wrap1(fs, "cpSync", "c"); wrap1(fs, "cp", "c");
  wrapOpen(fs, "openSync"); wrapOpen(fs, "open");
  for (const n of ["readdirSync", "readdir", "opendirSync", "opendir"]) wrapDir(fs, n);
  const fsp = fs.promises;
  for (const n of ["readFile", "stat", "lstat", "access", "copyFile", "readlink"]) wrap1(fsp, n);
  wrap1(fsp, "cp", "c");
  wrapOpen(fsp, "open");
  for (const n of ["readdir", "opendir"]) wrapDir(fsp, n);

  // --- child processes: a node script is a read; anything else is noted by name,
  // and any argument that names a repo file is a read too (ffmpeg -i test/fixtures/x.mkv).
  const cp = require("child_process");
  const nodeLike = (cmd) => {
    const b = path.basename(String(cmd)).toLowerCase();
    return cmd === process.execPath || b === "node" || b === "node.exe";
  };
  function recSpawn(cmd, args) {
    try {
      if (typeof cmd !== "string") return;
      if (!nodeLike(cmd)) {
        const name = path.basename(cmd.trim().replace(/^"|"$/g, "")).replace(/\.(exe|cmd|bat)"?$/i, "").toLowerCase();
        if (!seen.has("\0x" + name)) { seen.add("\0x" + name); out(`x ${name}`); }
      }
      // (only arguments that name something that exists: not numbers, flags or inline code)
      if (Array.isArray(args)) {
        for (const a of args) if (typeof a === "string" && a && !a.startsWith("-") && a.length < 400 && !/[\r\n]/.test(a) && o.existsSync(a)) rec("r", a);
      }
    } catch { /* ignore */ }
  }
  // A node child started with its own env that leaves out NODE_OPTIONS is not traced:
  // say so ("w"), so the map can show which tests have reads it cannot see.
  function envCheck(cmd, args, isFork) {
    try {
      if (!isFork && !nodeLike(cmd)) return;
      for (const a of args) {
        if (a && typeof a === "object" && !Array.isArray(a) && a.env && typeof a.env === "object") {
          if ((!a.env.AURORA_TRACE_TEST || !String(a.env.NODE_OPTIONS || "").includes("trace-preload")) && !seen.has("\0w")) {
            seen.add("\0w");
            out(`w ${owner}`);
          }
          return;
        }
      }
    } catch { /* ignore */ }
  }
  for (const n of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
    const f = cp[n];
    if (typeof f !== "function") continue;
    cp[n] = function (cmd, args) {
      if (n === "fork") rec("r", cmd); else recSpawn(cmd, args);
      envCheck(cmd, arguments, n === "fork");
      return f.apply(this, arguments);
    };
    Object.defineProperties(cp[n], Object.getOwnPropertyDescriptors(f));
  }
  for (const n of ["exec", "execSync"]) {
    const f = cp[n];
    if (typeof f !== "function") continue;
    cp[n] = function (command) {
      if (typeof command === "string") { const parts = command.trim().split(/\s+/); recSpawn(parts[0], parts.slice(1)); }
      return f.apply(this, arguments);
    };
    Object.defineProperties(cp[n], Object.getOwnPropertyDescriptors(f));
  }

  // --- ES modules (import / import()): off-thread hooks write their own log
  try {
    if (isMainThread && typeof Module.register === "function") {
      Module.register("./trace-esm-hooks.mjs", require("url").pathToFileURL(__filename), {
        data: { file: path.join(dir, `${process.pid}-esm${threadId}.log`), owner },
      });
    }
  } catch { /* older node: CommonJS + fs tracing only */ }
}
