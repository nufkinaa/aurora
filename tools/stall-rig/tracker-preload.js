// Preloaded into the torrent rig's private instance (after the test fence):
// the first public tracker the server always announces to is answered by the
// rig's own tracker on this machine (RIG_TRACKER_PORT). The server keeps its
// default tracker list as it is; nothing leaves the PC. Rig only.
"use strict";
const net = require("net");
const PORT = Number(process.env.RIG_TRACKER_PORT || 0);
const HOST = "tracker.opentrackr.org";
if (PORT) {
  const fenced = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const a = Array.isArray(args[0]) ? args[0] : args;
    if (a[0] && typeof a[0] === "object" && String(a[0].host || a[0].hostname || "").toLowerCase() === HOST) {
      a[0] = { ...a[0], host: "127.0.0.1", hostname: "127.0.0.1", port: PORT, lookup: undefined };
      if (Array.isArray(args[0])) args[0] = a; else args[0] = a[0];
    }
    return fenced.apply(this, args);
  };
}
