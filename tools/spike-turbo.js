// Prompt-03 GO/NO-GO spike: could an aria2-fed reader ("turbo path") serve a
// STREAM better than the tuned WebTorrent engine? aria2 fills pieces
// OUT-OF-ORDER (no sequential/in-order mode for BitTorrent), so the question
// is: when a viewer seeks to X%, how long until aria2's own piece picker
// happens to complete that region — versus WebTorrent, which re-prioritizes
// toward the playhead on demand. Measures, on Blender's Sintel:
//   - per-decile completion times (the fill pattern a reader would live with)
//   - wait-until-proven for seek targets at 20/50/80% of the video file
//   - the bitfield→per-file completed-ranges derivation the build would need
//
//   node tools/spike-turbo.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const config = require("../src/config");

const INFOHASH = "08ada5a7a6183aae1e09d831df6748d566095a10"; // Sintel (CC)
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
];
const magnet =
  `magnet:?xt=urn:btih:${INFOHASH}&dn=Sintel&` +
  TRACKERS.map((t) => "tr=" + encodeURIComponent(t)).join("&");

const rpc = async (port, method, params = []) => {
  const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "s", method, params: ["token:spike", ...params] }),
    signal: AbortSignal.timeout(4000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
};

// hex bitfield -> is piece p complete?
const hasPiece = (hexBitfield, p) => {
  const nibble = parseInt(hexBitfield[p >> 2] || "0", 16);
  return !!(nibble & (8 >> (p & 3)));
};

// The derivation the real build would ship: which byte ranges of file
// [fileStart, fileEnd) are PROVEN complete by the whole-torrent bitfield.
// Interior-piece rule: a piece is proof only if it lies entirely inside the
// file, OR the bitfield marks it AND the file boundary truncates it — for the
// spike we accept boundary pieces when marked complete (aria2 verifies whole
// pieces, so a marked boundary piece's bytes inside our file are valid).
const regionProven = (hexBitfield, pieceLen, fileStart, byteFrom, byteTo) => {
  if (byteTo <= byteFrom) return false; // empty region proves nothing
  const absFrom = fileStart + byteFrom;
  const absTo = fileStart + byteTo; // exclusive
  const pFrom = Math.floor(absFrom / pieceLen);
  const pTo = Math.floor((absTo - 1) / pieceLen);
  for (let p = pFrom; p <= pTo; p++) if (!hasPiece(hexBitfield, p)) return false;
  return true;
};

