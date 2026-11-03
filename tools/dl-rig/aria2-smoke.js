#!/usr/bin/env node
// Does the local swarm (swarm.js) really behave like the swarms the household's
// downloads meet, as seen by the real aria2? Each scenario is one kind of
// torrent life — a fast copy, a slow one, nobody at all, a seeder that goes
// silent behind a live socket, one that leaves, one that lies, a season pack —
// and the table at the end is what aria2's RPC said about it. The download
// queue reads exactly these fields, so this is the ground truth it is built on.
//
//   node tools/dl-rig/aria2-smoke.js            all scenarios (~6 minutes)
//   node tools/dl-rig/aria2-smoke.js --only fast,throttle
//   node tools/dl-rig/aria2-smoke.js --keep     leave the scratch folder for a look
//
// It starts its OWN aria2c (a fresh RPC port and secret, its own folder) and
// stops only that process, by PID. Nothing leaves the PC: aria2 has DHT, LPD
// and PEX off, every tracker in the torrent is excluded except our local one,
// and its sockets are bound to 127.0.0.1.
"use strict";
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { startSwarm, freePort } = require("./swarm");

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const ONLY = (() => { const i = argv.indexOf("--only"); return i < 0 ? null : new Set(String(argv[i + 1]).split(",")); })();
const ARIA2 = process.env.ARIA2_PATH || (() => {
  // src/config prints a warning when the worktree has no config.json; the path
  // it resolves (PATH or winget's package folder) is all we want from it.
  const warn = console.warn; console.warn = () => {};
  try { return require("../../src/config").ARIA2; } finally { console.warn = warn; }
})();
const SCRATCH = path.join(os.tmpdir(), "aurora-agents", "downloads-v2", `smoke-${Date.now().toString(36)}`);
const MB = 1000 * 1000;
const KiB = 1024;
const MiB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const stamp = () => `${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s`;
const say = (...a) => console.log(stamp(), ...a);
const fmtB = (n) => (n >= MiB ? `${(n / MiB).toFixed(1)}MiB` : n >= KiB ? `${(n / KiB).toFixed(0)}KiB` : `${n}B`);
const sec = (ms) => (ms == null ? "-" : (ms / 1000).toFixed(1));

// ---------------------------------------------------------------- aria2 + RPC
let aria = null; // { pid, port, secret, child, log }
const rpc = (method, params = []) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params: [`token:${aria.secret}`, ...params] });
  const req = http.request({ host: "127.0.0.1", port: aria.port, path: "/jsonrpc", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 10000 }, (res) => {
    let s = ""; res.setEncoding("utf8"); res.on("data", (d) => (s += d));
    res.on("end", () => { try { const j = JSON.parse(s); if (j.error) reject(Object.assign(new Error(`${method}: ${j.error.message}`), { code: j.error.code })); else resolve(j.result); } catch (e) { reject(e); } });
  });
  req.on("timeout", () => req.destroy(new Error(`${method}: rpc timeout`)));
  req.on("error", reject);
  req.end(body);
});

const startAria2 = async (announce) => {
  const port = await freePort();
  const listen = await freePort();
  const dhtPort = await freePort();
  const secret = crypto.randomBytes(16).toString("hex");
  const dir = path.join(SCRATCH, "aria2");
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(SCRATCH, "aria2.log");
  const args = [
    "--enable-rpc", "--rpc-listen-all=false", `--rpc-listen-port=${port}`, `--rpc-secret=${secret}`,
    `--dir=${dir}`,
    "--enable-dht=false", "--enable-dht6=false", "--bt-enable-lpd=false", "--enable-peer-exchange=false",
    `--listen-port=${listen}`, `--dht-listen-port=${dhtPort}`,
    "--bt-exclude-tracker=*", `--bt-tracker=${announce}`,
    "--seed-time=0", "--file-allocation=none",
    "--console-log-level=warn", "--summary-interval=0",
    `--stop-with-process=${process.pid}`,
    // loopback only, IPv4 only: the BT listen socket would otherwise take every interface
    "--interface=127.0.0.1", "--disable-ipv6=true",
    // a log to count hash failures in (the console only shows warnings)
    `--log=${log}`, "--log-level=info",
  ];
  const child = spawn(ARIA2, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const out = [];
  child.stdout.on("data", (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) out.push(l.trim()); });
  child.stderr.on("data", (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) out.push(l.trim()); });
  aria = { pid: child.pid, port, listen, secret, child, log, out, exited: false };
  child.on("exit", (code) => { aria.exited = true; aria.exitCode = code; });
  say(`aria2c pid ${child.pid}, rpc 127.0.0.1:${port}, bt listen ${listen}`);
  for (let i = 0; i < 100; i++) {
    if (aria.exited) throw new Error(`aria2c exited at start (code ${aria.exitCode}): ${out.join(" | ")}`);
    try { const v = await rpc("aria2.getVersion"); say(`aria2 ${v.version} up`); return; } catch { await sleep(100); }
  }
  throw new Error("aria2 RPC never answered");
};

