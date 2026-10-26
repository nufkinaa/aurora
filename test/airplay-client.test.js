// AirPlay in the web player (public/js/airplay.js), with WebKit's AirPlay API
// stubbed: no Apple device was in reach when this was written. Held here:
//   - which stream the RECEIVER is sent for each kind of title (the file, the
//     jit stream with Apple's fMP4, the full encode, the master that carries
//     subtitles, a torrent's), and the titles that cannot be sent;
//   - the button: offered only when Safari says a TV is in reach, the
//     picker opened from the press, a word instead of the picker when the
//     title can't go;
//   - the switch: when the element starts playing to the TV, hls.js's
//     MediaSource is taken off and the element plays the signed link at the
//     same spot; when AirPlay ends, the local stream is put back where the TV
//     reached; Safari's own switch to our alternative <source> is kept;
//   - the AirPlay alternative <source> beside hls.js's MediaSource;
//   - an error on the TV: a fresh link once, then a message.
const test = require("node:test");
const assert = require("node:assert");

const load = () => import("../public/js/airplay.js");

const film = (o = {}) => ({ id: "0123456789ab", container: "mp4", video: { codec: "h264", bitDepth: 8 }, audio: { codec: "aac" }, subtitles: [], ...o });
const SUB = (n) => ({ label: `Sub ${n}`, url: `/stream/subtitle/s${n}` });

test("receiverSource: the file itself when the TV plays it as it is", async () => {
  const { receiverSource } = await load();
  assert.deepEqual(receiverSource(film()), { path: "/stream/video/0123456789ab", type: "video/mp4", kind: "direct" });
  assert.equal(receiverSource(film({ container: "mov" })).kind, "direct");
  assert.equal(receiverSource(film({ video: { codec: "hevc" } })).kind, "direct", "HEVC in MP4: an Apple TV 4K plays it");
  assert.equal(receiverSource(film({ audio: { codec: "eac3" } })).kind, "direct", "Dolby audio: the TV passes it on");
  // a subtitle listed but off: still the file
  assert.equal(receiverSource(film({ subtitles: [SUB(0)] }), { subIdx: -1 }).kind, "direct");
});

test("receiverSource: the jit stream in Apple's fMP4 — HEVC tagged hvc1, another audio track, the full encode for codecs the TV can't decode", async () => {
  const { receiverSource } = await load();
  const mkv = (o) => film({ container: "mkv", ...o });
  assert.equal(receiverSource(mkv()).path, "/stream/transcode/0123456789ab/jit/index.m3u8?seg=fmp4");
  assert.equal(receiverSource(mkv({ video: { codec: "hevc" } })).path, "/stream/transcode/0123456789ab/jit/index.m3u8?seg=fmp4&vtag=hvc1");
  assert.equal(receiverSource(mkv(), { audioIdx: 2 }).path, "/stream/transcode/0123456789ab/jit/index.m3u8?seg=fmp4&a=2");
  assert.equal(receiverSource(film(), { audioIdx: 1 }).path, "/stream/transcode/0123456789ab/jit/index.m3u8?seg=fmp4&a=1", "an MP4 on its second track");
  for (const v of [{ codec: "av1" }, { codec: "vp9" }, { codec: "h264", bitDepth: 10 }, { codec: "mpeg2video" }]) {
    assert.equal(receiverSource(mkv({ video: v })).path, "/stream/transcode/0123456789ab/jit/index.m3u8?v=h264&seg=fmp4", JSON.stringify(v));
  }
  assert.equal(receiverSource(film({ audio: { codec: "dts" } })).kind, "hls", "DTS: re-made as AAC");
  const s = receiverSource(mkv());
  assert.equal(s.type, "application/x-mpegURL");
});

