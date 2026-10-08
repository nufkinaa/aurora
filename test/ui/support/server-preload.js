// Preloaded (node -r) into the private Aurora instance the UI tests boot.
// It changes nothing about the app; it only fences the process in:
//
//   1. No outbound network. Every TCP connection to a host that is not this
//      machine is refused at once (TMDB, Cinemeta, trackers, push services),
//      and UDP never leaves it. The tests must behave the same offline and
//      online, and must never start a real torrent or metadata lookup.
//   2. No orphans. If the test process that started this server disappears
//      (killed, crashed, a CTRL-C that never reached its handlers) the server
//      takes itself and its children (ffmpeg) down within a second or two.
const net = require("net");
const dgram = require("dgram");
const { spawnSync } = require("child_process");

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::", "[::1]", "::ffff:127.0.0.1"]);
const seen = new Set();
const note = (host) => {
  if (seen.has(host)) return;
  seen.add(host);
  process.stdout.write(`[ui-test] blocked outbound connection to ${host}\n`);
};

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // connect(options[, cb]) | connect(port[, host][, cb]) | connect(path[, cb])
  // (internal callers pass one pre-normalised array)
  const a = Array.isArray(args[0]) ? args[0] : args;
  let host = null;
  let local = false;
  if (a[0] && typeof a[0] === "object") {
    if (a[0].path) local = true; // a pipe: never leaves the machine
    host = a[0].host || a[0].hostname || "localhost";
  } else if (typeof a[0] === "string" && !/^\d+$/.test(a[0])) {
    local = true; // connect(path)
  } else {
    host = typeof a[1] === "string" ? a[1] : "localhost";
  }
  if (local || LOCAL.has(String(host).toLowerCase())) return realConnect.apply(this, args);
  note(host);
  const err = Object.assign(new Error(`ui-test: outbound network is disabled (${host})`), { code: "ECONNREFUSED" });
  process.nextTick(() => this.destroy(err));
  return this;
};

const realSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  const cb = args.find((x) => typeof x === "function");
  const host = args.filter((x) => typeof x === "string").pop();
  if (host && LOCAL.has(host.toLowerCase())) return realSend.apply(this, args);
  note(`udp:${host || "?"}`);
  if (cb) process.nextTick(cb, null, 0);
};

const parent = Number(process.env.AURORA_UI_PARENT_PID || 0);
if (parent) {
  const alive = () => { try { process.kill(parent, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  // (three misses in a row: one odd answer from the OS must not end a run)
  let misses = 0;
  setInterval(() => {
    if (alive()) { misses = 0; return; }
    if (++misses < 3) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(process.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    process.exit(0);
  }, 1000).unref();
}