const stopAria2 = async () => {
  if (!aria || aria.exited) return;
  try { await rpc("aria2.forceShutdown"); } catch {}
  for (let i = 0; i < 50 && !aria.exited; i++) await sleep(100);
  if (!aria.exited) { try { process.kill(aria.pid); } catch {} } // only OUR pid
  for (let i = 0; i < 30 && !aria.exited; i++) await sleep(100);
  say(`aria2c pid ${aria.pid} stopped`);
};

// ------------------------------------------------------------ one download
const KEYS = ["gid", "status", "totalLength", "completedLength", "downloadSpeed", "connections", "numSeeders", "errorCode", "errorMessage", "followedBy", "files"];

// Add a magnet and watch it every `every` ms until it finishes, fails, or
// `tick` returns "stop" / the time runs out. The [METADATA] download aria2
// makes for a magnet is followed to the real one (followedBy).
// `seeders`: handles whose uploaded() is sampled too — the seeder-side byte
// count is exact, while completedLength only moves when a whole piece passes
// its hash check and downloadSpeed is smoothed over several seconds.
const watch = async (content, { name, selectFile, timeoutMs = 90000, every = 200, tick, addTorrent = false, seeders = [] }) => {
  const dir = path.join(SCRATCH, "aria2", name);
  const opts = { dir };
  if (selectFile) opts["select-file"] = String(selectFile);
  const t0 = Date.now();
  let gid = addTorrent
    ? await rpc("aria2.addTorrent", [content.torrentFile.toString("base64"), [], opts])
    : await rpc("aria2.addUri", [[content.magnet], opts]);
  const metaGid = addTorrent ? null : gid;
  const r = { name, t0, tMeta: addTorrent ? 0 : null, tFirst: null, tEnd: null, samples: [], maxConn: 0, maxSeeders: 0, gids: [gid] };
  let st = null;
  let lastLen = -1;
  for (;;) {
    st = await rpc("aria2.tellStatus", [gid, KEYS]);
    const now = Date.now() - t0;
    if (gid === metaGid && st.status === "complete" && st.followedBy && st.followedBy.length) {
      r.tMeta = now;
      gid = st.followedBy[0];
      r.gids.push(gid);
      continue;
    }
    const s = { t: now, len: Number(st.completedLength), total: Number(st.totalLength), speed: Number(st.downloadSpeed), conn: Number(st.connections), seeders: Number(st.numSeeders || 0), status: st.status, meta: gid === metaGid, up: seeders.reduce((n, h) => n + h.uploaded(), 0) };
    r.samples.push(s);
    r.maxConn = Math.max(r.maxConn, s.conn);
    r.maxSeeders = Math.max(r.maxSeeders, s.seeders);
    if (!s.meta && r.tFirst == null && s.len > 0) r.tFirst = now;
    if (s.len !== lastLen) { r.tLastMove = now; lastLen = s.len; }
    const verdict = tick ? await tick({ st, s, gid, r, now }) : null;
    if (["complete", "error", "removed"].includes(st.status)) break;
    if (verdict === "stop" || now > timeoutMs) break;
    await sleep(every);
  }
  r.tEnd = Date.now() - t0;
  r.final = st;
  r.gid = gid;
  // leave nothing running in aria2
  for (const g of r.gids) {
    try { const x = await rpc("aria2.tellStatus", [g, ["status"]]); if (!["complete", "error", "removed"].includes(x.status)) await rpc("aria2.forceRemove", [g]); } catch {}
  }
  for (let i = 0; i < 30; i++) {
    const left = [];
    for (const g of r.gids) { try { const x = await rpc("aria2.tellStatus", [g, ["status"]]); if (!["complete", "error", "removed"].includes(x.status)) left.push(g); } catch {} }
    if (!left.length) break;
    await sleep(100);
  }
  for (const g of r.gids) { try { await rpc("aria2.removeDownloadResult", [g]); } catch {} }
  r.dir = dir;
  return r;
};