test("receiverSource: subtitles go as a master playlist the TV's own menu offers — the one on here first", async () => {
  const { receiverSource } = await load();
  const withSubs = film({ subtitles: [SUB(0), SUB(1), { label: "Online", url: "/stream/websub?u=x" }] });
  assert.equal(receiverSource(withSubs, { subIdx: 1 }).path, "/stream/airplay/0123456789ab/master.m3u8?seg=fmp4&sub=1");
  // an online subtitle on here is not one the server can send: the file, no default
  assert.equal(receiverSource(withSubs, { subIdx: 2 }).kind, "direct");
  // none on here: the plain stream — the master only ever goes to a TV for
  // the subtitle that is on (2026-10-26)
  assert.equal(receiverSource(film({ container: "mkv", subtitles: [SUB(0)] })).path, "/stream/transcode/0123456789ab/jit/index.m3u8?seg=fmp4");
  assert.equal(receiverSource(film({ container: "mkv", subtitles: [SUB(0)] }), { subIdx: 0 }).path, "/stream/airplay/0123456789ab/master.m3u8?seg=fmp4&sub=0");
  const embedded = film({ container: "mkv", subtitles: [{ label: "English", url: "/stream/embedded/0123456789ab/0", embedded: true }] });
  assert.equal(receiverSource(embedded, { subIdx: 0 }).path, "/stream/airplay/0123456789ab/master.m3u8?seg=fmp4&sub=0");
});

test("receiverSource: torrents, and what cannot be sent at all", async () => {
  const { receiverSource, MESSAGES } = await load();
  const h = "a".repeat(40);
  const tor = (o) => ({ id: `torrent|${h}|3`, _isTorrent: true, ...o });
  assert.equal(receiverSource(tor({ container: "mp4", video: { codec: "h264" }, audio: { codec: "aac" } })).path, `/stream/torrent/${h}/3`);
  assert.equal(receiverSource(tor({ container: "mkv", video: { codec: "hevc" } })).path, `/stream/torrent/hls/${h}/3/jit/index.m3u8?seg=fmp4&vtag=hvc1`);
  assert.equal(receiverSource(tor({ container: "mkv", video: { codec: "av1" } })).path, `/stream/torrent/hls/${h}/3/jit/index.m3u8?v=h264&seg=fmp4`);
  assert.equal(receiverSource(tor({ container: "avi", video: { codec: "mpeg4" } })).error, "format");
  assert.equal(receiverSource(tor({})).error, "format", "nothing known about the file yet");
  assert.deepEqual(receiverSource(film({ _offline: true })), { error: "offline", message: MESSAGES.offline });
  assert.equal(receiverSource(film({ container: "avi" })).error, "format");
  assert.equal(receiverSource(film({ id: "../x" })).error, "none");
  assert.equal(receiverSource(null).error, "none");
});

test("localOrigin: a page on this machine's own name is one the TV can't reach", async () => {
  const { localOrigin } = await load();
  for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "0.0.0.0", "aurora.localhost"]) assert.equal(localOrigin(h), true, h);
  for (const h of ["192.168.1.20", "nufurora.com", "10.0.0.5", "mybox.local"]) assert.equal(localOrigin(h), false, h);
});

