// "Network for streaming" (2026-11-28, elia: "Can you just add those commands
// to the admin panel? So I could press to execute from there?").
// docs/network-for-streaming.md; why: docs/qa/streaming-efficiency/REPORT.md §3.2
// (one connection at 70 ms and 1 % loss: CUBIC 2.9 Mbit/s of a 20 Mbit/s
// line, BBR 18.8).
//
// Reading what is in force needs no root: /proc/sys and /proc/net/snmp are
// readable by anyone. Changing it is root's work; Aurora never gets root. It
// asks ONE fixed-purpose helper installed once by the admin outside the repo
// (scripts/nufurora/aurora-net-helper → /usr/local/sbin/aurora-net-helper,
// allowed by one sudoers line), with `sudo -n` and execFile (no shell). The
// helper takes one word: status, apply, undo, caddy-h2 or caddy-h3.
//
//   status()   what is in force, the share of data resent lately, the helper
//   run(verb)  "apply" | "undo" (BBR) | "http2" | "http3" (Caddy without / with
//              HTTP/3 — Caddy's QUIC does its own sending, BBR does not steer it)
//   start()    a sample of the TCP counters every minute (Linux only)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const HELPER = "/usr/local/sbin/aurora-net-helper";
const SUDOERS = "/etc/sudoers.d/aurora-net";
const REPO_HELPER = path.join(__dirname, "..", "..", "scripts", "nufurora", "aurora-net-helper");
const SAMPLE_MS = 60 * 1000;
const KEEP = 61; // an hour of minutes

const versionOf = (text) => { const m = /^VERSION=(\d+)/m.exec(String(text || "")); return m ? Number(m[1]) : null; };

const deps = {
  platform: () => process.platform,
  now: () => Date.now(),
  readProc: (rel) => fs.readFileSync(path.join("/proc", rel), "utf8"),
  helperText: () => { try { return fs.readFileSync(HELPER, "utf8"); } catch { return null; } },
  repoText: () => { try { return fs.readFileSync(REPO_HELPER, "utf8"); } catch { return null; } },
  repoHelper: () => REPO_HELPER,
  user: () => { try { return os.userInfo().username; } catch { return process.env.USER || ""; } },
  // sudo -n never asks for a password: without the sudoers line it fails at once
  helper: (args, timeoutMs) => new Promise((resolve) => {
    execFile("sudo", ["-n", HELPER, ...args], { timeout: timeoutMs, killSignal: "SIGTERM", windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        spawnError: err && typeof err.code === "string" ? err.code : null,
        killed: !!(err && err.killed),
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  }),
};

// ---------- the TCP counters (/proc/net/snmp) ----------
const snmpTcp = (text) => {
  const rows = String(text || "").split("\n").filter((l) => l.startsWith("Tcp:"));
  if (rows.length < 2) return null;
  const k = rows[0].trim().split(/\s+/);
  const v = rows[1].trim().split(/\s+/);
  const o = {};
  k.forEach((name, i) => { o[name] = Number(v[i]); });
  return Number.isFinite(o.OutSegs) && Number.isFinite(o.RetransSegs) ? { out: o.OutSegs, retrans: o.RetransSegs } : null;
};
let samples = [];
const sample = () => {
  let c = null;
  try { c = snmpTcp(deps.readProc("net/snmp")); } catch {}
  if (!c) return null;
  const s = { at: deps.now(), ...c };
  samples.push(s);
  if (samples.length > KEEP) samples = samples.slice(-KEEP);
  return s;
};
const pct = (retrans, out) => (out > 0 ? Math.round((retrans / out) * 100000) / 1000 : 0);
// the share resent between the oldest kept sample and now, and since the server started
const lossNow = () => {
  const last = sample();
  if (!last) return null;
  const first = samples[0];
  const span = last.at - first.at;
  const recent = span >= 50 * 1000 && last.out > first.out
    ? { pct: pct(last.retrans - first.retrans, last.out - first.out), minutes: Math.round(span / 60000), sent: last.out - first.out }
    : null;
  return { recent, sinceBoot: { pct: pct(last.retrans, last.out), sent: last.out } };
};

let timer = null;
const start = () => {
  if (timer || deps.platform() !== "linux") return;
  sample();
  timer = setInterval(sample, SAMPLE_MS);
  if (timer.unref) timer.unref();
};

// ---------- the helper ----------
const shq = (p) => (/^[A-Za-z0-9._/-]+$/.test(p) ? p : `'${String(p).replace(/'/g, "'\\''")}'`);
const setupCommand = () => {
  const u = deps.user();
  const user = /^[a-z_][a-z0-9_.-]{0,31}$/i.test(u) ? u : "elia";
  return `sudo install -o root -g root -m 0755 ${shq(deps.repoHelper())} ${HELPER} && t=$(mktemp) && echo '${user} ALL=(root) NOPASSWD: ${HELPER}' > "$t" && sudo visudo -cf "$t" && sudo install -o root -g root -m 0440 "$t" ${SUDOERS}; rm -f "$t"`;
};
const parse = (stdout) => {
  const lines = String(stdout || "").trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o && typeof o === "object" && "ok" in o) return o; } catch {}
  }
  return null;
};
// -> { ok: true, json } | { ok: false, error } | { missing: "helper"|"sudo", error }
const askHelper = async (verb, ms) => {
  if (deps.helperText() == null) return { missing: "helper", error: `${HELPER} is not installed yet.` };
  const r = await deps.helper([verb], ms);
  const j = parse(r.stdout);
  if (j) return j.ok ? { ok: true, json: j } : { ok: false, error: j.error || "the helper refused" };
  if (r.spawnError === "ENOENT") return { missing: "sudo", error: "sudo is not on this server." };
  if (/password is required|not allowed to|may not run|a terminal is required|not in the sudoers/i.test(r.stderr)) return { missing: "sudo", error: "The sudo rule for the helper is not installed." };
  if (r.killed) return { ok: false, error: `the helper did not finish in ${Math.round(ms / 1000)} s` };
  return { ok: false, error: (r.stderr.trim().split(/\r?\n/).pop() || `the helper gave no answer (exit ${r.code})`).slice(0, 300) };
};

