// Storage drives (2026-11-08, elia: "find drives like that and distribute
// content automatically between them … after the admin selects the drive and
// presses use that drive too"). docs/storage-drives.md is the whole story.
//
//   list()                 every candidate drive with its numbers (cached; the
//                          admin's Drives card)
//   use(id)                "Use this drive too": write check, <mount>/Aurora/
//                          Movies + Shows, config.json's libraries, a rescan
//   setNewDownloads(id,on) "Stop using for new downloads" / "Use again"
//   testAgain(id)          the speed check, again
//   pickRoot(kind, ask)    where a new download goes (rules.pick)
//   onPath(abs)            the drive a path is on, and whether it answers
//   guard(abs, who)        before serving a library file: fails FAST (and tells
//                          the admin) when its drive is not answering
//   spaceOf(abs)           free/total of a NETWORK drive from the last check
//                          (lib/disk.js answers from this instead of a statfs
//                          that could hang in the server)
//
// Everything that touches a network drive runs in a child process with a
// deadline (lib/drives/run.js); local drives are asked in-process (a local
// statfs does not hang). Nothing here starts at require time: start().
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const mounts = require("./mounts");
const rules = require("./rules");
const run = require("./run");
const lazy = require("../lazy");
const configLib = lazy(require, "../../config");

const SEC = 1000;
const MIN = 60 * SEC;
const NET_CHECK_MS = 15 * SEC;     // a network drive in use, asked this often
const NET_IDLE_CHECK_MS = 60 * SEC; // one not in use
const LOCAL_CHECK_MS = 60 * SEC;
const MOUNTS_MS = 30 * SEC;
// (an object, so a test can shorten them)
const limits = { checkTimeoutMs: 6 * SEC, guardTimeoutMs: 3 * SEC };
const USAGE_EVERY_MS = 6 * 3600 * SEC;
const USAGE_TIMEOUT_MS = 3 * MIN;
const SPEED_TIMEOUT_MS = 45 * SEC;
const SPEED_RETRY_MS = 5 * MIN;
const SPEED_MB = 256;
const PREPARE_TIMEOUT_MS = 20 * SEC;

// The words viewers see on the website, the TV and the phone (one sentence,
// sent by the server, so every app says the same).
const VIEWER_MESSAGE = "This title is on a storage drive that isn't answering right now. The admin has been told — try again a little later.";
const CODE = "drive-down";

const deps = {
  platform: () => process.platform,
  now: () => Date.now(),
  readMountinfo: () => {
    for (const f of ["/proc/self/mountinfo", "/proc/mounts"]) {
      try { return fs.readFileSync(f, "utf8"); } catch {}
    }
    return "";
  },
  windowsDisks: () => new Promise((resolve) => {
    require("child_process").execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,Size,FreeSpace,ProviderName,VolumeName,FileSystem | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 20000 }, (err, so) => resolve(err ? null : String(so || "")));
  }),
  // test/e2e seam: folders that count as drives of their own
  //   AURORA_DRIVES_EXTRA='[{"path":"C:\\tmp\\drive2","network":true}]'
  extra: () => {
    try {
      const v = JSON.parse(process.env.AURORA_DRIVES_EXTRA || "[]");
      return (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? { path: x } : x)).filter((x) => x && x.path);
    } catch { return []; }
  },
  ask: (...a) => run.ask(...a),
  stat: (p) => fs.promises.stat(p),
  statfsLocal: async (p) => {
    const s = await fs.promises.statfs(p);
    const total = s.blocks * s.bsize;
    return { total, free: s.bavail * s.bsize, used: Math.max(0, total - s.bfree * s.bsize) };
  },
  watchingNow: () => {
    let n = 0;
    try {
      const realtime = require("../../realtime");
      for (const c of realtime.clients.values()) if (realtime.presenceOf(c) === "watching") n++;
    } catch {}
    try {
      // a stream request in the last minute is someone watching too
      const seen = require("../inuse")._internals.seen;
      const t = Date.now();
      for (const at of seen.values()) if (t - at < MIN) { n++; break; }
    } catch {}
    return n;
  },
  announce: (id, name, type, level, message) => {
    try { require("../health").announce(id, name, type, level, message); } catch {}
  },
  rescan: () => {
    try {
      const scanner = require("../../media/scanner");
      Promise.resolve(scanner.scanAsync({ force: true })).then(() => { try { require("../../realtime").libraryUpdated(); } catch {} }).catch(() => {});
    } catch {}
  },
  configFile: () => path.join(configLib().ROOT, "config.json"),
  titlesUnder: (dirs) => {
    // titles (a film, a show) with a file under one of `dirs` — from the index, no disk
    try {
      const scanner = require("../../media/scanner");
      const libroots = require("../libroots");
      let n = 0;
      for (const m of scanner.index.movies) { const e = scanner.resolve(m.id); if (e && libroots.isUnder(e.path, dirs)) n++; }
      for (const s of scanner.index.shows) {
        const ep = s.seasons && s.seasons[0] && s.seasons[0].episodes && s.seasons[0].episodes[0];
        const e = ep && scanner.resolve(ep.id);
        if (e && libroots.isUnder(e.path, dirs)) n++;
      }
      return n;
    } catch { return 0; }
  },
  stagingRoot: () => { try { return require("../../media/aria2").STAGING_ROOT; } catch { return path.join(os.tmpdir(), "aurora-downloads"); } },
};

