// Aurora Play — a card that tilts under the pointer, with a foil sheen that
// slides across it as it turns (the collectible cards).
//
//   tilt(card, { max = 14, foil = true })  -> undo()
//       `card` is the element that turns (it gets .play-tilt); its children
//       may include a .play-foil layer (the sheen) and a .play-glare (the
//       light spot). Pointer moves are read at most once a frame; the card
//       eases back flat when the pointer leaves. On a touch screen the card
//       follows the finger while it is held, and otherwise sways on its own
//       (.play-tilt.is-idle, CSS) — still under reduced motion.
//   tiltFrom(x, y, rect, max)  pure: the pointer at (x, y) over `rect` ->
//       { rx, ry, mx, my } (degrees about X and Y; mx/my 0..1 across the card)
//
// Everything moves by transform: the card by rotateX/rotateY, the foil and
// the glare by translate (their gradients are painted once, larger than the
// card, and slid — never re-painted per frame).
import { reduced, clamp } from "./motion.js";

export const tiltFrom = (x, y, rect, max = 14) => {
  const mx = clamp((x - rect.left) / (rect.width || 1), 0, 1);
  const my = clamp((y - rect.top) / (rect.height || 1), 0, 1);
  // pointer to the right turns the right edge AWAY (rotateY +), pointer at
  // the top tips the top edge away (rotateX +)
  return { rx: +((0.5 - my) * 2 * max).toFixed(2), ry: +((mx - 0.5) * 2 * max).toFixed(2), mx: +mx.toFixed(3), my: +my.toFixed(3) };
};

export const tilt = (card, { max = 14 } = {}) => {
  if (!card) return () => {};
  card.classList.add("play-tilt");
  const still = reduced();
  const foil = card.querySelector(".play-foil");
  const glare = card.querySelector(".play-glare");
  let raf = 0;
  let want = null;
  const paint = () => {
    raf = 0;
    if (!want) return;
    const { rx, ry, mx, my } = want;
    card.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
    // the sheen travels against the turn, a little further than the card
    if (foil) foil.style.transform = `translate3d(${(0.5 - mx) * 40}%, ${(0.5 - my) * 40}%, 0)`;
    if (glare) {
      glare.style.transform = `translate3d(${(mx - 0.5) * 100}%, ${(my - 0.5) * 100}%, 0)`;
      glare.style.opacity = "1";
    }
  };
  const move = (e) => {
    if (still) return;
    if (e.pointerType === "touch" && !(e.buttons & 1) && e.type !== "pointerdown") return;
    card.classList.remove("is-idle");
    card.classList.add("is-live");
    want = tiltFrom(e.clientX, e.clientY, card.getBoundingClientRect(), max);
    if (!raf) raf = requestAnimationFrame(paint);
  };
  const rest = () => {
    want = null;
    cancelAnimationFrame(raf);
    raf = 0;
    card.classList.remove("is-live");
    card.style.transform = "";
    if (foil) foil.style.transform = "";
    if (glare) { glare.style.transform = ""; glare.style.opacity = ""; }
    if (!still) card.classList.add("is-idle");
  };
  const lift = (e) => { if (e.pointerType === "touch") rest(); };
  const host = card.parentElement || card;
  host.addEventListener("pointermove", move);
  host.addEventListener("pointerdown", move);
  host.addEventListener("pointerleave", rest);
  host.addEventListener("pointercancel", rest);
  host.addEventListener("pointerup", lift);
  rest();
  return () => {
    cancelAnimationFrame(raf);
    host.removeEventListener("pointermove", move);
    host.removeEventListener("pointerdown", move);
    host.removeEventListener("pointerleave", rest);
    host.removeEventListener("pointercancel", rest);
    host.removeEventListener("pointerup", lift);
    card.classList.remove("is-idle", "is-live");
  };
};