const sha1File = (f) => new Promise((res, rej) => {
  const h = crypto.createHash("sha1");
  fs.createReadStream(f).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
});
// Is the downloaded copy of a content file byte-identical to the source?
const sameAsSource = async (content, r, file) => {
  const src = path.join(content._seedPath, file.relOnDisk);
  const got = path.join(r.dir, file.relOnDisk);
  if (!fs.existsSync(got)) return false;
  return (await sha1File(src)) === (await sha1File(got));
};
// Speed between two moments, from completedLength (field "len") or from what the
// seeders sent (field "up").
const realSpeed = (r, fromT, toT, field = "len") => {
  const a = r.samples.filter((s) => !s.meta && s.t >= fromT && s.t <= toT);
  if (a.length < 2) return 0;
  return ((a[a.length - 1][field] - a[0][field]) * 1000) / Math.max(1, a[a.length - 1].t - a[0].t);
};
// First sample time >= from where pred(sample, previous) holds.
const firstAfter = (r, from, pred) => { let prev = null; for (const x of r.samples) { if (x.meta) continue; if (x.t >= from && prev && pred(x, prev)) return x.t; prev = x; } return null; };
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };

// ------------------------------------------------------------- scenarios
const rows = [];
const notes = [];
const row = (r, extra = {}) => {
  const f = r.final || {};
  const last = r.samples[r.samples.length - 1] || {};
  rows.push({
    scenario: r.name,
    meta: sec(r.tMeta), first: sec(r.tFirst), total: sec(r.tEnd),
    status: f.status, err: f.errorCode || "-",
    conn: r.maxConn, seeders: r.maxSeeders,
    got: `${fmtB(Number(f.completedLength || last.len || 0))}/${fmtB(Number(f.totalLength || last.total || 0))}`,
    avg: r.tFirst != null && Number(f.completedLength) > 0 ? `${fmtB(Math.round(Number(f.completedLength) * 1000 / Math.max(1, r.tEnd - r.tFirst)))}/s` : "-",
    ...extra,
    ok: extra.ok == null ? "-" : extra.ok ? "PASS" : "FAIL",
  });
};
const note = (name, text) => { notes.push(`[${name}] ${text}`); say(`  ${name}: ${text}`); };

const scenarios = {};
let swarm;

scenarios.fast = async () => {
  const c = await swarm.makeContent({ name: "Fast Film", files: [{ path: "Fast.Film.2020.mkv", size: 50 * MB }] });
  const s = await swarm.seed(c, { label: "fast" });
  const r = await watch(c, { name: "fast", timeoutMs: 60000 });
  const same = r.final.status === "complete" && (await sameAsSource(c, r, c.files[0]));
  await s.stop();
  row(r, { ok: r.tMeta != null && same });
  note("fast", `magnet → metadata from the webtorrent seeder via ut_metadata: ${r.tMeta != null ? "YES" : "NO"}; bytes identical to source: ${same}`);
};

scenarios.slow = async () => {
  const c = await swarm.makeContent({ name: "Slow Film", files: [{ path: "Slow.Film.2020.mkv", size: 8 * MB }] });
  const s = await swarm.seed(c, { label: "slow", rate: 300 * KiB });
  const r = await watch(c, { name: "slow", timeoutMs: 60000 });
  await s.stop();
  const speeds = r.samples.filter((x) => !x.meta && x.t > (r.tFirst || 0) + 3000 && x.status === "active").map((x) => x.speed);
  const med = median(speeds);
  const steady = speeds.length ? speeds.filter((v) => Math.abs(v - med) < med * 0.35).length / speeds.length : 0;
  row(r, { ok: r.final.status === "complete" && med > 200 * KiB && med < 400 * KiB });
  note("slow", `aria2 downloadSpeed median ${fmtB(med)}/s, min ${fmtB(Math.min(...speeds))}/s, max ${fmtB(Math.max(...speeds))}/s; ${(steady * 100).toFixed(0)}% of samples within 35% of the median`);
};