// ---------- the store (data/drives.json) ----------
let store = null;
const mem = { scores: {}, noNew: {}, usage: {}, added: {}, alerts: {} };
const data = () => (store ? store.data : mem);
const save = () => { if (store) store.save(); };
const openStore = () => {
  if (store) return store;
  try {
    const { JsonStore } = require("../jsonstore");
    store = new JsonStore(path.join(configLib().DATA_DIR, "drives.json"), { scores: {}, noNew: {}, usage: {}, added: {}, alerts: {} });
    for (const k of Object.keys(mem)) if (!store.data[k] || typeof store.data[k] !== "object") store.data[k] = {};
  } catch { store = null; }
  return store;
};

// ---------- live state ----------
const live = {
  started: false,
  drives: [], // from the mount list: { id, mount, source, fstype, network, readOnly, hard, options, label }
  mountsAt: 0,
  lazyAt: 0, // onPath's own look at the mount list, before start()
  state: new Map(), // id -> { total, free, used, at, answering, downSince, why, roots: {dir: bool}, checking, lastOkAt }
  timers: [],
  speedRunning: null, // id
  speedQueue: [],
  speedWaiting: null, // why the queue waits
  usageRunning: new Set(),
  titles: { at: 0, by: new Map() },
};
const stateOf = (id) => {
  let s = live.state.get(id);
  if (!s) { s = { total: null, free: null, used: null, at: 0, answering: null, downSince: 0, why: null, roots: {}, lastOkAt: 0 }; live.state.set(id, s); }
  return s;
};

const normDir = (p) => {
  const r = path.resolve(String(p || ""));
  return deps.platform() === "win32" ? r.toLowerCase() : r;
};

// Which of Aurora's folders sit on a drive: the library folders (per kind),
// the data folder, the download staging folder.
const auroraDirs = () => {
  const config = configLib();
  const out = [];
  for (const kind of ["movies", "shows"]) for (const dir of (config.LIBRARIES && config.LIBRARIES[kind]) || []) out.push({ kind, dir });
  out.push({ kind: "data", dir: config.DATA_DIR });
  out.push({ kind: "staging", dir: deps.stagingRoot() });
  return out;
};
const dirsOn = (drive) => auroraDirs().filter((d) => {
  const on = mounts.driveOf(d.dir, live.drives, deps.platform());
  return on && on.id === drive.id;
});

