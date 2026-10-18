// Who is using the CPU for whom: viewers first, everything else behind them.
//
// Two kinds of heavy work run here. A VIEWER encode is somebody watching
// right now: a ladder rendition (jit.js), a single-rendition transcode
// (remux.js), a torrent transcode. BACKGROUND work is everything nobody is
// waiting on this second: the play-ready copy made after a download and the
// phone copies (offline.js), intro and credits detection (the audio pass and
// the credits picture, creditscv.js), subtitle OCR, the
// encode-speed calibrations. (The blur-up placeholders a page load asks for
// are not: a few milliseconds each, and somebody is looking at the page.)
//
// Before this, background encodes ran at NORMAL priority on every thread —
// above the viewers' own encoders, which run below normal so the server stays
// responsive — and nothing knew they were running. Measured: a viewer's
// 10-second segment took 85 s on a busy machine.
//
// THE RULES
//   Viewer work is never touched by any of this. It only registers itself
//   (viewer.track) so the rest can see it.
//
//   Background work
//     - runs at the LOWEST priority the OS has (Windows: the idle class;
//       Linux/macOS: nice 19, and the idle I/O class where `ionice` exists),
//       one step under the viewers' encoders — so whenever both want a core,
//       the viewer's gets it;
//     - is capped in threads (background.threads(): half the machine);
//     - is counted against a small budget (BUDGET units: an encode takes all
//       of it, OCR and intro detection one each), so the background jobs do
//       not pile up on each other either;
//     - does not START while a viewer encode is running, nor for QUIET_MS
//       after the last one ended (background.gate hands out the places, in
//       the order asked);
//     - and a background ENCODE that is already running when a viewer encode
//       starts is PAUSED where the OS can do that (SIGSTOP, resumed with
//       SIGCONT after the quiet period — Linux and macOS). Windows has no
//       such call for another process short of native code; there the idle
//       priority class does the yielding (the encoder only gets cores nobody
//       else wants) and nothing new is started.
//     - When the viewers' encoders fall behind real time all the same
//       (encbudget.js watches), the newest background job is SHED: stopped
//       and put back in its queue (background.shedNewest).
//
//   A viewer encoder whose viewer has GONE (viewer.track's `idle` — the
//   ladder says so of an encoder nobody has asked anything of for a while)
//   is still running, but it is nobody's: viewer.load() leaves it out of
//   what an admission counts, and viewer.reclaim() stops it when another
//   viewer's encode is let in.
//
//   SPECULATIVE work is a start made ready before anybody pressed Play (the
//   ladder's warm-up of an ENCODED rendition's first seconds, jit.js
//   warmSegment). It is nobody's yet:
//     - it is never in the viewers' registry — no admission counts it, so it
//       cannot take a viewer's room or cause one to be refused or degraded;
//     - it is stopped the moment ANY viewer encode registers (viewer.track),
//       and it is the first thing shed when the viewers' encoders fall
//       behind (background.shedNewest) — before any background job;
//     - background work is not held back for it;
//     - when its viewer does come, its owner takes it out of here and
//       registers it as viewer work (speculative.track → release, then
//       viewer.track).
//
// Everything that touches the OS is a replaceable dependency (deps), so the
// rules are tested without a process.
"use strict";
const os = require("os");
const { execFile } = require("child_process");

const QUIET_MS = 20 * 1000; // no viewer encode for this long = the coast is clear
const BUDGET = 2; // background units that may run together
// (sublang: the subtitle language / alignment passes, media/sublang.js — one
// ffmpeg read each; credits: the credits picture, creditscv.js / introdetect.js)
// (speech: the speech timeline of a film for the audio subtitle sync,
// media/speech.js — one ffmpeg decode of one audio track)
const WEIGHTS = { encode: 2, ocr: 1, intro: 1, credits: 1, sublang: 1, speech: 1, light: 0 };

const deps = {
  setPriority: (pid, prio) => os.setPriority(pid, prio),
  kill: (child, sig) => child.kill(sig),
  platform: process.platform,
  cpus: () => (typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length), // (the CPUs this process may use)
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout: (t) => clearTimeout(t),
  ionice: (pid) => {
    // the idle I/O class, where the tool exists (util-linux); never an error
    try { execFile("ionice", ["-c", "3", "-p", String(pid)], { timeout: 3000 }, () => {}); } catch {}
  },
};

const PRIORITY = {
  viewer: os.constants.priority.PRIORITY_BELOW_NORMAL, // as jit.js / remux.js always set it
  background: os.constants.priority.PRIORITY_LOW, // 19: nice 19 / the Windows idle class
};

// ------------------------------------------------------------- viewer work

const viewers = new Map(); // token -> { kind, label, cost, memMb, since, speed }
let lastViewerEndedAt = 0;
let viewerSeq = 0;

const whenGone = (child, fn) => {
  let done = false;
  const once = () => { if (!done) { done = true; fn(); } };
  if (child && typeof child.once === "function") { child.once("exit", once); child.once("error", once); }
  return once;
};

