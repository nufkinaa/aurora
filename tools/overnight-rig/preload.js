// Preloaded (node -r, after the fence) into a PRIVATE instance by
// tools/overnight-rig/run.js: the outside world the overnight preparation
// needs, made up — and nothing of the app changed.
//
//   - the catalogue knows the rig's show (its episode list), so "what comes
//     next" has an answer with no network;
//   - the source list answers with one made-up release per episode;
//   - the download ENGINE is a stand-in (as test/dlv2-queue.test.js does it):
//     a download "arrives" at once — the rig's own self-made episode file is
//     put where aria2 would have written it, and everything after that is the
//     real queue: the landing into the library, ffprobe's check, the scan.
//     No torrent, no peer, no tracker is ever contacted.
//
//   OVERNIGHT_RIG=<spec.json>   turns it on (ui-test-server opts.env). The spec:
//     { shows: { <imdbId>: <meta> }, sources: { "<imdbId>:<s>:<e>": [source] },
//       payloads: { <infoHash>: "<absolute path of the file it delivers>" } }
"use strict";
const fs = require("fs");
const path = require("path");

if (process.env.OVERNIGHT_RIG) {
  const spec = JSON.parse(fs.readFileSync(process.env.OVERNIGHT_RIG, "utf-8"));
  const root = process.cwd(); // the instance folder
  const S = (p) => require(path.join(root, "src", p));
  const say = (m) => process.stdout.write(`[overnight-rig] ${m}\n`);

  const makeEngine = (stagingRoot, fileProgress) => {
    const torrents = new Map(); // infoHash -> { gid, files }
    const byGid = new Map();
    let seq = 0;
    const deliver = (infoHash) => {
      const src = spec.payloads[infoHash];
      if (!src) throw new Error(`the rig has no file for ${infoHash}`);
      const dir = path.join(stagingRoot, infoHash);
      fs.mkdirSync(dir, { recursive: true });
      const to = path.join(dir, path.basename(src));
      fs.copyFileSync(src, to);
      const length = fs.statSync(to).size;
      return [{ index: 1, path: to, length, completed: length, selected: false }];
    };
    return {
      available: () => true,
      running: () => true,
      stagingDir: (h) => path.join(stagingRoot, h),
      fileProgress,
      add: async (magnet, infoHash, fileIndex) => {
        let t = torrents.get(infoHash);
        if (!t) { t = { infoHash, gid: null, files: deliver(infoHash) }; torrents.set(infoHash, t); }
        if (!t.gid || !byGid.has(t.gid)) { t.gid = `rig${++seq}`; byGid.set(t.gid, t); }
        const f = t.files.find((x) => x.index === Number(fileIndex));
        if (f) f.selected = true;
        say(`delivered ${path.basename(t.files[0].path)} (${(t.files[0].length / 1e6).toFixed(1)} MB) for ${infoHash.slice(0, 8)}`);
        return t.gid;
      },
      status: async (gid) => {
        const t = byGid.get(gid);
        if (!t) throw new Error(`aria2.tellStatus: GID ${gid} is not found`);
        return { state: "complete", error: null, errorCode: null, downloadSpeed: 0, peers: 0, seeders: 0, connections: 0, infoHash: t.infoHash,
          pieceLength: 16384, numPieces: 1, bitfield: "f", files: t.files.map((f) => ({ ...f })) };
      },
      select: async (gid, fileIndex, wanted) => { const t = byGid.get(gid); if (t) { const f = t.files.find((x) => x.index === Number(fileIndex)); if (f) f.selected = !!wanted; } return true; },
      limit: async () => "OK",
      peers: async () => [],
      remove: async (gid) => { byGid.delete(gid); },
      removeByInfoHash: async (h) => { const t = torrents.get(h); if (t && t.gid) byGid.delete(t.gid); return t ? 1 : 0; },
      purge: async (h) => { fs.rmSync(path.join(stagingRoot, h), { recursive: true, force: true }); },
      activeDownloads: async () => [...byGid.values()].map((t) => ({ gid: t.gid, infoHash: t.infoHash })),
      applyEnginePlan: async () => ({ applied: true }),
    };
  };

  const t = setInterval(() => {
    try {
      const downloads = S("media/downloads");
      const torrent = S("media/torrent");
      const discover = S("media/discover");
      const aria2 = S("media/aria2");
      clearInterval(t);
      const realMeta = discover.meta;
      discover.meta = async (kind, id, ...rest) => (spec.shows[id] ? spec.shows[id] : realMeta(kind, id, ...rest));
      const realCached = discover.metaCached;
      discover.metaCached = (kind, id) => spec.shows[id] || realCached(kind, id);
      torrent.getSources = async (kind, id, year, s, e) => ({ imdbId: id, streams: spec.sources[`${id}:${s}:${e}`] || [] });
      downloads._internals.setEngine(makeEngine(path.join(root, "tmp", "rig-staging"), aria2.fileProgress));
      say(`catalogue, sources and a stand-in download engine in place (${Object.keys(spec.payloads).length} deliverable files)`);
    } catch (e) {
      say(`not yet: ${e.message}`);
    }
  }, 100);
  t.unref();
}