// ---------- the mount list ----------
const refreshMounts = async () => {
  let list = [];
  if (deps.platform() === "win32") {
    const json = await deps.windowsDisks();
    list = json ? mounts.parseWindowsDisks(json) : live.drives.filter((d) => !d.extra);
    for (const d of list) {
      // PowerShell gave the numbers already: a local drive needs no other look
      if (!d.network && d.total) Object.assign(stateOf(d.id), { total: d.total, free: d.free, used: d.total - d.free, at: deps.now(), answering: true });
    }
  } else {
    list = mounts.candidates(mounts.parseMounts(deps.readMountinfo()));
  }
  for (const x of deps.extra()) {
    const mount = path.resolve(x.path);
    list.push({ id: mount, mount, source: x.source || mount, fstype: x.network ? "nfs" : "folder", network: !!x.network, readOnly: false, hard: !!x.network, options: [], label: x.label || null, extra: true });
  }
  live.drives = list;
  live.mountsAt = deps.now();
  return list;
};

// ---------- checking a drive ----------
const markDown = (drive, why) => {
  const s = stateOf(drive.id);
  if (s.answering !== false) {
    s.downSince = s.downSince || deps.now();
    console.warn(`[drives] ${drive.mount} is not answering (${why})`);
  }
  s.answering = false;
  s.why = why;
  stepAlert(drive);
};
const markUp = (drive) => {
  const s = stateOf(drive.id);
  if (s.answering === false) console.log(`[drives] ${drive.mount} is answering again`);
  s.answering = true;
  s.downSince = 0;
  s.why = null;
  s.lastOkAt = deps.now();
  stepAlert(drive);
};

const check = async (drive) => {
  const s = stateOf(drive.id);
  const roots = dirsOn(drive).filter((d) => d.kind === "movies" || d.kind === "shows").map((d) => d.dir);
  if (!drive.network) {
    // (a local disk does not hang the way a network one does — but a dying
    // USB disk can be slow: the round never waits on it longer than this)
    const within = (p, ms = 10 * SEC) => Promise.race([p, new Promise((_, no) => { const t = setTimeout(() => no(Object.assign(new Error("slow"), { code: "slow to answer" })), ms); t.unref?.(); })]);
    try {
      const v = await within(deps.statfsLocal(drive.mount));
      Object.assign(s, v, { at: deps.now() });
      const r = {};
      for (const d of roots) { try { r[d] = (await within(fs.promises.stat(d))).isDirectory(); } catch { r[d] = false; } }
      s.roots = r;
      markUp(drive);
    } catch (e) {
      s.why = (e && e.code) || "could not be read";
    }
    return s;
  }
  let res = await deps.ask("check", { path: drive.mount, roots }, { timeoutMs: limits.checkTimeoutMs, key: `${drive.id}:check` });
  // another check of this drive is out and has not timed out: wait for it
  // (two checks at once are no sign of a hang)
  for (let i = 0; res && res.busy && !res.timeout && i < (limits.checkTimeoutMs / 250) + 4; i++) {
    await new Promise((r) => setTimeout(r, 250));
    res = await deps.ask("check", { path: drive.mount, roots }, { timeoutMs: limits.checkTimeoutMs, key: `${drive.id}:check` });
  }
  if (res && res.ok) {
    const { roots: r, ...v } = res.result;
    Object.assign(s, v, { at: deps.now(), roots: r || {} });
    markUp(drive);
  } else if (res && (res.timeout || res.busy)) {
    markDown(drive, res.busy ? "the last check is still waiting for it" : `no answer in ${limits.checkTimeoutMs / SEC} s`);
  } else {
    markDown(drive, (res && res.error) || "the check failed");
  }
  return s;
};

// ---------- the alert to the admin ----------
const clock = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const stepAlert = (drive) => {
  const inUse = dirsOn(drive).some((d) => d.kind === "movies" || d.kind === "shows");
  if (!inUse) return;
  const s = stateOf(drive.id);
  const alerts = data().alerts;
  const { state, send } = rules.alertStep(alerts[drive.id], { down: s.answering === false, now: deps.now() });
  const changed = JSON.stringify(alerts[drive.id] || null) !== JSON.stringify(state);
  alerts[drive.id] = state;
  if (changed) save();
  if (!send) return;
  const id = `drive:${drive.id}`;
  const name = `Storage drive ${drive.mount}`;
  if (send.type === "down") {
    const titles = titlesOn(drive);
    const tried = state.viewers.length;
    deps.announce(id, name, "alert", "critical",
      `Storage drive ${drive.mount} isn't answering since ${clock(state.downSince)} — ${titles} title${titles === 1 ? "" : "s"} can't play.` +
      `${tried ? ` ${tried} ${tried === 1 ? "person" : "people"} tried to watch.` : ""} New downloads go to the other drives until it answers again.`);
  } else {
    deps.announce(id, name, "recovered", "ok",
      `Storage drive ${drive.mount} is answering again after ${send.minutes} min${send.viewers ? ` — ${send.viewers} ${send.viewers === 1 ? "person" : "people"} tried to watch meanwhile` : ""}. Its titles play again.`);
  }
};

