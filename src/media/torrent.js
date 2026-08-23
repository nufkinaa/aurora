// Torrent module: resolves a title to an IMDb id (keyless, via Cinemeta),
// asks Torrentio for stream sources, and streams the chosen file over HTTP
// with range support via WebTorrent. Everything is cached so repeat opens
// are instant.
//
//   Cinemeta   https://v3-cinemeta.strem.io/catalog/{type}/top/search={q}.json
//   Torrentio  https://torrentio.strem.fun/lite/stream/{type}/{id}.json
//
// For personal use on a private network.
const fs = require("fs");
const path = require("path");
const { JsonStore } = require("../lib/jsonstore");
const perf = require("../lib/perf");
const config = require("../config");
const scanner = require("./scanner");

// WebTorrent is ESM - dynamic import avoids top-level await issues.
let WebTorrent = null;
const loadWebTorrent = async () => {
  if (!WebTorrent) {
    const mod = await import("webtorrent");
    WebTorrent = mod.default || mod;
  }
  return WebTorrent;
};

const CACHE_DIR = path.join(config.CACHE_DIR, "torrents");
const STORE = new JsonStore(
  path.join(config.CACHE_DIR, "torrent-streams.json"),
  {
    streams: {}, // "type|id" -> { at, streams }
    ids: {}, // "type|title|year" -> imdbId
  },
);
// Tolerate an older on-disk shape (pre-rewrite the file only had { torrents })
if (!STORE.data.streams) STORE.data.streams = {};
if (!STORE.data.ids) STORE.data.ids = {};

// Full Torrentio (not /lite) - many more sources per title
const TORRENTIO_BASE = "https://torrentio.strem.fun";
const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
const STREAMS_TTL = 6 * 3600 * 1000;
// How long Torrentio gets to answer. This was 15s and that is below its floor:
// measured 2026-07-31 over eleven requests across six titles, it never replied
// faster than 19.4s, clustering on two plateaus at ~19.4s and ~38.9s (the same
// scrape window, sometimes run twice). Every lookup therefore aborted, the route
// returned 502, and both the site and the TV showed no sources at all — for the
// 22 hours since the last request that beat the old budget.
const SOURCES_TIMEOUT = 51000;
const VIDEO_EXT = [".mp4", ".mkv", ".webm", ".avi", ".m4v", ".mov"];

// Memoise the PROMISE (not the instance) so two requests racing before the
// first import resolves can't each construct a second WebTorrent client.
let clientInstance = null;
let clientPromise = null;
const getClient = () => {
  if (!clientPromise) {
    clientPromise = loadWebTorrent().then((W) => {
      // Cap peer connections per torrent. A completed torrent otherwise keeps
      // dialing new peers to seed — climbing to 100+ sockets at 0 MB/s, which
      // both wastes resources and looks alarming in the buffering UI. 40 is
      // plenty for fast streaming.
      // seedOutgoingConnections:false makes webtorrent itself ignore peers
      // offered by trackers/DHT/PEX once a torrent is done — it stops dialing
      // out the moment there is nothing left to fetch (see quiesce()).
      clientInstance = new W({ maxConns: 40, seedOutgoingConnections: false });
      // A client-level error with no listener throws out of the event loop;
      // the process guard catches it but the client can be left wedged. Log it.
      clientInstance.on("error", (err) =>
        console.error(
          "[torrent] client error:",
          err && err.message ? err.message : err,
        ),
      );
      return clientInstance;
    });
  }
  return clientPromise;
};

// Evict torrents nobody is watching so RAM / sockets / disk don't grow without
// bound over a long-running server. lastAccess is bumped on every stream/status
// touch; a torrent idle past the threshold is removed (and its files freed).
const torrentAccess = new Map(); // infoHash -> last-access ms
const TORRENT_IDLE_MS = 30 * 60 * 1000; // 30 min untouched -> evict
const MAX_TORRENTS = 12; // hard cap; evict least-recently-used beyond it
const touchTorrent = (infoHash) => torrentAccess.set(infoHash, Date.now());

// In-flight remove+destroyStore teardowns. A readyTorrent re-add racing a
// pending remove reads through half-destroyed store handles — the new
// instance's reads then hang forever (~4MB then silence; seen live
// 2026-07-24, and the failed unlinks are why stale staging piles up on C:).
const removing = new Map(); // infoHash -> Promise<void>

setInterval(() => {
  const cl = clientInstance;
  if (!cl) return;
  const now = Date.now();
  const evict = (t, why) => {
    const hash = t.infoHash;
    const p = new Promise((resolve) => {
      try {
        cl.remove(hash, { destroyStore: true }, (err) => {
          if (err)
            console.warn(
              `[torrent] destroyStore failed for ${hash.slice(0, 8)}…:`,
              err.message,
            );
          resolve();
        });
      } catch {
        resolve();
      }
    });
    removing.set(hash, p);
    p.finally(() => {
      if (removing.get(hash) === p) removing.delete(hash);
    });
    torrentAccess.delete(hash);
    perf.flush(hash, `evict-${why}`);
    console.log(`[torrent] evicted ${why} ${hash.slice(0, 8)}…`);
  };
  // 1) idle eviction — and stop peer discovery on anything already complete
  //    (covers torrents that came up 100% from the store, whose 'done' event
  //    fired before we could listen for it)
  for (const t of [...cl.torrents]) {
    if (now - (torrentAccess.get(t.infoHash) || 0) > TORRENT_IDLE_MS)
      evict(t, "idle");
    else if (servedContentComplete(t)) quiesce(t, "sweep");
  }
  // 2) hard cap — drop least-recently-used, but never one touched in the last
  //    2 min (i.e. actively streaming)
  if (cl.torrents.length > MAX_TORRENTS) {
    const cold = [...cl.torrents]
      .filter((t) => now - (torrentAccess.get(t.infoHash) || 0) > 120000)
      .sort(
        (a, b) =>
          (torrentAccess.get(a.infoHash) || 0) -
          (torrentAccess.get(b.infoHash) || 0),
      );
    for (const t of cold.slice(0, cl.torrents.length - MAX_TORRENTS))
      evict(t, "over-cap");
  }
}, 60000).unref?.();

