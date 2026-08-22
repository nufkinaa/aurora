// The download engine: an aria2c daemon, driven over its JSON-RPC API.
//
// Streaming still uses the in-process WebTorrent client — it is good at "give me
// these bytes now". Downloading to the library is a different job, and our own
// engine could never answer its two central questions honestly:
//
//   * how much of THIS file (one episode out of a 7-file pack) is on disk?
//   * is it finished?
//
// Measured 2026-07-27 on the same pack: WebTorrent's bitfield was missing 300+
// pieces that were verifiably intact in its own store, so reported progress went
// 65 → 68 → 70 → 68 → 66 and then sat frozen; completion needed a hand-rolled
// SHA-1 sweep of the staging directory to detect at all. aria2 downloaded the
// same episode with 0 backwards steps in 106 samples, at 17 MB/s, and said
// "complete" when it was complete. `files[].completedLength` is the answer to
// the first question and `status` is the answer to the second.
//
// This module owns the daemon and the RPC. It knows nothing about jobs or the
// library; media/downloads.js keeps that.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("../config");

// One directory per torrent, under our own root — never shared with the
// streaming client's store, which is a different engine writing the same files.
const STAGING_ROOT = path.join(os.tmpdir(), "aurora-downloads");
const stagingDir = (infoHash) => path.join(STAGING_ROOT, infoHash);

// A fresh secret per boot: the RPC only listens on localhost, but anything else
// running on this machine shouldn't be able to drive our downloader.
const SECRET = crypto.randomBytes(16).toString("hex");
const PORT = config.ARIA2_PORT;
const ENDPOINT = `http://127.0.0.1:${PORT}/jsonrpc`;

const available = () => !!config.ARIA2;

let proc = null;
let startup = null;

const spawnDaemon = () => {
  const args = [
    "--enable-rpc",
    "--rpc-listen-all=false",              // localhost only
    `--rpc-listen-port=${PORT}`,
    `--rpc-secret=${SECRET}`,
    `--dir=${STAGING_ROOT}`,
    `--stop-with-process=${process.pid}`,  // no orphan if the server dies (Windows has no process groups; works on Linux too)
    "--continue=true",                     // resume from the staging bytes after a restart
    "--seed-time=0",                       // we are not a seedbox
    "--bt-save-metadata=true",             // cache the .torrent…
    "--bt-load-saved-metadata=true",       // …so a second episode of a pack skips the metadata hunt
    "--file-allocation=none",              // preallocating a 4 GB pack stalls the add on Windows
    // Keep the DHT routing table between runs. Without a path aria2 looks for
    // one in ~/.cache and logs "Failed to load DHT routing table" on every
    // start, beginning each boot with an empty table; persisting it lets peer
    // discovery warm up instead of starting cold every time.
    `--dht-file-path=${path.join(config.DATA_DIR, "aria2", "dht.dat")}`,
    `--dht-file-path6=${path.join(config.DATA_DIR, "aria2", "dht6.dat")}`,
    "--enable-dht=true",
    "--dht-entry-point=router.bittorrent.com:6881",
    "--summary-interval=0",                // no periodic console noise
    "--console-log-level=warn",
    "--max-concurrent-downloads=4",
    "--bt-max-peers=100",
    // A dead tracker must not hold up the start. The defaults are 60s each, and
    // one unreachable entry near the front of the list cost 22 seconds before a
    // single peer was found (measured 2026-07-27).
    "--bt-tracker-timeout=8",
    "--bt-tracker-connect-timeout=5",
    // Fetch the first and last pieces of the wanted file first. Progress for one
    // file inside a pack only moves when a whole PIECE of that file completes,
    // so without this the job sits at 0% while aria2 fills pieces elsewhere —
    // 62 seconds of apparent nothing in the same measurement, versus 2 with it.
    "--bt-prioritize-piece=head,tail",
    "--bt-request-peer-speed-limit=10M",   // keep asking for peers until it's genuinely fast
    "--follow-torrent=true",
  ];
  const child = spawn(config.ARIA2, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (d) => {
    const line = String(d).trim();
    if (line) console.log(`[aria2] ${line.slice(0, 300)}`);
  });
  child.stderr.on("data", (d) => {
    const line = String(d).trim();
    if (line) console.warn(`[aria2] ${line.slice(0, 300)}`);
  });
  child.on("exit", (code) => {
    console.warn(`[aria2] daemon exited (code ${code})`);
    if (proc === child) { proc = null; startup = null; }
  });
  return child;
};