const titlesOn = (drive, now = deps.now()) => {
  const hit = live.titles.by.get(drive.id);
  if (hit && now - hit.at < 30 * SEC) return hit.n;
  const dirs = dirsOn(drive).filter((d) => d.kind === "movies" || d.kind === "shows").map((d) => d.dir);
  const n = dirs.length ? deps.titlesUnder(dirs) : 0;
  live.titles.by.set(drive.id, { at: now, n });
  return n;
};

// ---------- what Aurora keeps there ----------
const measureUsage = async (drive) => {
  if (live.usageRunning.has(drive.id)) return;
  const dirs = dirsOn(drive).map((d) => d.dir);
  if (!dirs.length) return;
  // (nested folders — the staging folder inside the data folder — once)
  const top = dirs.filter((d) => !dirs.some((o) => o !== d && normDir(d).startsWith(normDir(o) + path.sep)));
  live.usageRunning.add(drive.id);
  try {
    const res = await deps.ask("usage", { paths: top, budgetMs: USAGE_TIMEOUT_MS - 20 * SEC }, { timeoutMs: USAGE_TIMEOUT_MS, key: `${drive.id}:usage` });
    if (res && res.ok) {
      data().usage[drive.id] = { bytes: res.result.bytes, files: res.result.files, partial: !!res.result.partial, at: deps.now() };
      save();
    } else if (res && res.timeout && drive.network) markDown(drive, "counting Aurora's files did not finish");
  } finally {
    live.usageRunning.delete(drive.id);
  }
};

// ---------- the speed check ----------
const testDirFor = (drive) => {
  const mine = dirsOn(drive).filter((d) => d.kind === "movies" || d.kind === "shows");
  if (mine.length) return mine[0].dir;
  const data = dirsOn(drive).find((d) => d.kind === "data");
  return data ? data.dir : null;
};
const queueSpeed = (id) => {
  if (live.speedRunning === id || live.speedQueue.includes(id)) return;
  live.speedQueue.push(id);
  setImmediate(pumpSpeed);
};
const pumpSpeed = async () => {
  if (live.speedRunning || !live.speedQueue.length) return;
  // never while somebody is watching: the test reads and writes the drive flat out
  if (deps.watchingNow() > 0) {
    live.speedWaiting = "waits until nobody is watching";
    const t = setTimeout(pumpSpeed, SPEED_RETRY_MS);
    t.unref?.();
    return;
  }
  live.speedWaiting = null;
  const id = live.speedQueue.shift();
  const drive = live.drives.find((d) => d.id === id);
  const dir = drive && testDirFor(drive);
  if (!drive || !dir || stateOf(id).answering === false) return setImmediate(pumpSpeed);
  live.speedRunning = id;
  try {
    const res = await deps.ask("speed", { dir, sizeMB: SPEED_MB, budgetMs: 18000 }, { timeoutMs: SPEED_TIMEOUT_MS, key: `${id}:speed` });
    if (res && res.ok) {
      const m = res.result;
      const sc = rules.score(m);
      data().scores[id] = { ...sc, measured: { writeMBps: round1(m.writeMBps), readMBps: round1(m.readMBps), iops: Math.round(m.iops || 0), latencyMs: round2(m.latencyMs), readMethod: m.readMethod, randomMethod: m.randomMethod, writtenMB: m.writtenMB, seconds: round1(m.seconds) }, at: deps.now() };
      save();
      console.log(`[drives] speed of ${drive.mount}: ${sc ? `${sc.value} (${sc.word})` : "?"} — write ${round1(m.writeMBps)} MB/s, read ${round1(m.readMBps)} MB/s (${m.readMethod}), ${Math.round(m.iops || 0)} random reads/s`);
    } else {
      data().scores[id] = { ...(data().scores[id] || {}), error: res && res.timeout ? "the speed check did not finish in time" : (res && res.error) || "the speed check failed", errorAt: deps.now() };
      save();
      if (res && res.timeout && drive.network) markDown(drive, "the speed check did not finish");
    }
  } finally {
    live.speedRunning = null;
    setImmediate(pumpSpeed);
  }
};
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

