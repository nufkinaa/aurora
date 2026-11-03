// A BitTorrent swarm that lives entirely on this PC, for testing the download
// queue against the real aria2 without touching the internet:
//
//   const { startSwarm } = require("./tools/dl-rig/swarm");
//   const swarm = await startSwarm({ dir });            // a tracker on 127.0.0.1
//   const c = await swarm.makeContent({ name: "Film", files: [{ path: "Film.mkv", size: 50e6 }] });
//   const s = await swarm.seed(c, { rate: 300 * 1024 }); // one seeder, its own client
//   ... aria2.addUri([c.magnet]) ...
//   await swarm.stop();
//
//   the tracker   bittorrent-tracker, HTTP only, bound to 127.0.0.1 — it hands out
//                 the address each peer announced from, which is always 127.0.0.1
//   the content   random bytes we make ourselves (deterministic per seed), never
//                 anything real
//   a seeder      one WebTorrent client per seeder, so each can be slow, stall,
//                 leave or lie on its own — a swarm of different people, not one
//                 client with one global upload limit
//
// Nothing leaves the PC: no DHT, no LSD, no PEX, no UPnP/NAT-PMP, no web seeds,
// no default public trackers (create-torrent adds a list of them unless it is
// given its own), and every listening socket is bound to 127.0.0.1.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A free TCP port on 127.0.0.1. There is a tiny race between closing the probe
// and the real owner binding it; for a test rig on one PC that is fine.
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

// WebTorrent's connection pool calls `net.createServer().listen(port)`, which
// binds every interface (the LAN too). We want loopback only, so while a client
// is being built (its pool is created synchronously in the constructor) every
// new server's listen() is pinned to 127.0.0.1.
const withLoopbackListen = (build) => {
  const real = net.createServer;
  net.createServer = function (...args) {
    const srv = real.apply(this, args);
    const listen = srv.listen;
    srv.listen = function (port, ...rest) {
      if (typeof port === "number" || port === undefined) {
        const cb = rest.find((x) => typeof x === "function");
        return listen.call(this, port || 0, "127.0.0.1", cb);
      }
      return listen.call(this, port, ...rest);
    };
    return srv;
  };
  try { return build(); } finally { net.createServer = real; }
};

// Deterministic pseudo-random bytes: AES-128-CTR over zeros, keyed by the seed
// and the file's path. Same seed → same bytes → same infoHash, and it runs at
// well over 1 GB/s, so a 200 MB file costs a fraction of a second.
// `head` (a Buffer) is written first and the random bytes fill the rest up to
// `size`: the server runs ffprobe on a finished download and calls pure random
// bytes a fake, so a rig "film" can start with a real (tiny) MKV header.
const writeRandomFile = (file, size, seed, rel, head = null) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = crypto.createHash("sha256").update(`${seed}\0${rel}`).digest().subarray(0, 16);
  const cipher = crypto.createCipheriv("aes-128-ctr", key, Buffer.alloc(16));
  const fd = fs.openSync(file, "w");
  try {
    if (head && head.length) fs.writeSync(fd, head);
    const CHUNK = 4 * 1024 * 1024;
    const zeros = Buffer.alloc(CHUNK);
    for (let left = size - (head ? head.length : 0); left > 0; left -= CHUNK) {
      const n = Math.min(CHUNK, left);
      fs.writeSync(fd, cipher.update(n === CHUNK ? zeros : zeros.subarray(0, n)));
    }
  } finally { fs.closeSync(fd); }
};

