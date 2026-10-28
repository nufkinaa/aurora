// Starts first: while somebody waits for the FIRST segment of a stream (a
// start, a seek, a resume), the encoders that are already well ahead of their
// own viewers stand still, and go on the moment that segment is out.
//
// Why: on a machine without a graphics card every viewer's encode is libx264
// on the CPU. On Linux they all run at the same priority — a nice value once
// raised cannot be lowered back without root (lib/prio.js), so an encoder
// whose viewer is right behind it must stay at normal (jit paceEncoder) — and
// the three or four people who press Play within seconds of each other
// competed for the cores with the encoders that had started a few seconds
// earlier and were filling their viewers' buffers at full speed: on eight
// cores 3 starts at once p95 2.3–7.1 s, 4 at once up to 11 s
// (docs/qa/perf-ttff/REPORT.md). An encoder whose viewer already has two
// segments of film made beyond where it is watching loses nothing by
// pausing for the second or two the newcomer's first segment takes.
//
// THE RULES
//   - a WAIT is a viewer waiting for the first segment of what it asked for
//     (wait() → end()). Owners: media/jit.js (a reader that has had nothing
//     yet — a start, a seek, a resume, another rung) and media/remux.js (a
//     new job until its playlist is there — the TV's offsets);
//   - a CANDIDATE is a running CPU encoder (track()): the ladder's renditions
//     and the single-rendition / TV offset encodes. Its owner says how much
//     film it has made beyond its viewers' playheads (aheadSec, the least over
//     its viewers, estimated so it can only be too LOW — see the owners), and
//     whether somebody is waiting on it right now (waited);
//   - while there is a wait, every candidate at least HOLD_AHEAD_SEC (two 6 s
//     segments) ahead and not waited on is HELD. Linux / macOS: SIGSTOP, our
//     own child, no privileges needed (SIGCONT resumes it exactly where it
//     was). Windows: the idle priority class (a priority there can be put
//     back, and an NtSuspendProcess costs a PowerShell — lib/procpause.js), so
//     the waited-for encoder, at normal, gets every core it can use;
//   - it is let go as soon as ANY of these holds: no wait is left (the
//     segment is out, or the viewer left), it is under HOLD_AHEAD_SEC ahead
//     (its viewer is getting near — never starved for somebody else's
//     start), somebody waits on it, MAX_HOLD_MS has passed (then not held
//     again for REHOLD_MS), its owner stops it (lib/children killNow), the
//     server exits. A wait that is never ended stops counting after
//     WAIT_TTL_MS. While anything is held or waited for, a TICK_MS timer
//     looks again (the watchdog: nothing is ever left held).
//   - a process the server dies without letting go (SIGKILL, the OOM killer:
//     no handler of ours runs) is not left stopped either: the keeper ends
//     what the dead server left in its process group (lib/keeper.js
//     killGroup — SIGKILL ends a stopped process). The kernel's own rule for
//     orphaned groups (SIGHUP + SIGCONT) does not help here: the keeper
//     starts the server as its own session (measured in WSL).
//
// Everything that touches the OS is a replaceable dependency (deps), so the
// rules are tested without a process.
"use strict";
const os = require("os");

const HOLD_AHEAD_SEC = 12; // two of jit's 6 s segments: never held with less
const HOLD_FROM_SEC = HOLD_AHEAD_SEC + 2; // (a hold starts with a little more, so one is not let go a tick later)
const MAX_HOLD_MS = 10 * 1000;
const REHOLD_MS = 2 * 1000;
const WAIT_TTL_MS = 30 * 1000;
const TICK_MS = 250;

const deps = {
  platform: () => process.platform,
  kill: (pid, sig) => process.kill(pid, sig),
  setPriority: (pid, p) => os.setPriority(pid, p),
  now: () => Date.now(),
  setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
  clearInterval: (t) => clearInterval(t),
  // AURORA_STARTFIRST=off: nothing is ever held (the A/B switch)
  enabled: () => !/^(0|off|false|no)$/i.test(String(process.env.AURORA_STARTFIRST || "")),
  log: (msg) => console.log(msg),
};

