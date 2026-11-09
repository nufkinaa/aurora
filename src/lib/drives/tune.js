// "Tune this network drive" (2026-11-09, elia: "add (tune the network mount)
// to aurora so I don't need to actually send commands with ssh").
// docs/storage-drives.md, "Tune this network drive from the admin".
//
// Changing an NFS mount's options (rsize/wsize, nconnect) needs a new fstab
// line and an unmount + mount: root's work. Aurora never gets root. It asks
// ONE fixed-purpose helper, installed once by the admin outside the repo
// (scripts/nufurora/aurora-mount-helper → /usr/local/sbin/aurora-mount-helper,
// root-owned, allowed by one sudoers line), with `sudo -n` and execFile (no
// shell). The helper only takes a mount point and a preset name.
//
//   preview(id)        the drive's line now, what "tuned" would write, or the
//                      one-time setup commands when the helper isn't there
//   start(id, action)  "apply" (tuned) or "revert" (the line as it was): runs
//                      in the background; the card follows cardFacts()
//   cardFacts(drive)   for list(): supported, the step running, the last result
//   recover()          at start: a run the last process did not finish
//
// A run: nobody may be playing from the drive. It is paused (viewers get a
// fast "being tuned" answer, the scanner leaves its titles alone, a landing
// waits), new downloads stop going there, landings already copying there
// finish, the speed check runs, the helper changes the mount, Aurora waits for
// the drive to answer, the speed check runs again; then everything is as it
// was (new downloads included) and the card says before → after.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const lazy = require("../lazy");
const run = require("./run");

const drivesLib = lazy(require, "./index");

const HELPER = "/usr/local/sbin/aurora-mount-helper";
const SUDOERS = "/etc/sudoers.d/aurora-mount";
const REPO_HELPER = path.join(__dirname, "..", "..", "..", "scripts", "nufurora", "aurora-mount-helper");

const SEC = 1000;
const MIN = 60 * SEC;
// (an object, so a test can shorten them)
const limits = {
  statusMs: 20 * SEC, // `status` reads a file and asks findmnt
  changeMs: 4 * MIN, // the helper's own steps stop at 45 s each (umount, mount, the way back)
  landingsMs: 10 * MIN,
  speedWaitMs: 5 * MIN, // another drive's speed check finishing first
  answerMs: 90 * SEC,
  pollMs: 2 * SEC,
};

const PAUSE_NOTE = "Aurora pauses this drive for about three minutes: nobody can watch from it meanwhile and new downloads wait. It measures the speed before and after.";
const WATCHING = "Someone is watching a title from this drive right now — try again when nobody is.";

const deps = {
  platform: () => process.platform,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  helperInstalled: () => { try { return fs.statSync(HELPER).isFile(); } catch { return false; } },
  // sudo -n never asks for a password: without the sudoers line it fails at once.
  // execFile, never a shell; the helper's arguments are a mount point from the
  // mount list and a fixed word. A timeout sends SIGTERM (sudo passes it on;
  // the helper puts the old line back when it was half-way).
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
  user: () => { try { return os.userInfo().username; } catch { return process.env.USER || ""; } },
  repoHelper: () => REPO_HELPER,
  repoVersion: () => { try { const m = /^VERSION=(\d+)/m.exec(fs.readFileSync(REPO_HELPER, "utf8")); return m ? Number(m[1]) : null; } catch { return null; } },
  settled: (key, ms) => run.settled(key, ms),
};

let current = null; // { id, action, step, startedAt }

// titles being moved to or from the drive (lib/drives/mover.js), or the drive being emptied
const movingOn = (D, id) => {
  try { if (D.mover && D.mover().busyOn(id)) return true; } catch {}
  const ev = D.tuneSeams.data().evacuate;
  return !!(ev && ev[id]);
};
const supported = (drive) => deps.platform() === "linux" && !!drive && !!drive.network && /^nfs4?$/.test(String(drive.fstype || ""));

