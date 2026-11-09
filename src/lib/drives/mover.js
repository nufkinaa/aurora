// Moving titles between drives (elia 2026-11-09). Two reasons, one mover:
//
//   cold      "Keep the fast drive for new and 4K titles" (on by default): when
//             the fast drive's room above its reserve falls under 15%, the
//             titles nobody has played for 60+ days move, oldest first, to the
//             roomiest slower drive, until it is back at 20% (rules.coldNeed,
//             rules.coldTitles).
//   evacuate  "Stop using this drive" → "Move them to the other drives first":
//             every title on that drive moves to the others; when none is
//             left, the drive is removed (index.js finishRemove).
//
// One title at a time, and safely:
//   1. its files are copied into a hidden temp folder on the target drive
//      (`.aurora-moving-<token>`: the library walk skips dot folders), in
//      chunks of a few seconds, by a child process at the lowest CPU and I/O
//      priority (run.js `low`) — never in the server, since either drive may
//      be a network drive that stops answering;
//   2. before every chunk: the title itself starting to play ABANDONS a cold
//      move (the temp folder goes, the original is never touched, the title
//      is left alone for a week) and PAUSES an evacuation; anybody watching
//      from either drive, or a drive not answering, PAUSES it;
//   3. every file is checked: same length, same hash of its first and last MB;
//   4. each file is renamed into place on the target (all or nothing per file);
//   5. the library walk runs (a title keeps its id: ids come from the path
//      under the library folder, which is the same on the new drive), the
//      original is deleted — only while nobody plays it — and one log line
//      says what moved where.
// Everything is in data/drives.json (`moves.current`): after a restart the
// move goes on from the file and the byte where it stopped.
"use strict";
const path = require("path");
const crypto = require("crypto");

const SEC = 1000;
const DAY = 86400 * SEC;
const size = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

