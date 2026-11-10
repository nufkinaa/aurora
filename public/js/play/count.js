// Aurora Play — numbers that arrive: the odometer and the count-up.
//
//   odometer(text, { ms, delay, laps })  -> { el, start(), settle() }
//       `text` is the FINAL text ("136", "1,204", "3:41"). Each digit is a
//       wheel that rolls up to its value (transform only — no layout per
//       frame); the units wheel spins the most laps, the leading digit the
//       fewest, so the number lands left to right like a fruit machine.
//       Anything that is not a digit stands still. Screen readers get the
//       final text at once (aria-label); the wheels are hidden from them.
//       start() rolls; settle() jumps to the end (reduced motion, Skip).
//   countUp(node, to, { ms, format })    a small inline number counting up as
//       text (for a "6 sittings" in a sentence) -> cancel()
//   wheelPlan(text, laps)                 pure: which wheels a text needs and
//       how far each one travels (tested in test/play-kit.test.js)
//
// CSS: .play-odo, .play-odo-wheel, .play-odo-strip in css/play.css. A digit
// is --odo-h tall (in em), so the odometer takes any font size the
// surrounding text gives it.
import { reduced, tween, EASE } from "./motion.js";

// For each character: { digit: n, steps } or { char }. The wheel for a digit
// passes `laps` full turns (decreasing to the left) and stops on the digit.
export const wheelPlan = (text, laps = 2) => {
  const chars = [...String(text)];
  const digitCount = chars.filter((c) => /\d/.test(c)).length;
  let seen = 0;
  return chars.map((c) => {
    if (!/\d/.test(c)) return { char: c };
    const fromRight = digitCount - 1 - seen++;
    // the units wheel spins `laps` full turns, each wheel to its left one
    // fewer (a long number's leading digits just roll up to their value)
    const spins = Math.max(0, laps - fromRight);
    const n = Number(c);
    return { digit: n, steps: spins * 10 + n };
  });
};

export const odometer = (text, { ms = 1600, delay = 0, laps = 2, className = "" } = {}) => {
  const el = document.createElement("span");
  el.className = `play-odo ${className}`.trim();
  el.setAttribute("role", "text");
  el.setAttribute("aria-label", String(text));
  const strips = [];
  const plan = wheelPlan(text, laps);
  plan.forEach((p, i) => {
    if (p.char !== undefined) {
      const s = document.createElement("span");
      s.className = "play-odo-char";
      s.setAttribute("aria-hidden", "true");
      s.textContent = p.char;
      el.append(s);
      return;
    }
    const wheel = document.createElement("span");
    wheel.className = "play-odo-wheel";
    wheel.setAttribute("aria-hidden", "true");
    const strip = document.createElement("span");
    strip.className = "play-odo-strip";
    // 0..9 for every lap, then 0..digit: the strip slides up `steps` digits
    let digits = "";
    for (let k = 0; k <= p.steps; k++) digits += `<span>${k % 10}</span>`;
    strip.innerHTML = digits;
    // the wheel's width comes from its final digit (the strip is absolute)
    const sizer = document.createElement("span");
    sizer.className = "play-odo-sizer";
    sizer.textContent = String(p.digit);
    wheel.append(sizer, strip);
    el.append(wheel);
    strips.push({ strip, steps: p.steps, order: i });
  });
  // the wheels land left to right: the leftmost first, each next a beat
  // later. A CSS animation (not a transition), so a paused story freezes it.
  const n = strips.length;
  strips.forEach((s, k) => {
    s.strip.style.setProperty("--odo-to", `calc(var(--odo-h) * ${-s.steps})`);
    s.strip.style.setProperty("--odo-ms", `${Math.round(ms * (0.62 + 0.38 * (n > 1 ? k / (n - 1) : 1)))}ms`);
    s.strip.style.setProperty("--odo-delay", `${delay}ms`);
  });
  const settle = () => {
    el.classList.remove("is-rolling");
    el.classList.add("is-settled");
  };
  const start = () => {
    if (reduced()) return settle();
    el.classList.remove("is-settled", "is-rolling");
    void el.offsetWidth; // (so a second start() rolls again from 0)
    el.classList.add("is-rolling");
  };
  return { el, start, settle };
};

export const countUp = (node, to, { ms = 1200, delay = 0, format = (v) => String(Math.round(v)) } = {}) => {
  node.textContent = format(reduced() ? to : 0);
  return tween({ ms, delay, ease: EASE.outExpo, onUpdate: (t) => { node.textContent = format(to * t); } });
};
