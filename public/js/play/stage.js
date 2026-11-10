// Aurora Play — putting a play screen on the page, and two small pieces the
// games share (Taste, Pick together, Pick for me).
//
//   mountPlay(screen, { seed })  -> { ready, destroy() }: the screen becomes a
//       play surface with the room behind it (fixed, so it fills the window),
//       and stays unseen until css/play.css is on the page — never a frame of
//       the unstyled thing. `ready` resolves when it can be shown (at most
//       4 s, loadPlayCss's own limit). destroy() when the screen goes.
//   star(cls)  -> an <svg> five-point star (currentColor), aria-hidden.
//   say(node, text, { ms })  -> a status pill's words: pops in, holds, fades
//       (CSS `.pg-callout`); under reduced motion it stays until clear().
//       Returns clear().
import { loadPlayCss, room } from "./room.js";
import { reduced } from "./motion.js";

export const mountPlay = (screen, { seed = 11 } = {}) => {
  screen.classList.add("play-surface", "pg");
  const bg = room({ seed });
  bg.el.classList.add("pg-room");
  screen.prepend(bg.el);
  screen.style.visibility = "hidden";
  const ready = loadPlayCss().then(() => { screen.style.visibility = ""; });
  return { ready, destroy: () => bg.destroy() };
};

const NS = "http://www.w3.org/2000/svg";
const STAR = "M12 1.8l2.95 6.6 7.2.75-5.4 4.85 1.55 7.1L12 17.4l-6.3 3.7 1.55-7.1-5.4-4.85 7.2-.75z";
export const star = (cls = "") => {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `pg-star ${cls}`.trim());
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", STAR);
  svg.append(p);
  return svg;
};

export const say = (node, text, { ms = 2900 } = {}) => {
  clearTimeout(node._sayT);
  node.textContent = text;
  node.classList.remove("on");
  void node.offsetWidth; // (the pop starts again for a second message)
  node.classList.add("on");
  const clear = () => { clearTimeout(node._sayT); node.classList.remove("on"); node.textContent = ""; };
  if (!reduced()) node._sayT = setTimeout(clear, ms);
  return clear;
};
