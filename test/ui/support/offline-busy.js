// Preloaded (node -r, after the fence) into a private instance by the offline
// tests (offline.test.js): the server's state when elia's iPhone said
// "Preparing on the server" and nothing more (2026-10-20) — somebody's stream
// is being encoded (a viewer encode that does not end), and a play-ready copy
// made ahead of time after a download (preconvert.js) is waiting in line for
// the encoder. Nothing of the app is changed: this only puts it in that state.
//
//   UI_OFFLINE_BUSY=1      turns it on (the instance's env, ui-test-server opts.env)
const EventEmitter = require("events");
const path = require("path");

if (process.env.UI_OFFLINE_BUSY === "1") {
  const root = process.cwd(); // the instance folder (ui-test-server starts it there)
  const t = setInterval(() => {
    try {
      const scanner = require(path.join(root, "src", "media", "scanner"));
      const metadata = require(path.join(root, "src", "media", "metadata"));
      const film = (scanner.allItems() || []).find((x) => x && x.title === "Test Film Two");
      const entry = film && scanner.resolve(film.id);
      if (!entry || !(metadata.getCached(entry.path) || {}).video) return;
      clearInterval(t);
      const cpuwork = require(path.join(root, "src", "media", "cpuwork"));
      const offline = require(path.join(root, "src", "media", "offline"));
      const viewer = new EventEmitter();
      viewer.pid = 0;
      viewer.kill = () => true;
      cpuwork.viewer.track(viewer, { kind: "ladder", label: "somebody's stream (offline-busy)" });
      const st = offline.prepare(film.id, "1080", {}, { keepMs: 6 * 24 * 3600 * 1000 });
      process.stdout.write(`[offline-busy] a viewer encode is running and a play-ready copy of ${film.id} waits (${st.state})\n`);
    } catch (e) {
      process.stdout.write(`[offline-busy] not yet: ${e.message}\n`);
    }
  }, 300);
  t.unref();
}
