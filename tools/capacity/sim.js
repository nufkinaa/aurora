// Simulated devices and the measuring around them (used by load.js, soak.js).
//
// A "device" does what the real clients do, at the real intervals — read off
// public/js and tv-native/src (REPORT.md §3 lists each one with its source
// line): a WebSocket that says hello and then mostly listens; a screen change
// every `thinkMs` while browsing (Home, a title page, a search, a few
// pictures); while playing, a progress POST and a WebSocket "activity" every
// 5 s and the media itself — byte ranges read at the film's bitrate for
// direct play, or HLS segments for the jit paths.
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { REPO, pct, round } = require("./lib");
const WebSocket = require(path.join(REPO, "node_modules", "ws"));

// ---------- http ----------
class Client {
  constructor(base, { sid = null, maxSockets = 6 } = {}) {
    this.base = new URL(base);
    this.sid = sid;
    this.agent = new http.Agent({ keepAlive: true, maxSockets });
  }
  // Resolves { status, bytes, ms, ttfbMs, headers }. Never rejects (status 0 = transport error).
  request(method, p, { body = null, headers = {}, onChunk = null, compressed = true, timeoutMs = 120000 } = {}) {
    return new Promise((resolve) => {
      const t0 = process.hrtime.bigint();
      const data = body == null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      const h = { ...(compressed ? { "Accept-Encoding": "gzip, deflate, br" } : {}), ...(this.sid ? { "X-Session": this.sid } : {}), ...headers };
      if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
      const req = http.request({ host: this.base.hostname, port: this.base.port, path: p, method, headers: h, agent: this.agent }, (res) => {
        const ttfbMs = Number(process.hrtime.bigint() - t0) / 1e6;
        let bytes = 0;
        res.on("data", (c) => { bytes += c.length; if (onChunk) onChunk(c, res); });
        res.on("end", () => resolve({ status: res.statusCode, bytes, ms: Number(process.hrtime.bigint() - t0) / 1e6, ttfbMs, headers: res.headers }));
        res.on("error", () => resolve({ status: 0, bytes, ms: Number(process.hrtime.bigint() - t0) / 1e6, ttfbMs }));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, bytes: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, error: e.code || e.message }));
      if (data) req.write(data);
      req.end();
    });
  }
  get(p, o) { return this.request("GET", p, o); }
  post(p, body, o) { return this.request("POST", p, { ...o, body }); }
  async json(p) {
    const chunks = [];
    const r = await this.request("GET", p, { compressed: false, onChunk: (c) => chunks.push(c) });
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
  }
  async text(p) {
    const chunks = [];
    const r = await this.request("GET", p, { compressed: false, onChunk: (c) => chunks.push(c) });
    return { status: r.status, text: Buffer.concat(chunks).toString("utf8"), ms: r.ms };
  }
  close() { this.agent.destroy(); }
}

// ---------- tallies ----------
class Stats {
  constructor() { this.by = new Map(); this.t0 = Date.now(); }
  add(name, r) {
    let s = this.by.get(name);
    if (!s) this.by.set(name, (s = { n: 0, err: 0, bytes: 0, ms: [], codes: {} }));
    s.n++;
    s.bytes += r.bytes || 0;
    s.codes[r.status] = (s.codes[r.status] || 0) + 1;
    if (!(r.status >= 200 && r.status < 400)) s.err++;
    if (s.ms.length < 200000) s.ms.push(r.ms);
  }
  row(name, secs) {
    const s = this.by.get(name);
    if (!s) return null;
    return { name, n: s.n, rps: round(s.n / secs, 1), err: s.err, p50: round(pct(s.ms, 50), 1), p95: round(pct(s.ms, 95), 1), p99: round(pct(s.ms, 99), 1), max: round(Math.max(...s.ms), 1), kbAvg: round(s.bytes / s.n / 1024, 1), codes: s.codes };
  }
  rows(secs = (Date.now() - this.t0) / 1000) { return [...this.by.keys()].map((k) => this.row(k, secs)); }
  total(secs = (Date.now() - this.t0) / 1000, filter = () => true) {
    let n = 0, err = 0; const ms = [];
    for (const [k, s] of this.by) { if (!filter(k)) continue; n += s.n; err += s.err; for (const v of s.ms) ms.push(v); }
    return { n, rps: round(n / secs, 1), err, p50: round(pct(ms, 50), 1), p95: round(pct(ms, 95), 1), p99: round(pct(ms, 99), 1), max: ms.length ? round(Math.max(...ms), 1) : null };
  }
}

