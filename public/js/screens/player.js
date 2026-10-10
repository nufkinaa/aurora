// Full-screen player with Apple TV-style controls: auto-hiding UI, scrubber,
// ±10s, subtitle + speed menus, Up Next auto-advance, server-side resume.
import { el, icons, fmtClock, toast, formatRow } from "../ui.js";
import { api } from "../api.js";
import { state, progressFor, titleProgressFor, refreshProgress, readyDownloads } from "../state.js";
import { navigate, cameFrom } from "../router.js";
import { pushScope, popScope } from "../focus.js";
import { reportActivity, onMessage } from "../ws.js";
import { party, createParty, joinParty, leaveParty, sendPartyState, setPartyItem, onPartyState, onPartyUpdate, onPartyEnded, onPartyItem } from "../party.js";
import { showReportSheet, setPlayingContext } from "../report.js";
import * as offline from "../offline.js";
import { track } from "../usage.js";
import { playCap, capFor, netTier, measured, probe, dataMode } from "../net.js";
import { followVideo } from "../glassTone.js";
import { normPick, pickOf, bestTrackIndex, audioPick, sameAudio } from "../lang.js";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

// What an audio track is called in the menu: its language in words (the
// ISO code ffprobe reports), its title when the release named it ("Director's
// commentary"), else "Track N".
const AUDIO_LANG_NAMES = {
  eng: "English", en: "English", heb: "Hebrew", he: "Hebrew", iw: "Hebrew", rus: "Russian", ru: "Russian",
  ukr: "Ukrainian", uk: "Ukrainian", fra: "French", fre: "French", fr: "French", deu: "German", ger: "German", de: "German",
  spa: "Spanish", es: "Spanish", ita: "Italian", it: "Italian", por: "Portuguese", pt: "Portuguese",
  jpn: "Japanese", ja: "Japanese", kor: "Korean", ko: "Korean", zho: "Chinese", chi: "Chinese", zh: "Chinese",
  ara: "Arabic", ar: "Arabic", tur: "Turkish", tr: "Turkish", pol: "Polish", pl: "Polish", hin: "Hindi", hi: "Hindi",
  nld: "Dutch", dut: "Dutch", nl: "Dutch", swe: "Swedish", sv: "Swedish", tam: "Tamil", tel: "Telugu",
};
// A menu section's title with its glyph — the TV's menus, on the site (elia,
// 2026-10-07: "the same changes we made on tv with the little icons").
// What this profile picked last in the player (an audio language, a subtitle
// track): kept on the device and on the profile, so the next title — on any
// device — starts the way the last one was left (2026-10-07).
const profilePick = (key) => {
  const p = (state.profile && state.profile.prefs) || {};
  return p[key] != null ? p[key] : prefs.get(key, null);
};
const rememberPick = (key, value) => {
  prefs.set(key, value);
  if (!state.profile) return;
  state.profile.prefs = { ...(state.profile.prefs || {}), [key]: value };
  api.updateProfile(state.profile.id, { prefs: { [key]: value } }).catch(() => {});
};

const menuTitle = (icon, text, gap) =>
  el("div", { class: "menu-title", style: gap ? { marginTop: "6px" } : null, html: `${icons[icon] || ""}<span>${text}</span>` });

const audioTrackName = (t, i) => {
  const code = String(t.language || "").toLowerCase();
  const lang = code && code !== "und" ? AUDIO_LANG_NAMES[code] || code.toUpperCase() : "";
  const title = t.title && !/^(stereo|surround|\d\.\d)$/i.test(t.title) ? t.title : "";
  if (lang && title && !new RegExp(lang, "i").test(title)) return `${lang} · ${title}`;
  return lang || title || `Track ${i + 1}`;
};

// Consecutive fast presses skip in bigger and bigger jumps, capped at 3m —
// a 5m top step overshot too easily on remotes that auto-repeat.
const SKIP_STEPS = [10, 10, 10, 30, 60, 60, 120, 180];
const SKIP_CHAIN_MS = 900;

const prefs = {
  get: (key, fallback) => {
    try {
      const all = JSON.parse(localStorage.getItem("aurora-player") || "{}");
      return key in all ? all[key] : fallback;
    } catch {
      return fallback;
    }
  },
  set: (key, value) => {
    try {
      const all = JSON.parse(localStorage.getItem("aurora-player") || "{}");
      all[key] = value;
      localStorage.setItem("aurora-player", JSON.stringify(all));
    } catch {}
  },
};

// Device-local player settings, shared with the Preferences screen (which is a
// far better place to find "subtitles on by default" than a menu you can only
// open while something is already playing).
export const playerPrefs = prefs;

const CUE_SIZES = { S: "1.4vw", M: "2.2vw", L: "3.2vw" };

// ---- "Still watching?" (2026-10-08) ----
// How many episodes in a row started BY THEMSELVES (Up next counting down to
// zero — never a press of Play now / Next), and which episode the run ended
// on. The player is rendered afresh for every episode, so the count rides
// sessionStorage across that navigation; it only counts for the episode it
// names, so a title opened by hand never inherits a stale run.
const AUTO_RUN_KEY = "aurora-auto-run";
const STILL_WATCHING_AFTER = 3;
const autoRun = {
  read: (id) => {
    try {
      const r = JSON.parse(sessionStorage.getItem(AUTO_RUN_KEY) || "null");
      return r && String(r.to) === String(id) && r.n > 0 ? Math.floor(r.n) : 0;
    } catch {
      return 0;
    }
  },
  write: (n, to) => {
    try {
      if (n > 0) sessionStorage.setItem(AUTO_RUN_KEY, JSON.stringify({ n, to: String(to), at: Date.now() }));
      else sessionStorage.removeItem(AUTO_RUN_KEY);
    } catch {}
  },
};

// ---------- what this device can play ----------
// Module-level so the Play-button warm-up (warmPlayback, used by
// prefetch.js) and the player itself decide from ONE set of rules. The
// player's closures below delegate here — never fork the logic.
const MIME = {
  // BOTH directions must be mapped: the bad codecs so they remux, and the
  // GOOD ones with their real RFC6381 strings — a bare "aac" gets "" from
  // canPlayType (it wants mp4a.40.2), which silently classed every probed
  // AAC stream as needs-remux and re-encoded perfectly playable audio.
  audio: {
    ac3: "ac-3", eac3: "ec-3", dts: "dtsc", truehd: "mlpa",
    aac: "mp4a.40.2", mp3: "mp4a.6B", opus: "opus", flac: "flac", vorbis: "vorbis",
  },
  video: {
    h264: "avc1.640029",
    hevc: "hvc1.1.6.L123.B0",
    av1: "av01.0.08M.08",
    vp9: "vp09.00.40.08",
    vp8: "vp8",
    mpeg4: "mp4v.20.9",
  },
  // The CONTAINER matters as much as the codec: an iPhone hardware-decodes
  // HEVC but can't demux MKV at all.
  container: {
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    webm: "video/webm",
    avi: "video/x-msvideo",
  },
};
// iPhone: HLS through Safari's NATIVE pipeline, never MSE (see startHls).
export const nativeHlsFor = (video) =>
  /iPhone|iPod/.test(navigator.userAgent) && !!video.canPlayType("application/vnd.apple.mpegurl");
// AC-3 / E-AC-3 / DTS audio is silent in most desktop browsers (fine on TVs).
export const audioRemuxFor = (item, video) => {
  const codec = item.audio && item.audio.codec;
  if (!codec || item.audio.compatible) return false;
  const mime = MIME.audio[codec] || codec;
  return !(
    video.canPlayType(`audio/mp4; codecs="${mime}"`) ||
    video.canPlayType(`video/mp4; codecs="${mime}"`) ||
    // opus/vorbis are webm-family answers in Blink; mkv rides the same demuxer
    video.canPlayType(`audio/webm; codecs="${mime}"`)
  );
};
// HEVC/AV1/10-bit video decodes fine on TVs but not on most phones/desktops.
export const videoTranscodeFor = (item, video) => {
  const v = item.video;
  if (!v || !v.codec || !item.transcodeBase) return false;
  // 10-bit H.264 (Hi10P) has no hardware decoding anywhere and canPlayType
  // can't see bit depth — always transcode it.
  if (v.codec === "h264" && (v.bitDepth || 8) > 8) return true;
  const mime = MIME.video[v.codec];
  if (!mime) return true; // mpeg2, vc1, wmv… nothing browsers decode
  // Ask about the file's actual container when we know it; otherwise fall
  // back to the generic containers.
  const containers = MIME.container[item.container]
    ? [MIME.container[item.container]]
    : ["video/mp4", "video/webm"];
  return !containers.some((c) => video.canPlayType(`${c}; codecs="${mime}"`));
};
// Can this device DECODE the codec if we repackage into a container it
// accepts? h264 8-bit is universal; HEVC rides on hardware. iOS canPlayType
// LIES about hvc1 (blank while every iPhone since iOS 11 decodes HEVC), so
// on native-HLS devices HEVC is a platform guarantee.
export const copyableFor = (v, video, nativeHls) =>
  !!v &&
  ((v.codec === "h264" && (v.bitDepth || 8) <= 8) ||
    (v.codec === "hevc" && (nativeHls || !!video.canPlayType('video/mp4; codecs="hvc1.2.4.L123.B0"'))));

// Start the server side of playback for a library title BEFORE the tap: the
// same first request the player would make (the jit full-timeline playlist,
// or the h264 offset job) — so the index/first segment is ready when Play
// lands. Direct-play files have nothing to warm. Torrents are never warmed
// here (that would join a swarm). Returns the URL asked, or null.
let probeEl = null;
export const warmPlayback = (item) => {
  try {
    if (!item || item._isTorrent || item.magnet || String(item.id || "").startsWith("torrent|") || item._offline) return null;
    if (!item.transcodeBase) return null;
    const video = probeEl || (probeEl = document.createElement("video"));
    const nativeHls = nativeHlsFor(video);
    const needV = videoTranscodeFor(item, video);
    const needA = audioRemuxFor(item, video);
    const copyable = copyableFor(item.video || {}, video, nativeHls);
    // the three server-backed branches of renderPlayer's start decision
    const hevcMkv = !nativeHls && item.video && item.video.codec === "hevc" && /mkv|matroska/i.test(item.container || "") && copyable;
    let url = null;
    if (hevcMkv || (needV && copyable) || (!needV && needA)) {
      const isHevc = item.video && item.video.codec === "hevc";
      url = `${item.transcodeBase}/jit/index.m3u8${nativeHls ? `?seg=fmp4${isHevc ? "&vtag=hvc1" : ""}` : ""}`;
    } else if (needV) {
      url = `${item.transcodeBase}/0/index.m3u8?v=h264`;
    }
    if (!url) return null;
    fetch(url, { cache: "no-store", priority: "low" }).catch(() => {});
    return url;
  } catch {
    return null;
  }
};

// Subtitle appearance is styled globally via ::cue
export const applyCueStyle = () => {
  let styleEl = document.getElementById("cue-style");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "cue-style";
    document.head.append(styleEl);
  }
  const size = CUE_SIZES[prefs.get("cueSize", "M")] || CUE_SIZES.M;
  const bg = prefs.get("cueBackground", true)
    ? "rgba(0, 0, 0, 0.75)"
    : "transparent";
  styleEl.textContent =
    `video::cue { font-size: ${size}; background: ${bg}; ` +
    `font-family: inherit; line-height: 1.4; }`;
};

let playerOrigin = null; // the page the current run of players was opened from

