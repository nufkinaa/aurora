// Trailers in the billboard (glass look): a pick that has held still for a
// few seconds cross-fades from its art to its trailer, streamed from
// YouTube through the IFrame Player API — muted, 25 seconds, then back to
// the art and on to the next pick. Press Unmute and the sound comes on
// (a press is the gesture browsers want) and the window grows to 50
// seconds. Anything the viewer does — a dot, a swipe, scrolling past, the
// tab hiding — ends it at once and hands the slab back to the art.
//
// Nothing is downloaded and nothing touches the server: the video id rides
// in the title's Discover metadata, the same one the Trailer button uses.
// If the player never reports "playing" (no internet, a browser that
// refuses muted autoplay, an ad, a dead id) the art simply stays and the
// billboard rotates as it always has. The player is the "nocookie" host, so
// nothing is set until the viewer unmutes.
import { el } from "./ui.js";
import { api } from "./api.js";

// The device-local player settings, read straight from storage (the same
// key playerPrefs writes) — the player module itself is loaded lazily.
const pref = (key, fallback) => {
  try {
    const all = JSON.parse(localStorage.getItem("aurora-player") || "{}");
    return key in all ? all[key] : fallback;
  } catch {
    return fallback;
  }
};

const DWELL_MS = 3000; // still this long → the trailer starts
const MUTED_S = 25; // how long a muted trailer runs
const UNMUTED_S = 50; // …and with sound
const START_TIMEOUT_MS = 7000; // no "playing" by then → give up on this pick
const FADE_MS = 800;

let ytApi = null; // promise for window.YT
const loadYt = () => {
  if (ytApi) return ytApi;
  ytApi = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch {} resolve(window.YT); };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    s.onerror = () => { ytApi = null; reject(new Error("YouTube player unavailable")); };
    document.head.append(s);
    setTimeout(() => { if (!(window.YT && window.YT.Player)) { ytApi = null; reject(new Error("YouTube player slow")); } }, 12000);
  });
  return ytApi;
};

// Why a device sits this out — checked at every arm, so a setting change
// or going offline takes effect on the next pick.
export const heroTrailersWanted = () => {
  if (document.documentElement.dataset.look !== "glass") return false;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (navigator.connection && navigator.connection.saveData) return false;
  if (!navigator.onLine) return false;
  const coarse = matchMedia("(pointer: coarse)").matches && innerWidth < 900;
  return pref("heroTrailers", !coarse);
};