// Flip every byte of the given pieces in a copy of the content. The piece is a
// byte range of the whole torrent, so it can straddle two files of a pack.
const corruptCopy = (content, pieces, dest) => {
  for (const f of content.files) {
    const to = path.join(dest, f.relOnDisk);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(content._seedPath, f.relOnDisk), to);
  }
  for (const i of pieces) {
    const start = i * content.pieceLength;
    const end = Math.min(start + content.pieceLength, content.totalLength);
    if (start >= content.totalLength) throw new Error(`corruptPieces: piece ${i} is past the end (${content.pieceCount} pieces)`);
    for (const f of content.files) {
      const a = Math.max(start, f.offset);
      const b = Math.min(end, f.offset + f.length);
      if (a >= b) continue;
      const fd = fs.openSync(path.join(dest, f.relOnDisk), "r+");
      try {
        const buf = Buffer.alloc(b - a);
        fs.readSync(fd, buf, 0, buf.length, a - f.offset);
        for (let k = 0; k < buf.length; k++) buf[k] ^= 0xff;
        fs.writeSync(fd, buf, 0, buf.length, a - f.offset);
      } finally { fs.closeSync(fd); }
    }
  }
};

/**
 * Start a tracker on 127.0.0.1 and return the swarm.
 * @param {object} o
 * @param {string} o.dir                 where content (and corrupt copies) are written
 * @param {number} [o.announceIntervalMs=10000]  what the tracker tells peers; short, so
 *                                       a seeder that comes back is found within seconds
 * @param {boolean} [o.log=false]        print seeder events
 */
