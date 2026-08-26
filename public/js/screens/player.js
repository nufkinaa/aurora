// Full-screen player with Apple TV-style controls: auto-hiding UI, scrubber,
// ±10s, subtitle + speed menus, Up Next auto-advance, server-side resume.
import { el, icons, fmtClock, toast } from "../ui.js";
import { api } from "../api.js";
import { state, progressFor, refreshProgress } from "../state.js";
import { navigate } from "../router.js";
import { pushScope, popScope } from "../focus.js";
import { reportActivity, onMessage } from "../ws.js";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

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

export const renderPlayer = async (root, { id }) => {
  const restart = location.hash.includes("restart=1");
  const itemId = id.split("?")[0];
  const entryHash = location.hash;

  let item;
  // Torrent sources are handed over directly by the Discover page (no server
  // round-trip); fall back to the API for library items or a page refresh.
  if (state.pendingItems[itemId]) {
    item = state.pendingItems[itemId];
    delete state.pendingItems[itemId];
  } else {
    try {
      item = await api.item(itemId);
    } catch {
      return navigate("#/");
    }
  }
  await refreshProgress();

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

  const isEpisode = !!item.showId;
  const title = isEpisode ? item.showTitle : item.title;
  const subtitleText = isEpisode
    ? `S${item.season} E${item.episode} · ${item.title}`
    : item.year || "";

  // Detect torrent playback
  const isTorrent =
    item._isTorrent || item.magnet || item.id?.startsWith("torrent|");

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

  // ---------- element tree ----------
  const video = el("video", {
    autoplay: true,
    preload: "auto",
    playsinline: true,
  });

  // AC-3 / E-AC-3 / DTS audio is silent in most desktop browsers (fine on
  // TVs). When the browser can't decode it, play through the server's
  // compat remux (HLS: video copied, audio -> AAC).
  const AUDIO_MIME = { ac3: "ac-3", eac3: "ec-3", dts: "dtsc", truehd: "mlpa" };
  const audioNeedsRemux = () => {
    const codec = item.audio && item.audio.codec;
    if (!codec || item.audio.compatible) return false;
    const mime = AUDIO_MIME[codec] || codec;
    return !(
      video.canPlayType(`audio/mp4; codecs="${mime}"`) ||
      video.canPlayType(`video/mp4; codecs="${mime}"`)
    );
  };

  // HEVC/AV1/10-bit video (typical of downloaded torrents) decodes fine on
  // TVs but not on most phones/desktops. The server records the library
  // file's video codec; each device decides for itself via canPlayType and
  // plays the server transcode when it can't decode the file directly.
  const VIDEO_MIME = {
    h264: "avc1.640029",
    hevc: "hvc1.1.6.L123.B0",
    av1: "av01.0.08M.08",
    vp9: "vp09.00.40.08",
    vp8: "vp8",
    mpeg4: "mp4v.20.9",
  };
  // The CONTAINER matters as much as the codec: an iPhone hardware-decodes
  // HEVC but can't demux MKV at all, so asking about the real container is
  // what lets the player start on the transcode immediately instead of
  // direct-playing into a stall and switching 6+ seconds later. Blink
  // (Chrome/TV WebView) answers x-matroska queries accurately; WebKit
  // returns "" for it, which is also the truth.
  const CONTAINER_MIME = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    webm: "video/webm",
    avi: "video/x-msvideo",
  };
  const videoNeedsTranscode = () => {
    const v = item.video;
    if (!v || !v.codec || !item.transcodeBase) return false;
    // 10-bit H.264 (Hi10P) has no hardware decoding anywhere and canPlayType
    // can't see bit depth — always transcode it.
    if (v.codec === "h264" && (v.bitDepth || 8) > 8) return true;
    const mime = VIDEO_MIME[v.codec];
    if (!mime) return true; // mpeg2, vc1, wmv… nothing browsers decode
    // Ask about the file's actual container when we know it; otherwise fall
    // back to the generic containers.
    const containers = CONTAINER_MIME[item.container]
      ? [CONTAINER_MIME[item.container]]
      : ["video/mp4", "video/webm"];
    return !containers.some((c) => video.canPlayType(`${c}; codecs="${mime}"`));
  };

  // iPhone: play HLS through Safari's NATIVE pipeline, never MSE. iOS 17.1
  // added ManagedMediaSource, which flips Hls.isSupported() to true on
  // iPhone — but video.webkitEnterFullscreen() (the ONLY fullscreen an
  // iPhone has) is exactly what iOS 17.x breaks on MSE-backed elements
  // (InvalidStateError, or the native player opening audio-only). Native HLS
  // is the configuration iPhones always used before 17.1 and the one the
  // native player accepts. iPhone ONLY: desktop Safari keeps hls.js and the
  // patient torrent retry tuning below; canPlayType guards against a spoofed
  // UA on a browser with no native HLS.
  const nativeHlsOnly =
    /iPhone|iPod/.test(navigator.userAgent) &&
    !!video.canPlayType("application/vnd.apple.mpegurl");

  // Can this device DECODE the codec if we repackage into a container it
  // accepts? This is what separates the cheap COPY from the full h264 encode
  // (elia's iPhone report, 2026-08-26: every MKV stream re-encoded at swarm
  // speed because the container check alone said "can't play" — when the
  // phone hardware-decodes both h264 AND hevc, and only the MKV wrapper was
  // the problem). h264 8-bit is universal; HEVC rides on hardware and gets
  // fMP4 segments on native-HLS devices (Apple's requirement).
  const codecCopyable = (v) =>
    !!v &&
    ((v.codec === "h264" && (v.bitDepth || 8) <= 8) ||
      (v.codec === "hevc" &&
        // iOS canPlayType LIES about hvc1 (answers blank while every iPhone
        // since iOS 11 hardware-decodes HEVC — elia's phone proved it by
        // "encoding" every x265 stream, 2026-08-26). On native-HLS devices
        // HEVC is a platform guarantee; elsewhere trust the browser's answer.
        (nativeHlsOnly ||
          !!video.canPlayType('video/mp4; codecs="hvc1.2.4.L123.B0"'))));

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
    video.src = item.videoUrl;
    tryPlay();
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
  const startHls = (url, startAt = 0) => {
    const gen = ++hlsGen;
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
            // A failure well after the last one starts a fresh burst.
            const now = Date.now();
            if (now - lastRecoveryAt > HLS_RECOVERY_WINDOW_MS)
              hlsRecoveries = 0;
            lastRecoveryAt = now;
            if (hlsRecoveries >= HLS_MAX_RECOVERIES) {
              spinner.classList.add("hidden");
              stopTorrentOverlay();
              toast(
                "This source isn't responding — still trying, or pick another",
                "⚠️",
              );
              // Slow heartbeat: without it nothing would ever load again, so no
              // further error could fire and the window above could never
              // refresh — the screen would stay dead until the viewer acted.
              clearTimeout(hlsRecoverTimer);
              hlsRecoverTimer = setTimeout(() => {
                if (!exited) startHls(url);
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
              if (!exited) startHls(url);
            }, 2000);
          });
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
  // S7: a JIT stream has ONE full-length playlist — no offset jobs exist, so
  // anything that speaks offset-URLs (keepAlive pings) must stand down.
  let jitMode = false;
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
  const transcodeUrl = (ss, v) => {
    const vv = v || currentV;
    // Native-HLS devices (iPhone) get fMP4 segments for copy jobs — Apple
    // requires them for HEVC-in-HLS, and they're fine for h264 too. HEVC in
    // fMP4 additionally MUST be tagged hvc1: ffmpeg's default (hev1) is the
    // other legal tag, and iOS refuses it (the black-screen "codec
    // unsupported" of 2026-08-26).
    const seg = nativeHlsOnly && vv === "copy" ? "&seg=fmp4" : "";
    const isHevc =
      (item.video && item.video.codec === "hevc") || item.videoCodecHint === "hevc";
    const vtag = seg && isHevc ? "&vtag=hvc1" : "";
    return `${item.transcodeBase}/${Math.max(0, Math.floor(ss || 0))}/index.m3u8?v=${vv}${seg}${vtag}`;
  };
  const startTranscode = (offset, v, { claimed = false, clock = null } = {}) => {
    streamOffset = Math.max(0, Math.floor(offset || 0));
    usingTranscode = true;
    // Any offset job means we've LEFT the jit world (e.g. the media-error
    // self-heal) — keepAlive must ping the new job again.
    jitMode = false;
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
        startHls(url);
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
    fetch(`${url}&seek=1`, { cache: "no-store" })
      .then((res) => begin(res.ok ? clockFromHeaders(res) : null))
      .catch(() => beginH264Fallback());
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
    { fallbackToZero = false } = {},
  ) => {
    const ss = Math.max(0, Math.floor(target) - 2);
    const token = ++probeToken;
    spinner.classList.remove("hidden");
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
      startTranscode(ss, v, { claimed: true, clock: clockFromHeaders(res) });
      return true;
    } catch {
      if (exited || token !== probeToken) return true;
      if (fallbackToZero) {
        startTranscode(0, v);
        return true;
      }
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
  const tryJitSwitch = async (fromSec) => {
    if (isTorrent) {
      // The probe normalizes ffprobe's "matroska,webm" to "mkv"; accept both.
      if (!/matroska|mkv/i.test(item.container || "")) return false;
      if (!codecCopyable(item.video || {})) return false;
    } else if (item.video && videoNeedsTranscode() && !codecCopyable(item.video)) {
      return false; // truly undecodable here — needs the real h264 encode
    }
    const base = isTorrent ? item.transcodeBase : `/stream/transcode/${item.id}`;
    const isHevc =
      (item.video && item.video.codec === "hevc") || item.videoCodecHint === "hevc";
    const jitUrl = `${base}/jit/index.m3u8${
      nativeHlsOnly ? `?seg=fmp4${isHevc ? "&vtag=hvc1" : ""}` : ""
    }`;
    try {
      const r = await fetch(jitUrl, { cache: "no-store" });
      if (!r.ok) return false;
    } catch {
      return false;
    }
    if (exited) return true; // switched-to-nothing: just don't start legacy
    usingTranscode = true;
    jitMode = true;
    currentV = "copy";
    streamOffset = 0;
    clockBase = 0;
    windowStart = 0;
    startHls(jitUrl, Math.max(0, fromSec || 0));
    return true;
  };

  // Resume point (baked into the transcode's start offset for streams, applied
  // as a native seek for direct/library playback).
  const prog0 = progressFor(item.id);
  const resumeAt =
    !restart &&
    prog0 &&
    !prog0.finished &&
    prog0.position > 10 &&
    (!item.duration || prog0.position < item.duration - 20)
      ? Math.floor(prog0.position)
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

  const usingRemux = audioNeedsRemux(); // library file with undecodable audio
  // The !isTorrent guards below preserve flow ownership: torrents ALWAYS go
  // through their own branch (prefetch warm + fallbackToZero on resume) —
  // before the probe existed they had no item.video/audio so these library
  // branches never matched a torrent; the guard keeps that invariant now
  // that probe data fills those fields.
  if (!isTorrent && videoNeedsTranscode()) {
    // Library file this device can't play directly. The file is complete on
    // disk, so resuming at the saved position works (unlike torrent streams,
    // where the bytes at an arbitrary offset may not be downloaded yet).
    // When only the CONTAINER is the problem (h264/HEVC-in-MKV on an
    // iPhone), jit copies it onto the full timeline (S7c: fMP4 there, so
    // Apple's fullscreen can scrub the whole film); the legacy copy job is
    // the fallback, and everything undecodable gets the real h264 encode.
    const copyOk = codecCopyable(item.video || {});
    const jitOk = copyOk ? await tryJitSwitch(resumeAt) : false;
    if (!jitOk) startTranscode(resumeAt, copyOk ? "copy" : "h264");
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
    toast("This encode won't decode here — switching to transcode…", "⚙️");
    reportMark("client_switch", { reason: "decode-stall", to: "h264", position: effTime() });
    // Resume from where the direct stream died (those bytes are downloaded —
    // we were just playing them); fall back to 0 only if the seek-job fails.
    startTranscodeAt(effTime(), "h264", { fallbackToZero: true });
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
        if (++stalls >= 3) fallbackToTranscode(); // ~6s
      } else {
        stalls = 0;
      }
      lastCT = ct;
    }, 2000);
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
        if (currentV === "h264" && videoNeedsTranscode() && codecCopyable(item.video)) {
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
  const scrubber = el(
    "div",
    { class: "scrubber focusable", tabindex: "0", "aria-label": "Seek" },
    el("div", { class: "scrubber-track" }, scrubBuffer, scrubFill),
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
  const fsBtn = btn("Fullscreen", icons.fullscreen, () => toggleFullscreen());
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

  const menuHost = el("div");

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
      ),
    ),
    el(
      "div",
      { class: "player-bottom" },
      scrubber,
      el("div", { class: "scrubber-time" }, timeNow, bufferPct, timeLeft),
      el(
        "div",
        { class: "player-controls" },
        btn("Back 10 seconds", icons.back10, () => skip(-1)),
        playBtn,
        btn("Forward 10 seconds", icons.forward10, () => skip(1)),
        el("div", { class: "vol-group" }, muteBtn, volSlider),
        el("div", { class: "player-spacer" }),
        ccBtn,
        speedBtn,
        gearBtn,
        fsBtn,
      ),
    ),
    menuHost,
  );

  root.append(overlay);
  pushScope(overlay);
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

  const showControls = () => {
    overlay.classList.remove("controls-hidden", "hide-cursor");
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(hideControls, 3200);
  };
  const hideControls = () => {
    if (menuHost.childElementCount > 0) return; // keep visible while a menu is open
    if (video.paused) return;
    overlay.classList.add("controls-hidden", "hide-cursor");
    document.activeElement?.blur?.();
  };
  const controlsHidden = () => overlay.classList.contains("controls-hidden");

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
    } else {
      video.pause();
      showFlash(icons.pause);
    }
  };

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
    paintVolume();
  };
  volSlider.addEventListener("input", () => {
    video.muted = false;
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
  };
  const autoTrackIndex = (from = 0) => {
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
    const menu = el("div", {
      class: "menu",
      style: { right: "36px", bottom: "110px" },
    });

    if (kind === "cc") {
      menu.append(el("div", { class: "menu-title" }, "Subtitles"));
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
        el(
          "div",
          { class: "menu-title", style: { marginTop: "6px" } },
          "Subtitle timing",
        ),
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
      menu.append(el("div", { class: "menu-title" }, "Speed"));
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
        menu.append(el("div", { class: "menu-title" }, "Playback"));
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
        menu.append(el("div", { class: "menu-title" }, "Subtitle style"));
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
        // Skip-intro marking — episodes only (introKey is null otherwise).
        // Two presses: one at the start of the intro, one at its end; the
        // range is saved for the whole show, on the server, for everyone.
        if (introKey) {
          menu.append(el("div", { class: "menu-title" }, "Skip intro"));
          if (intro && introMarkStart == null) {
            menu.append(
              entry(
                "Clear intro marks",
                `${fmtClock(intro.start)}–${fmtClock(intro.end)}`,
                () => {
                  api.clearIntro(introKey).catch(() => {});
                  intro = null;
                  skipIntroBtn.classList.add("hidden");
                  toast("Intro marks cleared for this show", "⏭");
                  rebuild();
                },
              ),
            );
          }
          if (introMarkStart == null) {
            menu.append(
              entry(
                intro ? "Re-mark intro start" : "Mark intro start",
                `at ${fmtClock(effTime())}`,
                () => {
                  introMarkStart = Math.max(0, Math.floor(effTime()));
                  toast(
                    `Intro start set at ${fmtClock(introMarkStart)} — open Settings again when it ends`,
                    "⏭",
                  );
                  rebuild();
                },
              ),
            );
          } else {
            menu.append(
              entry(
                "Mark intro end (save)",
                `starts ${fmtClock(introMarkStart)}`,
                async () => {
                  const end = Math.floor(effTime());
                  if (end <= introMarkStart) {
                    toast("The end has to come after the start", "⏭");
                    return;
                  }
                  try {
                    await api.setIntro(introKey, introMarkStart, end);
                    intro = { start: introMarkStart, end };
                    toast(
                      "Saved — every episode of this show now offers Skip intro",
                      "⏭",
                    );
                  } catch (e) {
                    toast(e.message || "Couldn't save the intro", "⚠️");
                  }
                  introMarkStart = null;
                  rebuild();
                },
              ),
            );
            menu.append(
              entry("Cancel marking", `was ${fmtClock(introMarkStart)}`, () => {
                introMarkStart = null;
                rebuild();
              }),
            );
          }
        }
      };
      rebuild();
    }
    menuHost.append(menu);
    menu.querySelector(".menu-item.active")?.focus({ preventScroll: true });
  };

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
  const commitSeek = () => {
    seekDebounce = null;
    if (pendingSeek == null) return;
    const target = pendingSeek;
    pendingSeek = null;
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
    video.currentTime = Math.max(0, target - clockBase);
    updateScrubber();
  };
  const seekTo = (sec) => {
    if (seekLocked()) return; // scrubber retargets wait for the landing too
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
      const buffered =
        (usingTranscode ? clockBase : 0) +
        video.buffered.end(video.buffered.length - 1);
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
  scrubber.addEventListener("pointermove", (e) => {
    if (!scrubDragging) return;
    const d = totalDuration();
    if (!d) return;
    scrubDragMoved = true;
    const frac = scrubFrac(e);
    // Live preview only — pendingSeek moves the bar/clock via updateScrubber,
    // and nothing commits until the finger lifts.
    pendingSeek = frac * d;
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
    // Save the EFFECTIVE content time (transcode offset + clock) so resume lands
    // where the viewer actually stopped, not where the transcode session began.
    api
      .saveProgress(state.profile.id, item.id, effTime(), d, streamMeta())
      .catch(() => {});
  };

  // ---------- Up Next ----------
  let upNextEl = null;
  let countdownTimer = null;

  // Streamed episodes know their show through the IMDb id — they have no
  // library showId, which is why Up Next used to never appear for them.
  const isStreamEpisode = !!(isTorrent && item.imdbId && item.season && item.episode);

  const findNextEpisode = async () => {
    if (isEpisode) {
      const show = await api.item(item.showId);
      const flat = show.seasons.flatMap((s) => s.episodes || []);
      const i = flat.findIndex((e) => e.id === item.id);
      return i >= 0 ? flat[i + 1] || null : null;
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
    const autoplay = !next._stream && prefs.get("autoplayNext", true);
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
          counter,
          " Dismiss",
        ),
      ),
    );
    overlay.append(upNextEl);
    upNextEl.querySelector(".btn-primary").focus({ preventScroll: true });

    if (autoplay) {
      countdownTimer = setInterval(() => {
        remaining--;
        counter.textContent = String(remaining);
        if (remaining <= 0) goNext(next);
      }, 1000);
    }
  };

  const dismissUpNext = () => {
    clearInterval(countdownTimer);
    if (upNextEl) upNextEl.remove();
    upNextEl = null;
  };

  const goNext = (next) => {
    dismissUpNext();
    saveProgress();
    // Streamed episode: back to the show's page to pick a source — episode
    // deep-linked so it's one press away.
    if (next._stream) {
      navigate(`#/discover/series/${item.imdbId}`);
      return;
    }
    navigate(`#/play/${next.id}`);
  };

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
  const skipIntroBtn = el("button", {
    class: "btn skip-intro focusable hidden",
    html: `<span>Skip intro</span> ⏭`,
    onclick: () => {
      if (!intro) return;
      skipIntroBtn.classList.add("hidden");
      seekTo(intro.end);
    },
  });
  overlay.append(skipIntroBtn);
  if (introKey) {
    api
      .intro(introKey)
      .then((r) => {
        if (r && isFinite(r.start) && isFinite(r.end)) intro = r;
      })
      .catch(() => {});
  }
  const maybeSkipIntro = () => {
    if (!intro) return;
    const t = effTime();
    // Not in the range's final second — skipping to "one second from now"
    // reads as a broken button.
    const inIntro = t >= intro.start && t < intro.end - 1 && !video.paused;
    skipIntroBtn.classList.toggle("hidden", !inIntro);
  };

  // ---------- video events ----------
  video.addEventListener("loadedmetadata", () => {
    // Fires on every (re)load — including transcode restarts that change
    // streamOffset (far seek / resume). Re-anchor all subtitle cues to the
    // new clock, or subs go out of sync the moment a seek restarts the stream.
    applyOffsetAll();
    // The new stream's clock is valid from here, so the held seek target can
    // hand the scrubber back to it without the bar ever stepping backwards.
    seekPreview = null;
    const prog = progressFor(item.id);
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
      video.currentTime = prog.position;
      toast(`Resuming from ${fmtClock(prog.position)}`, "▶️");
    } else if (usingTranscode && streamOffset > 0) {
      toast(`Resuming from ${fmtClock(streamOffset)}`, "▶️");
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
    const remaining = d - effTime();
    const win = upNextWindow(d);
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
  video.addEventListener("playing", () => {
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
      startTranscodeAt(effTime(), currentV);
      return;
    }
    saveProgress();
    if (!isEpisode) exit();
  });
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
      toast("This device refused the fast path — re-encoding instead…", "⚙️");
      reportMark("client_switch", { reason: "media-error", to: "h264", position: effTime() });
      startTranscodeAt(effTime(), "h264", { fallbackToZero: true });
      return;
    }
    spinner.classList.add("hidden");
    toast(
      "This video can't be played in the browser (codec unsupported).",
      "⚠️",
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
  video.addEventListener("click", (e) => {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      if (lastPointerType === "touch") {
        const r = video.getBoundingClientRect();
        const f = r.width > 0 ? (e.clientX - r.left) / r.width : 0.5;
        if (f < 0.35) return skip(-1);
        if (f > 0.65) return skip(1);
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
  const onPointerMove = () => showControls();
  overlay.addEventListener("mousemove", onPointerMove);

  const onNavMove = (e) => {
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
    else if (action === "play") video.play().catch(() => {});
    else if (action === "pause") video.pause();
    else if (action === "rewind") skip(-1);
    else if (action === "forward") skip(1);
    else if (action === "stop") exit();
  };
  document.addEventListener("media-key", onMediaKey);

  const onBack = (e) => {
    e.preventDefault();
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

  // Torrent subtitles (Hebrew/English) are fetched asynchronously after play
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
  const exit = () => {
    if (exited) return;
    exited = true;
    saveProgress();
    reportActivity("Browsing");
    // Torrent sources remember where they came from (the Discover detail page)
    if (item.returnHash && item.returnHash !== location.hash)
      navigate(item.returnHash);
    else if (isEpisode && item.showId) navigate(`#/show/${item.showId}`);
    else if (history.length > 1) history.back();
    else navigate("#/");
  };

  applyCueStyle();
  paintVolume();
  showControls();

  // cleanup when the route changes away
  return () => {
    exited = true;
    clearInterval(saveTimer);
    if (torrentPoll) clearInterval(torrentPoll);
    if (statusPoll) clearInterval(statusPoll);
    if (stallTimer) clearInterval(stallTimer);
    if (audioProbe) clearInterval(audioProbe);
    if (keepAlive) clearInterval(keepAlive);
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
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("media-key", onMediaKey);
    document.removeEventListener("ui-back", onBack);
    document.removeEventListener("torrent-subs", onTorrentSubs);
    unsubOcr();
    popScope(overlay);
  };
};