// ---------- quiescing a finished torrent ----------
// Once every byte we need is verified on disk there is nothing left to find:
// announcing to trackers, answering DHT and holding wires open only burn
// sockets and CPU. From here on the file is served straight off disk (see the
// fast path in recoveringStream), so we stop looking for peers entirely.
//
// Deliberately REVERSIBLE — discovery is never destroyed, only silenced — so a
// later request for a different, incomplete file of the same torrent (packs)
// can bring it back to life via unquiesce().
const quiesce = (t, why) => {
  if (!t || t._auroraQuiesced) return;
  t._auroraQuiesced = true;
  try {
    const tracker = t.discovery && t.discovery.tracker;
    if (tracker) {
      tracker.setInterval(0); // halt the periodic announce
      tracker.stop(); // tell trackers we're gone
    }
    // The DHT re-announce is a self-rescheduling timeout on torrent-discovery.
    if (t.discovery && t.discovery._dhtTimeout)
      clearTimeout(t.discovery._dhtTimeout);
    t.pause(); // no new/incoming peers while quiesced
    for (const w of [...(t.wires || [])]) {
      try {
        w.destroy();
      } catch {}
    }
  } catch (e) {
    console.warn(
      `[torrent] quiesce failed for ${t.infoHash.slice(0, 8)}…:`,
      e && e.message,
    );
  }
  console.log(
    `[torrent] ${t.infoHash.slice(0, 8)}… complete — stopped looking for peers (${why}), serving from disk`,
  );
};

const unquiesce = (t, why) => {
  if (!t || !t._auroraQuiesced) return;
  t._auroraQuiesced = false;
  try {
    t.resume();
    const tracker = t.discovery && t.discovery.tracker;
    if (tracker) {
      tracker.setInterval(); // back to the default announce interval
      tracker.start();
    }
  } catch (e) {
    console.warn(
      `[torrent] unquiesce failed for ${t.infoHash.slice(0, 8)}…:`,
      e && e.message,
    );
  }
  console.log(
    `[torrent] ${t.infoHash.slice(0, 8)}… looking for peers again (${why})`,
  );
};

// True when everything we actually serve from this torrent is on disk: either
// the whole torrent finished, or the single file we scoped it to did.
const servedContentComplete = (t) =>
  !!t && (t.done === true || !!(t._auroraFile && t._auroraFile.done));

// infoHash -> announce (tracker) list from Torrentio, for faster peer discovery
const sourcesByHash = new Map();

// Public trackers to always include. HTTP/HTTPS/WSS (TCP-based) come FIRST and
// are the backbone: many networks — VPNs especially (NordVPN etc.) — block
// UDP, which kills both DHT and udp:// trackers, leaving peer discovery with
// no channel. TCP trackers get through. The udp:// entries are kept as a
// bonus for networks where UDP works (they announce in parallel and simply
// time out harmlessly where it doesn't).
const DEFAULT_TRACKERS = [
  // HTTP/HTTPS/WSS (TCP) — the backbone. On a UDP-filtered connection (many
  // residential ISPs + VPNs) DHT and udp:// trackers are dead, so the ONLY way
  // to find peers is TCP trackers. The more live ones we announce to, the more
  // torrents find reachable peers — so this list is deliberately broad.
  // All entries were verified reachable 2026-07-23. Refresh from a maintained
  // source when discovery degrades: github.com/ngosang/trackerslist (the
  // trackers_all_http / _https / _ws lists), keeping TCP entries first.
  "http://tracker.opentrackr.org:1337/announce",
  "https://tracker.pmman.tech:443/announce",
  "https://ht.therarbg.to:443/announce",
  "https://tracker.nekomi.cn:443/announce",
  "https://tracker.7471.top:443/announce",
  "https://021912.xyz:443/announce",
  "https://004430.xyz:443/announce",
  "https://tracker.bt4g.com:443/announce",
  "https://tr.nyacat.pw:443/announce",
  "https://t.213891.xyz:443/announce",
  "http://1337.abcvg.info:80/announce",
  "http://tracker.dler.org:6969/announce",
  "http://tracker.qu.ax:6969/announce",
  "http://t.overflow.biz:6969/announce",
  "http://ipv4announce.sktorrent.eu:6969/announce",
  "http://tracker.waaa.moe:6969/announce",
  "http://bittorrent-tracker.e-n-c-r-y-p-t.net:1337/announce",
  "wss://tracker.webtorrent.dev:443",
  "wss://tracker.openwebtorrent.com:443",
  "wss://tracker.btorrent.xyz:443",
  // UDP — faster where allowed (home networks without UDP filtering). These
  // simply time out harmlessly where UDP is blocked.
  //
  // Ordered by a real announce to each, 2026-07-27: these four answered in
  // ~2.5s with 30-50 peers apiece, while opentrackr timed out on both its UDP
  // and HTTP entries. The download engine tries this group first (see
  // magnetFor), so a dead tracker at the front is paid for in dead air before
  // the first peer — re-measure with tools like the announce check in this
  // file's history if discovery ever degrades again.
  "udp://open.demonii.com:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.opentrackr.org:1337/announce",
];

