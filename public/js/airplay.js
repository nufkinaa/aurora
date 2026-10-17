// AirPlay from the web player (2026-10-17, Matan: "Airplay do not work").
//
// HOW AIRPLAY VIDEO WORKS, and why it did not. Safari does not send the
// picture to an Apple TV: it sends the ADDRESS of the media, and the Apple
// TV fetches it itself. Three things followed from that, and each one broke it:
//
//  1. A stream built by hls.js has no address. On a Mac and an iPad the
//     player feeds the <video> through ManagedMediaSource / MediaSource — a
//     blob: URL that means nothing on another device. hls.js even switches
//     AirPlay off on such an element (it sets disableRemotePlayback, which
//     WebKit requires for a ManagedMediaSource with no AirPlay alternative),
//     so the button never appeared there. Only an iPhone (native HLS) and a
//     file played as the file had an address at all.
//  2. The Apple TV has none of the sender's credentials. On a server that
//     requires sign-in every request it made was refused (401). So it is
//     handed an AirPlay LINK: /air/<token>/stream/… — signed, expiring, for
//     this one title only (src/lib/airtoken.js, POST /api/airplay/link).
//  3. What it is handed must be something it plays: H.264 / HEVC (fMP4 with
//     the hvc1 tag) with AAC or Dolby audio, in an MP4 file or an HLS stream.
//     MKV, AVI and the like go through the server's jit stream (fMP4
//     segments, AAC audio), and a codec the Apple TV can't decode (AV1, VP9,
//     10-bit H.264…) through the full H.264 encode.
//     Subtitles the page draws never reach the TV: a title with subtitles is
//     sent as a master playlist that carries them as HLS subtitle renditions
//     (routes/stream.js "/stream/airplay/…").
//
// WHAT HAPPENS NOW.
//  - The button shows when Safari says a target is in reach
//    (webkitplaybacktargetavailabilitychanged). On an hls.js element the
//    receiver's address is also attached as an AirPlay ALTERNATIVE <source>
//    after hls.js's own (WebKit's documented way to AirPlay a
//    ManagedMediaSource), and remote playback is allowed again — so Safari's
//    own AirPlay menus (Control Center, the macOS menu bar) work too.
//    localStorage["aurora-airplay-alt"] = "0" turns that part off.
//  - When the element starts playing to a wireless target
//    (webkitcurrentplaybacktargetiswirelesschanged), it is switched to the
//    receiver's address at the current position: hls.js is taken off, and
//    the element plays the link. Every seek is then a plain seek of the
//    element (all receiver sources are the whole film on one timeline).
//  - When AirPlay stops, the player goes back to what it was playing, at
//    the position the TV reached.
//  - A title that cannot be sent says why, instead of failing on the TV.
//
// NOT TESTED ON AN APPLE DEVICE when it was written (no Mac, iPhone or Apple
// TV in reach): the logic is tested with WebKit's API stubbed
// (test/airplay-client.test.js, test/ui/airplay.test.js), and
// docs/qa/airplay/REPORT.md has the steps to try it for real.

// ---------- what the receiver can play ----------
const APPLE_AUDIO = new Set(["aac", "mp3", "ac3", "eac3", "alac"]);
export const appleVideo = (v) => !!v && ((v.codec === "h264" && (v.bitDepth || 8) <= 8) || v.codec === "hevc");
const fileBox = (c) => /^(mp4|m4v|mov)$/i.test(c || "") || /mov,mp4/i.test(c || "");
const mkvBox = (c) => /mkv|matroska/i.test(c || "");
const isTorrent = (item) => !!item && (String(item.id || "").startsWith("torrent|") || !!item._isTorrent);

export const MESSAGES = {
  offline: "This is the copy saved on this device. AirPlay sends the film from the server — play it from Aurora's library to watch it on a TV.",
  format: "This file's format can't be sent to an Apple TV. Play it here, or pick another source.",
  none: "This can't be sent with AirPlay.",
  local: "AirPlay needs Aurora opened by its network address — this page is on \"localhost\", which the TV can't reach, and the server found no home-network address to give it instead.",
  refused: "The server didn't allow AirPlay for this title.",
  failed: "The TV couldn't play this film. Try AirPlay again, or play it here.",
};