// Bring the daemon up (idempotent) and wait until the RPC answers.
const ensure = async () => {
  if (!available()) throw new Error("aria2 is not installed on this server");
  if (proc && startup) return startup;
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  fs.mkdirSync(path.join(config.DATA_DIR, "aria2"), { recursive: true });
  proc = spawnDaemon();
  startup = (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const v = await call("aria2.getVersion");
        console.log(`[aria2] ready — version ${v.version}`);
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error("aria2 did not start (RPC never answered)");
  })();
  return startup;
};

// Raw JSON-RPC. Everything below goes through here.
const call = async (method, params = []) => {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomBytes(6).toString("hex"),
      method,
      params: [`token:${SECRET}`, ...params],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};

const rpc = async (method, params) => {
  await ensure();
  return call(method, params);
};

// ---------- downloads ----------

// A magnet arrives as TWO downloads: aria2 first fetches the torrent's details
// under one GID — a placeholder it names "[METADATA]<hash>" — and then follows
// it with the real download under another. Only the second one has the files, so
// this is how we tell them apart. (Guessing from the file extension does not
// work: the placeholder has no ".torrent" suffix, and taking it for the real
// download left jobs sitting at 0% while aria2 quietly finished the episode.)
const isMetadataPlaceholder = (files) =>
  files.length === 1 && /\[METADATA\]/i.test(files[0].path || "");

// Adds that haven't registered their infoHash yet: infoHash -> Promise<gid>.
// Two episodes of one pack are requested in the same tick, and aria2 refuses a
// second add of the same torrent ("InfoHash … is already registered"), so the
// second caller has to wait for the first and join it.
const adding = new Map();