// ---------- a <video> with WebKit's AirPlay API, stubbed ----------
class FakeSource extends EventTarget {
  constructor(doc) { super(); this.ownerDocument = doc; this.attrs = {}; this.parentNode = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  get src() { return this.attrs.src || ""; }
  set src(v) { this.attrs.src = v; }
  get isConnected() { return !!this.parentNode; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}
const fakeVideo = () => {
  const doc = { createElement: () => new FakeSource(doc) };
  const v = new EventTarget();
  Object.assign(v, {
    ownerDocument: doc,
    children: [],
    paused: false,
    currentTime: 0,
    disableRemotePlayback: false,
    webkitCurrentPlaybackTargetIsWireless: false,
    pickerOpened: 0,
    _src: "",
    webkitShowPlaybackTargetPicker() { this.pickerOpened++; },
    play() { this.paused = false; return Promise.resolve(); },
    removeAttribute(k) { if (k === "src") this._src = ""; },
    getAttribute(k) { return k === "src" ? this._src || null : null; },
    appendChild(c) { c.parentNode = v; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
    querySelector(sel) { return sel === "source" ? this.children[0] || null : null; },
    querySelectorAll(sel) { return sel === "source" ? [...this.children] : []; },
  });
  Object.defineProperty(v, "src", { get() { return this._src; }, set(x) { this._src = x; this.loads = (this.loads || 0) + 1; } });
  Object.defineProperty(v, "currentSrc", { get() { return this._forcedCurrent || this._src || (this.children[0] ? this.children[0].src : ""); } });
  return v;
};
const fire = (v, type, extra = {}) => v.dispatchEvent(Object.assign(new Event(type), extra));
const tick = () => new Promise((r) => setTimeout(r, 0));
const env = () => ({ win: { location: { origin: "https://tv.example", hostname: "tv.example" }, localStorage: { getItem: () => null } } });

const harness = async ({ item = film({ container: "mkv" }), needed = true, linkFails = null, envOverride = null, sub = () => -1 } = {}) => {
  const { createAirplay } = await load();
  const video = fakeVideo();
  const log = [];
  const asked = [];
  let n = 0;
  const air = createAirplay({
    video,
    item,
    link: async (path) => {
      asked.push(path);
      if (linkFails) { const e = new Error("no"); e.status = linkFails; throw e; }
      return { url: `/air/tok${++n}${path}`, expiresAt: Date.now() + 3600e3, needed };
    },
    hooks: {
      pos: () => video.currentTime,
      subIdx: sub,
      leave: () => { log.push("leave"); const s = { was: video.hlsOn ? "hls" : "file" }; video.hlsOn = false; return s; },
      back: (snap, pos, playing) => log.push(["back", snap, Math.round(pos), playing]),
      toast: (t, icon, action) => log.push(["toast", t, action || null]),
      retarget: (u) => { log.push(["retarget", u]); video.src = u; return true; },
      track: (f) => log.push(["track", f]),
      onAvailable: (on) => log.push(["available", on]),
      onActive: (on) => log.push(["active", on]),
    },
    env: envOverride || env(),
  });
  // hls.js on the element, the way it attaches a ManagedMediaSource
  const attachHls = () => {
    const s = video.ownerDocument.createElement("source");
    s.setAttribute("type", "video/mp4");
    s.setAttribute("src", "blob:https://tv.example/mms-1");
    video.appendChild(s);
    video.disableRemotePlayback = true;
    video.hlsOn = true;
  };
  return { air, video, log, asked, attachHls };
};

test("the button: offered only once Safari says a TV is in reach; the press opens Safari's picker", async () => {
  const { air, video, log } = await harness();
  assert.equal(air.supported, true);
  assert.equal(air.available, false);
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  assert.deepEqual(log.find((l) => l[0] === "available"), ["available", true]);
  await tick();
  assert.equal(air.pick(), true);
  assert.equal(video.pickerOpened, 1);
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "not-available" });
  assert.deepEqual(log.filter((l) => l[0] === "available").pop(), ["available", false]);
  air.destroy();
});

test("the button on a title that can't be sent: a word on why, and no picker", async () => {
  const { air, video, log } = await harness({ item: film({ _offline: true }) });
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick();
  assert.equal(air.pick(), false);
  assert.equal(video.pickerOpened, 0);
  assert.match(log.find((l) => l[0] === "toast")[1], /saved on this device/);
  air.destroy();
});

test("a page opened as localhost: the TV could never reach it — said, not tried", async () => {
  const { air, video, log } = await harness({ envOverride: { win: { location: { origin: "http://localhost:4000", hostname: "localhost" }, localStorage: { getItem: () => null } } } });
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick();
  assert.equal(air.pick(), false);
  assert.match(log.find((l) => l[0] === "toast")[1], /localhost/);
  air.destroy();
});

test("…unless the server names its home-network address: the TV is given that one", async () => {
  const { createAirplay } = await load();
  const video = fakeVideo();
  const air = createAirplay({
    video, item: film({ container: "mkv" }),
    link: async (p) => ({ url: `/air/t1${p}`, needed: true, origin: "http://192.168.1.20:4000" }),
    hooks: { leave: () => ({}), back: () => {} },
    env: { win: { location: { origin: "http://localhost:4000", hostname: "localhost" }, localStorage: { getItem: () => null } } },
  });
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick();
  assert.equal(air.pick(), true);
  video.webkitCurrentPlaybackTargetIsWireless = true;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  await tick(); await tick();
  assert.equal(video.src, "http://192.168.1.20:4000/air/t1/stream/transcode/0123456789ab/jit/index.m3u8?seg=fmp4");
  air.destroy();
});

test("the alternative <source>: beside hls.js's MediaSource, the signed link — and remote playback allowed again", async () => {
  const { air, video, attachHls, asked } = await harness();
  attachHls();
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick();
  assert.deepEqual(asked, ["/stream/transcode/0123456789ab/jit/index.m3u8?seg=fmp4"]);
  assert.equal(video.children.length, 2, "hls.js's source, then ours");
  const alt = video.children[1];
  assert.equal(alt.getAttribute("src"), "https://tv.example/air/tok1/stream/transcode/0123456789ab/jit/index.m3u8?seg=fmp4");
  assert.equal(alt.getAttribute("type"), "application/x-mpegURL");
  assert.equal(video.disableRemotePlayback, false);
  // hls.js re-attaches (a recovery): it put back only its own; ours follows
  for (const c of [...video.children]) video.removeChild(c);
  attachHls();
  air.attached();
  await tick(); await tick();
  assert.equal(video.children.length, 2);
  assert.equal(video.disableRemotePlayback, false);
  air.destroy();
});

test("the alternative <source> can be switched off (localStorage aurora-airplay-alt = 0)", async () => {
  const off = { win: { location: { origin: "https://tv.example", hostname: "tv.example" }, localStorage: { getItem: (k) => (k === "aurora-airplay-alt" ? "0" : null) } } };
  const { air, video, attachHls } = await harness({ envOverride: off });
  attachHls();
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick();
  assert.equal(video.children.length, 1);
  assert.equal(video.disableRemotePlayback, true, "left as hls.js set it");
  air.destroy();
});

test("AirPlay starts: hls.js comes off, the element plays the signed link at the same spot; AirPlay ends: the local stream comes back where the TV got to", async () => {
  const { air, video, log, attachHls } = await harness();
  attachHls();
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick();
  video.currentTime = 1234.5;
  fire(video, "timeupdate");
  video.webkitCurrentPlaybackTargetIsWireless = true;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  await tick(); await tick();
  assert.ok(air.active());
  assert.ok(log.includes("leave"));
  assert.equal(video.children.length, 0, "hls.js's MediaSource source and ours are both gone");
  assert.equal(video.src, "https://tv.example/air/tok1/stream/transcode/0123456789ab/jit/index.m3u8?seg=fmp4");
  // the new resource's timeline arrives: back to the same spot, playing
  video.currentTime = 0;
  fire(video, "loadedmetadata");
  assert.equal(video.currentTime, 1234.5);
  assert.ok(log.some((l) => l[0] === "track" && l[1] === "airplay_on"));
  // the TV plays on; then AirPlay ends
  video.currentTime = 1500;
  video.webkitCurrentPlaybackTargetIsWireless = false;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  assert.equal(air.active(), false);
  const back = log.find((l) => l[0] === "back");
  assert.deepEqual(back, ["back", { was: "hls" }, 1500, true]);
  assert.equal(video.src, "", "the TV's address is taken off before the local stream returns");
  air.destroy();
});

test("Safari already moved to our alternative <source>: it keeps playing — only hls.js comes off", async () => {
  const { air, video, attachHls } = await harness();
  attachHls();
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick();
  const alt = video.children[1];
  video.currentTime = 600;
  fire(video, "timeupdate");
  video._forcedCurrent = alt.getAttribute("src");
  video.webkitCurrentPlaybackTargetIsWireless = true;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  await tick(); await tick();
  assert.ok(air.active());
  assert.deepEqual(video.children, [alt], "hls.js's source removed, ours kept");
  assert.equal(video.loads || 0, 0, "the element was not reloaded");
  air.destroy();
});

test("an open server and a plain address the TV can fetch (an iPhone playing the file): nothing is changed", async () => {
  const { air, video, log } = await harness({ item: film(), needed: false });
  video.src = "/stream/video/0123456789ab";
  video.loads = 0;
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick();
  video.webkitCurrentPlaybackTargetIsWireless = true;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  await tick(); await tick();
  assert.equal(video.loads, 0);
  assert.ok(!log.includes("leave"));
  video.webkitCurrentPlaybackTargetIsWireless = false;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  assert.ok(!log.some((l) => l[0] === "back"), "nothing to put back");
  air.destroy();
});

test("a title that can't be sent, AirPlayed from Safari's own menu: said, and the local stream is left alone", async () => {
  const { air, video, log } = await harness({ item: film({ container: "avi" }) });
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick();
  video.webkitCurrentPlaybackTargetIsWireless = true;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  await tick(); await tick();
  assert.match(log.find((l) => l[0] === "toast")[1], /format/);
  assert.ok(!log.includes("leave"));
  air.destroy();
});

test("the server refuses the link (a kids profile, a title not allowed): said on the press", async () => {
  const { air, video, log } = await harness({ linkFails: 403 });
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick();
  assert.equal(air.pick(), false);
  assert.match(log.find((l) => l[0] === "toast")[1], /didn't allow/);
  air.destroy();
});

test("errors from the TV, one step each: a fresh link to what it plays, then the H.264 encode every Apple TV decodes, then a word", async () => {
  const { air, video, log, asked } = await harness();
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick();
  video.currentTime = 300;
  fire(video, "timeupdate");
  video.webkitCurrentPlaybackTargetIsWireless = true;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  await tick(); await tick();
  fire(video, "loadedmetadata");
  video.currentTime = 420;
  assert.equal(air.onError(), true);
  await tick(); await tick();
  assert.equal(asked.length, 2, "a fresh link was asked for");
  assert.equal(asked[1], "/stream/transcode/0123456789ab/jit/index.m3u8?seg=fmp4", "for the same stream");
  assert.match(video.src, /\/air\/tok2\//);
  video.currentTime = 0;
  fire(video, "loadedmetadata");
  assert.equal(video.currentTime, 420);
  // again: the TV may not decode the file's own video — the encode
  assert.equal(air.onError(), true);
  await tick(); await tick();
  assert.equal(asked[2], "/stream/transcode/0123456789ab/jit/index.m3u8?v=h264&seg=fmp4");
  assert.match(video.src, /\/air\/tok3\/stream\/transcode\/0123456789ab\/jit\/index\.m3u8\?v=h264&seg=fmp4$/);
  // and again: said, nothing more asked
  assert.equal(air.onError(), true);
  assert.match(log.filter((l) => l[0] === "toast").pop()[1], /couldn't play/);
  assert.equal(asked.length, 3);
  air.destroy();
  // not on AirPlay: the player's own error handling, untouched
  const other = await harness();
  assert.equal(other.air.onError(), false);
  other.air.destroy();
});

test("another audio track while on AirPlay: the TV is sent the film with that track, at the same spot", async () => {
  const { createAirplay } = await load();
  const video = fakeVideo();
  let audio = 0;
  const asked = [];
  const air = createAirplay({
    video, item: film({ container: "mkv" }),
    link: async (p) => { asked.push(p); return { url: `/air/t${asked.length}${p}`, needed: true }; },
    hooks: { audioIdx: () => audio, leave: () => ({}), back: () => {} },
    env: env(),
  });
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick();
  video.webkitCurrentPlaybackTargetIsWireless = true;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  await tick(); await tick();
  video.currentTime = 77;
  audio = 1;
  assert.equal(air.reload(), true);
  await tick(); await tick();
  assert.match(asked.pop(), /&a=1$/);
  assert.match(video.src, /a=1$/);
  air.destroy();
});

test("a browser without WebKit's AirPlay (Chrome, Firefox): nothing is listened to, nothing changes on the element", async () => {
  const { createAirplay } = await load();
  const video = fakeVideo();
  delete video.webkitShowPlaybackTargetPicker;
  video.webkitShowPlaybackTargetPicker = undefined;
  let asked = 0;
  const air = createAirplay({ video, item: film(), link: async () => { asked++; return {}; }, env: env() });
  assert.equal(air.supported, false);
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  air.attached();
  await tick();
  assert.equal(asked, 0);
  assert.equal(air.available, false);
  assert.equal(video.disableRemotePlayback, false, "remote playback (Chromecast's Remote Playback API) untouched");
  air.destroy();
});

// ---------- the iPhone: the link goes on BEFORE AirPlay (2026-10-26) ----------
// An iPhone plays HLS natively: the element holds the plain address, and
// iOS hands THAT to the TV the moment AirPlay is picked. On a server that
// requires sign-in the TV was refused it and played the sound alone.
const IPHONE_JIT = "/stream/transcode/0123456789ab/jit/index.m3u8?seg=fmp4";

test("addresses: the stream an address names, whether plain or a link; what is a link", async () => {
  const { streamPathOf, isLink } = await load();
  assert.equal(streamPathOf(IPHONE_JIT, "https://tv.example"), IPHONE_JIT);
  assert.equal(streamPathOf(`https://tv.example${IPHONE_JIT}`, "https://tv.example"), IPHONE_JIT);
  assert.equal(streamPathOf(`https://tv.example/air/abc.def${IPHONE_JIT}`), IPHONE_JIT);
  assert.equal(streamPathOf("http://192.168.1.20:4000/air/abc.def/stream/video/0123456789ab"), "/stream/video/0123456789ab");
  assert.equal(streamPathOf(`https://elsewhere.example${IPHONE_JIT}`, "https://tv.example"), null, "another site's address is not ours to sign");
  assert.equal(streamPathOf("blob:https://tv.example/x", "https://tv.example"), null);
  assert.equal(streamPathOf("/api/library", "https://tv.example"), null);
  assert.equal(streamPathOf(null), null);
  assert.equal(isLink(`https://tv.example/air/abc.def${IPHONE_JIT}`), true);
  assert.equal(isLink("/air/abc.def/stream/video/x"), true);
  assert.equal(isLink(IPHONE_JIT), false);
  assert.equal(isLink("blob:https://tv.example/x"), false);
});

test("the twin: a TV in reach and a server that requires sign-in — the element is moved to the link's twin of exactly what it plays, and later starts use it too", async () => {
  const { air, video, log, asked } = await harness();
  video.src = IPHONE_JIT; // native HLS: the plain address
  video.currentTime = 12;
  assert.equal(air.twin(IPHONE_JIT), null, "no TV in reach yet: the plain address");
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick(); await tick();
  assert.deepEqual(asked, [IPHONE_JIT]);
  const tw = log.find((l) => l[0] === "retarget");
  assert.ok(tw, "re-pointed");
  assert.equal(tw[1], `https://tv.example/air/tok1${IPHONE_JIT}`, "the same stream, on the page's own address, under the link");
  assert.ok(log.some((l) => l[0] === "track" && l[1] === "airplay_twin"));
  // any other start of a local stream (an offset job, the file) gets its twin
  assert.equal(air.twin("/stream/transcode/0123456789ab/600/index.m3u8?v=h264-720"), "https://tv.example/air/tok1/stream/transcode/0123456789ab/600/index.m3u8?v=h264-720");
  assert.equal(air.twin(`https://tv.example/air/old.tok${IPHONE_JIT}`), `https://tv.example/air/tok1${IPHONE_JIT}`, "a twin under an older link: the current one");
  assert.equal(air.twin("https://elsewhere.example/x.m3u8"), null);
  // the next availability event (or the half-hourly refresh) does not move it again
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick();
  assert.equal(log.filter((l) => l[0] === "retarget").length, 1);
  air.destroy();
});

test("no twin where it isn't needed or can't work: an open server, hls.js, a page on localhost, the switch off", async () => {
  // an open server: the plain address plays for the TV as it is
  {
    const { air, video, log } = await harness({ needed: false });
    video.src = IPHONE_JIT;
    fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
    await tick(); await tick();
    assert.ok(!log.some((l) => l[0] === "retarget"));
    assert.equal(air.twin(IPHONE_JIT), null);
    air.destroy();
  }
  // hls.js (a Mac, an iPad): the alternative <source> is that element's way
  {
    const { air, video, log, attachHls } = await harness();
    attachHls();
    fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
    await tick(); await tick();
    assert.ok(!log.some((l) => l[0] === "retarget"));
    assert.equal(video.children.length, 2);
    air.destroy();
  }
  // localhost: the TV could never reach the page's own name
  {
    const { air, video, log } = await harness({ envOverride: { win: { location: { origin: "http://localhost:4000", hostname: "localhost" }, localStorage: { getItem: () => null } } } });
    video.src = IPHONE_JIT;
    fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
    await tick(); await tick();
    assert.ok(!log.some((l) => l[0] === "retarget"));
    air.destroy();
  }
  // localStorage aurora-airplay-twin = 0
  {
    const off = { win: { location: { origin: "https://tv.example", hostname: "tv.example" }, localStorage: { getItem: (k) => (k === "aurora-airplay-twin" ? "0" : null) } } };
    const { air, video, log } = await harness({ envOverride: off });
    video.src = IPHONE_JIT;
    fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
    await tick(); await tick();
    assert.ok(!log.some((l) => l[0] === "retarget"));
    assert.equal(air.twin(IPHONE_JIT), null);
    air.destroy();
  }
});

test("a page opened as localhost on the server machine: the twin is on the home-network address the server names (that machine reaches it too)", async () => {
  const { createAirplay } = await load();
  const video = fakeVideo();
  const moved = [];
  const air = createAirplay({
    video, item: film({ container: "mkv" }),
    link: async (p) => ({ url: `/air/t1${p}`, needed: true, origin: "http://192.168.1.20:4000" }),
    hooks: { retarget: (u) => { moved.push(u); video.src = u; return true; }, leave: () => ({}), back: () => {} },
    env: { win: { location: { origin: "http://localhost:4000", hostname: "localhost" }, localStorage: { getItem: () => null } } },
  });
  video.src = IPHONE_JIT;
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick(); await tick();
  assert.deepEqual(moved, [`http://192.168.1.20:4000/air/t1${IPHONE_JIT}`]);
  air.destroy();
});

test("AirPlay starts on the twin: the element is left exactly as it is (iOS has already handed the TV an address it can fetch); 'Playing on the TV' with the way out; AirPlay ends: nothing to put back", async () => {
  const { air, video, log } = await harness();
  video.src = IPHONE_JIT;
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick(); await tick();
  const loads = video.loads;
  video.currentTime = 700;
  fire(video, "timeupdate");
  video.webkitCurrentPlaybackTargetIsWireless = true;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  await tick(); await tick();
  assert.ok(air.active());
  assert.equal(video.loads, loads, "not reloaded during the hand-over");
  assert.ok(!log.includes("leave"));
  const onTv = log.find((l) => l[0] === "toast" && /Playing on the TV/.test(l[1]));
  assert.ok(onTv && onTv[2] && /No picture/.test(onTv[2].label), "the way out is offered");
  video.webkitCurrentPlaybackTargetIsWireless = false;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  assert.equal(air.active(), false);
  assert.ok(!log.some((l) => l[0] === "back"));
  air.destroy();
});

test("'No picture there?': the TV is sent the H.264 encode at the same spot, and the phone's stream comes back after", async () => {
  const { air, video, log, asked } = await harness({ item: film({ container: "mkv", video: { codec: "hevc", bitDepth: 10 } }) });
  video.src = "/stream/transcode/0123456789ab/jit/index.m3u8?seg=fmp4&vtag=hvc1";
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick(); await tick();
  video.webkitCurrentPlaybackTargetIsWireless = true;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  await tick(); await tick();
  const onTv = log.find((l) => l[0] === "toast" && /Playing on the TV/.test(l[1]));
  video.currentTime = 1500;
  onTv[2].onClick();
  await tick(); await tick(); await tick();
  assert.equal(asked.pop(), "/stream/transcode/0123456789ab/jit/index.m3u8?v=h264&seg=fmp4");
  assert.ok(log.includes("leave"), "the phone's stream handed over first");
  assert.match(video.src, /\/air\/tok\d\/stream\/transcode\/0123456789ab\/jit\/index\.m3u8\?v=h264&seg=fmp4$/);
  video.currentTime = 0;
  fire(video, "loadedmetadata");
  assert.equal(video.currentTime, 1500);
  assert.equal(await air.simpler(), false, "once: nothing simpler than the encode");
  video.webkitCurrentPlaybackTargetIsWireless = false;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  assert.ok(log.some((l) => l[0] === "back"), "the phone's own stream is put back");
  air.destroy();
});

test("a subtitle on here when AirPlay starts on the twin: the master that carries it — and if the TV refuses that, the stream without it", async () => {
  const item = film({ container: "mkv", subtitles: [SUB(0), SUB(1)] });
  const { air, video, log, asked } = await harness({ item, sub: () => 1 });
  video.src = IPHONE_JIT;
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick(); await tick();
  const twin = video.src;
  assert.match(twin, /\/air\/tok1\/stream\/transcode\//);
  assert.equal(asked[0], "/stream/airplay/0123456789ab/master.m3u8?seg=fmp4&sub=1");
  video.currentTime = 90;
  fire(video, "timeupdate");
  video.webkitCurrentPlaybackTargetIsWireless = true;
  fire(video, "webkitcurrentplaybacktargetiswirelesschanged");
  await tick(); await tick();
  assert.ok(log.includes("leave"));
  assert.equal(video.src, "https://tv.example/air/tok1/stream/airplay/0123456789ab/master.m3u8?seg=fmp4&sub=1");
  // the TV can't take it: back to the stream it was already playing, said
  assert.equal(air.onError(), true);
  assert.equal(video.src, twin);
  assert.match(log.filter((l) => l[0] === "toast").pop()[1], /subtitles/);
  air.destroy();
});

test("the phone's own twin stops (the link expired, the server restarted): a fresh link, same stream; again within a minute: the plain address for good", async () => {
  let t = 1000000;
  const { createAirplay } = await load();
  const video = fakeVideo();
  const log = [];
  let n = 0;
  const air = createAirplay({
    video, item: film({ container: "mkv" }),
    link: async (p) => ({ url: `/air/tok${++n}${p}`, needed: true }),
    hooks: { retarget: (u) => { log.push(u); video.src = u; return true; }, leave: () => ({}), back: () => {} },
    env: { ...env(), now: () => t },
  });
  video.src = IPHONE_JIT;
  fire(video, "webkitplaybacktargetavailabilitychanged", { availability: "available" });
  await tick(); await tick(); await tick();
  assert.equal(log.pop(), `https://tv.example/air/tok1${IPHONE_JIT}`);
  t += 5 * 60 * 1000;
  assert.equal(air.recover(), true);
  await tick(); await tick(); await tick();
  assert.equal(log.pop(), `https://tv.example/air/tok2${IPHONE_JIT}`, "a fresh link to the same stream");
  t += 20 * 1000;
  assert.equal(air.recover(), true);
  assert.equal(log.pop(), `https://tv.example${IPHONE_JIT}`, "the plain address");
  assert.equal(air.twin(IPHONE_JIT), null, "and no twin for the rest of this player");
  assert.equal(air.recover(), false, "a plain address is not the twin's to recover");
  air.destroy();
});
