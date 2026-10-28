// Helper processes that decode and fingerprint for introdetect.js
// (introprint-child.js): up to cpuwork's intro slots of them, each at the
// lowest CPU priority, started when wanted and gone after a minute idle.
// An urgent read (somebody pressed Play) has a lane of its own.
// Should a helper not start (or die), the read happens here instead, the
// old way — decode, then the cooperative fingerprint.
//   read(file, start, length, { urgent }) -> { codes, valid } | null
"use strict";
const path = require("path");
const { fork, execFile } = require("child_process");
const config = require("../config");
const cpuwork = require("./cpuwork");
const introprint = require("./introprint");

const IDLE_MS = 60 * 1000;
const CHILD = path.join(__dirname, "introprint-child.js");

// Two lanes: the background one (up to cpuwork's intro slots, the lowest
// priority) and the urgent one (somebody pressed Play on an episode with no
// answer: one helper, one step below normal — still under the server and
// level with the viewers' own encoders, so it is done in seconds, not
// starved behind whatever else the machine is doing).
const lanes = {
  background: { helpers: [], queue: [], max: () => { try { return cpuwork.background.introSlots(); } catch { return 1; } }, lower: (child) => cpuwork.background.lower(child, "intro-print") },
  urgent: { helpers: [], queue: [], max: () => 1, lower: (child) => { try { require("os").setPriority(child.pid, require("os").constants.priority.PRIORITY_BELOW_NORMAL); } catch {} } },
};
let seq = 0;
const pending = new Map(); // id -> { resolve, helper, retry }
let broken = false; // a helper could not be started: read in-process from now on

const toPrint = (m) => {
  if (!m || !m.codes || !m.valid) return null;
  const c = Buffer.from(m.codes);
  const v = Buffer.from(m.valid);
  const l = m.level ? Buffer.from(m.level) : null;
  return {
    codes: new Uint32Array(c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength - (c.byteLength % 4))),
    valid: new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)),
    ...(l ? { level: new Uint8Array(l.buffer.slice(l.byteOffset, l.byteOffset + l.byteLength)) } : {}),
  };
};

// an idle helper never keeps the server (or a test) alive; a busy one does
const hold = (h, on) => {
  try { if (h.child.channel) { if (on) h.child.channel.ref(); else h.child.channel.unref(); } } catch {}
};
const startHelper = (lane) => {
  const child = fork(CHILD, [], { serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, execArgv: [] });
  try { lane.lower(child); } catch {}
  const h = { child, busy: false, idleTimer: null };
  child.on("message", (m) => {
    const p = m && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    h.busy = false;
    hold(h, false);
    p.resolve(m.error ? null : toPrint(m));
    pump(lane);
  });
  const gone = () => {
    const i = lane.helpers.indexOf(h);
    if (i >= 0) lane.helpers.splice(i, 1);
    for (const [id, p] of pending) if (p.helper === h) { pending.delete(id); p.retry(); }
    pump(lane);
  };
  child.on("exit", gone);
  child.on("error", () => { broken = lane.helpers.length <= 1; gone(); });
  if (child.unref) child.unref();
  hold(h, false);
  lane.helpers.push(h);
  return h;
};

const pump = (lane) => {
  while (lane.queue.length) {
    let h = lane.helpers.find((x) => !x.busy);
    if (!h && lane.helpers.length < lane.max() && !broken) {
      try { h = startHelper(lane); } catch { broken = true; }
    }
    if (!h) break;
    const job = lane.queue.shift();
    h.busy = true;
    clearTimeout(h.idleTimer);
    h.idleTimer = null;
    const id = ++seq;
    pending.set(id, { resolve: job.resolve, helper: h, retry: () => job.local() });
    try {
      hold(h, true);
      h.child.send({ id, ...job.msg });
    } catch {
      pending.delete(id);
      h.busy = false;
      job.local();
    }
  }
  for (const h of lane.helpers) {
    if (h.busy || h.idleTimer) continue;
    h.idleTimer = setTimeout(() => { h.idleTimer = null; if (!h.busy) { try { h.child.disconnect(); } catch {} } }, IDLE_MS);
    if (h.idleTimer.unref) h.idleTimer.unref();
  }
  if (broken) while (lane.queue.length) lane.queue.shift().local();
};

// The old way, here: decode at the lowest priority, fingerprint cooperatively.
const readHere = (file, start, length) =>
  new Promise((resolve) => {
    const args = ["-v", "error", "-nostdin"];
    if (start > 0) args.push("-ss", String(start));
    args.push("-i", file, "-t", String(length), "-vn", "-ac", "1", "-ar", String(introprint.SR), "-f", "s16le", "-");
    const child = execFile(config.FFMPEG, args, { encoding: "buffer", maxBuffer: Math.ceil(length * introprint.SR * 2 + 4 * 1024 * 1024), windowsHide: true, timeout: Math.max(60000, length * 100) }, async (err, stdout) => {
      if (!stdout || stdout.length <= introprint.N * 4) return resolve(null);
      resolve(await introprint.fingerprintAsync(new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2))));
    });
    try { cpuwork.background.lower(child); } catch {}
  });

const read = (file, start, length, { urgent = false } = {}) =>
  new Promise((resolve) => {
    const job = { msg: { file, start, length, ffmpeg: config.FFMPEG }, resolve, local: () => readHere(file, start, length).then(resolve) };
    if (broken) return job.local();
    const lane = urgent ? lanes.urgent : lanes.background;
    lane.queue.push(job);
    pump(lane);
  });

const status = () => Object.fromEntries(Object.entries(lanes).map(([k, l]) => [k, { helpers: l.helpers.length, busy: l.helpers.filter((h) => h.busy).length, queued: l.queue.length }]));

module.exports = { read, status, _internals: { readHere, lanes, broken: () => broken } };
