// The SQLite work that may wait on the disk, off the event loop
// (lib/sqlitestore.js): WAL checkpoints (the part of SQLite that fsyncs),
// VACUUM INTO copies for the backups, and reading such a copy back as JSON.
// Its own connection; the server's connection keeps writing meanwhile (WAL).
"use strict";
const { parentPort, workerData } = require("worker_threads");

const emit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === "string" ? w : w && w.message;
  if (/SQLite is an experimental feature/i.test(String(msg || ""))) return;
  return emit.call(this, w, ...rest);
};
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = emit;

const db = new DatabaseSync(workerData.file);
db.exec("PRAGMA busy_timeout = 5000");

parentPort.on("message", (m) => {
  try {
    if (m.op === "checkpoint") {
      const mode = m.mode === "TRUNCATE" ? "TRUNCATE" : "PASSIVE";
      const r = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
      parentPort.postMessage({ id: m.id, ok: true, r });
    } else if (m.op === "vacuumInto") {
      db.prepare("VACUUM INTO ?").run(m.to);
      parentPort.postMessage({ id: m.id, ok: true });
    } else if (m.op === "export") {
      const stores = require(workerData.mod).exportFromFile(m.file);
      parentPort.postMessage({ id: m.id, ok: true, stores });
    } else {
      parentPort.postMessage({ id: m.id, ok: false, error: `unknown op ${m.op}` });
    }
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: (e && e.message) || String(e) });
  }
});
