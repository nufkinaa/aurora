// Left/right nudge buttons for the horizontal rows, on desktop only.
//
// Touch already has the answer (you swipe) and so does the keyboard (the focus
// manager scrolls the row as you move along it). What has nothing is a mouse: the
// scrollbar is hidden, so a row that continues off-screen looks like a row that
// ends there.
//
// Two things make this feel calm rather than clicky:
//
//   It moves by whole cards, never by a raw pixel amount, so a row never comes to
//   rest with a poster sliced in half.
//
//   A wide row does NOT advance by a full screenful. Turning over every card at
//   once leaves nothing to anchor against and reads as a jump cut, so once six or
//   more cards fit, two of them stay on screen as a hinge. Below that the row is
//   small enough that a full turn is still followable.
import { el, icons } from "./ui.js";

// Cards kept on screen between presses, once the row is wide enough to spare them.
const OVERLAP = 2;
// Below this many visible cards, advance by the full set instead of holding some
// back — with four visible, keeping two would barely move.
const OVERLAP_FROM = 6;
// Slack for fractional scroll positions: browsers report scrollLeft as a float and
// scrollWidth as an integer, so an exact comparison never reports "at the end".
const EPSILON = 2;

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const attachRowArrows = (section, scroller) => {
  const prev = el("button", {
    class: "row-nav prev",
    type: "button",
    "aria-label": "Scroll left",
    tabindex: "-1",
    html: icons.chevronLeft,
  });
  const next = el("button", {
    class: "row-nav next",
    type: "button",
    "aria-label": "Scroll right",
    tabindex: "-1",
    html: icons.chevronRight,
  });

  // Distance from one card to the next, measured rather than assumed: the gap is
  // a token that changes on small screens, and Continue Watching uses wider cards
  // than every other row.
  const cardStep = () => {
    const kids = scroller.children;
    if (kids.length >= 2) return kids[1].offsetLeft - kids[0].offsetLeft;
    return kids.length ? kids[0].offsetWidth : scroller.clientWidth;
  };

  const padLeft = () => parseFloat(getComputedStyle(scroller).paddingLeft) || 0;

  // The leftmost card not yet scrolled past — where a press counts from.
  const leadingIndex = () => {
    const edge = scroller.scrollLeft + padLeft() + EPSILON;
    const kids = scroller.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].offsetLeft + kids[i].offsetWidth > edge) return i;
    }
    return Math.max(0, kids.length - 1);
  };

  const scrollToCard = (index) => {
    const kids = scroller.children;
    if (!kids.length) return;
    const card = kids[Math.max(0, Math.min(kids.length - 1, index))];
    scroller.scrollTo({
      left: Math.max(0, card.offsetLeft - padLeft()),
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  };

  const nudge = (direction) => {
    const step = cardStep();
    if (step <= 0) return;
    const visible = Math.max(1, Math.round(scroller.clientWidth / step));
    const advance = visible >= OVERLAP_FROM ? visible - OVERLAP : visible;
    scrollToCard(leadingIndex() + direction * advance);
  };

  // Which arrows are worth showing. A row that fits entirely shows neither, so
  // the buttons only ever appear where there is genuinely something past the edge.
  const paint = () => {
    const overflows = scroller.scrollWidth - scroller.clientWidth > EPSILON;
    section.classList.toggle(
      "can-prev",
      overflows && scroller.scrollLeft > EPSILON,
    );
    section.classList.toggle(
      "can-next",
      overflows &&
        scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - EPSILON,
    );

    // Centre the arrows on the cards, not on the scroller box. That box carries
    // several rems of asymmetric padding so the focus aura isn't clipped by its
    // own overflow, and centring on it sits the arrows visibly low. Measuring the
    // first card instead stays correct if that padding is ever retuned.
    const first = scroller.firstElementChild;
    if (first) {
      const rowTop = section.getBoundingClientRect().top;
      const box = first.getBoundingClientRect();
      section.style.setProperty("--row-nav-y", `${box.top - rowTop + box.height / 2}px`);
    }
    section.style.setProperty("--row-nav-x", `${padLeft()}px`);
  };

  prev.addEventListener("click", () => nudge(-1));
  next.addEventListener("click", () => nudge(1));

  scroller.addEventListener("scroll", paint, { passive: true });
  // Covers the row growing (images settling, cards added) and the window resizing
  // past the point where the row still overflows.
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(paint);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
  }

  section.append(prev, next);
  // First measurement has to wait for layout: nothing has a width yet at build
  // time, and ResizeObserver's initial callback only arrives once it does.
  requestAnimationFrame(paint);
};
