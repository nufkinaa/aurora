// A strip that scrolls sideways says that it goes on: the side that has more
// fades out (a mask in CSS: .fade-strip.more-start / .more-end). Which side
// has more is read from whether the strip's first and last item are wholly in
// view — an IntersectionObserver, so nothing runs while the strip scrolls.
// Items can come and go (one shown later, one display: none): watched.
// (elia, 2026-11-10: "it's not clear enough that this has more elements and
// can be scrolled horizontally" — the title page's button strip; the same
// cue for the Movies/Shows categories and a show's seasons.)
//   edgeFade(strip, { when })  `when`: a media query the strip scrolls under
//                              (outside it, nothing is observed)
import { untilLeave } from "./router.js";

export const edgeFade = (strip, { when = null } = {}) => {
  if (!strip || typeof IntersectionObserver !== "function") return;
  if (when && typeof matchMedia === "function" && !matchMedia(when).matches) return;
  strip.classList.add("fade-strip");
  let first = null, last = null;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const whole = e.intersectionRatio > 0.97;
      if (e.target === first) strip.classList.toggle("more-start", !whole);
      if (e.target === last) strip.classList.toggle("more-end", !whole);
    }
  }, { root: strip, threshold: [0, 0.97, 1] });
  let tries = 0;
  const watch = () => {
    // (built before it is put on the page: wait for that, a few frames at most)
    if (!strip.isConnected) { if (tries++ < 120) requestAnimationFrame(watch); return; }
    if (getComputedStyle(strip).display === "contents") return; // (no box of its own: the classic look's season wrapper)
    const shown = [...strip.children].filter((c) => c.getClientRects().length);
    const f = shown[0] || null, l = shown[shown.length - 1] || null;
    if (f === first && l === last) return;
    io.disconnect();
    strip.classList.remove("more-start", "more-end");
    first = f; last = l;
    if (first) io.observe(first);
    if (last && last !== first) io.observe(last);
  };
  requestAnimationFrame(watch);
  const mo = new MutationObserver(() => requestAnimationFrame(watch));
  mo.observe(strip, { childList: true });
  untilLeave(() => { io.disconnect(); mo.disconnect(); });
};