// ---------- the server process, seen from outside ----------
// CPU seconds, resident memory, handles and threads of one pid, every
// `everyMs`. One long-lived helper process does the asking (PowerShell on
// Windows, /proc on Linux), so sampling costs the machine almost nothing.
const procSampler = (pid, everyMs = 2000) => {
  const samples = [];
  let child = null, timer = null;
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='SilentlyContinue'; while ($true) { $p = Get-Process -Id ${pid}; if (-not $p) { break }; $p.Refresh(); [Console]::Out.WriteLine(('{0},{1},{2},{3},{4}' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $p.TotalProcessorTime.TotalSeconds, $p.WorkingSet64, $p.HandleCount, $p.Threads.Count)); Start-Sleep -Milliseconds ${everyMs} }`;
    child = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const [t, cpu, rss, handles, threads] = buf.slice(0, i).trim().split(",").map(Number);
        buf = buf.slice(i + 1);
        if (Number.isFinite(cpu)) samples.push({ t, cpu, rss, handles, threads });
      }
    });
  } else {
    const fs = require("fs");
    const tick = () => {
      try {
        const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
        const fds = fs.readdirSync(`/proc/${pid}/fd`).length;
        samples.push({ t: Date.now(), cpu: (Number(st[11]) + Number(st[12])) / 100, rss: Number(st[21]) * 4096, handles: fds, threads: Number(st[17]) });
      } catch {}
    };
    tick();
    timer = setInterval(tick, everyMs);
  }
  return {
    samples,
    last: () => samples[samples.length - 1] || null,
    // CPU seconds used between two moments (ms since epoch), from the nearest samples
    cpuBetween: (a, b) => {
      const s0 = samples.filter((s) => s.t <= a).pop() || samples[0];
      const s1 = samples.filter((s) => s.t <= b).pop() || samples[samples.length - 1];
      return s0 && s1 ? { cpuSec: s1.cpu - s0.cpu, wallSec: (s1.t - s0.t) / 1000, rssMb: Math.round(s1.rss / 1048576), handles: s1.handles, threads: s1.threads } : null;
    },
    stop: () => { if (child) try { child.kill(); } catch {} if (timer) clearInterval(timer); },
  };
};

// The event loop, seen from outside: a tiny request (GET /healthz — no work
// in it) five times a second on its own connection. When the loop is busy
// with something else this is what waits; its latency IS the lag a user's
// request would meet (plus ~1 ms of loopback).
const lagProbe = (base, everyMs = 200) => {
  const c = new Client(base, { maxSockets: 1 });
  const ms = [];
  let stopped = false, busy = false;
  const timer = setInterval(async () => {
    if (busy || stopped) return;
    busy = true;
    const r = await c.get("/healthz", { compressed: false });
    busy = false;
    if (r.status === 200) ms.push(r.ms); else ms.push(r.ms + 1000);
  }, everyMs);
  return {
    ms,
    cut: () => { const a = ms.splice(0, ms.length); return { n: a.length, p50: round(pct(a, 50), 1), p95: round(pct(a, 95), 1), p99: round(pct(a, 99), 1), max: a.length ? round(Math.max(...a), 1) : null }; },
    stop: () => { stopped = true; clearInterval(timer); c.close(); },
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.7 + Math.random() * 0.6);

// ---------- one device ----------
// kind: "idle" | "browse" | "direct" | "remux" | "transcode"
class Device {
  constructor(srv, i, kind, stats, opts = {}) {
    this.srv = srv; this.i = i; this.kind = kind; this.stats = stats; this.opts = opts;
    const s = srv.sessions[i % srv.sessions.length];
    this.profile = s.profileId;
    this.c = new Client(srv.url, { sid: s.sid });
    this.stopped = false; this.ws = null; this.wsMsgs = 0; this.timers = [];
  }
  async hit(name, method, p, o) {
    const r = await this.c.request(method, p, o);
    this.stats.add(name, r);
    return r;
  }
  connectWs() {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.srv.url.replace("http", "ws") + "/", { headers: { "X-Session": this.c.sid } });
      this.ws = ws;
      ws.on("open", () => resolve(true));
      ws.on("error", () => resolve(false));
      ws.on("message", (raw) => {
        this.wsMsgs++;
        let m = null;
        try { m = JSON.parse(raw); } catch {}
        if (!m) return;
        if (m.type === "welcome") ws.send(JSON.stringify({ type: "hello", profile: `Viewer ${this.i}`, profileId: this.profile }));
        // what the web client does on library_updated (public/js/ws.js): refetch the library, its state, and Home
        if (m.type === "library_updated" && !this.stopped && this.opts.refetchOnUpdate !== false) this.refetch();
      });
    });
  }
  async refetch() {
    await Promise.all([
      this.hit("library", "GET", `/api/library?profile=${this.profile}`),
      this.hit("state", "GET", `/api/profiles/${this.profile}/state`),
      this.hit("home", "GET", `/api/home?profile=${this.profile}`),
    ]);
  }
  // a page load: what main.js / state.js fetch once
  async boot() {
    await this.hit("me", "GET", "/api/me");
    await Promise.all([
      this.hit("server-info", "GET", "/api/server-info"),
      this.hit("profiles", "GET", "/api/profiles"),
      this.hit("state", "GET", `/api/profiles/${this.profile}/state`),
      this.hit("library", "GET", `/api/library?profile=${this.profile}`),
      this.hit("downloads", "GET", "/api/downloads"),
    ]);
    await this.hit("home", "GET", `/api/home?profile=${this.profile}`);
  }
  async browseLoop() {
    const think = this.opts.thinkMs || 20000;
    const lib = this.srv.library;
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    await sleep(Math.random() * think);
    while (!this.stopped) {
      const roll = Math.random();
      if (roll < 0.35) {
        await this.hit("home", "GET", `/api/home?profile=${this.profile}`);
      } else if (roll < 0.7) {
        const m = pick(lib.movies);
        await this.hit("item", "GET", `/api/item/${m.id}`);
        if (m.cover) await this.hit("img", "GET", `${m.cover}${m.cover.includes("?") ? "&" : "?"}w=256`, { compressed: false });
      } else if (roll < 0.85) {
        const q = pick(["sil", "gold", "river", "emp", "cap", "mid", "chron"]);
        await this.hit("suggest", "GET", `/api/search/suggest?q=${q}`);
        await this.hit("search", "GET", `/api/search?q=${q}`);
      } else {
        await this.hit("library", "GET", `/api/library?profile=${this.profile}`);
        await this.hit("watchlist", "GET", `/api/profiles/${this.profile}/watchlist`);
      }
      // a few posters of the screen just opened (first views; repeats come from the browser's cache)
      const covers = Array.from({ length: 4 }, () => pick(lib.movies)).filter((m) => m.cover);
      await Promise.all(covers.map((m) => this.hit("img", "GET", `${m.cover}${m.cover.includes("?") ? "&" : "?"}w=256`, { compressed: false })));
      if (Math.random() < 0.5) this.hit("usage", "POST", "/api/usage", { body: { profile: this.profile, sid: `cap${this.i}`, device: "desktop", look: "glass", events: [{ n: "route", t: Date.now(), p: { r: "home", ms: 300 } }, { n: "nav", t: Date.now(), p: { to: "movies" } }] } });
      await sleep(jitter(think));
    }
  }
  // the 5-second heartbeat of any player: a progress save and a WebSocket "activity"
  playHeartbeat(item, getPos) {
    const id = item.id;
    const t = setInterval(() => {
      if (this.stopped) return;
      const pos = getPos();
      this.hit("progress", "POST", `/api/profiles/${this.profile}/progress`, { body: { itemId: id, position: pos, duration: 7200 } });
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: "activity", action: "Watching", details: item.title, position: pos, duration: 7200 }));
    }, 5000);
    this.timers.push(t);
  }
  // Direct play: the file read at the film's own bitrate, one long ranged GET
  // per pass with the socket paused whenever the reader is ahead of the clock
  // (which is what a media element with a full buffer does to the connection).
  async directLoop(item, mbit) {
    const url = item.url || item.videoUrl;
    const t0 = Date.now();
    this.playHeartbeat(item, () => Math.floor((Date.now() - t0) / 1000));
    const bytesPerSec = (mbit * 1e6) / 8;
    while (!this.stopped) {
      const start = Date.now();
      let got = 0;
      const r = await this.c.request("GET", url, {
        compressed: false, headers: { Range: "bytes=0-" },
        onChunk: (chunk, res) => {
          got += chunk.length;
          const ahead = got / bytesPerSec * 1000 - (Date.now() - start);
          if (this.stopped) { res.destroy(); return; }
          if (ahead > 250) { res.pause(); setTimeout(() => res.resume(), Math.min(ahead, 2000)); }
        },
      });
      this.stats.add("direct-range", { ...r, ms: r.ttfbMs || r.ms });
      if (r.status === 0) await sleep(1000);
    }
  }
  // jit HLS: the playlist once, then segments — as fast as they come until
  // 45 s is buffered (the web player's buffer goal), then one per segment time.
  async hlsLoop(item, v) {
    const base = `/stream/transcode/${this.srv.vid(item) || item.id}/jit`;
    const t0 = Date.now();
    this.playHeartbeat(item, () => Math.floor((Date.now() - t0) / 1000));
    while (!this.stopped) {
      const pl = await this.c.text(`${base}/index.m3u8${v && v !== "copy" ? `?v=${v}` : ""}`);
      this.stats.add("playlist", { status: pl.status, ms: pl.ms, bytes: pl.text.length });
      if (pl.status !== 200) { this.refused = (this.refused || 0) + 1; await sleep(5000); continue; }
      const lines = pl.text.split("\n");
      const segs = [];
      for (let k = 0; k < lines.length; k++) if (lines[k].startsWith("#EXTINF:")) segs.push({ dur: parseFloat(lines[k].slice(8)), uri: lines[k + 1].trim() });
      let buffered = 0;
      const startedAt = Date.now();
      let played = 0;
      for (const s of segs) {
        if (this.stopped) break;
        const r = await this.hit(`segment-${v || "copy"}`, "GET", `${base}/${s.uri}`, { compressed: false });
        if (r.status !== 200) { this.segFails = (this.segFails || 0) + 1; await sleep(2000); continue; }
        buffered += s.dur;
        played = (Date.now() - startedAt) / 1000;
        const ahead = buffered - played;
        if (ahead > 45) await sleep((ahead - 45) * 1000);
      }
      // let what is buffered play out before the title starts again
      const left = buffered - (Date.now() - startedAt) / 1000;
      if (left > 0 && !this.stopped) await sleep(Math.min(left, 60) * 1000);
    }
  }
  async run() {
    await this.connectWs();
    await this.boot();
    const T = this.srv.titles;
    if (this.kind === "browse") return this.browseLoop();
    if (this.kind === "direct") return this.directLoop(T.direct, this.opts.mbit || 8);
    if (this.kind === "remux") return this.hlsLoop(T.remux, "copy");
    if (this.kind === "transcode") return this.hlsLoop(T.hevc[this.i % (this.opts.titles || 1)], this.opts.v || "h264");
    // idle: the connection probe every 300 s is all a Home screen left open does
    while (!this.stopped) {
      await sleep(jitter(300000));
      if (!this.stopped) await this.hit("netprobe", "GET", "/api/netprobe?kb=48", { compressed: false });
    }
  }
  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    try { this.ws && this.ws.terminate(); } catch {}
    this.c.close();
  }
}

module.exports = { Client, Stats, Device, procSampler, lagProbe, sleep, jitter, WebSocket };