export const createHeroTrailer = (heroEl, { onEnd }) => {
  const layer = el("div", { class: "hero-video", "aria-hidden": "true" });
  const mount = el("div"); // the API replaces this with the iframe
  layer.append(mount);
  const unmute = el("button", {
    class: "hero-unmute focusable hidden",
    "aria-label": "Unmute trailer",
    html: `<span class="hero-unmute-ic">🔇</span><span>Unmute</span>`,
  });
  heroEl.append(unmute); // above the dots' layer; CSS puts it beside them

  let player = null;
  let armed = null; // {item, timer}
  let active = false;
  let capTimer = null;
  let startTimer = null;
  let startedAt = 0;
  let unmuted = false;
  let gen = 0;
  const noTrailer = new Set(); // ids that failed once — not again this visit

  const teardown = () => {
    clearTimeout(capTimer); capTimer = null;
    clearTimeout(startTimer); startTimer = null;
    if (player) { try { player.destroy(); } catch {} player = null; }
    layer.innerHTML = "";
    layer.append(mount);
  };

  // Back to the art. `advance` is the normal end (cap or the trailer's own
  // end): the billboard moves on; an interruption just restores the art.
  const stop = (advance = false) => {
    gen++;
    clearTimeout(armed && armed.timer);
    armed = null;
    const was = active;
    active = false;
    unmuted = false;
    heroEl.classList.remove("trailing", "trailing-sound", "trailing-loading");
    unmute.classList.add("hidden");
    if (was) {
      // let the cross-fade back to the art finish before the iframe goes
      const dying = player;
      player = null;
      setTimeout(() => { try { dying && dying.destroy(); } catch {} layer.innerHTML = ""; layer.append(mount); }, FADE_MS);
      if (advance && onEnd) onEnd();
    } else {
      teardown();
    }
  };

  const sizeFrame = () => {
    const f = layer.querySelector("iframe");
    if (!f) return;
    // cover the slab at 16:9, 15% over so YouTube's title strip and watermark
    // sit outside the rounded crop
    const w = heroEl.clientWidth, h = heroEl.clientHeight;
    const scale = 1.15;
    let fw = w * scale, fh = (fw * 9) / 16;
    if (fh < h * scale) { fh = h * scale; fw = (fh * 16) / 9; }
    f.style.width = `${Math.round(fw)}px`;
    f.style.height = `${Math.round(fh)}px`;
    f.style.left = `${Math.round((w - fw) / 2)}px`;
    f.style.top = `${Math.round((h - fh) / 2)}px`;
  };

  const trailerIdFor = async (item) => {
    if (item.trailers && item.trailers.length) return item.trailers[0];
    if (!item.imdbId) return null;
    try {
      const m = await api.discoverMeta(item.type === "show" ? "show" : "movie", item.imdbId);
      const id = m && m.trailers && m.trailers[0];
      item.trailers = (m && m.trailers) || [];
      return id || null;
    } catch {
      return null;
    }
  };

  const capFor = () => (unmuted ? UNMUTED_S : MUTED_S) * 1000;
  const armCap = () => {
    clearTimeout(capTimer);
    const left = Math.max(0, startedAt + capFor() - Date.now());
    capTimer = setTimeout(() => {
      // with sound on, ease the volume down over the last second
      if (unmuted && player) {
        let v = 100;
        const ramp = setInterval(() => { v -= 20; try { player.setVolume(Math.max(0, v)); } catch {} if (v <= 0) clearInterval(ramp); }, 200);
        setTimeout(() => stop(true), 1000);
      } else stop(true);
    }, left);
  };

  const play = async (item, myGen) => {
    const id = await trailerIdFor(item);
    if (myGen !== gen || !id || noTrailer.has(id)) return;
    let YT;
    try { YT = await loadYt(); } catch { return; }
    if (myGen !== gen) return;
    heroEl.classList.add("trailing-loading");
    player = new YT.Player(mount, {
      host: "https://www.youtube-nocookie.com",
      videoId: id,
      playerVars: {
        autoplay: 1, mute: 1, controls: 0, rel: 0, modestbranding: 1, playsinline: 1,
        iv_load_policy: 3, disablekb: 1, fs: 0, enablejsapi: 1, origin: location.origin,
      },
      events: {
        onReady: (e) => {
          if (myGen !== gen) return;
          sizeFrame();
          try { e.target.mute(); e.target.playVideo(); } catch {}
          startTimer = setTimeout(() => {
            // never got going (autoplay refused, no internet, an ad): the art stays
            if (myGen === gen && !active) { noTrailer.add(id); stop(false); }
          }, START_TIMEOUT_MS);
        },
        onStateChange: (e) => {
          if (myGen !== gen) return;
          if (e.data === YT.PlayerState.PLAYING && !active) {
            active = true;
            startedAt = Date.now();
            clearTimeout(startTimer);
            heroEl.classList.remove("trailing-loading");
            heroEl.classList.add("trailing");
            unmute.classList.remove("hidden");
            armCap();
          } else if (e.data === YT.PlayerState.ENDED && active) {
            stop(true);
          }
        },
        onError: () => { if (myGen === gen) { noTrailer.add(id); stop(false); } },
      },
    });
  };

  unmute.onclick = () => {
    if (!active || !player) return;
    unmuted = true;
    try { player.unMute(); player.setVolume(100); } catch {}
    heroEl.classList.add("trailing-sound");
    unmute.innerHTML = `<span class="hero-unmute-ic">🔊</span><span>Sound on</span>`;
    unmute.setAttribute("aria-label", "Trailer sound is on");
    armCap(); // the window grows to 50 seconds from when it started
  };

  // A pick landed: wait out the dwell, then (if still this pick, still
  // wanted, still on screen) start it.
  const arm = (item, { visible }) => {
    stop(false);
    if (!heroTrailersWanted() || !item) return;
    if (!item.imdbId && !(item.trailers && item.trailers.length)) return;
    const myGen = gen;
    // fetch the id during the dwell so the start isn't gated on the network
    trailerIdFor(item).catch(() => {});
    armed = {
      item,
      timer: setTimeout(() => {
        armed = null;
        if (myGen !== gen || document.hidden || !visible()) return;
        if (document.querySelector(".ui-overlay, .screensaver")) return;
        play(item, myGen);
      }, DWELL_MS),
    };
  };

  window.addEventListener("resize", sizeFrame);
  const onHide = () => { if (document.hidden) stop(false); };
  document.addEventListener("visibilitychange", onHide);

  return {
    layer,
    arm,
    stop,
    isActive: () => active || !!armed || heroEl.classList.contains("trailing-loading"),
    destroy: () => {
      stop(false);
      teardown();
      window.removeEventListener("resize", sizeFrame);
      document.removeEventListener("visibilitychange", onHide);
      unmute.remove();
    },
  };
};
