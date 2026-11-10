// Aurora Play — a press that answers: the control squishes under the finger
// (or the Enter key) and springs back when it is let go, with a short haptic
// tick on a phone that has one (ui.js haptic: navigator.vibrate on Android,
// the system tick on an iPhone). The look is CSS (.play-press / .is-down in
// css/play.css: a fast scale-down, a springy return); this adds the state for
// keyboards and touch, where :active is unreliable.
//
//   pressable(node, { tick = true })  -> undo()
//   pressAll(root)   every .play-press inside root -> undo()
import { haptic } from "../ui.js";

export const pressable = (node, { tick = true } = {}) => {
  if (!node || node._playPress) return () => {};
  node._playPress = true;
  node.classList.add("play-press");
  const down = (e) => {
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    if (e.type === "keydown" && e.repeat) return;
    node.classList.add("is-down");
    if (tick && e.pointerType === "touch") { try { haptic(8); } catch {} }
  };
  const up = () => node.classList.remove("is-down");
  node.addEventListener("pointerdown", down);
  node.addEventListener("keydown", down);
  for (const t of ["pointerup", "pointercancel", "pointerleave", "keyup", "blur"]) node.addEventListener(t, up);
  return () => {
    node._playPress = false;
    node.removeEventListener("pointerdown", down);
    node.removeEventListener("keydown", down);
    for (const t of ["pointerup", "pointercancel", "pointerleave", "keyup", "blur"]) node.removeEventListener(t, up);
  };
};

export const pressAll = (root) => {
  const undo = [...root.querySelectorAll(".play-press")].map((n) => pressable(n));
  return () => undo.forEach((u) => u());
};