export const renderPlayer = async (root, { id }) => {
  // Where the viewer was before the player (exit() goes back there). An
  // episode that started from the one before it (Up next, Next episode)
  // REPLACES that player in the history, and keeps the place the first one
  // was opened from.
  {
    const from = cameFrom();
    if (!(from && from.startsWith("#/play/"))) playerOrigin = from;
  }
  const enteredFrom = playerOrigin;
  // One player entry in the history however many episodes go by: Back from
  // the show page used to walk through every episode's player, each one
  // starting a stream and saving its place (QA, 2026-10-08).
  const goPlay = (hash) => {
    try {
      location.replace(hash);
    } catch {
      navigate(hash);
    }
  };
  const restart = location.hash.includes("restart=1");
  const itemId = id.split("?")[0];
  const entryHash = location.hash;

  let item;
  // Offline mode (#/play/<id>?offline=1, from the Saved screen): the item
  // comes from this device's store and the bytes from the service worker's
  // media cache — no server involved, no probe, no transcode decisions.
  const offlineMode = location.hash.includes("offline=1");
  // Torrent sources are handed over directly by the Discover page (no server
  // round-trip); fall back to the API for library items or a page refresh.
  if (offlineMode) {
    const saved = await offline.getSaved(itemId).catch(() => null);
    if (!saved) {
      toast("That title isn't saved on this device", "📱");
      return navigate("#/saved");
    }
    item = {
      ...saved,
      videoUrl: `/offline/media/${saved.id}`,
      downloadUrl: null,
      hlsUrl: null,
      transcodeBase: null,
      video: null,
      audio: null,
      subtitles: (saved.subtitles || []).map((t) => ({ ...t })),
      _offline: true,
    };
  } else if (state.pendingItems[itemId]) {
    item = state.pendingItems[itemId];
    delete state.pendingItems[itemId];
  } else {
    try {
      item = await api.item(itemId);
    } catch (e) {
      // a kids profile refused it: say so in the server's words
      if (e && /kids profile/i.test(e.message || "")) toast(e.message, "🧸");
      return navigate("#/");
    }
  }
  // Detect torrent playback
  const isTorrent =
    item._isTorrent || item.magnet || item.id?.startsWith("torrent|");

  // A stream item for something we now OWN plays the file instead. This is
  // the last line of defence for every way a torrent id can still reach the
  // player — a Continue Watching card, a deep link, a stale tab — and it runs
  // before anything below can touch the swarm (the probe adds the torrent).
  // NOT for a source the viewer just picked by hand on the detail page
  // (`_chosen`): "Other versions" is a deliberate choice of a different file.
  // location.replace keeps Back honest: no torrent url left in history to
  // bounce straight back here. Runs alongside the progress refresh — the two
  // are independent, and the probe window below shouldn't wait on either.
  const ownedP =
    isTorrent && !item._chosen && (item.imdbId || item.title)
      ? api
          .libraryFor({
            imdbId: item.imdbId,
            type: item.season != null && item.episode != null ? "series" : item.type,
            title: item.title,
            year: item.year,
            season: item.season,
            episode: item.episode,
          })
          .catch(() => null)
      : Promise.resolve(null);
  const [owned] = await Promise.all([ownedP, refreshProgress()]);
  if (location.hash !== entryHash) return;
  if (owned && owned.id) {
    location.replace(`#/play/${owned.id}${restart ? "?restart=1" : ""}`);
    return;
  }
  // A stream item on a server with "torrents": false (a Continue Watching
  // card from before the switch, a deep link): say so and go back, rather
  // than open a player whose every request the server will refuse.
  if (isTorrent && state.torrents === false) {
    toast("Streaming from sources is switched off on this server", "🚫");
    if (history.length > 1) return history.back();
    return navigate("#/");
  }

  // S2 probe-then-decide: for torrents, ask the server what the file's first
  // bytes actually SAY (streamprobe.js) — release tags are a guess and the
  // wild lies (unlisted AC-3 was S0's whole third act). Wait a beat for the
  // answer; a warm/prewarmed source answers in well under a second, a cold
  // swarm misses the window and the tag guess proceeds unchanged — the late
  // subscription further down corrects the path the moment truth arrives.
  let probeP = null;
  let probeResult = null;
  if (item.infoHash) {
    const probeIdx = parseInt(String(item.id || "").split("|")[2], 10) || 0;
    probeP =
      item._probePromise ||
      fetch(`/api/torrents/probe/${item.infoHash}/${probeIdx}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    const first = await Promise.race([
      probeP,
      new Promise((r) => setTimeout(() => r("__timeout"), 1500)),
    ]);
    if (first && first !== "__timeout") {
      probeResult = first;
      probeP = null; // consumed pre-play; no late correction needed
    }
  }

  // The user may have pressed Back (or navigated anywhere else) while the
  // awaits above were in flight — the router has already rendered the next
  // screen. Building the overlay now would orphan it on top of that screen
  // and leak every player listener/timer.
  if (location.hash !== entryHash) return;

  // Playing a file you asked the server to download is "opening" it: the
  // nav's "✓ ready" nudge for that job goes away, on every device of yours.
  if (state.profile && !isTorrent) {
    for (const job of readyDownloads()) {
      if (job.libraryId === item.id) api.downloadSeen(job.id, state.profile.id).catch(() => {});
    }
  }

  const isEpisode = !!item.showId;
  const title = isEpisode ? item.showTitle : item.title;
  const subtitleText = isEpisode
    ? `S${item.season} E${item.episode} · ${item.title}`
    : item.year || "";

  // Client-side forensics: path switches and far-seek outcomes land in the
  // same per-torrent perf record as the server's marks (routes/torrent.js
  // perf-mark), so a slow stream's whole story reads from one log. Torrent
  // streams only; fire-and-forget.
  const reportMark = (name, extra) => {
    if (!isTorrent || !item.infoHash) return;
    try {
      fetch(`/api/torrents/perf-mark/${item.infoHash}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ms: 0, ...extra }),
      }).catch(() => {});
    } catch {}
  };

  // Start-up forensics for library files (torrents have perf-mark): every
  // step from mount to first frame, with the milliseconds, in the server log
  // under [play] — so "it takes too long" comes with the step that took it.
  const t0 = performance.now();
  const playMarks = [];
  const mark = (name, extra = {}) => {
    const ms = Math.round(performance.now() - t0);
    playMarks.push({ name, ms, ...extra });
    if (isTorrent || item._offline) return;
    try {
      fetch(`/api/play-mark/${encodeURIComponent(item.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ms, ...extra }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  };
  mark("mount", { container: item.container || null, video: item.video && item.video.codec, audio: item.audio && item.audio.codec });
  setPlayingContext({ id: item.id, title: isEpisode ? `${item.showTitle} S${item.season}E${item.episode}` : item.title, marks: () => playMarks.slice() });

  // ---------- element tree ----------
  const video = el("video", {
    autoplay: true,
    preload: "auto",
    playsinline: true,
    // lets Safari hand the film to an Apple TV / AirPlay speaker (see airBtn)
    "x-webkit-airplay": "allow",
  });

  // AC-3 / E-AC-3 / DTS audio is silent in most desktop browsers (fine on
  // TVs). When the browser can't decode it, play through the server's
  // compat remux (HLS: video copied, audio -> AAC).
  // BOTH directions must be mapped: the bad codecs so they remux, and the
  // GOOD ones with their real RFC6381 strings — a bare "aac" gets "" from
  // canPlayType (it wants mp4a.40.2), which silently classed every probed
  // AAC stream as needs-remux and re-encoded perfectly playable audio
  // (found 2026-08-27 hunting elia's needless-transcode report).
  // (the tables and the rules live at module scope — see MIME / audioRemuxFor)
  const audioNeedsRemux = () => audioRemuxFor(item, video);

  // HEVC/AV1/10-bit video (typical of downloaded torrents) decodes fine on
  // TVs but not on most phones/desktops. The server records the library
  // file's video codec; each device decides for itself via canPlayType and
  // plays the server transcode when it can't decode the file directly.

  // The CONTAINER matters as much as the codec: an iPhone hardware-decodes
  // HEVC but can't demux MKV at all, so asking about the real container is
  // what lets the player start on the transcode immediately instead of
  // direct-playing into a stall and switching 6+ seconds later. Blink
  // (Chrome/TV WebView) answers x-matroska queries accurately; WebKit
  // returns "" for it, which is also the truth.
  const videoNeedsTranscode = () => videoTranscodeFor(item, video);

  // iPhone: play HLS through Safari's NATIVE pipeline, never MSE. iOS 17.1
  // added ManagedMediaSource, which flips Hls.isSupported() to true on
  // iPhone — but video.webkitEnterFullscreen() (the ONLY fullscreen an
  // iPhone has) is exactly what iOS 17.x breaks on MSE-backed elements
  // (InvalidStateError, or the native player opening audio-only). Native HLS
  // is the configuration iPhones always used before 17.1 and the one the
  // native player accepts. iPhone ONLY: desktop Safari keeps hls.js and the
  // patient torrent retry tuning below; canPlayType guards against a spoofed
  // UA on a browser with no native HLS.
  const nativeHlsOnly = nativeHlsFor(video);

  // Can this device DECODE the codec if we repackage into a container it
  // accepts? This is what separates the cheap COPY from the full h264 encode
  // (elia's iPhone report, 2026-08-26: every MKV stream re-encoded at swarm
  // speed because the container check alone said "can't play" — when the
  // phone hardware-decodes both h264 AND hevc, and only the MKV wrapper was
  // the problem). h264 8-bit is universal; HEVC rides on hardware and gets
  // fMP4 segments on native-HLS devices (Apple's requirement).
  const codecCopyable = (v) => copyableFor(v, video, nativeHlsOnly);

  let hls = null;
  // Rebuilds after a FATAL hls.js error (see the ERROR handler). Bounded per
  // BURST rather than for the whole session: four quick attempts, then an honest
  // message — but if the next failure comes more than a window later the budget
  // refreshes, so an outage that ends (server restarted, swarm woke up) is
  // picked up again instead of leaving the viewer on a dead screen forever.
  const HLS_MAX_RECOVERIES = 4;
  const HLS_RECOVERY_WINDOW_MS = 30000;
  let hlsRecoveries = 0;
  let lastRecoveryAt = 0;
  let hlsRecoverTimer = null;
  // Shared with the stall recovery block far below ("a stream that silently
  // stops") — declared HERE because startHls, seekTo and saveProgress touch
  // it, and startHls can run before the rest of this function has (the
  // start-up branches await). Nothing else may live in it.
  //  url      — what the current hls stream was built from (a rebuild re-asks it)
  //  inFlight — hls.js has a segment request out right now
  //  netAt    — when hls.js last did anything on the network
  //  hold     — {gen, pos, at, carded}: a rebuild is coming back to media time `pos`
  //  userAt   — when the viewer (or the party) last asked for a seek
  const stall = { url: null, lad: null, inFlight: false, netAt: 0, hold: null, userAt: 0 };
  const loadHlsScript = () =>
    new Promise((resolve, reject) => {
      if (window.Hls) return resolve();
      const s = document.createElement("script");
      s.src = "/js/vendor/hls.min.js";
      s.onload = resolve;
      s.onerror = reject;
      document.head.append(s);
    });

  // Start playback and cope with the browser refusing to.
  //
  // iOS (and Chrome without media engagement for this origin) blocks
  // programmatic playback of audible video unless it happens inside the tap
  // that asked for it — and by the time we get here the tap is long gone
  // (navigation + metadata fetch). The rejection used to be swallowed, leaving
  // a video that was fully buffered but paused, a play button drawn as "pause",
  // and — for torrents — the buffering overlay parked on top with nothing but a
  // Back button. That is the "buffer says it's buffered a lot but the video
  // does not play" report. Only NotAllowedError means "blocked": an AbortError
  // just means a newer source replaced this one mid-load.
  let playBlocked = false;
  const tryPlay = () => {
    const p = video.play();
    if (!p || !p.catch) return;
    // These handlers run as microtasks — i.e. after the whole synchronous body
    // of renderPlayer has run — so the controls they touch are initialized by
    // then even though startDirect/startTranscode are called further up.
    p.then(() => {
      playBlocked = false;
    }).catch((err) => {
      if (exited || !err || err.name !== "NotAllowedError") return;
      // The `autoplay` attribute can still have started playback even though
      // our explicit play() was refused (measured in Chrome) — don't tell
      // someone to press play while the film is already running.
      if (!video.paused) return;
      playBlocked = true;
      spinner.classList.add("hidden");
      playBtn.innerHTML = icons.play;
      showControls();
      toast("Tap play to start — your browser blocks autoplay", "▶️");
    });
  };

  const startDirect = () => {
    mark("path", { path: "direct" });
    video.src = item.videoUrl;
    tryPlay();
  };
  // ---- the quality ladder: hls.js levels (see ladderOn) ----
  // The levels hls.js holds, each named by what its playlist URL asks the
  // server for: h = 0 for the top rung (the copy, or the full encode), else
  // the capped height. hls.js sorts them by bitrate, lowest first.
  const ladderLevels = () => {
    if (!hls || !hls.levels) return [];
    return hls.levels.map((l, i) => {
      const u = l.uri || (Array.isArray(l.url) ? l.url[0] : l.url) || "";
      const v = (/[?&]v=([^&]+)/.exec(u) || [])[1] || "copy";
      const m = /^h264-(\d+)$/.exec(v);
      return { i, v, h: m ? +m[1] : 0 };
    });
  };
  const ladderIdx = (h) => {
    const l = ladderLevels().find((x) => x.h === h);
    return l ? l.i : -1;
  };
  // What a rebuild of the ladder stream should come back as: the same pick,
  // starting on the level it was playing.
  const ladderNow = () => {
    const cur = hls ? ladderLevels().find((l) => l.i === (hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel)) : null;
    return { pick: ladderPick, startH: cur ? cur.h : 0 };
  };
  // Data saver (Preferences → Data use) holds Auto under a height: 720p, or
  // 480p on a line measured as very thin. -1 = no ceiling.
  const ladderCapIdx = () => {
    if (dataMode() !== "saver") return -1;
    const top = playCap() || 720;
    const fits = ladderLevels().filter((l) => l.h && l.h <= top).sort((a, b) => b.h - a.h)[0];
    return fits ? fits.i : -1;
  };
  // A ladder whose top rung is the file's own HEVC and whose lower rungs are
  // H.264 is two codec families, and hls.js's automatic choice never crosses
  // from one to the other (QA, 2026-10-08: Auto sat on 720p with a 100 Mbit
  // line and never returned to Original). On such a ladder Auto is done here:
  // the highest level the measured line carries with room to spare.
  const ladderMixed = () => !!hls && new Set((hls.levels || []).map((l) => l.codecSet || "")).size > 1;
  const ladderBest = () => {
    const est = (hls && hls.bandwidthEstimate) || 0;
    const cap = ladderCapIdx();
    let best = 0;
    (hls.levels || []).forEach((l, i) => {
      if (cap >= 0 && i > cap) return;
      if ((l.bitrate || 0) * 1.4 <= est) best = Math.max(best, i);
    });
    return best;
  };
  // Apply a pick to the stream that is playing: "auto" hands the choice back
  // to hls.js; a height pins that level from the next segment on (what is
  // already buffered past it is dropped, so the change shows within seconds).
  // `first`: before anything has loaded — the level the stream STARTS on.
  // false when that level is not in this ladder.
  const ladderApply = (pick, { first = false, startH = 0 } = {}) => {
    if (!hls || !ladderOn) return false;
    const cap = ladderCapIdx();
    if (pick === "auto") {
      hls.autoLevelCapping = cap;
      if (first) {
        // start where the line can carry it (a slow line was measured before
        // the film was opened), never above the data-saver ceiling
        let i = ladderIdx(startH);
        if (i < 0) i = ladderIdx(0);
        if (cap >= 0 && i > cap) i = cap;
        if (i >= 0) hls.startLevel = i;
      } else hls.nextLevel = ladderMixed() ? ladderBest() : -1; // (drops what is buffered ahead, so Auto shows within seconds)
      ladderPick = "auto";
      return true;
    }
    const i = ladderIdx(pick);
    if (i < 0) return false;
    hls.autoLevelCapping = -1; // the viewer's own choice is not capped
    if (first) {
      hls.startLevel = i;
      hls.loadLevel = i;
    } else hls.nextLevel = i;
    ladderPick = pick;
    return true;
  };
  const ladderLabel = (h) => (h ? `${h}p` : "original");
  // The ladder's side of a new hls.js instance.
  const ladderWire = (h, gen, lad) => {
    const E = window.Hls.Events;
    let shown = null; // the level the corner chip last named
    h.on(E.MANIFEST_PARSED, () => {
      if (gen !== hlsGen || h !== hls) return;
      if (!h.levels || h.levels.length < 2) {
        // one rendition only (a small file, or no encoder free): an ordinary
        // jit stream — the old quality logic applies to it again
        ladderAsked = false;
        return;
      }
      ladderOn = true;
      const want = lad.pick != null ? lad.pick : "auto";
      if (!ladderApply(want, { first: true, startH: lad.startH || 0 })) ladderApply("auto", { first: true });
      mark("ladder", { levels: ladderLevels().map((l) => l.v).join(","), pick: String(ladderPick) });
      // Auto on a two-codec ladder (see ladderMixed): look every few seconds.
      // Up only with a healthy buffer and not twice in a quarter minute; down
      // as soon as the line no longer carries the level it is on.
      if (!ladderMixed()) return;
      let movedAt = 0;
      const iv = setInterval(() => {
        if (gen !== hlsGen || h !== hls) return void clearInterval(iv);
        if (!ladderOn || ladderPick !== "auto" || video.paused || video.seeking) return;
        const cur = h.loadLevel >= 0 ? h.loadLevel : h.currentLevel;
        const lv = h.levels[cur];
        if (!lv) return;
        const est = h.bandwidthEstimate || 0;
        const best = ladderBest();
        let ahead = 0;
        for (let i = 0; i < video.buffered.length; i++) {
          if (video.buffered.start(i) <= video.currentTime + 0.5 && video.buffered.end(i) > video.currentTime) ahead = video.buffered.end(i) - video.currentTime;
        }
        const now = Date.now();
        if (best > cur && ahead > 8 && now - movedAt > 15000) {
          movedAt = now;
          h.loadLevel = best;
        } else if (best < cur && est < (lv.bitrate || 0) * 1.1) {
          movedAt = now;
          h.loadLevel = best;
        }
      }, 3000);
    });
    h.on(E.LEVEL_SWITCHED, (_e, d) => {
      if (gen !== hlsGen || !ladderOn) return;
      const lv = ladderLevels().find((l) => l.i === d.level);
      if (!lv) return;
      const was = shown;
      shown = lv.h;
      if (was === null || was === lv.h) return; // the first level is not a change
      lastChangeAt = Date.now();
      // Auto moved: a small chip names where it went, as the step-down did
      if (ladderPick === "auto") {
        showQualityNote(`Auto ${ladderLabel(lv.h)}`);
        mark("abr", { to: lv.v, at: Math.round(effTime()) });
      }
    });
    // A lower rung the server cannot make right now (no encoder free: 503)
    // or at all (404): take it off the ladder rather than wait on it — the
    // rungs that remain play on. The top rung is the film itself and keeps
    // the ordinary recovery.
    h.on(E.ERROR, (_e, d) => {
      if (gen !== hlsGen || !ladderOn || !d) return;
      const code = d.response && d.response.code;
      if (code !== 503 && code !== 404) return;
      const at = d.frag ? d.frag.level : d.context && d.context.level != null ? d.context.level : d.level;
      const lv = ladderLevels().find((l) => l.i === at);
      if (!lv || !lv.h || h.levels.length < 2) return;
      mark("ladder-drop", { v: lv.v, code });
      if (ladderPick === lv.h) {
        ladderPick = "auto";
        toast("The server can't make that stream right now — back to automatic", "⚠️");
      }
      try {
        h.removeLevel(at);
        h.autoLevelCapping = ladderCapIdx();
        if (ladderPick === "auto") h.loadLevel = -1;
        else ladderApply(ladderPick);
      } catch {}
      if (h.levels.length < 2) ladderOn = false;
    });
  };

  // Every startHls call is a generation. The ERROR handler below schedules a
  // rebuild of ITS OWN url on a shared timer, so without this a playlist error
  // on the stream we are leaving would fire ~2s after a successful skip and
  // reload the OLD offset — playback jumped back and then stalled ("skip worked
  // and then everything went downhill"). A superseded generation must not touch
  // the player.
  let hlsGen = 0;
  // `startAt` is a position WITHIN this playlist (0 = its first segment, which is
  // content time streamOffset). Only the abandoned-stream restore passes it, to
  // put the viewer back where they were instead of at the start of the window.
  // ---- a quality change without the black gap ----
  // Changing the stream means tearing the old one down and building the new
  // one on the same <video>, and for the second or so in between the element
  // has nothing to show: black, then a spinner, then the film again. So the
  // last frame of the old stream is copied onto a canvas laid exactly over
  // the picture, and lifted (a quick fade) the moment the new stream presents
  // its first frame. The film appears to hold for a beat, then carries on.
  let holdNext = false; // the next startHls is a quality change: hold the frame
  let holdEl = null;
  const releaseHold = () => {
    if (!holdEl) return;
    const c = holdEl;
    holdEl = null;
    overlay.classList.remove("q-hold", "q-hold-slow");
    c.classList.add("out");
    setTimeout(() => c.remove(), 260);
  };
  const holdFrame = () => {
    if (holdEl || !video.videoWidth || video.readyState < 2) return;
    let c;
    try {
      const k = Math.min(1, 1920 / video.videoWidth);
      c = document.createElement("canvas");
      c.className = "player-hold";
      c.width = Math.round(video.videoWidth * k);
      c.height = Math.round(video.videoHeight * k);
      c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
      c.style.objectFit = getComputedStyle(video).objectFit || "contain";
    } catch {
      return; // a frame that can't be read is simply not held
    }
    video.after(c);
    holdEl = c;
    overlay.classList.add("q-hold");
    const done = () => {
      if (holdEl === c) releaseHold();
    };
    // the spinner stays out of it unless the new stream is really slow to come
    setTimeout(() => holdEl === c && overlay.classList.add("q-hold-slow"), 1500);
    // `loadeddata` is the NEW stream's (the old one fired its own long ago):
    // there is a frame to show; wait for it to actually reach the screen.
    video.addEventListener("loadeddata", () => {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(done);
      setTimeout(done, 400);
    }, { once: true });
    setTimeout(done, 15000); // never left over a film that is playing
  };

  // `lad`: this url is a ladder's master playlist — { pick, startH } (see
  // tryJitSwitch). Anything else is a single stream and the ladder is off.
  const startHls = (url, startAt = 0, lad = null) => {
    if (holdNext) {
      holdNext = false;
      holdFrame();
    }
    const gen = ++hlsGen;
    ladderAsked = !!lad;
    ladderOn = false;
    if (!lad) ladderPick = "auto";
    stall.lad = lad; // a rebuild of this stream is a ladder again (see ladderNow)
    stall.url = url; // (stall recovery) what a rebuild of this stream asks for
    stall.inFlight = false;
    stall.netAt = Date.now();
    excuseUntil = Date.now() + 15000; // a new stream buffers before it plays
    watchFrom = Date.now() + 6000; // ...and the line watcher lets it settle
    clearTimeout(hlsRecoverTimer);
    if (nativeHlsOnly) {
      // Same shape as the no-MSE fallback below. Skips loading the 530 KB
      // hls.js bundle on iPhones entirely. Legacy jobs bake the offset into
      // the playlist, so their startAt is 0 — but a jit stream is the WHOLE
      // movie, so a resume/switch position must become a native seek the
      // moment the timeline exists.
      if (hls) {
        try {
          hls.destroy();
        } catch {}
        hls = null;
      }
      video.src = url;
      if (startAt > 0) {
        const once = () => {
          video.removeEventListener("loadedmetadata", once);
          try {
            video.currentTime = startAt;
          } catch {}
        };
        video.addEventListener("loadedmetadata", once);
      }
      tryPlay();
      return;
    }
    loadHlsScript()
      .then(() => {
        if (exited || gen !== hlsGen) return;
        if (window.Hls && window.Hls.isSupported()) {
          if (hls) {
            try {
              hls.destroy();
            } catch {}
            hls = null;
            // Reset the element's resource state machine between instances:
            // detaching a MediaSource with a WELL-FED buffer and attaching a
            // fresh one wedges Chrome for ~20s (empty buffer, readyState 1,
            // then everything at once — reproduced 2026-08-26 on copy-seek
            // restarts fired after ~15s of playback; restarts fired early
            // never stalled). load() aborts the teardown synchronously —
            // same reset the exit cleanup already trusts.
            try {
              video.removeAttribute("src");
              video.load();
            } catch {}
          }
          // A torrent-backed transcode playlist can take 15-30s to first
          // respond (peer discovery + first segment). hls.js defaults time out
          // at ~10s and would give up before playback ever starts, so we make
          // manifest/fragment loading patient and retry generously.
          hls = new window.Hls({
            maxBufferLength: 45,
            // START AT THE BEGINNING OF THE PLAYLIST, not at its live edge.
            // Our transcode playlists have no #EXT-X-ENDLIST while ffmpeg is
            // still running, so hls.js classifies them as LIVE and defaults
            // (startPosition -1) to the live edge. Measured live 2026-07-25:
            // reopening a title whose transcode had been running a while
            // started playback 1193s in — the viewer landed ~20 min into the
            // film, played until it caught the growing edge, then stalled
            // ("re-buffering" forever). The playlist always begins exactly at
            // streamOffset, so position 0 IS where playback belongs; for a
            // finished (VOD) playlist this is the default anyway. Never -1.
            startPosition: startAt,
            // We manage subtitle <track>s ourselves; stop hls.js from also
            // auto-enabling one (which showed two subtitle tracks at once).
            subtitleDisplay: false,
            manifestLoadingTimeOut: 60000,
            manifestLoadingMaxRetry: 8,
            manifestLoadingRetryDelay: 2000,
            manifestLoadingMaxRetryTimeout: 60000,
            levelLoadingTimeOut: 60000,
            levelLoadingMaxRetry: 8,
            levelLoadingRetryDelay: 2000,
            fragLoadingTimeOut: 60000,
            fragLoadingMaxRetry: 8,
            fragLoadingRetryDelay: 2000,
          });
          hls.on(window.Hls.Events.ERROR, (_evt, data) => {
            // Recover from transient network/media errors instead of dying
            if (!data.fatal) return;
            if (exited || gen !== hlsGen) return; // we already moved on (see hlsGen)
            // A seek is in flight, so THIS is the stream being left behind. Its
            // buffer just ran dry, which on a cold source is expected: the swarm
            // is now feeding the seek's region, not this one. Rebuilding it here
            // re-requests the OLD offset, restarts it from the beginning of its
            // playlist (startPosition 0 — the picture jumps backwards) and takes
            // swarm bandwidth away from the seek the viewer is waiting for. That
            // thrash is what turned a slow skip into "it stopped and I had to go
            // out and back". Let it lie; if the seek fails we restore it.
            if (probing) {
              // Note that it died, so a failed seek knows to rebuild it (at the
              // frame the seek paused on) rather than leaving a dead player.
              abandonedFatal = true;
              spinner.classList.remove("hidden");
              if (isTorrent && item.infoHash) startTorrentOverlay(false);
              return;
            }
            if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError();
              return;
            }
            // Anything else fatal — most often the PLAYLIST itself failing
            // because the transcode hadn't started yet or had died. startLoad()
            // does not re-request the manifest, so the player used to sit on the
            // buffering overlay forever waiting for a stream that was never
            // coming (worst on uncached torrents, where the first playlist can
            // legitimately take a while). Rebuild the whole stream instead, a
            // bounded number of times, then say so honestly.
            // WHERE the rebuild comes back to. A jit stream is the whole film
            // on one playlist (media time = content time), so rebuilding it
            // with no position restarted the FILM at 0:00 after any fatal
            // network error. The position: the playhead (read again when the
            // rebuild really happens — what is buffered plays on until then);
            // or, when a rebuild is itself still coming back, where that one
            // was heading; or, before anything has played, where this stream
            // was asked to start. Other streams keep the old behaviour (0 =
            // the start of their own playlist, where their offset job begins).
            const held = stall.hold && stall.hold.gen === gen ? stall.hold.pos : 0;
            const ct = video.currentTime || 0;
            const wasAt = ct > 0.5 ? ct : held || startAt || 0;
            const rebuild = () => {
              // still this stream on the element? then its playhead is the truth
              const now = gen === hlsGen ? video.currentTime || 0 : 0;
              const backAt = !jitMode ? 0 : now > 0.5 ? now : wasAt;
              startHls(url, backAt, lad && ladderNow());
              // the same guard the stall rebuild uses: until the picture is
              // back there, saveProgress must not write the 0 the reset
              // element reports over the resume point (carded: this handler
              // has its own retries and card — the stall card stays out of it)
              if (backAt > 2) stall.hold = { gen: hlsGen, pos: backAt, at: Date.now(), carded: true };
            };
            // A failure well after the last one starts a fresh burst.
            const now = Date.now();
            if (now - lastRecoveryAt > HLS_RECOVERY_WINDOW_MS)
              hlsRecoveries = 0;
            lastRecoveryAt = now;
            if (hlsRecoveries >= HLS_MAX_RECOVERIES) {
              spinner.classList.add("hidden");
              stopTorrentOverlay();
              showErrorCard(
                isTorrent
                  ? "This source stopped answering. Aurora keeps trying in the background — or try again now."
                  : "The stream stopped answering. Aurora keeps trying in the background — or try again now.",
                () => {
                  hlsRecoveries = 0;
                  clearTimeout(hlsRecoverTimer);
                  rebuild();
                },
              );
              // Slow heartbeat: without it nothing would ever load again, so no
              // further error could fire and the window above could never
              // refresh — the screen would stay dead until the viewer acted.
              clearTimeout(hlsRecoverTimer);
              hlsRecoverTimer = setTimeout(() => {
                if (!exited) rebuild();
              }, HLS_RECOVERY_WINDOW_MS);
              return;
            }
            hlsRecoveries++;
            // Rebuilding resets the media element, so without this the viewer
            // stares at a blank player with no spinner and no explanation.
            spinner.classList.remove("hidden");
            if (isTorrent && item.infoHash) startTorrentOverlay(false);
            clearTimeout(hlsRecoverTimer);
            hlsRecoverTimer = setTimeout(() => {
              if (!exited) rebuild();
            }, 2000);
          });
          // (stall recovery) What the loader is doing, read off hls.js's own
          // events: a nudge or a rebuild must never interrupt a request that
          // is still in flight — on a slow line that request IS the progress.
          {
            const E = window.Hls.Events;
            const seen = (busy) => () => {
              if (gen !== hlsGen) return;
              stall.netAt = Date.now();
              if (busy !== null) stall.inFlight = busy;
            };
            if (E.FRAG_LOADING) hls.on(E.FRAG_LOADING, seen(true));
            for (const n of ["FRAG_LOADED", "FRAG_LOAD_EMERGENCY_ABORTED"]) if (E[n]) hls.on(E[n], seen(false));
            for (const n of ["MANIFEST_LOADING", "LEVEL_LOADING", "LEVEL_LOADED", "FRAG_BUFFERED"]) if (E[n]) hls.on(E[n], seen(null));
            // an error is activity too (hls.js is retrying); one that names a
            // segment means that request is over — the retry announces itself
            hls.on(E.ERROR, (_e, d) => {
              if (gen !== hlsGen) return;
              stall.netAt = Date.now();
              if (d && d.frag) stall.inFlight = false;
            });
          }
          if (lad) ladderWire(hls, gen, lad);
          hls.loadSource(url);
          hls.attachMedia(video);
          // Rare attach race (observed on copy-seek restarts, 2026-08-26):
          // the loader sits idle with an EMPTY buffer for ~20s, then appends
          // everything at once and plays fine — it always self-heals, so
          // this only shortens the hiccup. One bounded nudge: if nothing
          // buffered shortly after start, kick the loader once.
          setTimeout(() => {
            if (exited || gen !== hlsGen || !hls) return;
            if (video.buffered.length === 0) {
              try {
                hls.stopLoad();
                hls.startLoad(startAt || -1);
              } catch {}
            }
          }, 5000);
        } else {
          video.src = url; // Safari plays HLS natively
        }
        tryPlay();
      })
      .catch(() => startDirect());
  };

  // ---- offset-aware transcode (enables resume + seek on streams) ----
  // Three related-but-distinct numbers (S3 split them; conflating them is
  // what made copy-seeks impossible):
  //  • streamOffset — the JOB's requested offset: names the transcode URL.
  //  • clockBase    — content time at media position 0: h264 jobs re-encode
  //    a fresh 0-based timeline so clockBase = streamOffset; PTS-honest copy
  //    jobs (-copyts) keep the source clock so clockBase = 0 — the media
  //    clock IS the movie clock, scrubber and subtitles exact for free.
  //  • windowStart  — content time where the playlist's data begins (for
  //    copy jobs the keyframe/audio start the server publishes); the far-
  //    seek boundary below uses it.
  let streamOffset = 0;
  let clockBase = 0;
  let windowStart = 0;
  let usingTranscode = false;
  // Set by the exit cleanup; declared with the stream state because the
  // startup chain (tryJitSwitch) consults it before the UI wiring below.
  let exited = false;
  // "Still watching?": the run of self-started episodes that led to this one
  // (0 when a person started it). Any real input puts it back to 0.
  let autoRunN = autoRun.read(item.id);
  // True once THIS DEVICE actually failed to play a copy stream (media
  // error) — from then on no watchdog or probe "upgrade" may steer back to
  // copy, or a device that genuinely can't decode the codec ping-pongs
  // between copy and the h264 encode forever.
  let copyRefused = false;
  // S7: a JIT stream has ONE full-length playlist — no offset jobs exist, so
  // anything that speaks offset-URLs (keepAlive pings) must stand down.
  let jitMode = false;
  // THE QUALITY LADDER (2026-10-08). A library title played through hls.js
  // opens the jit stream by its MASTER playlist (…/jit/master.m3u8): the
  // file's video as it is — or the full encode, where this device cannot
  // decode it — with 720p and 480p encodes under it, every one cut on the
  // same segment boundaries. hls.js then moves between them by itself, up as
  // well as down, and a Quality pick is a level change inside the one stream
  // instead of a rebuild.
  //  ladderAsked — the stream on the element was opened by its master
  //  ladderOn    — …and it really has more than one level (known once the
  //                manifest is parsed): the menu and the picks talk to hls.js
  //  ladderPick  — "auto", or what the viewer pinned: 0 (original), 720, 480
  // An iPhone plays HLS natively and cannot pin a level, so it keeps the
  // single playlists and the rebuild for a manual pick — unless
  // localStorage["aurora-ladder-native"] = "1" asks to try the master there
  // (untested on a real phone; a file whose own codec is H.264 only, so
  // every rendition is the same codec family).
  let ladderAsked = false;
  let ladderOn = false;
  let ladderPick = "auto";
  let ladderNative = false;
  try { ladderNative = localStorage.getItem("aurora-ladder-native") === "1"; } catch {}
  // True while a seek is probing a new offset. Nothing may request the OLD
  // playlist during that window — the server would recreate that job and
  // supersede the one the seek is waiting for (see startTranscodeAt).
  let probing = false;
  // What a seek is waiting for, and since when — the buffering overlay reports
  // this so a slow skip reads as "working on it", not as a dead player.
  let seekWait = null; // {at, target}
  // Set when the stream we are LEAVING died fatally while a seek was in flight.
  // We don't rebuild it then (see the ERROR handler); if the seek ends up
  // failing, that flag is what brings it back.
  let abandonedFatal = false; // true once the held stream has died mid-seek
  let currentV = item.transcodeV || "h264";
  // Which of the file's audio streams plays (multi-dub releases): 0 is the
  // first. Rides every transcode URL as &a=; a change restarts the stream at
  // the current position with the other track mapped in (server-side — a
  // browser can't switch tracks inside one stream).
  let audioIdx = 0;
  // The original language first (elia, 2026-10-07): a multi-dub file starts
  // on the track the server marked `original` (TMDB's original language for
  // the title), not on whichever track the release happened to list first.
  // A track other than the first rides the transcode path with &a= — the
  // same restart an audio switch does, only from the start.
  {
    const tracks = item.audioTracks || [];
    const orig = tracks.find((t) => t.original);
    // …unless this viewer chose a dub last time: the language they picked in
    // the Audio menu follows the profile to every title that has it.
    // Compared as a LANGUAGE (lang.js), not as a string: "he" remembered on
    // one file is the "heb" track of the next.
    const liked = profilePick("audioLang");
    const mine = liked ? tracks.find((t) => sameAudio(t.language, liked)) : null;
    const pick = mine || orig;
    const oi = pick ? (pick.index != null ? pick.index : tracks.indexOf(pick)) : 0;
    if (oi > 0) audioIdx = oi;
  }
  // A height the stream is capped at — 720 or 480, 0 for the file as it is.
  // A slow line (net.js) starts a library title on a capped h264 encode: a
  // 1–2 Mbit/s stream that plays, where the untouched file (6–15 Mbit/s)
  // would only ever buffer. Rides ?v= as h264-720 / h264-480; the Quality
  // section of the settings menu changes it mid-film. Library files only —
  // a torrent stream is already limited by its swarm, not by this line.
  const canCap = !isTorrent && !item._offline && !!item.transcodeBase;
  // The file's own bitrate. A line that carries the file comfortably is never
  // capped, however it was classed: the picture is not given up, and the
  // server not asked to encode, for nothing.
  const fileKbps = item.sizeBytes && item.duration ? (item.sizeBytes * 8) / item.duration / 1000 : null;
  const lineCarriesFile = () => {
    const kbps = measured().kbps;
    return fileKbps != null && kbps != null && kbps >= fileKbps * 1.3;
  };
  // (Data saver is a choice about data, not about speed: it caps regardless.)
  let capH = canCap && (dataMode() === "saver" || !lineCarriesFile()) ? playCap() : 0;
  // Buffering right after a start, a seek or a stream change is by design;
  // stalls only count once this time has passed (see the step-down below).
  let excuseUntil = Date.now() + 15000;
  // The line watcher (further down) reads nothing into the first seconds of a
  // stream, or the seconds after a seek.
  let watchFrom = Date.now() + 6000;
  // Automatic quality (the start above, the mid-film step-down below) stops
  // the moment the viewer picks one themselves, or reverts.
  let autoQuality = canCap && dataMode() !== "full";
  let bootCapped = false; // the "lighter stream" pill is shown once the overlay exists
  const transcodeUrl = (ss, v) => {
    const vv = capH ? "h264" : v || currentV;
    // Native-HLS devices (iPhone) get fMP4 segments for copy jobs — Apple
    // requires them for HEVC-in-HLS, and they're fine for h264 too. HEVC in
    // fMP4 additionally MUST be tagged hvc1: ffmpeg's default (hev1) is the
    // other legal tag, and iOS refuses it (the black-screen "codec
    // unsupported" of 2026-08-26).
    const seg = nativeHlsOnly && vv === "copy" ? "&seg=fmp4" : "";
    const isHevc =
      (item.video && item.video.codec === "hevc") || item.videoCodecHint === "hevc";
    const vtag = seg && isHevc ? "&vtag=hvc1" : "";
    const a = audioIdx > 0 ? `&a=${audioIdx}` : "";
    const cap = capH && vv === "h264" ? `-${capH}` : "";
    return `${item.transcodeBase}/${Math.max(0, Math.floor(ss || 0))}/index.m3u8?v=${vv}${cap}${seg}${vtag}${a}`;
  };
  const startTranscode = (offset, v, { claimed = false, clock = null, startAt = 0 } = {}) => {
    streamOffset = Math.max(0, Math.floor(offset || 0));
    usingTranscode = true;
    // Any offset job means we've LEFT the jit world (e.g. the media-error
    // self-heal) — keepAlive must ping the new job again.
    jitMode = false;
    if (capH) v = "h264"; // a capped stream is always the encode
    if (v) currentV = v;
    const url = transcodeUrl(streamOffset, currentV);
    const isCopySeek = currentV === "copy" && streamOffset > 0;
    // PTS-honest copy jobs need the playlist's published clock (base +
    // start offset — see streamprobe.segmentStart for why two numbers)
    // before the scrubber can be trusted; if it can't be learned, fall back
    // to the exact 0-based h264 encode rather than play with a wrong clock.
    const beginH264Fallback = () => {
      currentV = "h264";
      const u2 = transcodeUrl(streamOffset, currentV);
      fetch(`${u2}&seek=1`, { cache: "no-store" }).catch(() => {});
      clockBase = streamOffset;
      windowStart = streamOffset;
      startHls(u2);
    };
    const begin = (c) => {
      // Two copy clocks (both measured 2026-08-26):
      // - hls.js/TS: -copyts keeps real timestamps; hls.js rebases media
      //   time to the segment's min PTS, so the published headers anchor an
      //   EXACT clock. No headers → the exact h264 encode instead.
      // - native/fMP4 (iPhone): Apple normalizes fMP4 to a zero-based
      //   timeline (and its fullscreen UI chokes on raw copyts stamps —
      //   elia's "crazy high numbers"), so those jobs ship WITHOUT copyts
      //   and the clock anchors at the requested offset like an h264 job:
      //   worst case one GOP of early-landing bias, sane native UI.
      if (isCopySeek && !nativeHlsOnly && !(c && isFinite(c.base))) return beginH264Fallback();
      if (isCopySeek && !nativeHlsOnly) {
        clockBase = c.base;
        windowStart = c.base;
        startHls(url, c.offset || 0);
      } else {
        clockBase = streamOffset;
        windowStart = streamOffset;
        // startAt: how far into this job to begin (a quality change that was
        // prepared a few seconds ahead and took over late) — 0 everywhere else
        startHls(url, startAt > 0 ? startAt : 0);
      }
    };
    // Claim this offset the way a seek does (see startTranscodeAt). Only a
    // &seek=1 request tells the server the VIEWER chose this position, and only
    // those retire an older job for the same file — without this, re-opening a
    // title at a resume point left the previous offset's ffmpeg holding a slot
    // until it idled out, which is what used to answer the next seek with
    // "busy transcoding". Fire-and-forget: hls.js gets the URL WITHOUT the flag,
    // so its own playlist refreshes can never retire anything. A far seek's
    // probe already WAS this exact request (claimed) — repeating it cost a
    // full extra pass through readyTorrent+ensure on the seek's critical path.
    if (claimed) return begin(clock);
    if (!isCopySeek) {
      fetch(`${url}&seek=1`, { cache: "no-store" }).catch(() => {});
      return begin(null);
    }
    // Unclaimed copy-at-offset (boot resume): the claim response carries the
    // clock headers — await it; the playlist production gates playback anyway.
    // (bounded: a claim that never answers used to hold `probing` up and with
    // it the "Playback stopped" card, indefinitely)
    fetch(`${url}&seek=1`, { cache: "no-store", signal: AbortSignal.timeout(20000) })
      .then((res) => begin(res.ok ? clockFromHeaders(res) : null))
      .catch(() => beginH264Fallback());
  };

  // Play another of the file's audio tracks: restart at the current
  // position through the transcode path with &a=N. A direct-played file
  // moves onto the copy path (repackaged at stream speed, no re-encode) —
  // unless this device can't decode its video, in which case h264.
  const switchAudio = (idx) => {
    if (idx === audioIdx) return closeMenu();
    if (seekLocked()) return;
    audioIdx = idx;
    {
      const t = (item.audioTracks || []).find((x, i) => (x.index != null ? x.index : i) === idx);
      if (t && audioPick(t.language)) rememberPick("audioLang", audioPick(t.language));
    }
    closeMenu();
    showControls();
    if (!item.transcodeBase) item.transcodeBase = isTorrent ? item.transcodeBase : `/stream/transcode/${item.id}`;
    const at = effTime();
    let v = usingTranscode && !jitMode ? currentV : "copy";
    if (v === "copy" && item.video && videoNeedsTranscode() && !codecCopyable(item.video)) v = "h264";
    const t = (item.audioTracks || []).find((x, i) => (x.index != null ? x.index : i) === idx);
    toast(`Audio: ${audioTrackName(t || {}, idx)}`, "🔈");
    track("feat", { f: "audio_track" });
    // On the ladder the other track is the same full-timeline stream with
    // &a= (every rendition carries it): the pick and the quality stay as
    // they are. Otherwise — and when the ladder cannot be had — the offset
    // job, as before.
    if (ladderEligible() && !capH) {
      const keep = ladderOn ? ladderNow() : null;
      tryJitSwitch(at, keep).then((ok) => {
        if (!ok) startTranscodeAt(at, v, { fallbackToZero: true });
      });
      return;
    }
    startTranscodeAt(at, v, { fallbackToZero: true });
  };

  // Change the stream's quality mid-film: a capped 720p / 480p encode for a
  // slow line, or back to the file as it is. Same restart-at-this-spot as an
  // audio switch.
  let showQualityNote = () => {}; // the corner chip — bound further down, with the pill
  let lastChangeAt = Date.now(); // when the quality last changed, by anyone
  const switchQuality = (h) => {
    if (h === (ladderOn ? ladderPick : capH)) return closeMenu();
    if (seekLocked()) return;
    // the viewer chose — nothing changes it behind them now (choosing Auto
    // on a ladder gives the choice back)
    autoQuality = h === "auto" ? canCap && dataMode() !== "full" : false;
    closeMenu();
    showControls();
    track("feat", { f: h === "auto" ? "quality_auto" : h ? `quality_${h}` : "quality_original" });
    applyQuality(h);
  };
  // The change itself — the viewer's (above) or the line watcher's step back
  // up (`auto`). No message box either way: a small chip in the corner names
  // the quality for a moment, and that is all.
  const applyQuality = (h, { auto = false } = {}) => {
    // A file this device plays as it is: "Original" is plain direct play,
    // ladder or no ladder (further down).
    const directOk = !!item.videoUrl && audioIdx === 0 && !videoNeedsTranscode() && !audioNeedsRemux();
    // ON THE LADDER a quality is a level of the stream that is playing: no
    // rebuild, no gap. (What cannot be a level — Original on a file that
    // direct-plays, a rung the server took away — goes on below.)
    // (Original stays a level too, even where the file would direct-play:
    // leaving the ladder for it took Auto out of the menu until another
    // quality had been picked — QA, 2026-10-08. The top rung IS the file's
    // video, copied.)
    if (ladderOn && hls) {
      if (ladderApply(h)) {
        lastChangeAt = Date.now();
        return void showQualityNote(h === "auto" ? "Auto" : h ? `${h}p` : "Original");
      }
    }
    if (h === "auto") return; // only a ladder has an Auto
    const was = capH;
    lastChangeAt = Date.now();
    const at = effTime();
    const note = `${auto ? "Auto " : ""}${h ? `${h}p` : auto ? "original" : "Original"}`;
    // the rebuild onto a capped offset job — the path before the ladder, and
    // still the one for an iPhone, a file with no index, a busy server
    const viaRebuild = () => {
      capH = h;
      startTranscodeAt(at, "h264", { quiet: true, live: true }).then((ok) => {
        if (ok) return void showQualityNote(note);
        capH = was;
        if (!auto) toast("The server can't make that stream right now — staying as it is", "⚠️");
      });
    };
    if (h) {
      if (!ladderEligible()) return void viaRebuild();
      // not on a ladder yet (direct play, a single stream): open the ladder
      // with this quality pinned; from then on every change is a level change
      capH = 0;
      holdNext = true;
      tryJitSwitch(at, { pick: h }).then((ok) => {
        if (ok) return void showQualityNote(note);
        holdNext = false;
        capH = was;
        viaRebuild();
      });
      return;
    }
    capH = 0;
    showQualityNote(note);
    holdNext = true; // whichever path below rebuilds the stream holds the frame
    // A file this device plays as it is goes back to plain direct play — the
    // server does nothing at all for it.
    if (item.videoUrl && audioIdx === 0 && !videoNeedsTranscode() && !audioNeedsRemux()) {
      ++hlsGen;
      clearTimeout(hlsRecoverTimer);
      if (hls) {
        try { hls.destroy(); } catch {}
        hls = null;
      }
      usingTranscode = false;
      jitMode = false;
      ladderAsked = false;
      ladderOn = false;
      ladderPick = "auto";
      streamOffset = 0;
      clockBase = 0;
      windowStart = 0;
      excuseUntil = Date.now() + 15000;
      watchFrom = Date.now() + 6000;
      mark("path", { path: "direct", from: at });
      holdNext = false;
      holdFrame();
      video.addEventListener("loadedmetadata", () => {
        try { video.currentTime = at; } catch {}
        tryPlay();
      }, { once: true });
      video.src = item.videoUrl;
      return;
    }
    // back to the untouched picture: the copy path when this device decodes
    // the file's video (jit first — every seek native), the full encode when not
    const copyOk = !copyRefused && (!item.video || !videoNeedsTranscode() || codecCopyable(item.video));
    // (the viewer asked for Original: on a ladder that is its top rung, pinned)
    const pin = auto ? null : { pick: 0 };
    if (!copyOk) {
      // the full encode: as the top of a ladder when there can be one
      if (!ladderEligible()) return void startTranscodeAt(at, "h264", { fallbackToZero: true, quiet: true, live: true });
      tryJitSwitch(at, pin).then((ok) => {
        if (!ok) {
          holdNext = false;
          startTranscodeAt(at, "h264", { fallbackToZero: true, quiet: true, live: true });
        }
      });
      return;
    }
    tryJitSwitch(at, pin).then((ok) => {
      if (!ok) {
        holdNext = true;
        startTranscodeAt(at, "copy", { fallbackToZero: true, quiet: true });
      }
    });
  };

  // The PTS-honest clock published by copy-at-offset playlist responses.
  const clockFromHeaders = (res) => {
    const base = parseFloat(res.headers.get("X-Aurora-Base"));
    const offset = parseFloat(res.headers.get("X-Aurora-Offset"));
    return isFinite(base) ? { base, offset: isFinite(offset) ? offset : 0 } : null;
  };

  // Restart the transcode at an absolute content time — but PROBE the
  // playlist first, so a point the server can't serve yet (bytes not
  // downloaded) leaves current playback untouched instead of killing it.
  // Resolves true if playback was switched, false if the point isn't ready.
  let probeToken = 0;
  const startTranscodeAt = async (
    target,
    v,
    { fallbackToZero = false, quiet = false, live = false } = {},
  ) => {
    // LIVE (a quality change onto an encode — an exact, 0-based timeline): the
    // film keeps playing what it has while the new stream is made. The new one
    // is asked to begin three seconds AHEAD of the playhead, and takes over
    // when the playhead gets there — nothing replayed, nothing skipped, and no
    // spinner over a picture that is still moving. A film that is paused or
    // already stalled has nothing to keep playing, so it changes on the spot.
    const liveMode = live && v === "h264";
    const moving = liveMode && !video.paused && !video.seeking && video.readyState >= 3;
    const ss = liveMode
      ? Math.max(0, moving ? Math.ceil(target + 3) : Math.floor(target))
      : Math.max(0, Math.floor(target) - 2);
    const token = ++probeToken;
    if (!quiet) spinner.classList.remove("hidden");
    // Keep the CURRENT stream loading while we probe. Pausing its loading (tried
    // 2026-07-25 via hls.stopLoad, to stop its playlist polls from superseding
    // the job this seek wants) meant a slow seek drained the buffer and playback
    // died mid-wait — "it kept playing until it stopped and just sat there
    // loading". The supersede race is handled server-side instead, by refusing
    // to kill a job that was only just created.
    probing = true;
    seekWait = { at: Date.now(), target };
    try {
      // &seek=1 tells the server this is the viewer deliberately moving, not a
      // background playlist refresh — the only kind of request allowed to
      // re-create an offset the server just retired (so skipping forward and
      // straight back still works). hls.js loads the URL WITHOUT it.
      const res = await fetch(`${transcodeUrl(ss, v || currentV)}&seek=1`);
      if (exited || token !== probeToken) return true;
      if (!res.ok) throw new Error("not ready");
      // The probe above was the claim; a PTS-honest copy playlist's clock
      // rides its response headers.
      const clock = clockFromHeaders(res);
      let startAt = 0;
      if (liveMode) {
        // The claim has retired the old job on the server: stop the old
        // stream asking for more (it would only collect errors) and let it
        // play out what it already holds until the hand-over point.
        try { if (hls) hls.stopLoad(); } catch {}
        const t0 = Date.now();
        while (
          !exited && token === probeToken && !video.paused && !video.seeking &&
          video.readyState >= 3 && effTime() < ss - 0.05 && Date.now() - t0 < 6000
        ) await new Promise((r) => setTimeout(r, 50));
        if (exited || token !== probeToken) return true;
        // late to the hand-over (a slow probe): begin that far into the new stream
        startAt = effTime() - ss;
        if (!(startAt > 0 && startAt < 30)) startAt = 0;
        holdNext = true;
      }
      startTranscode(ss, v, { claimed: true, clock, startAt });
      return true;
    } catch {
      if (exited || token !== probeToken) return true;
      if (fallbackToZero) {
        startTranscode(0, v);
        return true;
      }
      holdNext = false;
      spinner.classList.add("hidden");
      return false;
    } finally {
      if (token === probeToken) {
        probing = false;
        seekWait = null;
      }
    }
  };

  // S7: move playback (library or torrent) onto the jit full-timeline stream
  // at an absolute content time — one COMPLETE playlist, segments on demand,
  // every future seek native. Native-HLS devices (Apple) get fMP4 segments
  // (+hvc1 tag for HEVC); hls.js gets TS. The producer copies the video, so
  // only codecs this device decodes qualify; resolves false when jit can't
  // serve (wrong container, no index) and the caller keeps the legacy flow.
  //
  // THE LADDER: a library title on hls.js asks for the MASTER playlist of
  // that same stream instead (see ladderOn). `lad` says how it should start:
  //   { startH }  automatic, beginning on that height (a slow line)
  //   { pick }    pinned by the viewer: 0 = original, 720, 480
  //   { plain }   the single playlist, no ladder (a manual pick on an iPhone)
  // The master can also carry what the single playlist cannot: the full
  // encode as its top rung (a codec this device cannot decode — every seek
  // native there too) and the file's other audio tracks.
  const ladderEligible = () => canCap && !!item.id && (!nativeHlsOnly || ladderNative);
  const tryJitSwitch = async (fromSec, lad = null) => {
    const isHevc =
      (item.video && item.video.codec === "hevc") || item.videoCodecHint === "hevc";
    const undecodable = !isTorrent && !!item.video && videoNeedsTranscode() && !codecCopyable(item.video);
    // the top rung: the file's video, or the encode when that cannot play here
    const top = undecodable || copyRefused ? "h264" : "copy";
    let useLadder = ladderEligible() && !(lad && lad.plain);
    // a height the viewer pinned (0 = original), or null for automatic
    const pinned = lad && typeof lad.pick === "number" ? lad.pick : null;
    const startH = (lad && lad.startH) || 0;
    // native HLS does not adapt across codec families, and cannot be pinned
    if (useLadder && nativeHlsOnly && (top !== "copy" || isHevc || pinned != null || !autoQuality)) useLadder = false;
    // A copied HEVC top over H.264 rungs is a ladder of two codecs. hls.js
    // changes codec between levels where the browser's MediaSource can
    // (SourceBuffer.changeType); without it, the single stream as before.
    if (useLadder && top === "copy" && isHevc && !ladderMixedOk()) useLadder = false;
    if (!useLadder) {
      // the single jit playlist, exactly as before the ladder
      if (copyRefused) return false; // jit IS a copy stream — escalations are one-way
      if (audioIdx > 0) return false; // the single playlist carries the first audio track only
      if (capH) return false; // jit copies the file's own video — a capped stream can't be one
      if (pinned || startH) return false; // a lower quality needs the ladder (or the rebuild)
    }
    if (isTorrent) {
      // The probe normalizes ffprobe's "matroska,webm" to "mkv"; accept both.
      if (!/matroska|mkv/i.test(item.container || "")) return false;
      if (!codecCopyable(item.video || {})) return false;
    } else if (undecodable && !useLadder) {
      return false; // truly undecodable here — needs the real h264 encode
    }
    const base = isTorrent ? item.transcodeBase : `/stream/transcode/${item.id}`;
    const q = [
      nativeHlsOnly && "seg=fmp4",
      nativeHlsOnly && isHevc && top === "copy" && "vtag=hvc1",
      useLadder && top === "h264" && "top=h264",
      useLadder && audioIdx > 0 && `a=${audioIdx}`,
    ].filter(Boolean).join("&");
    const jitUrl = `${base}/jit/${useLadder ? "master" : "index"}.m3u8${q ? `?${q}` : ""}`;
    try {
      const r = await fetch(jitUrl, { cache: "no-store" });
      if (!r.ok) {
        // no ladder for this file right now (no encoder free, no index): the
        // single playlist is still worth asking where it could play
        if (useLadder && !pinned && !startH) return tryJitSwitch(fromSec, { plain: true });
        return false;
      }
      if (useLadder && pinned) {
        // the pinned quality has to be one of the rungs offered
        const text = await r.text();
        if (!text.includes(`v=h264-${pinned}`)) return false;
      }
    } catch {
      return false;
    }
    if (exited) return true; // switched-to-nothing: just don't start legacy
    mark("path", { path: useLadder ? "ladder" : "jit", from: fromSec || 0 });
    usingTranscode = true;
    jitMode = true;
    currentV = top === "h264" && useLadder ? "h264" : "copy";
    if (useLadder) capH = 0; // the ladder's levels are the quality now
    streamOffset = 0;
    clockBase = 0;
    windowStart = 0;
    startHls(jitUrl, Math.max(0, fromSec || 0), useLadder ? { pick: pinned != null ? pinned : "auto", startH } : null);
    return true;
  };
  // Can this browser move between an HEVC level and an H.264 one in one
  // stream? (MediaSource with changeType — hls.js uses it for exactly this.)
  const ladderMixedOk = () => {
    try {
      const MS = window.ManagedMediaSource || window.MediaSource;
      const SB = window.ManagedSourceBuffer || window.SourceBuffer;
      return !!(MS && SB && SB.prototype && typeof SB.prototype.changeType === "function");
    } catch {
      return false;
    }
  };

  // Resume point (baked into the transcode's start offset for streams, applied
  // as a native seek for direct/library playback).
  // This exact file/torrent first, else the title's shared history (the same
  // episode watched from another source resumes where it stopped).
  const prog0 = progressFor(item.id) || titleProgressFor(item);
  const resumeAt =
    !restart &&
    prog0 &&
    !prog0.finished &&
    prog0.position > 10 &&
    (!item.duration || prog0.position < item.duration - 20)
      // four seconds early: you come back mid-sentence otherwise, and the
      // last thing you saw is the first thing you see (2026-10-07)
      ? Math.max(0, Math.floor(prog0.position) - 4)
      : 0;

  // Probe data replaces the tag guess THROUGH the same fields library items
  // carry, so the one set of capability functions decides for both. For
  // torrents the verdict is folded back into needsTranscode/transcodeV so
  // the torrent-specific start logic below (prefetch warm, fallbackToZero)
  // keeps owning the flow — only the truth feeding it changes.
  const applyProbe = (p) => {
    if (!p) return false;
    if (p.container) item.container = p.container;
    if (p.video) item.video = p.video;
    const a = (p.audioStreams || [])[0];
    if (a) item.audio = { codec: a.codec };
    // a choice of dubs: the settings menu lists them (one track = nothing to pick)
    if ((p.audioStreams || []).length > 1) item.audioTracks = p.audioStreams;
    return !!(p.video || a);
  };
  if (probeResult && isTorrent && applyProbe(probeResult)) {
    const needV = videoNeedsTranscode();
    const needA = audioNeedsRemux();
    item.needsTranscode = needV || needA;
    // Container-only problem with a decodable codec → COPY (repackage at
    // stream speed); the full encode only when the device truly can't decode.
    item.transcodeV = needV
      ? codecCopyable(item.video) ? "copy" : "h264"
      : needA ? "copy" : item.transcodeV;
  }

  // A slow line: try the capped stream first. The request below is the same
  // claim a seek makes; if the server can't do it (no ffmpeg, both encode
  // slots taken) the cap is dropped and the title plays the way it always did.
  let cappedStart = false;
  if (capH && ladderEligible() && !item._offline) {
    // The ladder first: the same stream, begun on the lighter level, and
    // free to climb when the line turns out better than it measured.
    const want = capH;
    const waiting = el("div", { class: "player" }, el("div", { class: "spinner" }));
    root.append(waiting);
    let ok = false;
    try { ok = await tryJitSwitch(resumeAt, { startH: want }); } catch {}
    waiting.remove();
    if (location.hash !== entryHash) return; // left while waiting
    if (ok && !exited) {
      mark("decision", { why: `slow line (${netTier()}) → ladder from ${want}p` });
      cappedStart = true;
      track("feat", { f: `quality_auto_${want}` });
    } else if (!ok) capH = want;
  }
  if (capH && !cappedStart) {
    const ss = Math.max(0, resumeAt - 2);
    // The overlay isn't built yet, and the server may take a few seconds to
    // produce the first segment: show a spinner meanwhile, and give up after
    // 25 s (the server itself abandons a job that hasn't started in 20).
    const waiting = el("div", { class: "player" }, el("div", { class: "spinner" }));
    root.append(waiting);
    const ctl = new AbortController();
    const giveUp = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(`${transcodeUrl(ss, "h264")}&seek=1`, { cache: "no-store", signal: ctl.signal });
      if (location.hash !== entryHash) { clearTimeout(giveUp); waiting.remove(); return; }
      if (res.ok && !exited) {
        mark("decision", { why: `slow line (${netTier()}) → ${capH}p` });
        startTranscode(ss, "h264", { claimed: true });
        cappedStart = true;
        bootCapped = true;
        track("feat", { f: `quality_auto_${capH}` });
      }
    } catch {}
    clearTimeout(giveUp);
    waiting.remove();
    if (location.hash !== entryHash) return; // left while waiting
    if (!cappedStart) capH = 0;
  }

  const usingRemux = audioNeedsRemux(); // library file with undecodable audio
  // The !isTorrent guards below preserve flow ownership: torrents ALWAYS go
  // through their own branch (prefetch warm + fallbackToZero on resume) —
  // before the probe existed they had no item.video/audio so these library
  // branches never matched a torrent; the guard keeps that invariant now
  // that probe data fills those fields.
  if (cappedStart || exited) {
    // already playing the capped stream (or the player closed while asking)
  } else if (item._offline) {
    // The saved copy was made playable for this device (offline.js); play it.
    startDirect();
  } else if (
    !isTorrent &&
    !nativeHlsOnly &&
    item.video && item.video.codec === "hevc" &&
    /mkv|matroska/i.test(item.container || "") &&
    codecCopyable(item.video)
  ) {
    mark("decision", { why: "hevc-in-mkv → copy first" });
    const jitOk = await tryJitSwitch(resumeAt);
    if (!jitOk) startTranscode(resumeAt, "copy");
  } else if (!isTorrent && videoNeedsTranscode()) {
    // Library file this device can't play directly. The file is complete on
    // disk, so resuming at the saved position works (unlike torrent streams,
    // where the bytes at an arbitrary offset may not be downloaded yet).
    // When only the CONTAINER is the problem (h264/HEVC-in-MKV on an
    // iPhone), jit copies it onto the full timeline (S7c: fMP4 there, so
    // Apple's fullscreen can scrub the whole film); the legacy copy job is
    // the fallback, and everything undecodable gets the real h264 encode.
    const copyOk = codecCopyable(item.video || {});
    const jitOk = copyOk ? await tryJitSwitch(resumeAt) : false;
    // About to encode live — is there a play-ready copy the server made
    // when this was downloaded (media/preconvert.js)? Then play that: it
    // starts at once, seeks natively and costs the server nothing. One small
    // request, only on this path; anything but "ready" changes nothing.
    let prepared = false;
    if (!jitOk && !copyOk) {
      try {
        const st = await api.offlineStatus(item.id, "1080", false);
        if (st && st.state === "ready" && st.url && !st.direct && !exited) {
          mark("decision", { why: "play-ready copy on the server" });
          item.videoUrl = st.url;
          prepared = true;
          startDirect();
        }
      } catch {}
    }
    // Still to be encoded live: as the top rung of a ladder when there can be
    // one (the whole film on one timeline, lighter rungs under it), else the
    // offset job as always.
    const ladOk = !jitOk && !prepared && !copyOk && ladderEligible() ? await tryJitSwitch(resumeAt) : false;
    if (!jitOk && !prepared && !ladOk) startTranscode(resumeAt, copyOk ? "copy" : "h264");
  } else if (!isTorrent && usingRemux) {
    // Undecodable AUDIO only. S7 JIT first: one COMPLETE playlist (exact
    // duration + boundaries from the file's own index), segments made on
    // demand — every seek becomes a native in-window seek over the whole
    // film, no offset jobs at all. If the file has no usable index (503),
    // fall through to the classic flow: the offset-aware copy transcode,
    // which fixes the audio and makes resume + far-seek work.
    const jitOk = await tryJitSwitch(resumeAt);
    if (!jitOk) {
      if (item.transcodeBase) startTranscode(resumeAt, "copy");
      else startHls(item.hlsUrl);
    }
  } else if (isTorrent && item.needsTranscode && item.transcodeBase) {
    // Known-undecodable torrent codec (HEVC/AV1/DTS…). Resume at the saved
    // position: the server-side seek reads the torrent through the blocking
    // Range route, so any position works at swarm speed; prefetchRegion just
    // warms the estimated byte region. Falls back to 0 if the swarm can't
    // deliver in time. Deferred a tick: these touch bindings initialized
    // further down this function.
    // S7b JIT first — tryJitSwitch only accepts probe-confirmed copy-safe
    // MKVs, so every stream it declines (unknown container, cold probe,
    // non-copyable codec) keeps the proven legacy flow untouched. Streams
    // that start legacy get their jit chance when the late probe answers.
    const jitOk = await tryJitSwitch(resumeAt);
    if (jitOk && resumeAt > 0)
      // Deferred a tick: prefetchRegion is declared further down this
      // function (same reason the legacy branch defers).
      setTimeout(() => {
        if (!exited) prefetchRegion(resumeAt); // fire-and-forget warmup
      }, 0);
    if (!jitOk) {
      if (resumeAt > 0) {
        setTimeout(() => {
          if (exited) return;
          prefetchRegion(resumeAt); // fire-and-forget warmup
          startTranscodeAt(resumeAt, item.transcodeV, { fallbackToZero: true });
        }, 0);
      } else {
        startTranscode(0, item.transcodeV);
      }
    }
  } else {
    startDirect();
  }

  // Auto-fallback to the server transcode when direct playback turns out to be
  // undecodable — either a hard decode error or a decode stall (data buffered
  // ahead but the clock frozen). Resumes from the current point. Applies to
  // torrent streams AND library files (canPlayType can lie about hw decoding);
  // not when playback already started on the transcode.
  // (needsTranscode torrents start on the transcode a tick later — usingTranscode
  // is still false here, so exclude them explicitly or the watchdogs would arm.)
  const canFallback =
    !usingTranscode &&
    !!item.transcodeBase &&
    !(isTorrent && item.needsTranscode);
  let stallTimer = null;
  let switchedToTranscode = false;
  const fallbackToTranscode = () => {
    if (switchedToTranscode || !canFallback) return;
    switchedToTranscode = true;
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
    // A direct-play stall is very often the CONTAINER or the audio track
    // (this Chrome can't decode AC-3/E-AC-3 at all), not the video codec —
    // measured 2026-08-27 hunting elia's "h264 was encoded for me": the
    // watchdog hard-coded h264 and burned CPU on video this device
    // hardware-decodes. When the probe has told us the video is copyable,
    // the copy remux (new container + AAC audio) fixes everything a stall
    // like that can mean — and if the video itself was the problem, the
    // media-error self-heal escalates copy → h264 anyway.
    const wantV = !copyRefused && item.video && codecCopyable(item.video) ? "copy" : "h264";
    toast(
      wantV === "copy"
        ? "Repackaging this stream for your device…"
        : "This encode won't decode here — switching to transcode…",
      "⚙️",
    );
    reportMark("client_switch", { reason: "decode-stall", to: wantV, position: effTime() });
    // Resume from where the direct stream died (those bytes are downloaded —
    // we were just playing them); fall back to 0 only if the seek-job fails.
    const at = effTime();
    if (wantV === "copy") {
      tryJitSwitch(at).then((ok) => {
        if (!ok) startTranscodeAt(at, "copy", { fallbackToZero: true });
      });
    } else {
      startTranscodeAt(at, "h264", { fallbackToZero: true });
    }
  };

  if (canFallback) {
    let lastCT = -1,
      stalls = 0;
    stallTimer = setInterval(() => {
      if (exited || switchedToTranscode) return;
      const ct = video.currentTime;
      const ahead =
        video.buffered.length &&
        video.buffered.end(video.buffered.length - 1) - ct > 3;
      // frozen clock WITH data waiting ahead = decode stall (not a peer stall)
      if (!video.paused && ahead && ct === lastCT) {
        if (++stalls >= 3) { mark("stall-switch", { at: ct }); fallbackToTranscode(); } // ~3s
      } else {
        stalls = 0;
      }
      lastCT = ct;
    }, 1000);
  }

  // Keep the server-side halves of this playback alive for as long as the
  // player is open — including while PAUSED, when nothing else requests
  // anything:
  //  • the torrent: evicted after 30 min untouched, destroying its pieces (a
  //    pause over dinner used to mean re-downloading from scratch).
  //  • the transcode: ffmpeg is killed after 2.5 min with no segment request,
  //    and its directory deleted. hls.js stops fetching once its 45s buffer is
  //    full, so a stream paused (or simply well-buffered) for that long lost its
  //    transcode and stalled permanently on resume. Re-requesting the playlist
  //    marks the job in use — and revives it if it was already reaped.
  const keepAlive = setInterval(() => {
    if (exited) return;
    if (isTorrent && item.infoHash)
      fetch(`/api/torrents/status/${item.infoHash}`).catch(() => {});
    // Never ping the old offset mid-seek — that request would supersede the
    // job the seek is waiting on.
    if (usingTranscode && !probing && !jitMode)
      fetch(transcodeUrl(streamOffset, currentV), { cache: "no-store" }).catch(
        () => {},
      );
  }, 60000);

  // Silent-audio watchdog: some encodes carry AC-3/DTS the release name never
  // advertised — the browser plays the video fine and the audio is just
  // silent. Chrome counts decoded audio bytes; still zero after ~6s of real
  // playback means no audio is being produced at all → switch to the
  // audio-only compat transcode (video copied, cheap), keeping the position.
  let audioProbe = null;
  if (canFallback) {
    audioProbe = setInterval(() => {
      if (exited || usingTranscode || switchedToTranscode) {
        clearInterval(audioProbe);
        return;
      }
      // 3s of REAL playback is plenty for the audio pipeline to have decoded
      // its first bytes if it ever will — the old 6s threshold just meant 6
      // silent seconds before the inevitable switch (S0 measured 6.8s).
      if (video.paused || video.currentTime < 3) return;
      clearInterval(audioProbe); // one-shot: decide once real playback ran
      const dec = video.webkitAudioDecodedByteCount;
      if (typeof dec === "number" && dec === 0) {
        switchedToTranscode = true;
        if (stallTimer) {
          clearInterval(stallTimer);
          stallTimer = null;
        }
        toast("This encode's audio can't play here — switching sound…", "🔇");
        reportMark("client_switch", { reason: "silent-audio", to: "copy", position: effTime() });
        startTranscodeAt(effTime(), "copy", { fallbackToZero: true });
      }
    }, 1000);
  }

  // Late probe arrival (the 1500ms pre-play window missed — cold swarm):
  // the moment the file's real codecs are known, correct the path NOW with
  // the honest toast, instead of letting the viewer sit through silent audio
  // until the byte-counting watchdog concludes the same thing.
  if (probeP) {
    probeP.then((p) => {
      if (exited) return;
      if (!applyProbe(p)) return;
      // usingTranscode is checked BEFORE switchedToTranscode: a transcode
      // the audio watchdog already switched to still deserves its upgrade
      // (h264→copy, copy→jit) now that the real codecs are known.
      if (usingTranscode) {
        // Started on the TAG guess before the truth arrived. Two corrections
        // are worth making now that the codecs are known:
        //  • a full h264 encode of a codec this device decodes (elia's
        //    second stream, 2026-08-26: probe missed the 1.5s window, tags
        //    said h264, and nothing ever upgraded it) → the stream-speed
        //    copy, on the jit full timeline when the file supports it;
        //  • a LEGACY copy job (started from tags, so the container wasn't
        //    known yet) whose file turns out jit-capable → same picture,
        //    but every future seek becomes native. Silent switch: nothing
        //    is wrong with what the viewer sees.
        // The h264 upgrade applies whenever the probe proves the video
        // copyable — however we ENDED UP encoding (tag guess, decode-stall
        // watchdog) — except after this device actually refused a copy
        // stream (copyRefused: escalations are one-way).
        if (currentV === "h264" && !capH && !copyRefused && codecCopyable(item.video)) {
          toast("This device can play this video — switching to the fast path…", "⚡");
          reportMark("client_switch", { reason: "probe-upgrade", to: "copy", position: effTime() });
          const at = effTime();
          tryJitSwitch(at).then((ok) => {
            if (!ok) startTranscodeAt(at, "copy", { fallbackToZero: true });
          });
        } else if (currentV === "copy" && !jitMode) {
          const at = effTime();
          tryJitSwitch(at).then((ok) => {
            if (ok) reportMark("client_switch", { reason: "probe-jit", to: "jit", position: at });
          });
        }
        return;
      }
      if (switchedToTranscode) return; // a direct→transcode switch is in flight
      if (videoNeedsTranscode()) {
        const wantV = codecCopyable(item.video) ? "copy" : "h264";
        switchedToTranscode = true;
        if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
        toast(
          wantV === "copy"
            ? "Repackaging this stream for your device…"
            : "This encode won't decode here — switching to transcode…",
          "⚙️",
        );
        reportMark("client_switch", { reason: "probe-video", to: wantV, position: effTime() });
        const at = effTime();
        if (wantV === "copy") {
          tryJitSwitch(at).then((ok) => {
            if (!ok) startTranscodeAt(at, "copy", { fallbackToZero: true });
          });
        } else {
          startTranscodeAt(at, wantV, { fallbackToZero: true });
        }
      } else if (audioNeedsRemux()) {
        switchedToTranscode = true;
        if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
        toast("This encode's audio can't play here — switching sound…", "🔇");
        reportMark("client_switch", { reason: "probe-audio", to: "copy", position: effTime() });
        const at = effTime();
        tryJitSwitch(at).then((ok) => {
          if (!ok) startTranscodeAt(at, "copy", { fallbackToZero: true });
        });
      }
    });
  }

  for (const [i, t] of (item.subtitles || []).entries()) {
    const track = el("track", {
      kind: "subtitles",
      label: t.label || `Track ${i + 1}`,
      src: t.url,
    });
    armTrackOffset(track);
    video.append(track);
  }

  const flash = el("div", { class: "player-flash" });
  const spinner = el("div", { class: "spinner hidden" });
  const skipIndicator = el("div", { class: "skip-indicator" });

  // Torrent buffering overlay (connecting to peers -> buffering)
  const torrentStatus = el(
    "div",
    { class: "torrent-status hidden" },
    el("div", {
      class: "spinner",
      style: { position: "static", margin: "0 auto 16px" },
    }),
    el("div", { class: "torrent-status-title" }, "Connecting to peers…"),
    el("div", { class: "torrent-status-sub" }, ""),
    el("button", {
      class: "btn focusable",
      style: { marginTop: "22px" },
      html: icons.back + "<span>Back</span>",
      onclick: () => exit(),
    }),
  );

  const scrubFill = el("div", {
    class: "scrubber-fill",
    style: { width: "0%" },
  });
  const scrubBuffer = el("div", {
    class: "scrubber-buffer",
    style: { width: "0%" },
  });
  const scrubTip = el("div", { class: "scrub-tip hidden" });
  // Landmarks on the track — where the intro ends, where the credits start —
  // drawn as ticks, and felt as a tap on a phone when a drag crosses one.
  const scrubMarks = el("div", { class: "scrubber-marks", "aria-hidden": "true" });
  const scrubber = el(
    "div",
    { class: "scrubber focusable", tabindex: "0", "aria-label": "Seek" },
    el("div", { class: "scrubber-track" }, scrubBuffer, scrubFill, scrubMarks),
    scrubTip,
  );
  const timeNow = el("span", {}, "0:00");
  const timeLeft = el("span", {}, "");
  // How much of the video is buffered ahead — most useful while a torrent
  // fills in. Hidden once fully buffered.
  const bufferPct = el("span", { class: "buffer-pct" }, "");

  const btn = (name, html, onclick, cls = "") =>
    el("button", {
      class: `pbtn focusable ${cls}`,
      html,
      "aria-label": name,
      onclick,
    });

  const playBtn = btn("Play/Pause", icons.pause, () => togglePlay(), "big");
  const ccBtn = btn("Subtitles", icons.cc, () => toggleMenu("cc"));
  const speedBtn = btn("Speed", icons.speed, () => toggleMenu("speed"));
  const gearBtn = btn("Settings", icons.gear, () => toggleMenu("settings"));
  const partyBtn = btn("Watch together", "👥", () => togglePartyPanel());
  // X-Ray over the film: the picture pauses, a sheet rises with who is in
  // this episode / film, who made it and how it is rated (js/xray.js — the
  // same panel as the title page's), and closing it picks the film back up.
  let xraySheet = null;
  let xrayResume = false;
  let xrayImdb = item.imdbId || null;
  const closeXray = () => {
    if (!xraySheet) return;
    const sheet = xraySheet;
    xraySheet = null;
    popScope(sheet);
    sheet.classList.remove("in");
    setTimeout(() => sheet.remove(), 280);
    if (xrayResume && !exited) video.play().catch(() => {});
    xrayResume = false;
  };
  const openXray = async () => {
    if (xraySheet) return closeXray();
    const show = !!item.showId || (item.season && item.episode);
    // a saved copy carries its own X-Ray (offline.js extrasFor)
    if (!xrayImdb && item._offline && item.xray) xrayImdb = item.xray.imdbId;
    if (!xrayImdb) {
      try {
        const r = await api.imdbFor(show ? "show" : "movie", show ? item.showTitle || item.title : item.title, item.year);
        xrayImdb = (r && r.imdbId) || null;
      } catch {}
    }
    if (!xrayImdb) return toast("No X-Ray for this one — it isn't matched to a known title", "🔍");
    const { xrayPanel } = await import("../xray.js");
    if (exited || xraySheet) return;
    // in a watch party a pause is everyone's pause — leave the film running there
    xrayResume = !video.paused && !party.current;
    if (xrayResume) video.pause();
    track("feat", { f: "xray_player" });
    const sheet = (xraySheet = el("div", { class: "xray-sheet", onclick: (e) => { if (e.target === sheet) closeXray(); } },
      xrayPanel({
        type: show ? "series" : "movie",
        imdbId: xrayImdb,
        season: item.season,
        episode: item.episode,
        keys: [item.id, item.showId].filter(Boolean),
        onClose: closeXray,
        closeLabel: "Back to watching",
        link: false,
        fallback: item._offline && item.xray ? item.xray.data : null,
      })));
    // (Back / Escape is handled by the player's own Back handler — see onBack —
    // so a remote's Back button closes the sheet too.)
    overlay.append(sheet);
    pushScope(sheet);
    requestAnimationFrame(() => sheet.classList.add("in"));
    setTimeout(() => sheet.classList.add("in"), 60); // (a hidden tab runs no animation frames)
  };
  const xrayBtn = btn("X-Ray", icons.xray, () => openXray());
  // Next episode (elia, 2026-10-07): there from the start of an episode that
  // has one, not only as the Up next card at the credits — which can be
  // dismissed, and which is no help to someone who wants the next one now.
  let nextKnown = null;
  const nextBtn = btn("Next episode", icons.next, () => { if (nextKnown) goNext(nextKnown); }, "next-btn hidden");
  const fsBtn = btn("Fullscreen", icons.fullscreen, () => toggleFullscreen());
  // Picture in picture: the film in a floating window over other apps and
  // tabs. The standard API on desktop and Android; Safari's own on iPhone and
  // iPad (where it also keeps playing when you leave the app).
  const pipOk = () =>
    (document.pictureInPictureEnabled && !video.disablePictureInPicture) ||
    (typeof video.webkitSupportsPresentationMode === "function" && video.webkitSupportsPresentationMode("picture-in-picture"));
  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement) return await document.exitPictureInPicture();
      if (video.webkitPresentationMode === "picture-in-picture") return video.webkitSetPresentationMode("inline");
      if (video.requestPictureInPicture) await video.requestPictureInPicture();
      else if (video.webkitSetPresentationMode) video.webkitSetPresentationMode("picture-in-picture");
      track("feat", { f: "pip" });
    } catch {
      toast("Picture in picture isn't available right now", "⚠️");
    }
  };
  const pipBtn = btn("Picture in picture", icons.pip, () => togglePip(), "pip-btn hidden");
  // offered once the video can actually do it (metadata has to be in)
  const offerPip = () => { try { pipBtn.classList.toggle("hidden", !pipOk()); } catch {} };
  video.addEventListener("loadedmetadata", offerPip);
  video.addEventListener("webkitpresentationmodechanged", offerPip);
  // Leaving the tab or the app while the film plays moves it into the
  // floating window by itself, where the browser offers that: this property
  // (an installed Chrome app; WebKit where it has it), and Chromium's
  // "enterpictureinpicture" media-session action in a plain tab (registered
  // with the other Media Session handlers below). A browser without either
  // simply behaves as before.
  try {
    if ("autoPictureInPicture" in video) video.autoPictureInPicture = true;
  } catch {}
  // AirPlay (Safari only): hand the film to an Apple TV. Offered only when
  // Safari says a target is in reach AND the element plays a source AirPlay
  // can fetch for itself — the file, or native HLS (iPhone). A stream built
  // by hls.js lives in this page's memory (MSE, a blob: URL) and a saved copy
  // lives in this device's cache; neither can be handed to another device.
  let airAvailable = false;
  const airOk = () =>
    airAvailable &&
    !hls &&
    !item._offline &&
    typeof video.webkitShowPlaybackTargetPicker === "function" &&
    !!(video.currentSrc || video.src) &&
    !/^blob:/i.test(video.currentSrc || video.src || "");
  const airBtn = btn("AirPlay", icons.airplay, () => {
    try {
      video.webkitShowPlaybackTargetPicker();
      track("feat", { f: "airplay" });
    } catch {}
  }, "airplay-btn hidden");
  const offerAir = () => { try { airBtn.classList.toggle("hidden", !airOk()); } catch {} };
  if (window.WebKitPlaybackTargetAvailabilityEvent) {
    video.addEventListener("webkitplaybacktargetavailabilitychanged", (e) => {
      airAvailable = !!e && e.availability === "available";
      offerAir();
    });
    // the source can change under the button (direct → hls.js and back)
    video.addEventListener("loadedmetadata", offerAir);
    video.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", () => {
      try { airBtn.classList.toggle("active", !!video.webkitCurrentPlaybackTargetIsWireless); } catch {}
    });
  }
  if ((item.subtitles || []).length === 0) ccBtn.classList.add("hidden");

  const muteBtn = btn("Mute", icons.volume, () => toggleMute());
  const volSlider = el("input", {
    type: "range",
    class: "vol-slider focusable",
    min: "0",
    max: "100",
    value: String(Math.round(prefs.get("volume", 1) * 100)),
    "aria-label": "Volume",
  });
  video.volume = prefs.get("volume", 1);
  // muted stays muted into the next episode and the next film (it used to be
  // forgotten on every new playback while the volume was kept)
  if (prefs.get("muted", false)) video.muted = true;

  const menuHost = el("div");

  // ---------- watch party: pill + panel ----------
  // The pill (top-right) says you're in a party and how many are in; the
  // panel is the code to share, the people in it, and Leave. Both are built
  // here and driven by the party section further down.
  const partyPill = el("button", { class: "party-pill focusable hidden", onclick: () => togglePartyPanel() });
  const partyPanel = el("div", { class: "party-panel hidden" });
  let togglePartyPanel = () => {}; // bound below, once the video exists

  const overlay = el(
    "div",
    { class: "player" },
    video,
    spinner,
    torrentStatus,
    flash,
    skipIndicator,
    el(
      "div",
      { class: "player-top" },
      btn("Back", icons.back, () => exit()),
      el(
        "div",
        {},
        el("div", { class: "player-title" }, title),
        subtitleText && el("div", { class: "player-subtitle" }, subtitleText),
        isTorrent && el("span", { class: "torrent-badge" }, "TORRENT"),
        // the pill up top says what matters while watching: resolution,
        // HDR flavour, sound — not the codec or that there are subtitles
        formatRow(item, { max: 3, codec: false, subs: false }),
      ),
      partyPill,
    ),
    el(
      "div",
      { class: "player-bottom" },
      // One row: time · timeline · time left. The times used to sit on a row
      // of their own under the timeline, with "NN% loaded" between them —
      // a third of the dock's height for two numbers (elia: slimmer, and the
      // loaded text can go).
      el("div", { class: "scrub-row" }, timeNow, scrubber, timeLeft),
      el(
        "div",
        { class: "player-controls" },
        // three groups: transport, volume, tools — the classic look lays
        // them out left-to-right, the glass dock puts the transport in the
        // middle with volume left and tools right
        el("div", { class: "pc-transport" },
          btn("Back 10 seconds", icons.back10, () => skip(-1)),
          playBtn,
          btn("Forward 10 seconds", icons.forward10, () => skip(1)),
          nextBtn),
        el("div", { class: "vol-group" }, muteBtn, volSlider),
        el("div", { class: "player-spacer" }),
        el("div", { class: "pc-tools" }, ccBtn, speedBtn, item._offline && !item.xray ? null : xrayBtn, partyBtn, gearBtn, pipBtn, airBtn, fsBtn),
      ),
    ),
    menuHost,
    partyPanel,
  );

  root.append(overlay);
  // The controls are glass over a moving picture: each one takes the tint
  // the frame behind it calls for (glassTone.js), a couple of times a second
  // while they are showing.
  followVideo(
    video,
    overlay,
    ".player-top > div, .player-top .pbtn, .player-bottom, .party-panel:not(.hidden), .party-pill, .upnext, .resume-card, .quality-pill",
    { active: () => !exited && (!overlay.classList.contains("controls-hidden") || !partyPanel.classList.contains("hidden")) },
  );
  pushScope(overlay);
  // The dock's real height, published as --dock-h: on a phone it is two rows
  // tall, and everything that floats above it (the CC/speed/settings menu,
  // Up next, Skip intro, the resume card) positions against this in CSS
  // instead of against a fixed offset tuned for the one-row desktop dock.
  const dockEl = overlay.querySelector(".player-bottom");
  const paintDockH = () => overlay.style.setProperty("--dock-h", `${dockEl.offsetHeight || 0}px`);
  const dockRO = window.ResizeObserver ? new ResizeObserver(paintDockH) : null;
  if (dockRO) dockRO.observe(dockEl);
  else window.addEventListener("resize", paintDockH);
  paintDockH();
  const activityLabel = isEpisode
    ? `${item.showTitle} S${item.season}E${item.episode}`
    : item.title;
  reportActivity("Watching", activityLabel);

  // ---------- playback state ----------
  let activeTrack = -1;
  // Whether the automatic "subtitles on by default" pick has already happened.
  // It must run once per title, not on every media (re)load, or a viewer who
  // turned subtitles off would have them switched back on by the next seek.
  let autoSubsApplied = false;
  let controlsTimer = null;
  let saveTimer = null;
  let upNextShown = false;
  let torrentPoll = null;
  // Fraction of the FILE the server has (1 for library files on disk; for
  // torrents, the swarm download progress) — drives the "% loaded" label.
  let serverLoaded = isTorrent ? null : 1;
  let statusPoll = null;
  // Torrent buffering overlay controls — reused for the initial buffer AND any
  // mid-playback re-buffer, so peers/speed are always shown while waiting.
  let startTorrentOverlay = () => {};
  let stopTorrentOverlay = () => {};
  let rebufferTimer = null;

  // ---------- torrent buffering feedback ----------
  const fmtSpeed = (bytesPerSec) => {
    if (!bytesPerSec) return "";
    const mb = bytesPerSec / 1024 / 1024;
    return mb >= 1
      ? `${mb.toFixed(1)} MB/s`
      : `${Math.round(bytesPerSec / 1024)} KB/s`;
  };

  if (isTorrent && item.infoHash) {
    const sub = torrentStatus.querySelector(".torrent-status-sub");
    const titleEl = torrentStatus.querySelector(".torrent-status-title");
    let everPlayed = false;
    let lastPolledTime = 0; // to detect real progress between polls
    // mini-pill ETA accounting (see the mini block below)
    let seekEtaAnchor = 0;
    let seekBytesSince = 0;
    let seekLastTick = 0;
    let readySecLast = 0;

    const refresh = async () => {
      if (exited) return;
      // Enough video is decoded to play — so we are no longer waiting on the
      // swarm and this overlay must get out of the way. It's either playing, or
      // it's paused waiting for the VIEWER (autoplay blocked on iOS/Safari), and
      // in that case the overlay used to sit on top of the controls forever with
      // only a Back button — no way to press play. Self-heals even if the
      // 'playing' event is missed.
      // A far seek deliberately HOLDS the picture (see commitSeek), so both
      // early-outs below — a healthy readyState and a still-buffered clock —
      // would hide this overlay at exactly the moment it's the only thing telling
      // the viewer anything. While a seek is in flight, always report it.
      if (!seekWait) {
        if (video.readyState >= 3) {
          stopTorrentOverlay();
          return;
        }
        // …and if the picture is demonstrably MOVING, believe that over
        // readyState: it can under-report mid-rebuffer, which left this overlay
        // covering a film that was actually playing.
        if (!video.paused && video.currentTime > lastPolledTime + 0.2) {
          lastPolledTime = video.currentTime;
          stopTorrentOverlay();
          return;
        }
      }
      lastPolledTime = video.currentTime;
      torrentStatus.classList.remove("hidden");
      try {
        const st = await api.torrentStatus(item.infoHash);
        serverLoaded = st.progress || 0;
        // The truth about the current path, in words a person can act on —
        // "transcoding…" used to appear for streams whose video was merely
        // COPIED (audio-only conversion), which read as "the server is doing
        // something heavy/wrong" (elia, 2026-08-25). usingTranscode is the
        // live state; item.needsTranscode was only the pre-play guess.
        const onTranscode = usingTranscode || switchedToTranscode;
        const pathWords = onTranscode
          ? currentV === "copy"
            ? "converting sound only"
            : "re-encoding for this device"
          : "direct stream";
        // Seconds of video actually ready to play — what the user cares about,
        // not the scattered whole-torrent download %.
        const readySec = video.buffered.length
          ? Math.max(
              0,
              Math.round(
                video.buffered.end(video.buffered.length - 1) -
                  video.currentTime,
              ),
            )
          : 0;
        // A far seek can legitimately take a minute or more on a cold source
        // (the server waits up to 5). Say so, with how long it has been going,
        // rather than showing a bare spinner over a frozen frame — that silence
        // is what makes a working skip feel like a hung player.
        const waiting = seekWait
          ? ` · skipping to ${fmtClock(seekWait.target)} (${fmtClock(Math.round((Date.now() - seekWait.at) / 1000))})`
          : "";
        if (st.peers > 0) {
          titleEl.textContent = seekWait
            ? "Fetching that part of the stream…"
            : everPlayed
              ? "Re-buffering…"
              : onTranscode
                ? "Preparing stream…"
                : "Buffering…";
          const parts = [`${st.peers} peer${st.peers === 1 ? "" : "s"}`];
          // Show download speed only while actually downloading. When the file
          // is (near) complete the speed is 0 by nature — showing "0 MB/s"
          // looks broken; the real wait is the transcode, so say "downloaded".
          const downloaded = (st.progress || 0) >= 0.99;
          if (st.downloadSpeed > 30000) parts.push(fmtSpeed(st.downloadSpeed));
          else if (downloaded) parts.push("downloaded");
          parts.push(pathWords);
          parts.push(
            readySec > 0
              ? `${readySec}s of video ready`
              : "getting the first frames…",
          );
          readySecLast = readySec;
          sub.textContent = parts.join(" · ") + waiting;
        } else {
          titleEl.textContent = seekWait
            ? "Fetching that part of the stream…"
            : "Connecting to peers…";
          sub.textContent =
            (seekWait ? "waiting on the swarm" : "This can take a moment") +
            waiting;
        }
        // Once the picture has shown, the full-screen vignette is just in the
        // way (elia, 2026-08-26: "the overlay is kind of annoying") — flip to
        // a compact pill above the controls: destination, live speed, and an
        // honest countdown. The ETA integrates the actual download rate
        // against a ~24MB target-region budget — a heuristic, so it wears a
        // tilde — and once the data is in it says "starting…".
        torrentStatus.classList.toggle("mini", everPlayed);
        if (everPlayed) {
          const speed = st.downloadSpeed || 0;
          const now = Date.now();
          if (seekWait) {
            if (seekEtaAnchor !== seekWait.at) {
              seekEtaAnchor = seekWait.at;
              seekBytesSince = 0;
              seekLastTick = now;
            }
            seekBytesSince += speed * Math.max(0, (now - seekLastTick) / 1000);
            seekLastTick = now;
            const NEED = 24 * 1024 * 1024;
            const remaining = NEED - seekBytesSince;
            const eta =
              remaining <= 0 || !speed
                ? null
                : Math.min(120, Math.max(2, Math.round(remaining / speed)));
            const elapsed = Math.round((now - seekWait.at) / 1000);
            // The budget is a bandwidth heuristic and bandwidth can be
            // filling the WRONG pieces (measured 63s "starting…" at a real
            // 25MB/s, 2026-08-27) — once it's spent with no landing, stop
            // pretending and show the honest elapsed wait instead.
            const tail =
              eta ? ` · ~${eta}s`
              : elapsed <= 8 ? " · starting…"
              : ` · still fetching that part… (${elapsed}s)`;
            sub.textContent =
              `→ ${fmtClock(seekWait.target)} · ${speed > 30000 ? fmtSpeed(speed) : "…"}` + tail;
          } else {
            sub.textContent =
              (speed > 30000 ? `${fmtSpeed(speed)} · ` : "") +
              (readySecLast > 0 ? `${readySecLast}s ready` : "buffering…");
          }
        }
      } catch {}
    };

    startTorrentOverlay = (focusBack) => {
      if (exited || torrentPoll) return;
      torrentStatus.classList.remove("hidden");
      if (focusBack)
        torrentStatus.querySelector(".btn")?.focus({ preventScroll: true });
      refresh();
      torrentPoll = setInterval(refresh, 1000);
    };
    stopTorrentOverlay = () => {
      everPlayed = true;
      torrentStatus.classList.add("hidden");
      if (torrentPoll) {
        clearInterval(torrentPoll);
        torrentPoll = null;
      }
    };

    startTorrentOverlay(true); // initial buffer

    // Keep the "% loaded" label fresh the whole session, not only while the
    // buffering overlay happens to be polling. Doubles as a torrent touch.
    statusPoll = setInterval(async () => {
      if (exited || document.hidden) return;
      try {
        const st = await api.torrentStatus(item.infoHash);
        serverLoaded = st.progress || 0;
      } catch {}
    }, 5000);

    // Give up gracefully if nothing ever plays within 60s — but never blame the
    // swarm when the browser is the one refusing to start playback.
    setTimeout(() => {
      if (!exited && !everPlayed && !playBlocked && video.currentTime === 0) {
        titleEl.textContent = "Still trying…";
        sub.textContent = "Few or no seeders — try another source";
      }
    }, 60000);
  }

  const showFlash = (iconHtml) => {
    flash.innerHTML = iconHtml;
    flash.classList.remove("go");
    void flash.offsetWidth;
    flash.classList.add("go");
  };

  // 2.4s of nothing moving and the chrome steps aside; any motion — mouse,
  // finger, wheel, key, remote — brings it straight back.
  const CONTROLS_IDLE_MS = 2400;
  const showControls = () => {
    overlay.classList.remove("controls-hidden", "hide-cursor");
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(hideControls, CONTROLS_IDLE_MS);
    liftCues(true);
  };
  const hideControls = () => {
    if (menuHost.childElementCount > 0) return; // keep visible while a menu is open
    if (video.paused) return;
    overlay.classList.add("controls-hidden", "hide-cursor");
    document.activeElement?.blur?.();
    liftCues(false);
  };
  const controlsHidden = () => overlay.classList.contains("controls-hidden");

  // ---------- subtitles step above the controls ----------
  // With the dock up, a bottom-placed cue sat UNDER the scrubber and buttons
  // (elia: "the subs should be raised when the playback panel is open so they
  // would be visible"). While the chrome shows, every default-placed cue is
  // re-aimed so its BOTTOM edge sits just above the dock's real top — whatever
  // height the dock is (two rows on a phone, one on a desktop); when the
  // chrome hides they drop back to the browser's own placement. Cues a
  // subtitle file positioned itself (a sign translated at the top of the
  // frame) are never touched. Native iOS fullscreen draws its own captions
  // around its own controls, so it's left alone too.
  let cuesLifted = false;
  const liftedCues = new WeakSet();
  const liftLine = () => {
    const v = video.getBoundingClientRect();
    const d = dockEl && dockEl.getBoundingClientRect();
    if (!v.height || !d || !d.height) return null;
    const bottom = Math.min(v.bottom, d.top - 12);
    return Math.max(8, Math.min(96, ((bottom - v.top) / v.height) * 100));
  };
  // true when the cue actually moved
  const placeCue = (cue, line) => {
    if (line != null) {
      if (!liftedCues.has(cue) && cue.line !== "auto") return false; // the file placed it — leave it
      if (liftedCues.has(cue) && cue.line === line) return false;
      cue.snapToLines = false;
      cue.lineAlign = "end";
      cue.line = line;
      liftedCues.add(cue);
      return true;
    }
    if (!liftedCues.has(cue)) return false;
    cue.snapToLines = true;
    cue.lineAlign = "start";
    cue.line = "auto";
    liftedCues.delete(cue);
    return true;
  };
  // Chrome keeps drawing a cue that is ON SCREEN where it first put it, new
  // position or not — so the very line you woke the controls to read stayed
  // under the dock until the next one. Taking it out and putting it straight
  // back makes the browser lay it out again, in its new place.
  const redrawActive = (tt, moved) => {
    if (!moved.length || !tt.activeCues) return;
    const onScreen = new Set(Array.from(tt.activeCues));
    for (const cue of moved) {
      if (!onScreen.has(cue)) continue;
      try { tt.removeCue(cue); tt.addCue(cue); } catch {}
    }
  };
  const placeAllCues = () => {
    const line = cuesLifted ? liftLine() : null;
    for (const tt of video.textTracks) {
      if (tt.mode !== "showing" || !tt.cues) continue;
      const moved = Array.from(tt.cues).filter((cue) => placeCue(cue, line));
      redrawActive(tt, moved);
    }
  };
  function liftCues(on) {
    if (on && video.webkitDisplayingFullscreen) on = false;
    if (on === cuesLifted) return; // showControls runs on every mouse move — act on transitions only
    cuesLifted = on;
    placeAllCues();
  }
  // Cues that arrive later (a track switched on, auto-subtitles landing, a
  // track rebuilt by the sync nudge) pick up the current placement as they
  // become active — cheap: only the active cues are touched.
  const onCueChange = (e) => {
    const tt = e.target;
    if (!cuesLifted || tt.mode !== "showing" || !tt.activeCues) return;
    const line = liftLine();
    redrawActive(tt, Array.from(tt.activeCues).filter((cue) => placeCue(cue, line)));
  };
  for (const tt of video.textTracks) tt.addEventListener("cuechange", onCueChange);
  video.textTracks.addEventListener("addtrack", (e) => e.track && e.track.addEventListener("cuechange", onCueChange));
  // a resize / fullscreen flip moves the dock — re-aim while lifted
  const onLiftResize = () => cuesLifted && placeAllCues();
  window.addEventListener("resize", onLiftResize);

  // While a far seek is landing, conflicting inputs are LOCKED: pressing
  // play resumed the deliberately-held old picture mid-swap, and stacking
  // another restart on the one in flight churned the server's job slots —
  // both reported as "it messes it up" (elia, 2026-08-27). Back always
  // works; a locked press gets one gentle reminder, never silence.
  let seekLockToastAt = 0;
  const seekLocked = () => {
    if (!seekWait && !probing) return false;
    const now = Date.now();
    if (now - seekLockToastAt > 2500) {
      seekLockToastAt = now;
      toast("Hold on — landing your skip…", "⏳");
    }
    return true;
  };

  const togglePlay = () => {
    if (seekLocked()) return;
    if (video.paused) {
      video.play().catch(() => {});
      showFlash(icons.play);
      partyUser(true);
    } else {
      video.pause();
      showFlash(icons.pause);
      partyUser(false);
    }
  };
  // Bound in the watch-party section below (declared here so togglePlay,
  // defined first, can call it).
  let partyUser = () => {};

  // Accelerating skip: 10s per press; chains of fast presses escalate to
  // 30s, 1m, 2m, 5m. The indicator shows the cumulative jump.
  let skipStreak = 0;
  let skipAccum = 0;
  let skipDir = 0;
  let lastSkipAt = 0;
  let skipHideTimer = null;

  const skip = (dir) => {
    if (seekLocked()) return;
    const now = Date.now();
    if (now - lastSkipAt > SKIP_CHAIN_MS || dir !== skipDir) {
      skipStreak = 0;
      skipAccum = 0;
    }
    lastSkipAt = now;
    skipDir = dir;
    const step = SKIP_STEPS[Math.min(skipStreak, SKIP_STEPS.length - 1)];
    skipStreak++;
    skipAccum += step;

    // Skip relative to the effective content time; seekTo handles native vs
    // transcode (which restarts at the offset, debounced across a skip burst).
    // Chained skips continue from where the last one was headed, so pressing
    // skip again while a far seek loads keeps moving forward.
    const base =
      pendingSeek != null
        ? pendingSeek
        : seekPreview != null
          ? seekPreview
          : effTime();
    seekTo(base + dir * step);

    const amount =
      skipAccum >= 60
        ? `${Math.floor(skipAccum / 60)}m${skipAccum % 60 ? ` ${skipAccum % 60}s` : ""}`
        : `${skipAccum}s`;
    skipIndicator.textContent = dir > 0 ? `${amount} »` : `« ${amount}`;
    skipIndicator.classList.toggle("left", dir < 0);
    skipIndicator.classList.add("on");
    clearTimeout(skipHideTimer);
    skipHideTimer = setTimeout(() => skipIndicator.classList.remove("on"), 700);

    updateScrubber();
  };

  // Rotating into landscape is what "fullscreen" means on a phone — lock it
  // while fullscreen where the API exists (Android; no-op elsewhere).
  const lockLandscape = () => {
    try {
      screen.orientation?.lock?.("landscape").catch(() => {});
    } catch {}
  };
  // iPhone (every browser there is WebKit) has NO element fullscreen — only
  // the native video player. Crucially, requestFullscreen still EXISTS on
  // iPhone and simply rejects, so "does the function exist" is the wrong
  // test: gate on fullscreenEnabled and fall back to the native player.
  const enterNativeVideoFs = () => {
    try {
      video.webkitEnterFullscreen();
    } catch {}
    // iOS failures here throw synchronously OR no-op silently — either way
    // the button just looked dead and nobody could tell why. Check shortly
    // after and say so.
    setTimeout(() => {
      if (exited) return;
      const opened =
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        video.webkitDisplayingFullscreen;
      if (!opened) toast("iOS wouldn't open fullscreen — try again in a moment", "⚠️");
    }, 400);
  };
  const toggleFullscreen = () => {
    track("feat", { f: "fullscreen" });
    if (video.webkitDisplayingFullscreen) {
      try {
        video.webkitExitFullscreen();
      } catch {}
      return;
    }
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      try {
        screen.orientation?.unlock?.();
      } catch {}
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      try {
        exit.call(document)?.catch?.(() => {});
      } catch {}
      return;
    }
    // iPhone: element fullscreen NEVER works (any browser — all are WebKit),
    // and attempting it first consumes the tap's transient activation, which
    // then blocks the native fallback too. Go native directly, synchronously.
    if (
      /iPhone|iPod/.test(navigator.userAgent) &&
      video.webkitEnterFullscreen
    ) {
      // ...but never hand the native player a stream that isn't ready. Going
      // fullscreen immediately after a skip made it take over a media element
      // that was still switching source (the transcode had just restarted with
      // a couple of seconds of playlist), and it wedged. iOS won't let us defer
      // the call out of this tap — the transient activation would be gone — so
      // the only safe move is to decline and say why.
      if (probing || video.readyState < 3) {
        toast(
          "Still loading that part — tap fullscreen again in a moment",
          "⏳",
        );
        return;
      }
      enterNativeVideoFs();
      return;
    }
    const elementFsOk =
      document.fullscreenEnabled || document.webkitFullscreenEnabled;
    if (elementFsOk && overlay.requestFullscreen) {
      overlay.requestFullscreen().then(lockLandscape).catch(enterNativeVideoFs);
    } else if (elementFsOk && overlay.webkitRequestFullscreen) {
      // Prefixed call returns no promise — verify it actually took, and use
      // the native player if it silently didn't (still within the tap's
      // transient-activation window).
      overlay.webkitRequestFullscreen();
      setTimeout(() => {
        if (document.fullscreenElement || document.webkitFullscreenElement)
          lockLandscape();
        else enterNativeVideoFs();
      }, 300);
    } else if (video.webkitEnterFullscreen) {
      enterNativeVideoFs();
    }
  };

  const paintVolume = () => {
    muteBtn.innerHTML =
      video.muted || video.volume === 0 ? icons.volumeOff : icons.volume;
    volSlider.value = String(
      Math.round((video.muted ? 0 : video.volume) * 100),
    );
  };
  const toggleMute = () => {
    video.muted = !video.muted;
    prefs.set("muted", video.muted);
    paintVolume();
  };
  volSlider.addEventListener("input", () => {
    video.muted = false;
    prefs.set("muted", false);
    video.volume = volSlider.value / 100;
    prefs.set("volume", video.volume);
    paintVolume();
  });

  // Which subtitle track to switch on by itself, honouring the viewer's
  // Preferences: their language if one of the offered tracks is in it, else
  // `from` (the first / newest track, i.e. the old behaviour). -1 means "leave
  // subtitles off", for viewers who don't want them appearing unasked.
  const SUB_LANG_TEST = {
    he: { code: /^(he|heb|iw)/i, label: /hebrew|עבר/i },
    en: { code: /^(en|eng)/i, label: /english/i },
    ru: { code: /^(ru|rus)/i, label: /russian|русск/i },
  };
  const SUB_LANG_NAME = { he: "Hebrew", en: "English", ru: "Russian" };
  const autoTrackIndex = (from = 0) => {
    // PRECEDENCE (the same on the TV — Player.tsx autoTrack):
    //   1. `subPick`, what you last picked BY HAND in this menu, on any device:
    //      "off" stays off; "he" / "en" / "ru" is found again on the next
    //      title. It is a LANGUAGE, never a track's label (2026-10-08: a
    //      remembered "Hebrew 2" did not match an episode that only had
    //      "Hebrew"). The best track in it: a full one before SDH before
    //      forced, and among equals the first listed — lang.js bestTrackIndex.
    //      A pick in any other language, or of a track whose language cannot
    //      be told, is a one-off for that title and is not remembered.
    //   2. This title has nothing in that language (or nothing was ever
    //      picked): the Settings rules below, exactly as before — subtitles
    //      off if "Subtitles on by default" is off, else the Settings language
    //      (`subLang`), else `from`.
    // So the last explicit pick wins until the next one; Settings decides only
    // where a pick has nothing to say. Values older builds stored ("Hebrew 2",
    // "eng", "English - SDH") are read as their language by normPick; anything
    // it cannot place counts as nothing remembered.
    const last = normPick(profilePick("subPick"));
    if (last === "off") return -1;
    if (last) {
      const i = bestTrackIndex(item.subtitles || [], last);
      if (i >= 0) return i;
    }
    if (!prefs.get("subsDefault", true)) return -1;
    const want = prefs.get("subLang", "any");
    const test = SUB_LANG_TEST[want];
    if (test) {
      const subs = item.subtitles || [];
      const i = subs.findIndex(
        (t) => test.code.test(t.lang || "") || test.label.test(t.label || ""),
      );
      if (i >= 0) return i;
    }
    return from;
  };

  const selectTrack = (idx) => {
    const tracks = video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = i === idx ? "showing" : "disabled";
    }
    activeTrack = idx;
    // Cues load when a track is activated — apply any offset once they're in.
    // If the track already settled EMPTY (one flaky fetch poisons it forever
    // — browsers never retry), force a refetch instead.
    if (idx >= 0)
      setTimeout(() => {
        const trackEl = [...video.querySelectorAll("track")][idx];
        const settled =
          trackEl && (trackEl.readyState === 2 || trackEl.readyState === 3);
        if (
          settled &&
          (!trackEl.track.cues || trackEl.track.cues.length === 0)
        ) {
          reloadTrackEl(trackEl);
        } else {
          applyOffsetToTrack(tracks[idx]);
        }
      }, 250);
  };

  // Guarantee only one subtitle track is ever visible. hls.js / the browser can
  // enable a second native track behind our back (causing overlapping subs);
  // this collapses back to our chosen track whenever modes change.
  let enforcingTracks = false;
  const enforceSingleSub = () => {
    if (enforcingTracks) return;
    const tt = video.textTracks;
    const showing = [];
    for (let i = 0; i < tt.length; i++)
      if (tt[i].mode === "showing") showing.push(i);
    if (showing.length <= 1) return;
    const keep = showing.includes(activeTrack) ? activeTrack : showing[0];
    enforcingTracks = true;
    for (let i = 0; i < tt.length; i++)
      tt[i].mode = i === keep ? "showing" : "disabled";
    activeTrack = keep;
    enforcingTracks = false;
  };
  video.textTracks.addEventListener("change", enforceSingleSub);

  // ---------- subtitle sync ----------
  // Cue times in the subtitle files are CONTENT-absolute, but a transcoded
  // stream's clock starts at streamOffset — so every cue must be shifted by
  // -streamOffset (this is what made subs "drift" exactly after a far seek or
  // a mid-film resume: the clock re-anchored, the cues didn't). On top of
  // that sits the per-track manual nudge for release-timing mismatch.
  // Each cue remembers its original times and is always positioned absolutely
  // from them — repeated re-anchoring can never accumulate error, and the
  // Math.max(0,…) clamp can never corrupt an earlier cue permanently.
  // The manual nudge is PER TRACK. External subtitle files are timed for
  // whichever release their uploader had — measured across eight tracks of one
  // film, the first cue landed anywhere from 0.0s to 357.0s — so a delay that
  // fixes one track is wrong for the next. A single shared value silently
  // followed you from track to track.
  const trackOffsets = new Map(); // textTracks index -> seconds
  const offsetFor = (idx) => trackOffsets.get(idx) || 0;
  const appliedOffset = new WeakMap();
  const applyOffsetToTrack = (tt) => {
    if (!tt || !tt.cues || !tt.cues.length) return;
    const idx = [...video.textTracks].indexOf(tt);
    const shift = (idx >= 0 ? offsetFor(idx) : 0) - clockBase;
    if (appliedOffset.get(tt) === shift) return;
    // SNAPSHOT the cue list first. `tt.cues` is LIVE and kept sorted by start
    // time, and the clamp below parks every cue before the stream start on 0 —
    // hundreds of ties. Writing startTime while indexing into that list
    // re-orders it underneath the loop, so cues get skipped and keep the
    // PREVIOUS shift: measured [3983, 3978, 3983] within one track after a
    // single nudge. That is what left part of a track a second or so off while
    // the rest looked fine.
    for (const cue of Array.from(tt.cues)) {
      if (cue._t0 === undefined) {
        cue._t0 = cue.startTime;
        cue._t1 = cue.endTime;
      }
      cue.startTime = Math.max(0, cue._t0 + shift);
      cue.endTime = Math.max(0, cue._t1 + shift);
    }
    appliedOffset.set(tt, shift);
    // Chrome quirk: editing cue times on a SHOWING track can leave its
    // active-cue tracking stale — no subtitle renders again until the mode
    // changes. Flip the mode to force the cue index to rebuild.
    if (tt.mode === "showing") {
      tt.mode = "disabled";
      tt.mode = "showing";
    }
  };
  const applyOffsetAll = () => {
    for (const tt of video.textTracks) applyOffsetToTrack(tt);
  };
  const nudgeSubs = (delta) => {
    if (activeTrack < 0) return toast("Turn a subtitle track on first", "💬");
    const next = Math.round((offsetFor(activeTrack) + delta) * 10) / 10;
    trackOffsets.set(activeTrack, next);
    applyOffsetToTrack(video.textTracks[activeTrack]); // only this track moves
    toast(`Subtitle delay ${next >= 0 ? "+" : ""}${next.toFixed(1)}s`, "💬");
  };
  // A track that finished "loading" with ZERO cues hit a transient fetch
  // failure (server restart mid-load, flaky subtitle upstream) — browsers
  // never retry a failed track on their own, so subs stay silently missing
  // forever. Recreate the <track> element with a cache-buster to refetch.
  const reloadTrackEl = (trackEl) => {
    const src = trackEl.getAttribute("src") || "";
    const bust = `${src}${src.includes("?") ? "&" : "?"}retry=${Date.now()}`;
    const fresh = el("track", {
      kind: "subtitles",
      label: trackEl.label || "",
      src: bust,
      srclang: trackEl.getAttribute("srclang") || "",
    });
    armTrackOffset(fresh);
    const wasShowing = trackEl.track && trackEl.track.mode === "showing";
    video.insertBefore(fresh, trackEl); // same position keeps textTracks order
    trackEl.remove();
    if (wasShowing) fresh.track.mode = "showing";
    return fresh;
  };
  // readyState 2 = LOADED, 3 = ERROR — both "settled"; zero cues then means
  // the fetch produced nothing usable. (Still-loading tracks are left alone.)
  const reloadEmptyActiveTracks = () => {
    let n = 0;
    for (const trackEl of [...video.querySelectorAll("track")]) {
      const tt = trackEl.track;
      if (!tt || tt.mode === "disabled") continue;
      const settled = trackEl.readyState === 2 || trackEl.readyState === 3;
      if (settled && (!tt.cues || tt.cues.length === 0)) {
        reloadTrackEl(trackEl);
        n++;
      }
    }
    return n;
  };

  // Full reset: refetch any empty track, drop the manual nudge, and force-
  // reapply the absolute anchor on every track (appliedOffset cleared so even
  // a "same shift" state re-runs, rebuilding the active-cue index).
  // Nuclear option, on purpose: throw away the loaded subtitle data entirely,
  // re-download the file fresh, and re-anchor it to the current stream clock.
  const resyncSubs = () => {
    if (activeTrack < 0) return toast("Turn a subtitle track on first", "💬");
    const label =
      [...video.querySelectorAll("track")][activeTrack]?.label || "Subtitles";
    trackOffsets.delete(activeTrack); // back to the file's own timing
    for (const tt of video.textTracks) appliedOffset.delete(tt);
    // Reload the ACTIVE track from scratch (cache-busted). Its 'load' event
    // re-applies the anchor via armTrackOffset.
    let reloaded = 0;
    for (const trackEl of [...video.querySelectorAll("track")]) {
      if (trackEl.track && trackEl.track.mode === "showing") {
        reloadTrackEl(trackEl);
        reloaded++;
      }
    }
    applyOffsetAll(); // re-anchor the non-reloaded (disabled) tracks' state
    // Say exactly what happened — "re-syncing…" left people guessing whether
    // anything had actually been done.
    toast(
      reloaded
        ? `“${label}” re-downloaded, delay reset to 0s and re-aligned to the video`
        : `“${label}” delay reset to 0s and re-aligned to the video`,
      "💬",
    );
  };
  // Late-loading cues (external fetch, OCR) get the current offset on load.
  // Function declaration (hoisted): the subtitle-track loop near the top of
  // renderPlayer calls this before this line runs — a `const` here crashed
  // playback of any library item with subtitles (TDZ ReferenceError).
  function armTrackOffset(trackEl) {
    trackEl.addEventListener("load", () => applyOffsetToTrack(trackEl.track));
  }

  // ---------- menus (subtitles / speed) ----------
  // A menu is either PINNED (opened by a click or a key, and it stays until you
  // dismiss it) or merely hovered (see the ccBtn wiring below, which follows the
  // pointer back out again).
  let menuPinned = false;
  let menuKind = null;
  let hoverOut = null;
  const cancelHoverOut = () => {
    clearTimeout(hoverOut);
    hoverOut = null;
  };
  const closeMenu = () => {
    cancelHoverOut();
    menuPinned = false;
    menuKind = null;
    menuHost.innerHTML = "";
  };

  const toggleMenu = (kind, { pinned = true } = {}) => {
    if (menuHost.childElementCount > 0) {
      // Clicking the button whose menu hover already opened pins it, rather than
      // dismissing something the pointer only just revealed.
      if (kind === menuKind) {
        if (pinned && !menuPinned) {
          menuPinned = true;
          cancelHoverOut();
          return;
        }
        return closeMenu();
      }
      // A DIFFERENT menu is open — usually the subtitles panel the pointer
      // hover-opened on its way to this button. Switch to the requested menu;
      // a bare dismiss here is what ate the first click on speed/settings.
      closeMenu();
    }
    menuPinned = pinned;
    menuKind = kind;
    // positioned by CSS (.player .menu) — the glass look's phone dock moves it
    const menu = el("div", { class: "menu" });

    if (kind === "cc") {
      menu.append(menuTitle("cc", "Subtitles"));
      // One-press escape hatch: drops any manual nudge and force re-anchors
      // every track's cues to the current stream clock. Cheap insurance for
      // "subs look off and I don't want to fiddle with ±0.5s".
      menu.append(
        el(
          "button",
          {
            class: "menu-item focusable",
            onclick: () => {
              resyncSubs();
              closeMenu();
              showControls();
            },
          },
          "⟲ Resync subtitles",
        ),
      );
      const entry = (label, idx, tag) =>
        el(
          "button",
          {
            class: `menu-item focusable ${activeTrack === idx ? "active" : ""}`,
            // An explicit pick (including "Off") is final — never overridden by
            // the auto-pick on a later reload.
            onclick: () => {
              autoSubsApplied = true;
              selectTrack(idx);
              {
                const t = idx >= 0 ? (item.subtitles || [])[idx] : null;
                // "off", or the track's language when it is Hebrew, English
                // or Russian. Anything else is a one-off: what was remembered
                // stays (see autoTrackIndex).
                const pick = idx < 0 ? "off" : pickOf(t);
                if (pick) rememberPick("subPick", pick);
              }
              closeMenu();
              showControls();
            },
          },
          label,
          tag && el("span", { class: "tag" }, tag),
        );
      menu.append(entry("Off", -1));
      (item.subtitles || []).forEach((t, i) =>
        menu.append(
          entry(t.label || `Track ${i + 1}`, i, t.embedded ? "Embedded" : null),
        ),
      );
      // Subtitle timing nudge — fixes subs that drift ahead/behind the video.
      // The delay shown is the ACTIVE track's own (see trackOffsets).
      const fmtOffset = () => {
        const o = offsetFor(activeTrack);
        return `${o >= 0 ? "+" : ""}${o.toFixed(1)}s`;
      };
      const offsetLabel = el("span", { class: "tag" }, fmtOffset());
      const bump = (d) => {
        nudgeSubs(d);
        offsetLabel.textContent = fmtOffset();
      };
      menu.append(
        menuTitle("forward10", "Subtitle timing", true),
        el(
          "div",
          { class: "sub-sync" },
          el(
            "button",
            {
              class: "focusable",
              "aria-label": "Subtitles 5 seconds earlier",
              onclick: () => bump(-5),
            },
            "−5s",
          ),
          el(
            "button",
            {
              class: "focusable",
              "aria-label": "Subtitles earlier",
              onclick: () => bump(-0.5),
            },
            "−0.5s",
          ),
          offsetLabel,
          el(
            "button",
            {
              class: "focusable",
              "aria-label": "Subtitles later",
              onclick: () => bump(0.5),
            },
            "+0.5s",
          ),
          el(
            "button",
            {
              class: "focusable",
              "aria-label": "Subtitles 5 seconds later",
              onclick: () => bump(5),
            },
            "+5s",
          ),
          el(
            "button",
            {
              class: "focusable",
              "aria-label": "Reset subtitle timing",
              onclick: () => bump(-offsetFor(activeTrack)),
            },
            "Reset",
          ),
        ),
      );
    } else if (kind === "speed") {
      menu.append(menuTitle("speed", "Speed"));
      for (const s of SPEEDS) {
        menu.append(
          el(
            "button",
            {
              class: `menu-item focusable ${video.playbackRate === s ? "active" : ""}`,
              onclick: () => {
                video.playbackRate = s;
                closeMenu();
                showControls();
              },
            },
            s === 1 ? "Normal" : `${s}×`,
          ),
        );
      }
    } else {
      const entry = (label, value, onclick) =>
        el(
          "button",
          { class: "menu-item focusable", onclick },
          label,
          el("span", { class: "tag" }, value),
        );

      const rebuild = () => {
        menu.innerHTML = "";
        // Audio — only when the file carries more than one track (a dub, a
        // commentary). Picking one restarts the stream at the current
        // position with that track mapped in.
        const tracks = item.audioTracks || [];
        if (tracks.length > 1) {
          menu.append(menuTitle("volume", "Audio"));
          tracks.forEach((t, i) => {
            const idx = t.index != null ? t.index : i;
            menu.append(
              el(
                "button",
                {
                  class: `menu-item focusable ${audioIdx === idx ? "active" : ""}`,
                  onclick: () => switchAudio(idx),
                },
                el("span", {}, audioTrackName(t, i)),
                el("span", { class: "tag" }, [t.original && "Original", t.codec && String(t.codec).toUpperCase(), t.channels && `${t.channels}ch`].filter(Boolean).join(" · ")),
              ),
            );
          });
        }
        // Quality — a library title can be played as a lighter stream when
        // the connection can't carry the file itself.
        if (canCap) {
          menu.append(menuTitle("film", "Quality"));
          // "Original" is the file's video bit for bit (a copy) — except on a
          // device that can't decode its codec, where it is the best re-encode,
          // and the menu says so rather than claiming the file.
          // (asked of the FILE, not of what is playing: while a 720p encode
          // ran, a file that direct-plays was labelled as re-encoded)
          const origTag = videoNeedsTranscode() ? "re-encoded — this device can't play the file's codec" : "the file as it is";
          // On a ladder the entries are the stream's own levels, with Auto on
          // top; a pick is a level change, not a rebuild. Off it, the three
          // qualities as before.
          const rows = [[0, "Original", origTag], [720, "720p", "data saver"], [480, "480p", "slow connection"]];
          let active = capH;
          if (ladderOn) {
            const have = ladderLevels();
            const now = have.find((l) => l.i === (hls ? hls.currentLevel : -1));
            const list = rows.filter(([h]) => have.some((l) => l.h === h));
            rows.length = 0;
            rows.push(["auto", "Auto", now ? `now ${ladderLabel(now.h)}` : "follows your connection"], ...list);
            active = ladderPick;
          }
          for (const [h, label, tag] of rows) {
            menu.append(
              el(
                "button",
                { class: `menu-item focusable ${active === h ? "active" : ""}`, onclick: () => switchQuality(h) },
                el("span", {}, label),
                el("span", { class: "tag" }, tag),
              ),
            );
          }
        }
        menu.append(menuTitle("play", "Playback"));
        menu.append(
          entry(
            "Autoplay next episode",
            prefs.get("autoplayNext", true) ? "On" : "Off",
            () => {
              prefs.set("autoplayNext", !prefs.get("autoplayNext", true));
              rebuild();
            },
          ),
        );
        menu.append(menuTitle("cc", "Subtitle style"));
        menu.append(
          entry("Size", prefs.get("cueSize", "M"), () => {
            const order = ["S", "M", "L"];
            const next =
              order[(order.indexOf(prefs.get("cueSize", "M")) + 1) % 3];
            prefs.set("cueSize", next);
            applyCueStyle();
            rebuild();
          }),
        );
        menu.append(
          entry(
            "Background",
            prefs.get("cueBackground", true) ? "On" : "Off",
            () => {
              prefs.set("cueBackground", !prefs.get("cueBackground", true));
              applyCueStyle();
              rebuild();
            },
          ),
        );
        // (The Skip intro section that used to sit here — ignore the detected
        // intro, mark its start and end by hand, clear the marks — is gone
        // from the menu (elia). Detection and the public timestamp databases
        // do that job now; a wrong mark can still be removed in the admin,
        // under Inbox → Skip-intro marks.)
        menu.append(menuTitle("info", "Help"));
        menu.append(entry("Report a problem", "with this title", () => { closeMenu(); showReportSheet({ hint: "from the player" }); }));
      };
      rebuild();
    }
    menuHost.append(menu);
    placeMenu(menu, kind === "cc" ? ccBtn : kind === "speed" ? speedBtn : gearBtn);
    menu.querySelector(".menu-item.active")?.focus({ preventScroll: true });
  };

  // The menu opens from the button that asked for it: centred over that
  // button, sitting just above the dock, clamped to the screen. One fixed
  // spot (right: 36px, bottom: 110px) served all three menus before — with
  // the glass dock an island in the middle of the screen, Speed and Settings
  // opened a hundred pixels to the right of their buttons and 65px INTO the
  // dock. Phones keep the CSS layout (a full-width sheet above the dock).
  const placeMenu = (menu, anchor) => {
    if (!menu || !anchor || matchMedia("(max-width: 720px)").matches) {
      if (menu) menu.style.cssText = "";
      return;
    }
    const pr = overlay.getBoundingClientRect();
    const br = anchor.getBoundingClientRect();
    const dr = dockEl.getBoundingClientRect();
    const w = menu.offsetWidth || 260;
    const margin = 12;
    let left = br.left + br.width / 2 - w / 2 - pr.left;
    left = Math.max(margin, Math.min(left, pr.width - w - margin));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.right = "auto";
    menu.style.bottom = `${Math.round(pr.bottom - dr.top + 14)}px`;
    // the glass pop grows from where it was pressed
    menu.style.transformOrigin = `${Math.round(br.left + br.width / 2 - pr.left - left)}px 100%`;
  };
  const replaceMenu = () => {
    const m = menuHost.firstElementChild;
    if (!m) return;
    placeMenu(m, menuKind === "cc" ? ccBtn : menuKind === "speed" ? speedBtn : gearBtn);
  };
  window.addEventListener("resize", replaceMenu);

  // Subtitles open on hover too: reaching for a timing nudge mid-scene shouldn't
  // cost a click. The grace period covers the gap the pointer crosses between the
  // button and the panel, which is otherwise long enough to close it on the way.
  const HOVER_GRACE_MS = 250;
  const hoverAway = () => {
    if (menuPinned) return;
    cancelHoverOut();
    hoverOut = setTimeout(() => {
      if (!menuPinned) closeMenu();
    }, HOVER_GRACE_MS);
  };
  ccBtn.addEventListener("mouseenter", () => {
    if (menuHost.childElementCount === 0) toggleMenu("cc", { pinned: false });
    else cancelHoverOut();
  });
  ccBtn.addEventListener("mouseleave", hoverAway);
  // mouseenter/leave are delivered for descendants too, so this covers the panel
  // itself even though the host box is empty space.
  menuHost.addEventListener("mouseenter", cancelHoverOut);
  menuHost.addEventListener("mouseleave", hoverAway);

  // A pinned menu goes away on the next click that lands outside it — anywhere on
  // the video, the controls, the page. Clicks inside are the menu's own business:
  // the timing and style controls rebuild it in place and must survive. The three
  // menu-owning buttons are exempt too — they toggle/switch menus themselves, and
  // the click that OPENS a menu bubbles here afterwards: without the exemption it
  // closed the speed/settings menu in the same tick it opened ("buttons dead").
  const onDocClick = (e) => {
    if (!menuPinned || menuHost.childElementCount === 0) return;
    // A target that is DETACHED by the time the click bubbles here was a menu
    // item whose handler rebuilt the menu in place (the settings toggles, the
    // intro marks) — that's inside business, not an outside click. Without
    // this, every in-place toggle closed the menu it was cycling.
    if (!e.target.isConnected) return;
    if (
      menuHost.contains(e.target) ||
      ccBtn.contains(e.target) ||
      speedBtn.contains(e.target) ||
      gearBtn.contains(e.target)
    )
      return;
    closeMenu();
  };
  document.addEventListener("click", onDocClick);

  // ---------- scrubber ----------
  const totalDuration = () => {
    // While the compat remux is still generating, video.duration only covers
    // what's transcoded so far - the probed duration is the real total.
    const vd = isFinite(video.duration) ? video.duration : 0;
    return Math.max(
      usingTranscode ? clockBase + vd : vd,
      item.duration || 0,
    );
  };

  // Effective content time. h264 transcodes re-base their clock at
  // clockBase = streamOffset; PTS-honest copy jobs keep the source clock
  // (clockBase 0), so this is exact for both.
  const effTime = () =>
    (usingTranscode ? clockBase : 0) + (video.currentTime || 0);

  // ---- torrent far-seek prefetch ----
  // Restarting a torrent transcode at an offset makes ffmpeg -ss read the
  // ON-DISK file — which is sparse while downloading. Seeking into a region
  // that isn't downloaded yet made ffmpeg chew zero-holes: garbage/black
  // video, or a long stall ending in "not downloaded yet". This uses the same
  // mechanism direct-play seeking relies on: a Range request at the target
  // byte makes WebTorrent prioritize exactly those pieces, and it COMPLETES
  // only once they're really on disk — so we await it, then restart the
  // transcode on top of real data.
  let torrentByteLength = 0;
  let prefetchCtrl = null;
  const prefetchRegion = async (targetSec) => {
    if (!isTorrent || !item.downloadUrl) return true;
    const d = totalDuration();
    if (!d) return true;
    try {
      if (prefetchCtrl) prefetchCtrl.abort(); // a newer seek supersedes the old wait
      prefetchCtrl = new AbortController();
      const ctrl = prefetchCtrl;
      const timer = setTimeout(() => ctrl.abort(), 60000);
      if (!torrentByteLength) {
        const head = await fetch(item.downloadUrl, {
          headers: { Range: "bytes=0-0" },
          signal: ctrl.signal,
        });
        const cr = head.headers.get("Content-Range") || "";
        torrentByteLength = parseInt(cr.split("/")[1], 10) || 0;
        try {
          head.body && head.body.cancel && head.body.cancel();
        } catch {}
      }
      if (!torrentByteLength) {
        clearTimeout(timer);
        return true;
      }
      // Linear time→byte estimate is plenty for a prefetch hint.
      const byte = Math.max(
        0,
        Math.min(
          torrentByteLength - 1,
          Math.floor((targetSec / d) * torrentByteLength),
        ),
      );
      const end = Math.min(torrentByteLength - 1, byte + 2 * 1024 * 1024);
      const res = await fetch(item.downloadUrl, {
        headers: { Range: `bytes=${byte}-${end}` },
        signal: ctrl.signal,
      });
      await res.arrayBuffer(); // resolves only once those bytes exist
      clearTimeout(timer);
      return true;
    } catch {
      return false; // aborted (superseded seek) or timed out (starved swarm)
    }
  };

  // Seek to an ABSOLUTE content time. Transcoded streams can't seek the live
  // playlist, so we restart the transcode at that offset (debounced so a burst
  // of skips only restarts once); everything else seeks natively.
  let pendingSeek = null;
  let seekDebounce = null;
  let farSeekSeq = 0;
  // Where a far seek is HEADED, kept on the scrubber for the whole restart.
  // pendingSeek only lives until the debounce commits, so the bar used to snap
  // back to the old position and sit there until the new stream loaded — the
  // skip looked like it hadn't registered, then jumped seconds later.
  let seekPreview = null;
  // The last seek handed to the element itself ({ target, at }) — read by the
  // "stream ended early" recovery, which must go where the viewer asked.
  let lastNativeSeek = null;
  const commitSeek = () => {
    seekDebounce = null;
    if (pendingSeek == null) return;
    const target = pendingSeek;
    pendingSeek = null;
    if (party.current && Date.now() >= partyEcho) sendPartyState(!video.paused, target, "seek");
    if (usingTranscode) {
      // The live playlist only spans [windowStart, transcoded edge]. A seek
      // outside that used to clamp silently to the farthest transcoded point;
      // instead, restart the transcode at the target — for torrents, AFTER
      // waiting for the target region's bytes (see prefetchRegion above).
      const edge =
        clockBase + (isFinite(video.duration) ? video.duration : 0);
      if (target < windowStart || target >= edge + 4) {
        const seq = ++farSeekSeq;
        seekPreview = target; // hold the destination on screen while it loads
        updateScrubber();
        // HOLD the picture where it is instead of playing on from the old spot.
        // Letting it run was actively confusing — the bar said 22:29 while the
        // screen showed 3:05 — and it kept draining the same cold swarm the seek
        // needs, so it would run out and die anyway. Pausing is not stopLoad():
        // the stream stays intact and buffered, so if the seek can't be served we
        // resume from this exact frame (below) and nothing was lost.
        const resumeFrame = video.currentTime;
        const wasPlaying = !video.paused;
        if (wasPlaying) {
          try {
            video.pause();
          } catch {}
        }
        abandonedFatal = false; // a fresh seek: nothing has died yet
        let slow = null;
        if (isTorrent) {
          // Warm the swarm toward the estimated target region while the
          // server-side seek (ffmpeg reading through the blocking Range
          // route) fetches exactly what it needs. Fire-and-forget.
          prefetchRegion(target);
          spinner.classList.remove("hidden");
          slow = setTimeout(
            () => toast("Downloading that part of the movie…", "⏳"),
            1500,
          );
          // The picture is deliberately held now, so the overlay reports the
          // fetch (peers, speed, how long) for the whole wait rather than only
          // once the buffer happened to run dry.
          startTorrentOverlay(false);
        }
        // A refused seek is usually TRANSIENT: the server was still tearing
        // down the previous transcode, or momentarily at its concurrency cap
        // (its own message says "try again in a moment"). Retrying is our job,
        // not the viewer's — they pressed once and expect it to land. Keep the
        // spinner up across attempts and only speak up if it really can't be had.
        (async () => {
          const seekStarted = Date.now();
          const attempt = async () => {
            const t0 = Date.now();
            const ok = await startTranscodeAt(target, currentV);
            return { ok, ms: Date.now() - t0 };
          };
          try {
            let r = await attempt();
            // Retry only a QUICK refusal — that's the transient one (busy cap,
            // previous job still dying). A slow failure means the source really
            // couldn't deliver that region, and re-asking would just leave the
            // viewer watching a spinner for minutes.
            for (let i = 0; !r.ok && r.ms < 20000 && i < 3; i++) {
              if (exited || seq !== farSeekSeq) return; // a newer seek owns the player
              spinner.classList.remove("hidden");
              await new Promise((res) => setTimeout(res, 700));
              if (exited || seq !== farSeekSeq) return;
              r = await attempt();
            }
            if (r.ok) {
              reportMark("client_seek_outcome", {
                outcome: "landed", target: Math.round(target),
                wallMs: Date.now() - seekStarted,
              });
            }
            if (!r.ok && seq === farSeekSeq && !exited) {
              reportMark("client_seek_outcome", {
                outcome: "refused", target: Math.round(target),
                wallMs: Date.now() - seekStarted,
              });
              seekPreview = null; // give the bar back to reality
              toast(
                "That part can't be fetched right now — the source may be too slow",
                "⏳",
              );
              updateScrubber();
              // The seek is off, so the stream we were holding is the stream
              // again. If it died while we waited, rebuild it at the frame we
              // paused on (the ERROR handler deliberately left it alone);
              // otherwise just let it go from exactly where it stopped.
              if (abandonedFatal) {
                abandonedFatal = false;
                startHls(transcodeUrl(streamOffset, currentV), resumeFrame);
              } else {
                stopTorrentOverlay();
                spinner.classList.add("hidden");
                if (wasPlaying) tryPlay();
              }
            }
          } finally {
            if (slow) clearTimeout(slow);
          }
        })();
        return;
      }
    }
    lastNativeSeek = { target, at: Date.now() };
    video.currentTime = Math.max(0, target - clockBase);
    updateScrubber();
  };
  const seekTo = (sec) => {
    if (seekLocked()) return; // scrubber retargets wait for the landing too
    // (stall recovery) a seek is the viewer's own business: whatever was being
    // timed or held is void
    stall.userAt = Date.now();
    stall.hold = null;
    const total = totalDuration();
    const target = Math.max(0, Math.min(total ? total - 1 : sec, sec));
    // Debounced: a burst of remote skips moves the scrubber preview instantly
    // but touches the network once, after the presses stop — every committed
    // seek aborts the open stream and re-anchors torrent piece priorities
    // server-side, so skip-spam used to fire a request per press.
    pendingSeek = target;
    updateScrubber();
    clearTimeout(seekDebounce);
    // 250ms: long enough to coalesce a remote's auto-repeat burst, short
    // enough that a single deliberate click feels immediate (was 450 — part
    // of the answer to "why does a skip take so long", 2026-08-26).
    seekDebounce = setTimeout(commitSeek, 250);
  };

  const updateScrubber = () => {
    const d = totalDuration();
    // Priority: the seek being typed > the far seek in flight > the real clock.
    const t =
      pendingSeek != null
        ? pendingSeek
        : seekPreview != null
          ? seekPreview
          : effTime();
    scrubFill.style.width = d ? `${(t / d) * 100}%` : "0%";
    if (video.buffered.length && d) {
      // the range the playhead is IN — after a seek back, the end of the last
      // range painted everything up to an island far ahead as loaded
      let end = video.currentTime;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= video.currentTime + 0.5 && video.buffered.end(i) >= video.currentTime) end = Math.max(end, video.buffered.end(i));
      }
      const buffered = (usingTranscode ? clockBase : 0) + end;
      scrubBuffer.style.width = `${Math.min(100, (buffered / d) * 100)}%`;
    }
    // "% loaded" under the bar: how much of the FILE exists server-side —
    // 100% for library content on disk, live swarm progress for streams.
    // (The in-bar shading above still shows what THIS device has buffered.)
    bufferPct.textContent =
      serverLoaded == null
        ? ""
        : `${Math.min(100, Math.round(serverLoaded * 100))}% loaded`;
    timeNow.textContent = fmtClock(t);
    timeLeft.textContent = d ? "-" + fmtClock(d - t) : "";
  };

  const scrubFrac = (e) => {
    const rect = scrubber.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  // Drag-to-seek: sliding a finger (or the mouse) along the timeline previews
  // the target live and commits on release — a tap still seeks via the click
  // handler below. Pointer events cover mouse + touch with one code path.
  let scrubDragging = false;
  let scrubDragMoved = false; // a real slide suppresses the click that follows it
  scrubber.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (!totalDuration()) return;
    scrubDragging = true;
    scrubDragMoved = false;
    try {
      scrubber.setPointerCapture(e.pointerId);
    } catch {}
    showControls();
  });
  let lastHapticT = null;
  const landmarks = () => {
    const i = activeIntro();
    return [autoRecap && autoRecap.end, i && i.start, i && i.end, creditsStart].filter((t) => isFinite(t) && t > 0);
  };
  const paintScrubMarks = () => {
    const d = totalDuration();
    scrubMarks.innerHTML = "";
    if (!d) return;
    for (const t of landmarks()) if (t < d) scrubMarks.append(el("i", { style: { left: `${(t / d) * 100}%` } }));
  };
  const hapticAt = (t) => {
    if (lastHapticT != null && navigator.vibrate) {
      const lo = Math.min(lastHapticT, t);
      const hi = Math.max(lastHapticT, t);
      if (landmarks().some((m) => m > lo && m <= hi)) {
        try { navigator.vibrate(10); } catch {}
      }
    }
    lastHapticT = t;
  };
  scrubber.addEventListener("pointermove", (e) => {
    if (!scrubDragging) return;
    const d = totalDuration();
    if (!d) return;
    scrubDragMoved = true;
    const frac = scrubFrac(e);
    // Live preview only — pendingSeek moves the bar/clock via updateScrubber,
    // and nothing commits until the finger lifts.
    pendingSeek = frac * d;
    hapticAt(pendingSeek);
    clearTimeout(seekDebounce);
    updateScrubber();
    scrubTip.textContent = fmtClock(frac * d);
    scrubTip.style.left = `${frac * 100}%`;
    scrubTip.classList.remove("hidden");
    showControls();
  });
  scrubber.addEventListener("pointerup", (e) => {
    if (!scrubDragging) return;
    scrubDragging = false;
    lastHapticT = null;
    scrubTip.classList.add("hidden");
    if (scrubDragMoved) seekTo(scrubFrac(e) * totalDuration());
  });
  scrubber.addEventListener("pointercancel", () => {
    if (!scrubDragging) return;
    scrubDragging = false;
    scrubDragMoved = false;
    pendingSeek = null; // abandon the preview, give the bar back to the clock
    scrubTip.classList.add("hidden");
    updateScrubber();
  });

  scrubber.addEventListener("click", (e) => {
    // OK/Enter on the focused scrubber arrives as a synthetic click with no
    // coordinates — seeking to clientX 0 would jump to 0:00. Toggle play instead.
    if (!e.isTrusted && !e.clientX && !e.clientY) {
      togglePlay();
      return;
    }
    // A slide already committed its seek on pointerup — the click that the
    // browser fires right after must not re-seek (or jitter the target).
    if (scrubDragMoved) {
      scrubDragMoved = false;
      return;
    }
    const d = totalDuration();
    if (d) seekTo(scrubFrac(e) * d);
  });

  // Hover tooltip with the time under the cursor
  scrubber.addEventListener("mousemove", (e) => {
    const d = totalDuration();
    if (!d) return;
    const rect = scrubber.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    scrubTip.textContent = fmtClock(frac * d);
    scrubTip.style.left = `${frac * 100}%`;
    scrubTip.classList.remove("hidden");
  });
  scrubber.addEventListener("mouseleave", () =>
    scrubTip.classList.add("hidden"),
  );

  // ---------- watch party ----------
  // Shared remote: our play / pause / seek goes to the others; theirs lands
  // here. `partyEcho` mutes the video events our own remote-apply causes.
  const partyCode = (location.hash.match(/[?&]party=([A-Za-z0-9]{4,6})/) || [])[1] || null;
  let partyEcho = 0;
  let partySync = null;
  // Set when this player hands over to the next episode's player with the
  // party still running (host moved on, or guest following) — the route
  // cleanup then leaves the party alone instead of ending it.
  let keepParty = false;
  const inParty = () => !!party.current;
  const partySnapshotOf = (it) =>
    it._isTorrent || isTorrent && it.id === item.id
      ? { ...(streamMeta() || {}), cover: it.cover, backdrop: it.backdrop }
      : { id: it.id, title: it.title, showTitle: it.showTitle || item.showTitle, season: it.season, episode: it.episode, cover: it.cover || item.cover };
  // What the PERSON did — play/pause from the button, remote or media key,
  // and committed seeks — goes to the party. Raw video play/pause events do
  // not: the player's own transcode restarts and start-up juggling fire
  // those constantly, and a guest joining would announce "pressed play" to
  // the room before a single frame showed.
  partyUser = (playing) => {
    if (!inParty() || Date.now() < partyEcho) return;
    sendPartyState(playing, effTime(), playing ? "play" : "pause");
  };
  const applyPartyState = (st, announce) => {
    partyEcho = Date.now() + 1500;
    const elapsed = st.playing && st.now && st.at ? Math.max(0, st.now - st.at) / 1000 : 0;
    const target = (st.position || 0) + elapsed;
    // A transcoded / torrent stream restarts its whole pipeline on a seek,
    // so a guest on one tolerates far more drift on the periodic sync (and
    // a few seconds on a deliberate jump). Exact jumps still land exactly.
    const heavy = usingTranscode || isTorrent;
    const drift = effTime() - target;
    const tol = st.kind === "sync" ? (heavy ? 8 : 2.5) : heavy ? 3 : 1.2;
    if (Math.abs(drift) > tol) seekTo(target);
    if (st.playing && video.paused) video.play().catch(() => {});
    else if (!st.playing && !video.paused) video.pause();
    if (announce && st.by && st.kind !== "sync") {
      toast(
        st.kind === "pause" ? `${st.by} paused` : st.kind === "play" ? `${st.by} pressed play` : `${st.by} jumped to ${fmtClock(target)}`,
        "👥",
      );
    }
  };
  const paintParty = () => {
    const p = party.current;
    partyPill.classList.toggle("hidden", !p);
    partyBtn.classList.toggle("active", !!p);
    if (!p) {
      partyPanel.classList.add("hidden");
      return;
    }
    partyPill.textContent = `👥 ${p.members.length} · ${p.code}`;
    partyPanel.innerHTML = "";
    const chip = (m) =>
      el(
        "span",
        { class: "party-member" },
        m.avatarImage ? el("img", { src: m.avatarImage, alt: "" }) : el("span", { class: "party-avatar" }, m.avatar || "👤"),
        el("span", {}, m.name + (p.host && p.host.id === m.id ? " · host" : "")),
      );
    partyPanel.append(
      el("div", { class: "party-head" }, el("span", {}, "Watch together"), el("button", { class: "btn btn-icon focusable", "aria-label": "Close", html: "✕", onclick: () => partyPanel.classList.add("hidden") })),
      el("div", { class: "party-code" }, ...p.code.split("").map((c) => el("span", {}, c))),
      el(
        "div",
        { class: "party-hint" },
        "On another device: profile menu → Join a watch party, and type the code. Anyone can play, pause or jump — everyone follows.",
      ),
      el("div", { class: "party-members" }, p.members.map(chip)),
      el("div", { class: "party-actions" },
        el("button", {
          class: "btn focusable",
          html: `<span>${party.role === "host" ? "End party" : "Leave party"}</span>`,
          onclick: () => {
            const wasHost = party.role === "host";
            leaveParty();
            paintParty();
            toast(wasHost ? "Party ended" : "Left the party", "👥");
          },
        }),
      ),
    );
  };
  const startParty = async () => {
    try {
      await createParty(partySnapshotOf(item));
      track("feat", { f: "party_start" });
      // the party starts from where we are, in our state
      sendPartyState(!video.paused, effTime(), "sync");
      paintParty();
      partyPanel.classList.remove("hidden");
      pushScope(partyPanel);
      toast("Party started — share the code", "👥");
    } catch (e) {
      toast(`Couldn't start a party: ${e.message}`, "⚠️");
    }
  };
  // Not in a party yet: the first press explains what a party is (and that
  // it shows on everyone's Home) before anything is announced.
  const paintPartyInvite = () => {
    partyPanel.innerHTML = "";
    partyPanel.append(
      el("div", { class: "party-head" }, el("span", {}, "Watch together"), el("button", { class: "btn btn-icon focusable", "aria-label": "Close", html: "✕", onclick: () => { partyPanel.classList.add("hidden"); popScope(partyPanel); } })),
      el(
        "div",
        { class: "party-hint" },
        "Start a party and Aurora hands you a four-letter code. Anyone on another device joins with it (profile menu → Join a watch party) and play, pause and jumps stay in step. Everyone on Aurora sees the party on their Home and can join.",
      ),
      el("div", { class: "party-actions" },
        el("button", { class: "btn btn-primary focusable", html: "<span>Start a party</span>", onclick: startParty }),
      ),
    );
  };
  togglePartyPanel = async () => {
    if (!inParty()) paintPartyInvite();
    const open = partyPanel.classList.toggle("hidden");
    if (!open) pushScope(partyPanel);
    else popScope(partyPanel);
  };
  const unsubParty = [
    onPartyState((st) => applyPartyState(st, true)),
    onPartyUpdate(() => paintParty()),
    onPartyEnded(() => {
      paintParty();
      popScope(partyPanel);
    }),
    // The host moved to another title (Up next, mostly): follow it, party intact.
    onPartyItem(({ item: next, party: p }) => {
      if (!next || party.role === "host" || String(next.id) === String(item.id)) return;
      if (String(next.id).startsWith("torrent|")) state.pendingItems[next.id] = next;
      keepParty = true;
      toast(`${p && p.host ? p.host.name : "The host"} moved on to ${next.showTitle ? `S${next.season} E${next.episode}` : next.title || "the next title"}`, "👥");
      goPlay(`#/play/${encodeURIComponent(next.id)}?party=${p ? p.code : partyCode}`);
    }),
  ];
  // Joining via #/play/<id>?party=CODE (the #/party/:code route lands here).
  if (partyCode && party.current && party.current.code === partyCode) {
    // already in it — the host rolled into the next episode, or a guest
    // followed; the role and the code carry over untouched
    paintParty();
  } else if (partyCode) {
    const tryJoin = async () => {
      try {
        const p = await joinParty(partyCode);
        paintParty();
        toast(`Joined ${p.host ? p.host.name + "'s" : "the"} party`, "👥");
        // land where they are — once the video can seek
        const land = () => applyPartyState({ ...p.state, now: p.now, kind: "sync" }, false);
        if (video.readyState >= 1) land();
        else video.addEventListener("loadedmetadata", land, { once: true });
      } catch (e) {
        toast(`Couldn't join: ${e.message}`, "⚠️");
      }
    };
    // the socket may still be connecting on a fresh page load
    if (state.ws && state.ws.readyState === WebSocket.OPEN) tryJoin();
    else setTimeout(tryJoin, 1200);
  }
  // Periodic sync while playing, from whoever is in the party — a heartbeat
  // that late joiners and drifters correct against (guests only act on it
  // when they're more than 2.5s out).
  partySync = setInterval(() => {
    if (inParty() && !video.paused && party.role === "host") sendPartyState(true, effTime(), "sync");
  }, 5000);

  // ---------- resume card ----------
  // "Resuming from 12:34", with the frame at that spot for a library file
  // (/img/frame — the stills pipeline, so it costs one ffmpeg call the first
  // time and nothing after). Non-blocking: playback carries on underneath;
  // "Start over" is one press away for the six seconds it stays up, then it
  // fades. Streams have no file to pull a frame from, so they keep the toast.
  let resumeCard = null;
  let resumeAnnounced = false; // once per visit — transcode restarts re-fire the load handler
  const showResumeCard = (at) => {
    if (resumeAnnounced) return;
    resumeAnnounced = true;
    if (isTorrent || !overlay) {
      return toast(`Resumed at ${fmtClock(at)}`, "▶️", { label: "Start over", onClick: () => seekTo(0) });
    }
    if (resumeCard) resumeCard.remove();
    // Toned down (elia): a small dim pill at the top — "Resumed at 12:34 ·
    // Start over" — for four seconds, instead of a card with the frame and a
    // big button over the picture. No frame also means no ffmpeg call on the
    // server every time someone resumes.
    const startOver = el("button", {
      class: "focusable",
      onclick: () => {
        seekTo(0); // understands the transcode clock; currentTime = 0 would land on the resume point
        dismiss();
        toast("From the top", "⏮", null, { quiet: true });
      },
    }, "Start over");
    resumeCard = el("div", { class: "quality-pill resume-pill" }, el("span", {}, `Resumed at ${fmtClock(at)}`), startOver);
    let timer = null;
    const dismiss = () => {
      clearTimeout(timer);
      if (!resumeCard) return;
      resumeCard.classList.add("hide");
      const node = resumeCard;
      resumeCard = null;
      setTimeout(() => node.remove(), 550);
    };
    overlay.append(resumeCard);
    timer = setTimeout(dismiss, 4000);
  };

  // ---------- progress persistence ----------
  // For torrent streams, send a trimmed play-item so Continue Watching can
  // render and resume it (torrent ids aren't in the server's library scanner).
  const streamMeta = () => {
    if (!isTorrent) return undefined;
    return {
      id: item.id,
      type: item.type,
      title: item.title,
      year: item.year,
      cover: item.cover,
      backdrop: item.backdrop,
      imdbId: item.imdbId,
      infoHash: item.infoHash,
      season: item.season,
      episode: item.episode,
      videoUrl: item.videoUrl,
      downloadUrl: item.downloadUrl,
      transcodeBase: item.transcodeBase,
      transcodeV: item.transcodeV,
      needsTranscode: item.needsTranscode,
      quality: item.quality,
      duration: item.duration,
      _isTorrent: true,
      returnHash: item.returnHash,
    };
  };

  const saveProgress = () => {
    const d = totalDuration();
    if (!state.profile || !d) return;
    // (stall recovery) While a rebuilt stream is still coming back, the media
    // clock sits at 0 — saving now would move the resume point to the start
    // of the stream (of the FILM, on a jit stream). The last good save stands
    // until the picture is back where it was.
    if (stall.hold && stall.hold.gen === hlsGen && (video.currentTime || 0) < stall.hold.pos - 2) return;
    // Save the EFFECTIVE content time (transcode offset + clock) so resume lands
    // where the viewer actually stopped, not where the transcode session began.
    const pos = effTime();
    api
      .saveProgress(state.profile.id, item.id, pos, d, streamMeta())
      .then(() => {
        // a good save also refreshes the local view, so the Saved screen and
        // resume points don't lag while the server is reachable
        state.progress[item.id] = { position: Math.floor(pos), duration: Math.floor(d), finished: d > 0 && pos / d > 0.95, updatedAt: Date.now() };
      })
      .catch(() => {
        // offline: keep it here, flushed when the server is back (main.js)
        state.progress[item.id] = { position: Math.floor(pos), duration: Math.floor(d), finished: d > 0 && pos / d > 0.95, updatedAt: Date.now() };
        offline.queueProgress(state.profile.id, item.id, pos, d);
      });
  };

  // ---------- Up Next ----------
  let upNextEl = null;
  let countdownTimer = null;

  // Streamed episodes know their show through the IMDb id — they have no
  // library showId, which is why Up Next used to never appear for them.
  const isStreamEpisode = !!(isTorrent && item.imdbId && item.season && item.episode);

  const findNextEpisode = async () => {
    // A saved copy: the next SAVED episode, played from this device like this
    // one — with or without a server. (None saved: fall through and ask the
    // server, which offers the next library episode when it is in reach.)
    if (item._offline) {
      const n = await offline.nextSaved(item).catch(() => null);
      if (n) return { ...n, _savedCopy: true };
    }
    if (isEpisode) {
      const show = await api.item(item.showId);
      const flat = show.seasons.flatMap((s) => s.episodes || []);
      const i = flat.findIndex((e) => e.id === item.id);
      if (i < 0) return null;
      const cur = flat[i];
      const lib = flat[i + 1] || null;
      // The library only lists the episodes that are ON DISK. With E1–E4 and
      // E8 downloaded, "next" after E4 used to be E8 — Up next (and the Next
      // button) jumped three episodes ahead (found 2026-10-08). The one right
      // after this one is trusted as it is; anything else is checked against
      // the series' real episode list, and an episode that isn't downloaded
      // is offered the way a streamed one is: pick a source, never auto-play.
      if (lib && lib.season === cur.season && lib.episode === cur.episode + 1) return lib;
      const imdbId = show.imdbId || item.imdbId;
      if (!imdbId || !cur.season || !cur.episode) return lib; // nothing to check against
      let all;
      try {
        const meta = await api.discoverMeta("series", imdbId);
        all = (meta.seasons || []).filter((s) => s.number > 0).flatMap((s) => s.episodes || []);
      } catch {
        return lib; // no catalogue right now: what the library has, as before
      }
      const j = all.findIndex((e) => e.season === cur.season && e.episode === cur.episode);
      if (j < 0) return lib; // the catalogue doesn't know this episode
      const real = all[j + 1];
      if (!real) return null; // the series ends here
      if (lib && lib.season === real.season && lib.episode === real.episode) return lib;
      if (real.released && new Date(real.released) > new Date()) return null; // not aired yet
      return { ...real, imdbId, _stream: true };
    }
    if (isStreamEpisode) {
      const meta = await api.discoverMeta("series", item.imdbId);
      const flat = (meta.seasons || [])
        .filter((s) => s.number > 0) // specials (season 0) are not "next"
        .flatMap((s) => s.episodes || []);
      const i = flat.findIndex(
        (e) => e.season === item.season && e.episode === item.episode,
      );
      const next = i >= 0 ? flat[i + 1] : null;
      if (!next) return null;
      // An unaired episode is not up next, whatever the metadata lists.
      if (next.released && new Date(next.released) > new Date()) return null;
      // Already downloaded? Then it's a library episode: "Play now" and
      // auto-advance, never a trip back to the sources list.
      const owned = await api
        .libraryFor({
          imdbId: item.imdbId,
          type: "series",
          title: item.title,
          year: item.year,
          season: next.season,
          episode: next.episode,
        })
        .catch(() => null);
      if (owned && owned.id && owned.showId) {
        return { ...owned, title: owned.title || next.title };
      }
      return { ...next, _stream: true };
    }
    return null;
  };

  const showUpNext = async () => {
    if (upNextShown) return;
    upNextShown = true;
    let next;
    try {
      next = await findNextEpisode();
    } catch {
      // Transient lookup failure must not latch upNextShown forever — the
      // timeupdate ticks near the end will retry.
      upNextShown = false;
      return;
    }
    if (!next || exited) return;

    // Auto-advance only where "play" is unambiguous (a library file). A
    // streamed next episode needs a source picked — never auto-pick a torrent.
    // A guest never advances on its own — the host's party_item does that
    // for everyone, so two countdowns can't race and drop the guest out.
    const autoplay = !next._stream && prefs.get("autoplayNext", true) && !(inParty() && party.role === "guest");
    // "Still watching?" — three episodes have started by themselves with no
    // one touching anything in between: this one waits to be asked for.
    // Never in a watch party (the room decides together), and only where an
    // automatic start was about to happen at all.
    if (autoplay && !inParty() && autoRunN >= STILL_WATCHING_AFTER) {
      track("feat", { f: "still_watching_shown" });
      upNextEl = el(
        "div",
        { class: "upnext still-watching" },
        el("div", { class: "k" }, "Still watching?"),
        el("div", { class: "t" }, `Up next · S${next.season} E${next.episode} · ${next.title}`),
        el(
          "div",
          { class: "upnext-actions" },
          el("button", {
            class: "btn btn-primary focusable",
            html: icons.play + `<span>Keep watching</span>`,
            onclick: () => {
              noteInput();
              track("feat", { f: "still_watching_keep" });
              goNext(next);
            },
          }),
          el("button", {
            class: "btn focusable",
            onclick: () => {
              noteInput();
              track("feat", { f: "still_watching_done" });
              dismissUpNext();
              exit();
            },
          }, "I'm done"),
        ),
      );
      overlay.append(upNextEl);
      upNextEl.querySelector(".btn-primary").focus({ preventScroll: true });
      return; // no countdown: nothing starts until someone answers
    }
    let remaining = 15;
    const counter = el(
      "span",
      { class: "ring" },
      autoplay ? String(remaining) : "",
    );
    upNextEl = el(
      "div",
      { class: "upnext" },
      el("div", { class: "k" }, "Up next"),
      el(
        "div",
        { class: "t" },
        `S${next.season} E${next.episode} · ${next.title}`,
      ),
      el(
        "div",
        { class: "upnext-actions" },
        el("button", {
          class: "btn btn-primary focusable",
          html: next._stream
            ? icons.play + `<span>Choose episode</span>`
            : icons.play + `<span>Play now</span>`,
          onclick: () => goNext(next),
        }),
        el(
          "button",
          { class: "btn focusable", onclick: dismissUpNext },
          autoplay ? counter : null,
          autoplay ? " Dismiss" : "Dismiss",
        ),
      ),
    );
    overlay.append(upNextEl);
    upNextEl.querySelector(".btn-primary").focus({ preventScroll: true });

    if (autoplay) {
      countdownTimer = setInterval(() => {
        remaining--;
        counter.textContent = String(remaining);
        if (remaining <= 0) {
          // started by itself: one more in the run the next player reads
          // (a party's episodes are never counted)
          if (inParty()) autoRun.write(0);
          else autoRun.write(autoRunN + 1, next.id);
          goNext(next);
        }
      }, 1000);
    }
  };

  // Someone is there: a key, a click, a tap, a remote, a headset button. The
  // run of self-started episodes is over. (A function declaration — hoisted —
  // so the handlers wired anywhere in this function can name it.)
  function noteInput() {
    if (!autoRunN) return;
    autoRunN = 0;
    autoRun.write(0);
  }

  const dismissUpNext = () => {
    clearInterval(countdownTimer);
    if (upNextEl) upNextEl.remove();
    upNextEl = null;
  };

  const goNext = (next) => {
    dismissUpNext();
    saveProgress();
    if (inParty() && party.role === "guest") {
      toast("Following the host — the next episode starts when theirs does", "👥");
      return;
    }
    // Streamed episode: back to the show's page to pick a source — episode
    // deep-linked so it's one press away.
    if (next._stream) {
      navigate(`#/discover/series/${next.imdbId || item.imdbId}?s=${next.season}&e=${next.episode}`);
      return;
    }
    // A hosted party comes along: the guests are told the new episode and
    // follow; the next player finds the party still running.
    if (inParty() && party.role === "host") {
      setPartyItem(partySnapshotOf(next));
      keepParty = true;
      goPlay(`#/play/${next.id}?party=${party.current.code}`);
      return;
    }
    if (inParty()) keepParty = false;
    goPlay(`#/play/${next.id}${next._savedCopy ? "?offline=1" : ""}`);
  };

  // the Next episode button learns what is next once, a moment after start
  if (isEpisode) {
    setTimeout(async () => {
      if (exited) return;
      try {
        const n = await findNextEpisode();
        if (!n || exited) return;
        nextKnown = n;
        nextBtn.title = `Next episode — S${n.season} E${n.episode}${n.title ? ` · ${n.title}` : ""}`;
        nextBtn.classList.remove("hidden");
      } catch {}
    }, 1500);
  }

  // ---------- skip intro ----------
  // A per-SHOW intro range anyone in the household marks once from the
  // settings menu; every episode then offers this button inside the range.
  // Stored server-side (/api/intro) so it works on every device and profile.
  const introKey = isEpisode
    ? `show:${item.showId}`
    : isStreamEpisode
      ? `imdb:${item.imdbId}`
      : null;
  let intro = null; // {start, end} seconds, content-absolute
  let introMarkStart = null; // first half of an in-progress marking
  // Detected from the file (chapters, or the audio every episode of the
  // season shares): the skip range when nobody marked one by hand, and where
  // the credits start — Up Next then appears exactly there instead of at a
  // guessed distance from the end.
  let autoIntro = null;
  let creditsStart = null;
  // "Previously on…" — only the public databases know these (a recap repeats
  // in no other episode, so the audio comparison can never find one). The
  // same button offers it, under its own name.
  let autoRecap = null;
  const skipIntroBtn = el("button", {
    class: "btn skip-intro focusable hidden",
    html: `<span>Skip intro</span> ⏭`,
    onclick: () => {
      const seg = skippableNow();
      if (!seg) return;
      skipIntroBtn.classList.add("hidden");
      track("feat", { f: seg.kind === "recap" ? "skip_recap" : "skip_intro" });
      seekTo(seg.range.end);
    },
  });
  overlay.append(skipIntroBtn);
  // (a saved copy starts from the mark it was saved with; the server's
  // answer, when there is one, replaces it)
  if (item._offline && item.introMark) intro = item.introMark;
  if (introKey) {
    api
      .intro(introKey)
      .then((r) => {
        if (r && isFinite(r.start) && isFinite(r.end)) intro = r;
        paintScrubMarks();
      })
      .catch(() => {});
  }
  // A detected intro the household says is wrong stays ignored for that
  // show on this device (the manual marks, saved on the server, always win).
  const IGNORE_KEY = "aurora-intro-ignore";
  const ignoredIntros = () => {
    try { return JSON.parse(localStorage.getItem(IGNORE_KEY) || "[]"); } catch { return []; }
  };
  const introIgnored = () => !!introKey && ignoredIntros().includes(introKey);
  const ignoreAutoIntro = () => {
    if (!introKey) return;
    try { localStorage.setItem(IGNORE_KEY, JSON.stringify([...new Set([...ignoredIntros(), introKey])])); } catch {}
    autoIntro = null;
    autoRecap = null;
    skipIntroBtn.classList.add("hidden");
  };
  // One shape from both doors: a library episode asks by file id (its own
  // detection first, the public databases under it); a STREAMED episode has
  // no file to analyse and asks by identity — which is what finally gives
  // streams a Skip intro and an Up next timed to the credits.
  const applyAutoSegments = (r) => {
    if (!r) return;
    const ok = (x) => x && isFinite(x.start) && isFinite(x.end) && x.end > x.start;
    if (ok(r.intro) && !introIgnored()) autoIntro = r.intro;
    if (ok(r.recap) && !introIgnored()) autoRecap = r.recap;
    if (r.credits && isFinite(r.credits.start)) creditsStart = r.credits.start;
    paintScrubMarks();
  };
  if (isEpisode) {
    // A saved copy plays the same timeline as the file it was made from, so
    // the same ranges apply. It carries them (offline.js extrasFor) — Skip
    // intro, Skip recap and the credits-timed Up next work on a plane — and
    // when the server IS in reach its current answer wins and is kept.
    // (a tick later: applying them repaints the scrubber's marks, which reads
    // names declared just below this block)
    if (item._offline && item.segments) Promise.resolve().then(() => applyAutoSegments(item.segments));
    api
      .introAuto(item.id)
      .then((r) => {
        applyAutoSegments(r);
        if (item._offline && r) {
          offline.patchSaved(item.id, { segments: { intro: r.intro || null, recap: r.recap || null, credits: r.credits || null }, extrasAt: Date.now() }).catch(() => {});
        }
      })
      .catch(() => {});
  } else if (isStreamEpisode) {
    api
      .segments({ imdbId: item.imdbId, season: item.season, episode: item.episode, duration: item.duration || 0 })
      .then(applyAutoSegments)
      .catch(() => {});
  }
  const activeIntro = () => intro || autoIntro;
  // What the button would skip at this moment: the recap while inside it,
  // else the intro. Never in a range's final second — skipping to "one
  // second from now" reads as a broken button.
  const skippableNow = () => {
    const t = effTime();
    const inside = (x) => x && t >= x.start && t < x.end - 1;
    if (inside(autoRecap)) return { kind: "recap", range: autoRecap };
    const i = activeIntro();
    if (inside(i)) return { kind: "intro", range: i };
    return null;
  };
  // While an intro is being marked, a chip on the video carries the second
  // press ("ends here") so nobody has to find the gear menu again. Shared
  // with the menu's "Mark intro end (save)" entry through saveIntroEnd.
  let markChip = null;
  const hideMarkChip = () => { if (markChip) markChip.remove(); markChip = null; };
  const saveIntroEnd = async () => {
    const end = Math.floor(effTime());
    if (end <= introMarkStart) return toast("The end has to come after the start", "⏭");
    try {
      await api.setIntro(introKey, introMarkStart, end);
      intro = { start: introMarkStart, end };
      toast("Saved — every episode of this show now offers Skip intro", "⏭");
    } catch (e) {
      toast(e.message || "Couldn't save the intro", "⚠️");
    }
    introMarkStart = null;
    hideMarkChip();
  };
  const showMarkChip = () => {
    hideMarkChip();
    if (!overlay) return;
    markChip = el(
      "div",
      { class: "mark-chip" },
      el("span", { class: "mark-chip-k" }, `Intro starts ${fmtClock(introMarkStart)}`),
      el("button", { class: "btn small btn-primary focusable", onclick: () => { saveIntroEnd(); } }, "Ends here ✓"),
      el("button", { class: "btn small focusable", "aria-label": "Cancel marking", onclick: () => { introMarkStart = null; hideMarkChip(); } }, "✕"),
    );
    overlay.append(markChip);
  };
  let skipLabel = "intro";
  const maybeSkipIntro = () => {
    if (!activeIntro() && !autoRecap) return;
    const seg = video.paused ? null : skippableNow();
    if (seg && seg.kind !== skipLabel) {
      skipLabel = seg.kind;
      skipIntroBtn.innerHTML = `<span>Skip ${seg.kind}</span> ⏭`;
    }
    skipIntroBtn.classList.toggle("hidden", !seg);
  };

  // ---------- video events ----------
  video.addEventListener("loadedmetadata", () => {
    // Fires on every (re)load — including transcode restarts that change
    // streamOffset (far seek / resume). Re-anchor all subtitle cues to the
    // new clock, or subs go out of sync the moment a seek restarts the stream.
    applyOffsetAll();
    paintScrubMarks();
    // The new stream's clock is valid from here, so the held seek target can
    // hand the scrubber back to it without the bar ever stepping backwards.
    seekPreview = null;
    const prog = progressFor(item.id) || titleProgressFor(item);
    // Transcoded streams resume by starting the transcode at the saved offset
    // (baked into streamOffset at startup), so no client-side seek here. Direct
    // and library playback seek natively.
    if (
      !usingTranscode &&
      !restart &&
      prog &&
      !prog.finished &&
      prog.position > 10 &&
      prog.position < totalDuration() - 20
    ) {
      // four seconds early, the same as resumeAt on the repackaged path
      const at = Math.max(0, Math.floor(prog.position) - 4);
      video.currentTime = at;
      showResumeCard(at);
    } else if (usingTranscode && resumeAt > 0) {
      showResumeCard(resumeAt);
    }
    // RE-ASSERT the chosen subtitle track. A transcode restart (far seek /
    // resume) tears down hls.js and re-attaches the media element, which resets
    // every text track to "disabled" — so the subtitles the viewer had on simply
    // vanished after each skip, and "Resync" (which reloads whichever track is
    // *showing*) then had nothing to act on, which is why it appeared to do
    // nothing. selectTrack also re-applies the cue anchor for the new
    // streamOffset. Turning subs off stays off: only the FIRST load auto-picks.
    if (activeTrack >= 0) {
      selectTrack(activeTrack);
    } else if (!autoSubsApplied && (item.subtitles || []).length > 0) {
      autoSubsApplied = true;
      const auto = autoTrackIndex(0);
      if (auto >= 0) selectTrack(auto);
    }
    updateScrubber();
  });
  // The credits window scales with runtime — a fixed 30s missed the long
  // credits of hour-long episodes and fired mid-scene on very short ones.
  const upNextWindow = (d) => Math.max(30, Math.min(90, d * 0.05));
  const maybeUpNext = () => {
    if (!isEpisode && !isStreamEpisode) return;
    const d = totalDuration();
    if (!d) return;
    const t = effTime();
    const remaining = d - t;
    // Detected credits: Up Next appears the moment they start. Otherwise the
    // runtime-scaled window near the end.
    const win = creditsStart && creditsStart < d - 5 ? d - creditsStart : upNextWindow(d);
    if (remaining <= win) {
      // Only while actually playing — pausing on (or scrubbing across) the
      // last minute shouldn't pop a countdown over the frame.
      if (!video.paused) showUpNext();
    } else if (remaining > win + 15) {
      // Seeked back out of the credits: retract the popup (cancelling any
      // countdown) and re-arm so it can return when the credits do.
      if (upNextEl) dismissUpNext();
      upNextShown = false;
    }
  };
  video.addEventListener("timeupdate", () => {
    updateScrubber();
    maybeUpNext();
    maybeSkipIntro();
  });
  video.addEventListener("play", () => {
    playBtn.innerHTML = icons.pause;
    showControls();
  });
  video.addEventListener("pause", () => {
    playBtn.innerHTML = icons.play;
    showControls();
  });
  video.addEventListener("waiting", () => {
    spinner.classList.remove("hidden");
    // A torrent stream that stalls mid-playback: bring the peers/speed overlay
    // back (debounced so brief hiccups don't flash it).
    if (isTorrent && item.infoHash) {
      clearTimeout(rebufferTimer);
      rebufferTimer = setTimeout(() => {
        if (!exited && !video.paused && video.readyState < 3)
          startTorrentOverlay(false);
      }, 600);
    }
  });
  // ---- a line that stops keeping up, mid-film ----
  // The stream steps down by itself (file → 720p → 480p) at the same spot,
  // and back up when the line has room again. Three things can call for it:
  //  • THE WATCHER (below), once a second: the buffer ahead of the playhead is
  //    short AND filling slower than the film plays. That is the line falling
  //    behind, read off the stream itself, usually seconds BEFORE the picture
  //    would freeze — so the change happens while the film is still moving.
  //  • a stall that lasts three seconds, or two short ones within three
  //    minutes — for whatever the watcher did not see coming. These ask for a
  //    fresh measurement first (a stall on a fast line is the disk or the
  //    server, and a smaller picture would fix nothing).
  //  • the watcher again, the other way: the line has carried well over what
  //    the next quality up needs for a quarter of a minute — step back up.
  //    Twice a film at most, and never again once a step up is followed by
  //    trouble: a line that cannot hold it is not asked a third time.
  // A small chip says what happened, with Revert on a step down for the
  // viewer who would rather wait for the full picture; reverting, or choosing
  // a quality by hand, ends the automatic changes for this film.
  let stallAt = 0;
  let longStallTimer = null;
  let excuseTimer = null;
  let steppingDown = false;
  const stallTimes = [];
  // One small chip in the top corner, for every kind of change: the stream
  // stepping down by itself ("Auto 720p" with Revert, six seconds), stepping
  // back up, and the viewer picking a quality ("720p", two seconds, nothing
  // to press). It fades in and out where it is — nothing slides over the film.
  let qualityPill = null;
  const qualityChip = (text, ms, action = null) => {
    if (qualityPill) qualityPill.remove();
    const pill = (qualityPill = el("div", { class: "quality-pill hide" }, el("span", {}, text), action));
    overlay.append(pill);
    requestAnimationFrame(() => pill.classList.remove("hide"));
    setTimeout(() => pill.classList.add("hide"), ms);
    setTimeout(() => pill.remove(), ms + 600);
    return pill;
  };
  showQualityNote = (text) => qualityChip(text, 2000);
  const showQualityPill = (hNow, prev) => {
    const pill = qualityChip(`Auto ${hNow}p`, 6000, el("button", {
      class: "focusable",
      title: `${hNow}p for your connection — go back to ${prev ? `${prev}p` : "the original"}`,
      onclick: () => {
        pill.remove();
        excuseUntil = Date.now() + 15000;
        track("feat", { f: "quality_revert" });
        switchQuality(prev);
      },
    }, "Revert"));
  };
  // What the watcher last read off the stream: { kbps (null when the stream's
  // own bitrate is unknown), at }. Fresh, it IS the measurement — no probe.
  let lineEst = null;
  let upsLeft = 2;
  let steppedUpAt = 0;
  const stepDown = async (reason = "stalls") => {
    // on a ladder hls.js does the stepping, both ways
    if (ladderAsked) return;
    if (!autoQuality || steppingDown || exited || capH === 480 || probing || seekLocked()) return;
    steppingDown = true;
    try {
      let kbps;
      if (lineEst && Date.now() - lineEst.at < 8000) kbps = lineEst.kbps;
      else {
        const m = await probe();
        if (exited || !autoQuality || !m) return;
        // thin for what is playing now: the file itself, or the 720p stream
        // (bitrate unknown: anything under 8 Mbit/s may well be the reason)
        const thin = capH === 720 ? m.kbps < 2800 : fileKbps != null ? m.kbps < fileKbps * 1.3 : m.kbps < 8000;
        if (!thin) return;
        kbps = m.kbps;
      }
      const prev = capH;
      const next = prev === 720 ? 480 : kbps == null ? 720 : capFor(kbps);
      // trouble soon after a step up: this line does not hold it — stop trying
      if (steppedUpAt && Date.now() - steppedUpAt < 120000) upsLeft = 0;
      lastChangeAt = Date.now();
      stallTimes.length = 0;
      excuseUntil = Date.now() + 15000;
      // Onto the ladder when there can be one — the stream begins on the
      // lighter level and hls.js takes it from there, back up included. The
      // capped offset job otherwise, as before.
      let ok = false;
      if (ladderEligible()) {
        holdNext = true;
        ok = await tryJitSwitch(effTime(), { startH: next });
        if (!ok) holdNext = false;
      }
      if (!ok && !exited) {
        capH = next;
        ok = await startTranscodeAt(effTime(), "h264", { quiet: true, live: true });
      }
      if (exited) return;
      if (!ok) {
        // the server can't spare an encode: stay as we were, and stop asking
        capH = prev;
        autoQuality = false;
        return;
      }
      reportMark("client_switch", { reason, to: `h264-${next}`, position: effTime() });
      track("feat", { f: `quality_stepdown_${next}` });
      showQualityPill(next, prev);
    } finally {
      steppingDown = false;
    }
  };
  const beginStall = () => {
    stallAt = Date.now();
    clearTimeout(longStallTimer);
    longStallTimer = setTimeout(() => stepDown("stalls"), 3000);
  };
  video.addEventListener("seeking", () => {
    excuseUntil = Math.max(excuseUntil, Date.now() + 8000);
    watchFrom = Math.max(watchFrom, Date.now() + 5000);
  });

  // THE WATCHER. Once a second while the film plays: where the buffer ends,
  // against where it ended three seconds ago. `fill` is seconds of film
  // arriving per second of clock — under 1 with little in hand means the
  // freeze is coming; times the stream's bitrate it is the line's real speed.
  // (With plenty buffered the browser stops fetching, so `fill` only means
  // something when the buffer is short — which is the only time it is asked.)
  if (canCap) {
    const win = [];
    let thinSince = 0;
    let richSince = 0;
    const bufEnd = () => {
      const b = video.buffered;
      const t = video.currentTime;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.25 && b.end(i) >= t) return b.end(i);
      return t;
    };
    const watcher = setInterval(() => {
      if (exited) return clearInterval(watcher);
      const now = Date.now();
      if (ladderAsked || !autoQuality || video.paused || video.seeking || probing || steppingDown || holdEl || now < watchFrom) {
        win.length = 0;
        thinSince = richSince = 0;
        return;
      }
      const end = bufEnd();
      const ahead = end - video.currentTime;
      win.push({ t: now, end });
      while (win.length > 4) win.shift();
      if (win.length < 4) return;
      const fill = (end - win[0].end) / ((now - win[0].t) / 1000);
      const cur = capH === 720 ? 2500 : capH === 480 ? 1200 : fileKbps;

      // falling behind: short of buffer and not gaining on the playhead
      // (the last seconds of a film are not a thin line: the buffer stops
      // growing because there is nothing left to fetch — found by the browser
      // tests, 2026-10-08: every film ended on a 480p re-encode)
      const atEnd = Number.isFinite(video.duration) && end >= video.duration - 1.5;
      const starving = capH !== 480 && !atEnd && ahead < 8 && fill < 0.9;
      if (starving) {
        thinSince = thinSince || now;
        // two seconds of it — or at once when there is almost nothing left
        if (now - thinSince >= 2000 || (ahead < 3 && fill < 0.7)) {
          thinSince = 0;
          win.length = 0;
          lineEst = { kbps: cur != null ? Math.round(cur * Math.max(fill, 0.05)) : null, at: now };
          stepDown("starving");
        }
      } else thinSince = 0;

      // room to spare: what hls.js measured on the segments it fetched
      const est = hls && hls.bandwidthEstimate ? hls.bandwidthEstimate / 1000 : null;
      const need = capH === 480 ? 2800 * 1.6 : capH === 720 && fileKbps != null ? fileKbps * 1.5 : null;
      const rich =
        capH && upsLeft > 0 && est != null && need != null && est >= need &&
        ahead >= 12 && now - lastChangeAt > 45000 && dataMode() !== "saver";
      if (rich) {
        richSince = richSince || now;
        if (now - richSince >= 15000) {
          richSince = 0;
          win.length = 0;
          upsLeft--;
          steppedUpAt = now;
          const to = capH === 480 ? 720 : 0;
          reportMark("client_switch", { reason: "recovered", to: to ? `h264-${to}` : "original", position: effTime() });
          track("feat", { f: `quality_stepup_${to || "original"}` });
          excuseUntil = now + 15000;
          applyQuality(to, { auto: true });
        }
      } else richSince = 0;
    }, 1000);
  }
  video.addEventListener("waiting", () => {
    if (!autoQuality || video.paused || probing) return;
    const left = excuseUntil - Date.now();
    if (left <= 0) return beginStall();
    // Still inside the grace period: look again when it ends. A start that
    // never gets going is a stall too, it just began early.
    clearTimeout(excuseTimer);
    excuseTimer = setTimeout(() => {
      if (!exited && autoQuality && !stallAt && !video.paused && !probing && video.readyState < 3) beginStall();
    }, left + 100);
  });
  // A pause is the viewer's doing: whatever was being timed is void.
  video.addEventListener("pause", () => {
    stallAt = 0;
    clearTimeout(longStallTimer);
    clearTimeout(excuseTimer);
  });
  if (bootCapped) setTimeout(() => { if (!exited && capH) showQualityPill(capH, 0); }, 1200);

  video.addEventListener("playing", () => {
    clearTimeout(longStallTimer);
    clearTimeout(excuseTimer);
    if (stallAt) {
      const now = Date.now();
      if (now - stallAt > 700) {
        stallTimes.push(now);
        while (stallTimes.length && now - stallTimes[0] > 180000) stallTimes.shift();
        if (stallTimes.length >= 2) stepDown("stalls");
      }
      stallAt = 0;
    }
    spinner.classList.add("hidden");
    clearTimeout(rebufferTimer);
    hlsRecoveries = 0; // a working stream earns a fresh recovery budget
    stopTorrentOverlay();
  });
  video.addEventListener("ended", () => {
    // A transcode that "ends" FAR before the known duration is a truncated
    // playlist (its input starved server-side), not the end of the movie —
    // restart the stream where it died instead of silently closing the
    // player (a cached 9s stump made every open of an episode flash-close).
    const d = totalDuration();
    if (usingTranscode && d && d - effTime() > 90) {
      toast("Stream ended early — recovering…", "⚙️");
      // When this happens UNDER a seek that was still landing, the clock is
      // not where the viewer asked to be: the browser cut the stream's
      // duration to what it had and clamped the playhead to it (seen on a jit
      // stream, 2026-10-08: a click at 46:42 "ended" at 42:30 and the film
      // carried on from there). Recover at the seek's target instead.
      const asked =
        lastNativeSeek && Date.now() - lastNativeSeek.at < 15000 && effTime() < lastNativeSeek.target - 5
          ? lastNativeSeek.target
          : null;
      lastNativeSeek = null;
      startTranscodeAt(asked != null ? asked : effTime(), currentV);
      return;
    }
    saveProgress();
    if (!isEpisode) exit();
  });
  // ---- the error card (2026-10-07) ----
  // A stream that stopped for good used to leave a toast and a dead picture.
  // The card says what happened and offers the two things a viewer wants:
  // try again from this second, or go back.
  let errorCard = null;
  const hideErrorCard = () => { if (errorCard) errorCard.remove(); errorCard = null; };
  const showErrorCard = (message, retry) => {
    if (exited) return;
    hideErrorCard();
    spinner.classList.add("hidden");
    const again = el("button", {
      class: "btn btn-primary focusable",
      onclick: () => {
        hideErrorCard();
        spinner.classList.remove("hidden");
        track("feat", { f: "player_retry" });
        try { retry(); } catch {}
      },
    }, "Try again");
    errorCard = el("div", { class: "player-error", role: "alert" },
      el("div", { class: "player-error-glyph" }, "⚠️"),
      el("h3", {}, "Playback stopped"),
      el("p", {}, message),
      el("div", { class: "player-error-actions" },
        again,
        el("button", { class: "btn focusable", onclick: () => exit() }, "Back")));
    overlay.append(errorCard);
    setTimeout(() => { try { again.focus(); } catch {} }, 0);
  };
  video.addEventListener("playing", hideErrorCard);

  // ---- a stream that silently stops (2026-10-08) ----
  // The picture freezes, nothing errors, and the viewer reaches for the
  // remote. This watches the media clock once a second and, when a stream
  // that WAS playing stops advancing with nobody having asked it to, tries —
  // gently, and a bounded number of times — to get it going again.
  //
  // It counts a second as "stalled" only when ALL of this holds: the film has
  // really played on this stream (so a start-up wait is never a stall), it is
  // not paused / ended / blocked by the browser, the tab is visible, no seek
  // is typed, in flight or landing, no quality change is being prepared, no
  // error card is up, it is not AirPlaying, and it is not sitting at the end
  // of what the stream has. Anything else puts the count back to zero; the
  // grace periods every start / seek / stream change already get
  // (excuseUntil) and a native seek still landing merely pause it.
  //
  // The ladder:
  //   6 s   a nudge that cannot hurt, once per stall —
  //           • media is buffered within half a second AHEAD of a playhead
  //             that has none under it: hop the gap;
  //           • else, hls.js with nothing buffered, no request in flight and
  //             a silent loader: startLoad at this position;
  //           • and play() is asked for again (a no-op on a playing element).
  //  20 s   ONE rebuild of the stream at this position, the way the fatal-
  //         error handler rebuilds (startHls, same url) — but only for an
  //         hls.js stream whose loader is idle (no request in flight, silent
  //         for 8 s). While hls.js is fetching or polling, it is working and
  //         its own timeouts / retries / fatal error own the outcome; this
  //         waits for it until 90 s and then leaves the stall alone.
  //         Never rebuilt: a torrent that isn't fully downloaded (the wait is
  //         the swarm's, and the overlay already says so), a watch party (the
  //         host's clock would yank everyone back), native HLS on an iPhone
  //         (reassigning src there throws the viewer out of fullscreen / PiP,
  //         and AVPlayer retries by itself), and plain file playback — see
  //         below. At most two rebuilds in five minutes.
  //  +45 s  the rebuilt stream never came back: the error card, with Try
  //         again at the same spot. Nothing further happens by itself.
  //
  // Plain file playback (no hls.js) gets the nudge and nothing more. The only
  // stronger move is video.load() + seek back, and that is not safe here:
  // load() resets the element, so `loadedmetadata` runs again and re-applies
  // the SAVED resume point (seconds stale) over the position; text-track
  // modes and the offset cues are rebuilt under the viewer; an iPhone drops
  // out of fullscreen / PiP; and on a torrent it just re-opens the same Range
  // request against the same cold piece. A real network failure already
  // reaches the "error" listener below, and a decode stall has its own
  // watchdog (fallbackToTranscode).
  const STALL_NUDGE_S = 6;
  const STALL_REBUILD_S = 20;
  const STALL_LEAVE_S = 90;
  const STALL_CARD_MS = 45000;
  const STALL_IDLE_MS = 8000;
  const STALL_NUDGE_EVERY_MS = 30000; // a stream that stutters is not nudged on every stutter
  const STALL_MAX_REBUILDS = 2;
  const STALL_BUDGET_MS = 5 * 60000;
  let stGen = hlsGen; // the stream the counters belong to
  let stLastCt = video.currentTime || 0;
  let stMoved = false; // this stream has really played
  let stStalled = 0; // seconds counted
  let stStage = 0; // 0 watching · 1 nudged · 2 done with this stall
  let stLastTick = Date.now();
  let stGraceUntil = 0;
  let stSeenUser = 0;
  let stNudgedAt = 0;
  const stRebuilds = [];
  const stReset = () => {
    stStalled = 0;
    stStage = 0;
  };
  // seconds buffered from the playhead on, and the start of a range that
  // begins just ahead of it (null when there is none)
  const stBuffer = (ct) => {
    let ahead = 0;
    let gap = null;
    try {
      const b = video.buffered;
      for (let i = 0; i < b.length; i++) {
        const s = b.start(i);
        const e = b.end(i);
        if (s <= ct + 0.05 && e > ct) ahead = Math.max(ahead, e - ct);
        else if (s > ct && s - ct <= 0.5 && e - s > 0.5) gap = gap == null ? s : Math.min(gap, s);
      }
    } catch {}
    return { ahead, gap };
  };
  const stLoaderIdle = (now) => !stall.inFlight && now - stall.netAt >= STALL_IDLE_MS;
  // content time for a media time on the current stream (for the marks)
  const stContent = (mediaT) => (usingTranscode ? clockBase : 0) + (mediaT || 0);
  const stNote = (stage, mediaT, extra = {}) => {
    const info = {
      stage,
      position: Math.round(stContent(mediaT)),
      path: ladderOn ? "ladder" : jitMode ? "jit" : usingTranscode ? currentV : hls ? "hls" : "direct",
      ...extra,
    };
    reportMark("client_stall", info); // torrents: the per-stream perf record
    mark("stall", info); // library files: the [play] log
    track("feat", { f: `stall_${stage}` });
  };
  const stallWatch = setInterval(() => {
    if (exited) return;
    const now = Date.now();
    const ct = video.currentTime || 0;
    const late = now - stLastTick > 3000; // the timer itself was held up (sleep, throttling)
    stLastTick = now;

    // A rebuild that is still coming back: released once the picture is where
    // it was (or another stream took over); the card if it never arrives.
    const hold = stall.hold;
    if (hold) {
      if (hold.gen !== hlsGen || ct >= hold.pos - 2) stall.hold = null;
      else if (
        !hold.carded && now - hold.at >= STALL_CARD_MS &&
        !video.paused && !document.hidden && !errorCard && !probing && !seekWait
      ) {
        hold.carded = true;
        stopTorrentOverlay();
        stNote("card", hold.pos);
        showErrorCard(
          "The stream stopped and didn't come back by itself. Try again from the same spot, or go back.",
          () => {
            // only while this is still the stream that stopped
            if (exited || stall.hold !== hold || hold.gen !== hlsGen || !stall.url) return;
            startHls(stall.url, hold.pos, stall.lad && ladderNow());
            stall.hold = { gen: hlsGen, pos: hold.pos, at: Date.now(), carded: false };
          },
        );
      }
    }

    // another stream (a seek's restart, a quality change, a fatal-error
    // rebuild): everything starts over, and it has to play before it counts
    if (stGen !== hlsGen) {
      stGen = hlsGen;
      stMoved = false;
      stLastCt = ct;
      return stReset();
    }
    if (document.hidden) {
      stGraceUntil = now + 5000; // a tab coming back gets a moment
      stLastCt = ct;
      return stReset();
    }
    const userSeek = stall.userAt !== stSeenUser;
    stSeenUser = stall.userAt;
    const delta = ct - stLastCt;
    stLastCt = ct;
    if (Math.abs(delta) > 0.2) {
      // the clock moved: playing (a step the size of a second or so), or a jump
      if (delta > 0 && delta <= 4 && !late) stMoved = true;
      return stReset();
    }
    if (
      late || userSeek || !stMoved ||
      video.paused || video.ended || playBlocked || errorCard ||
      probing || seekWait || pendingSeek != null || seekPreview != null || scrubDragging ||
      holdEl || steppingDown || video.webkitCurrentPlaybackTargetIsWireless
    ) return stReset();
    // at the end of what the stream has (the film's end, or the edge of a
    // transcode still being made): not a stall this can do anything about
    if (isFinite(video.duration) && video.duration > 0 && ct >= video.duration - 1.5) return stReset();
    // waits that are already understood: paused, not forgotten
    if (video.seeking || now < excuseUntil || now < stGraceUntil) return;

    stStalled++;

    if (stStage === 0 && stStalled >= STALL_NUDGE_S) {
      stStage = 1;
      if (now - stNudgedAt < STALL_NUDGE_EVERY_MS) return;
      stNudgedAt = now;
      const { ahead, gap } = stBuffer(ct);
      let did = "play";
      try {
        if (ahead < 0.1 && gap != null) {
          video.currentTime = gap + 0.05;
          did = "gap";
        } else if (hls && ahead < 1 && stLoaderIdle(now)) {
          // an explicit position: -1 would mean "the live edge" on a playlist
          // that is still being written (see startPosition in startHls)
          hls.startLoad(ct);
          did = "load";
        }
      } catch {}
      try {
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
      } catch {}
      stNote("nudge", ct, { did });
      return;
    }

    if (stStage === 1 && stStalled >= STALL_REBUILD_S) {
      while (stRebuilds.length && now - stRebuilds[0] > STALL_BUDGET_MS) stRebuilds.shift();
      const swarmBound = isTorrent && !(serverLoaded != null && serverLoaded >= 0.99);
      const why =
        !hls || nativeHlsOnly || !stall.url ? "not-hls"
        : swarmBound ? "swarm"
        : inParty() ? "party"
        : stRebuilds.length >= STALL_MAX_REBUILDS ? "budget"
        : !stLoaderIdle(now) ? "loading"
        : null;
      if (why) {
        // "loading" can pass (hls.js gives up on a request); the rest cannot
        if (why !== "loading" || stStalled >= STALL_LEAVE_S) {
          stStage = 2;
          stNote("left", ct, { why });
        }
        return;
      }
      stStage = 2;
      stRebuilds.push(now);
      stNote("rebuild", ct);
      // what the fatal-error handler does before it rebuilds: the element is
      // about to be reset, so say that something is happening
      spinner.classList.remove("hidden");
      if (isTorrent && item.infoHash) startTorrentOverlay(false);
      startHls(stall.url, ct, stall.lad && ladderNow()); // same url, back at this media time
      stall.hold = { gen: hlsGen, pos: ct, at: now, carded: false };
      stGen = hlsGen;
      stMoved = false;
      stLastCt = 0;
      stReset();
    }
  }, 1000);

  // ---- Media Session (2026-10-07) ----
  // The lock screen, the notification shade, a headset's buttons, a
  // keyboard's media keys and the iPhone's Dynamic Island all talk to this:
  // what is playing (title, episode, picture), where it is, and what the
  // buttons do. Without it they show a bare "localhost" and a play button.
  // Handing the session back happens IN the route cleanup (msRelease), not on
  // this player's next timer tick: going episode to episode, the next player
  // has already written its title and its button handlers by then, and the
  // late tick of the old one wiped them — the lock screen went blank and the
  // media keys went dead for the whole next episode (found 2026-10-08).
  let msRelease = null;
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    const art = item.cover || item.poster || (item.showId ? `/img/cover/${item.showId}` : null);
    const abs = (u) => { try { return new URL(u, location.origin).href; } catch { return null; } };
    try {
      ms.metadata = new MediaMetadata({
        title: isEpisode ? `S${item.season} E${item.episode}${item.title && !/^Episode \d+$/.test(item.title) ? ` · ${item.title}` : ""}` : item.title || "Aurora",
        artist: isEpisode ? item.showTitle || "" : item.year ? String(item.year) : "",
        album: "Aurora",
        artwork: art && abs(art) ? [{ src: abs(art), sizes: "512x512" }] : [],
      });
    } catch {}
    const on = (name, fn) => { try { ms.setActionHandler(name, fn); } catch {} };
    on("play", () => { noteInput(); if (video.paused) togglePlay(); });
    on("pause", () => { noteInput(); if (!video.paused) togglePlay(); });
    on("seekbackward", () => { noteInput(); skip(-1); });
    on("seekforward", () => { noteInput(); skip(1); });
    on("seekto", (d) => { noteInput(); if (d && Number.isFinite(d.seekTime)) seekTo(d.seekTime); });
    on("stop", () => exit());
    // Chromium calls this when the tab is hidden while the film plays (auto
    // picture-in-picture); browsers that don't know the action refuse it in
    // `on` and nothing changes. Only a film that is really playing goes.
    on("enterpictureinpicture", () => {
      try {
        if (exited || video.paused || video.ended || video.readyState < 2) return;
        if (document.pictureInPictureElement || !video.requestPictureInPicture) return;
        video.requestPictureInPicture().then(() => track("feat", { f: "pip_auto" })).catch(() => {});
      } catch {}
    });
    const position = () => {
      if (exited) return void clearInterval(msTimer); // (the session itself: msRelease)
      try {
        ms.playbackState = video.paused ? "paused" : "playing";
        const duration = totalDuration();
        const pos = effTime();
        if (duration > 0 && pos >= 0 && pos <= duration && ms.setPositionState) {
          ms.setPositionState({ duration, position: pos, playbackRate: video.playbackRate || 1 });
        }
      } catch {}
    };
    const msTimer = setInterval(position, 1000);
    video.addEventListener("play", position);
    video.addEventListener("pause", position);
    msRelease = () => {
      clearInterval(msTimer);
      try { ms.metadata = null; ms.playbackState = "none"; } catch {}
      for (const a of ["play", "pause", "seekbackward", "seekforward", "seekto", "stop", "enterpictureinpicture"]) on(a, null);
    };
  }

  video.addEventListener("error", () => {
    // A decode/format error on a direct torrent stream → try the transcode
    // before giving up.
    if (canFallback && !switchedToTranscode) {
      fallbackToTranscode();
      return;
    }
    // A COPY stream can also be refused (a device rejecting the repackaged
    // codec — elia's iPhone sat on a dead screen for 3 minutes here,
    // 2026-08-26, with only the "codec unsupported" dead-end below). The
    // h264 encode is the one thing every device decodes: escalate to it
    // from the current position instead of giving up.
    if (usingTranscode && currentV === "copy" && !switchedToTranscode) {
      switchedToTranscode = true;
      copyRefused = true; // remember: no later "upgrade" may ping-pong back to copy
      toast("This device refused the fast path — re-encoding instead…", "⚙️");
      reportMark("client_switch", { reason: "media-error", to: "h264", position: effTime() });
      startTranscodeAt(effTime(), "h264", { fallbackToZero: true });
      return;
    }
    showErrorCard(
      "This device couldn't play the file as it is. Trying again re-encodes it into a format every device plays.",
      () => {
        if (item.transcodeBase || !isTorrent) {
          if (!item.transcodeBase) item.transcodeBase = `/stream/transcode/${item.id}`;
          startTranscodeAt(effTime(), "h264", { fallbackToZero: true });
        } else {
          video.load();
          video.play().catch(() => {});
        }
      },
    );
  });
  // Single click toggles play/controls. Double action depends on the input:
  // mouse double-click = fullscreen (desktop convention); on TOUCH the
  // screen edges are the phone grammar everyone expects — double-tap the
  // left/right third = ±10s, only the middle stays fullscreen. TV remotes
  // never fire pointer events, so the D-pad path below is untouched.
  let clickTimer = null;
  let lastPointerType = "mouse";
  video.addEventListener(
    "pointerdown",
    (e) => { lastPointerType = e.pointerType || "mouse"; },
    { passive: true },
  );
  // The ripple under a double tap — a soft disc where the finger landed,
  // saying which way and how far, the way iOS players do it.
  const tapRipple = (side, x, y) => {
    const r = overlay.getBoundingClientRect();
    const node = el("div", { class: `tap-ripple ${side}`, style: { left: `${x - r.left}px`, top: `${y - r.top}px` } },
      el("span", {}, side === "left" ? "−10s" : "+10s"));
    overlay.append(node);
    setTimeout(() => node.remove(), 700);
    try { if (navigator.vibrate) navigator.vibrate(8); } catch {}
  };
  video.addEventListener("click", (e) => {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      if (lastPointerType === "touch") {
        const r = video.getBoundingClientRect();
        const f = r.width > 0 ? (e.clientX - r.left) / r.width : 0.5;
        if (f < 0.35) return (tapRipple("left", e.clientX, e.clientY), skip(-1));
        if (f > 0.65) return (tapRipple("right", e.clientX, e.clientY), skip(1));
      }
      toggleFullscreen();
      return;
    }
    clickTimer = setTimeout(() => {
      clickTimer = null;
      if (controlsHidden()) showControls();
      else togglePlay();
    }, 250);
  });

  saveTimer = setInterval(() => {
    if (!video.paused) saveProgress();
    // Keep the admin panel's live view honest: position/duration ride along,
    // paused or not (a paused player still holds the title open).
    reportActivity("Watching", activityLabel, {
      position: effTime() || 0,
      duration: totalDuration() || 0,
      // What THIS device's video element actually believes, as opposed to the
      // total we compute. On a live transcode they differ, and on an iPhone the
      // element's value is what the native fullscreen player shows — so this is
      // the only way to see, from the server, what a phone is really doing.
      streamDuration: isFinite(video.duration)
        ? Math.round(video.duration)
        : null,
      streamReady: video.readyState,
    });
  }, 5000);

  // ---------- input handling ----------
  // "Still watching?" hears every kind of real input. Listeners on the
  // overlay go when it does; the three on window / document are removed in
  // the route cleanup. A pointermove only counts when the pointer actually
  // went somewhere — browsers also fire one when the page moves under a
  // pointer that is lying still (the Up next card appearing, the dock hiding).
  let lastPtr = null;
  const onRealMove = (e) => {
    const at = `${e.screenX},${e.screenY}`;
    if (lastPtr !== null && at !== lastPtr) noteInput();
    lastPtr = at;
  };
  const onAnyInput = () => noteInput();
  overlay.addEventListener("pointermove", onRealMove, { passive: true });
  overlay.addEventListener("pointerdown", onAnyInput, { passive: true });
  overlay.addEventListener("touchstart", onAnyInput, { passive: true });
  overlay.addEventListener("wheel", onAnyInput, { passive: true });
  window.addEventListener("keydown", onAnyInput, true); // capture: before anything can swallow it
  document.addEventListener("nav-move", onAnyInput);
  document.addEventListener("media-key", onAnyInput);

  const onPointerMove = () => showControls();
  overlay.addEventListener("pointermove", onPointerMove); // mouse, pen and finger alike
  overlay.addEventListener("touchstart", onPointerMove, { passive: true });
  overlay.addEventListener("wheel", onPointerMove, { passive: true });

  const typing = () =>
    !!document.querySelector(".look-notice-wrap") || /INPUT|TEXTAREA/.test((document.activeElement && document.activeElement.tagName) || "");
  const onNavMove = (e) => {
    if (typing()) return;
    const dir = e.detail;
    if (controlsHidden()) {
      if (dir === "left") {
        skip(-1);
        e.preventDefault();
      } else if (dir === "right") {
        skip(1);
        e.preventDefault();
      } else {
        showControls();
        scrubber.focus({ preventScroll: true });
        e.preventDefault();
      }
      return;
    }
    showControls();
    // Left/right SEEK, the way every other video site behaves — not just when
    // the controls are hidden or the scrubber happens to hold focus. The one
    // exception is a focused control (a button in the bar, an item in a menu),
    // where left/right still walks the row: that is how a D-pad crosses the
    // control bar on a TV, and seeking there would strand the remote.
    if (dir === "left" || dir === "right") {
      const focused = document.activeElement;
      const onControl =
        focused &&
        focused !== scrubber &&
        overlay.contains(focused) &&
        focused.closest(".player-controls, .menu");
      if (!onControl) {
        skip(dir === "left" ? -1 : 1);
        e.preventDefault();
        return;
      }
    }
    // On the volume slider, up/down adjusts volume (left/right freely moves
    // focus to the neighbouring controls, so the slider never traps the D-pad)
    if (
      document.activeElement === volSlider &&
      (dir === "up" || dir === "down")
    ) {
      video.muted = false;
      video.volume = Math.max(
        0,
        Math.min(1, video.volume + (dir === "up" ? 0.1 : -0.1)),
      );
      prefs.set("volume", video.volume);
      paintVolume();
      e.preventDefault();
    }
  };
  document.addEventListener("nav-move", onNavMove);

  const onKey = (e) => {
    if (typing()) return;
    const k = e.key;
    if (k === " " || e.keyCode === 32) {
      togglePlay();
      e.preventDefault();
    } else if ((k === "Enter" || e.keyCode === 13) && controlsHidden()) {
      togglePlay();
      e.preventDefault();
    } else if (k === "m" || k === "M") {
      toggleMute();
      showControls();
    } else if (k === "f" || k === "F") {
      toggleFullscreen();
    } else if ((k === "c" || k === "C") && (item.subtitles || []).length > 0) {
      showControls();
      toggleMenu("cc");
    }
  };
  document.addEventListener("keydown", onKey);

  const onMediaKey = (e) => {
    const action = e.detail;
    if (action === "playpause") togglePlay();
    else if (action === "play") {
      video.play().catch(() => {});
      partyUser(true);
    } else if (action === "pause") {
      video.pause();
      partyUser(false);
    }
    else if (action === "rewind") skip(-1);
    else if (action === "forward") skip(1);
    else if (action === "stop") exit();
  };
  document.addEventListener("media-key", onMediaKey);

  const onBack = (e) => {
    if (document.querySelector(".look-notice-wrap, .person-wrap")) return; // a sheet owns Back
    e.preventDefault();
    if (xraySheet) return closeXray(); // Back / Escape closes the X-Ray sheet, not the film
    if (upNextEl) return dismissUpNext();
    if (menuHost.childElementCount > 0) {
      closeMenu();
      showControls();
      return;
    }
    if (!controlsHidden() && !video.paused) {
      hideControls();
      return;
    }
    exit();
  };
  document.addEventListener("ui-back", onBack);

  // Torrent subtitles (Hebrew / English / Russian) are fetched asynchronously after play
  // starts — add them as switchable tracks the moment they arrive.
  const addTracks = (tracks) => {
    const have = new Set(
      [...video.querySelectorAll("track")].map((t) => t.getAttribute("src")),
    );
    let firstNew = -1;
    for (const t of tracks) {
      if (have.has(t.url)) continue;
      const trackEl = el("track", {
        kind: "subtitles",
        label: t.label,
        src: t.url,
        srclang: t.lang || "",
      });
      armTrackOffset(trackEl);
      video.append(trackEl);
      // Keep item.subtitles in sync with the DOM tracks so the CC menu lists
      // dynamically-added tracks (external fetch / resume / OCR) too.
      if (!item.subtitles) item.subtitles = [];
      if (!item.subtitles.some((s) => s.url === t.url)) item.subtitles.push(t);
      if (firstNew === -1)
        firstNew = video.querySelectorAll("track").length - 1;
    }
    if (firstNew === -1) return;
    ccBtn.classList.remove("hidden");
    if (activeTrack === -1 && !autoSubsApplied) {
      autoSubsApplied = true;
      const auto = autoTrackIndex(firstNew); // preferred language, else the first new one
      if (auto >= 0) selectTrack(auto);
    }
  };
  const onTorrentSubs = (e) => {
    if (e.detail && e.detail.id === item.id) addTracks(e.detail.subtitles);
  };
  document.addEventListener("torrent-subs", onTorrentSubs);
  // subs may already be present if the fetch resolved before the player mounted
  if (isTorrent && item.subtitles && item.subtitles.length)
    addTracks(item.subtitles);
  // Resuming a stream from Continue Watching skips the Discover page's subtitle
  // fetch. Fetch them here — but deferred + re-checked, so on a normal play we
  // don't double-fetch (and double-add) alongside the Discover page's own fetch.
  if (isTorrent && item.imdbId) {
    setTimeout(() => {
      if (exited || (item.subtitles && item.subtitles.length)) return;
      const subType = item.season && item.episode ? "series" : "movie";
      api
        .torrentSubtitles(subType, item.imdbId, item.season, item.episode)
        .then(({ subtitles }) => {
          if (subtitles && subtitles.length) addTracks(subtitles);
        })
        .catch(() => {});
    }, 2500);
  }

  // OCR can finish while watching this exact video - add the track live
  // Auto-subtitles: the viewer asked for a language (Preferences → Subtitles)
  // and this file doesn't carry it — the server fetches one from the
  // subtitle providers, writes it next to the file (for everyone, for good),
  // and it switches on here the moment it lands.
  if (!isTorrent && !item._offline && prefs.get("subsDefault", true)) {
    const want = prefs.get("subLang", "any");
    const test = SUB_LANG_TEST[want];
    const matches = (t) => test && (test.code.test(t.lang || "") || test.label.test(t.label || ""));
    if (test && !(item.subtitles || []).some(matches)) {
      api.subtitlesFetch(item.id, want)
        .then((r) => {
          if (exited || !r || !r.tracks || !r.tracks.length) return;
          addTracks(r.tracks.map((t) => ({ ...t, lang: t.lang || want })));
          const i = (item.subtitles || []).findIndex(matches);
          // The fetched track is offered either way, but it only switches on
          // by itself when that does not overrule the viewer's own last pick:
          // "Off" stays off, and a remembered language this title already
          // carries keeps its track (2026-10-08).
          const mine = normPick(profilePick("subPick"));
          const overruled = mine === "off" || (mine && mine !== want && bestTrackIndex(item.subtitles || [], mine) >= 0);
          if (i >= 0 && !overruled) {
            selectTrack(i);
            toast(`${SUB_LANG_NAME[want] || "Matching"} subtitles found — switched on`, "💬");
          }
        })
        .catch(() => {});
    }
  }
  const unsubOcr = onMessage("subtitle_ocr", async (msg) => {
    if (msg.status !== "done") return;
    try {
      const fresh = await api.item(item.id);
      const have = new Set((item.subtitles || []).map((t) => t.url));
      for (const t of fresh.subtitles || []) {
        if (have.has(t.url)) continue;
        item.subtitles.push(t);
        const trackEl = el("track", {
          kind: "subtitles",
          label: t.label,
          src: t.url,
        });
        armTrackOffset(trackEl);
        video.append(trackEl);
        ccBtn.classList.remove("hidden");
        if (activeTrack === -1) {
          const auto = autoTrackIndex(item.subtitles.length - 1);
          if (auto >= 0) selectTrack(auto);
        }
      }
    } catch {}
  });

  // ---------- exit ----------
  let exitConfirmed = false;
  const exit = () => {
    if (exited) return;
    if (inParty() && party.role === "host" && party.current.members.length > 1 && !exitConfirmed) {
      exitConfirmed = true;
      setTimeout(() => { exitConfirmed = false; }, 6000);
      toast(`Leaving ends the party for ${party.current.members.length - 1} other${party.current.members.length > 2 ? "s" : ""} — press Back again to end it`, "👥");
      return;
    }
    exited = true;
    saveProgress();
    reportActivity("Browsing");
    // Torrent sources remember where they came from (the Discover detail page)
    if (item.returnHash && item.returnHash !== location.hash)
      navigate(item.returnHash);
    else if (isEpisode && item.showId) {
      // Opened from the show's own page: go BACK to it. Pushing it again left
      // Back on the show page pointing into the player, round and round.
      if (enteredFrom === `#/show/${item.showId}` && history.length > 1) history.back();
      else navigate(`#/show/${item.showId}`);
    }
    else if (history.length > 1) history.back();
    else navigate("#/");
  };

  // first picture, once
  let firstFrameMarked = false;
  video.addEventListener("playing", () => {
    if (firstFrameMarked) return;
    firstFrameMarked = true;
    mark("first-frame", { transcode: usingTranscode, jit: jitMode, v: currentV || null });
    track("play", {
      ms: Math.round(performance.now() - t0),
      path: jitMode ? "jit" : usingTranscode ? currentV : "direct",
      kind: isTorrent ? "torrent" : item._offline ? "offline" : "library",
    });
  });

  applyCueStyle();
  paintVolume();
  showControls();

  // cleanup when the route changes away
  return () => {
    exited = true;
    clearInterval(saveTimer);
    clearInterval(partySync);
    for (const un of unsubParty) un();
    if (!keepParty) leaveParty();
    setPlayingContext(null);
    if (torrentPoll) clearInterval(torrentPoll);
    if (statusPoll) clearInterval(statusPoll);
    if (stallTimer) clearInterval(stallTimer);
    if (audioProbe) clearInterval(audioProbe);
    if (keepAlive) clearInterval(keepAlive);
    clearInterval(stallWatch); // (stall.hold is left as it is: the save below must still respect it)
    if (msRelease) msRelease(); // now — before the next player claims the media session
    clearTimeout(rebufferTimer);
    clearTimeout(seekDebounce);
    clearTimeout(hlsRecoverTimer);
    clearTimeout(controlsTimer);
    try {
      if (prefetchCtrl) prefetchCtrl.abort();
    } catch {}
    dismissUpNext();
    saveProgress();
    try {
      video.pause();
    } catch {}
    if (hls) {
      try {
        hls.destroy();
      } catch {}
      hls = null;
    }
    video.removeAttribute("src");
    video.load();
    document.removeEventListener("nav-move", onNavMove);
    window.removeEventListener("resize", replaceMenu);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("media-key", onMediaKey);
    document.removeEventListener("ui-back", onBack);
    document.removeEventListener("torrent-subs", onTorrentSubs);
    window.removeEventListener("keydown", onAnyInput, true);
    document.removeEventListener("nav-move", onAnyInput);
    document.removeEventListener("media-key", onAnyInput);
    if (dockRO) dockRO.disconnect();
    else window.removeEventListener("resize", paintDockH);
    window.removeEventListener("resize", onLiftResize);
    unsubOcr();
    popScope(overlay);
  };
};
