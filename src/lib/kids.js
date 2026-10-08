// Kids profiles: the age-rating gate (2026-10-08).
//
// A profile marked `kids: { maxAge }` only ever gets titles whose age rating
// is KNOWN and at or under that age. Everything here is pure — the rating
// arithmetic, the list filters, the request gate with its lookups injected —
// so test/kids.test.js pins it without a server, a scanner or the network.
// The wiring to the real stores lives in routes/api.js.
//
// THE CHOICE THAT MATTERS: a title with NO known rating is HIDDEN from a kids
// profile. "Unknown" is not "fine": an unrated title is as likely to be a
// horror film nobody certified as a cartoon. The price is that a catalogue
// title stays out of a kids profile until its rating has been looked up once
// (routes/api.js asks for those in the background, never on a hot route).

// The limits a profile can be given. They line up with what
// media/certification.js produces: FSK/Kijkwijzer numbers (0, 6, 12, 16, 18),
// BBFC (U, PG, 12, 15, 18) and the US letters translated to ages.
//   0  — only titles rated for everyone
//   7  — adds 6+ / 7+ (FSK 6, TV-Y7)
//   12 — adds PG (read as 8), 9+, 10+, 12+
//   16 — adds 13+ … 16+ (PG-13, TV-14, BBFC 15, FSK 16)
// 17+ / 18+ never fit a kids profile.
const AGES = [0, 7, 12, 16];

// Ratings that mean "no restriction", in the bodies' own spelling (the label
// "ALL" is what certification.ageLabel turns these into).
const ALL_AGES = new Set(["ALL", "AL", "U", "UC", "G", "TV-G", "TV-Y"]);
// Ratings with an official age that the string doesn't print.
const NAMED = { R: 17, "TV-MA": 17 };
// "Parental guidance" carries no number anywhere. The BBFC's own wording is
// that a PG film "should not unsettle a child aged around eight or older",
// so it reads as 8: out of the 0 and 7 limits, inside 12.
const GUIDANCE = { PG: 8, "TV-PG": 8 };

// An age label ("12+", "ALL", "PG") or a raw certification ("12A", "PG-13",
// "TV-Y7", "FSK 16") -> the youngest age it is rated for, or null when it
// says nothing we can stand on ("NR", "", a word we don't know).
const ageOf = (label) => {
  if (typeof label === "number") return Number.isFinite(label) && label >= 0 ? Math.floor(label) : null;
  const raw = String(label == null ? "" : label).trim().toUpperCase();
  if (!raw) return null;
  if (ALL_AGES.has(raw)) return 0;
  if (NAMED[raw] != null) return NAMED[raw];
  if (GUIDANCE[raw] != null) return GUIDANCE[raw];
  const digits = raw.match(/\d{1,2}/);
  return digits ? Number(digits[0]) : null;
};

// The one shape a profile's kids setting may have. Returns the clean value,
// `null` for "not a kids profile" (null / false / {maxAge: null}), and
// `undefined` for anything else — callers refuse that rather than guess.
const cleanKids = (v) => {
  if (v === null || v === false) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  if (v.maxAge === null) return null;
  return typeof v.maxAge === "number" && AGES.includes(v.maxAge) ? { maxAge: v.maxAge } : undefined;
};

// The household PIN: 4 to 6 digits, as a string (a number would lose "0042").
const validPin = (pin) => typeof pin === "string" && /^\d{4,6}$/.test(pin);

// Where an item's rating comes from when it doesn't carry one itself.
// Library items never do (media/online.js stores `certificate: null` for all
// three of its sources), so they are looked up by IMDb id in the cached
// catalogue ratings; an episode asks about its show. Every dep is a plain
// synchronous cache read — nothing here may touch the network.
const makeCertOf = ({ findById = null, imdbIdFor = null, cached = null } = {}) => (item) => {
  if (!item || typeof item !== "object") return null;
  const id = typeof item.id === "string" ? item.id : "";
  // A torrent play-item is stored from what the CLIENT sent with its watch
  // progress, so a rating printed on it proves nothing — only its id counts.
  const trustOwn = !id.startsWith("torrent|") && !item._isTorrent;
  if (trustOwn && item.certificate) return item.certificate;
  let title = item;
  if (item.showId && findById) title = findById(item.showId) || item;
  if (title !== item && title.certificate) return title.certificate;
  const tt = (v) => (typeof v === "string" && /^tt\d{4,12}$/.test(v) ? v : null);
  const imdbId =
    tt(title.imdbId) || tt(item.imdbId) ||
    (trustOwn && imdbIdFor ? tt(imdbIdFor(title)) : null) ||
    tt(id.replace(/^disc:/, ""));
  return imdbId && cached ? cached(imdbId) || null : null;
};

