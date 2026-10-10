// Shared plumbing for the time-to-first-frame harness (README.md beside this).
//
//   instance   a private Aurora (scripts/ui-test-server.js — YOUR working tree,
//              a throwaway data folder, no way out to the internet) whose
//              library is tools/ttff/.media
//   line       tools/throttle-proxy.js in front of it: one of CONDITIONS
//   browser    the Chrome (or Edge) on this machine, headless, through the proxy
//   capture    in the page: the click, every <video> event, every presented
//              frame; from the browser's network layer (CDP): every request
//              with start / first byte / end / bytes / connection / Server-Timing
"use strict";
const path = require("path");
const { chromium } = require("playwright-core");
const throttle = require("../throttle-proxy");
const media = require("./media");

// The lines. `latency` is each way (round trip = 2x). Every line has a real
// TCP connect (one round trip) and slow start.
const CONDITIONS = {
  "LL-HB": { down: 100000, up: 40000, latencyDown: 3, latencyUp: 2, what: "home LAN / good Wi-Fi: 100 Mbit/s, 5 ms" },
  "HL-HB": { down: 50000, up: 20000, latency: 90, what: "far server on fibre: 50 Mbit/s, 180 ms" },
  "HL-LB": { down: 3000, up: 1000, latency: 100, what: "far and thin: 3 Mbit/s, 200 ms" },
  "LL-LB": { down: 3000, up: 1000, latency: 5, what: "throttled Wi-Fi: 3 Mbit/s, 10 ms" },
  "ML-MB": { down: 8000, up: 3000, latency: 40, what: "an ordinary line to a server elsewhere: 8 Mbit/s, 80 ms" },
  "HL-1.5": { down: 1500, up: 750, latency: 100, what: "1.5 Mbit/s, 200 ms" },
  "LOSS-2": { down: 20000, up: 5000, latency: 30, pktloss: 2, what: "20 Mbit/s, 60 ms, 2% packet loss (≈1.7 Mbit/s per connection)" },
};
const rttOf = (c) => (c.latencyDown != null ? c.latencyDown + c.latencyUp : (c.latency || 0) * 2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the instance ----------
// `tree`: a snapshot made by snapshot.js — the app comes from there instead
// of the working tree.
const startInstance = async ({ verbose = false, config = {}, tree = null } = {}) => {
  media.build({ quiet: true });
  const server = require(tree ? path.join(require("./snapshot").treeDir(tree), "scripts", "ui-test-server.js") : "../../scripts/ui-test-server");
  const srv = await server.start({
    verbose,
    config: {
      libraries: { movies: [path.join(media.ROOT, "movies")], shows: [path.join(media.ROOT, "shows")] },
      ...config,
    },
  });
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(srv.url + url, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const admin = { "X-Admin-Password": srv.adminPassword };
  const api = {
    get: (url) => call("GET", url),
    createProfile: async (name) => {
      const password = "pass-" + name.toLowerCase();
      const { request } = await call("POST", "/api/profiles", { name, password, realName: `${name} Tester`, avatar: "🦊", color: "#2c9fe0" });
      const p = await call("POST", `/api/admin/profile-requests/${request.id}/approve`, {}, admin);
      const token = (await call("POST", `/api/profiles/${p.id}/unlock`, { password })).token;
      const h = token ? { "X-Profile-Token": token } : {};
      await call("PUT", `/api/profiles/${p.id}`, { lookNoticeSeen: true }, h);
      await call("POST", `/api/profiles/${p.id}/password`, { newPassword: "", currentPassword: password }, h);
      return { id: p.id, name };
    },
    setProgress: (profile, itemId, position, duration) => call("POST", `/api/profiles/${profile.id}/progress`, { itemId, position, duration }),
    clearProgress: (profile, itemId) => call("DELETE", `/api/profiles/${profile.id}/progress/${itemId}`),
  };
  // the library, by the short names of media.js
  const lib = await api.get("/api/library");
  const titles = {};
  for (const t of media.TITLES) {
    if (t.show) {
      const show = lib.shows.find((s) => s.title === t.show);
      if (!show) continue;
      const full = await api.get(`/api/item/${show.id}`);
      const ep = full.seasons[0].episodes.find((e) => e.episode === t.episode);
      if (ep) titles[t.key] = { key: t.key, id: ep.id, showId: show.id, duration: ep.duration, episode: t.episode, item: ep, why: t.why };
    } else {
      const name = t.title.replace(/ \(\d{4}\)$/, "");
      const m = lib.movies.find((x) => x.title === name);
      if (m) titles[t.key] = { key: t.key, id: m.id, duration: m.duration, item: m, why: t.why };
    }
  }
  return { srv, api, titles };
};

// ---------- the browser ----------
const launch = async ({ headed = false, noHevc = false } = {}) => {
  const channels = process.env.UI_BROWSER ? [process.env.UI_BROWSER] : ["chrome", "msedge"];
  const errors = [];
  for (const channel of channels) {
    try {
      return await chromium.launch({
        channel,
        headless: !headed,
        args: [
          "--autoplay-policy=no-user-gesture-required",
          // NOT --mute-audio: with it Chrome's media clock starts about a
          // second after the first frame (measured 2026-10-10: first frame at
          // 270 ms, the next at 1440), and hls.js answers the frozen clock
          // with a seek. Silence comes from muting the element (PAGE_PROBE).
          `--disable-features=Translate,MediaRouter${noHevc ? ",PlatformHEVCDecoderSupport" : ""}`,
          "--ignore-certificate-errors", // the local TLS front (h2-front.js) signs its own
          // Nothing leaves this machine: no name but this machine's resolves.
          // (Not Playwright's request routing — that switches the browser's
          // HTTP cache off, and a returning visitor has one.)
          "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
        ],
      });
    } catch (e) {
      errors.push(`${channel}: ${String(e.message).split("\n")[0]}`);
    }
  }
  throw new Error(`No installed browser could be launched (tried ${channels.join(", ")}).\n${errors.join("\n")}`);
};

// Runs in the page before any of its own code: notes every trusted click and
// everything every <video> does, on the wall clock (epoch ms).
const PAGE_PROBE = () => {
  if (window.__ttff) return;
  const now = () => performance.timeOrigin + performance.now();
  const T = (window.__ttff = { clicks: [], videos: [], nav: [] });
  for (const type of ["pointerdown", "click", "keydown"]) {
    addEventListener(type, (e) => { if (e.isTrusted) T.clicks.push({ t: now(), type }); }, true);
  }
  addEventListener("hashchange", () => T.nav.push({ t: now(), hash: location.hash }), true);
  const EVENTS = ["loadstart", "loadedmetadata", "loadeddata", "canplay", "canplaythrough", "play", "playing", "waiting", "stalled", "seeking", "seeked", "pause", "ended", "error", "emptied"];
  const watch = (v) => {
    v.muted = true; // silence without --mute-audio (see launch)
    const rec = { created: now(), events: [], frames: [], samples: [], el: v };
    T.videos.push(rec);
    const note = (ev) => rec.events.push({ ev, t: now(), ct: v.currentTime, rs: v.readyState });
    for (const ev of EVENTS) v.addEventListener(ev, () => note(ev));
    let moved = false;
    v.addEventListener("timeupdate", () => { if (!moved && v.currentTime > 0) { moved = true; note("timeupdate>0"); } });
    const onFrame = (n, meta) => {
      rec.frames.push({ t: performance.timeOrigin + n, mt: meta.mediaTime, w: meta.width, h: meta.height, seeking: v.seeking });
      if (rec.frames.length < 60) v.requestVideoFrameCallback(onFrame);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
    const iv = setInterval(() => {
      if (rec.samples.length >= 900) return clearInterval(iv);
      if (!v.currentSrc && !rec.samples.length) return; // not in use yet (or a probe element)
      let ahead = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime + 0.3 && v.buffered.end(i) > v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
      }
      rec.samples.push({ t: now(), ct: v.currentTime, p: v.paused ? 1 : 0, rs: v.readyState, ahead: +ahead.toFixed(2), h: v.videoHeight, b0: v.buffered.length ? +v.buffered.start(0).toFixed(3) : null });
    }, 100);
  };
  const create = Document.prototype.createElement;
  Document.prototype.createElement = function (name, ...rest) {
    const el = create.call(this, name, ...rest);
    try { if (String(name).toLowerCase() === "video") watch(el); } catch {}
    return el;
  };
  // hls.js, listened to: every error it reports (fatal or not), every level
  // it moves to, every load it gives up. And an experiment's knob:
  // localStorage["ttff-hls"] = JSON merged over the configuration the player
  // gives hls.js (run.js --set ttff-hls={...}), so a setting can be tried
  // before any code is written for it.
  T.hls = [];
  try {
    let over = null;
    try { over = JSON.parse(localStorage.getItem("ttff-hls") || "null"); } catch {}
    let wrapped;
    Object.defineProperty(window, "Hls", {
      configurable: true,
      get: () => wrapped,
      set: (v) => {
        wrapped = v && class extends v {
          constructor(cfg) {
            super(over ? { ...cfg, ...over } : cfg);
            const E = v.Events;
            const note = (what, extra) => { if (T.hls.length < 400) T.hls.push({ t: now(), what, ...extra }); };
            note("new", { progressive: !!this.config.progressive, est: this.config.abrEwmaDefaultEstimate });
            this.on(E.ERROR, (_e, d) => note("error", { details: d && d.details, fatal: !!(d && d.fatal), code: d && d.response && d.response.code, level: d && d.frag ? d.frag.level : undefined }));
            this.on(E.LEVEL_SWITCHING, (_e, d) => note("switching", { level: d.level, uri: String(d.uri || (d.url && d.url[0]) || "").split("?")[1] || "" }));
            if (E.FRAG_LOAD_EMERGENCY_ABORTED) this.on(E.FRAG_LOAD_EMERGENCY_ABORTED, (_e, d) => note("gave-up", { sn: d && d.frag && d.frag.sn, level: d && d.frag && d.frag.level }));
            if (E.BUFFER_FLUSHING) this.on(E.BUFFER_FLUSHING, (_e, d) => note("flush", { from: d && d.startOffset, to: d && d.endOffset }));
          }
        };
      },
    });
  } catch {}
  T.hlsSince = (since) => T.hls.filter((x) => x.t >= since - 5);
  T.dump = (since) =>
    T.videos
      .filter((r) => r.created >= since - 5 && r.events.length)
      .map((r) => ({ created: r.created, events: r.events, frames: r.frames, samples: r.samples, src: r.el.currentSrc, inPlayer: !!r.el.closest(".player"), duration: r.el.duration }));
};

// ---------- the network, as the browser's own network layer saw it ----------
const kindOf = (url, method) => {
  const p = url.replace(/^https?:\/\/[^/]+/, "");
  if (/^\/api\/play-mark\//.test(p)) return "mark";
  if (/^\/api\/usage|^\/api\/activity|^\/api\/netprobe/.test(p)) return "telemetry";
  if (/^\/api\/profiles\/[^/]+\/progress/.test(p) && method !== "GET") return "progress";
  if (/\.m3u8(\?|$)/.test(p)) return "playlist";
  if (/\/(seg\d+\.(ts|m4s)|init\.mp4)(\?|$)/.test(p)) return "segment";
  if (/^\/stream\/video\//.test(p) || /^\/offline\/file\//.test(p)) return "video";
  if (/^\/stream\/(subtitle|embedded)\//.test(p)) return "subtitle";
  if (/^\/img\//.test(p)) return "image";
  if (/\.js(\?|$)/.test(p)) return "script";
  if (/^\/api\//.test(p)) return "api";
  return "other";
};
const parseServerTiming = (h) => {
  const out = {};
  for (const part of String(h || "").split(",")) {
    const bits = part.trim().split(";");
    const name = bits.shift();
    if (!name) continue;
    for (const b of bits) { const [k, v] = b.split("="); if (k === "dur") out[name] = Number(v) || 0; if (k === "desc") out[`${name}:desc`] = String(v || "").replace(/"/g, ""); }
  }
  return out;
};
const initiatorOf = (init) => {
  const frames = [];
  for (let s = init && init.stack; s && frames.length < 4; s = s.parent) {
    for (const f of s.callFrames) if (frames.length < 4) frames.push(`${f.functionName || "?"}@${f.url.split("/").pop().split("?")[0]}:${f.lineNumber + 1}`);
  }
  return frames.length ? frames.join(" < ") : (init && init.type) || undefined;
};
const netlog = async (context, page) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  let reqs = new Map();
  let skew = null; // epoch ms − monotonic ms
  const at = (ts) => ts * 1000 + skew;
  cdp.on("Network.requestWillBeSent", (e) => {
    if (skew == null) skew = e.wallTime * 1000 - e.timestamp * 1000;
    if (e.redirectResponse) return;
    const h = e.request.headers || {};
    reqs.set(e.requestId, {
      url: e.request.url, path: e.request.url.replace(/^https?:\/\/[^/]+/, ""), method: e.request.method,
      kind: kindOf(e.request.url, e.request.method), range: h.Range || h.range || null,
      start: at(e.timestamp), ttfb: null, end: null, bytes: 0, chunks: [], status: null,
      body: e.request.method === "POST" && /play-mark/.test(e.request.url) ? e.request.postData || null : null,
      // who asked (for playlists: the player itself, or hls.js)
      by: /.m3u8/.test(e.request.url) ? initiatorOf(e.initiator) : undefined,
    });
  });
  cdp.on("Network.responseReceived", (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    const res = e.response;
    r.status = res.status;
    r.ttfb = at(e.timestamp);
    r.protocol = res.protocol;
    r.conn = res.connectionId;
    r.reused = res.connectionReused;
    r.fromCache = !!res.fromDiskCache || !!res.fromPrefetchCache;
    const hd = {};
    for (const [k, v] of Object.entries(res.headers || {})) hd[k.toLowerCase()] = v;
    r.server = parseServerTiming(hd["server-timing"]);
    r.contentRange = hd["content-range"] || null;
    r.length = Number(hd["content-length"]) || null;
    r.encoding = hd["content-encoding"] || null;
    if (res.timing) {
      // the browser's own split of the wait, ms from the request's start
      const t = res.timing;
      r.timing = { dns: t.dnsEnd > 0 ? t.dnsEnd - t.dnsStart : 0, connect: t.connectEnd > 0 ? t.connectEnd - t.connectStart : 0, ssl: t.sslEnd > 0 ? t.sslEnd - t.sslStart : 0, send: t.sendEnd, headers: t.receiveHeadersEnd };
    }
  });
  cdp.on("Network.dataReceived", (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    r.decoded = (r.decoded || 0) + (e.dataLength || 0);
    // bytes off the wire; a body read from the browser's cache moved none
    const n = r.fromCache ? 0 : e.encodedDataLength || 0;
    r.bytes += n;
    r.chunks.push([Math.round(at(e.timestamp)), n, e.dataLength || 0]);
  });
  cdp.on("Network.loadingFinished", (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    r.end = at(e.timestamp);
    if (!r.fromCache) {
      // Some responses report their size only here: spread it over the
      // chunks as they arrived (by decoded length), so "bytes by the first
      // frame" still adds up.
      const total = e.encodedDataLength || 0;
      if (total > r.bytes) {
        const dec = r.chunks.reduce((n, c) => n + c[2], 0);
        if (dec > 0) { let acc = 0; for (const c of r.chunks) { c[1] = Math.round((c[2] / dec) * total); acc += c[1]; } r.bytes = acc; }
        else { r.chunks.push([Math.round(r.end), total - r.bytes, 0]); r.bytes = total; }
      }
    }
  });
  cdp.on("Network.loadingFailed", (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    r.end = at(e.timestamp);
    r.failed = e.errorText || "failed";
  });
  return {
    reset: () => { reqs = new Map(); },
    all: () => [...reqs.values()].sort((a, b) => a.start - b.start),
  };
};

// ---------- one play, turned into numbers ----------
const median = (arr) => {
  const s = arr.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// requests + the page's record of the video → one result row
const digest = ({ t0, videos, requests, watchMs, expectFrom = 0 }) => {
  const v = videos.filter((x) => x.inPlayer || x.frames.length).sort((a, b) => b.events.length - a.events.length)[0] || videos[0] || null;
  const rel = (t) => (t == null ? null : Math.round(t - t0));
  const out = { t0, ok: false };
  if (!v) return { ...out, why: "no <video> was created" };
  const first = (name) => { const e = v.events.find((x) => x.ev === name && x.t >= t0); return e ? rel(e.t) : null; };
  out.mount = rel(v.created);
  out.loadedmetadata = first("loadedmetadata");
  out.canplay = first("canplay");
  out.playing = first("playing");
  out.timeupdate = first("timeupdate>0");
  // Sustained playback, read off the frames on screen: six in a row, each a
  // later moment of the film, inside 600 ms. (Not off currentTime: in a
  // muted headless browser that clock starts up to a second after the
  // picture is already moving.)
  const s = v.samples.filter((x) => x.t >= t0);
  const fr = v.frames.filter((f) => f.t >= t0);
  let playAt = null;
  for (let i = 0; i + 5 < fr.length; i++) {
    let run = true;
    for (let j = i; j < i + 5; j++) if (!(fr[j + 1].mt > fr[j].mt)) run = false;
    if (run && fr[i + 5].t - fr[i].t <= 600) { playAt = fr[i].t; break; }
  }
  out.ttplay = rel(playAt);
  // A freeze among the first frames (a seek the player made on itself, a
  // decoder starting over): the longest gap between two of the first 60.
  let gap = 0;
  for (let i = 1; i < fr.length; i++) gap = Math.max(gap, fr[i].t - fr[i - 1].t);
  out.startHitchMs = Math.round(gap);
  out.selfSeeks = v.events.filter((e) => e.ev === "seeking" && e.t >= t0 && out.firstFrame !== undefined).length;
  // The first frame of the film AS ASKED FOR. At a resume, a frame from the
  // top of the file (shown for an instant before the seek lands) is not it:
  // the first frame at the resume point is — or, on a stream whose clock
  // starts at zero wherever it begins, the frame playback started from.
  const frames = v.frames.filter((f) => f.t >= t0);
  const wanted = expectFrom > 30
    ? frames.find((f) => f.mt >= expectFrom - 30) || (playAt != null ? frames.find((f) => f.t >= playAt - 150) : null)
    : frames[0];
  out.firstFrame = wanted ? rel(wanted.t) : null;
  out.firstFrameAt = wanted ? +wanted.mt.toFixed(2) : null;
  out.frameSize = wanted ? `${wanted.w}x${wanted.h}` : null;
  out.ttff = out.firstFrame != null ? out.firstFrame : out.playing;
  out.ok = out.ttff != null;
  if (!out.ok) out.why = "no first frame in the time allowed";
  // Rebuffering after playback began, for as long as it was watched.
  if (playAt != null) {
    // (from the moment the element's own clock is running — see above)
    const run0 = s.findIndex((x, i) => x.t >= playAt && i > 0 && x.ct - s[i - 1].ct > 0.02);
    const after = run0 >= 0 ? s.slice(run0) : [];
    let stalled = 0;
    let stalls = 0;
    let inStall = false;
    for (let i = 1; i < after.length; i++) {
      const dt = after[i].t - after[i - 1].t;
      const frozen = !after[i].p && after[i].ct - after[i - 1].ct < 0.02;
      if (frozen) { stalled += dt; if (!inStall) { stalls++; inStall = true; } } else inStall = false;
    }
    const span = after.length ? after[after.length - 1].t - playAt : 0;
    out.watched = Math.round(span);
    // (a 100 ms sample can read "frozen" once between two frames: under 300 ms is not a stall)
    out.rebufferMs = stalled >= 300 ? Math.round(stalled) : 0;
    out.rebuffers = stalled >= 300 ? stalls : 0;
    out.endHeight = after.length ? after[after.length - 1].h : null;
    out.played = after.length ? +(after[after.length - 1].ct - after[0].ct).toFixed(1) : 0;
  }
  // ---- the requests ----
  const tFF = t0 + (out.ttff != null ? out.ttff : watchMs);
  const reqs = requests.filter((r) => r.start >= t0 - 30);
  const isMedia = (r) => r.kind === "segment" || r.kind === "video";
  const firstMedia = reqs.filter((r) => isMedia(r) && r.ttfb != null && r.status < 400).sort((a, b) => a.ttfb - b.ttfb)[0] || null;
  out.firstMediaByte = firstMedia ? rel(firstMedia.ttfb) : null;
  // The chain of requests the first media byte waited on: walk back from the
  // first media request to whatever had last finished when it was sent.
  const chain = [];
  if (firstMedia) {
    const causal = reqs.filter((r) => !["mark", "telemetry", "image", "progress"].includes(r.kind));
    let cur = firstMedia;
    chain.unshift(cur);
    for (let guard = 0; guard < 12; guard++) {
      const prev = causal
        .filter((r) => r !== cur && r.start < cur.start && (r.end || r.ttfb || Infinity) <= cur.start + 3 && !chain.includes(r))
        .sort((a, b) => (b.end || b.ttfb) - (a.end || a.ttfb))[0];
      if (!prev) break;
      chain.unshift(prev);
      cur = prev;
    }
  }
  out.chain = chain.map((r) => ({ kind: r.kind, path: r.path.slice(0, 80), start: rel(r.start), ttfb: rel(r.ttfb), end: rel(r.end), server: r.server && r.server.app != null ? Math.round(r.server.app) : null, newConn: r.reused === false }));
  out.roundTrips = chain.length;
  out.serverMs = Math.round(chain.reduce((n, r) => n + ((r.server && r.server.app) || 0), 0));
  out.newConns = reqs.filter((r) => r.reused === false && r.start <= tFF).length;
  // bytes that had arrived by the first frame
  let all = 0;
  let mediaBytes = 0;
  for (const r of reqs) {
    for (const [t, n] of r.chunks) {
      if (t > tFF) break;
      all += n;
      if (isMedia(r) || r.kind === "playlist") mediaBytes += n;
    }
  }
  out.bytesBeforeFF = all;
  out.mediaBytesBeforeFF = mediaBytes;
  out.requestsBeforeFF = reqs.filter((r) => r.start <= tFF).length;
  // which way it played
  const marks = reqs.filter((r) => r.kind === "mark" && r.body).map((r) => { try { return JSON.parse(r.body); } catch { return null; } }).filter(Boolean);
  out.marks = marks.map((m) => `${m.name}${m.path ? `:${m.path}` : ""}${m.why ? `:${m.why}` : ""}${m.levels ? `:${m.levels}` : ""}${m.to ? `:${m.to}` : ""}@${m.ms}`);
  const pathMark = marks.filter((m) => m.name === "path").pop();
  out.path = pathMark ? pathMark.path : null;
  out.appFirstFrame = (marks.find((m) => m.name === "first-frame") || {}).ms ?? null;
  const seg0 = reqs.find((r) => r.kind === "segment" && /seg\d+/.test(r.path));
  out.firstLevel = seg0 ? (/[?&]v=([^&]+)/.exec(seg0.path) || [])[1] || "copy" : null;
  out.firstSegBytes = seg0 ? seg0.bytes : null;
  out.firstSegServer = seg0 && seg0.server ? Math.round(seg0.server.seg || seg0.server.app || 0) : null;
  out.levels = [...new Set(reqs.filter((r) => r.kind === "segment").map((r) => (/[?&]v=([^&]+)/.exec(r.path) || [])[1] || "copy"))];
  // the waterfall, kept small: everything up to the first frame (+ a little)
  out.waterfall = reqs
    .filter((r) => r.start <= tFF + 300)
    .map((r) => ({
      kind: r.kind, method: r.method, path: r.path.length > 90 ? r.path.slice(0, 87) + "…" : r.path, range: r.range, status: r.status, length: r.length || undefined,
      start: rel(r.start), ttfb: rel(r.ttfb), end: rel(r.end), bytes: r.bytes,
      bytesByFF: r.chunks.reduce((n, [t, b]) => (t <= tFF ? n + b : n), 0),
      server: r.server && Object.keys(r.server).length ? r.server : undefined,
      by: r.by, conn: r.conn, newConn: r.reused === false, protocol: r.protocol, cache: r.fromCache || undefined,
      connectMs: r.timing && r.timing.connect > 0 ? Math.round(r.timing.connect) : undefined,
      sslMs: r.timing && r.timing.ssl > 0 ? Math.round(r.timing.ssl) : undefined,
    }));
  return out;
};

module.exports = { CONDITIONS, rttOf, sleep, startInstance, launch, PAGE_PROBE, netlog, digest, median, throttle, media, kindOf };
