// Pausing and resuming a child process (an ffmpeg that has run far enough
// ahead of its viewer), on every OS.
//
// Linux / macOS: SIGSTOP and SIGCONT. Windows has no signals for this; the
// kernel's NtSuspendProcess / NtResumeProcess do the same, and are reached
// through PowerShell's Add-Type (a few lines of C#, compiled by the .NET that
// every Windows has) — one short-lived PowerShell per call, which is fine for
// something that happens once every few minutes per stream. Either way a
// failure is just "not paused": the caller carries on as before.
"use strict";
const { execFile } = require("child_process");

const deps = {
  platform: () => process.platform,
  kill: (pid, sig) => process.kill(pid, sig),
  powershell: (script) => new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 20000 }, (err) => resolve(!err));
  }),
};

const WIN_SRC = (fn, pid) => `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AuroraProc { [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h); }'; $p = [System.Diagnostics.Process]::GetProcessById(${Number(pid)}); if ([AuroraProc]::${fn}($p.Handle) -ne 0) { exit 1 }`;

// → Promise<boolean>: did it work
const suspend = (pid) => {
  if (!(pid > 0)) return Promise.resolve(false);
  if (deps.platform() === "win32") return deps.powershell(WIN_SRC("NtSuspendProcess", pid));
  try { deps.kill(pid, "SIGSTOP"); return Promise.resolve(true); } catch { return Promise.resolve(false); }
};
const resume = (pid) => {
  if (!(pid > 0)) return Promise.resolve(false);
  if (deps.platform() === "win32") return deps.powershell(WIN_SRC("NtResumeProcess", pid));
  try { deps.kill(pid, "SIGCONT"); return Promise.resolve(true); } catch { return Promise.resolve(false); }
};

module.exports = { suspend, resume, _internals: { deps, WIN_SRC } };