// ---------- the one-time setup ----------
const shq = (p) => (/^[A-Za-z0-9._/-]+$/.test(p) ? p : `'${String(p).replace(/'/g, "'\\''")}'`);
const setupFor = () => {
  const u = deps.user();
  const user = /^[a-z_][a-z0-9_.-]{0,31}$/i.test(u) ? u : "elia";
  return {
    user,
    commands: [
      `sudo install -o root -g root -m 0755 ${shq(deps.repoHelper())} ${HELPER}`,
      `t=$(mktemp) && echo '${user} ALL=(root) NOPASSWD: ${HELPER}' > "$t" && sudo visudo -cf "$t" && sudo install -o root -g root -m 0440 "$t" ${SUDOERS}; rm -f "$t"`,
    ],
  };
};

// ---------- asking the helper ----------
const parse = (stdout) => {
  const lines = String(stdout || "").trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o && typeof o === "object" && "ok" in o) return o; } catch {}
  }
  return null;
};
// -> { ok: true, json } | { ok: false, json?, error, code? } | { missing: "helper"|"sudo", error }
const askHelper = async (args, ms) => {
  if (!deps.helperInstalled()) return { missing: "helper", error: `${HELPER} is not installed.` };
  const r = await deps.helper(args, ms);
  const j = parse(r.stdout);
  if (j) return j.ok ? { ok: true, json: j } : { ok: false, json: j, code: j.code || null, error: j.error || "the helper refused" };
  if (r.spawnError === "ENOENT") return { missing: "sudo", error: "sudo is not on this server." };
  if (/password is required|not allowed to|may not run|a terminal is required|not in the sudoers/i.test(r.stderr)) return { missing: "sudo", error: "The sudo rule for the helper is not installed." };
  if (r.killed) return { ok: false, error: `the helper did not finish in ${Math.round(ms / SEC)} s` };
  return { ok: false, error: (r.stderr.trim().split(/\r?\n/).pop() || `the helper gave no answer (exit ${r.code})`).slice(0, 300) };
};
const splitOpts = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

const findDrive = async (id) => {
  const S = drivesLib().tuneSeams;
  if (!S.live.mountsAt) await S.refreshMounts();
  return S.live.drives.find((d) => d.id === id) || null;
};

// ---------- the preview ----------
const preview = async (id) => {
  const D = drivesLib();
  const S = D.tuneSeams;
  const drive = await findDrive(id);
  if (!drive) return { error: "That drive is not on this server's list — reload." };
  if (!supported(drive)) return { error: "Only an NFS drive on a Linux server can be tuned from here." };
  const base = {
    id, mount: drive.mount, pauseNote: PAUSE_NOTE,
    inUse: !!S.testDirFor(drive),
    watching: D.deps.playingOn(drive) > 0,
    running: current && current.id === id ? { action: current.action, step: current.step, startedAt: current.startedAt } : null,
  };
  const st = await askHelper(["status", drive.mount], limits.statusMs);
  if (st.missing) return { ...base, installed: false, missing: st.missing, why: st.error, setup: setupFor() };
  if (!st.ok) return { ...base, installed: true, problem: st.error };
  const j = st.json;
  const cur = splitOpts(j.fstabOptions);
  const next = splitOpts(j.tunedOptions);
  const repoV = deps.repoVersion();
  const outdated = repoV != null && Number(j.version) < repoV;
  return {
    ...base,
    installed: true,
    version: j.version,
    outdated,
    setup: outdated ? setupFor() : null,
    mounted: !!j.mounted,
    fstabOptions: j.fstabOptions,
    liveOptions: j.liveOptions,
    tunedOptions: j.tunedOptions,
    add: next.filter((o) => !cur.includes(o)),
    remove: cur.filter((o) => !next.includes(o)),
    already: !!j.isTuned,
    canRevert: !!j.canRevert,
    originalOptions: j.originalOptions || null,
  };
};

