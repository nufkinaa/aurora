// Preloaded (node -r, after the fence) into a private instance by the browser
// tests of "save it to this device too" (offline-wish.test.js): a download
// engine that is an in-memory fake, so a download can be STAGED and made to
// LAND without anything leaving the machine — the same fake test/dl-landing
// and test/offline-wish-landing use, driven by files the test writes:
//
//   <instance>/wish-stage/<n>.json   { op: "create", hash, src, fields }   a download of `src`
//                                    (a real video) starts, with `fields` (downloads.create)
//                                    { op: "land", hash }                    its bytes are all in
//                                    { op: "fail", jobId }                   it is cancelled
// Each command is answered in <n>.done.json ({ ok, jobId?, error? }).
//
//   UI_WISH_STAGE=1      turns it on (the instance's env, ui-test-server opts.env)
const fs = require("fs");
const path = require("path");

// (only the server itself: a helper the server forks inherits this preload)
if (process.env.UI_WISH_STAGE === "1" && !process.send && require("worker_threads").isMainThread) {
  const root = process.cwd();
  const dir = path.join(root, "wish-stage");
  const staging = path.join(root, "tmp", "wish-staging");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(staging, { recursive: true });
  let downloads = null;
  let D = null;
  const torrents = new Map();
  const byGid = new Map();
  let seq = 0;
  const engine = {
    available: () => true,
    running: () => true,
    stagingDir: (h) => path.join(staging, h),
    fileProgress: null,
    add(magnet, infoHash, fileIndex) {
      const t = torrents.get(infoHash);
      if (!t) return Promise.reject(new Error(`unknown torrent ${infoHash}`));
      if (!t.gid) { t.gid = `gid${++seq}`; byGid.set(t.gid, t); }
      t.files.find((f) => f.index === fileIndex).selected = true;
      return Promise.resolve(t.gid);
    },
    async status(gid) {
      const t = byGid.get(gid);
      if (!t) throw new Error(`aria2.tellStatus: GID ${gid} is not found`);
      return { state: t.state, error: null, downloadSpeed: 250000, peers: 3, seeders: 3, connections: 3, infoHash: t.infoHash, files: t.files.map((f) => ({ ...f })) };
    },
    async select() { return true; },
    async remove(gid) { byGid.delete(gid); },
    async removeByInfoHash(h) { const t = torrents.get(h); if (t && t.gid) byGid.delete(t.gid); return 1; },
    async purge() {},
    applyEnginePlan: async () => ({ applied: true }),
  };
  const run = async (cmd) => {
    if (cmd.op === "create") {
      const d = path.join(staging, cmd.hash);
      fs.mkdirSync(d, { recursive: true });
      const p = path.join(d, `release${path.extname(cmd.src)}`);
      fs.copyFileSync(cmd.src, p);
      const length = fs.statSync(p).size;
      // a third of it in, so the page shows a download on its way
      torrents.set(cmd.hash, { infoHash: cmd.hash, gid: null, state: "active", files: [{ index: 1, path: p, length, completed: Math.floor(length / 3), selected: false }] });
      const r = downloads.create({ infoHash: cmd.hash, fileIdx: 0, sizeBytes: length, ...cmd.fields });
      if (!r.job) return { ok: false, error: r.error || JSON.stringify(r) };
      // (a nearly full test disk asks for an admin's approval: given here)
      if (r.needsApproval) downloads.approve(r.job.id);
      return { ok: true, jobId: r.job.id };
    }
    if (cmd.op === "land") {
      const t = torrents.get(cmd.hash);
      t.files[0].completed = t.files[0].length;
      await D.poll();
      return { ok: true };
    }
    if (cmd.op === "fail") {
      downloads.cancel(cmd.jobId, "self");
      return { ok: true };
    }
    return { ok: false, error: "unknown op" };
  };
  const t = setInterval(async () => {
    try {
      if (!downloads) {
        downloads = require(path.join(root, "src", "media", "downloads"));
        D = downloads._internals;
        engine.fileProgress = require(path.join(root, "src", "media", "aria2")).fileProgress;
        D.setEngine(engine);
        D.seams.findSources = async () => { throw new Error("no second sources here"); };
        D.seams.probe = async () => null; // (a short test video is not "a sample, not the film" here)
        process.stdout.write("[wish-stage] a fake download engine is in place\n");
      }
      for (const f of fs.readdirSync(dir).filter((x) => /^\d+\.json$/.test(x)).sort()) {
        const p = path.join(dir, f);
        const cmd = JSON.parse(fs.readFileSync(p, "utf-8"));
        fs.renameSync(p, p.replace(/\.json$/, ".taken"));
        let out;
        try { out = await run(cmd); } catch (e) { out = { ok: false, error: e.message }; }
        // (written whole, then moved in: the test reads the answer the moment
        // it exists — a plain write was once read empty, "Unexpected end of
        // JSON input", on a Linux runner)
        fs.writeFileSync(p.replace(/\.json$/, ".done.tmp"), JSON.stringify(out));
        fs.renameSync(p.replace(/\.json$/, ".done.tmp"), p.replace(/\.json$/, ".done.json"));
        process.stdout.write(`[wish-stage] ${cmd.op} → ${JSON.stringify(out)}\n`);
      }
    } catch (e) {
      process.stdout.write(`[wish-stage] ${e.message}\n`);
    }
  }, 200);
  t.unref();
}