const viewer = {
  // Register a viewer-facing encoder until its process is gone. Returns the
  // entry ({ id, release, … }); `meta`: { kind, label, cost, memMb }.
  track(child, meta = {}) {
    const id = ++viewerSeq;
    const entry = {
      id, kind: meta.kind || "encode", label: meta.label || "", cost: meta.cost || 1, memMb: meta.memMb || 0, since: deps.now(), pid: child && child.pid, release: null,
      // `idle()`: its viewer has gone (it is still running); `reclaim()`: stop it
      idle: typeof meta.idle === "function" ? meta.idle : null,
      reclaim: typeof meta.reclaim === "function" ? meta.reclaim : null,
    };
    // a viewer is being encoded for: nothing speculative runs beside it
    speculative.shedAll("a viewer's encoder started");
    viewers.set(id, entry);
    entry.release = whenGone(child, () => {
      if (!viewers.delete(id)) return;
      lastViewerEndedAt = deps.now();
      background._viewersChanged();
    });
    background._viewersChanged();
    return entry;
  },
  count: () => viewers.size,
  busy: () => viewers.size > 0,
  list: () => [...viewers.values()].map(({ release, idle, reclaim, ...v }) => ({ ...v, idle: isIdle({ idle }) })),
  // Has no viewer encode been running for the quiet period?
  quiet: (now = deps.now()) => viewers.size === 0 && now - lastViewerEndedAt >= QUIET_MS,
  // what is being encoded for viewers, in the budget's units (encbudget.js);
  // `only`: a filter on the entries
  cost: (only = null) => { let c = 0; for (const v of viewers.values()) if (!only || only(v)) c += v.cost; return c; },
  memMb: () => { let m = 0; for (const v of viewers.values()) m += v.memMb; return m; },
  // What an admission counts: the same, less the encoders whose viewer has
  // gone (see track's `idle`) — they are stopped when the room is wanted.
  load: (only = null) => { let c = 0; for (const v of viewers.values()) if (!isIdle(v) && (!only || only(v))) c += v.cost; return c; },
  // Another viewer's encode was let in: stop the ones whose viewer has gone.
  // Returns how many were asked to stop.
  reclaim: () => {
    let n = 0;
    for (const v of [...viewers.values()]) {
      if (!isIdle(v) || !v.reclaim) continue;
      try { v.reclaim(); n++; } catch {}
    }
    return n;
  },
};
const isIdle = (v) => { try { return !!(v.idle && v.idle()); } catch { return false; } };

// -------------------------------------------------------- speculative work

const specs = new Map(); // id -> { kind, label, cost, memMb, since, pid, onShed }
let specSeq = 0;
const speculative = {
  // Register a speculative process until it is gone, shed, or released by
  // its owner (who then registers it as viewer work). Returns { id, release }.
  // meta: { kind, label, cost, memMb, onShed(why) } — onShed stops it.
  track(child, meta = {}) {
    const id = ++specSeq;
    specs.set(id, { id, kind: meta.kind || "warm-up", label: meta.label || "", cost: meta.cost || 1, memMb: meta.memMb || 0, since: deps.now(), pid: child && child.pid, onShed: typeof meta.onShed === "function" ? meta.onShed : null });
    const release = () => { specs.delete(id); };
    whenGone(child, release);
    return { id, release };
  },
  count: () => specs.size,
  list: () => [...specs.values()].map(({ onShed, ...s }) => s),
  // Stop every speculative process. Returns how many.
  shedAll(why = "") {
    let n = 0;
    for (const s of [...specs.values()]) {
      specs.delete(s.id);
      stats.specShed++;
      try { if (s.onShed) s.onShed(why); } catch {}
      n++;
    }
    return n;
  },
};

// --------------------------------------------------------- background work

const jobs = new Map(); // id -> { kind, label, weight, child, pausable, paused, since, onShed } — a place in the budget
const waiters = []; // { weight, kind, meta, resolve }
let bgSeq = 0;
let quietTimer = null;
const stats = { started: 0, paused: 0, resumed: 0, shed: 0, heldBack: 0, specShed: 0 };

const used = () => { let u = 0; for (const j of jobs.values()) u += j.weight; return u; };
const weightOf = (kind) => (WEIGHTS[kind] == null ? 1 : WEIGHTS[kind]);

const lower = (child) => {
  if (!child || !child.pid) return child;
  try { deps.setPriority(child.pid, PRIORITY.background); } catch {}
  if (deps.platform === "linux") deps.ionice(child.pid);
  return child;
};

const pause = (j) => {
  if (!j.pausable || j.paused || !j.child) return;
  if (deps.platform === "win32") return; // no such call: the idle class is the yield
  try { deps.kill(j.child, "SIGSTOP"); j.paused = true; stats.paused++; console.log(`[cpu] paused ${j.kind} (${j.label}) — a viewer is being encoded for`); } catch {}
};
const resume = (j) => {
  if (!j.paused || !j.child) return;
  try { deps.kill(j.child, "SIGCONT"); } catch {}
  j.paused = false;
  stats.resumed++;
  console.log(`[cpu] resumed ${j.kind} (${j.label})`);
};

