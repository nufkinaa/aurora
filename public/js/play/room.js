// Aurora Play — the room a play feature happens in, and its stylesheet.
//
//   loadPlayCss()  -> Promise: css/play.css is on the page. It is not part of
//       the shell's stylesheet (Home never pays for it): the shell carries it
//       as <template id="play-css"> — inert, but versioned by the server like
//       every other stylesheet (assetver.js), so the copy fetched here is
//       cached for good. Without the template (an old shell) it is fetched
//       by its plain address. Resolves on load, on error, or after 4 s —
//       a play screen is never held up for ever.
//   room({ seed })  -> { el, destroy() }: the deeper sky a play feature sits
//       in — its own background (so it looks the same in the glass and the
//       legacy look): the night gradient, two slow aurora curtains (CSS,
//       transform only), a still starfield painted once on a canvas (again
//       on a resize), and a few stars that twinkle. Put `el` first inside the
//       play surface; destroy() when the screen goes.
import { paintStars } from "./sharecard.js";
import { reduced } from "./motion.js";

let cssReady = null;
export const loadPlayCss = () => {
  if (cssReady) return cssReady;
  if (document.querySelector("link[data-play-css]")) return (cssReady = Promise.resolve());
  const tpl = document.getElementById("play-css");
  const fromShell = tpl && tpl.content ? tpl.content.querySelector("link") : null;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = (fromShell && fromShell.getAttribute("href")) || "/css/play.css";
  link.setAttribute("data-play-css", "");
  cssReady = new Promise((resolve) => {
    const t = setTimeout(resolve, 4000);
    link.onload = () => { clearTimeout(t); resolve(); };
    link.onerror = () => { clearTimeout(t); link.remove(); cssReady = null; resolve(); };
  });
  document.head.append(link);
  return cssReady;
};

export const room = ({ seed = 11 } = {}) => {
  const el = document.createElement("div");
  el.className = "play-room";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = '<div class="play-room-ribbon play-room-ribbon--a"></div><div class="play-room-ribbon play-room-ribbon--b"></div><canvas class="play-room-stars"></canvas>' +
    // the twinkling few: fixed spots, staggered by CSS
    Array.from({ length: 7 }, (_, i) => `<i class="play-twinkle" style="--i:${i}"></i>`).join("");
  const canvas = el.querySelector("canvas");
  let w = 0, h = 0;
  const paint = () => {
    const nw = window.innerWidth, nh = window.innerHeight;
    if (nw === w && Math.abs(nh - h) < 120) return; // (a phone's toolbar coming and going is not a new sky)
    w = nw; h = nh;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    paintStars(ctx, w, h, { seed, count: Math.round(Math.min(260, (w * h) / 5200)) });
  };
  let t = 0;
  const onResize = () => { clearTimeout(t); t = setTimeout(paint, 150); };
  requestAnimationFrame(paint);
  window.addEventListener("resize", onResize);
  if (reduced()) el.classList.add("is-still");
  return {
    el,
    destroy: () => { clearTimeout(t); window.removeEventListener("resize", onResize); el.remove(); },
  };
};