// ---------- a run ----------
const figures = (res) => {
  const sc = res && res.score;
  if (!sc) return null;
  const m = sc.measured || {};
  return {
    value: sc.value, word: sc.word,
    parallelMBps: m.parallelMBps, readers: m.parallelReaders || 4,
    bufferedMBps: m.bufferedMBps, directMBps: m.directMBps, writeMBps: m.writeMBps,
    streams1080: sc.streams1080 != null ? sc.streams1080 : null, streams4k: sc.streams4k != null ? sc.streams4k : null,
    partial: !!m.partial,
  };
};
const mbps = (v) => (v == null ? "?" : String(Math.round(v)));
// 10% more for 4 viewers together is "better"; less than that is the same drive
const isBetter = (b, a) => !!(b && a && b.parallelMBps != null && a.parallelMBps != null && a.parallelMBps >= b.parallelMBps * 1.1);
const readLine = (b, a) => `read ${mbps(b && b.parallelMBps)} → ${mbps(a && a.parallelMBps)} MB/s for ${(a && a.readers) || (b && b.readers) || 4} viewers together`;

const stop = (message, extra = {}) => Object.assign(new Error(message), { tuneMessage: message, ...extra });
const step = (name) => { if (current) current.step = name; };

const helperMessage = (r, mount) => {
  const j = r.json || {};
  if (j.code === "busy") return "Something on the server still had a file open on the drive, so it was not unmounted — nothing changed. Try again in a few minutes.";
  if (j.code === "mount-failed" || j.code === "umount-failed" || j.code === "interrupted") {
    const back = j.mountedOldWay === false
      ? ` The drive did not mount again the old way either — it needs a look on the server (sudo mount ${mount}).`
      : " The old line is back and the drive is mounted the old way.";
    return `${j.code === "mount-failed" ? `The new options did not mount${j.detail ? ` (${String(j.detail).slice(0, 200)})` : ""}.` : j.code === "interrupted" ? "The change was stopped half-way." : `The drive could not be unmounted${j.detail ? ` (${String(j.detail).slice(0, 200)})` : ""} — nothing changed.`}${j.code === "umount-failed" ? "" : back}`;
  }
  return `The helper said: ${r.error || "no answer"}`;
};

// the speed check, once no other runs (the queue waits on the paused drive)
const speedNow = async (drive) => {
  const S = drivesLib().tuneSeams;
  const until = deps.now() + limits.speedWaitMs;
  while (S.live.speedRunning) {
    if (deps.now() > until) return { error: "another speed check did not finish" };
    await deps.sleep(limits.pollMs);
  }
  return S.measureSpeed(drive);
};

// the drive answers, with Aurora's folders there
const waitAnswer = async (id, fallback) => {
  const S = drivesLib().tuneSeams;
  const until = deps.now() + limits.answerMs;
  for (;;) {
    const drive = S.live.drives.find((d) => d.id === id) || fallback;
    const s = await S.check(drive, { force: true }).catch(() => null);
    if (s && s.answering !== false && Object.values(s.roots || {}).every(Boolean)) return true;
    if (deps.now() > until) return false;
    await deps.sleep(limits.pollMs);
  }
};

