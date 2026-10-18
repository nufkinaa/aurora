// Who gets the event loop next, for the few requests that are heavy.
//
// The server answers everything on one thread. A request that takes 5–50 ms
// of it (composing Home, the library list, a search) is fine alone; sixty of
// them arriving together are handled back to back, and every other request —
// including a viewer's next video segment, already on disk — waits for the
// whole run. Measured: one signed-in device asking for Home on 64 connections
// made everybody else wait 6.4 s.
//
// Two rules, applied only to the routes that say so (lane.middleware()):
//
//   HEAVY REQUESTS TAKE TURNS WITH EVERYTHING ELSE. The first one runs at
//   once; the next is started from setImmediate, so everything else that has
//   arrived — segments, pictures, health checks, other people's small
//   requests — is answered in between. A turn's worth of heavy work is one
//   request when the server is otherwise quiet, and grows with how long the
//   other work took (as much time again, SLICE_MAX_MS at most): under a rush
//   the heavy requests get about half of the loop instead of one place per
//   lap, so they are not starved by the very traffic they give way to — and
//   nobody else waits behind more than one slice of them.
//
//   A FAIR SHARE EACH. A client (its session, else its address) may have
//   `perClient` heavy requests in hand at once; further ones wait their turn,
//   up to `perClientQueue` of them, taken in rotation with other clients'.
//   Past that the answer is 429 with Retry-After at once — and a request that
//   has waited `maxWaitMs` gets the same. The website's boot (Home and the
//   library together) and the TV's prefetch are far inside the limits.
//
// A route that can answer from memory (lib/answermemo.js) does so BEFORE it
// enters the lane: a cached answer is never queued.
"use strict";

const DEFAULTS = {
  perClient: 4, // in hand at once, per client
  perClientQueue: 24, // waiting, per client
  maxQueue: 400, // waiting, everyone together
  maxWaitMs: 8000,
  retryAfterSec: 2,
  sliceMinMs: 8, // heavy work per turn when little else is going on (one request, in practice)
  sliceMaxMs: 60, // …and at most, when everything else is busy too
  sliceMaxJobs: 12, // (requests whose work happens later, off this clock: no more than this many started per turn)
};