// ---------- the rounds ----------
const round = async ({ all = false } = {}) => {
  const now = deps.now();
  // (Windows asks PowerShell for its drive letters: not every half minute)
  const mountsEvery = deps.platform() === "win32" ? 5 * MIN : MOUNTS_MS;
  if (all || now - live.mountsAt >= mountsEvery || !live.mountsAt) await refreshMounts();
  for (const d of live.drives) {
    const s = stateOf(d.id);
    const inUse = dirsOn(d).some((x) => x.kind === "movies" || x.kind === "shows");
    const every = d.network ? (inUse ? NET_CHECK_MS : NET_IDLE_CHECK_MS) : LOCAL_CHECK_MS;
    // a drive that is down is asked again at the in-use pace (its answer is what resumes everything)
    if (all || !s.at || now - s.at >= every || s.answering === false) await check(d);
    if (inUse && s.answering !== false) {
      const u = data().usage[d.id];
      if (!u || now - u.at >= USAGE_EVERY_MS) measureUsage(d).catch(() => {});
      const sc = data().scores[d.id];
      if (!sc || (!sc.value && !sc.errorAt)) queueSpeed(d.id);
    }
  }
};

const start = () => {
  if (live.started) return;
  live.started = true;
  openStore();
  // (one round at a time: a check that waits for its deadline must not start a second round behind it)
  const tick = () => {
    if (live.rounding) return;
    live.rounding = true;
    round().catch((e) => console.warn(`[drives] a round failed: ${(e && e.message) || e}`)).finally(() => { live.rounding = false; });
  };
  const t1 = setTimeout(tick, 3 * SEC);
  const t2 = setInterval(tick, 5 * SEC); // each drive is asked only at its own pace (round)
  t1.unref?.(); t2.unref?.();
  live.timers.push(t1, t2);
};
const stop = () => { for (const t of live.timers) { clearTimeout(t); clearInterval(t); } live.timers = []; live.started = false; };

// ---------- questions from the rest of the server (all from memory) ----------
const onPath = (abs) => {
  if (!live.mountsAt && deps.now() - live.lazyAt > MOUNTS_MS) {
    live.lazyAt = deps.now();
    // before the first round: the mount list is a cheap read on Linux
    if (deps.platform() !== "win32") { try { live.drives = mounts.candidates(mounts.parseMounts(deps.readMountinfo())); } catch {} }
    for (const x of deps.extra()) {
      const mount = path.resolve(x.path);
      if (!live.drives.some((d) => d.id === mount)) live.drives.push({ id: mount, mount, source: mount, fstype: x.network ? "nfs" : "folder", network: !!x.network, readOnly: false, hard: !!x.network, options: [], extra: true });
    }
  }
  const drive = mounts.driveOf(abs, live.drives, deps.platform());
  if (!drive) return null;
  const s = stateOf(drive.id);
  return { drive, network: !!drive.network, answering: s.answering !== false, state: s };
};
// onPath, after a fresh check of a network drive (a download about to land there)
const confirm = async (abs) => {
  const o = onPath(abs);
  if (!o || !o.network) return o;
  await check(o.drive).catch(() => {});
  return onPath(abs);
};
const isDown = (abs) => { const o = onPath(abs); return !!(o && o.network && !o.answering); };

// free/total of a network drive, from its last check (null when down or not
// measured yet); undefined = not a network drive (ask the disk as before)
const spaceOf = (abs) => {
  const o = onPath(abs);
  if (!o || !o.network) return undefined;
  const s = o.state;
  if (!o.answering || s.total == null) return null;
  return { free: s.free, total: s.total, freePct: s.total > 0 ? (s.free / s.total) * 100 : null };
};

