// Ambient screensaver (elia's pick): idle on the HOME screen for a few
// minutes and the app becomes a slow slideshow of backdrops from your own
// home rows, with a clock. Any input wakes it instantly. Never arms outside
// home (a paused movie must never get painted over), never in a hidden tab,
// and reduced-motion holds one still image instead of crossfading.
import { el, artUrl } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";

const IDLE_MS = 3 * 60 * 1000;
const SLIDE_MS = 12 * 1000;

let idleTimer = null;
let overlay = null;
let slideTimer = null;
let clockTimer = null;

const onHome = () => (location.hash || "#/") === "#/";

const stop = () => {
  clearInterval(slideTimer);
  clearInterval(clockTimer);
  slideTimer = clockTimer = null;
  if (overlay) {
    const o = overlay;
    overlay = null;
    o.classList.remove("on");
    setTimeout(() => o.remove(), 700);
  }
};

const start = async () => {
  if (overlay || !onHome() || !state.profile || document.hidden) return;
  let pool = [];
  try {
    const data = await api.home(state.profile.id);
    // hero backdrops first (landscape, made for this), then row covers
    pool = [
      ...(data.hero || []).map((h) => ({ src: h.backdrop || h.cover, title: h.title })),
      ...(data.rows || []).flatMap((r) => r.items.slice(0, 6).map((i) => ({ src: i.backdrop || i.cover, title: i.title }))),
    ].filter((x) => x.src);
  } catch {}
  if (!pool.length || overlay || !onHome()) return;
  // shuffle so every doze-off shows a different reel
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const imgA = el("img", { class: "ss-img", alt: "" });
  const imgB = el("img", { class: "ss-img", alt: "" });
  const caption = el("div", { class: "ss-caption" });
  const clock = el("div", { class: "ss-clock" });
  overlay = el("div", { class: "screensaver", "aria-hidden": "true" }, imgA, imgB, caption, clock);
  document.body.append(overlay);
  requestAnimationFrame(() => overlay && overlay.classList.add("on"));

  const tickClock = () => {
    clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  tickClock();
  clockTimer = setInterval(tickClock, 15000);

  let at = 0;
  let front = imgA;
  const show = (slide) => {
    const back = front === imgA ? imgB : imgA;
    back.src = artUrl(slide.src);
    back.onload = () => {
      back.classList.add("show");
      front.classList.remove("show");
      front = back;
      caption.textContent = slide.title || "";
    };
  };
  show(pool[0]);
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!calm && pool.length > 1) {
    slideTimer = setInterval(() => {
      at = (at + 1) % pool.length;
      show(pool[at]);
    }, SLIDE_MS);
  }
};

const poke = () => {
  if (overlay) stop();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(start, IDLE_MS);
};

// test hook: QA can trigger the saver without waiting out the idle timer
export const _screensaver = { start, stop };

export const initScreensaver = () => {
  for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "scroll"])
    window.addEventListener(ev, poke, { passive: true });
  document.addEventListener("visibilitychange", poke);
  window.addEventListener("hashchange", poke); // navigating away disarms/wakes
  poke();
};
