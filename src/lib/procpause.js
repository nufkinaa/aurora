// Pausing and resuming a child process (an ffmpeg that has run far enough
// ahead of its viewer), on every OS.
//
// Linux / macOS: SIGSTOP and SIGCONT. Windows has no signals for this; the
// kernel's NtSuspendProcess / NtResumeProcess do the same, and are reached
// through PowerShell's Add-Type (a few lines of C#, compiled by the .NET that
// every Windows has) — one short-lived PowerShell per call. Either way a
// failure is just "not paused": the caller carries on as before.
//
// WHAT THAT COSTS, AND ITS BOUNDS (integration of the server round,
// 2026-10-18). One call measured ~340-450 ms wall on the house PC (a
// PowerShell start + the Add-Type compile). The caller (media/remux.js)
// pauses a job 50 segments ahead of its reader and resumes it at 20, so a
// stream costs one suspend + one resume per ~30 segments (~3 minutes of
// film) — never per segment. On top of that, here:
//   - at most WIN_AT_ONCE PowerShells at once (a burst of jobs reaching the
//     line together waits its turn instead of starting ten);
//   - suspends at most WIN_SUSPENDS_PER_MIN a minute (past that a job just
//     runs on, as before this round; a RESUME is never refused — a process we
//     suspended must get its resume);
//   - WIN_FAILS_OFF suspends failing in a row (PowerShell missing, blocked
//     by policy, Add-Type refused) switch suspending OFF for WIN_OFF_MS, so a
//     box where it cannot work never spawns a PowerShell every few seconds.
// stats() says how often each happened (the admin's streaming report).
"use strict";
const { execFile } = require("child_process");

const deps = {
  platform: () => process.platform,
  kill: (pid, sig) => process.kill(pid, sig),
  now: () => Date.now(),
  powershell: (script) => new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 20000 }, (err) => resolve(!err));
  }),
};

const WIN_AT_ONCE = 2;
const WIN_SUSPENDS_PER_MIN = 12;
const WIN_FAILS_OFF = 3;
const WIN_OFF_MS = 30 * 60 * 1000;

const WIN_SRC = (fn, pid) => `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AuroraProc { [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h); }'; $p = [System.Diagnostics.Process]::GetProcessById(${Number(pid)}); if ([AuroraProc]::${fn}($p.Handle) -ne 0) { exit 1 }`;

const stats = { spawned: 0, suspended: 0, resumed: 0, failed: 0, refusedRate: 0, refusedOff: 0, offUntil: 0 };
let running = 0;
const queue = [];
let failsInARow = 0;
const recent = []; // when each recent suspend was started (the per-minute cap)

const slot = () => new Promise((resolve) => {
  if (running < WIN_AT_ONCE) { running++; resolve(); } else queue.push(resolve);
});
const free = () => {
  const next = queue.shift();
  if (next) next(); else running--;
};
const winCall = async (fn, pid) => {
  await slot();
  try {
    stats.spawned++;
    return await deps.powershell(WIN_SRC(fn, pid));
  } finally { free(); }
};

// → Promise<boolean>: did it work
const suspend = async (pid) => {
  if (!(pid > 0)) return false;
  if (deps.platform() !== "win32") {
    try { deps.kill(pid, "SIGSTOP"); stats.suspended++; return true; } catch { stats.failed++; return false; }
  }
  const now = deps.now();
  if (now < stats.offUntil) { stats.refusedOff++; return false; }
  while (recent.length && now - recent[0] > 60000) recent.shift();
  if (recent.length >= WIN_SUSPENDS_PER_MIN) { stats.refusedRate++; return false; }
  recent.push(now);
  const ok = await winCall("NtSuspendProcess", pid);
  if (ok) { failsInARow = 0; stats.suspended++; return true; }
  stats.failed++;
  if (++failsInARow >= WIN_FAILS_OFF) {
    stats.offUntil = deps.now() + WIN_OFF_MS;
    failsInARow = 0;
    console.warn(`[procpause] pausing a process failed ${WIN_FAILS_OFF} times in a row — not tried again for ${WIN_OFF_MS / 60000} min (jobs run on, as before)`);
  }
  return false;
};
const resume = async (pid) => {
  if (!(pid > 0)) return false;
  if (deps.platform() !== "win32") {
    try { deps.kill(pid, "SIGCONT"); stats.resumed++; return true; } catch { stats.failed++; return false; }
  }
  const ok = await winCall("NtResumeProcess", pid);
  if (ok) stats.resumed++; else stats.failed++;
  return ok;
};

const status = () => ({ ...stats, running, queued: queue.length, suspendsLastMinute: recent.length, limits: { atOnce: WIN_AT_ONCE, suspendsPerMin: WIN_SUSPENDS_PER_MIN, failsOff: WIN_FAILS_OFF, offMs: WIN_OFF_MS } });

const _reset = () => {
  for (const k of Object.keys(stats)) stats[k] = 0;
  running = 0; queue.length = 0; failsInARow = 0; recent.length = 0;
};

module.exports = { suspend, resume, status, WIN_AT_ONCE, WIN_SUSPENDS_PER_MIN, WIN_FAILS_OFF, _internals: { deps, WIN_SRC, _reset } };