// A place in the budget, from the moment it is granted: { id, attach(child),
// release() }. attach() hands it the process (lowest priority, paused while
// viewers encode when `pausable`, released by itself when the process is
// gone); release() is for a caller that started nothing after all.
const grant = (kind, meta = {}) => {
  const id = ++bgSeq;
  const j = { id, kind, label: meta.label || "", weight: weightOf(kind), child: null, pausable: !!meta.pausable, paused: false, since: deps.now(), onShed: meta.onShed || null };
  jobs.set(id, j);
  stats.started++;
  const release = () => { if (jobs.delete(id)) { background._arm(); drain(); } };
  return {
    id,
    release,
    attach(child) {
      j.child = child;
      lower(child);
      whenGone(child, release);
      if (viewer.busy()) pause(j); // a viewer encode began between the grant and the start
      return child;
    },
  };
};

const drain = () => {
  if (!viewer.quiet()) return;
  for (const j of jobs.values()) resume(j);
  // hand the budget to whoever is waiting, in order
  while (waiters.length) {
    const w = waiters[0];
    if (used() > 0 && used() + w.weight > BUDGET) break;
    waiters.shift();
    w.resolve(grant(w.kind, w.meta));
  }
};

const background = {
  BUDGET, QUIET_MS,
  threads: () => Math.max(1, Math.floor(deps.cpus() / 2)),
  used,
  // May a background job of this kind start right now?
  mayStart(kind = "encode") {
    const w = weightOf(kind);
    if (!viewer.quiet()) return false;
    return used() === 0 || used() + w <= BUDGET;
  },
  // Resolves with a place in the budget (see grant) when one may start: no
  // viewer encode running, none for the quiet period, room in the budget —
  // in the order asked.   meta: { label, pausable, onShed }
  gate(kind = "encode", meta = {}) {
    if (!waiters.length && background.mayStart(kind)) return Promise.resolve(grant(kind, meta));
    stats.heldBack++;
    return new Promise((resolve) => {
      waiters.push({ weight: weightOf(kind), kind, meta, resolve });
      background._arm();
    });
  },
  // A small helper process (a placeholder picture, a probe): the lowest
  // priority is all its manners — it is not counted and not held back.
  lower,
  list: () => [...jobs.values()].map((j) => ({ id: j.id, kind: j.kind, label: j.label, weight: j.weight, paused: j.paused, since: j.since, pid: (j.child && j.child.pid) || null })),
  // The viewers' encoders are falling behind: stop the newest background job
  // that can be put back in its queue. Returns its label, or null.
  shedNewest(why = "") {
    // what nobody is waiting for at all goes first
    if (specs.size) {
      const label = [...specs.values()].map((x) => x.label || x.kind).join(", ");
      speculative.shedAll(why);
      return label;
    }
    const cand = [...jobs.values()].filter((j) => typeof j.onShed === "function" && j.child).sort((x, y) => y.since - x.since || y.id - x.id)[0];
    if (!cand) return null;
    stats.shed++;
    console.warn(`[cpu] shedding ${cand.kind} (${cand.label})${why ? ` — ${why}` : ""}; it goes back in its queue`);
    try { if (cand.paused) deps.kill(cand.child, "SIGCONT"); } catch {}
    try { cand.onShed(); } catch {}
    return cand.label || cand.kind;
  },
  _viewersChanged() {
    if (viewer.busy()) {
      if (quietTimer) { deps.clearTimeout(quietTimer); quietTimer = null; }
      for (const j of jobs.values()) pause(j);
    } else {
      background._arm();
    }
  },
  // Look again when the quiet period is over.
  _arm() {
    if (quietTimer || viewer.busy()) return;
    if (!waiters.length && ![...jobs.values()].some((j) => j.paused)) return;
    const wait = Math.max(0, lastViewerEndedAt + QUIET_MS - deps.now());
    quietTimer = deps.setTimeout(() => { quietTimer = null; drain(); background._arm(); }, wait + 5);
  },
};

// For the admin page and the healer: what is running for whom.
const status = () => ({
  viewers: viewer.list(),
  background: background.list(),
  speculative: speculative.list(),
  backgroundBudget: BUDGET,
  backgroundUsed: used(),
  waiting: waiters.map((w) => w.kind),
  quiet: viewer.quiet(),
  quietMs: QUIET_MS,
  threadsBackground: background.threads(),
  pauses: deps.platform === "win32" ? "priority" : "signal",
  stats: { ...stats },
});

const _reset = () => {
  viewers.clear();
  specs.clear();
  jobs.clear();
  waiters.length = 0;
  lastViewerEndedAt = 0;
  if (quietTimer) { deps.clearTimeout(quietTimer); quietTimer = null; }
  for (const k of Object.keys(stats)) stats[k] = 0;
};

module.exports = { viewer, background, speculative, status, PRIORITY, QUIET_MS, BUDGET, WEIGHTS, _internals: { deps, jobs, viewers, waiters, stats, drain, _reset } };