scenarios.noseed = async () => {
  const c = await swarm.makeContent({ name: "Nobody Film", files: [{ path: "Nobody.Film.2020.mkv", size: 1 * MB }] });
  const r = await watch(c, { name: "noseed", timeoutMs: 45000, every: 500 });
  row(r, { ok: r.tMeta == null && r.final.status === "active" });
  const f = r.final;
  note("noseed", `after 45 s: status ${f.status}, totalLength ${f.totalLength}, completedLength ${f.completedLength}, connections ${f.connections}, numSeeders ${f.numSeeders}, followedBy ${JSON.stringify(f.followedBy || [])} — aria2 never gives up on its own`);
};

scenarios.stall = async () => {
  const c = await swarm.makeContent({ name: "Zombie Film", files: [{ path: "Zombie.Film.2020.mkv", size: 50 * MB }] });
  const s = await swarm.seed(c, { label: "zombie", stallAtFraction: 0.1, rate: 4 * MiB });
  let stalledAt = null;
  const peerShots = [];
  const r = await watch(c, {
    name: "stall", timeoutMs: 100000, every: 250, seeders: [s],
    tick: async ({ s: x, gid, now }) => {
      if (stalledAt == null && s.stalled()) stalledAt = now;
      if (stalledAt != null) {
        for (const at of [5000, 30000, 60000, 85000]) {
          if (now - stalledAt >= at && !peerShots.find((p) => p.at === at)) {
            const peers = await rpc("aria2.getPeers", [gid]).catch((e) => e.message);
            peerShots.push({ at, conn: x.conn, seeders: x.seeders, speed: x.speed, len: x.len, peers: Array.isArray(peers) ? peers.map((p) => ({ ip: p.ip, port: p.port, seeder: p.seeder, amChoking: p.amChoking, peerChoking: p.peerChoking, downloadSpeed: p.downloadSpeed })) : peers });
          }
        }
        if (now - stalledAt > 90000) return "stop";
      }
      return null;
    },
  });
  await s.stop();
  const after = r.samples.filter((x) => stalledAt != null && x.t > stalledAt + 3000);
  const frozen = after.length > 0 && after.every((x) => x.len === after[0].len);
  row(r, { ok: frozen && r.final.status === "active" });
  const zeroAt = firstAfter(r, stalledAt, (x) => x.speed === 0);
  note("stall", `seeder went silent at ${sec(stalledAt)} s after serving ${fmtB(s.served())} (${(100 * s.served() / c.totalLength).toFixed(1)}%); completedLength frozen at ${fmtB(after.length ? after[0].len : 0)} for the next ${sec(after.length ? after[after.length - 1].t - after[0].t : 0)} s: ${frozen}; aria2 downloadSpeed reached 0 only ${sec(zeroAt == null ? null : zeroAt - stalledAt)} s after the stall; status stayed ${r.final.status}, no errorCode`);
  const connTimeline = []; for (const x of r.samples) if (!x.meta && (!connTimeline.length || connTimeline[connTimeline.length - 1][1] !== x.conn)) connTimeline.push([sec(x.t), x.conn]);
  note("stall", `connections over time [s, n]: ${JSON.stringify(connTimeline)}`);
  for (const p of peerShots) note("stall", `+${p.at / 1000}s after stall: connections ${p.conn}, numSeeders ${p.seeders}, downloadSpeed ${p.speed}, getPeers ${JSON.stringify(p.peers)}`);
};

