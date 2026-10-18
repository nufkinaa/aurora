// Simulated devices: what the website (public/js) and the TV app
// (tv-native/src) really send, at their real cadences. The request shapes and
// timings are read off the client code (README "What a device does" lists
// each one with its source line).
//
// A household is one profile with a browser and a TV. Each device keeps its
// own keep-alive connections, its own WebSocket, its own session (the website
// by the aurora_session cookie, the TV by X-Session + X-Profile), and a
// picture cache (a picture is fetched once per device, as a browser's or the
// TV's image cache would).
"use strict";
const path = require("path");
const crypto = require("crypto");
const { Client } = require("./http");
const { PlayBuffer } = require("./buffer");
const { sleep, jitter } = require("./lib");

let WebSocket = null;
const ws = () => WebSocket || (WebSocket = require(require.resolve("ws", { paths: [path.join(__dirname, "..", "..")] })));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const enc = encodeURIComponent;
const TV_MODEL = "MiTV-MSSP2";

// ---------- pictures, as the clients rewrite them (web ui.js:160-203, TV api.ts:1168-1220) ----------
const EXT_HOSTS = /^https:\/\/(images\.metahub\.space|episodes\.metahub\.space|live\.metahub\.space|image\.tmdb\.org|static\.tvmaze\.com|upload\.wikimedia\.org)\//;
const artUrl = (u, w) => {
  if (!u || typeof u !== "string") return null;
  if (/^\/img\/(still|frame)\//.test(u)) return u;
  if (/^\/img\/poster\//.test(u)) return u;
  if (/^\/img\//.test(u)) return `${u}${u.includes("?") ? "&" : "?"}w=${w}`;
  if (EXT_HOSTS.test(u)) return `/img/ext?u=${enc(u)}&w=${w}`;
  return null; // other hosts: fetched from the internet by the device, not from Aurora
};
// the cards of an answer, in order: every object with a picture field
const cardsOf = (j, limit = 400) => {
  const out = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || out.length >= limit || depth > 6) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    if (o.poster || o.cover || o.backdrop) out.push(o);
    for (const k of Object.keys(o)) if (k !== "_blur" && typeof o[k] === "object") walk(o[k], depth + 1);
  };
  walk(j, 0);
  return out;
};

// ---------- the shared library view (filled once, before devices start) ----------
// ctx.lib = { movies, shows, items: Map(id -> /api/item), catalog: [{type, imdbId}], words: [] }
const classify = (it) => {
  // the website's startPlan (player.js:422-452) on Chrome/Windows: HEVC decodes, MKV with HEVC does not go as a file
  const v = (it.video && it.video.codec) || "";
  const audioOk = !it.audio || it.audio.compatible !== false;
  const hevcMkv = v === "hevc" && /mkv|matroska/i.test(it.container || "");
  const web = audioOk && !hevcMkv && /^(h264|hevc|vp9|av1)$/.test(v) ? "direct" : "jit";
  // the TV (Player.tsx:1453-1535): the file, unless its sound is not playable -> the offset job, v=copy
  const tv = audioOk && it.videoUrl ? "direct" : "offset";
  return { web, tv, kbps: it.sizeBytes && it.duration ? (it.sizeBytes * 8) / it.duration / 1000 : 0 };
};

class Device {
  // kind "web" | "tv"
  constructor(ctx, { profileId, sid, kind, i, name }) {
    this.ctx = ctx; this.profileId = profileId; this.sid = sid; this.kind = kind; this.i = i; this.name = name || `Load ${i + 1}`;
    const ua = kind === "tv" ? "okhttp/4.12.0 AuroraTV/5.3.0" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    const extra = kind === "tv" ? { "X-Session": sid, "X-Profile": profileId } : { Cookie: `aurora_session=${sid}` };
    this.c = new Client(ctx.url, { maxSockets: 6, ua, extra });
    this.viewerId = `${kind}${crypto.randomBytes(4).toString("hex")}${Date.now().toString(36)}`;
    this.stopped = false;
    this.seen = new Set(); // picture cache
    this.etags = new Map();
    this.timers = [];
    this.ws = null; this.wsReconnects = 0; this.wsMsgs = 0; this.wsOpen = false;
    this.playing = null;
    this.usage = [];
  }
  get stats() { return this.ctx.stats; }
  async hit(group, method, p, o = {}) {
    if (this.stopped) return { status: 0, ms: 0, bytes: 0 };
    const headers = { ...(method === "GET" ? { "X-Blur": "1" } : {}), ...(o.headers || {}) };
    const r = await this.c.request(method, p, { ...o, headers });
    // a catalogue picture the live server never fetched cannot be fetched by a private instance (no internet): the rig's, not the server's
    if (group === "image" && r.status >= 500 && p.startsWith("/img/ext")) group = "image-offline";
    // the same for answers that need the internet the instance does not have (catalogue, people, X-Ray, trailers)
    else if (r.status >= 502 && r.status <= 504 && /^\/api\/(discover|person|xray|trailer|imdb-for)/.test(p)) group = `${group}-offline`;
    if (!r.stopped) this.stats.add(group, r);
    if (r.status === 429 && method === "GET" && !o.noRetry && !this.stopped) {
      // the clients' manners (web api.js:171-177, TV serverManners.ts:27-48): wait Retry-After (+ up to 1.5 s), at most twice
      const n = (o._tries || 0) + 1;
      if (n <= 2) {
        const ra = Number(r.headers && r.headers["retry-after"]) || 2;
        await sleep(Math.min(5, Math.max(0.5, ra)) * 1000 + Math.random() * 1500);
        return this.hit(group, method, p, { ...o, _tries: n });
      }
    }
    return r;
  }
  async getJson(group, p, o = {}) {
    const r = await this.hit(group, "GET", p, { ...o, keepBody: true });
    let j = null;
    if (r.body && r.status === 200) {
      try {
        const enc0 = r.headers["content-encoding"];
        const zlib = require("zlib");
        const raw = enc0 === "br" ? zlib.brotliDecompressSync(r.body) : enc0 === "gzip" ? zlib.gunzipSync(r.body) : enc0 === "deflate" ? zlib.inflateSync(r.body) : r.body;
        j = JSON.parse(raw.toString("utf8"));
      } catch {}
    }
    return { ...r, json: j };
  }
  // pictures of a screen: the ones in view, fetched 6 at a time (a browser's connection limit)
  async pictures(cards, w, max = 18) {
    const urls = [];
    for (const c of cards.slice(0, max)) {
      const u = artUrl(c.poster || c.cover || c.backdrop, w);
      if (u && !this.seen.has(u)) { this.seen.add(u); urls.push(u); }
    }
    for (let k = 0; k < urls.length; k += 6) await Promise.all(urls.slice(k, k + 6).map((u) => this.hit("image", "GET", u, { compressed: false })));
  }
  note(n, p) { this.usage.push({ n, t: Date.now(), p }); }
  // usage batches: 20 s after the first event (usage.js:19-21, usage.ts:43)
  usageLoop() {
    const t = setInterval(() => {
      if (this.stopped || !this.usage.length) return;
      const events = this.usage.splice(0, 25);
      const body = this.kind === "tv"
        ? { profile: this.profileId, sid: this.viewerId, device: "tv", look: "tv", iid: this.viewerId, app: "tv", v: "5.3.0", model: TV_MODEL, events }
        : { profile: this.profileId, sid: this.viewerId, device: "desktop", look: "glass", net: { tier: "fast" }, events };
      this.hit("telemetry", "POST", "/api/usage", { body });
    }, jitter(20000, 0.1));
    this.timers.push(t);
  }

  // ---------- WebSocket (ws.js / realtime.ts): hello on welcome, no pings, reconnect with backoff ----------
  connectWs() {
    if (this.stopped) return;
    const W = ws();
    const headers = this.kind === "tv" ? { "X-Session": this.sid } : { Cookie: `aurora_session=${this.sid}` };
    const sock = new W(this.ctx.url.replace(/^http/, "ws") + "/", { headers, handshakeTimeout: 15000 });
    this.ws = sock;
    let opened = false;
    sock.on("open", () => { opened = true; this.wsOpen = true; this.backoff = 1000; });
    sock.on("message", (raw) => {
      this.wsMsgs++;
      let m = null;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "welcome") {
        sock.send(JSON.stringify(this.kind === "tv"
          ? { type: "hello", profile: this.name, profileId: this.profileId, app: "tv", build: "Aurora TV 5.3.0", model: TV_MODEL }
          : { type: "hello", profile: this.name, profileId: this.profileId }));
        if (this.playing) this.sendActivity();
      } else if (m.type === "library_updated") this.onLibraryUpdated();
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      this.wsOpen = false;
      if (this.stopped) return;
      if (opened) this.ctx.counters.wsDrops++;
      else this.ctx.counters.wsFails++;
      // 50-100 % of a backoff doubling from 1 s to 30 s (ws.js:132-137)
      this.backoff = Math.min(30000, (this.backoff || 1000) * (opened ? 1 : 2));
      this.wsReconnects++;
      setTimeout(() => this.connectWs(), this.backoff * (0.5 + Math.random() * 0.5));
    });
  }
  sendActivity() {
    const p = this.playing;
    if (!p || !this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ type: "activity", action: "Watching", details: p.title, position: Math.floor(p.buf.pos), duration: Math.floor(p.duration), streamDuration: Math.floor(p.duration), streamReady: true }));
  }
  async onLibraryUpdated() {
    this.ctx.counters.libraryUpdated++;
    if (this.playing && this.kind === "tv") return; // (the TV holds off while the player is open)
    await sleep(this.screen === "home" ? Math.random() * 300 : 500 + Math.random() * 4500);
    if (this.kind === "web") {
      await Promise.all([
        this.hit("library", "GET", `/api/library?profile=${this.profileId}`),
        this.hit("state", "GET", `/api/profiles/${this.profileId}/state`),
        this.screen === "home" ? this.hit("home", "GET", `/api/home?profile=${this.profileId}`) : null,
      ]);
    } else await this.tvHome();
  }

  // ---------- boot ----------
  async boot() {
    if (this.kind === "tv") return this.tvBoot();
    // index.html's early asks, then boot() (main.js:731-895) and the idle warm-up (prefetch.js:151-177)
    const early = { headers: { "X-Early": "1" } };
    await Promise.all([
      this.hit("boot", "GET", "/api/me", early), this.hit("boot", "GET", "/api/server-info", early),
      this.hit("boot", "GET", "/api/profiles", early), this.hit("state", "GET", `/api/profiles/${this.profileId}/state`, early),
      this.webHome(true),
    ]);
    this.connectWs();
    await Promise.all([
      this.hit("boot", "GET", `/api/downloads?profile=${this.profileId}`), this.hit("boot", "GET", "/api/changelog?head=1"), this.hit("boot", "GET", "/api/ai/status"),
    ]);
    this.usageLoop();
    this.netprobeLoop();
    await sleep(2500);
    for (const p of [`/api/profiles/${this.profileId}/watchlist`, `/api/library?profile=${this.profileId}`, "/api/catalog?type=movie&category=trending&page=0", "/api/catalog/genres?type=movie", "/api/catalog?type=show&category=trending&page=0", "/api/catalog/genres?type=show"]) {
      if (this.stopped) return;
      await this.hit(/library/.test(p) ? "library" : /catalog/.test(p) ? "grid" : "api-other", "GET", p);
      await sleep(500);
    }
  }
  netprobeLoop() {
    // first at 1.2 s, then every 5 min while visible and not in the player (net.js:44-45,196,293)
    const once = () => { if (!this.stopped && !this.playing) this.hit("netprobe", "GET", `/api/netprobe?kb=48&t=${Date.now()}`, { compressed: false }); };
    setTimeout(once, 1200);
    this.timers.push(setInterval(once, 300000));
  }
  async tvBoot() {
    // App.tsx:107-316, SessionWiring.tsx, prefetch.ts:33-65, Home.tsx:421-447
    await this.hit("boot", "GET", "/api/ping");
    await this.hit("boot", "GET", "/api/me");
    await this.hit("boot", "POST", "/api/auth/profile-token", { body: {} });
    this.connectWs();
    await this.hit("boot", "GET", "/api/profiles");
    await this.tvHome();
    await this.hit("api-other", "GET", "/api/party");
    setTimeout(() => this.hit("tv", "GET", `/tv-version.json?t=${Date.now()}`, { compressed: false }), 1500);
    this.timers.push(setInterval(() => { if (this.screen === "home") this.hit("tv", "GET", `/tv-version.json?t=${Date.now()}`, { compressed: false }); }, 30 * 60000));
    this.usageLoop();
    await sleep(2500);
    for (const p of ["/api/library", "/api/catalog?type=movie&category=trending&page=0", "/api/catalog?type=show&category=trending&page=0", "/api/catalog/genres?type=movie", "/api/catalog/genres?type=show", `/api/tv/tuning?model=${TV_MODEL}`]) {
      if (this.stopped) return;
      await this.hit(/library/.test(p) ? "library" : /catalog/.test(p) ? "grid" : "tv", "GET", p, /library/.test(p) ? this.cond(p) : {});
      await sleep(700 + Math.random() * 1500);
    }
    this.lastTuning = Date.now();
  }
  cond(p) { const e = this.etags.get(p); return e ? { headers: { "If-None-Match": e } } : {}; }

  // ---------- screens ----------
  async webHome(early = false) {
    this.screen = "home";
    const r = await this.getJson("home", `/api/home?profile=${this.profileId}`, early ? { headers: { "X-Early": "1" } } : {});
    if (r.json) {
      const cards = cardsOf(r.json);
      this.ctx.learn(cards);
      // hero backdrop (innerWidth x DPR, <= 1920), then the cards in view (w=360 at DPR 2)
      const hero = r.json.hero && r.json.hero[0];
      if (hero) await this.pictures([{ poster: hero.backdrop }], 1920, 1);
      await this.pictures(cards, 360, 16);
    }
    if (!early) { this.hit("api-other", "GET", `/api/profiles/${this.profileId}/wrapped`); this.hit("api-other", "GET", "/api/party"); }
    this.note("route", { r: "home", ms: Math.round(r.ms) });
    return r;
  }
  async tvHome() {
    this.screen = "home";
    const p = `/api/home?slim=1&profile=${this.profileId}`;
    const r = await this.getJson("home", p, this.cond(p));
    if (r.headers && r.headers.etag) this.etags.set(p, r.headers.etag);
    if (r.json) {
      const cards = cardsOf(r.json);
      this.ctx.learn(cards);
      const hero = r.json.hero && r.json.hero[0];
      if (hero) await this.pictures([{ poster: hero.backdrop }], 1280, 1);
      await this.pictures(cards, 256, 14);
    }
    this.note("route", { r: "home", ms: Math.round(r.ms) });
  }
  async grid() {
    this.screen = "grid";
    const type = pick(["movie", "show"]);
    const cat = pick(["trending", "trending", "new", "top"]);
    this.hit("library", "GET", this.kind === "web" ? `/api/library?profile=${this.profileId}` : "/api/library", this.kind === "tv" ? this.cond("/api/library") : {});
    this.hit("grid", "GET", `/api/catalog/genres?type=${type}`);
    for (let page = 0; page < 3; page++) {
      const r = await this.getJson("grid", `/api/catalog?type=${type}&category=${cat}&page=${page}`);
      if (r.json) await this.pictures(cardsOf(r.json), this.kind === "tv" ? 256 : 360, 24);
      if (Math.random() < 0.5 || this.stopped) break;
      await sleep(jitter(4000));
    }
    this.note("route", { r: type === "movie" ? "movies" : "shows" });
  }
  async title() {
    this.screen = "title";
    const lib = this.ctx.lib;
    const own = Math.random() < 0.6 && lib.movies.length;
    if (own) {
      const m = Math.random() < 0.75 ? pick(lib.movies) : pick(lib.shows.length ? lib.shows : lib.movies);
      const type = m.type === "show" ? "show" : "movie";
      const it = await this.getJson("title", `/api/item/${m.id}?profile=${this.profileId}`);
      const imdb = (it.json && it.json.imdbId) || m.imdbId;
      const calls = [this.hit("state", "GET", `/api/profiles/${this.profileId}/state`), this.hit("boot", "GET", "/api/server-info")];
      if (imdb) {
        calls.push(this.getJson("title", `/api/discover/meta/${this.kind === "tv" && type === "show" ? "series" : type}/${imdb}`).then((r) => { if (r.json) this.ctx.learnCast(r.json, imdb, type); }));
        calls.push(this.getJson("title", `/api/discover/similar/${type === "show" ? "series" : "movie"}/${imdb}?profile=${this.profileId}`).then((r) => r.json && this.pictures(cardsOf(r.json), this.kind === "tv" ? 256 : 360, 8)));
        if (this.kind === "web") calls.push(this.hit("title", "GET", `/api/discover/collection/${type === "show" ? "series" : "movie"}/${imdb}`));
        else calls.push(this.hit("title", "GET", `/api/trailer?imdbId=${imdb}&type=${type}`));
      }
      await Promise.all(calls);
      await this.pictures([{ poster: m.backdrop }, { poster: m.cover }], this.kind === "tv" ? 1280 : 1920, 2);
      // X-Ray: on hover / press, about one visit in five
      if (imdb && Math.random() < 0.2) await this.hit("title", "GET", `/api/xray?type=${type === "show" ? "series" : "movie"}&imdbId=${imdb}`);
      if (Math.random() < 0.3 && imdb) await this.person(imdb, type);
    } else {
      const c = pick(lib.catalog.length ? lib.catalog : [{ type: "movie", imdbId: "tt0111161" }]);
      const r = await this.getJson("title", `/api/discover/meta/${c.type === "show" ? "series" : "movie"}/${c.imdbId}`);
      if (r.json) this.ctx.learnCast(r.json, c.imdbId, c.type);
      await this.getJson("title", `/api/discover/similar/${c.type === "show" ? "series" : "movie"}/${c.imdbId}?profile=${this.profileId}`).then((s) => s.json && this.pictures(cardsOf(s.json), 360, 8));
      if (r.json) await this.pictures(cardsOf(r.json), 1280, 2);
    }
    this.note("route", { r: own ? "/movie/:id" : "/discover/:id" });
  }
  async person(imdb, type) {
    // personSheet.js:337 / PersonSheet.tsx:193 — 40 a minute per address on the server (api.js:418-428)
    const name = this.ctx.castFor(imdb) || pick(["Tom Hanks", "Emma Stone", "Ryan Gosling", "Cate Blanchett"]);
    const r = await this.getJson("person", `/api/person/${enc(`name:${name}`)}?of=${imdb}&type=${type === "show" ? "series" : "movie"}&profile=${this.profileId}`);
    if (r.json) await this.pictures(cardsOf(r.json), 240, 10);
  }
  async search() {
    this.screen = "search";
    this.hit("api-other", "GET", `/api/profiles/${this.profileId}/searches`);
    const word = this.ctx.searchWord();
    let pending = null, pendingSearch = null;
    // the website: suggest after 90 ms of quiet, results after 180 ms, a newer key aborts the older ask (suggest.js:99-121, search.js:360)
    // the TV: one 250 ms debounce, then suggest and search together (Search.tsx:164-210)
    for (let k = 1; k <= word.length; k++) {
      if (this.stopped) return;
      const q = enc(word.slice(0, k));
      const gap = this.kind === "tv" ? 300 + Math.random() * 500 : 110 + Math.random() * 200;
      await sleep(gap);
      if (q.length < 1) continue;
      if (pending) pending.abort();
      pending = new AbortController();
      const lim = this.kind === "tv" ? 6 : 8;
      if (this.kind === "web" || gap > 250) this.hit("suggest", "GET", `/api/search/suggest?v=2&q=${q}&limit=${lim}&profile=${this.profileId}`, { signal: pending.signal });
      if ((this.kind === "web" && gap > 180) || (this.kind === "tv" && gap > 250)) {
        if (pendingSearch) pendingSearch.abort();
        pendingSearch = new AbortController();
        this.hit("search", "GET", `/api/search?v=2&q=${q}&profile=${this.profileId}`, { signal: pendingSearch.signal });
      }
    }
    await sleep(this.kind === "tv" ? 250 : 180);
    const r = await this.getJson("search", `/api/search?v=2&q=${enc(word)}&profile=${this.profileId}&commit=1`);
    if (r.json && r.json.pending) {
      const first = (r.json.results || [])[0];
      await this.hit("search", "GET", `/api/search?v=2&q=${enc(word)}&profile=${this.profileId}&wait=1${first && first.key ? `&pin=${enc(first.key)}` : ""}`);
    }
    if (r.json) await this.pictures(cardsOf(r.json), this.kind === "tv" ? 256 : 360, 12);
    await sleep(1200);
    this.hit("api-other", "POST", `/api/profiles/${this.profileId}/searches`, { body: { q: word } });
    this.note("route", { r: "/search" });
  }
  async myList() {
    this.screen = "mylist";
    const r = await this.getJson("api-other", `/api/profiles/${this.profileId}/watchlist`);
    if (r.json) await this.pictures(cardsOf(r.json), 360, 12);
  }
  // one screen change of someone browsing
  async browseOnce() {
    const roll = Math.random();
    if (roll < 0.25) return this.kind === "tv" ? this.tvHome() : this.webHome();
    if (roll < 0.43) return this.grid();
    if (roll < 0.78) return this.title();
    if (roll < 0.93) return this.search();
    if (roll < 0.97) return this.title(); // (the person sheet rides on title pages)
    return this.myList();
  }
  async browseLoop(thinkMs) {
    while (!this.stopped) {
      await sleep(jitter(thinkMs, 0.5));
      if (this.stopped || this.playing) continue;
      try { await this.browseOnce(); } catch (e) { this.ctx.counters.deviceErrors++; }
      if (this.kind === "tv" && Date.now() - (this.lastTuning || 0) > 60000 && Math.random() < 0.3) { this.lastTuning = Date.now(); this.hit("tv", "GET", `/api/tv/tuning?model=${TV_MODEL}`); }
    }
  }

  // ---------- playing ----------
  // mode: "direct" | "jit" (web jit ladder, copy) | "offset" (TV, v=copy) | "transcode" (web jit, an encoded 720p rung)
  async play(item, mode, { minutes = Infinity, seekEveryMin = 12 } = {}) {
    const ctx = this.ctx;
    const duration = item.duration || 5400;
    const startAt = Math.random() < 0.4 ? Math.floor(Math.random() * duration * 0.6) : 0;
    const buf = new PlayBuffer({
      startSec: this.kind === "tv" ? 2 : 2.5, rebufferSec: this.kind === "tv" ? 8 : 5, durationSec: duration, startAt,
    });
    const p = { item, mode, title: item.title, duration, buf, bytes: 0, segs: 0, segFails: 0, refused: 0, t0: Date.now(), startAt };
    this.playing = p;
    ctx.viewers.add(p);
    p.device = `${this.kind}:${this.profileId}`;
    // play marks (player.js:751-763): mount, decision, path, first frame
    const mark = (name, ms) => this.hit("telemetry", "POST", `/api/play-mark/${item.id}`, { body: { name, ms, ...(this.kind === "tv" ? { app: "tv" } : {}) } });
    mark("mount", 0); mark("decision", 3);
    if (this.kind === "tv") {
      await Promise.all([this.hit("title", "GET", `/api/item/${item.id}?profile=${this.profileId}`), Date.now() - (this.lastTuning || 0) > 60000 ? this.hit("tv", "GET", `/api/tv/tuning?model=${TV_MODEL}`) : null]);
      this.lastTuning = Date.now();
    }
    // heartbeat: progress every 5 s while playing (web player.js:5885-5901, TV Player.tsx:2546-2555), WS activity every 5 s
    let lastSaved = -1e9;
    let firstFrameMarked = false;
    const hb = setInterval(() => {
      if (this.stopped) return;
      buf.tick();
      if (!firstFrameMarked && buf.ttffMs != null) { firstFrameMarked = true; mark("first-frame", buf.ttffMs); }
      this.sendActivity();
      const pos = Math.floor(buf.pos);
      if (buf.state === "playing" && (this.kind === "web" || Math.abs(pos - lastSaved) >= 4)) {
        lastSaved = pos;
        this.hit("progress", "POST", `/api/profiles/${this.profileId}/progress`, { body: { itemId: item.id, position: pos, duration: Math.floor(duration) } });
      }
    }, 5000);
    const tick = setInterval(() => buf.tick(), 100);
    this.timers.push(hb, tick);
    const until = Date.now() + minutes * 60000;
    const ac = { stop: false };
    p.stop = () => { ac.stop = true; };
    // seeks: now and then, a jump somewhere else in the film
    const seekTimer = setInterval(() => { if (!this.stopped && Math.random() < 0.5) p.seekTo = Math.max(0, Math.min(duration - 120, buf.pos + (Math.random() < 0.5 ? -1 : 1) * (60 + Math.random() * 1200))); }, jitter(seekEveryMin * 60000, 0.3));
    this.timers.push(seekTimer);
    try {
      if (mode === "direct") await this.directPlay(p, until, ac);
      else if (mode === "offset") await this.offsetPlay(p, until, ac);
      else await this.jitPlay(p, until, ac, mode === "transcode" ? "h264-720" : "copy");
    } catch (e) { ctx.counters.deviceErrors++; p.error = String(e && e.message || e); }
    clearInterval(hb); clearInterval(tick); clearInterval(seekTimer);
    // exit: one last save, "Browsing", the goodbye for streams (player.js:6188-6222)
    await this.hit("progress", "POST", `/api/profiles/${this.profileId}/progress`, { body: { itemId: item.id, position: Math.floor(buf.pos), duration: Math.floor(duration) } });
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: "activity", action: "Browsing", details: null }));
    if (mode !== "direct") await this.hit("stream-other", "POST", `/stream/transcode/${item.id}/jit/bye`, { headers: { "X-Aurora-Viewer": this.viewerId } });
    this.playing = null;
    p.endedAt = Date.now();
    p.report = buf.report();
    return p;
  }
  // The file by byte ranges. The reader stops taking bytes once it holds
  // `high` seconds ahead and starts again under `low` (Chrome's media cache /
  // ExoPlayer's LoadControl: TV 50-120 s, Player.tsx:205-208), which is TCP
  // backpressure on the server, exactly as a paused media element causes.
  async directPlay(p, until, ac) {
    const { item, buf } = p;
    const size = item.sizeBytes, dur = item.duration;
    const bps = size / dur;
    const [low, high] = this.kind === "tv" ? [50, 120] : [60, 120];
    let from = p.startAt;
    const mediaHeaders = this.kind === "tv" ? { "X-Aurora-Viewer": this.viewerId } : {};
    while (!this.stopped && !ac.stop && Date.now() < until && buf.state !== "ended") {
      const offset = Math.floor(from * bps);
      const t0 = Date.now();
      let first = true;
      const r = await this.c.request("GET", `/stream/video/${item.id}`, {
        compressed: false, timeoutMs: 0, headers: { Range: `bytes=${offset}-`, ...mediaHeaders },
        onChunk: (chunk, res) => {
          if (first) { first = false; this.stats.add("direct-first-byte", { status: res.statusCode, ms: Date.now() - t0, bytes: 0 }); }
          p.bytes += chunk.length;
          from += chunk.length / bps;
          buf.fed(from);
          if (this.stopped || ac.stop || Date.now() >= until) return false;
          if (p.seekTo != null) return false;
          if (buf.ahead() >= high && !res.isPaused()) {
            res.pause();
            const wake = setInterval(() => {
              if (this.stopped || ac.stop || p.seekTo != null || Date.now() >= until) { clearInterval(wake); res.destroy(); return; }
              if (buf.ahead() < low) { clearInterval(wake); res.resume(); }
            }, 250);
          }
          return true;
        },
      });
      this.stats.add("direct", { status: r.status === 0 && r.stopped ? 206 : r.status, ms: r.ttfbMs || r.ms, bytes: r.bytes });
      if (p.seekTo != null) { from = p.seekTo; buf.seek(from); p.seekTo = null; continue; }
      if (r.status === 0 && !r.stopped) { p.segFails++; await sleep(1000); }
      if (from >= dur - 0.5) break;
    }
  }
  // hls.js on the jit ladder: master, the rendition, segments one after
  // another while less than 45 s is buffered (player.js:1302 maxBufferLength 45)
  async jitPlay(p, until, ac, variant) {
    const { item, buf } = p;
    const base = `/stream/transcode/${item.id}/jit`;
    const t0 = Date.now();
    const m = await this.hit("playlist", "GET", `${base}/master.m3u8`, { keepBody: true, compressed: false, headers: { "X-Aurora-Start": `at=${p.startAt}` } });
    if (m.status !== 200) { p.refused++; return this.retryLater(p, until, ac, () => this.jitPlay(p, until, ac, variant)); }
    const lines = m.body.toString("utf8").split(/\r?\n/);
    const variants = lines.filter((l) => l && !l.startsWith("#"));
    const want = variants.find((v) => new RegExp(`[?&]v=${variant}(&|$)`).test(v)) || variants[0];
    if (!want) { p.refused++; return; }
    const rendUrl = want.startsWith("/") ? want : `${base}/${want}`;
    const rp = await this.hit("playlist", "GET", rendUrl, { keepBody: true, compressed: false });
    if (rp.status !== 200) { p.refused++; return this.retryLater(p, until, ac, () => this.jitPlay(p, until, ac, variant)); }
    const segs = parseMedia(rp.body.toString("utf8"), rendUrl);
    await this.playSegments(p, segs, until, ac, 45, t0, "segment");
  }
  // The TV's offset job (v=copy): a claim (&seek=1), then ExoPlayer on a
  // growing playlist and its segments; buffer 50-120 s; a seek outside what
  // has been made claims a new <ss>
  async offsetPlay(p, until, ac) {
    const { item, buf } = p;
    let ss = Math.floor(p.startAt);
    const t0 = Date.now();
    while (!this.stopped && !ac.stop && Date.now() < until && buf.state !== "ended") {
      const base = `/stream/transcode/${item.id}/${ss}`;
      const pl = `${base}/index.m3u8?v=copy`;
      let claim = null;
      for (let k = 0; k < 3; k++) {
        claim = await this.hit("playlist", "GET", `${pl}&seek=1`, { compressed: false, headers: { "X-Aurora-Viewer": this.viewerId } });
        if (claim.status === 200) break;
        await sleep(1500);
      }
      if (!claim || claim.status !== 200) { p.refused++; await sleep(5000); continue; }
      const r = await this.playLive(p, pl, ss, until, ac, t0);
      if (r === "seek") { ss = Math.floor(p.seekTo); buf.seek(ss); p.seekTo = null; continue; }
      break;
    }
  }
  async playLive(p, plUrl, ss, until, ac, t0) {
    const { buf } = p;
    const done = new Set();
    let pos = ss; // media time of the next segment
    let ended = false;
    let firstSeg = true;
    let lastPoll = 0;
    while (!this.stopped && !ac.stop && Date.now() < until && buf.state !== "ended") {
      if (p.seekTo != null) return "seek";
      if (!ended && Date.now() - lastPoll > 4000) {
        lastPoll = Date.now();
        const r = await this.hit("playlist", "GET", plUrl, { keepBody: true, compressed: false, headers: { "X-Aurora-Viewer": this.viewerId } });
        if (r.status === 200) {
          const text = r.body.toString("utf8");
          ended = /#EXT-X-ENDLIST/.test(text);
          p.list = parseMedia(text, plUrl);
        }
      }
      const next = (p.list || []).find((s) => !done.has(s.uri));
      if (!next) { await sleep(1000); continue; }
      if (buf.ahead() >= 120) { await sleep(500); continue; }
      const r = await this.hit("segment", "GET", next.uri, { compressed: false, headers: { "X-Aurora-Viewer": this.viewerId } });
      if (r.status !== 200) { p.segFails++; await sleep(1000); continue; }
      if (firstSeg) { firstSeg = false; this.stats.add("first-segment", { status: 200, ms: Date.now() - t0, bytes: 0 }); }
      done.add(next.uri);
      p.segs++; p.bytes += r.bytes;
      pos += next.dur;
      buf.fed(pos);
      if (buf.ahead() >= 120) while (buf.ahead() > 50 && !this.stopped && !ac.stop && p.seekTo == null && Date.now() < until) await sleep(500);
      if (ended && done.size >= p.list.length) break;
    }
    return "end";
  }
  async playSegments(p, segs, until, ac, goal, t0, group) {
    const { buf } = p;
    let k = Math.max(0, segs.findIndex((s) => s.start + s.dur > p.startAt));
    let firstSeg = true;
    while (!this.stopped && !ac.stop && Date.now() < until && k < segs.length && buf.state !== "ended") {
      if (p.seekTo != null) {
        const to = p.seekTo;
        p.seekTo = null;
        k = Math.max(0, segs.findIndex((s) => s.start + s.dur > to));
        buf.seek(segs[k] ? segs[k].start : to);
        continue;
      }
      if (buf.ahead() >= goal) { await sleep(250); continue; }
      const s = segs[k];
      const r = await this.hit(group, "GET", s.uri, { compressed: false });
      if (r.status !== 200) {
        p.segFails++;
        if (r.status === 503) p.refused++;
        await sleep(r.status === 503 ? 5000 : 1000);
        continue;
      }
      if (firstSeg) { firstSeg = false; this.stats.add("first-segment", { status: 200, ms: Date.now() - t0, bytes: 0 }); }
      p.segs++; p.bytes += r.bytes;
      buf.fed(s.start + s.dur);
      k++;
    }
  }
  async retryLater(p, until, ac, again) {
    await sleep(5000);
    if (this.stopped || ac.stop || Date.now() >= until) return;
    return again();
  }

  start({ boot = true, browse = null } = {}) {
    this.running = (async () => {
      if (boot) await this.boot().catch(() => { this.ctx.counters.deviceErrors++; });
      if (browse) await this.browseLoop(browse);
    })();
    return this.running;
  }
  stop() {
    this.stopped = true;
    if (this.playing && this.playing.stop) this.playing.stop();
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    try { this.ws && this.ws.terminate(); } catch {}
    this.c.close();
  }
}

// an HLS media playlist -> [{ uri (absolute path), dur, start }]
const parseMedia = (text, url) => {
  const dir = url.split("?")[0].replace(/\/[^/]*$/, "");
  const out = [];
  let t = 0, dur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#EXTINF:")) dur = parseFloat(line.slice(8));
    else if (line && !line.startsWith("#") && dur != null) {
      const uri = line.startsWith("/") ? line : `${dir}/${line}`;
      out.push({ uri, dur, start: t });
      t += dur; dur = null;
    }
  }
  return out;
};

module.exports = { Device, classify, artUrl, cardsOf, parseMedia };