// Torrentio `sources` look like "tracker:udp://..." and "dht:<nodeid>".
const trackersFromSources = (sources = []) =>
  sources
    .filter((s) => typeof s === "string" && s.startsWith("tracker:"))
    .map((s) => s.slice("tracker:".length));

const fetchJson = async (url, ms = 12000) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "Aurora/1.0" },
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ---------- title -> IMDb id (keyless, via Cinemeta) ----------

const resolveId = async (type, title, year) => {
  if (/^tt\d+$/i.test(title)) return title;

  // Prefer an IMDb id we already know from the library / metadata
  const libItem = scanner
    .allItems()
    .find((i) => normalize(i.title) === normalize(title));
  if (libItem && libItem.imdbId) return libItem.imdbId;

  const cacheKey = `${type}|${normalize(title)}|${year || ""}`;
  if (STORE.data.ids[cacheKey]) return STORE.data.ids[cacheKey];

  const cinemetaType = type === "series" ? "series" : "movie";
  const data = await fetchJson(
    `${CINEMETA_BASE}/catalog/${cinemetaType}/top/search=${encodeURIComponent(title)}.json`,
  );
  const metas = data.metas || [];
  if (metas.length === 0) return null;

  // Best match: exact title, preferring the right year when we have one
  const scored = metas
    .map((m) => {
      let score =
        normalize(m.name) === normalize(title)
          ? 2
          : normalize(m.name).includes(normalize(title))
            ? 1
            : 0;
      if (year && m.releaseInfo) {
        const my = parseInt(String(m.releaseInfo).slice(0, 4), 10);
        if (my === year) score += 2;
        else if (Math.abs(my - year) <= 1) score += 1;
      }
      return { m, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const id = best && best.m.id && /^tt\d+/.test(best.m.id) ? best.m.id : null;
  if (id) {
    STORE.data.ids[cacheKey] = id;
    STORE.save();
  }
  return id;
};

// ---------- Torrentio parsing ----------

const parseSeeders = (title) => {
  const m = title.match(/\u{1F464}\s*([\d,.]+)/u);
  return m ? parseInt(m[1].replace(/[,.]/g, ""), 10) : 0;
};

const parseSizeString = (title) => {
  const m = title.match(/\u{1F4BE}\s*([\d.,]+\s*[KMGT]?B)/iu);
  return m ? m[1].trim() : null;
};

const parseSizeBytes = (title) => {
  const s = parseSizeString(title);
  if (!s) return 0;
  const num = parseFloat(s.replace(",", "."));
  if (/GB/i.test(s)) return Math.round(num * 1024 ** 3);
  if (/MB/i.test(s)) return Math.round(num * 1024 ** 2);
  if (/KB/i.test(s)) return Math.round(num * 1024);
  return Math.round(num * 1024 ** 3);
};

const parseQuality = (name) => {
  const n = (name || "").toLowerCase();
  if (n.includes("2160") || n.includes("4k")) return "2160p";
  if (n.includes("1080")) return "1080p";
  if (n.includes("720")) return "720p";
  if (n.includes("480")) return "480p";
  return "SD";
};

// First line of Torrentio's `name` is the source, second is the quality label
const qualityLabel = (name) => {
  const parts = (name || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts[1] || parts[0] || "";
};

// The release name Torrentio puts on the first line of `title`
const releaseName = (title) => (title || "").split("\n")[0].trim();

// The provider Torrentio labels on the first line of `name` (e.g. "Torrentio",
// "ThePirateBay", "YTS")
const providerName = (name) => {
  const first = (name || "").split("\n")[0].trim();
  return first && first.toLowerCase() !== "torrentio" ? first : null;
};

// Rich release tags (HDR/DV, codec, audio, rip type) for display badges.
const parseTags = (name, title) => {
  const s = `${name} ${title}`;
  const tags = [];
  if (/dolby\s*vision|\bDV\b/i.test(s)) tags.push("DV");
  if (/HDR10\+|HDR10|\bHDR\b/i.test(s)) tags.push("HDR");
  if (/\bREMUX\b/i.test(s)) tags.push("REMUX");
  else if (/blu-?ray|\bBDRemux\b|\bBDRip\b|\bBRRip\b/i.test(s))
    tags.push("BluRay");
  else if (/web-?dl/i.test(s)) tags.push("WEB-DL");
  else if (/webrip/i.test(s)) tags.push("WEBRip");
  else if (/hdrip|hdtv/i.test(s)) tags.push("HDRip");
  else if (/\bCAM\b|\bTS\b|telesync/i.test(s)) tags.push("CAM");
  if (/atmos/i.test(s)) tags.push("Atmos");
  else if (/truehd/i.test(s)) tags.push("TrueHD");
  else if (/dts-?hd/i.test(s)) tags.push("DTS-HD");
  else if (/\bDTS\b/i.test(s)) tags.push("DTS");
  else if (/ddp|dd\+|e-?ac-?3|eac3/i.test(s)) tags.push("DD+");
  if (/av1/i.test(s)) tags.push("AV1");
  else if (/x265|h\.?265|hevc/i.test(s)) tags.push("H.265");
  else if (/x264|h\.?264|avc/i.test(s)) tags.push("H.264");
  return tags;
};

// A CAM/telesync source is low quality regardless of resolution - flag it.
const isCam = (name, title) =>
  /\bCAM\b|\bTS\b|telesync|hdcam/i.test(`${name} ${title}`);

// A dubbed release (re-voiced audio, or foreign-audio-only with no English
// track) should never be the recommended pick — if it's not the source
// language it can't be "best". Multi-audio packs that still include English
// stay eligible.
const isDubbed = (title, languages) =>
  /\b(dub|dubbed|dublado|dubbing)\b/i.test(title) ||
  (languages.length > 0 && !languages.includes("EN"));

// Collection packs (a movie inside a "Top 250" / trilogy / 110 GB anthology
// torrent). They're bad sources: swarms are weaker per-file, metadata for a
// giant torrent is slow to fetch, and the odds of a usable peer for YOUR file
// are low ("637 seeders" on an IMDb-250 pack found zero usable peers live).
// For movies, any fileIdx > 0 means multi-file; for series that's the normal
// season-pack shape, so only name-matched collections are flagged there.
const PACK_RE =
  /\b(complete|collection|anthology|trilogy|duology|quadrilogy|boxset|box ?set|movie ?pack|top ?\d{2,4}|filmography|collezione|saga)\b/i;
const isPack = (s, ttType) =>
  PACK_RE.test(s.release || "") || (ttType === "movie" && (s.fileIdx || 0) > 0);

// "Best value" score for ranking + the recommended pick: 1080p is the sweet
// spot, more seeders is better, and oversized files are penalised (slower to
// start and heavier to transcode). 4K sits below 1080p here on purpose.
// `sizeCapGb` is where the penalty starts: ~4.5 GB is fine for a movie, but a
// single EPISODE at 3.6 GB is remux-grade overkill — without a lower cap it
// outscored a 500 MB encode of the same episode.
const GB = 1024 ** 3;
const valueScore = (s, sizeCapGb = 4.5) => {
  if (s.cam) return -1e6;
  const qBase =
    { "1080p": 100, "720p": 70, "2160p": 62, "480p": 40, SD: 20 }[s.quality] ??
    20;
  const seedBonus = Math.min(s.seeders || 0, 3000) / 100; // 0..30
  const gb = (s.sizeBytes || 0) / GB;
  const sizePenalty = gb > sizeCapGb ? (gb - sizeCapGb) * 8 : 0;
  // Sink packs below every same-quality single release, but above CAMs.
  const packPenalty = s.pack ? 55 : 0;
  return qBase + seedBonus - sizePenalty - packPenalty;
};

const LANG_FLAGS = {
  "🇬🇧": "EN",
  "🇺🇸": "EN",
  "🇮🇱": "HE",
  "🇮🇳": "HI",
  "🇫🇷": "FR",
  "🇩🇪": "DE",
  "🇪🇸": "ES",
  "🇮🇹": "IT",
  "🇷🇺": "RU",
  "🇯🇵": "JA",
  "🇰🇷": "KO",
  "🇵🇹": "PT",
  "🇵🇱": "PL",
  "🇹🇷": "TR",
  "🇨🇳": "ZH",
};
const parseLanguages = (title) => {
  const langs = [];
  for (const [flag, code] of Object.entries(LANG_FLAGS)) {
    if (title.includes(flag) && !langs.includes(code)) langs.push(code);
  }
  return langs;
};

// ---------- sources ----------

// Fetch stream sources for a title. For series pass season+episode.
const getSources = async (type, title, year, season, episode) => {
  const ttType = type === "series" || type === "show" ? "series" : "movie";
  const imdbId = /^tt\d+$/i.test(title)
    ? title
    : await resolveId(ttType, title, year);
  if (!imdbId) return { imdbId: null, streams: [] };

  const streamId =
    ttType === "series" && season && episode
      ? `${imdbId}:${season}:${episode}`
      : imdbId;

  const cacheKey = `${ttType}|${streamId}`;
  const cached = STORE.data.streams[cacheKey];
  // Fresh AND in the current shape (older cached entries lack `tags`)
  if (
    cached &&
    Date.now() - cached.at < STREAMS_TTL &&
    cached.streams.length &&
    cached.v === 4 // parser/ranking version — older cached lists must recompute
  ) {
    return { imdbId, streams: cached.streams };
  }

  const data = await fetchJson(
    `${TORRENTIO_BASE}/stream/${ttType}/${streamId}.json`,
    SOURCES_TIMEOUT,
  );
  const seen = new Set();
  let streams = (data.streams || [])
    .map((s) => {
      const title = (s.title || "").toString();
      const name = (s.name || "").toString();
      if (s.infoHash) {
        sourcesByHash.set(s.infoHash, trackersFromSources(s.sources));
      }
      const languages = parseLanguages(title);
      const stream = {
        infoHash: s.infoHash,
        fileIdx: s.fileIdx || 0,
        filename: s.behaviorHints?.filename || releaseName(title) || "video",
        release: releaseName(title),
        provider: providerName(name),
        quality: parseQuality(name),
        qualityLabel: qualityLabel(name),
        tags: parseTags(name, title),
        cam: isCam(name, title),
        dubbed: isDubbed(title, languages),
        seeders: parseSeeders(title),
        sizeString: parseSizeString(title),
        sizeBytes: parseSizeBytes(title),
        languages,
      };
      stream.pack = isPack(stream, ttType);
      return stream;
    })
    .filter((s) => {
      if (!s.infoHash || seen.has(s.infoHash)) return false;
      seen.add(s.infoHash);
      return true;
    })
    .sort((a, b) => {
      // Best-value first: favour 1080p (the sweet spot), reward seeders, and
      // penalise oversized files (episodes use a much lower size cap than
      // movies). CAM rips always sink. Quality-specific browsing still works
      // via the quality filter pills.
      if (a.cam !== b.cam) return a.cam ? 1 : -1;
      const sizeCap = ttType === "series" ? 1.4 : 4.5;
      return valueScore(b, sizeCap) - valueScore(a, sizeCap);
    });

  // Cap the list, but reserve slots per quality tier: a flat top-40 by value
  // let 1080p crowd out nearly every 4K option (large remuxes carry a big
  // size penalty), leaving the 4K filter pill almost empty. Guarantee the
  // best few of each tier survive the cap, in value order.
  const kept = new Set(streams.slice(0, 40));
  for (const q of ["2160p", "1080p", "720p", "480p", "SD"]) {
    for (const s of streams
      .filter((x) => x.quality === q && !x.cam)
      .slice(0, 8))
      kept.add(s);
  }
  streams = streams.filter((s) => kept.has(s));

  // Flag the top non-CAM, non-dubbed, non-pack pick so the UI can recommend
  // it (packs only become eligible when nothing else exists).
  const best =
    streams.find((s) => !s.cam && !s.dubbed && !s.pack) ||
    streams.find((s) => !s.cam && !s.dubbed);
  if (best) best.recommended = true;

  STORE.data.streams[cacheKey] = { at: Date.now(), streams, v: 4 };
  STORE.save();
  return { imdbId, streams };
};

// ---------- external subtitles ----------
//
// The providers, the Hebrew/English-only policy and the encoding handling all
// live in media/websubs.js. This is just the two shapes the rest of the server
// asks for: raw tracks (the download manager saves them as sidecars) and
// player-ready tracks (proxied, because a browser can't unzip Wizdom's archive
// or guess Windows-1255).
const websubs = require("./websubs");

const getSubtitleSources = (type, imdbId, season, episode) =>
  websubs.list(type, imdbId, season, episode);

const getSubtitles = async (type, imdbId, season, episode) =>
  (await websubs.list(type, imdbId, season, episode)).map((s) => ({
    lang: s.lang,
    label: s.label,
    note: s.note || "",
    url: `/stream/websub?p=${s.provider}&r=${encodeURIComponent(s.ref)}`,
  }));

// One track as WebVTT, for the player.
const fetchSubtitleAsVtt = async (track) =>
  websubs.toVtt(await websubs.fetchSrt(track));

// ---------- streaming ----------

// Add (or find) a torrent and resolve once its metadata + files are ready.
const _readyTorrent = (infoHash) =>
  new Promise((resolve, reject) => {
    getClient().then(async (cl) => {
      try {
        // Never re-add a torrent whose previous instance is still tearing down
        // (see `removing` above) — wait for the teardown to finish first.
        const rm = removing.get(infoHash);
        if (rm) {
          try {
            await rm;
          } catch {}
        }

        let t = cl.torrents.find((x) => x.infoHash === infoHash);
        if (t && t.ready) return resolve(t);

        if (!t) {
          // Trackers MUST be embedded in the magnet URI as &tr= params — passing
          // them only via the `announce` option leaves WebTorrent DHT-only, which
          // routinely finds 0 peers ("No nodes to query"). Combine Torrentio's
          // trackers with a strong public default set.
          const announce = [
            ...new Set([
              ...(sourcesByHash.get(infoHash) || []),
              ...DEFAULT_TRACKERS,
            ]),
          ];
          const trParams = announce
            .map((t) => "tr=" + encodeURIComponent(t))
            .join("&");
          const magnet = `magnet:?xt=urn:btih:${infoHash}&${trParams}`;
          try {
            // No `path` option: stream from WebTorrent's default store. A custom
            // path can stall adds on Windows and isn't needed for streaming.
            t = cl.add(magnet, { announce });
          } catch (err) {
            // Duplicate-add race: a magnet's infoHash isn't set synchronously, so
            // a concurrent request may have already added this torrent. Reuse it.
            const existing = cl.torrents.find((x) => x.infoHash === infoHash);
            if (existing) t = existing;
            else return reject(err);
          }
          console.log(
            `[torrent] add ${infoHash.slice(0, 8)}… (${announce.length} trackers)`,
          );
          perf.mark(infoHash, "add", { trackers: announce.length });
          t.once("metadata", () => perf.mark(infoHash, "metadata"));
          t.once("wire", () => perf.mark(infoHash, "first_peer"));
          t.on("ready", () => {
            perf.mark(infoHash, "ready", {
              files: t.files.length,
              peersAtReady: t.numPeers,
            });
            console.log(
              `[torrent] ${infoHash.slice(0, 8)}… ready, ${t.files.length} files, ${t.numPeers} peers`,
            );
          });
          // Fully downloaded: stop hunting for peers and serve from disk. Deferred
          // a tick so webtorrent finishes its own 'done' bookkeeping (it calls
          // discovery.complete() right after this event) before we silence
          // discovery and drop wires.
          t.on("done", () => setTimeout(() => quiesce(t, "done"), 1000));
          // Persistent listener: readyTorrent's once("error") is removed after
          // ready, so a LATER torrent error (tracker failure, bad piece) would
          // otherwise be an unhandled 'error' event.
          t.on("error", (err) =>
            console.error(
              `[torrent] ${infoHash.slice(0, 8)}… error:`,
              err && err.message ? err.message : err,
            ),
          );
        }

        // Use once() + cleanup so repeated requests for the same not-yet-ready
        // torrent (buffering polls, parallel video/subtitle/HLS calls) don't pile
        // listeners onto the shared torrent object.
        const onReady = () => {
          cleanup();
          resolve(t);
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out finding peers"));
        }, 90000);
        const cleanup = () => {
          clearTimeout(timer);
          t.removeListener("ready", onReady);
          t.removeListener("error", onError);
        };
        t.once("error", onError);
        if (t.ready) onReady();
        else t.once("ready", onReady);
      } catch (err) {
        reject(err);
      }
    }, reject);
  });

// A file read stream that heals itself. WebTorrent streams created while the
// torrent is still RE-VERIFYING an existing store can wedge forever: a piece
// that gets store-verified after the stream attached never wakes the waiting
// read (seen live twice, 2026-07-24 — playback froze after ~4 MiB on torrents
// whose data was 100% on disk). If no bytes flow for 10s, destroy the inner
// stream and recreate it at the exact byte offset — after verification has
// settled the fresh stream sees the full bitfield and flows immediately. For
// genuinely starved swarms the periodic recreate is harmless churn.
const { PassThrough } = require("stream");
const recoveringStream = (file, { start = 0, end, torrent: t } = {}) => {
  const last = end === undefined ? file.length - 1 : end;
  const wanted = last - start + 1; // exactly what the caller promised its client
  const out = new PassThrough();
  let inner = null;
  let sent = 0;
  let lastData = Date.now();
  let closed = false;
  let resumedAt = -1; // `sent` at the last resume, so we can tell progress from a spin
  let stuckSince = 0; // when `sent` stopped advancing across resumes
  const RESUME_GIVE_UP_MS = 30000;

  // Pick up a range that ended early or failed. Measured live on a cold swarm:
  // webtorrent returns a *partial* range and emits 'end' (seen at +481308 of
  // 2097152), so resuming is the difference between a whole range and a lie.
  // We keep resuming while bytes flow, and give up only after half a minute of
  // no progress at all — failing loudly matters, because the routes turn a
  // stream error into a BROKEN response, which ffmpeg retries (-reconnect) and
  // the browser reports honestly, whereas a short body is taken as real data.
  const resumeOrFail = (why, err) => {
    if (closed) return;
    if (sent !== resumedAt) {
      resumedAt = sent;
      stuckSince = 0;
      console.warn(
        `[torrent] ${why} at +${sent}/${wanted} — resuming (${file.name})`,
      );
    } else if (!stuckSince) {
      stuckSince = Date.now();
    }
    if (stuckSince && Date.now() - stuckSince > RESUME_GIVE_UP_MS) {
      closed = true;
      clearInterval(tick);
      out.destroy(
        err || new Error(`range stuck at ${sent}/${wanted} (${why})`),
      );
      return;
    }
    // Two things must not happen: a hot loop when the inner read closes
    // instantly, and the heal timer spawning a SECOND inner read alongside this
    // one (two live readers would interleave bytes into `out` and corrupt the
    // range). A short delay fixes the first; refreshing lastData means the
    // 10-second heal check can't fire inside that window, which fixes the second.
    lastData = Date.now();
    const again = setTimeout(() => {
      if (!closed) spawn();
    }, 500);
    again.unref?.();
  };

  const spawn = () => {
    // FAST PATH: when every piece covering the remaining range is already
    // verified, read straight from the on-disk store file. Measured live
    // (2026-07-24): webtorrent's own read path wedges even on 100%-verified
    // torrents at cold offsets — ~one piece per heal cycle, tail reads dead —
    // while the bytes sit final on an idle disk. WebTorrent is only needed
    // for pieces that don't exist yet.
    try {
      if (t && t.path) {
        // progress >= 1 outranks the bitfield: on a store-resumed torrent
        // webtorrent sets its downloaded counters but NOT the public
        // bitfield (measured live: progress 1, file complete on disk, yet
        // bitfield reported pieces missing — which also wedges its streams).
        let all = t.progress >= 1;
        if (!all && t.bitfield && t.pieceLength) {
          all = true;
          const from = file.offset + start + sent;
          const to = file.offset + last;
          for (
            let i = Math.floor(from / t.pieceLength);
            i <= Math.floor(to / t.pieceLength);
            i++
          ) {
            if (!t.bitfield.get(i)) {
              all = false;
              break;
            }
          }
        }
        if (all) {
          inner = fs.createReadStream(path.join(t.path, file.path), {
            start: start + sent,
            end: last,
          });
          wire();
          return;
        }
        // NOTE: do NOT extend this to serve a PARTIAL verified stretch from
        // disk. Tried 2026-07-25 and it made streaming far worse: handing the
        // read back to webtorrent at every gap meant one 10s heal PER PIECE
        // (measured on Silo S03E04 — 14 heals with offsets marching in exact
        // 262144-byte steps, ~26 KB/s effective), because a disk read doesn't
        // drive webtorrent's piece selection the way its own read stream does.
        // The whole-range check above is only safe because it needs nothing more
        // from the swarm.
      }
    } catch {}
    try {
      inner = file.createReadStream({ start: start + sent, end: last });
    } catch (err) {
      // The torrent was destroyed under us — idle/over-cap eviction, or an
      // admin remove — and webtorrent throws "File is destroyed" synchronously.
      // From the heal timer below that was an uncaughtException every 2.5s
      // forever, with the HTTP response left hanging open (seen live
      // 2026-07-25). Fail the stream instead: the routes already turn a stream
      // error into a closed response, so the client can retry.
      if (!closed) {
        closed = true;
        clearInterval(tick);
        out.destroy(err);
      }
      return;
    }
    wire();
  };

  const wire = () => {
    inner.on("data", (chunk) => {
      sent += chunk.length;
      lastData = Date.now();
      if (!out.write(chunk)) {
        inner.pause();
        out.once("drain", () => {
          try {
            inner && inner.resume();
          } catch {}
        });
      }
    });
    // The INNER read finishing is not the same as the RANGE being delivered.
    // Both routes send Content-Length up front, so ending short here is a lie:
    // the browser reports ERR_CONTENT_LENGTH_MISMATCH (seen live on the seek
    // prefetch), and ffmpeg — which reads offset seeks through this very route —
    // takes the short read as end-of-file, dies with "Invalid data found /
    // Error muxing a packet", and the player gets a 504 on a seek the swarm
    // could actually have served. Resume from where it stopped instead.
    inner.on("end", () => {
      if (closed) return;
      if (sent < wanted) return resumeOrFail("range ended short");
      closed = true;
      clearInterval(tick);
      out.end();
    });
    // A mid-range failure is recoverable the same way a stall is (see the heal
    // timer): try again from `sent`. Only give up when a retry gains nothing.
    inner.on("error", (err) => {
      if (closed) return;
      resumeOrFail(`read failed (${err && err.message})`, err);
    });
  };

  const tick = setInterval(() => {
    if (closed) {
      clearInterval(tick);
      return;
    }
    if (Date.now() - lastData > 10000) {
      lastData = Date.now();
      console.warn(
        `[torrent] read stalled — recreating stream at +${sent} bytes (${file.name})`,
      );
      try {
        inner.removeAllListeners();
        inner.destroy();
      } catch {}
      spawn();
    }
  }, 2500);
  tick.unref?.();

  out.on("close", () => {
    closed = true;
    clearInterval(tick);
    try {
      inner && inner.destroy();
    } catch {}
  });

  spawn();
  return out;
};

// Scope piece-selection to one file of a multi-file torrent. The default
// whole-torrent selection makes webtorrent's per-block piece loop walk EVERY
// piece for every connected wire ON THE MAIN THREAD — a 250-movie collection
// pack (hundreds of thousands of pieces) was measured at 100%+ CPU and 5-6s
// HTTP latency. Deselect-all THEN select the file happens in one tick, so the
// selection is never empty when a peer event fires (the old trySelectWire
// "null.missing" crash trigger was an empty selection left across ticks).
const scopeToFile = (t, file) => {
  try {
    if (
      !t._auroraScoped &&
      t.files.length > 1 &&
      typeof t.deselect === "function"
    ) {
      t.deselect(0, t.pieces.length - 1, false);
      t._auroraScoped = true;
      console.log(
        `[torrent] ${t.infoHash.slice(0, 8)}… scoped to "${file.name}" (${t.files.length} files, ${t.pieces.length} pieces)`,
      );
    }
    if (typeof file.select === "function") file.select();
    // Remember what this torrent is actually serving, so "complete" can mean
    // "this file is complete" on a pack we only ever read one file from.
    t._auroraFile = file;
    // A pack whose OTHER file is now wanted needs its peers back; a file that's
    // already fully on disk needs none.
    if (!file.done && !t.done) unquiesce(t, `need "${file.name}"`);
    else if (servedContentComplete(t)) quiesce(t, "file complete");
  } catch (e) {
    console.warn(
      `[torrent] scoping failed for ${t.infoHash.slice(0, 8)}…:`,
      e && e.message,
    );
  }
};

// Remove a torrent with a tracked teardown (see `removing`), so re-adds wait.
const removeTorrent = (infoHash) =>
  new Promise((resolve) => {
    const cl = clientInstance;
    const t = cl && cl.torrents.find((x) => x.infoHash === infoHash);
    if (!t) return resolve(false);
    perf.flush(infoHash, "removed");
    const p = new Promise((done) => {
      try {
        cl.remove(infoHash, { destroyStore: true }, (err) => {
          if (err)
            console.warn(
              `[torrent] destroyStore failed for ${infoHash.slice(0, 8)}…:`,
              err.message,
            );
          done();
        });
      } catch {
        done();
      }
    });
    removing.set(infoHash, p);
    p.finally(() => {
      if (removing.get(infoHash) === p) removing.delete(infoHash);
    });
    torrentAccess.delete(infoHash);
    p.then(() => resolve(true));
  });

// How much of the FILE we're actually serving has arrived, 0..1 (null when we
// aren't scoped to a file yet). `t.progress` can't answer this: it spans the
// whole torrent — so a 2 GB movie inside a 110 GB pack tops out near 2% — and
// it counts partly-arrived pieces across everything, which is what made the
// admin bar leap ahead early and then never land. Bytes over the served file's
// piece range, read off the bitfield (which, unlike the File.downloaded getter,
// can't throw out of the piece picker).
const servedFileProgress = (t) => {
  const file = t && t._auroraFile;
  if (!t || !file || !file.length || !t.bitfield || !t.pieceLength) return null;
  try {
    const first = Math.floor(file.offset / t.pieceLength);
    const last = Math.floor((file.offset + file.length - 1) / t.pieceLength);
    let have = 0;
    let total = 0;
    for (let i = first; i <= last; i++) {
      const len = i === t.pieces.length - 1 ? t.lastPieceLength : t.pieceLength;
      total += len;
      if (t.bitfield.get(i)) {
        have += len;
        continue;
      }
      const piece = t.pieces[i];
      if (!piece) {
        have += len;
        continue;
      } // nulled = completed
      const missing = typeof piece.missing === "number" ? piece.missing : len;
      have += Math.max(0, len - missing);
    }
    return total > 0 ? Math.min(1, have / total) : null;
  } catch {
    return null;
  }
};

// Lightweight view of what the streaming client is holding (admin).
const listTorrents = () => {
  const cl = clientInstance;
  if (!cl) return [];
  return cl.torrents.map((t) => ({
    infoHash: t.infoHash,
    name: t.name || null,
    files: t.files ? t.files.length : 0,
    pieces: t.pieces ? t.pieces.length : 0,
    progress: t.progress || 0,
    peers: t.numPeers || 0,
    downloadSpeed: t.downloadSpeed || 0,
    done: !!t.done,
    quiesced: !!t._auroraQuiesced,
    lastAccess: torrentAccess.get(t.infoHash) || 0,
  }));
};

// De-dupe concurrent readyTorrent calls for the same infoHash (two profiles
// opening the same stream, or the buffering poll racing the video request) so
// they share ONE add instead of racing into a duplicate-add error.
const readying = new Map(); // infoHash -> Promise<torrent>
const readyTorrent = (infoHash) => {
  touchTorrent(infoHash); // mark in-use so the eviction sweeper leaves it alone
  const inflight = readying.get(infoHash);
  if (inflight) return inflight;
  const p = _readyTorrent(infoHash);
  readying.set(infoHash, p);
  p.finally(() => {
    if (readying.get(infoHash) === p) readying.delete(infoHash);
  });
  // The map's reference has no consumer of its own — without this, a shared
  // rejection ("Timed out finding peers") also fires as an unhandledRejection
  // even though every real caller handled it.
  p.catch(() => {});
  return p;
};

// Pick the video file: the given index, else the largest video file.
const pickVideoFile = (torrent, fileIdx) => {
  const videos = torrent.files.filter((f) =>
    VIDEO_EXT.includes(path.extname(f.name).toLowerCase()),
  );
  if (typeof fileIdx === "number" && torrent.files[fileIdx]) {
    const f = torrent.files[fileIdx];
    if (VIDEO_EXT.includes(path.extname(f.name).toLowerCase())) return f;
  }
  return (
    videos.sort((a, b) => b.length - a.length)[0] || torrent.files[0] || null
  );
};

// Subtitle files inside the torrent, as playable tracks.
const torrentSubtitles = (torrent, infoHash) => {
  const subs = [];
  torrent.files.forEach((f, i) => {
    const ext = path.extname(f.name).toLowerCase();
    if (ext === ".srt" || ext === ".vtt") {
      subs.push({
        label: path.basename(f.name, ext).slice(0, 40),
        url: `/stream/torrent/sub/${infoHash}/${i}`,
      });
    }
  });
  return subs;
};

const clearCache = () => {
  STORE.data = { streams: {}, ids: {} };
  STORE.save();
};

// Synchronous peek for telemetry/admin: the client only if it already exists.
const clientIfLoaded = () => clientInstance;

// Build a magnet URI (+ tracker list) for an infoHash, combining any trackers
// Torrentio gave us for it with the strong public default set. Used by the
// download-to-server manager, which persists the result so it survives a
// restart (after which sourcesByHash is empty).
// The magnet handed to the DOWNLOAD engine (aria2). Streaming builds its own
// (see getSources/_readyTorrent) and keeps the list exactly as it is, because
// WebTorrent needs the wss:// entries to reach browser peers.
//
// ORDER MATTERS MORE THAN LENGTH here, measured 2026-07-27 by announcing to
// every tracker in the list: the first entry was dead, and aria2 worked through
// it before anything else — 22.3 seconds before the download had a single peer.
// Leading with the udp:// trackers (which answered in ~2.5s with 30-50 peers
// each) brought that to 0.8 seconds. The wss:// entries are dropped outright:
// only a browser can speak to a WebSocket tracker, so for aria2 they are pure
// waiting. Nothing is hardcoded as "dead" — trackers come back, and a short
// tracker timeout (see media/aria2.js) is what keeps a dead one cheap.
const magnetFor = (infoHash) => {
  const all = [
    ...new Set([...(sourcesByHash.get(infoHash) || []), ...DEFAULT_TRACKERS]),
  ];
  const usable = all.filter((t) => !t.startsWith("wss://"));
  const announce = [
    ...usable.filter((t) => t.startsWith("udp://")),
    ...usable.filter((t) => !t.startsWith("udp://")),
  ];
  const trParams = announce.map((t) => "tr=" + encodeURIComponent(t)).join("&");
  return { magnet: `magnet:?xt=urn:btih:${infoHash}&${trParams}`, announce };
};

module.exports = {
  getClient,
  clientIfLoaded,
  magnetFor,
  servedFileProgress,
  touchTorrent,
  resolveId,
  getSources,
  getSubtitles,
  getSubtitleSources,
  fetchSubtitleAsVtt,
  readyTorrent,
  pickVideoFile,
  scopeToFile,
  recoveringStream,
  removeTorrent,
  listTorrents,
  torrentSubtitles,
  clearCache,
  VIDEO_EXT,
  CACHE_DIR,
};
