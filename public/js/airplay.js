// AirPlay from the web player (2026-10-17, Matan: "Airplay do not work";
// 2026-10-26, Matan again, iPhone: "it shows that it's a sound file and not a
// video, and it still gets stuck").
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
//     Subtitles the page draws never reach the TV: a subtitle that is ON is
//     sent in a master playlist that carries it as an HLS subtitle rendition
//     (routes/stream.js "/stream/airplay/…").
//
// THE IPHONE (2026-10-26). An iPhone plays HLS natively: the element holds a
// plain address, and the moment AirPlay is picked — the player's button, the
// fullscreen controls, Control Center, Screen Mirroring — iOS hands THAT
// address to the TV. On a server that requires sign-in (nufurora.com does)
// it is the session's address, the TV is refused it, and the switch to the
// link (below, "when the element starts playing to a wireless target") came
// only after iOS had already given up on the picture: the TV got the sound
// alone, with the lock-screen card (title, show, "Aurora", the poster) that
// makes it look like a song. So on an element that plays a plain address
// the link goes on BEFORE AirPlay: as soon as Safari says a TV is in reach,
// the element is moved to the link's twin of exactly what it plays (the
// same stream, the same segments, the same spot — `retarget`), and every
// later start of a local stream on it uses the twin too. When AirPlay
// starts, the TV is given an address it can fetch, and nothing on the
// element has to change during the hand-over.
//
// WHAT HAPPENS NOW.
//  - The button shows when Safari says a target is in reach
//    (webkitplaybacktargetavailabilitychanged). On an hls.js element the
//    receiver's address is also attached as an AirPlay ALTERNATIVE <source>
//    after hls.js's own (WebKit's documented way to AirPlay a
//    ManagedMediaSource), and remote playback is allowed again — so Safari's
//    own AirPlay menus (Control Center, the macOS menu bar) work too.
//    localStorage["aurora-airplay-alt"] = "0" turns that part off.
//    On an element that plays a plain address (an iPhone), the twin above;
//    localStorage["aurora-airplay-twin"] = "0" turns that part off.
//  - When the element starts playing to a wireless target
//    (webkitcurrentplaybacktargetiswirelesschanged): an element that already
//    plays an address the TV can fetch (the twin, or anything on an open
//    server) is left as it is — unless a subtitle is on here, which only the
//    master playlist carries. Anything else (hls.js) is switched to the
//    receiver's address at the current position: hls.js is taken off, and
//    the element plays the link. Every seek is then a plain seek of the
//    element (all receiver sources are the whole film on one timeline).
//  - "Playing on the TV" comes with a way out for a TV that shows no picture
//    (one that can't decode the file's video — an older Apple TV and HEVC):
//    the full H.264 encode, which every Apple TV plays.
//  - An error from the TV: the stream without the subtitle (when the master
//    was the change), then a fresh link, then the H.264 encode, then a word.
//  - When AirPlay stops, the player goes back to what it was playing, at
//    the position the TV reached.
//  - A title that cannot be sent says why, instead of failing on the TV.
//
// NOT TESTED ON AN APPLE DEVICE (no Mac, iPhone or Apple TV in reach): the
// logic is tested with WebKit's API stubbed (test/airplay-client.test.js,
// test/ui/airplay.test.js — the twin on Chrome's own native HLS with an
// iPhone's user agent), and docs/qa/airplay/ has the steps to try it for real.

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
  onTv: "Playing on the TV.",
  noPicture: "No picture there?",
  simpler: "Sending the TV the simpler picture every Apple TV shows…",
  noSubs: "The TV couldn't take the subtitles — playing it without them.",
};