// a library folder on a network drive: readable as of its last check
const rootReadable = (dir) => {
  const o = onPath(dir);
  if (!o || !o.network) return undefined;
  if (!o.answering) return false;
  const r = o.state.roots || {};
  return r[dir] !== false;
};

// Before a library file's bytes are served. → { ok } | { ok: false, status, code, message }
// Local drives pass at once. A network drive known to be down fails at once;
// otherwise the file is looked at (asynchronously, so a hang holds one pool
// thread and not the server) with a deadline — past it the drive is marked
// "not answering" and every later request fails fast without touching it.
const pending = new Map(); // drive id -> stats out
const guard = async (abs, who = null) => {
  const o = onPath(abs);
  if (!o || !o.network) return { ok: true };
  const blocked = () => {
    noteViewer(o.drive, who);
    return { ok: false, status: 503, code: CODE, message: VIEWER_MESSAGE };
  };
  if (!o.answering) return blocked();
  // one look at a time per drive is enough to notice a hang
  const n = pending.get(o.drive.id) || 0;
  if (n >= 4) return blocked();
  pending.set(o.drive.id, n + 1);
  let timer;
  const verdict = await Promise.race([
    deps.stat(abs).then(() => "ok", (e) => (e && /^(ENOENT|ENOTDIR)$/.test(e.code || "") ? "ok" : "error")),
    new Promise((r) => { timer = setTimeout(() => r("timeout"), limits.guardTimeoutMs); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
  // (a hung stat never settles: its count stays, which is what keeps the next ones off the drive)
  if (verdict !== "timeout") pending.set(o.drive.id, Math.max(0, (pending.get(o.drive.id) || 1) - 1));
  if (verdict === "ok") return { ok: true };
  markDown(o.drive, verdict === "timeout" ? `a file did not answer in ${limits.guardTimeoutMs / SEC} s` : "a file could not be read");
  // look again at once (the check decides when it is back)
  check(o.drive).catch(() => {});
  return blocked();
};
const noteViewer = (drive, who) => {
  const a = data().alerts[drive.id];
  if (!a || !a.downSince) {
    // the first viewer can come before the round that starts the outage's clock
    stepAlert(drive);
  }
  const s = data().alerts[drive.id];
  if (!s) return;
  const key = String(who || "someone");
  if (!s.viewers.includes(key) && s.viewers.length < 200) { s.viewers.push(key); save(); }
};

// the item record's mark (GET /api/item/:id): a title whose file is on a drive that is down
const unavailableFor = (abs) => (isDown(abs) ? { code: CODE, message: VIEWER_MESSAGE } : null);

// ---------- where new downloads go ----------
const acceptsNew = (id) => !data().noNew[id];
// candidates for rules.pick. `hasShowAt(root)` (from the caller: the
// downloads module knows how show folders are matched) says whether the
// show already lives in that folder. `committedOn(root)` the bytes already
// promised to that folder.
const candidatesFor = (kind, { hasShowAt = () => false, committedOn = () => 0 } = {}) => {
  const config = configLib();
  const roots = (kind === "show" ? config.LIBRARIES.shows : config.LIBRARIES.movies) || [];
  return roots.map((root) => {
    const o = onPath(root);
    const id = o ? o.drive.id : root;
    const s = o ? o.state : null;
    let free = s && s.free != null ? s.free : null;
    let total = s && s.total != null ? s.total : null;
    if (free == null && (!o || !o.network)) {
      // a local folder not measured yet: ask the disk (a local statfs does not hang)
      try { const st = fs.statfsSync(root); free = st.bavail * st.bsize; total = st.blocks * st.bsize; } catch {}
    }
    const sc = data().scores[id];
    return {
      root,
      drive: id,
      free,
      total,
      committed: committedOn(root, id),
      score: sc && sc.value != null ? sc.value : null,
      accepts: acceptsNew(id),
      answering: o ? o.answering && (!o.network || rootReadable(root) !== false) : true,
      hasShow: kind === "show" ? !!hasShowAt(root) : false,
    };
  });
};
const pickRoot = (kind, ask = {}, helpers = {}) => {
  const config = configLib();
  const roots = (kind === "show" ? config.LIBRARIES.shows : config.LIBRARIES.movies) || [];
  if (roots.length <= 1) return { root: roots[0] || null, drive: null, why: "the only library folder", full: false };
  return rules.pick(candidatesFor(kind, helpers), { kind, sizeBytes: ask.sizeBytes || 0 });
};

// ---------- "Use this drive too" ----------
const shortErr = (e) => String((e && e.message) || e || "").slice(0, 300);
// config.json, changed in one place (libraries) and written safely: the file
// as it is NOW on disk is read (a hand edit since the start is kept), a copy
// of it is kept beside it, the new one goes to a temp file, is fsync'd, and
// renamed over it.
const addLibrariesToConfig = (adds) => {
  const file = deps.configFile();
  let raw = "{}";
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const cfg = JSON.parse(raw);
  cfg.libraries = cfg.libraries && typeof cfg.libraries === "object" ? cfg.libraries : {};
  for (const kind of ["movies", "shows"]) {
    const list = Array.isArray(cfg.libraries[kind]) ? cfg.libraries[kind] : [];
    for (const dir of adds[kind] || []) if (!list.some((x) => normDir(x) === normDir(dir))) list.push(dir);
    cfg.libraries[kind] = list;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const backup = `${file}.before-drive-${stamp}`;
  if (fs.existsSync(file)) fs.copyFileSync(file, backup);
  // keep the five newest of these copies
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const olds = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.before-drive-`)).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - 5))) fs.unlinkSync(path.join(dir, f));
  } catch {}
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, JSON.stringify(cfg, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  return { file, backup };
};

const use = async (id) => {
  if (!live.mountsAt) await refreshMounts();
  const drive = live.drives.find((d) => d.id === id);
  if (!drive) return { error: "That drive is not on this server's list — reload." };
  if (dirsOn(drive).some((d) => d.kind === "movies" || d.kind === "shows")) return { error: "Aurora already keeps films or shows on this drive." };
  if (drive.readOnly) return { error: "This drive is mounted read-only — Aurora can't write there." };
  const s = await check(drive);
  if (s.answering === false) return { error: `The drive is not answering (${s.why || "no answer"}).` };
  const base = path.join(drive.mount, "Aurora");
  const movies = path.join(base, "Movies");
  const shows = path.join(base, "Shows");
  const res = await deps.ask("prepare", { dirs: [base, movies, shows], test: base }, { timeoutMs: PREPARE_TIMEOUT_MS, key: `${drive.id}:prepare` });
  if (!res || !res.ok) return { error: res && res.timeout ? "The drive did not answer while Aurora made its folders." : `Aurora could not make its folders there: ${shortErr(res && res.error)}` };
  if (!res.result.check.ok) return { error: `Aurora can't write there: the ${res.result.check.step} step failed (${res.result.check.error}).` };
  let written;
  try { written = addLibrariesToConfig({ movies: [movies], shows: [shows] }); } catch (e) {
    return { error: `The folders are made, but config.json could not be updated: ${shortErr(e)}` };
  }
  // the running server takes them at once (the same arrays everything reads)
  const config = configLib();
  for (const [kind, dir] of [["movies", movies], ["shows", shows]]) {
    const list = config.LIBRARIES[kind];
    if (!list.some((x) => normDir(x) === normDir(dir))) list.push(dir);
  }
  try { require("../libroots")._reset(); } catch {}
  data().added[id] = { at: deps.now(), movies, shows };
  delete data().noNew[id];
  save();
  console.log(`[drives] now using ${drive.mount}: ${movies}, ${shows} (config.json updated; copy kept as ${path.basename(written.backup)})`);
  deps.rescan();
  queueSpeed(id);
  measureUsage(drive).catch(() => {});
  return { ok: true, created: res.result.created, existed: res.result.existed, movies, shows, backup: written.backup };
};

const setNewDownloads = (id, on) => {
  const drive = live.drives.find((d) => d.id === id);
  if (!drive) return { error: "That drive is not on this server's list — reload." };
  if (!dirsOn(drive).some((d) => d.kind === "movies" || d.kind === "shows")) return { error: "Aurora keeps no films or shows on this drive." };
  if (on) delete data().noNew[id];
  else data().noNew[id] = true;
  save();
  console.log(`[drives] ${drive.mount}: ${on ? "takes new downloads again" : "no new downloads"}`);
  return { ok: true };
};

const testAgain = (id) => {
  const drive = live.drives.find((d) => d.id === id);
  if (!drive) return { error: "That drive is not on this server's list — reload." };
  if (!testDirFor(drive)) return { error: "Use this drive first — the speed check writes in Aurora's folder there." };
  if (stateOf(id).answering === false) return { error: "The drive is not answering." };
  queueSpeed(id);
  return { ok: true, waiting: deps.watchingNow() > 0 ? "It runs when nobody is watching." : null };
};

// ---------- the admin's card ----------
const list = async ({ fresh = false } = {}) => {
  if (fresh || !live.mountsAt) await round({ all: fresh }).catch(() => {});
  const d = data();
  return live.drives.map((drive) => {
    const s = stateOf(drive.id);
    const on = dirsOn(drive);
    const libs = on.filter((x) => x.kind === "movies" || x.kind === "shows");
    const inUse = libs.length > 0;
    const sc = d.scores[drive.id] || null;
    const u = d.usage[drive.id] || null;
    return {
      id: drive.id,
      name: drive.label || (drive.mount === "/" ? "System disk" : path.basename(drive.mount.replace(/[\\/]+$/, "")) || drive.mount),
      mount: drive.mount,
      source: drive.source,
      fstype: drive.fstype,
      network: !!drive.network,
      readOnly: !!drive.readOnly,
      hardMount: !!drive.hard,
      options: drive.options || [],
      total: s.total, free: s.free, used: s.used, measuredAt: s.at || null,
      answering: s.answering !== false,
      downSince: s.answering === false ? s.downSince || null : null,
      why: s.answering === false ? s.why : null,
      inUse,
      holds: on.map((x) => x.kind),
      folders: on.map((x) => ({ kind: x.kind, dir: x.dir })),
      newDownloads: inUse ? acceptsNew(drive.id) : false,
      aurora: u ? { bytes: u.bytes, files: u.files, partial: u.partial, at: u.at } : null,
      score: sc && sc.value != null ? { value: sc.value, word: sc.word, streams: sc.streams, measured: sc.measured, at: sc.at } : null,
      scoreError: sc && sc.error ? sc.error : null,
      testing: live.speedRunning === drive.id ? "running" : live.speedQueue.includes(drive.id) ? (live.speedWaiting || "queued") : null,
      titles: inUse ? titlesOn(drive) : 0,
      reserve: s.total ? rules.reserveFor(s.total) : null,
    };
  });
};

// for the admin summary (lib/adminsummary.js): the drives in use
const summaryFacts = () => {
  return live.drives.filter((dr) => dirsOn(dr).some((x) => x.kind === "movies" || x.kind === "shows")).map((dr) => {
    const s = stateOf(dr.id);
    return { id: dr.id, mount: dr.mount, network: !!dr.network, free: s.free, total: s.total, answering: s.answering !== false, downSince: s.answering === false ? s.downSince : null, newDownloads: acceptsNew(dr.id), titles: s.answering === false ? titlesOn(dr) : null };
  });
};

module.exports = {
  start, stop, list, use, setNewDownloads, testAgain, pickRoot, candidatesFor, onPath, confirm, isDown, spaceOf, rootReadable, guard, unavailableFor, summaryFacts,
  VIEWER_MESSAGE, CODE,
  deps, limits,
  _internals: { live, data, round, check, refreshMounts, addLibrariesToConfig, stepAlert, pumpSpeed, queueSpeed, measureUsage, reset: () => { live.drives = []; live.state.clear(); live.mountsAt = 0; live.lazyAt = 0; live.speedQueue = []; live.speedRunning = null; live.titles.by.clear(); pending.clear(); for (const k of Object.keys(mem)) mem[k] = {}; store = null; } },
};
