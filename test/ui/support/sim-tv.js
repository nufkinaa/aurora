// A simulated Aurora TV: the TV app's side of the devices channel
// (src/lib/devices.js), in node, over a real WebSocket to a private instance.
// It announces itself the way tv-native/src/remote does, keeps a pretend
// player (a clock that runs while "playing", subtitle and audio tracks from
// the real /api/item answer, a next episode from the show's own list), reports
// its state — every second while a remote screen watches it — and answers
// every command. It reconnects by itself (a server restart), and records what
// it was told, for the tests to read.
//
//   const tv = new SimTV({ url: srv.url, profile, name: "Living room TV" });
//   await tv.start();          // resolves once the server said device_ok
//   tv.log                     // [{cmd, args, from, first, at}]
//   tv.now                     // what it is "playing" (null: Home)
//   await tv.stop();
"use strict";
const WebSocket = require("ws");
const crypto = require("crypto");

class SimTV {
  constructor({ url, profile, token = null, session = null, name = "Living room TV", deviceId = null, caps = null, ackDelayMs = 25, silent = false }) {
    this.url = url;
    this.profile = profile;
    this.token = token;
    this.session = session;
    this.name = name;
    this.deviceId = deviceId || `tv-sim-${crypto.randomBytes(5).toString("hex")}`;
    this.caps = caps || { navigate: true, volume: true, playItem: true, tracks: true };
    this.ackDelayMs = ackDelayMs;
    this.silent = silent; // never answers (the timeout test)
    this.log = [];
    this.keys = [];
    this.toasts = [];
    this.now = null; // {item, position, at, paused, sub, audio, subDelay}
    this.screen = "home";
    this.volume = { supported: true, level: 0.5, muted: false, scope: "system" };
    this.watched = false;
    this.announces = 0;
    this.connects = 0;
    this.ws = null;
    this.stopped = false;
    this.okWaiters = [];
    this.tick = null;
  }

  start() {
    this.stopped = false;
    this.open();
    return this.whenAnnounced();
  }
  whenAnnounced(after = this.announces) {
    return new Promise((resolve) => this.okWaiters.push({ after, resolve }));
  }