(async () => {
  if (!config.ARIA2) {
    console.log("aria2 not installed — spike cannot run");
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-spike-"));
  const port = 6898;
  const proc = spawn(config.ARIA2, [
    "--enable-rpc", `--rpc-listen-port=${port}`, "--rpc-secret=spike",
    "--rpc-listen-all=false", `--dir=${tmp}`, "--file-allocation=none",
    "--seed-time=0", "--enable-dht=true",
    // Keep DHT state inside the temp dir, not the user's ~/.aria2.
    `--dht-file-path=${path.join(tmp, "dht.dat")}`,
    // No orphan if this script dies (house pattern — see src/media/aria2.js).
    `--stop-with-process=${process.pid}`,
    // Mirror the production download pipeline's prioritization (aria2.js):
    "--bt-prioritize-piece=head,tail",
    "--max-connection-per-server=8", "--quiet",
  ], { stdio: "ignore" });

  try {
    for (let i = 0; i < 20; i++) {
      try { await rpc(port, "aria2.getVersion"); break; }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }
    const t0 = Date.now();
    const gid = await rpc(port, "aria2.addUri", [[magnet]]);
    let follow = null;
    while (!follow) {
      const st = await rpc(port, "aria2.tellStatus", [gid]).catch(() => null);
      if (st && st.followedBy && st.followedBy[0]) follow = st.followedBy[0];
      if (Date.now() - t0 > 90000) throw new Error("no metadata in 90s");
      if (!follow) await new Promise((r) => setTimeout(r, 200));
    }
    const metadataMs = Date.now() - t0;

    // Identify the video file + its absolute byte offset in the torrent.
    let st = await rpc(port, "aria2.tellStatus", [follow]);
    const pieceLen = parseInt(st.pieceLength, 10);
    let fileStart = 0, video = null;
    for (const f of st.files) {
      const len = parseInt(f.length, 10);
      if (!video || len > parseInt(video.length, 10)) {
        video = f;
        video._start = fileStart; // start recorded BEFORE advancing
      }
      fileStart += len;
    }
    const vlen = parseInt(video.length, 10);
    console.log(`metadata ${metadataMs}ms; video ${path.basename(video.path)} ${Math.round(vlen / 1048576)}MB, pieceLen ${pieceLen}, start@${video._start}`);

    // Seek targets: 2MB regions at 20/50/80% of the video file.
    const targets = [0.2, 0.5, 0.8].map((f) => ({
      frac: f,
      from: Math.min(vlen - 2097152, Math.floor(vlen * f)),
      provenAtMs: null,
    }));
    const deciles = Array.from({ length: 10 }, (_, i) => ({ i, doneAtMs: null }));

    const dlStart = Date.now();
    let doneAtMs = null;
    let rpcFails = 0;
    while (true) {
      const fresh = await rpc(port, "aria2.tellStatus", [follow]).catch(() => null);
      // A dead aria2 must invalidate the measurement, not read as a slow swarm.
      if (!fresh) {
        if (++rpcFails >= 10) throw new Error("aria2 RPC died mid-measurement — result invalid");
      } else {
        rpcFails = 0;
        st = fresh;
      }
      const bf = st.bitfield || "";
      const now = Date.now() - dlStart;
      for (const t of targets) {
        if (t.provenAtMs === null && bf &&
            regionProven(bf, pieceLen, video._start, t.from, t.from + 2097152)) {
          t.provenAtMs = now;
        }
      }
      for (const d of deciles) {
        if (d.doneAtMs === null && bf) {
          const from = Math.floor((vlen * d.i) / 10);
          const to = Math.min(vlen, Math.floor((vlen * (d.i + 1)) / 10));
          if (regionProven(bf, pieceLen, video._start, from, to)) d.doneAtMs = now;
        }
      }
      if (st.status === "complete" || parseInt(st.completedLength, 10) >= parseInt(st.totalLength, 10)) {
        doneAtMs = now;
        break;
      }
      if (now > 180000) { console.log("(180s cap hit)"); break; }
      await new Promise((r) => setTimeout(r, 200));
    }

    // Verify a real read of a proven region from the growing file works.
    const readTarget = targets[1];
    let readMs = null;
    if (readTarget.provenAtMs !== null) {
      const r0 = Date.now();
      const fd = fs.openSync(video.path, "r"); // aria2 reports absolute paths
      const buf = Buffer.alloc(1048576);
      const got = fs.readSync(fd, buf, 0, buf.length, readTarget.from);
      fs.closeSync(fd);
      if (got !== buf.length) throw new Error(`short read from proven region (${got}/${buf.length}) — result invalid`);
      readMs = Date.now() - r0;
    }

    const result = {
      metadataMs,
      totalDownloadMs: doneAtMs,
      avgMBps: doneAtMs ? Math.round(((vlen / 1048576) / (doneAtMs / 1000)) * 100) / 100 : null,
      seekWaits: targets.map((t) => ({ at: `${t.frac * 100}%`, provenAtMs: t.provenAtMs, asFractionOfTotal: doneAtMs && t.provenAtMs !== null ? Math.round((t.provenAtMs / doneAtMs) * 100) / 100 : null })),
      decileDoneAtMs: deciles.map((d) => d.doneAtMs),
      provenRegionReadMs: readMs,
    };
    if (doneAtMs === null) throw new Error("hit the 180s cap — measurement incomplete");
    console.log("SPIKE_RESULT " + JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (err) {
    console.error("SPIKE FAILED:", err.message);
    process.exitCode = 1;
  } finally {
    try { proc.kill(); } catch {}
    // AWAITED, not fire-and-forget: process.exit()/unhandled exits discard
    // timers, which leaked a full Sintel per run into %TEMP% (review finding).
    // The delay lets Windows release aria2's file handles before rmSync.
    await new Promise((r) => setTimeout(r, 1500));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
})();