scenarios.leave = async () => {
  const c = await swarm.makeContent({ name: "Leaver Film", files: [{ path: "Leaver.Film.2020.mkv", size: 50 * MB }] });
  const s = await swarm.seed(c, { label: "leaver", rate: 2 * MiB, leaveAfterBytes: 10 * MB });
  // a different person with the same file, who turns up later
  // dialOut false: the returner waits to be found, so this measures aria2's own
  // re-announce (the tracker says every 10 s), not the seeder dialling in
  const back = await swarm.seed(c, { label: "returner", startDelayMs: 25000, dialOut: false });
  let leftAt = null; let backAt = null; let lenAtLeave = null;
  const tAdd = Date.now();
  back.ready.then(() => { backAt = Date.now() - tAdd; });
  const shots = [];
  const r = await watch(c, {
    name: "leave+back", timeoutMs: 90000, seeders: [s, back],
    tick: async ({ s: x, gid, now }) => {
      if (leftAt == null && s.left()) { leftAt = now; lenAtLeave = x.len; }
      if (leftAt != null && !shots.length && now - leftAt > 5000) {
        const peers = await rpc("aria2.getPeers", [gid]).catch(() => []);
        shots.push({ conn: x.conn, seeders: x.seeders, speed: x.speed, status: x.status, peers: peers.length });
      }
      return null;
    },
  });
  await s.stop(); await back.stop();
  const stuck = r.samples.filter((x) => leftAt != null && x.t > leftAt + 2000 && (backAt == null || x.t < backAt));
  const zeroAt = firstAfter(r, leftAt || 0, (x) => x.speed === 0);
  const flowAgain = backAt == null ? null : firstAfter(r, backAt, (x, p) => x.up > p.up);
  row(r, { ok: r.final.status === "complete" && stuck.length > 0 && stuck.every((x) => x.len === stuck[0].len) });
  note("leave+back", `leaver gone at ${sec(leftAt)} s with ${fmtB(lenAtLeave || 0)} done (frozen at ${fmtB(stuck.length ? stuck[0].len : 0)} until the return); 5 s later: ${JSON.stringify(shots[0] || {})}; aria2 downloadSpeed reached 0 at ${sec(zeroAt)} s; returner seeding at ${sec(backAt)} s, bytes from it at ${sec(flowAgain)} s (${sec(flowAgain == null ? null : flowAgain - backAt)} s after it appeared), done at ${sec(r.tEnd)} s`);
};

const hashFailLines = (since) => {
  try {
    const txt = fs.readFileSync(aria.log, "utf8").slice(since);
    return txt.split(/\r?\n/).filter((l) => /wrong piece|hash check|checksum|bad piece|validation fail/i.test(l));
  } catch { return []; }
};
const logSize = () => { try { return fs.statSync(aria.log).size; } catch { return 0; } };