const flow = async (drive, action, status) => {
  const D = drivesLib();
  const S = D.tuneSeams;
  const id = drive.id;
  const d = S.data();
  d.tunes = d.tunes || {};
  const prevNoNew = !!d.noNew[id];
  const words = action === "revert" ? "putting the old mount options back" : "tuning the mount";
  d.tunes[id] = { ...(d.tunes[id] || {}), running: { action, startedAt: current.startedAt, prevNoNew } };
  d.noNew[id] = true;
  S.save();
  S.pause(id, words);
  console.log(`[drives] ${drive.mount}: ${words} — paused, no new downloads meanwhile`);
  const last = {
    action, ok: false, changed: false, startedAt: current.startedAt, at: null,
    before: null, after: null, better: null,
    optionsBefore: status.liveOptions || status.fstabOptions || null, optionsAfter: null,
    fstabBefore: status.fstabOptions || null, fstabAfter: null,
    clamped: [], missing: [], message: "",
  };
  try {
    step("landings");
    const until = deps.now() + limits.landingsMs;
    // (and a title the mover is copying there or from there: it finishes its step first)
    while (D.deps.landingsOn(drive) > 0 || (() => { try { return D.mover().busyOn(id); } catch { return false; } })()) {
      if (deps.now() > until) throw stop("A download or a moved title was still being copied there after 10 minutes — nothing was changed. Try again later.");
      await deps.sleep(limits.pollMs);
    }
    // Aurora's own looks at the drive finish first (they hold files open there)
    for (const k of ["check", "usage", "sweep", "prepare"]) await deps.settled(`${id}:${k}`, 30 * SEC).catch(() => {});

    step("before");
    const before = await speedNow(drive);
    if (before.error) throw stop(`The speed check before the change failed (${before.error}) — nothing was changed.`);
    last.before = figures(before);

    step("changing");
    const r = await askHelper(action === "revert" ? ["revert", drive.mount] : ["apply", drive.mount, "tuned"], limits.changeMs);
    if (r.missing) throw stop("The mount helper isn't set up on this server any more — nothing was changed.");
    if (!r.ok) {
      const j = r.json || {};
      last.helper = { code: j.code || null, fstabRestored: j.fstabRestored != null ? !!j.fstabRestored : null, mountedOldWay: j.mountedOldWay != null ? !!j.mountedOldWay : null };
      throw stop(helperMessage(r, drive.mount));
    }
    const j = r.json;
    last.changed = j.changed !== false;
    last.optionsBefore = j.liveBefore || last.optionsBefore;
    last.optionsAfter = j.liveAfter || null;
    last.fstabBefore = j.fstabBefore || last.fstabBefore;
    last.fstabAfter = j.fstabAfter || null;
    last.clamped = Array.isArray(j.clamped) ? j.clamped : [];
    last.missing = Array.isArray(j.missing) ? j.missing : [];
    last.backup = j.backup || null;

    step("answer");
    await S.refreshMounts().catch(() => {});
    if (!(await waitAnswer(id, drive))) throw stop(`The drive was mounted again but has not answered in ${Math.round(limits.answerMs / SEC)} s — Aurora keeps asking, and says so on the card if it stays away.`);

    step("after");
    const after = await speedNow(S.live.drives.find((x) => x.id === id) || drive);
    last.after = after.error ? null : figures(after);
    last.ok = true;
    const server = last.clamped.length ? ` The server agreed to less than asked: ${last.clamped.join(", ")}.` : "";
    const notOn = last.missing.length ? ` Not in force: ${last.missing.join(", ")}.` : "";
    if (action === "revert") {
      last.message = `The old options are back: ${readLine(last.before, last.after)}.${server}${notOn}`;
    } else if (!last.after) {
      last.better = false;
      last.message = `Mounted with the new options, but the speed check after it failed (${after.error}).${server}${notOn}`;
    } else {
      last.better = isBetter(last.before, last.after);
      last.message = last.better
        ? `Faster: ${readLine(last.before, last.after)}.${server}${notOn}`
        : `Not faster: ${readLine(last.before, last.after)}. "Put it back" returns the old options.${server}${notOn}`;
    }
  } catch (e) {
    last.ok = false;
    last.message = e.tuneMessage || `Something went wrong: ${(e && e.message) || e}`;
  } finally {
    last.at = deps.now();
    if (prevNoNew) d.noNew[id] = true;
    else delete d.noNew[id];
    S.unpause(id);
    d.tunes[id] = { last };
    S.save();
    current = null;
    console.log(`[drives] ${drive.mount}: ${action === "revert" ? "put back" : "tuned"} — ${last.message}`);
  }
  return last;
};