const waits = new Map(); // id -> { label, since }
const cands = new Map(); // holder -> candidate
let waitSeq = 0;
let timer = null;
const stats = { waits: 0, holds: 0, releases: 0, maxed: 0, failed: 0, heldMsTotal: 0, longestHoldMs: 0, why: {} };

const alive = (child) => !!(child && child.pid && child.exitCode == null && child.signalCode == null);
const safe = (fn, dflt) => { try { const v = fn(); return v === undefined ? dflt : v; } catch { return dflt; } };

const holdOs = (c) => {
  if (deps.platform() === "win32") {
    deps.setPriority(c.child.pid, os.constants.priority.PRIORITY_LOW);
  } else {
    deps.kill(c.child.pid, "SIGSTOP");
  }
};
const releaseOs = (c, { forKill = false } = {}) => {
  if (deps.platform() === "win32") {
    if (forKill) return; // (killNow puts it at normal itself)
    const p = safe(() => c.priority(), null);
    deps.setPriority(c.child.pid, p != null ? p : os.constants.priority.PRIORITY_BELOW_NORMAL);
    return;
  }
  // a process another owner paused meanwhile (remux's far-ahead pause,
  // lib/procpause.js) stays paused: that one resumes it
  if (!forKill && safe(() => c.pausedElsewhere(), false)) return;
  deps.kill(c.child.pid, "SIGCONT");
};

const hold = (c, now) => {
  try { holdOs(c); } catch { stats.failed++; c.noHoldUntil = now + REHOLD_MS; return; }
  c.held = true;
  c.heldAt = now;
  if (c.holder && typeof c.holder === "object") c.holder.sfHeld = true;
  stats.holds++;
  safe(() => c.onHold && c.onHold(), null);
  deps.log(`[startfirst] held ${c.label} (${Math.round(safe(() => c.aheadSec(), 0))} s made ahead of its viewer; ${waits.size} waiting for a first segment)`);
};
const release = (c, why, now = deps.now(), opts = {}) => {
  if (!c.held) return;
  c.held = false;
  if (c.holder && typeof c.holder === "object") c.holder.sfHeld = false;
  if (alive(c.child)) { try { releaseOs(c, opts); } catch { stats.failed++; } }
  const ms = now - c.heldAt;
  stats.releases++;
  stats.heldMsTotal += ms;
  if (ms > stats.longestHoldMs) stats.longestHoldMs = ms;
  stats.why[why] = (stats.why[why] || 0) + 1;
  if (why === "max") { stats.maxed++; c.noHoldUntil = now + REHOLD_MS; }
  safe(() => c.onRelease && c.onRelease(why), null);
  deps.log(`[startfirst] let go ${c.label} after ${ms} ms (${why})`);
};

// Look at everything again. Cheap: a few candidates, no I/O.
const check = () => {
  const now = deps.now();
  for (const [id, w] of waits) if (now - w.since >= WAIT_TTL_MS) waits.delete(id);
  const on = deps.enabled();
  for (const c of [...cands.values()]) {
    if (!alive(c.child)) { cands.delete(c.holder); if (c.held) release(c, "exited", now); continue; }
    // (what the owner reads off the loop — remux's playlist — for the next look)
    if (c.refresh && (waits.size || c.held)) { try { Promise.resolve(c.refresh()).catch(() => {}); } catch {} }
    const ahead = safe(() => c.aheadSec(), -Infinity);
    const waited = safe(() => c.waited(), true);
    const elsewhere = safe(() => c.pausedElsewhere(), false);
    if (c.held) {
      const why = !on ? "off" : !waits.size ? "segment out" : waited ? "waited on" : !(ahead >= HOLD_AHEAD_SEC) ? "viewer near" : now - c.heldAt >= MAX_HOLD_MS ? "max" : null;
      if (why) release(c, why, now);
    } else if (on && waits.size && !waited && !elsewhere && ahead >= HOLD_FROM_SEC && now >= (c.noHoldUntil || 0)) {
      hold(c, now);
    }
  }
  arm();
};
const arm = () => {
  const busy = waits.size > 0 || [...cands.values()].some((c) => c.held);
  if (busy && !timer) timer = deps.setInterval(check, TICK_MS);
  else if (!busy && timer) { deps.clearInterval(timer); timer = null; }
};