// The title's OWN subtitles (sidecar files, tracks in the film) — the ones
// the server lists, in its order. Ones found online and added here come
// after them and are not the server's to send.
const ownSubs = (item) => {
  const list = Array.isArray(item.subtitles) ? item.subtitles : [];
  let own = 0;
  while (own < list.length && /^\/stream\/(subtitle|embedded)\//.test((list[own] && list[own].url) || "")) own++;
  return own;
};

// The stream the RECEIVER should play, for this title as it is playing here:
//   { path, type, kind: "direct" | "hls" }  or  { error, message }
// `audioIdx`: the audio track playing here (0 = the first); `subIdx`: the
// subtitle showing here (index into item.subtitles, -1 for none).
// `simple`: the full H.264 encode, whatever the file is (the way out for a
// TV that cannot decode the file's own video) — null when there is no such
// stream for this title.
export const receiverSource = (item, { audioIdx = 0, subIdx = -1, simple = false } = {}) => {
  if (!item) return { error: "none", message: MESSAGES.none };
  if (item._offline) return { error: "offline", message: MESSAGES.offline };
  const v = item.video || null;
  const vOk = appleVideo(v);
  const aOk = !item.audio || !item.audio.codec || APPLE_AUDIO.has(item.audio.codec);
  const hevc = !!v && v.codec === "hevc";
  const encode = simple || (v && !vOk); // a codec the TV can't decode: the full encode
  const q = [
    encode ? "v=h264" : null,
    "seg=fmp4", // fMP4 segments: Apple's format (and required for HEVC)
    !encode && vOk && hevc ? "vtag=hvc1" : null,
    audioIdx > 0 ? `a=${audioIdx}` : null,
  ].filter(Boolean).join("&");
  if (isTorrent(item)) {
    const m = /^torrent\|([a-fA-F0-9]{40})\|(\d{1,5})$/.exec(String(item.id || ""));
    if (!m) return { error: "none", message: MESSAGES.none };
    const [, hash, idx] = m;
    if (!simple && fileBox(item.container) && vOk && aOk && audioIdx === 0) return { path: `/stream/torrent/${hash}/${idx}`, type: "video/mp4", kind: "direct" };
    // the jit stream needs the file's MKV index (routes/torrent.js)
    if (mkvBox(item.container) && v) return { path: `/stream/torrent/hls/${hash}/${idx}/jit/index.m3u8?${q}`, type: "application/x-mpegURL", kind: "hls" };
    return { error: "format", message: MESSAGES.format };
  }
  const id = String(item.id || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { error: "none", message: MESSAGES.none };
  // a container the jit stream can't index (it reads MKV and MP4 indexes)
  if (item.container && !fileBox(item.container) && !mkvBox(item.container)) return { error: "format", message: MESSAGES.format };
  const own = ownSubs(item);
  const showing = subIdx >= 0 && subIdx < own;
  // the file itself when the TV plays it as it is — unless a subtitle is on
  // here, which only a playlist can carry to the TV
  if (!simple && fileBox(item.container) && vOk && aOk && audioIdx === 0 && !showing) {
    return { path: `/stream/video/${id}`, type: "video/mp4", kind: "direct" };
  }
  // A subtitle on here: the master playlist that carries the title's own
  // subtitles, that one on. With none on, the plain stream — the most
  // ordinary thing an Apple TV is ever handed (2026-10-26: the master is the
  // one part of this the receiver has never been seen to accept).
  if (showing) {
    return { path: `/stream/airplay/${id}/master.m3u8?${q}&sub=${subIdx}`, type: "application/x-mpegURL", kind: "hls" };
  }
  return { path: `/stream/transcode/${id}/jit/index.m3u8?${q}`, type: "application/x-mpegURL", kind: "hls" };
};

// A page on this machine's own name: an Apple TV can't reach it.
export const localOrigin = (hostname) =>
  /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)$/i.test(String(hostname || "")) || /\.localhost$/i.test(String(hostname || ""));

// ---------- addresses ----------
const LINK_RE = /^\/air\/([^/]+)(\/stream\/.*)$/;
const parse = (addr, base) => {
  try { return new URL(String(addr), base || "http://aurora.invalid"); } catch { return null; }
};
// Is this address an AirPlay link (/air/<token>/stream/…)?
export const isLink = (addr) => {
  const u = addr ? parse(addr) : null;
  return !!u && LINK_RE.test(u.pathname);
};
// The stream an address names — "/stream/…?…" — whether it is the plain
// address or a link to it; null for anything else (a blob:, another site,
// a page of the API). `origin`: the plain address must be on this one.
export const streamPathOf = (addr, origin = null) => {
  if (!addr) return null;
  const u = parse(addr, origin || undefined);
  if (!u) return null;
  const m = LINK_RE.exec(u.pathname);
  if (m) return m[2] + u.search;
  if (origin && u.origin !== parse(origin).origin) return null;
  return u.pathname.startsWith("/stream/") ? u.pathname + u.search : null;
};
const tokenOf = (url) => {
  const u = url ? parse(url) : null;
  const m = u ? LINK_RE.exec(u.pathname) : null;
  return m ? m[1] : null;
};

// How long a link is used before a fresh one is asked for (the server's
// links live three hours and more: this keeps a long-open player well inside).
const REFRESH_MS = 30 * 60 * 1000;
// An error this long after the last step taken for one is a new trouble:
// the steps begin again.
const STEPS_RESET_MS = 10 * 60 * 1000;
// The phone's own twin failing again this soon after a fresh one: give the
// twin up for this player (back to the plain address).
const LOCAL_RETRY_MS = 60 * 1000;

// ---------- the controller ----------
// video: the player's <video>; item: the title.
// link(path) -> Promise<{ url, expiresAt, needed }> (api.airplayLink)
// hooks (all optional but leave/back):
//   pos()            the film position now (seconds)
//   audioIdx()       the audio track playing here
//   subIdx()         the subtitle showing here, -1 for none
//   src()            the plain address the element plays (no hls.js, not a
//                    blob:) — null when there is none
//   retarget(url)    play `url` on the element in place of what it plays — the
//                    same stream at another address: same spot, same state
//   leave()          take the local stream off the element; returns what it was (a snapshot)
//   back(snap, pos, playing)  put it back, at `pos`
//   toast(text, icon, action), track(feature), onAvailable(bool), onActive(bool)
// env: { win, now } for tests.
export const createAirplay = ({ video, item, link, hooks = {}, env = {} }) => {
  const win = env.win || (typeof window !== "undefined" ? window : {});
  const now = env.now || (() => Date.now());
  const h = {
    pos: () => video.currentTime || 0, audioIdx: () => 0, subIdx: () => -1,
    src: () => {
      const s = video.getAttribute ? video.getAttribute("src") : null;
      return s && !/^blob:/i.test(s) ? s : null;
    },
    retarget: (url) => { video.src = url; return true; },
    leave: () => null, back: () => {}, toast: () => {}, track: () => {}, onAvailable: () => {}, onActive: () => {},
    ...hooks,
  };
  const supported = typeof video.webkitShowPlaybackTargetPicker === "function";
  let available = false;
  let prepared = null; // { src, url, at, expiresAt, needed } | { error, message, src? }
  let preparing = null;
  // { pending } while the link is being asked for; then
  // { kept: true, url }            the element plays on as it was (the TV fetches it too)
  // { kept: false, snap, url, base } the element was switched to `url` for the TV
  // plus the steps taken for its errors: baseTried, fresh, simple, stepAt
  let active = null;
  let alt = null; // our <source>
  let destroyed = false;
  let lastPos = 0;
  let lastPlaying = false;
  let twinDead = false; // the phone's own twin failed twice in a row: plain addresses from here
  let localAt = 0;
  const flag = (key) => {
    try { return win.localStorage ? win.localStorage.getItem(key) !== "0" : true; } catch { return true; }
  };
  const altOn = () => flag("aurora-airplay-alt");
  const twinOn = () => flag("aurora-airplay-twin");
  const origin = () => (win.location && win.location.origin) || "";
  // the address the TV is given is on a name only this machine knows
  // (known once the link is in: a page opened as localhost is given the
  // server's home-network address when the server has one)
  const isLocal = () => {
    if (!prepared || !prepared.url) return false;
    try { return localOrigin(new URL(prepared.url).hostname); } catch { return false; }
  };
  // a link the server answered, as an absolute address for the TV
  const absolute = (r) => {
    // (`origin`: the server's address on the home network, when this page
    // was opened as localhost on the server machine itself)
    const base = typeof r.origin === "string" && /^https?:\/\//.test(r.origin) ? r.origin : origin() || "http://localhost";
    return new URL(r.url, base).href;
  };
  const failure = (e) => {
    const status = e && e.status;
    return { error: status === 403 ? "refused" : "failed", message: status === 403 ? MESSAGES.refused : MESSAGES.none, at: now() };
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
        prepared = { src, url: absolute(r), at: now(), expiresAt: r.expiresAt || 0, needed: r.needed !== false };
        return prepared;
      })
      .catch((e) => (prepared = failure(e)))
      .finally(() => { if (preparing === p) preparing = null; });
    preparing = p;
    return p.then((r) => { syncAlt(); syncTwin(); return r; });
  };
  // A link to one stream of this title (the TV kept on what it plays, or
  // moved to the H.264 encode): { url } or { error, message }.
  const linkFor = (path) =>
    Promise.resolve()
      .then(() => link(path))
      .then((r) => {
        if (!r || typeof r.url !== "string" || !r.url.startsWith("/air/")) throw new Error("no link");
        return { url: absolute(r) };
      })
      .catch(failure);

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

  // ---- the twin: a plain address, moved onto the link before AirPlay ----
  // Only where it is needed and can work: a TV is in reach, the server
  // requires sign-in (an open server's plain address plays for the TV as it
  // is), and the link is on an address the TV can reach.
  const twinReady = () =>
    supported && available && !destroyed && !twinDead && twinOn() && !isLocal() &&
    !!prepared && !prepared.error && prepared.needed && !!tokenOf(prepared.url);
  // The link's twin of a plain address of THIS page — or null. On the
  // link's own origin: the page's (the phone fetches it as well as the TV),
  // or, for a page opened as localhost on the server machine, the server's
  // home-network address, which that machine reaches as well as the TV.
  const twinOf = (addr) => {
    if (!twinReady()) return null;
    const inner = streamPathOf(addr, origin());
    if (!inner) return null;
    const u = parse(prepared.url);
    return u ? `${u.origin}/air/${tokenOf(prepared.url)}${inner}` : null;
  };
  const syncTwin = () => {
    if (active || !twinReady()) return;
    const cur = h.src();
    if (!cur || isLink(cur)) return;
    const t = twinOf(cur);
    if (t && h.retarget(t)) h.track("airplay_twin");
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
  // The TV is to play `url` now, at the spot it has reached. An element that
  // was left as it was hands its stream over first, so the end of AirPlay
  // can put it back.
  const sendTv = (url) => {
    const a = active;
    const pos = video.currentTime || lastPos || 0;
    const playing = !video.paused;
    if (a.kept) { a.snap = h.leave(); a.kept = false; }
    a.url = url;
    playAt(url, pos, playing);
  };
  // The full H.264 encode for the TV — or false when there is nothing
  // simpler than what it has.
  const simpler = async () => {
    if (!active || active.pending || destroyed || active.simple) return false;
    const src = receiverSource(item, { audioIdx: h.audioIdx(), subIdx: h.subIdx(), simple: true });
    if (src.error) return false;
    active.simple = true;
    const r = await linkFor(src.path);
    if (!active || destroyed) return false;
    if (r.error) { h.toast(r.message, "⚠️"); return false; }
    sendTv(r.url);
    h.track("airplay_simpler");
    return true;
  };
  // "Playing on the TV" — and the way out for a TV that shows no picture.
  const offer = () => {
    const tvGets = active && (active.url || "");
    if (/[?&]v=h264(&|$)/.test(tvGets)) return; // already the simplest there is
    h.toast(MESSAGES.onTv, "📺", {
      label: MESSAGES.noPicture,
      onClick: () => { h.toast(MESSAGES.simpler, "📺"); simpler(); },
    });
  };
  const enter = async () => {
    if (active || destroyed) return;
    const pos = lastPos || h.pos();
    const playing = lastPlaying || !video.paused;
    active = { pending: true };
    h.onActive(true);
    const r = await prepare(prepared && !prepared.error && now() - prepared.at > 10 * 60 * 1000 ? { force: true } : {});
    if (destroyed || !active) return;
    if (!r || r.error) {
      // nothing the TV can be given: say so (it is playing to the TV all the same)
      h.toast(r ? r.message : MESSAGES.none, "⚠️");
      active = { kept: true, url: null };
      return;
    }
    if (isLocal()) h.toast(MESSAGES.local, "⚠️");
    // The element already plays an address the TV can fetch for itself —
    // the twin (a link), or anything on an open server: nothing to change…
    const cur = h.src();
    if (cur && (isLink(cur) || !r.needed)) {
      // …unless a subtitle is on here, which only the master carries
      if (/^\/stream\/airplay\//.test(r.src.path)) {
        active = { kept: true, url: cur, base: cur };
        sendTv(r.url);
      } else {
        active = { kept: true, url: cur };
      }
      h.track("airplay_on");
      offer();
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
    offer();
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
  // error while it plays to the TV). One step each, in this order: the same
  // stream without the subtitle (when the master was the change); a fresh
  // link to what it plays (the old one may have expired, or the server
  // restarted); the H.264 encode every Apple TV decodes; then a word.
  // Returns true when it was AirPlay's.
  const onError = () => {
    if (!active || active.pending) return false;
    const a = active;
    if (a.kept && !a.url) return true; // nothing was given to the TV: nothing to try
    if (a.stepAt && now() - a.stepAt > STEPS_RESET_MS) { a.baseTried = a.fresh = a.simple = false; }
    a.stepAt = now();
    if (a.base && !a.kept && a.url !== a.base && !a.baseTried) {
      a.baseTried = true;
      h.toast(MESSAGES.noSubs, "⚠️");
      sendTv(a.base);
      return true;
    }
    if (!a.fresh) {
      a.fresh = true;
      const inner = streamPathOf(a.url);
      if (inner) {
        linkFor(inner).then((r) => {
          if (active !== a || destroyed) return;
          if (r.error) return void h.toast(r.message, "⚠️");
          sendTv(r.url);
        });
        return true;
      }
    }
    if (!a.simple) {
      simpler().then((ok) => { if (!ok && active === a) h.toast(MESSAGES.failed, "⚠️"); });
      return true;
    }
    h.toast(MESSAGES.failed, "⚠️");
    return true;
  };

  // The phone's OWN stream on its twin stopped (not on AirPlay): the link
  // expired, or the server restarted (its links end with it). A fresh link,
  // the same stream, the same spot; failing again within a minute, the plain
  // address for the rest of this player. Returns true when it was the twin's.
  const recover = () => {
    if (active || destroyed) return false;
    const cur = h.src();
    if (!cur || !isLink(cur)) return false;
    const plain = `${origin()}${streamPathOf(cur)}`;
    if (now() - localAt < LOCAL_RETRY_MS) {
      twinDead = true;
      h.retarget(plain);
      h.track("airplay_twin_off");
      return true;
    }
    localAt = now();
    prepare({ force: true }).then(() => {
      if (destroyed || active) return;
      h.retarget(twinOf(plain) || plain);
    });
    return true;
  };

  // Another audio track while on AirPlay: the TV is sent the same film with
  // that track, at the same spot.
  const reload = () => {
    if (!active || active.pending) return false;
    const a = active;
    prepare({ force: true }).then((r) => {
      if (active !== a || destroyed) return;
      if (!r || r.error) return void h.toast(r ? r.message : MESSAGES.failed, "⚠️");
      sendTv(r.url);
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
    // the address a local stream should be started on: its twin when the
    // twin is in use (see above), else null (the plain address)
    twin: (addr) => (active ? null : twinOf(addr)),
    pick,
    onError,
    recover,
    reload,
    simpler,
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
    _state: () => ({ available, prepared, active, alt, twinDead }),
  };
};