scenarios.corrupt = async () => {
  const BAD = [3, 30, 60];
  // only the liar
  {
    const c = await swarm.makeContent({ name: "Liar Film", files: [{ path: "Liar.Film.2020.mkv", size: 20 * MB }] });
    const bad = await swarm.seed(c, { label: "liar", corruptPieces: BAD });
    const since = logSize();
    const r = await watch(c, { name: "corrupt only", timeoutMs: 40000, every: 250 });
    await bad.stop();
    const fails = hashFailLines(since);
    const missing = Number(r.final.totalLength) - Number(r.final.completedLength);
    // aria2 closes the connection on every wrong piece (the seeder's next write
    // gets ECONNABORTED) but does not ban the address: the liar dials back in,
    // aria2 asks for the same bad piece first again, and so on — a crawl with
    // no error, never complete.
    const reconnects = new Set(fails.map((l) => (l.match(/CUID#(\d+)/) || [])[1])).size;
    row(r, { ok: r.final.status === "active" && missing >= BAD.length * c.pieceLength && fails.length > 0 });
    note("corrupt only", `status ${r.final.status} errorCode ${r.final.errorCode || "-"}, missing ${fmtB(missing)} (= ${missing / c.pieceLength} pieces), liar uploaded ${fmtB(bad.uploaded())} for a ${fmtB(c.totalLength)} file; ${fails.length} "wrong piece" log lines on ${reconnects} different connections (each one closed right after), e.g. ${JSON.stringify((fails[0] || "").replace(/^\S+ \S+ /, "").slice(0, 160))}`);
  }
  // the liar first, a good copy turns up after 6 s
  {
    const c = await swarm.makeContent({ name: "Liar Film 2", files: [{ path: "Liar2.Film.2020.mkv", size: 20 * MB }] });
    const bad = await swarm.seed(c, { label: "liar2", corruptPieces: BAD });
    const good = await swarm.seed(c, { label: "honest", startDelayMs: 6000 });
    const since = logSize();
    const r = await watch(c, { name: "corrupt+good", timeoutMs: 60000, every: 250 });
    await bad.stop(); await good.stop();
    const same = r.final.status === "complete" && (await sameAsSource(c, r, c.files[0]));
    row(r, { ok: same });
    note("corrupt+good", `status ${r.final.status}, bytes identical to source: ${same}; liar uploaded ${fmtB(bad.uploaded())}, honest uploaded ${fmtB(good.uploaded())}; ${hashFailLines(since).length} hash-failure log lines`);
  }
};

scenarios.pack = async () => {
  const c = await swarm.makeContent({
    name: "Show.S01.1080p",
    files: [
      { path: "Show.S01E01.1080p.mkv", size: 30 * MB },
      { path: "Show.S01E02.1080p.mkv", size: 30 * MB },
      { path: "Show.S01E03.1080p.mkv", size: 30 * MB },
      { path: "Sample/show.s01e01.sample.mkv", size: 5 * MB },
      { path: "Show.S01.nfo", size: 2048 },
    ],
  });
  const order = c.files.map((f) => `#${f.index} ${f.path}`).join(", ");
  const s = await swarm.seed(c, { label: "pack", rate: 8 * MiB });
  // The queue picks an episode by its index in the torrent; create-torrent
  // sorts paths, so E02 is not file #2 here (see the order in the notes).
  const want = c.files.find((f) => /E02/.test(f.path));
  // files[].completedLength of the selected file while it downloads (the queue's progress number)
  const fileLen = [];
  const r = await watch(c, {
    name: `pack E02 (#${want.index})`, selectFile: want.index, timeoutMs: 60000,
    tick: ({ st, s: x }) => { if (x.meta) return null; const f = (st.files || []).find((y) => Number(y.index) === want.index); if (f) fileLen.push({ status: st.status, file: Number(f.completedLength), len: x.len }); return null; },
  });
  // and a file smaller than one piece (the .nfo): what does files[] say once complete?
  const nfo = c.files.find((f) => /[.]nfo$/.test(f.path));
  const rn = await watch(c, { name: `pack nfo (#${nfo.index})`, selectFile: nfo.index, timeoutMs: 30000 });
  await s.stop();
  row(rn, { ok: rn.final.status === "complete" && (await sameAsSource(c, rn, nfo)) });
  note("pack nfo", `selected #${nfo.index} ${nfo.path} (${nfo.length} B): totalLength ${rn.final.totalLength}, completedLength ${rn.final.completedLength}, files[] ${(rn.final.files || []).filter((f) => f.selected === "true").map((f) => `#${f.index} ${f.completedLength}/${f.length}`).join(", ")}`);
  const same = r.final.status === "complete" && (await sameAsSource(c, r, want));
  const perFile = (r.final.files || []).map((f) => `#${f.index} sel=${f.selected} ${fmtB(Number(f.completedLength))}/${fmtB(Number(f.length))}`).join("; ");
  const onDisk = c.files.map((f) => { const p = path.join(r.dir, f.relOnDisk); return `${f.path}: ${fs.existsSync(p) ? fmtB(fs.statSync(p).size) : "absent"}`; }).join("; ");
  row(r, { ok: same });
  note("pack E02", `torrent order: ${order}`);
  note("pack E02", `selected #${want.index} = ${want.path}; identical to source: ${same}; totalLength ${r.final.totalLength} vs file ${want.length} (pieces covering the selection)`);
  note("pack E02", `tellStatus files: ${perFile}`);
  note("pack E02", `on disk (apparent sizes): ${onDisk}`);
  const active = fileLen.filter((x) => x.status === "active");
  note("pack E02", `files[#${want.index}].completedLength while active: ${active.length} samples, max ${fmtB(Math.max(0, ...active.map((x) => x.file)))} (completedLength max ${fmtB(Math.max(0, ...active.map((x) => x.len)))}); at status complete: ${fmtB((fileLen.find((x) => x.status === "complete") || {}).file || 0)}`);
  // the neighbour before E02 shows its full size on disk: is it real data or a hole up to the shared piece?
  const prev = c.files.find((f) => f.index === want.index - 1);
  const p = path.join(r.dir, prev.relOnDisk);
  if (fs.existsSync(p)) {
    const head = Buffer.alloc(1 << 20); const fd = fs.openSync(p, "r"); fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd);
    note("pack E02", `neighbour #${prev.index} ${prev.path}: first MiB all zeros = ${head.every((b) => b === 0)} (only the piece it shares with the selection is real data)`);
  }
};

scenarios.throttle = async () => {
  const c = await swarm.makeContent({ name: "Big Film", files: [{ path: "Big.Film.2020.mkv", size: 120 * MB }] });
  const s = await swarm.seed(c, { label: "big", rate: 6 * MiB });
  const marks = {};
  const r = await watch(c, {
    name: "throttle 32K", timeoutMs: 60000, every: 200, seeders: [s],
    tick: async ({ s: x, gid, now, r: rr }) => {
      if (rr.tFirst == null) return null;
      const since = now - rr.tFirst;
      if (!marks.down && since > 4000) {
        marks.down = now; marks.connAtDown = x.conn;
        await rpc("aria2.changeOption", [gid, { "max-download-limit": "32K" }]);
      }
      if (marks.down && !marks.up && now - marks.down > 15000) {
        marks.connBeforeUp = x.conn;
        marks.up = now;
        await rpc("aria2.changeOption", [gid, { "max-download-limit": "0" }]);
      }
      if (marks.down && !marks.up && marks.slowAt == null && x.speed < 64 * KiB) marks.slowAt = now;
      if (marks.up && marks.fastAt == null && x.speed > 2 * MiB) marks.fastAt = now;
      if (marks.up && now - marks.up > 6000) return "stop";
      return null;
    },
  });
  await s.stop();
  const before = realSpeed(r, marks.down - 2500, marks.down, "up");
  const during = realSpeed(r, marks.down + 3000, marks.up, "up");
  const after = realSpeed(r, marks.up + 2000, marks.up + 6000, "up");
  // how fast the seeder side felt it: the first 1 s window after the change under / over the line
  const win = (from, pred) => { for (const x of r.samples) { if (x.t < from) continue; const v = realSpeed(r, x.t, x.t + 1000, "up"); if (pred(v)) return x.t - from; } return null; };
  const bitesIn = win(marks.down, (v) => v < 64 * KiB);
  const backIn = win(marks.up, (v) => v > 2 * MiB);
  const minConnThrottled = Math.min(...r.samples.filter((x) => x.t > marks.down && x.t < marks.up).map((x) => x.conn));
  row(r, { ok: during < 48 * KiB && during > 8 * KiB && after > 2 * MiB && minConnThrottled > 0 });
  note("throttle 32K", `seeder-side speed before ${fmtB(before)}/s → throttled ${fmtB(during)}/s → unthrottled ${fmtB(after)}/s; on the wire the limit bites within ${sec(bitesIn)} s and lifts within ${sec(backIn)} s; aria2's own downloadSpeed shows < 64KiB/s only ${sec(marks.slowAt - marks.down)} s after the change and > 2MiB/s ${sec(marks.fastAt - marks.up)} s after back to 0; connections at throttle ${marks.connAtDown}, lowest while throttled ${minConnThrottled}, before unthrottle ${marks.connBeforeUp}`);
};

const pauseScenario = (method) => async () => {
  const c = await swarm.makeContent({ name: `Pause Film ${method}`, files: [{ path: `Pause.${method}.2020.mkv`, size: 120 * MB }] });
  const s = await swarm.seed(c, { label: method, rate: 4 * MiB });
  const m = {};
  const r = await watch(c, {
    name: `${method}/unpause`, timeoutMs: 60000, every: 100, seeders: [s],
    tick: async ({ s: x, gid, now, r: rr }) => {
      if (rr.tFirst == null) return null;
      if (!m.pause && now - rr.tFirst > 3000) { m.pause = now; await rpc(`aria2.${method}`, [gid]); }
      if (m.pause && !m.paused && x.status === "paused") {
        m.paused = now; m.lenPaused = x.len;
        m.peersPaused = await rpc("aria2.getPeers", [gid]).then((p) => p.length, (e) => `err ${e.message}`);
        m.connPaused = x.conn; m.seedWiresPaused = s.wires();
      }
      if (m.paused && !m.unpause && now - m.paused > 5000) {
        m.lenBeforeUnpause = x.len; m.upBeforeUnpause = x.up; m.seedWiresBefore = s.wires();
        m.unpause = now; await rpc("aria2.unpause", [gid]);
      }
      if (m.paused && m.upPaused == null) m.upPaused = x.up;
      if (m.unpause && m.flow == null && x.up > m.upBeforeUnpause) { m.flow = now; m.connFlow = x.conn; }
      if (m.unpause && m.lenFlow == null && x.len > m.lenBeforeUnpause) m.lenFlow = now;
      if (m.flow && m.lenFlow && now - m.flow > 1500) return "stop";
      return null;
    },
  });
  await s.stop();
  row(r, { ok: m.flow != null });
  note(`${method}/unpause`, `${method} → status "paused" in ${sec(m.paused - m.pause)} s; while paused: connections ${m.connPaused}, getPeers ${m.peersPaused}, seeder wires ${m.seedWiresPaused}→${m.seedWiresBefore}, bytes sent while paused ${fmtB((m.upBeforeUnpause || 0) - (m.upPaused || 0))}; unpause → seeder sends again in ${sec(m.flow - m.unpause)} s, completedLength moves in ${sec(m.lenFlow - m.unpause)} s (connections then ${m.connFlow}); completedLength ${fmtB(m.lenPaused || 0)} at pause, ${fmtB(m.lenBeforeUnpause || 0)} before unpause`);
};
scenarios.pause = pauseScenario("pause");
scenarios.forcepause = pauseScenario("forcePause");

// ------------------------------------------------------------------- main
const printTable = () => {
  const cols = ["scenario", "meta", "first", "total", "status", "err", "conn", "seeders", "got", "avg", "ok"];
  const head = { scenario: "scenario", meta: "meta s", first: "1st byte s", total: "total s", status: "status", err: "errCode", conn: "max conn", seeders: "max seeders", got: "completed/total", avg: "avg speed", ok: "ok" };
  const w = Object.fromEntries(cols.map((k) => [k, Math.max(String(head[k]).length, ...rows.map((x) => String(x[k] ?? "").length))]));
  const line = (o) => cols.map((k) => String(o[k] ?? "").padEnd(w[k])).join(" | ");
  console.log(`\n${line(head)}\n${cols.map((k) => "-".repeat(w[k])).join("-|-")}`);
  for (const x of rows) console.log(line(x));
  console.log("");
  for (const n of notes) console.log(n);
};

const main = async () => {
  if (!ARIA2) throw new Error("aria2c not found (set ARIA2_PATH)");
  fs.mkdirSync(SCRATCH, { recursive: true });
  say(`scratch ${SCRATCH}`);
  swarm = await startSwarm({ dir: path.join(SCRATCH, "content"), announceIntervalMs: 10000 });
  say(`tracker ${swarm.announce}`);
  await startAria2(swarm.announce);
  const order = ["fast", "slow", "noseed", "stall", "leave", "corrupt", "pack", "throttle", "pause", "forcepause"];
  let failed = false;
  for (const name of order) {
    if (ONLY && !ONLY.has(name)) continue;
    say(`== ${name}`);
    try { await scenarios[name](); } catch (e) { failed = true; rows.push({ scenario: name, status: "CRASH", ok: "FAIL" }); note(name, `crashed: ${e.stack || e}`); }
  }
  const warns = aria.out.filter((l) => !/^\s*$/.test(l));
  if (warns.length) { console.log(`\naria2 console (${warns.length} lines, first 8):`); for (const l of warns.slice(0, 8)) console.log("  " + l.slice(0, 200)); }
  printTable();
  return failed || rows.some((x) => x.ok === "FAIL");
};

let exitCode = 0;
main()
  .then((bad) => { exitCode = bad ? 1 : 0; }, (e) => { console.error(e); exitCode = 2; })
  .finally(async () => {
    await stopAria2().catch(() => {});
    if (swarm) await swarm.stop().catch(() => {});
    if (!KEEP) { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); say(`scratch removed`); } catch (e) { console.warn(`could not remove ${SCRATCH}: ${e.message}`); } }
    else say(`scratch kept: ${SCRATCH}`);
    console.log(exitCode === 0 ? "\nSMOKE PASS" : "\nSMOKE FAIL");
    process.exit(exitCode);
  });