module.exports = (ctx) => {
  // ctx: { deps, data, save, live, stateOf, onPath, check, rules, run, limits,
  //        isUnderDir, inUseDrives, candidatesFor, finishRemove }
  const { deps, rules } = ctx;
  const L = ctx.limits.mover;
  const st = { busy: false, nextAt: 0, stopped: false, kicks: 0, started: new Set() };

  const moves = () => {
    const d = ctx.data();
    if (!d.moves || typeof d.moves !== "object") d.moves = {};
    const m = d.moves;
    if (!Array.isArray(m.recent)) m.recent = [];
    if (!m.skip || typeof m.skip !== "object") m.skip = {};
    if (!m.coldActive || typeof m.coldActive !== "object") m.coldActive = {};
    if (m.current === undefined) m.current = null;
    return m;
  };
  const evac = () => { const d = ctx.data(); if (!d.evacuate || typeof d.evacuate !== "object") d.evacuate = {}; return d.evacuate; };
  const keepFast = () => ctx.data().keepFast !== false;
  const now = () => deps.now();
  const driveById = (id) => ctx.live.drives.find((d) => d.id === id) || null;
  const answering = (id) => ctx.stateOf(id).answering !== false;
  const label = (t) => t.title || path.basename(t.src || t.dir || "");
  const ask = (drive, op, args, ms) => deps.ask(op, args, { timeoutMs: ms, key: `${drive}:move`, low: true });

  // ---------- what plays where ----------
  const playingIds = () => new Set(deps.playingNow().map((p) => p.id));
  const watchedDrives = () => {
    const out = new Set();
    for (const p of deps.playingNow()) {
      const o = p.path ? ctx.onPath(p.path) : null;
      if (o) out.add(o.drive.id);
    }
    return out;
  };

  // ---------- the titles on a drive ----------
  const titlesOn = (driveId, all = deps.libraryTitles()) => all.filter((t) => {
    const o = ctx.onPath(t.dir);
    return o && o.drive.id === driveId;
  });
  const roomOf = (driveId) => {
    const s = ctx.stateOf(driveId);
    if (s.free == null || !s.total) return null;
    return s.free - rules.reserveFor(s.total);
  };
  // the library folder of the kind on `driveId` that a title can land in
  const targetFor = (t, { exclude = [], prefer = null, slowerThan = null } = {}) => {
    const kind = t.kind === "show" ? "show" : "movie";
    const cands = ctx.candidatesFor(kind).filter((c) => c.drive && !exclude.includes(c.drive) && c.accepts !== false && c.answering !== false && c.free != null);
    const scoreOf = (id) => { const sc = ctx.data().scores[id]; return sc && sc.value != null ? sc.value : 50; };
    const room = cands.filter((c) => (c.free - (c.committed || 0)) - rules.reserveFor(c.total) >= (t.sizeBytes || 0) && (slowerThan == null || scoreOf(c.drive) < slowerThan));
    if (!room.length) return null;
    if (prefer) { const p = room.find((c) => c.drive === prefer); if (p) return p; }
    room.sort((a, b) => (b.free - (b.committed || 0)) - (a.free - (a.committed || 0)));
    return room[0];
  };

  // ---------- planning ----------
  const plan = (t, target, reason) => {
    const token = crypto.randomBytes(4).toString("hex");
    const rel = path.relative(t.root, t.dir);
    return {
      token, reason, titleId: t.id, ids: t.ids || [t.id], kind: t.kind, title: label(t),
      from: ctx.onPath(t.dir).drive.id, to: target.drive, fromRoot: t.root, toRoot: target.root,
      src: t.dir, temp: path.join(target.root, `.aurora-moving-${token}`), dst: path.join(target.root, rel),
      sizeBytes: t.sizeBytes || 0, bytes: null, copied: 0, files: null, fileIdx: 0,
      phase: "listing", startedAt: now(), paused: null,
    };
  };
  const planNext = () => {
    const m = moves();
    const all = deps.libraryTitles();
    const playing = playingIds();
    // 1. evacuations first: a drive the admin is taking out of use
    for (const [id, ev] of Object.entries(evac())) {
      const left = titlesOn(id, all);
      ev.left = left.length;
      if (!left.length) {
        if (!deps.downloadsTo(id)) { ctx.finishRemove(id, { moved: ev.moved || 0 }); }
        else ev.why = "waits for a download that is landing there";
        continue;
      }
      if (!answering(id)) { ev.why = "the drive isn't answering"; continue; }
      const ready = left.filter((t) => !t.downloading && !t.ids.some((x) => playing.has(x)));
      if (!ready.length) { ev.why = "its titles are being played or downloaded"; continue; }
      let pickT = null;
      let target = null;
      for (const t of ready) { target = targetFor(t, { exclude: Object.keys(evac()) }); if (target) { pickT = t; break; } }
      if (!pickT) { ev.why = "no room on the other drives"; continue; }
      ev.why = null;
      return plan(pickT, target, "evacuate");
    }
    // 2. the fast drive running low
    if (!keepFast()) { m.coldActive = {}; return null; }
    const infos = ctx.inUseDrives();
    const fast = rules.fastDrive(infos);
    for (const k of Object.keys(m.coldActive)) if (k !== fast) delete m.coldActive[k];
    if (!fast) return null;
    const fs_ = infos.find((d) => d.id === fast);
    const need = rules.coldNeed(fs_, !!m.coldActive[fast]);
    if (!need) { delete m.coldActive[fast]; return null; }
    m.coldActive[fast] = true;
    const fastScore = fs_.score == null ? 50 : fs_.score;
    const cands = rules.coldTitles(titlesOn(fast, all).map((t) => ({ ...t, playing: t.ids.some((x) => playing.has(x)), skipUntil: m.skip[t.id] || 0 })), { now: now(), idleDays: L.idleDays });
    for (const t of cands) {
      const target = targetFor(t, { exclude: [fast, ...Object.keys(evac())], slowerThan: fastScore });
      if (target) return plan(t, target, "cold");
    }
    return null;
  };

  // ---------- one move, step by step ----------
  const record = (cur, result) => {
    const m = moves();
    m.recent.unshift({ title: cur.title, kind: cur.kind, from: cur.fromRoot, to: cur.toRoot, bytes: cur.bytes != null ? cur.bytes : cur.sizeBytes, reason: cur.reason, result, at: now() });
    m.recent = m.recent.slice(0, L.keepRecent);
  };
  const finish = (cur, result, line) => {
    const m = moves();
    record(cur, result);
    m.current = null;
    ctx.save();
    console.log(`[drives] ${line}`);
  };
  const abandon = async (cur, why, { skipDays = 0 } = {}) => {
    // the original was never touched: only the temp copy goes
    await ask(cur.to, "rmtree", { dir: cur.temp }, L.stepTimeoutMs).catch(() => {});
    if (skipDays) moves().skip[cur.titleId] = now() + skipDays * DAY;
    finish(cur, `stopped: ${why}`, `move of "${cur.title}" to ${cur.toRoot} stopped: ${why} (the original is untouched)`);
    return "abandoned";
  };
  const pause = (cur, why) => {
    if (cur.paused !== why) { cur.paused = why; ctx.save(); console.log(`[drives] move of "${cur.title}" paused: ${why}`); }
    st.nextAt = now() + L.pauseRetryMs;
    return "paused";
  };
  // before each step: is it still right to go on?
  const gate = (cur) => {
    if (cur.reason === "cold" && !keepFast()) return { stop: "the fast drive is no longer kept for new titles" };
    if (cur.reason === "evacuate" && !evac()[cur.from]) return { stop: "the drive is in use again" };
    const playingNow = cur.ids.some((x) => playingIds().has(x));
    if (playingNow) return cur.reason === "cold" ? { stop: "someone started playing it", skipDays: 7 } : { wait: "it is being played" };
    if (!answering(cur.from) || !answering(cur.to)) return { wait: "a drive isn't answering" };
    const watched = watchedDrives();
    if (watched.has(cur.from) || watched.has(cur.to)) return { wait: "someone is watching from that drive" };
    return null;
  };

  const advance = async (cur) => {
    for (;;) {
      if (st.stopped) return "stopped";
      // (once it is in place, only "nobody plays it" matters: the original goes)
      if (cur.phase !== "removing") {
        const g = gate(cur);
        if (g && g.stop) return abandon(cur, g.stop, g);
        if (g && g.wait) return pause(cur, g.wait);
      }
      if (cur.paused) { cur.paused = null; ctx.save(); }
      if (cur.phase === "listing") {
        const r = await ask(cur.from, "tree", { dir: cur.src }, L.stepTimeoutMs);
        if (!r || !r.ok) {
          if (r && r.timeout) { ctx.check(driveById(cur.from)).catch(() => {}); return pause(cur, "the drive did not answer"); }
          return abandon(cur, `could not read it (${(r && r.error) || "no answer"})`, { skipDays: 1 });
        }
        cur.files = r.result.files;
        cur.bytes = r.result.bytes;
        const room = roomOf(cur.to);
        if (room != null && room < cur.bytes) return abandon(cur, "no room on the target drive any more");
        cur.phase = "copying";
        ctx.save();
        console.log(`[drives] moving "${cur.title}" (${size(cur.bytes)}, ${cur.files.length} file${cur.files.length === 1 ? "" : "s"}) from ${cur.fromRoot} to ${cur.toRoot} — ${cur.reason === "cold" ? "nobody has played it for a long while and the fast drive is running low" : "the drive is being taken out of use"}`);
        continue;
      }
      if (cur.phase === "copying") {
        if (cur.fileIdx >= cur.files.length) { cur.phase = "verifying"; ctx.save(); continue; }
        const f = cur.files[cur.fileIdx];
        // (the first chunk of a file this process did not start: a restart, so a little is copied again)
        const k = `${cur.token}:${cur.fileIdx}`;
        const resume = !st.started.has(k);
        st.started.add(k);
        const r = await ask(cur.to, "copy", { src: path.join(cur.src, f.rel), dst: path.join(cur.temp, f.rel), maxMs: L.chunkMs, resume }, L.chunkMs + L.stepTimeoutMs);
        if (!r || !r.ok) {
          if (r && (r.timeout || r.busy)) {
            ctx.check(driveById(cur.to)).catch(() => {});
            ctx.check(driveById(cur.from)).catch(() => {});
            return pause(cur, "a drive did not answer during the copy");
          }
          return abandon(cur, `the copy failed (${(r && r.error) || "no answer"})`, { skipDays: 1 });
        }
        const before = cur.files.slice(0, cur.fileIdx).reduce((n, x) => n + x.size, 0);
        cur.copied = before + r.result.copied;
        if (r.result.done) cur.fileIdx++;
        ctx.save();
        continue;
      }
      if (cur.phase === "verifying") {
        const srcs = cur.files.map((f) => path.join(cur.src, f.rel));
        const dsts = cur.files.map((f) => path.join(cur.temp, f.rel));
        const a = await ask(cur.from, "ends", { paths: srcs }, L.stepTimeoutMs);
        const b = await ask(cur.to, "ends", { paths: dsts }, L.stepTimeoutMs);
        if (!a || !a.ok || !b || !b.ok) return pause(cur, "a drive did not answer while the copy was checked");
        const bad = cur.files.find((f, i) => {
          const x = a.result[srcs[i]];
          const y = b.result[dsts[i]];
          return !x || !y || x.error || y.error || x.size !== y.size || x.head !== y.head || x.tail !== y.tail;
        });
        if (bad) return abandon(cur, `the copy of ${bad.rel} did not match`, { skipDays: 1 });
        cur.phase = "landing";
        ctx.save();
        continue;
      }
      if (cur.phase === "landing") {
        const r = await ask(cur.to, "land", { temp: cur.temp, dst: cur.dst }, L.stepTimeoutMs);
        if (!r || !r.ok) {
          if (r && r.timeout) return pause(cur, "the target drive did not answer while the files were put in place");
          return abandon(cur, `the files could not be put in place (${(r && r.error) || "no answer"})`, { skipDays: 1 });
        }
        cur.landed = r.result;
        cur.phase = "removing";
        ctx.save();
        continue;
      }
      if (cur.phase === "removing") {
        // both copies are complete now; the original goes only while nobody plays it
        if (cur.ids.some((x) => playingIds().has(x))) return pause(cur, "it is being played — the original goes when it stops");
        try { deps.carryProbes(cur.src, cur.dst, cur.files); } catch {}
        const r = await ask(cur.from, "rmtree", { dir: cur.src }, L.stepTimeoutMs);
        if (!r || !r.ok) return pause(cur, "the original could not be deleted yet");
        await Promise.resolve(deps.rescan()).catch(() => {});
        if (cur.reason === "evacuate" && evac()[cur.from]) evac()[cur.from].moved = (evac()[cur.from].moved || 0) + 1;
        try { if (ctx.afterMove) ctx.afterMove(cur); } catch {}
        finish(cur, "moved", `moved "${cur.title}" (${size(cur.bytes || 0)}) from ${cur.fromRoot} to ${cur.toRoot}${cur.landed && cur.landed.beside && cur.landed.beside.length ? ` (${cur.landed.beside.length} file(s) landed beside one of the same name)` : ""}`);
        return "moved";
      }
      return abandon(cur, `unknown step ${cur.phase}`);
    }
  };

  const step = async () => {
    const m = moves();
    if (!m.current) {
      const p = planNext();
      ctx.save();
      if (!p) { st.nextAt = now() + L.idleEveryMs; return "idle"; }
      m.current = p;
      ctx.save();
    }
    const r = await advance(m.current);
    if (r === "moved" || r === "abandoned") st.nextAt = 0; // the next title at once
    return r;
  };

  // called by the drives round (every few seconds) and after a press
  const kick = ({ force = false } = {}) => {
    if (st.busy || st.stopped) return null;
    if (!force && now() < st.nextAt) return null;
    st.busy = true;
    st.kicks++;
    const p = step().catch((e) => { console.warn(`[drives] the mover failed: ${(e && e.message) || e}`); st.nextAt = now() + L.pauseRetryMs; return "error"; })
      .finally(() => { st.busy = false; });
    return p;
  };
  // run until nothing is left to do now (tests)
  const drain = async (max = 50) => {
    const seen = [];
    for (let i = 0; i < max; i++) {
      while (st.busy) await new Promise((r) => setTimeout(r, 20));
      const r = await kick({ force: true });
      seen.push(r);
      if (r === "idle" || r === "paused" || r === "stopped") break;
    }
    return seen;
  };

  const view = () => {
    const m = moves();
    const c = m.current;
    return {
      keepFast: keepFast(),
      current: c ? { title: c.title, kind: c.kind, from: c.fromRoot, to: c.toRoot, reason: c.reason, bytes: c.bytes != null ? c.bytes : c.sizeBytes, copied: c.copied || 0, phase: c.phase, paused: c.paused || null, startedAt: c.startedAt } : null,
      recent: m.recent.slice(0, L.keepRecent),
    };
  };

  return {
    kick, drain, view, planNext, titlesOn,
    stop: () => { st.stopped = true; },
    start: () => { st.stopped = false; st.nextAt = 0; },
    // a move is out on this drive (Stop moving: the current one stops at its next step)
    busyOn: (id) => { const c = moves().current; return !!(c && (c.from === id || c.to === id)); },
    _st: st,
  };
};
