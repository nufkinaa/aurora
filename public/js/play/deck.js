// Aurora Play — the card deck's feel, shared by Taste and Pick together
// (CSS: the DECK section of play.css).
//
//   pullOf(dx, dy, distX, distY)  -> 0..1: how far a drag is towards an
//       answer; the card underneath rises by this much (`--pull` on the deck).
//   setPull(deck, v)  puts it on the deck; 0 lets the deck rest again.
//   depthOf(left)  -> "0".."4": how many cards the deck still shows (the one
//       on top, the next, two plates) for `data-depth`.
//   slam(node, stamp, nudge)  the answer given by a button or a key: the
//       stamp is slammed onto the card and the card takes the hit; SLAM_MS
//       later the caller throws it.
import { clamp } from "./motion.js";

export const SLAM_MS = 170;

export const pullOf = (dx, dy, distX, distY) =>
  clamp(Math.max(Math.abs(dx) / (distX || 1), Math.abs(dy) / (distY || 1)), 0, 1);

export const setPull = (deck, v) => {
  if (!deck) return;
  if (v > 0) {
    deck.classList.add("is-pulling");
    deck.style.setProperty("--pull", v.toFixed(3));
  } else {
    deck.classList.remove("is-pulling");
    deck.style.removeProperty("--pull");
  }
};

export const depthOf = (left) => String(clamp(Math.floor(Number(left) || 0), 0, 4));

export const slam = (node, stamp, { x = 0, y = 0, r = 0 } = {}) => {
  if (stamp) {
    stamp.style.opacity = "1";
    stamp.classList.add("pg-slam");
  }
  node.style.transition = "transform 150ms cubic-bezier(.2,.9,.3,1.3)";
  node.style.transform = `translate(${x}px, ${y}px) rotate(${r}deg)`;
};
