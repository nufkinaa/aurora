// Torrent-engine benchmark: WebTorrent (the streaming engine) vs aria2 (the
// download engine) on the SAME legal, well-seeded torrent — Blender's open
// movies, the canonical WebTorrent test content. Measures what the dev-plan's
// prompt-01 needs: metadata time, peer ramp, first byte, sustained throughput,
// and a mid-file seek read. Standalone: never touches the running server.
//
//   node tools/bench-torrent.js [seconds=25]
//
// Writes a JSON summary line to stdout at the end (grep for BENCH_RESULT).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const config = require("../src/config");

const RUN_SECS = Math.max(10, parseInt(process.argv[2], 10) || 25);

// Sintel (2010), (c) Blender Foundation, CC BY 3.0 — webtorrent.io's demo.
const INFOHASH = "08ada5a7a6183aae1e09d831df6748d566095a10";
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.openwebtorrent.com",
];
const magnet =
  `magnet:?xt=urn:btih:${INFOHASH}&dn=Sintel&` +
  TRACKERS.map((t) => "tr=" + encodeURIComponent(t)).join("&");

const now = () => Date.now();
const result = { runSecs: RUN_SECS, webtorrent: {}, aria2: {} };

const benchWebTorrent = () =>
  new Promise(async (resolve) => {
    const { default: WebTorrent } = await import("webtorrent");
    // Mirror the server's client options exactly (src/media/torrent.js
    // getClient), so this measures what production would do.
    const client = new WebTorrent({
      maxConns: 40,
      seedOutgoingConnections: false,
      utp: false,
      tracker: { getAnnounceOpts: () => ({ numwant: 200 }) },
    });
    client.on("error", () => {});
    const t0 = now();
    const R = result.webtorrent;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-bench-wt-"));
    const torrent = client.add(magnet, { path: tmp });
    torrent.on("error", () => {});
    let peakPeers = 0;
    const peerPoll = setInterval(() => {
      peakPeers = Math.max(peakPeers, torrent.numPeers || 0);
    }, 500);
    torrent.once("wire", () => (R.firstPeerMs = now() - t0));
    torrent.once("metadata", () => (R.metadataMs = now() - t0));
    torrent.once("ready", async () => {
      R.readyMs = now() - t0;
      const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
      R.file = { name: file.name, mb: Math.round(file.length / 1048576) };
      // First byte at offset 0 (what "press play" waits for)
      const fb0 = now();
      const first = file.createReadStream({ start: 0, end: 65535 });
      first.once("data", () => {
        R.firstByteMs = now() - t0;
        R.firstByteAfterReadyMs = now() - fb0;
        first.destroy();
      });
      // Free run for throughput
      const dl0 = torrent.downloaded;
      setTimeout(async () => {
        R.downloadedMB = Math.round(((torrent.downloaded - dl0) / 1048576) * 10) / 10;
        R.avgMBps = Math.round((R.downloadedMB / RUN_SECS) * 100) / 100;
        R.peakPeers = peakPeers;
        // Seek test: 1 byte from 60% into the file (measures far-seek latency)
        const seekStart = Math.floor(file.length * 0.6);
        const s0 = now();
        const seekStream = file.createReadStream({ start: seekStart, end: seekStart + 65535 });
        const seekDone = (label) => {
          R.seekReadMs = label === "ok" ? now() - s0 : -1;
          clearInterval(peerPoll);
          client.destroy(() => {
            try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
            resolve();
          });
        };
        const seekTimer = setTimeout(() => { seekStream.destroy(); seekDone("timeout"); }, 60000);
        seekStream.once("data", () => { clearTimeout(seekTimer); seekStream.destroy(); seekDone("ok"); });
      }, RUN_SECS * 1000);
    });
    // Hard cap: give up entirely after 90s of nothing
    setTimeout(() => {
      if (!R.readyMs) {
        R.error = "no metadata within 90s";
        clearInterval(peerPoll);
        client.destroy(() => resolve());
      }
    }, 90000).unref();
  });

const rpc = async (port, method, params = []) => {
  const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "b", method, params: ["token:bench", ...params] }),
    signal: AbortSignal.timeout(4000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
};

const benchAria2 = async () => {
  const R = result.aria2;
  if (!config.ARIA2) { R.error = "aria2 not installed"; return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-bench-a2-"));
  const port = 6899;
  const proc = spawn(config.ARIA2, [
    "--enable-rpc", `--rpc-listen-port=${port}`, "--rpc-secret=bench",
    "--rpc-listen-all=false", `--dir=${tmp}`, "--file-allocation=none",
    "--seed-time=0", "--enable-dht=true", "--bt-enable-lpd=false",
    "--max-connection-per-server=8", "--quiet",
  ], { stdio: "ignore" });
  try {
    // wait for RPC to come up
    for (let i = 0; i < 20; i++) {
      try { await rpc(port, "aria2.getVersion"); break; }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }
    const t0 = now();
    const gid = await rpc(port, "aria2.addUri", [[magnet]]);
    // magnet GID completes when metadata is fetched; the real download follows
    let followGid = null;
    while (!followGid) {
      const st = await rpc(port, "aria2.tellStatus", [gid]).catch(() => null);
      if (st && st.followedBy && st.followedBy[0]) followGid = st.followedBy[0];
      else if (st && st.status === "error") { R.error = "magnet failed"; return; }
      if (now() - t0 > 90000) { R.error = "no metadata within 90s"; return; }
      if (!followGid) await new Promise((r) => setTimeout(r, 250));
    }
    R.metadataMs = now() - t0;
    // sample the follow-on download for RUN_SECS
    const dlStart = now();
    let last = null, peakPeers = 0, firstByteMs = null;
    while (now() - dlStart < RUN_SECS * 1000) {
      last = await rpc(port, "aria2.tellStatus", [followGid]).catch(() => last);
      if (last) {
        peakPeers = Math.max(peakPeers, parseInt(last.connections || 0, 10));
        if (firstByteMs === null && parseInt(last.completedLength, 10) > 0)
          firstByteMs = now() - t0;
        if (last.status === "complete") break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (last) {
      R.firstByteMs = firstByteMs;
      R.downloadedMB = Math.round((parseInt(last.completedLength, 10) / 1048576) * 10) / 10;
      const secs = Math.min(RUN_SECS, (now() - dlStart) / 1000);
      R.avgMBps = Math.round((R.downloadedMB / secs) * 100) / 100;
      R.peakPeers = peakPeers;
      R.complete = last.status === "complete";
    }
  } finally {
    try { proc.kill(); } catch {}
    setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 1500);
  }
};

(async () => {
  console.log(`Benchmarking on Sintel (${INFOHASH.slice(0, 8)}…), ${RUN_SECS}s per engine`);
  console.log("— WebTorrent (the streaming engine) —");
  await benchWebTorrent();
  console.log(JSON.stringify(result.webtorrent, null, 2));
  console.log("— aria2 (the download engine) —");
  await benchAria2();
  console.log(JSON.stringify(result.aria2, null, 2));
  console.log("BENCH_RESULT " + JSON.stringify(result));
  process.exit(0);
})();
