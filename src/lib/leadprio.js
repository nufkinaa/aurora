// A stream producer (a jit rendition, a TV offset copy) that is well AHEAD of
// its viewer steps down to the lowest CPU priority, and back up when the
// viewer comes near again.
//
// Why: at an evening's start everybody presses Play within seconds. Every
// copy and encode then runs at full speed until it is parked far ahead of
// its reader (jit COPY_LEAD_MAX 40 segments, remux AHEAD_MAX 50): about a
// dozen seconds of a core each. Twenty of them at once filled the CPU, and the
// viewers still waiting for their FIRST segment waited behind the ones
// already minutes ahead (capacity-2026-10: TV offset starts p95 7–13 s at 20–
// 30 viewers). Running ahead stays exactly as it was — it just yields to
// whoever is still waiting.
//
// Windows only: there a process may be put back to the priority it had. On
// Linux / macOS raising a nice value back needs privileges, so a producer
// once lowered could not be raised when its viewer caught up — those systems
// keep the old behaviour.
"use strict";
const os = require("os");

const LOW_AT = 6; // segments ahead of the reader (~36–60 s of film)
const BACK_AT = 3;
const deps = {
  platform: () => process.platform,
  get: (pid) => os.getPriority(pid),
  set: (pid, p) => os.setPriority(pid, p),
};

// holder: the run / job object (keeps its own state on it). → "low" | "back" | null
const step = (holder, pid, lead) => {
  if (!holder || !pid || deps.platform() !== "win32" || !Number.isFinite(lead)) return null;
  if (!holder.leadLow && lead >= LOW_AT) {
    try {
      holder.leadPrio = deps.get(pid);
      deps.set(pid, os.constants.priority.PRIORITY_LOW);
      holder.leadLow = true;
      return "low";
    } catch { return null; }
  }
  if (holder.leadLow && lead < BACK_AT) {
    try {
      deps.set(pid, holder.leadPrio != null ? holder.leadPrio : os.constants.priority.PRIORITY_BELOW_NORMAL);
      holder.leadLow = false;
      return "back";
    } catch { return null; }
  }
  return null;
};

module.exports = { step, LOW_AT, BACK_AT, _deps: deps };
