// What this machine gives the server, checked at boot and on every metrics
// read (cheaply): the Node version, the open-file limit (Linux), free disk
// where the data lives, and what config.json's check found
// (lib/configcheck.js). For the admin's Health card and /api/admin/metrics;
// each problem is also said once in the log at boot.
//
// The file-handle limit matters because every connection, every video being
// read, every ffmpeg pipe is one. A Linux box's usual soft limit is 1024: at
// ~20 viewers with their pictures, sockets and segment files, that runs out,
// and then EVERYTHING fails — accepting, opening a file, spawning ffmpeg —
// with EMFILE. So the HTTP server's maxConnections is set from it
// (applyToServer): past it a new connection is refused at once, and the
// process keeps handles for its own files. Windows has no such limit.
"use strict";
const fs = require("fs");

const MIN_NODE = 20;
const FD_WARN = 4096; // a soft limit below this is worth raising
const FD_RESERVE = 256; // handles kept back for files, pipes, the log
const DISK_WARN_GB = 5;

// /proc/self/limits → { soft, hard } open files, or null (not Linux)
const fdLimit = (read = (p) => fs.readFileSync(p, "utf8")) => {
  if (process.platform !== "linux") return null;
  try {
    const line = read("/proc/self/limits").split("\n").find((l) => /^Max open files/.test(l));
    if (!line) return null;
    const m = /Max open files\s+(\S+)\s+(\S+)/.exec(line);
    const v = (x) => (x === "unlimited" ? Infinity : Number(x));
    return m ? { soft: v(m[1]), hard: v(m[2]) } : null;
  } catch {
    return null;
  }
};
const fdOpen = () => {
  if (process.platform !== "linux") return null;
  try { return fs.readdirSync("/proc/self/fd").length; } catch { return null; }
};

const maxConnectionsFor = (limit) => (limit && Number.isFinite(limit.soft) ? Math.max(64, limit.soft - FD_RESERVE) : null);

const applyToServer = (server) => {
  const n = maxConnectionsFor(fdLimit());
  if (n && server) server.maxConnections = n;
  return n;
};

let cached = null;
let cachedAt = 0;
const status = () => {
  const now = Date.now();
  if (cached && now - cachedAt < 10 * 1000) return cached;
  const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ id: "node", level: major >= MIN_NODE ? "ok" : "warn", text: `Node ${process.version}${major >= MIN_NODE ? "" : ` — Aurora needs ${MIN_NODE} or newer`}` });
  const lim = fdLimit();
  if (lim) {
    const open = fdOpen();
    const low = lim.soft < FD_WARN;
    const near = open != null && Number.isFinite(lim.soft) && open > lim.soft * 0.8;
    checks.push({
      id: "files", level: near ? "critical" : low ? "warn" : "ok",
      text: `Open files ${open != null ? open : "?"} of ${lim.soft === Infinity ? "unlimited" : lim.soft}${low ? ` — raise the limit (LimitNOFILE=65536 in the service, or ulimit -n 65536): at ~20 viewers ${lim.soft} runs out` : ""}`,
      open, soft: lim.soft, hard: lim.hard, maxConnections: maxConnectionsFor(lim),
    });
  }
  try {
    const config = require("../config");
    const s = require("./disk").spaceSync(config.DATA_DIR);
    if (s) {
      const gb = s.free / 1e9;
      checks.push({ id: "disk", level: gb < DISK_WARN_GB ? "warn" : "ok", text: `Free where the data lives: ${gb.toFixed(1)} GB (${Math.round(s.freePct)} %)`, free: s.free, total: s.total });
    }
  } catch {}
  try {
    const cc = require("./configcheck").last();
    const refused = cc.problems.filter((p) => p.level === "refused");
    checks.push({
      id: "config", level: refused.length ? "warn" : cc.problems.length ? "info" : "ok",
      text: cc.problems.length ? `config.json: ${refused.length ? `${refused.length} setting(s) refused, defaults used` : ""}${refused.length && cc.problems.length > refused.length ? "; " : ""}${cc.problems.length > refused.length ? `${cc.problems.length - refused.length} warning(s)` : ""}` : "config.json: every setting checked, nothing wrong",
      problems: cc.problems,
    });
  } catch {}
  cached = { checks, worst: checks.some((c) => c.level === "critical") ? "critical" : checks.some((c) => c.level === "warn") ? "warn" : "ok" };
  cachedAt = now;
  return cached;
};

// Once, at boot: what is not right, in the log.
const announce = () => {
  for (const c of status().checks) if (c.level === "warn" || c.level === "critical") { try { console.warn(`[resources] ${c.text}`); } catch {} }
};

module.exports = { status, announce, applyToServer, fdLimit, maxConnectionsFor, _internals: { fdOpen, reset: () => { cached = null; } } };
