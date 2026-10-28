// A remux job (a TV's copy start, offset, seek, and the single-rendition
// encode) keeps NORMAL priority until its first segment — its playlist — is
// out, and only then steps down to the viewers' own priority (lib/prio.js).
// It used to be below normal from its first instruction: under CPU load a
// copy start waited 20 s and failed "Remux did not start in time" (TV 5.7.1
// rig). Real ffmpeg; os.setPriority is watched, not replaced.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const config = require("../src/config");
const remux = require("../src/media/remux");
const prio = require("../src/lib/prio");
const sf = require("../src/lib/startfirst");

test("remux copy and encode jobs: normal priority until the playlist is out, then the viewers' own; a first-segment wait while it starts", { skip: !config.ffmpegAvailable && "no ffmpeg", timeout: 90000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-remuxprio-"));
  const film = path.join(tmp, "f.mkv");
  execFileSync(config.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=60", "-f", "lavfi", "-i", "sine=duration=60", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-c:a", "aac", "-shortest", film]);
  const real = os.setPriority;
  const calls = [];
  os.setPriority = (pid, p) => { calls.push({ pid, p, at: Date.now() }); try { real(pid, p); } catch {} };
  const jobsSeen = [];
  try {
    for (const vcodec of ["copy", "h264"]) {
      const waitsBefore = sf.status().stats.waits;
      const t0 = Date.now();
      const pending = remux.ensure(film, `prio${vcodec}${process.pid}`, { vcodec, ss: 7, seek: true });
      const dir = await pending;
      assert.ok(sf.status().stats.waits > waitsBefore, `${vcodec}: a first-segment wait was open while the job started`);
      const readyAt = Date.now();
      const job = remux._internals.jobs.get(dir);
      assert.ok(job && job.proc, `${vcodec}: running`);
      jobsSeen.push(job);
      const mine = calls.filter((c) => c.pid === job.proc.pid);
      const lowered = mine.filter((c) => c.p > os.constants.priority.PRIORITY_NORMAL); // (higher number = lower priority)
      for (const c of lowered) assert.ok(c.at >= readyAt - 150, `${vcodec}: not lowered before its playlist was out (${c.at - t0} ms vs ready ${readyAt - t0} ms)`);
      await new Promise((r) => setImmediate(r));
      const after = calls.filter((c) => c.pid === job.proc.pid);
      assert.equal(after.at(-1) && after.at(-1).p, prio.viewer(), `${vcodec}: the viewers' priority once its first segment is out`);
      assert.equal(sf.status().waiting, 0, "the wait ended with the playlist");
    }
  } finally {
    os.setPriority = real;
    await new Promise((r) => setTimeout(r, 300)); // (a colour probe of the encode's source may still be on its way)
    for (const job of jobsSeen) if (job.proc) { const p = job.proc; require("../src/lib/children").killNow(p); await new Promise((r) => (p.exitCode != null ? r() : p.once("close", r))); }
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
});