const ownCert = (item) => (item && item.certificate) || null;

// May a profile limited to `maxAge` see this item? Unknown rating -> no.
const allowed = (item, maxAge, certOf = ownCert) => {
  if (!item || typeof maxAge !== "number") return false;
  const age = ageOf(certOf(item));
  return age != null && age <= maxAge;
};

const filterItems = (list, maxAge, certOf = ownCert) =>
  Array.isArray(list) ? list.filter((i) => allowed(i, maxAge, certOf)) : [];

// /api/home's shape: { hero: [items], rows: [{ id, title, items }] }. Rows
// left empty are dropped — an empty shelf is a hint that something was hidden.
const filterHome = (payload, maxAge, certOf = ownCert) => {
  if (!payload || typeof payload !== "object") return payload;
  return {
    ...payload,
    hero: filterItems(payload.hero, maxAge, certOf),
    rows: (Array.isArray(payload.rows) ? payload.rows : [])
      .map((r) => ({ ...r, items: filterItems(r && r.items, maxAge, certOf) }))
      .filter((r) => r.items.length > 0),
  };
};

// ---------- the device lock ----------
// Entering a kids profile in a browser sets this cookie; it rides every
// request that browser makes — the <video> and <img> ones too, which carry no
// profile of their own — and only the household PIN takes it off again.
// The value is "<profileId>.<set-at ms>". It is not signed on purpose: the
// only thing a forged one can do is restrict the forger.
const COOKIE = "aurora_kid";

// ...and the mark the PIN leaves behind when it lifts the lock (2026-10-08):
// "this browser LEFT that kids profile". Without it, a browser whose sign-in
// session is the kids profile's stayed a kids browser after the PIN — the
// grown-up's profile, entered next, was filtered and refused like the child's
// (the session still named the kids profile on every request, and <video>
// requests name nothing else). Same shape as the lock, same reasoning for
// leaving it unsigned: forging one frees nothing a private window doesn't.
// Entering the kids profile again takes it off.
const OUT_COOKIE = "aurora_kid_out";

const readMark = (req, name) => {
  const raw = req && req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== name) continue;
    let val = "";
    try { val = decodeURIComponent(v.join("=")); } catch { return null; }
    const m = /^([\w-]{1,40})\.(\d{1,15})$/.exec(val);
    return m ? { profile: m[1], at: Number(m[2]) } : null;
  }
  return null;
};