const startSwarm = async ({ dir, announceIntervalMs = 10000, log = false } = {}) => {
  if (!dir) throw new Error("startSwarm: dir is required");
  fs.mkdirSync(dir, { recursive: true });
  const { default: Server } = await import("bittorrent-tracker/server");
  const { default: WebTorrent } = await import("webtorrent");
  const { default: createTorrent } = await import("create-torrent");
  const { default: parseTorrent, toMagnetURI } = await import("parse-torrent");

  const tracker = new Server({ udp: false, ws: false, http: true, stats: false, interval: announceIntervalMs });
  tracker.on("error", (e) => console.warn(`[swarm] tracker error: ${e.message}`));
  tracker.on("warning", () => {}); // unknown-infohash scrapes etc. are not interesting
  await new Promise((r) => tracker.listen(0, "127.0.0.1", r));
  const announce = `http://127.0.0.1:${tracker.http.address().port}/announce`;
  const seeders = new Set();
  let badCopies = 0;
  const say = (...a) => { if (log) console.log("[swarm]", ...a); };

  /**
   * Make deterministic random content and its .torrent.
   * @param {object} o
   * @param {string} o.name                torrent name (folder name for a pack)
   * @param {{path:string,size:number,head?:Buffer|string}[]} o.files  one entry without a folder =
   *                                       a single-file torrent; `head` (Buffer or a file path) is
   *                                       written at the start of the file, random bytes fill the
   *                                       rest; `size` is the total (raised to head's length if shorter)
   * @param {number} [o.pieceLength=262144]
   * @param {string|number} [o.seed=o.name] PRNG seed for the bytes
   */
  const makeContent = async ({ name, files, pieceLength = 256 * 1024, seed } = {}) => {
    if (!name || !Array.isArray(files) || !files.length) throw new Error("makeContent: name and files are required");
    const root = path.join(dir, name);
    fs.rmSync(root, { recursive: true, force: true });
    for (const f of files) {
      const head = f.head == null ? null : Buffer.isBuffer(f.head) ? f.head : fs.readFileSync(f.head);
      const size = Math.max(Number(f.size) || 0, head ? head.length : 0);
      writeRandomFile(path.join(root, f.path), size, seed == null ? name : seed, f.path, head);
    }
    // One plain file → a single-file torrent named after the file (what most
    // films look like); anything else → a folder torrent named `name`.
    const single = files.length === 1 && !/[\\/]/.test(files[0].path);
    const input = single ? path.join(root, files[0].path) : root;
    const seedPath = single ? root : dir;
    const torrentFile = Buffer.from(await new Promise((res, rej) => createTorrent(input, {
      name: single ? files[0].path : name,
      announceList: [[announce]],
      pieceLength,
      createdBy: "aurora dl-rig",
      creationDate: 1700000000000, // fixed, so the same seed gives the same infoHash
      urlList: [],
    }, (err, t) => (err ? rej(err) : res(t)))));
    const parsed = await parseTorrent(torrentFile);
    // parse-torrent lists files in the torrent's order, which is the order aria2
    // numbers them (1-based) for select-file.
    const out = parsed.files.map((f, i) => ({
      path: f.path.replace(/\\/g, "/").split("/").slice(single ? 0 : 1).join("/"),
      length: f.length,
      offset: f.offset,
      index: i + 1,
      relOnDisk: f.path, // relative to the seeding path (the torrent name is its first part)
    }));
    return {
      name,
      infoHash: parsed.infoHash,
      torrentFile,
      magnet: toMagnetURI({ infoHash: parsed.infoHash, name: parsed.name, announce: [announce] }),
      files: out,
      pieceLength: parsed.pieceLength,
      pieceCount: parsed.pieces.length,
      totalLength: parsed.length,
      root,
      _seedPath: seedPath,
    };
  };

  /**
   * Start ONE seeder (its own WebTorrent client) for content.
   * @param {object} content              from makeContent
   * @param {object} [o]
   * @param {number} [o.rate]              upload limit, bytes/s (default unlimited)
   * @param {number} [o.stallAtFraction]   after uploading this fraction of totalLength it
   *                                       serves nothing more but stays connected (zombie)
   * @param {number} [o.leaveAfterBytes]   destroy itself after uploading this many bytes
   * @param {number} [o.leaveAfterMs]      destroy itself this long after it started seeding
   * @param {number[]} [o.corruptPieces]   serve flipped bytes for these piece indexes (0-based)
   * @param {number} [o.startDelayMs]      appear this much later (seed() returns at once;
   *                                       await handle.ready for the moment it is seeding)
   * @param {boolean} [o.dialOut=true]   false: only accept connections, never dial the
   *                                       downloaders the tracker lists (so a test measures
   *                                       the downloader finding us by re-announcing)
   * @param {string} [o.label]             a name for logs
   * @returns {Promise<{peerPort:number, ready:Promise<void>, setRate(bps:number|null):void,
   *   stall():void, resume():void, stalled():boolean, uploaded():number, served():number, wires():number,
   *   left():boolean, stop():Promise<void>}>}
   */
  const seed = async (content, o = {}) => {
    const label = o.label || `seeder${seeders.size + 1}`;
    const peerPort = await freePort();
    let seedPath = content._seedPath;
    if (o.corruptPieces && o.corruptPieces.length) {
      seedPath = path.join(dir, `.bad-${++badCopies}`);
      fs.rmSync(seedPath, { recursive: true, force: true });
      corruptCopy(content, o.corruptPieces, seedPath);
    }
    let client = null;
    let torrent = null;
    let isStalled = false;
    let served = 0; // block bytes read for peers (what has gone or is going out)
    let gone = false;
    const held = []; // block requests that arrived while stalled, never answered
    let leaveTimer = null;
    let startTimer = null;

    const stop = async () => {
      if (gone) return;
      gone = true;
      clearTimeout(leaveTimer);
      clearTimeout(startTimer);
      held.length = 0;
      seeders.delete(handle);
      if (client) await new Promise((r) => client.destroy(() => r()));
      say(`${label} stopped (uploaded ${torrent ? torrent.uploaded : 0} B)`);
    };

    const start = () => new Promise((resolve, reject) => {
      if (gone) return resolve();
      client = withLoopbackListen(() => new WebTorrent({
        dht: false, lsd: false, utp: false, utPex: false, natUpnp: false, natPmp: false,
        webSeeds: false, tracker: {}, torrentPort: peerPort,
        // false: never dial the downloaders the tracker lists, wait to be dialled
        seedOutgoingConnections: o.dialOut !== false,
        uploadLimit: typeof o.rate === "number" && o.rate >= 0 ? Math.round(o.rate) : -1,
      }));
      client.on("error", (e) => console.warn(`[swarm] ${label} client error: ${e.message}`));
      client.add(content.torrentFile, {
        path: seedPath,
        // We wrote these bytes ourselves (and the corrupt copy is wrong on
        // purpose): skip the hash check, which would also refuse to serve
        // the bad pieces.
        skipVerify: true,
        announce: [announce],
      }, (t) => {
        torrent = t;
        // Zombie: a request that arrives while stalled is simply never
        // answered. The connection, keep-alives, unchoke and bitfield stay —
        // the peer looks healthy and sends nothing, which is what a real dead
        // seeder behind a live socket looks like.
        //
        // The cut is counted here, at the moment a block is READ for a peer,
        // not on the "upload" event: the downloader keeps several MB of
        // requests in flight, and counting on "upload" let ~3 MB more through
        // after the line (a 10% stall froze at 16%).
        const stallAt = o.stallAtFraction != null ? o.stallAtFraction * content.totalLength : Infinity;
        const realGet = t.store.get.bind(t.store);
        t.store.get = (index, opts, cb) => {
          const len = (opts && opts.length) || 0;
          if (!isStalled && served + len > stallAt) {
            isStalled = true;
            say(`${label} stalls after serving ${served} B`);
          }
          if (isStalled) { if (typeof cb === "function") held.push(cb); return; }
          served += len;
          return realGet(index, opts, cb);
        };
        t.on("upload", () => {
          if (o.leaveAfterBytes != null && t.uploaded >= o.leaveAfterBytes) {
            say(`${label} leaves at ${t.uploaded} B`);
            stop();
          }
        });
        if (o.leaveAfterMs != null) leaveTimer = setTimeout(() => { say(`${label} leaves after ${o.leaveAfterMs} ms`); stop(); }, o.leaveAfterMs);
        // Ready once the tracker knows us, so a downloader that announces after
        // this gets our address in its first peer list.
        let done = false;
        const fin = () => { if (!done) { done = true; say(`${label} seeding on 127.0.0.1:${client.torrentPort}`); resolve(); } };
        t.once("trackerAnnounce", fin);
        setTimeout(fin, 3000);
      });
      client.once("error", reject);
    });

    const handle = {
      label,
      peerPort,
      ready: null,
      setRate: (bps) => { if (client) client.throttleUpload(bps == null || bps < 0 || !Number.isFinite(bps) ? -1 : Math.round(bps)); },
      stall: () => { isStalled = true; },
      resume: () => { isStalled = false; held.length = 0; }, // dropped requests: the downloader re-asks
      stalled: () => isStalled,
      uploaded: () => (torrent ? torrent.uploaded : 0),
      served: () => served,
      wires: () => (torrent ? torrent.wires.length : 0),
      left: () => gone,
      stop,
    };
    seeders.add(handle);
    if (o.startDelayMs > 0) {
      handle.ready = new Promise((res, rej) => { startTimer = setTimeout(() => start().then(res, rej), o.startDelayMs); });
      handle.ready.catch(() => {});
    } else {
      handle.ready = start();
      await handle.ready;
    }
    return handle;
  };

  const stop = async () => {
    await Promise.all([...seeders].map((s) => s.stop()));
    await new Promise((r) => tracker.close(() => r()));
  };

  // Who the tracker knows for an infoHash (for checks: are the addresses loopback?).
  const peersOf = (infoHash) => {
    const sw = tracker.torrents[infoHash];
    if (!sw) return [];
    return sw.peers.keys.map((k) => { const p = sw.peers.peek(k); return p && { ip: p.ip, port: p.port, complete: p.complete, peerId: p.peerId }; }).filter(Boolean);
  };

  return { announce, makeContent, seed, stop, peersOf, freePort, sleep };
};

module.exports = { startSwarm, freePort };
