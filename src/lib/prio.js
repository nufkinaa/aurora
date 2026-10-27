// The CPU priority of the work a viewer is waiting on — streams being
// copied or encoded for somebody watching.
//
// The server lowers that work a step below itself (below normal) once it is
// under way, so the server and whoever else it serves come first; and it can
// raise one back when the viewer needs it NOW (jit promote, leadprio). On
// Windows a process may be put back to where it was. On Linux and macOS
// raising a nice value needs privileges the server does not have (it does,
// running as root): there, once lowered, a stream stays at nice 10 for the
// rest of the film — and nice 10 against nice 0 is about a tenth of a busy
// core. On a small Linux server (a 2–4 vCPU VPS: nufurora.com) that is the
// TV's offset encode and every jit encode after its first segment starving
// behind another viewer's copy running ahead, the picture's own pictures,
// a subtitle read: segments made slower than the film plays, and the film
// stopping to load on a good line.
//
// So: where a priority can be raised again, as before (viewer work below
// normal); where it cannot, viewer work stays at normal — level with the
// server and with every other viewer, still above the background work
// (cpuwork.js, the lowest priority), which is the order that matters.
"use strict";
const os = require("os");

const deps = {
  platform: () => process.platform,
  uid: () => (typeof process.getuid === "function" ? process.getuid() : -1),
};

// May this process raise a child's priority back after lowering it?
const canRaise = () => deps.platform() === "win32" || deps.uid() === 0;

// Where viewer work runs once it may yield.
const viewer = () => (canRaise() ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL);

module.exports = { canRaise, viewer, _deps: deps };