// -> { ok, started } | { error, watching?, missing?, setup? }
const start = async (id, action = "apply") => {
  if (action !== "apply" && action !== "revert") return { error: "Tune or put back?" };
  if (current) return { error: current.id === id ? "This drive is being tuned already." : "Another drive is being tuned — one at a time." };
  // (held from here: two presses can't both pass the checks below)
  current = { id, action, step: "checking", startedAt: deps.now() };
  let started = false;
  try {
    const D = drivesLib();
    const S = D.tuneSeams;
    const drive = await findDrive(id);
    if (!drive) return { error: "That drive is not on this server's list — reload." };
    if (!supported(drive)) return { error: "Only an NFS drive on a Linux server can be tuned from here." };
    if (!S.testDirFor(drive)) return { error: "Use this drive first — the speed check before and after writes in Aurora's folder there." };
    if (S.stateOf(id).answering === false) return { error: "The drive is not answering — Aurora can't measure it now." };
    if (D.deps.playingOn(drive) > 0) return { error: WATCHING, watching: true };
    if (movingOn(D, id)) return { error: "Titles are being moved to or from this drive — try again when that is done." };
    const st = await askHelper(["status", drive.mount], limits.statusMs);
    if (st.missing) return { error: "The mount helper isn't set up on this server yet.", missing: st.missing, setup: setupFor() };
    if (!st.ok) return { error: st.error };
    if (action === "revert" && !st.json.canRevert) return { error: "There is no earlier line to put back." };
    if (action === "apply" && st.json.isTuned) return { error: "This drive already has the tuned options." };
    // once more (the helper took a moment)
    if (D.deps.playingOn(drive) > 0) return { error: WATCHING, watching: true };
    current.step = "starting";
    started = true;
    flow(drive, action, st.json).catch((e) => console.warn(`[drives] tune: ${(e && e.message) || e}`));
    return { ok: true, started: true, action };
  } finally {
    if (!started) current = null;
  }
};

const STEP_WORDS = {
  checking: "getting ready", starting: "getting ready", landings: "waiting for a download to finish copying there",
  before: "measuring the speed before", changing: "changing the mount", answer: "waiting for the drive to answer", after: "measuring the speed after",
};
const cardFacts = (drive) => {
  if (!supported(drive)) return null;
  const S = drivesLib().tuneSeams;
  const t = (S.data().tunes || {})[drive.id] || {};
  const mine = current && current.id === drive.id;
  return {
    supported: true,
    running: mine ? { action: current.action, step: current.step, words: STEP_WORDS[current.step] || current.step, startedAt: current.startedAt } : null,
    elsewhere: !!(current && !mine),
    last: t.last || null,
  };
};

// at start: a run that the last process did not finish
const recover = () => {
  const S = drivesLib().tuneSeams;
  const d = S.data();
  const tunes = d.tunes || {};
  let n = 0;
  for (const [id, t] of Object.entries(tunes)) {
    if (!t || !t.running) continue;
    n++;
    if (t.running.prevNoNew) d.noNew[id] = true;
    else delete d.noNew[id];
    tunes[id] = {
      last: {
        action: t.running.action, ok: false, interrupted: true, startedAt: t.running.startedAt, at: deps.now(),
        message: "Aurora restarted in the middle of this. New downloads are as they were; press Tune to see the drive's options now.",
      },
    };
  }
  if (n) { S.save(); console.warn(`[drives] ${n} drive tune${n === 1 ? "" : "s"} did not finish before the restart — new downloads put back as they were`); }
  return n;
};

module.exports = {
  preview, start, cardFacts, recover, setupFor,
  HELPER, SUDOERS, PAUSE_NOTE, WATCHING,
  deps, limits,
  _internals: { askHelper, parse, isBetter, figures, helperMessage, current: () => current, reset: () => { current = null; } },
};