// ---------- what the admin sees ----------
const readSys = (rel) => { try { return deps.readProc(path.posix.join("sys", rel)).trim(); } catch { return null; } };
const status = async () => {
  if (deps.platform() !== "linux") return { supported: false, platform: deps.platform() };
  const installed = deps.helperText();
  const helper = {
    installed: installed != null,
    version: versionOf(installed),
    repoVersion: versionOf(deps.repoText()),
  };
  helper.outdated = !!(helper.installed && helper.repoVersion && helper.version && helper.version < helper.repoVersion);
  const ssai = readSys("net/ipv4/tcp_slow_start_after_idle");
  const out = {
    supported: true,
    cc: readSys("net/ipv4/tcp_congestion_control"),
    defaultQdisc: readSys("net/core/default_qdisc"),
    slowStartAfterIdle: ssai == null ? null : Number(ssai),
    available: String(readSys("net/ipv4/tcp_available_congestion_control") || "").split(/\s+/).filter(Boolean),
    loss: lossNow(),
    helper,
    setup: setupCommand(),
  };
  if (helper.installed) {
    const r = await askHelper("status", 15000);
    if (r.ok) {
      out.queue = r.json.queue || null; out.iface = r.json.iface || null; out.file = !!r.json.file; helper.ready = true;
      out.caddy = r.json.caddy || null; // none | mine (HTTP/1.1 + HTTP/2 only) | hand (its own protocols line) | default
      out.caddyLine = r.json.caddyLine || null;
    }
    else { helper.ready = false; helper.error = r.error; }
  }
  out.on = out.cc === "bbr" && out.slowStartAfterIdle === 0 && out.defaultQdisc === "fq";
  return out;
};

let busy = false;
const WORDS = { apply: "apply", undo: "undo", http2: "caddy-h2", http3: "caddy-h3" };
const run = async (verb) => {
  if (!Object.prototype.hasOwnProperty.call(WORDS, verb)) return { error: "unknown action" };
  if (deps.platform() !== "linux") return { error: "Only a Linux server can change this." };
  if (busy) return { error: "Already changing — wait a moment." };
  busy = true;
  try {
    const r = await askHelper(WORDS[verb], 45000);
    if (r.missing) return { error: r.error, setup: setupCommand() };
    if (!r.ok) return { error: r.error };
    console.log(`[nettune] ${verb}: congestion ${r.json.cc}, queue ${r.json.queue || "?"}${r.json.queueNow === false ? " (the queue changes at the next restart)" : ""}, caddy ${r.json.caddy || "?"}`);
    return { ok: true, queueNow: r.json.queueNow !== false, status: await status() };
  } finally { busy = false; }
};

module.exports = { status, run, start, HELPER, SUDOERS, _internals: { deps, snmpTcp, lossNow, parse, setupCommand, versionOf, reset: () => { samples = []; busy = false; if (timer) clearInterval(timer); timer = null; } } };