// Start (or join) the download of one torrent, wanting `fileIndex` (1-based, the
// way aria2 numbers files). Returns the GID of the real torrent download.
//
// NOT an async function on purpose: the in-flight entry has to be registered in
// the same tick as the call. Two episodes of a pack are requested together, and
// if the first `await` happens before the map is written, the second caller
// still sees nothing in flight and adds the torrent a second time — which aria2
// rejects with "InfoHash … is already registered" and the episode never starts.
const add = (magnet, infoHash, fileIndex) => {
  const joined = adding.get(infoHash);
  if (joined) return joined.then((gid) => select(gid, fileIndex, true).then(() => gid));

  const p = (async () => {
    // Already downloading this torrent (a sibling episode from an earlier
    // request)? Join it rather than adding a duplicate.
    const existing = await findByInfoHash(infoHash);
    if (existing) return existing;

    const dir = stagingDir(infoHash);
    fs.mkdirSync(dir, { recursive: true });
    const gid = await rpc("aria2.addUri", [[magnet], {
      dir,
      "select-file": String(fileIndex),
      "bt-save-metadata": "true",
    }]);

    // Wait out the metadata phase and return the GID that actually has files.
    const deadline = Date.now() + 5 * 60 * 1000;
    for (;;) {
      const st = await rpc("aria2.tellStatus", [gid, ["status", "followedBy", "errorMessage", "files"]]);
      if (st.followedBy && st.followedBy.length) return st.followedBy[0];
      if (st.status === "error") {
        throw new Error(st.errorMessage || "aria2 could not fetch the torrent details");
      }
      // A cached .torrent (bt-load-saved-metadata) means there was never a
      // placeholder to follow — this GID is already the real download.
      if (st.files && st.files.length && !isMetadataPlaceholder(st.files)) return gid;
      if (Date.now() > deadline) throw new Error("no peers had the torrent details after 5 minutes");
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();

  adding.set(infoHash, p);                    // synchronous: see the note above
  p.finally(() => { if (adding.get(infoHash) === p) adding.delete(infoHash); });

  // Make sure this caller's file is selected even when it joined an add that was
  // started for a different episode.
  return p.then((gid) => select(gid, fileIndex, true).catch(() => {}).then(() => gid));
};

// Which of our downloads is this torrent, if any? Skips the [METADATA]
// placeholder, which carries the same infoHash but has no files to select.
const findByInfoHash = async (infoHash) => {
  const wanted = String(infoHash).toLowerCase();
  const lists = await Promise.all([
    rpc("aria2.tellActive", [["gid", "infoHash", "files"]]).catch(() => []),
    rpc("aria2.tellWaiting", [0, 50, ["gid", "infoHash", "files"]]).catch(() => []),
  ]);
  for (const d of lists.flat()) {
    if (!d.infoHash || String(d.infoHash).toLowerCase() !== wanted) continue;
    if (isMetadataPlaceholder(d.files || [])) continue;
    return d.gid;
  }
  return null;
};

// Add (or drop) a file from what this download is fetching. aria2 takes the
// complete list every time, so read the current selection and adjust it.
const select = async (gid, fileIndex, wanted) => {
  const files = await rpc("aria2.getFiles", [gid]);
  const chosen = new Set(
    files.filter((f) => f.selected === "true").map((f) => Number(f.index))
  );
  if (wanted) chosen.add(Number(fileIndex));
  else chosen.delete(Number(fileIndex));
  if (!chosen.size) return false;            // nothing left to want
  await rpc("aria2.changeOption", [gid, { "select-file": [...chosen].sort((a, b) => a - b).join(",") }]);
  return true;
};

// Everything media/downloads.js needs to know about a running download, with the
// numbers already turned into the shapes it uses.
const status = async (gid) => {
  const st = await rpc("aria2.tellStatus", [gid, [
    "status", "errorMessage", "downloadSpeed", "connections", "numSeeders", "files", "infoHash",
  ]]);
  return {
    state: st.status,                                   // active | waiting | paused | complete | error | removed
    error: st.errorMessage || null,
    downloadSpeed: Number(st.downloadSpeed || 0),
    peers: Number(st.numSeeders || st.connections || 0),
    infoHash: st.infoHash || null,
    files: (st.files || []).map((f) => ({
      index: Number(f.index),
      path: f.path,
      length: Number(f.length),
      completed: Number(f.completedLength),
      selected: f.selected === "true",
    })),
  };
};

// One file's progress within a download. `null` when the download no longer
// knows about that index (removed, or metadata not in yet).
const fileProgress = (st, fileIndex) => {
  const f = st.files.find((x) => x.index === Number(fileIndex));
  if (!f || !f.length) return null;
  return { ...f, fraction: Math.min(1, f.completed / f.length) };
};

// Stop a download and forget it. The bytes on disk are left alone — deciding
// whether they're still wanted belongs to the queue (see purge).
const remove = async (gid) => {
  try { await rpc("aria2.forceRemove", [gid]); } catch {}
  try { await rpc("aria2.removeDownloadResult", [gid]); } catch {}
};

// Delete a torrent's staging bytes. Called only once nothing wants them.
const purge = async (infoHash) => {
  const dir = stagingDir(infoHash);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    console.log(`[aria2] purged staging for ${String(infoHash).slice(0, 8)}…`);
  } catch (e) {
    console.warn(`[aria2] could not purge ${dir}:`, e && e.message);
  }
};

// Diagnostics for the admin panel.
const activeDownloads = async () => {
  if (!proc) return [];
  return rpc("aria2.tellActive", [[
    "gid", "infoHash", "status", "downloadSpeed", "connections", "numSeeders",
    "completedLength", "totalLength", "files",
  ]]).catch(() => []);
};

const shutdown = () => {
  if (!proc) return;
  try { proc.kill(); } catch {}
  proc = null;
  startup = null;
};
// --stop-with-process covers a hard kill; this is the tidy path.
process.on("exit", shutdown);

module.exports = {
  available, ensure, add, status, fileProgress, select, remove, purge,
  activeDownloads, shutdown, stagingDir, STAGING_ROOT,
  // Test-only: the rule that tells the real download apart from the metadata
  // placeholder. Getting this wrong parks every job at 0%, so it is pinned.
  _internals: { isMetadataPlaceholder },
};