// A viewer is waiting for a first segment. → { end() } (idempotent)
const wait = (label = "") => {
  const id = ++waitSeq;
  waits.set(id, { label, since: deps.now() });
  stats.waits++;
  check();
  let done = false;
  return { id, end() { if (done) return; done = true; if (waits.delete(id)) check(); } };
};

// A running CPU encoder that may be held. `holder`: the owner's object for it
// (jit's run, remux's job) — it carries `sfHeld` while held, which the owner's
// own priority changes respect. meta:
//   child          the ffmpeg process
//   label          for the log
//   aheadSec()     film made beyond its viewers' playheads (s), the least of
//                  them; -Infinity / null when that is not known
//   waited()       somebody is waiting on what it makes next
//   pausedElsewhere()  paused by another rule (remux's far-ahead pause)
//   priority()     Windows: the priority to put back when let go
//   refresh()      optional, async: re-read what aheadSec() answers from (it
//                  is asked on every look while somebody waits)
//   onHold(), onRelease(why)
// → untrack(). Gone by itself when the process exits.
const track = (holder, meta = {}) => {
  if (!holder || !meta.child) return () => {};
  const c = {
    holder, child: meta.child, label: meta.label || "encoder",
    aheadSec: meta.aheadSec || (() => -Infinity),
    waited: meta.waited || (() => false),
    pausedElsewhere: meta.pausedElsewhere || (() => false),
    priority: meta.priority || (() => null),
    refresh: typeof meta.refresh === "function" ? meta.refresh : null,
    onHold: meta.onHold || null, onRelease: meta.onRelease || null,
    held: false, heldAt: 0, noHoldUntil: 0,
  };
  cands.set(holder, c);
  const gone = () => {
    if (cands.get(holder) !== c) return;
    cands.delete(holder);
    if (c.held) release(c, "exited");
    arm();
  };
  if (typeof meta.child.once === "function") { meta.child.once("exit", gone); meta.child.once("error", gone); }
  if (waits.size) check();
  return gone;
};

const held = (holder) => { const c = holder && cands.get(holder); return !!(c && c.held); };

// About to be killed (lib/children killNow): let go first, so a stopped
// process gets the signal at once whatever the signal is.
const letGo = (child) => {
  for (const c of cands.values()) if (c.child === child && c.held) release(c, "stopped", deps.now(), { forKill: true });
};

// Everything held goes on (shutdown; synchronous — safe in an "exit" handler).
const releaseAll = (why = "shutdown") => {
  let n = 0;
  for (const c of cands.values()) if (c.held) { release(c, why, deps.now()); n++; }
  arm();
  return n;
};
let hooked = false;
const hookExit = () => {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => { try { releaseAll("server exit"); } catch {} });
};
hookExit();

const status = () => ({
  enabled: deps.enabled(),
  how: deps.platform() === "win32" ? "idle priority" : "SIGSTOP / SIGCONT",
  waiting: waits.size,
  encoders: cands.size,
  held: [...cands.values()].filter((c) => c.held).map((c) => ({ label: c.label, ms: deps.now() - c.heldAt })),
  limits: { aheadSec: HOLD_AHEAD_SEC, holdFromSec: HOLD_FROM_SEC, maxHoldMs: MAX_HOLD_MS, reholdMs: REHOLD_MS, waitTtlMs: WAIT_TTL_MS },
  stats: { ...stats, why: { ...stats.why } },
});

const _reset = () => {
  waits.clear();
  cands.clear();
  if (timer) { deps.clearInterval(timer); timer = null; }
  for (const k of Object.keys(stats)) stats[k] = k === "why" ? {} : 0;
};

module.exports = { wait, track, held, check, letGo, releaseAll, status, HOLD_AHEAD_SEC, HOLD_FROM_SEC, MAX_HOLD_MS, REHOLD_MS, WAIT_TTL_MS, TICK_MS, _internals: { deps, waits, cands, stats, _reset } };