  open() {
    if (this.stopped) return;
    const headers = this.session ? { "X-Session": this.session } : {};
    const ws = new WebSocket(this.url.replace(/^http/, "ws"), { headers });
    this.ws = ws;
    ws.on("open", () => {
      this.connects++;
      this.send({ type: "hello", profile: this.profile.name, profileId: this.profile.id, app: "tv", build: "Aurora TV sim", model: "Sim TV" });
      this.announce();
    });
    ws.on("message", (raw) => {
      let m = null;
      try { m = JSON.parse(String(raw)); } catch { return; }
      this.onMessage(m);
    });
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      this.watched = false;
      if (!this.stopped) setTimeout(() => this.open(), 300 + Math.random() * 300);
    });
    ws.on("error", () => {});
  }

  send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(data)); return true; } catch { return false; }
  }

  announce() {
    this.send({ type: "device_announce", deviceId: this.deviceId, name: this.name, kind: "tv", form: "tv", model: "Sim TV", profileId: this.profile.id, token: this.token || undefined, caps: this.caps, state: this.state() });
  }

  position() {
    const n = this.now;
    if (!n) return 0;
    const p = n.paused ? n.position : n.position + (Date.now() - n.at) / 1000;
    return Math.min(n.item.duration || p, p);
  }
  setPosition(p) {
    if (!this.now) return;
    this.now.position = Math.max(0, Math.min(this.now.item.duration || p, p));
    this.now.at = Date.now();
  }

  state() {
    const n = this.now;
    return {
      screen: this.screen,
      appState: "active",
      now: n ? {
        id: n.item.id,
        title: n.item.showId ? n.item.title : n.item.title,
        showTitle: n.item.showTitle || null,
        epTitle: n.item.showId ? n.item.title : null,
        season: n.item.season != null ? n.item.season : null,
        episode: n.item.episode != null ? n.item.episode : null,
        poster: n.item.cover || null,
        backdrop: n.item.backdrop || null,
        duration: n.item.duration || 0,
        position: this.position(),
        paused: n.paused,
        buffering: false,
        canSeek: true,
        hasNext: !!n.next,
        nextLabel: n.next ? `S${n.next.season} E${n.next.episode}` : null,
        subs: (n.item.subtitles || []).map((t, i) => ({ id: `s${i}`, label: t.label || `Track ${i + 1}`, lang: t.lang || null })),
        sub: n.sub,
        audios: (n.item.audioTracks || []).map((t, i) => ({ id: String(t.index != null ? t.index : i), label: t.title || t.language || `Track ${i + 1}`, lang: t.language || null })),
        audio: n.audio,
        subDelay: n.subDelay,
      } : null,
      volume: { ...this.volume },
    };
  }
  report() { this.send({ type: "device_state", state: this.state() }); }
  schedule() {
    clearInterval(this.tick);
    this.tick = setInterval(() => this.report(), this.watched ? 1000 : 4000);
    if (this.tick.unref) this.tick.unref();
  }

  onMessage(m) {
    switch (m.type) {
      case "device_ok":
        this.announces++;
        this.schedule();
        for (const w of this.okWaiters.splice(0)) {
          if (this.announces > w.after) w.resolve(m);
          else this.okWaiters.push(w);
        }
        break;
      case "device_error":
        this.lastError = m.error;
        break;
      case "remote_watch":
        this.watched = !!m.on;
        this.schedule();
        if (this.watched) this.report();
        break;
      case "remote_command":
        this.log.push({ cmd: m.cmd, args: m.args, from: m.from, first: m.first, at: Date.now() });
        if (m.first) this.toasts.push(`Controlled from ${m.from && m.from.profileName ? `${m.from.profileName}'s ` : ""}${(m.from && m.from.label) || "a phone"}`);
        if (this.silent) return;
        this.handle(m).then((r) => setTimeout(() => {
          this.send({ type: "remote_ack", ref: m.ref, ...r });
          this.report();
        }, this.ackDelayMs));
        break;
    }
  }

  async get(path) {
    const headers = this.session ? { "X-Session": this.session } : {};
    const r = await fetch(`${this.url}${path}`, { headers });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  }

  async open_(id, { position = 0, subLang = null, audioLang = null } = {}) {
    const item = await this.get(`/api/item/${encodeURIComponent(id)}`);
    let next = null;
    if (item.showId) {
      try {
        const show = await this.get(`/api/item/${encodeURIComponent(item.showId)}`);
        const eps = (show.seasons || []).flatMap((s) => s.episodes || []);
        const i = eps.findIndex((e) => e.id === item.id);
        next = i >= 0 ? eps[i + 1] || null : null;
        item.showTitle = item.showTitle || show.title;
        item.cover = item.cover || show.cover;
      } catch {}
    }
    const subs = item.subtitles || [];
    const si = subLang && subLang !== "off" ? subs.findIndex((t) => String(t.lang || t.label || "").toLowerCase().startsWith(subLang)) : -1;
    const audios = item.audioTracks || [];
    const ai = audioLang ? audios.findIndex((t) => String(t.language || "").toLowerCase().startsWith(audioLang)) : -1;
    this.now = { item, next, position: position || 0, at: Date.now(), paused: false, sub: si >= 0 ? `s${si}` : null, audio: audios.length ? String(ai >= 0 ? (audios[ai].index != null ? audios[ai].index : ai) : (audios[0].index != null ? audios[0].index : 0)) : null, subDelay: 0 };
    this.screen = "player";
  }

  async handle(m) {
    const a = m.args || {};
    const nothing = { ok: false, error: "nothing-playing", message: "Nothing is playing on the TV" };
    switch (m.cmd) {
      case "play_item":
        try {
          await this.open_(a.item.id, a);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: "failed", message: `Couldn't open it on the TV (${e.message})` };
        }
      case "key":
        this.keys.push(a.key);
        if (a.key === "home") { this.now = null; this.screen = "home"; }
        return { ok: true };
      case "rename":
        this.name = a.name;
        this.announce();
        return { ok: true };
    }
    if (!this.now) return nothing;
    const n = this.now;
    switch (m.cmd) {
      case "toggle": this.setPosition(this.position()); n.paused = !n.paused; break;
      case "play": this.setPosition(this.position()); n.paused = false; break;
      case "pause": this.setPosition(this.position()); n.paused = true; break;
      case "seek": this.setPosition(a.to); break;
      case "skip": this.setPosition(this.position() + a.by); break;
      case "next":
        if (!n.next) return { ok: false, error: "no-next", message: "There is no next episode" };
        await this.open_(n.next.id, { subLang: null });
        break;
      case "sub": n.sub = a.id; break;
      case "audio": n.audio = a.id; break;
      case "sub_delay":
        if (!n.sub) return { ok: false, error: "no-subtitles", message: "Turn a subtitle track on first" };
        n.subDelay = a.value != null ? a.value : Math.round((n.subDelay + a.by) * 10) / 10;
        break;
      case "volume":
        this.volume.muted = false;
        this.volume.level = Math.max(0, Math.min(1, a.level != null ? a.level : Math.round((this.volume.level + a.step * 0.1) * 10) / 10));
        break;
      case "mute": this.volume.muted = !!a.on; break;
      case "stop": this.now = null; this.screen = "home"; break;
      default: return { ok: false, error: "bad-command" };
    }
    return { ok: true };
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.tick);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      await new Promise((r) => { ws.once("close", r); try { ws.close(); } catch { r(); } setTimeout(r, 500); });
    }
  }
  /** the socket drops (Wi-Fi off) without stopping: it reconnects */
  drop() { try { this.ws && this.ws.terminate(); } catch {} }
}

module.exports = { SimTV };