// The stream the RECEIVER should play, for this title as it is playing here:
//   { path, type, kind: "direct" | "hls" }  or  { error, message }
// `audioIdx`: the audio track playing here (0 = the first); `subIdx`: the
// subtitle showing here (index into item.subtitles, -1 for none).
export const receiverSource = (item, { audioIdx = 0, subIdx = -1 } = {}) => {
  if (!item) return { error: "none", message: MESSAGES.none };
  if (item._offline) return { error: "offline", message: MESSAGES.offline };
  const v = item.video || null;
  const vOk = appleVideo(v);
  const aOk = !item.audio || !item.audio.codec || APPLE_AUDIO.has(item.audio.codec);
  const hevc = !!v && v.codec === "hevc";
  const q = [
    v && !vOk ? "v=h264" : null, // a codec the TV can't decode: the full encode
    "seg=fmp4", // fMP4 segments: Apple's format (and required for HEVC)
    vOk && hevc ? "vtag=hvc1" : null,
    audioIdx > 0 ? `a=${audioIdx}` : null,
  ].filter(Boolean).join("&");
  if (isTorrent(item)) {
    const m = /^torrent\|([a-fA-F0-9]{40})\|(\d{1,5})$/.exec(String(item.id || ""));
    if (!m) return { error: "none", message: MESSAGES.none };
    const [, hash, idx] = m;
    if (fileBox(item.container) && vOk && aOk && audioIdx === 0) return { path: `/stream/torrent/${hash}/${idx}`, type: "video/mp4", kind: "direct" };
    // the jit stream needs the file's MKV index (routes/torrent.js)
    if (mkvBox(item.container) && v) return { path: `/stream/torrent/hls/${hash}/${idx}/jit/index.m3u8?${q}`, type: "application/x-mpegURL", kind: "hls" };
    return { error: "format", message: MESSAGES.format };
  }
  const id = String(item.id || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { error: "none", message: MESSAGES.none };
  // a container the jit stream can't index (it reads MKV and MP4 indexes)
  if (item.container && !fileBox(item.container) && !mkvBox(item.container)) return { error: "format", message: MESSAGES.format };
  // The title's OWN subtitles (sidecar files, tracks in the film) — the ones
  // the server lists, in its order. Ones found online and added here come
  // after them and are not the server's to send.
  const list = Array.isArray(item.subtitles) ? item.subtitles : [];
  let own = 0;
  while (own < list.length && /^\/stream\/(subtitle|embedded)\//.test((list[own] && list[own].url) || "")) own++;
  const subs = own > 0;
  const showing = subIdx >= 0 && subIdx < own;
  // the file itself when the TV plays it as it is — unless subtitles are on
  // here, which only a playlist can carry to the TV
  if (fileBox(item.container) && vOk && aOk && audioIdx === 0 && !showing) {
    return { path: `/stream/video/${id}`, type: "video/mp4", kind: "direct" };
  }
  if (subs) {
    const sub = showing ? `&sub=${subIdx}` : "";
    return { path: `/stream/airplay/${id}/master.m3u8?${q}${sub}`, type: "application/x-mpegURL", kind: "hls" };
  }
  return { path: `/stream/transcode/${id}/jit/index.m3u8?${q}`, type: "application/x-mpegURL", kind: "hls" };
};

// A page on this machine's own name: an Apple TV can't reach it.
export const localOrigin = (hostname) =>
  /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)$/i.test(String(hostname || "")) || /\.localhost$/i.test(String(hostname || ""));

// How long a link is used before a fresh one is asked for (the server's
// links live three hours and more: this keeps a long-open player well inside).
const REFRESH_MS = 30 * 60 * 1000;
// A receiver error within this long of the last re-ask is the film's, not the link's.
const RETRY_WINDOW_MS = 2 * 60 * 1000;

// ---------- the controller ----------
// video: the player's <video>; item: the title.
// link(path) -> Promise<{ url, expiresAt, needed }> (api.airplayLink)
// hooks (all optional but leave/back):
//   pos()            the film position now (seconds)
//   audioIdx()       the audio track playing here
//   subIdx()         the subtitle showing here, -1 for none
//   plainSrc()       true when the element plays a plain address (no hls.js, not a blob)
//   leave()          take the local stream off the element; returns what it was (a snapshot)
//   back(snap, pos, playing)  put it back, at `pos`
//   toast(text, icon), track(feature), onAvailable(bool), onActive(bool)
// env: { win, now } for tests.
export const createAirplay = ({ video, item, link, hooks = {}, env = {} }) => {
  const win = env.win || (typeof window !== "undefined" ? window : {});
  const now = env.now || (() => Date.now());
  const h = {
    pos: () => video.currentTime || 0, audioIdx: () => 0, subIdx: () => -1, plainSrc: () => false,
    leave: () => null, back: () => {}, toast: () => {}, track: () => {}, onAvailable: () => {}, onActive: () => {},
    ...hooks,
  };
  const supported = typeof video.webkitShowPlaybackTargetPicker === "function";
  let available = false;
  let prepared = null; // { src, url, at, expiresAt, needed } | { error, message, src? }
  let preparing = null;
  let active = null; // { snap, kept, url }
  let alt = null; // our <source>
  let destroyed = false;
  let lastPos = 0;
  let lastPlaying = false;
  let retryAt = 0;
  const altOn = () => {
    try { return win.localStorage ? win.localStorage.getItem("aurora-airplay-alt") !== "0" : true; } catch { return true; }
  };
  const origin = () => (win.location && win.location.origin) || "";
  // the address the TV is given is on a name only this machine knows
  // (known once the link is in: a page opened as localhost is given the
  // server's home-network address when the server has one)
  const isLocal = () => {
    if (!prepared || !prepared.url) return false;
    try { return localOrigin(new URL(prepared.url).hostname); } catch { return false; }
  };

  // Ask for the receiver's address (again, when `force`, when it is old, or
  // when what should be sent has changed: another audio track, subtitles on).
  const prepare = ({ force = false } = {}) => {
    if (destroyed) return Promise.resolve(null);
    const src = receiverSource(item, { audioIdx: h.audioIdx(), subIdx: h.subIdx() });
    if (src.error) {
      prepared = { error: src.error, message: src.message };
      return Promise.resolve(prepared);
    }
    const fresh = prepared && !prepared.error && prepared.src.path === src.path && now() - prepared.at < REFRESH_MS;
    if (!force && fresh) return Promise.resolve(prepared);
    if (preparing && !force) return preparing;
    const p = Promise.resolve()
      .then(() => link(src.path))
      .then((r) => {
        if (!r || typeof r.url !== "string" || !r.url.startsWith("/air/")) throw new Error("no link");
        // (`origin`: the server's address on the home network, when this page
        // was opened as localhost on the server machine itself)
        const base = typeof r.origin === "string" && /^https?:\/\//.test(r.origin) ? r.origin : origin() || "http://localhost";
        prepared = { src, url: new URL(r.url, base).href, at: now(), expiresAt: r.expiresAt || 0, needed: r.needed !== false };
        return prepared;
      })
      .catch((e) => {
        const status = e && e.status;
        prepared = { error: status === 403 ? "refused" : "failed", message: status === 403 ? MESSAGES.refused : MESSAGES.none, at: now() };
        return prepared;
      })
      .finally(() => { if (preparing === p) preparing = null; });
    preparing = p;
    return p.then((r) => { syncAlt(); return r; });
  };

  // ---- the AirPlay alternative <source> beside hls.js's ManagedMediaSource ----
  // hls.js attaches a ManagedMediaSource as a <source> child (and turns remote
  // playback off). WebKit AirPlays such an element when a second <source>
  // names an address the receiver can fetch: then remote playback may be on.
  const mmsSource = () => {
    const first = video.querySelector ? video.querySelector("source") : null;
    return first && /^blob:/i.test(first.src || "") ? first : null;
  };
  const syncAlt = () => {
    if (destroyed || !supported || active || !altOn()) return;
    if (!prepared || prepared.error || isLocal()) return;
    if (!mmsSource()) return;
    if (!alt || !alt.isConnected) {
      alt = video.ownerDocument.createElement("source");
      alt.setAttribute("data-airplay", "1");
    }
    if (alt.getAttribute("src") !== prepared.url) alt.setAttribute("src", prepared.url);
    alt.setAttribute("type", prepared.src.type);
    if (alt.parentNode !== video) video.appendChild(alt);
    // (only now — with the alternative in place, as WebKit requires)
    try { video.disableRemotePlayback = false; } catch {}
  };

  // ---- the switch ----
  const playAt = (url, pos, playing) => {
    const once = () => {
      video.removeEventListener("loadedmetadata", once);
      try { if (pos > 0.5 && Math.abs((video.currentTime || 0) - pos) > 1) video.currentTime = pos; } catch {}
      if (playing) { try { const p = video.play(); if (p && p.catch) p.catch(() => {}); } catch {} }
    };
    video.addEventListener("loadedmetadata", once);
    video.src = url;
  };
  const enter = async () => {
    if (active || destroyed) return;
    const pos = lastPos || h.pos();
    const playing = lastPlaying || !video.paused;
    active = { snap: null, kept: false, url: null, pending: true };
    h.onActive(true);
    const r = await prepare(prepared && !prepared.error && now() - prepared.at > 10 * 60 * 1000 ? { force: true } : {});
    if (destroyed || !active) return;
    if (!r || r.error) {
      // nothing the TV can be given: say so (it is playing to the TV all the same)
      h.toast(r ? r.message : MESSAGES.none, "⚠️");
      active.pending = false;
      active.kept = true;
      return;
    }
    if (isLocal()) h.toast(MESSAGES.local, "⚠️");
    // An open server, and the element already plays a plain address the TV
    // can fetch for itself: nothing to change.
    if (!r.needed && h.plainSrc()) {
      active = { snap: null, kept: true, url: null };
      h.track("airplay_on");
      return;
    }
    // Safari already moved to our alternative <source>: keep it playing,
    // take hls.js off around it.
    const already = (video.currentSrc || "") === r.url;
    for (const s of [...(video.querySelectorAll ? video.querySelectorAll("source") : [])]) {
      if (!(already && s === alt)) s.remove();
    }
    const snap = h.leave();
    active = { snap, kept: false, url: r.url };
    if (already) {
      try { if (pos > 0.5 && Math.abs((video.currentTime || 0) - pos) > 5) video.currentTime = pos; } catch {}
    } else {
      if (alt) { try { alt.remove(); } catch {} }
      playAt(r.url, pos, playing);
    }
    h.track("airplay_on");
  };
  const leave = () => {
    if (!active) return;
    const a = active;
    const pos = video.currentTime || lastPos || 0;
    const playing = !video.paused;
    active = null;
    h.onActive(false);
    if (a.kept || a.pending) return;
    try { if (alt) alt.remove(); } catch {}
    alt = null;
    try { video.removeAttribute("src"); } catch {}
    h.back(a.snap, pos, playing);
  };

  // The receiver could not play what it was given (the element reports the
  // error while it plays to the TV). Once: a fresh link (the old one may have
  // expired, or the server restarted) at the same spot. Again within two
  // minutes: it is the film — say so. Returns true when it was AirPlay's.
  const onError = () => {
    if (!active || active.kept || active.pending) return false;
    const pos = video.currentTime || lastPos || 0;
    if (now() - retryAt < RETRY_WINDOW_MS) {
      h.toast(MESSAGES.failed, "⚠️");
      return true;
    }
    retryAt = now();
    prepare({ force: true }).then((r) => {
      if (!active || destroyed) return;
      if (!r || r.error) return void h.toast(r ? r.message : MESSAGES.failed, "⚠️");
      active.url = r.url;
      playAt(r.url, pos, true);
    });
    return true;
  };

  // Another audio track while on AirPlay: the TV is sent the same film with
  // that track, at the same spot.
  const reload = () => {
    if (!active || active.kept || active.pending) return false;
    const pos = video.currentTime || 0;
    const playing = !video.paused;
    prepare({ force: true }).then((r) => {
      if (!active || destroyed) return;
      if (!r || r.error) return void h.toast(r ? r.message : MESSAGES.failed, "⚠️");
      active.url = r.url;
      playAt(r.url, pos, playing);
    });
    return true;
  };

  // The button (inside the press: Safari opens its picker only from one).
  const pick = () => {
    if (prepared && prepared.error) {
      h.toast(prepared.message, "⚠️");
      return false;
    }
    if (isLocal()) {
      h.toast(MESSAGES.local, "⚠️");
      return false;
    }
    try {
      video.webkitShowPlaybackTargetPicker();
      h.track("airplay");
      return true;
    } catch {
      return false;
    }
  };

  // ---- Safari's events ----
  const onAvail = (e) => {
    available = !!e && e.availability === "available";
    h.onAvailable(available);
    if (available) prepare();
  };
  const onWireless = () => {
    if (video.webkitCurrentPlaybackTargetIsWireless) enter();
    else leave();
  };
  const onTime = () => {
    if (active) return;
    lastPos = h.pos();
    lastPlaying = !video.paused;
  };
  const onPause = () => { if (!active) lastPlaying = false; };
  if (supported) {
    video.addEventListener("webkitplaybacktargetavailabilitychanged", onAvail);
    video.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", onWireless);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("pause", onPause);
  }
  const refresh = supported ? setInterval(() => { if (available && !active) prepare(); }, REFRESH_MS / 2) : null;
  try { if (refresh && refresh.unref) refresh.unref(); } catch {} // (Node, in the tests: never what keeps it running)

  return {
    supported,
    get available() { return available; },
    active: () => !!active,
    // the element's local stream changed (hls.js attached its MediaSource):
    // put the AirPlay alternative beside it again
    attached: () => { if (supported && available) prepare().then(syncAlt); },
    // what should be sent changed (subtitles on/off): ask for it now
    changed: () => { if (supported && available && !active) prepare(); },
    pick,
    onError,
    reload,
    destroy: () => {
      destroyed = true;
      if (refresh) clearInterval(refresh);
      if (supported) {
        video.removeEventListener("webkitplaybacktargetavailabilitychanged", onAvail);
        video.removeEventListener("webkitcurrentplaybacktargetiswirelesschanged", onWireless);
        video.removeEventListener("timeupdate", onTime);
        video.removeEventListener("pause", onPause);
      }
    },
    _state: () => ({ available, prepared, active, alt }),
  };
};