const readLock = (req) => readMark(req, COOKIE);
const readRelease = (req) => readMark(req, OUT_COOKIE);
const releaseCookie = (profileId, { secure = false, at = Date.now() } = {}) =>
  [
    `${OUT_COOKIE}=${encodeURIComponent(`${profileId}.${at}`)}`,
    "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${400 * 24 * 3600}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
const clearRelease = () => `${OUT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
const lockCookie = (profileId, { secure = false, at = Date.now() } = {}) =>
  [
    `${COOKIE}=${encodeURIComponent(`${profileId}.${at}`)}`,
    "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${400 * 24 * 3600}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// Is this request being made as a kids profile — and which one?
//   { profile, maxAge, source } or null.
//
// deps: closed() -> bool, session(req) -> { profileId, createdAt } | null,
//       tokenProfile(token) -> profileId | null, kidsOf(profileId) -> {maxAge} | null
//
//  - sign-in "closed": the session IS the person; nothing else is consulted
//    (a kids cookie left by whoever used the browser before must not follow
//    the next person who signs in).
//  - otherwise the device lock comes first. It is void once somebody has
//    signed in on this browser AFTER it was set, as a profile that is not a
//    kids one: that took a password a child doesn't have, and it is what
//    keeps a stale lock from trapping a grown-up.
//  - then whatever profile the request itself names: its session, its unlock
//    token, `profile=` in the query or body, /api/profiles/:id in the path.
//    A request that names no profile stays unfiltered, as before kids
//    profiles existed — that is every old caller.
const resolveKids = (req, deps) => {
  const kidsOf = (id) => {
    const k = id && typeof id === "string" ? deps.kidsOf(id) : null;
    return k && typeof k.maxAge === "number" ? k : null;
  };
  const sess = deps.session ? deps.session(req) : null;
  if (deps.closed && deps.closed()) {
    const k = sess && kidsOf(sess.profileId);
    return k ? { profile: sess.profileId, maxAge: k.maxAge, source: "session" } : null;
  }
  const lock = readLock(req);
  if (lock) {
    const k = kidsOf(lock.profile);
    const outranked = sess && !kidsOf(sess.profileId) && (sess.createdAt || 0) > lock.at;
    if (k && !outranked) return { profile: lock.profile, maxAge: k.maxAge, source: "lock" };
  }
  const named = [];
  // The session names its profile — unless the PIN took this browser out of
  // that very profile after the session began (see OUT_COOKIE). A sign-in
  // made after that counts again.
  const out = readRelease(req);
  const leftIt = sess && out && out.profile === sess.profileId && out.at >= (sess.createdAt || 0);
  if (sess && !leftIt) named.push(sess.profileId);
  const token = req.headers && req.headers["x-profile-token"];
  if (token && deps.tokenProfile) named.push(deps.tokenProfile(String(token)));
  if (req.query && typeof req.query.profile === "string") named.push(req.query.profile);
  if (req.body && typeof req.body === "object" && typeof req.body.profile === "string") named.push(req.body.profile);
  const inPath = /^\/api\/profiles\/([^/]+)/.exec(req.path || "");
  if (inPath) { try { named.push(decodeURIComponent(inPath[1])); } catch {} }
  let best = null;
  for (const id of named) {
    const k = kidsOf(id);
    // two kids profiles named at once: the stricter one decides
    if (k && (!best || k.maxAge < best.maxAge)) best = { profile: id, maxAge: k.maxAge, source: "request" };
  }
  return best;
};

// ---------- the gate ----------
// One middleware in front of every router that serves titles. For a request
// made as a kids profile it (a) filters each list on its way out and
// (b) refuses direct access to a title over the limit with 403.
//
// deps (all synchronous, all cache reads):
//   kidsFor(req)                 -> { profile, maxAge, source } | null
//   certOf(item)                 -> age label | null         (see makeCertOf)
//   findById(id)                 -> library item | null
//   streamItem(profileId, id)    -> the stored torrent play-item | null
//   certByTitle(type, title, yr) -> age label | null         (cached catalogue meta)
//   hashes                       -> Map infoHash -> { age, at }  (what may be streamed)
//   onUnknown(item)              -> optional; told about hidden unrated titles
const HASH_TTL = 24 * 3600 * 1000;
const HASH_MAX = 4000;

const createGate = (deps) => {
  const hashes = deps.hashes || new Map();
  const noteHash = (hash, age) => {
    if (typeof hash !== "string" || !/^[a-f0-9]{40}$/i.test(hash)) return;
    const key = hash.toLowerCase();
    const cur = hashes.get(key);
    // one torrent, one title: keep the stricter reading if two ever disagree
    hashes.set(key, { age: cur ? Math.max(cur.age, age) : age, at: Date.now() });
    if (hashes.size > HASH_MAX) {
      const now = Date.now();
      for (const [k, v] of hashes) if (now - v.at > HASH_TTL) hashes.delete(k);
      while (hashes.size > HASH_MAX) hashes.delete(hashes.keys().next().value);
    }
  };
  const hashOk = (hash, maxAge) => {
    const hit = hashes.get(String(hash || "").toLowerCase());
    return !!hit && Date.now() - hit.at < HASH_TTL && hit.age <= maxAge;
  };

  return (req, res, next) => {
    const p = req.path || "";
    const watched = p.startsWith("/api/") || p.startsWith("/stream/") || p.startsWith("/offline/") ||
      p.startsWith("/img/still/") || p.startsWith("/img/frame/"); // frames cut from the film itself
    // the admin panel, sign-in and the kids routes themselves are never gated
    if (!watched || /^\/api\/(admin|auth|kids)(\/|$)/.test(p)) return next();
    let kid = null;
    try { kid = deps.kidsFor(req); } catch { kid = null; }
    if (!kid) return next();
    req.kids = kid;
    const max = kid.maxAge;
    const method = String(req.method || "GET").toUpperCase();

    const deny = (error, extra = {}) => res.status(403).json({ error, kids: true, ...extra });
    const tooOld = () => deny("That one isn't available in a kids profile.");

    const ok = (item) => {
      const age = ageOf(deps.certOf(item));
      if (age == null) {
        if (deps.onUnknown) { try { deps.onUnknown(item); } catch {} }
        return false;
      }
      if (age > max) return false;
      // an allowed title that plays from a torrent: its stream may start
      if (item && typeof item === "object") {
        if (item.infoHash) noteHash(item.infoHash, age);
        if (typeof item.id === "string" && item.id.startsWith("torrent|")) noteHash(item.id.split("|")[1], age);
      }
      return true;
    };
    const keep = (list) => (Array.isArray(list) ? list.filter(ok) : list);

    // Filter the answer on its way out. Only 2xx object bodies; a filter that
    // throws fails CLOSED — better an error than an unfiltered list.
    const rewrite = (fn) => {
      const send = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 400 || !body || typeof body !== "object") return send(body);
        let out;
        try { out = fn(body); } catch {
          res.status(500);
          return send({ error: "Couldn't prepare that for a kids profile.", kids: true });
        }
        if (out && out.__deny) { res.status(403); return send({ error: out.__deny, kids: true }); }
        return send(out);
      };
      return next();
    };
    const fields = (...names) => rewrite((body) => {
      const out = { ...body };
      for (const n of names) if (n in out) out[n] = keep(out[n]);
      return out;
    });

    // ----- the profile's own routes -----
    const prof = /^\/api\/profiles\/([^/]+)(\/.*)?$/.exec(p);
    if (prof) {
      let id = prof[1];
      try { id = decodeURIComponent(id); } catch {}
      const rest = prof[2] || "";
      // This device is locked to a kids profile: every other profile's data
      // (and its unlock) is out of reach until the PIN lifts the lock.
      if (kid.source === "lock" && id !== kid.profile) {
        return deny("This device is in a kids profile — a grown-up's PIN switches it.", { kidsLocked: true });
      }
      if (id === kid.profile) {
        // What a child must not do to the profile: put a password on it (and
        // lock the family out), repoint its sign-in, or delete it. The admin's
        // People tab still does all three.
        if ((method === "DELETE" && rest === "") || (method === "POST" && /^\/(password|email)$/.test(rest))) {
          return deny("A kids profile can't change that — ask a grown-up.");
        }
        if (method === "GET" && rest === "/watchlist") return fields("items");
      }
      return next();
    }

    // ----- lists -----
    if (method === "GET") {
      if (p === "/api/home") {
        return rewrite((body) => {
          const out = { ...body, hero: keep(body.hero) || [] };
          out.rows = (Array.isArray(body.rows) ? body.rows : [])
            .map((r) => ({ ...r, items: keep(r.items) || [] }))
            .filter((r) => r.items.length > 0);
          return out;
        });
      }
      if (p === "/api/library") return fields("movies", "shows");
      if (p === "/api/library/for") return rewrite((b) => ({ ...b, item: b.item && ok(b.item) ? b.item : null }));
      if (p === "/api/popular" || p === "/api/catalog" || p.startsWith("/api/discover/similar/")) return fields("items");
      if (p === "/api/search") return fields("results", "catalog");
      if (p === "/api/search/suggest") return fields("suggestions");
      if (p === "/api/discover" || p === "/api/discover/search") return fields("movies", "shows");
      if (p.startsWith("/api/discover/collection/")) {
        // { collection, director, creator, network }: each a shelf with items
        return rewrite((body) => {
          const out = {};
          for (const [k, shelf] of Object.entries(body)) {
            if (shelf && typeof shelf === "object" && Array.isArray(shelf.items)) {
              const items = keep(shelf.items);
              out[k] = items.length ? { ...shelf, items } : null;
            } else out[k] = shelf;
          }
          return out;
        });
      }
      // The title page's own data: the rating arrives WITH the answer (and is
      // cached from then on), so the verdict is given on the way out.
      if (p.startsWith("/api/discover/meta/")) {
        return rewrite((body) => (ok(body) ? body : { __deny: "That one isn't available in a kids profile." }));
      }
      if (p === "/api/ai/status") return res.json({ enabled: false });
      // X-Ray is a title's cast and scene notes: asked by IMDb id (the site)
      // or by library id (the TV). It was left open — a kids profile could
      // read an 18+ film's by its id (found 2026-10-08).
      if (p === "/api/xray") {
        const q = req.query || {};
        if (q.itemId) {
          const item = deps.findById(String(q.itemId));
          return !item || ok(item) ? next() : tooOld();
        }
        return ok({ imdbId: q.imdbId }) ? next() : tooOld();
      }
      // The household's download list names every title being fetched, by
      // anyone. A kids profile sees the ones it may see.
      if (p === "/api/downloads") {
        return rewrite((body) =>
          Array.isArray(body) ? body.filter((j) => j && ok({ imdbId: j.imdbId, _isTorrent: true })) : body);
      }
    }
    if (p === "/api/ai/recommend") return deny("The recommender is switched off in kids profiles.");

    // ----- one title, asked for directly -----
    const itemM = /^\/api\/item\/(.+)$/.exec(p);
    if (itemM && method === "GET") {
      let id = itemM[1];
      try { id = decodeURIComponent(id); } catch {}
      if (id.startsWith("torrent|")) {
        if (hashOk(id.split("|")[1], max)) return next();
        const stored = deps.streamItem ? deps.streamItem(kid.profile, id) : null;
        // the id is passed along so an allowed one opens its stream
        return stored && ok({ ...stored, id }) ? next() : tooOld();
      }
      const item = deps.findById(id);
      return !item || ok(item) ? next() : tooOld(); // unknown id: the route's own 404
    }

    // ----- stream sources: asked by title, so answered from cached meta -----
    if (p === "/api/torrents/sources" && method === "GET") {
      const q = req.query || {};
      const age = ageOf(deps.certByTitle ? deps.certByTitle(String(q.type || "movie"), String(q.title || ""), parseInt(q.year, 10) || null) : null);
      if (age == null || age > max) return tooOld();
      return rewrite((body) => {
        for (const s of (body && body.streams) || []) if (s && s.infoHash) noteHash(s.infoHash, age);
        return body;
      });
    }
    // A torrent may only be touched once a title this profile may see has
    // listed it (the sources answer above, or an allowed Continue Watching card).
    if (p.startsWith("/stream/torrent/") || /^\/api\/torrents\/(probe|status|perf-mark)\//.test(p)) {
      const h = /(?:^|\/)([a-f0-9]{40})(?:\/|$)/i.exec(p);
      return h && hashOk(h[1], max) ? next() : tooOld();
    }
    const subsM = /^\/api\/torrents\/subtitles\/[^/]+\/([^/]+)$/.exec(p);
    if (subsM) return ok({ imdbId: subsM[1] }) ? next() : tooOld();

    // ----- library files: playing, transcoding, downloading, saving offline -----
    const fileM =
      // (embedded: a subtitle track read out of the film's own file — its dialogue)
      /^\/stream\/(?:video|download|hls|transcode|embedded)\/([^/]+)/.exec(p) ||
      /^\/offline\/file\/([^/]+)/.exec(p) ||
      /^\/img\/(?:still|frame)\/([^/]+)/.exec(p) ||
      /^\/api\/offline\/(?:options|prepare|status)\/([^/]+)/.exec(p);
    if (fileM) {
      let id = fileM[1];
      try { id = decodeURIComponent(id); } catch {}
      const item = deps.findById(id);
      return !item || ok(item) ? next() : tooOld();
    }

    // ----- asking the server to download a title -----
    if (p === "/api/downloads" && method === "POST") {
      const b = req.body || {};
      // judged by its IMDb id alone — a rating typed into the request proves nothing
      return ok({ imdbId: b.imdbId, _isTorrent: true }) ? next() : tooOld();
    }

    return next();
  };
};

module.exports = {
  AGES, ageOf, cleanKids, validPin, makeCertOf, allowed, filterItems, filterHome,
  COOKIE, readLock, lockCookie, clearCookie, resolveKids, createGate,
  OUT_COOKIE, readRelease, releaseCookie, clearRelease,
};
