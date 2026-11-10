// Aurora Play — the motion helpers every play screen shares. The kit is
// public/js/play/*.js (each file says what it offers at its top) and
// public/css/play.css (the matching classes, tokens and keyframes); a demo of
// every piece: node tools/play-demo/serve.js.
//
//   reduced()                 true when the person asked for less motion
//   EASE.out(t) …             easing curves, t in 0..1 (pure)
//   tween({ ms, ease, onUpdate, onDone })   one value 0→1 over `ms` on rAF;
//                             -> cancel(). Under reduced motion it lands at
//                             1 at once.
//   stagger(nodes, step, base)  each node's --d (ms) for the CSS entrances:
//                             [data-in] children rise in that order
//   wait(ms, signal)          a timer as a promise, dropped with the signal
//   cssVars({ "--d": 120, left: "4%" })  -> "--d:120;left:4%" — a style
//                             STRING: ui.js el() takes a style object with
//                             Object.assign, which silently drops custom
//                             properties, so pass vars as this string
//
// The rules the kit keeps (elia's brief, 2026-11-10): motion moves transform
// and opacity only; nothing runs while its screen is not showing; under
// prefers-reduced-motion every helper jumps to the final state.

export const reduced = () => {
  try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

// t in 0..1 -> eased 0..1. `back` and `spring` overshoot on purpose: a press
// that springs back, a card that lands with a little bounce.
export const EASE = {
  linear: (t) => t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: (t) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  // a damped spring settling at 1 (about two visible wobbles)
  spring: (t) => (t >= 1 ? 1 : 1 - Math.cos(t * 4.5 * Math.PI) * Math.exp(-t * 6)),
};

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;

export const tween = ({ ms = 600, ease = EASE.out, delay = 0, onUpdate, onDone } = {}) => {
  let raf = 0;
  let timer = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try { onUpdate && onUpdate(1); } catch {}
    try { onDone && onDone(); } catch {}
  };
  if (reduced() || ms <= 0) {
    finish();
    return () => {};
  }
  const begin = () => {
    const t0 = performance.now();
    const step = (now) => {
      const t = clamp((now - t0) / ms, 0, 1);
      try { onUpdate && onUpdate(ease(t)); } catch {}
      if (t < 1) raf = requestAnimationFrame(step);
      else { done = true; try { onDone && onDone(); } catch {} }
    };
    raf = requestAnimationFrame(step);
  };
  if (delay > 0) timer = setTimeout(begin, delay);
  else begin();
  return () => {
    done = true;
    clearTimeout(timer);
    cancelAnimationFrame(raf);
  };
};

// The entrance order: --d on each node, in ms. CSS does the rest
// ([data-in] { animation-delay: calc(var(--d) * 1ms) }).
export const stagger = (nodes, step = 70, base = 0) => {
  [...nodes].forEach((n, i) => n && n.style && n.style.setProperty("--d", String(Math.round(base + i * step))));
  return nodes;
};

export const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason || new Error("aborted"));
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason || new Error("aborted")); }, { once: true });
  });

export const cssVars = (o) => Object.entries(o).map(([k, v]) => `${k.startsWith("--") ? k : k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}:${v}`).join(";");