const createLane = (opts = {}) => {
  const cfg = { ...DEFAULTS, ...opts };
  const d = {
    setImmediate: opts.setImmediate || ((fn) => setImmediate(fn)),
    setTimeout: opts.setTimeout || ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }),
    now: opts.now || (() => Date.now()),
    // a finer clock for the slices (the tests hand one in, or leave time standing still)
    clock: opts.clock || (opts.now ? opts.now : () => performance.now()),
  };
  const clients = new Map(); // key -> { active, queue: [job] }
  const ring = []; // keys with something waiting, in turn order
  let waiting = 0;
  let startedThisTurn = false;
  let pumpScheduled = false;
  let sweepArmed = false;
  let lastSliceEnd = d.clock();
  const stats = { admitted: 0, queued: 0, refused: 0, timedOut: 0, maxWaiting: 0 };

  const stateOf = (key) => {
    let c = clients.get(key);
    if (!c) { c = { active: 0, queue: [] }; clients.set(key, c); }
    return c;
  };
  const forget = (key, c) => { if (!c.active && !c.queue.length) clients.delete(key); };

  const start = (key, c, job) => {
    c.active++;
    stats.admitted++;
    startedThisTurn = true;
    schedulePump(); // the turn ends at the next setImmediate
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      c.active--;
      forget(key, c);
      schedulePump();
    };
    try {
      job.run(release);
    } catch (e) {
      release();
      throw e;
    }
  };

  // Next in rotation whose client has room, or null.
  const next = () => {
    for (let i = 0; i < ring.length; i++) {
      const key = ring[i];
      const c = clients.get(key);
      if (!c || !c.queue.length) { ring.splice(i--, 1); continue; }
      if (c.active >= cfg.perClient) continue;
      const job = c.queue.shift();
      waiting--;
      ring.splice(i, 1);
      if (c.queue.length) ring.push(key); // to the back: others go first
      return { key, c, job };
    }
    return null;
  };

  const pump = () => {
    pumpScheduled = false;
    startedThisTurn = false;
    // the ones that waited too long are told so, without taking a turn
    const now = d.now();
    for (const key of [...ring]) {
      const c = clients.get(key);
      if (!c) continue;
      while (c.queue.length && now - c.queue[0].at > cfg.maxWaitMs) {
        const job = c.queue.shift();
        waiting--;
        stats.timedOut++;
        try { job.refuse("waited too long"); } catch {}
      }
      forget(key, c);
    }
    // This turn's slice: as long as everything else took since the last one,
    // within the two bounds. Synchronous handlers (Home, the library list)
    // run inside start(), so the clock sees what they cost.
    const sliceStart = d.clock();
    const budget = Math.min(cfg.sliceMaxMs, Math.max(cfg.sliceMinMs, sliceStart - lastSliceEnd));
    for (let started = 0; started < cfg.sliceMaxJobs; started++) {
      const n = next();
      if (!n) break;
      start(n.key, n.c, n.job);
      if (d.clock() - sliceStart >= budget) break;
    }
    lastSliceEnd = d.clock();
    armSweep();
  };
  // While something waits and nothing is moving (its client is at its limit),
  // look again once a second: a request must not wait past maxWaitMs unseen.
  const armSweep = () => {
    if (sweepArmed || !waiting) return;
    sweepArmed = true;
    d.setTimeout(() => { sweepArmed = false; schedulePump(); }, 1000);
  };
  const schedulePump = () => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    d.setImmediate(pump);
  };

  // run(release) is called when it is this request's turn; refuse(why) when
  // it will not get one. Returns "run" | "queued" | "refused".
  const enter = (key, run, refuse) => {
    const c = stateOf(key);
    const job = { run, refuse, at: d.now() };
    if (!startedThisTurn && c.active < cfg.perClient && !waiting) {
      start(key, c, job);
      return "run";
    }
    if (c.queue.length >= cfg.perClientQueue || waiting >= cfg.maxQueue) {
      stats.refused++;
      forget(key, c);
      try { refuse(c.queue.length >= cfg.perClientQueue ? "too many at once from this device" : "the server is busy"); } catch {}
      return "refused";
    }
    c.queue.push(job);
    waiting++;
    stats.queued++;
    if (waiting > stats.maxWaiting) stats.maxWaiting = waiting;
    if (!ring.includes(key)) ring.push(key);
    schedulePump();
    return "queued";
  };

  // Who is asking: the session when there is one (so a household behind one
  // address is not one client), else the address.
  const clientKey = (req) => {
    try {
      const sid = req.headers["x-session"] || (req.headers.cookie && /(?:^|;\s*)aurora_session=([^;]+)/.exec(req.headers.cookie) || [])[1]; // lib/authz.js COOKIE
      if (sid) return `s:${String(sid).slice(0, 24)}`;
    } catch {}
    // the address as lib/ratelimit.js reads it: X-Forwarded-For only from a
    // trusted proxy, so a client cannot make itself many clients with a header
    let ip;
    try { ip = require("./ratelimit")._internals.addressOf(req); } catch { ip = String((req.socket && req.socket.remoteAddress) || "?").replace("::ffff:", ""); }
    return `a:${ip}`;
  };

  // Express middleware for a heavy route. The slot is held until the answer
  // has gone out (or the client went away).
  const middleware = (keyOf = clientKey) => (req, res, next) => {
    enter(
      keyOf(req),
      (release) => {
        if (res.writableEnded || res.destroyed) return release(); // gave up while waiting
        res.once("finish", release);
        res.once("close", release);
        next();
      },
      (why) => {
        if (res.headersSent) return;
        res.setHeader("Retry-After", String(cfg.retryAfterSec));
        res.status(429).json({ error: `Too many requests at once (${why}) — try again in a moment.`, retryAfter: cfg.retryAfterSec });
      },
    );
  };

  const status = () => ({ waiting, clients: clients.size, ...stats, limits: { perClient: cfg.perClient, perClientQueue: cfg.perClientQueue, maxQueue: cfg.maxQueue, maxWaitMs: cfg.maxWaitMs } });

  return { enter, middleware, clientKey, status, _internals: { clients, ring, pump, cfg } };
};

// The server's one lane for its heavy API routes.
const heavy = createLane();

module.exports = { createLane, heavy, DEFAULTS };
