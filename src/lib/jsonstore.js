// Tiny persistent JSON store with debounced, atomic writes.
const fs = require("fs");
const path = require("path");

// Every instance registers here so we can flush them all on shutdown (the 1.5s
// debounce would otherwise lose the most recent writes when the process exits).
const instances = new Set();

class JsonStore {
  constructor(filePath, fallback) {
    this.filePath = filePath;
    this.saveTimer = null;
    try {
      this.data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
      // A corrupt (but non-empty) store must never be silently replaced: the
      // first save() after boot would rename defaults over it and permanently
      // destroy every profile / watch history. Set the readable-but-broken
      // file aside so it stays recoverable.
      if (err.code !== "ENOENT") {
        try {
          const backup = `${filePath}.corrupt-${Date.now()}`;
          fs.copyFileSync(filePath, backup);
          console.error(`Corrupt store ${filePath} — backed up to ${backup}, starting from defaults`);
        } catch {}
      }
      this.data = typeof fallback === "function" ? fallback() : fallback;
    }
    instances.add(this);
  }

  // Atomic write: write to a temp file then rename over the target. rename is
  // atomic on the same volume, so a crash/power-loss mid-write can never leave a
  // truncated JSON file that fails to parse on next boot (which would silently
  // wipe watch history / sessions / bans).
  _writeNow() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error(`Failed to save ${this.filePath}:`, err.message);
    }
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this._writeNow();
    }, 1500);
  }

  // Write immediately (e.g. on shutdown)
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this._writeNow();
  }
}

// Flush every store with a pending write. Called on process shutdown.
const flushAll = () => {
  for (const s of instances) if (s.saveTimer) s.flush();
};

// Persist pending writes on normal shutdown so recent progress/state isn't lost.
let flushed = false;
const onExit = () => {
  if (flushed) return;
  flushed = true;
  flushAll();
};
process.on("SIGINT", () => { onExit(); process.exit(0); });
process.on("SIGTERM", () => { onExit(); process.exit(0); });
process.on("beforeExit", onExit);

module.exports = { JsonStore, flushAll };
