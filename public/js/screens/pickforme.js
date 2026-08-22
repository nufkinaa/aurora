// The AI tab — describe the mood, get titles back with a line on why each one
// fits.
//
// The server does the thinking (src/media/ai.js). This screen is the ask: a text
// box, a Movies/Shows switch, two taste dials, and then normal cards. The cards
// are the same component the rest of the app uses and they sit in the same
// `.grid`, so anything picked here looks, opens and plays exactly like a title
// found any other way.
//
// The router rebuilds every screen from scratch on each navigation, which meant
// opening one of the results and pressing Back threw the whole answer away — for
// a list that costs real money and ten seconds to produce. So the last answer
// lives at module scope and is painted straight back on return, scroll position
// included. A full page refresh starts clean, which is fine: the server caches an
// identical request for a day, so asking again is instant and free.
import { el, toast } from "../ui.js";
import { card } from "../components.js";
import { api } from "../api.js";

const EXAMPLES = [
  "something dumb and loud, I've had a long day",
  "slow and beautiful, nothing scary",
  "a clever thriller that respects my time",
  "makes me cry in a good way",
  "comfort food, seen it a hundred times energy",
];

// Movies or Shows, nothing in between: the server takes a 0..100 mix, and these
// are its two ends. 0 = films only, 100 = series only.
const KINDS = [
  { id: "movie", label: "Movies", mix: 0 },
  { id: "show", label: "Shows", mix: 100 },
];

// The taste dials. Ids have to match the ones src/media/ai.js knows; the labels
// are plain English on purpose — "Not too old" is clearer than "2010 onwards"
// when you're picking something to watch, and the server owns what the boundary
// actually is.
const ERAS = [
  { id: "any", label: "Any era" },
  { id: "fresh", label: "Recent" },
  { id: "modern", label: "Not too old" },
  { id: "classic", label: "A classic" },
];

// Length means different things for a film and a series, so the row swaps with
// the switch rather than pretending one set of options fits both.
const LENGTHS = {
  movie: [
    { id: "any", label: "Any length" },
    { id: "short", label: "Under 100 min" },
    { id: "standard", label: "Under 2 hours" },
    { id: "epic", label: "Something long" },
  ],
  show: [
    { id: "any", label: "Any length" },
    { id: "limited", label: "One or two seasons" },
    { id: "meaty", label: "Many seasons" },
  ],
};

// It takes several seconds, so the wait narrates itself rather than sitting on
// one word long enough to look broken. The last one is the honest truth about
// what the server is doing by then.
const STAGES = [
  "Reading the room…",
  "Ransacking the archives…",
  "Arguing with itself about your taste…",
  "Checking which of these Aurora can actually play…",
];
const STAGE_MS = 2600;
const SKELETONS = 16;

// The last answer, kept for the life of the page:
// { vibe, kindId, era, length, items, status, scrollY }
let last = null;

export const renderPickForMe = async (root) => {
  const screen = el("div", { class: "screen pfm" });

  // ---- state. These four are the whole request. Seeded from the last answer so
  // coming back shows the controls exactly as they were left. ----
  let kind = KINDS.find((k) => k.id === (last && last.kindId)) || KINDS[0];
  let era = (last && last.era) || "any";
  let length = (last && last.length) || "any";
  let busy = false;
  // Set by the router's cleanup, so a reply that lands after the viewer has
  // navigated away is still remembered but doesn't touch a detached screen.
  let gone = false;
  let ticker = null;

  const input = el("input", {
    type: "text",
    class: "pfm-input focusable",
    placeholder: "What are you in the mood for?",
    maxlength: "300",
  });

  // ---- the switch: one click anywhere on it flips to the other option ----
  const thumb = el("span", { class: "pfm-switch-thumb" });
  const opts = KINDS.map((k) => el("span", { class: "pfm-switch-opt" }, k.label));
  const paintSwitch = () => {
    const shows = kind.id === "show";
    switcher.setAttribute("aria-checked", shows ? "true" : "false");
    opts[0].classList.toggle("on", !shows);
    opts[1].classList.toggle("on", shows);
  };
  const flip = () => {
    kind = kind.id === "movie" ? KINDS[1] : KINDS[0];
    // The length ids are per-kind, so a live selection can't survive the flip.
    length = "any";
    paintSwitch();
    lengthRow.repaint();
  };
  const switcher = el(
    "button",
    {
      type: "button",
      class: "pfm-switch focusable",
      role: "switch",
      "aria-checked": "false",
      "aria-label": "Recommend movies or shows",
      onclick: flip,
    },
    thumb,
    ...opts
  );

  // ---- taste pills ----
  // getOptions is a function, not an array, because the length row's options
  // change when the switch flips.
  const pillRow = (label, getOptions, getValue, setValue) => {
    const row = el("div", { class: "pfm-tune-group" });
    const repaint = () => {
      row.innerHTML = "";
      row.append(el("span", { class: "pfm-tune-label" }, label));
      for (const o of getOptions()) {
        const on = o.id === getValue();
        row.append(
          el("button", {
            type: "button",
            class: `pfm-pill focusable ${on ? "on" : ""}`,
            "aria-pressed": on ? "true" : "false",
            onclick: () => { setValue(o.id); repaint(); },
          }, o.label)
        );
      }
    };
    repaint();
    return { row, repaint };
  };

  const eraRow = pillRow("Era", () => ERAS, () => era, (v) => { era = v; });
  const lengthRow = pillRow(
    "Length",
    () => LENGTHS[kind.id],
    () => length,
    (v) => { length = v; }
  );

  const goBtn = el("button", { type: "button", class: "pfm-go focusable" }, "Find me something");
  const waiting = el("div");                                 // holds the wait state while busy
  const status = el("div", { class: "pfm-status" });
  const results = el("div", { class: "pfm-results grid" });

  // ---- the wait ----
  const startWaiting = () => {
    const msg = el("div", { class: "pfm-wait-msg in" }, STAGES[0]);
    waiting.append(
      el("div", { class: "pfm-wait" },
        msg,
        el("div", { class: "pfm-wait-bar" }),
        el("div", { class: "pfm-wait-hint" },
          "Asking for actual opinions, not running a database query — give it a few seconds.")
      )
    );
    // Poster-shaped placeholders so the results land into a layout that already
    // has their shape, instead of shoving the page down when they arrive.
    for (let i = 0; i < SKELETONS; i++) results.append(el("div", { class: "skeleton pfm-skel" }));

    let stage = 0;
    return setInterval(() => {
      stage = Math.min(stage + 1, STAGES.length - 1);
      msg.textContent = STAGES[stage];
      // Restart the fade so each new message animates in. Reading offsetWidth
      // forces the reflow that makes removing and re-adding the class count as
      // two separate states.
      msg.classList.remove("in");
      void msg.offsetWidth;
      msg.classList.add("in");
    }, STAGE_MS);
  };

  // One path for painting results, used by a fresh answer and a restored one
  // alike — so what comes back after Back is exactly what was there before.
  const paint = (items, statusText) => {
    waiting.innerHTML = "";
    results.innerHTML = "";
    status.textContent = statusText;
    // Each card keeps its own reason directly beneath it, so the link between
    // pick and justification survives any wrapping of the grid.
    results.append(
      ...items.map((item) =>
        el("div", { class: "pfm-pick" },
          card(item),
          // title so a reason that overruns the three-line clamp is still
          // readable on hover rather than lost.
          item.why ? el("div", { class: "pfm-why", title: item.why }, item.why) : ""
        )
      )
    );
  };

  const ask = async () => {
    const vibe = input.value.trim();
    if (vibe.length < 3) { input.focus(); return; }
    if (busy) return;
    busy = true;
    goBtn.disabled = true;
    status.textContent = "";
    results.innerHTML = "";
    waiting.innerHTML = "";
    ticker = startWaiting();

    try {
      const res = await api.aiRecommend(vibe, kind.mix, era, length);
      const items = res.items || [];
      if (!items.length) {
        if (!gone) {
          waiting.innerHTML = "";
          results.innerHTML = "";
          status.textContent = "Nothing came back for that. Try describing it differently.";
        }
        return;
      }
      const noun = kind.id === "show"
        ? (items.length === 1 ? "show" : "shows")
        : (items.length === 1 ? "film" : "films");
      const statusText =
        `${items.length} ${noun} for “${vibe}”` +
        (res.cached ? " · from earlier" : "") +
        // The taste chips can genuinely strangle a request — "recent" plus "many
        // seasons" leaves almost nothing standing. Say so, rather than letting a
        // three-title page read as the recommender being useless.
        (items.length < 5 && (era !== "any" || length !== "any")
          ? " · not much fits those filters, try loosening one"
          : "");
      // Remember it before painting, so an answer that arrives while the viewer
      // is elsewhere is waiting for them when they come back.
      last = { vibe, kindId: kind.id, era, length, items, status: statusText, scrollY: 0 };
      if (!gone) paint(items, statusText);
    } catch (err) {
      if (gone) return;
      waiting.innerHTML = "";
      results.innerHTML = "";
      status.textContent = "";
      toast((err && err.message) || "The recommender didn't answer.", "🤖");
    } finally {
      clearInterval(ticker);
      ticker = null;
      busy = false;
      goBtn.disabled = false;
    }
  };

  goBtn.addEventListener("click", ask);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });
  paintSwitch();

  screen.append(
    el("div", { class: "pfm-head" },
      el("h1", {}, "AI"),
      el("p", { class: "pfm-sub" },
        "Describe the mood in your own words. It searches everything Aurora can play — not just what's already downloaded.")
    ),
    el("div", { class: "pfm-box" },
      el("div", { class: "pfm-ask" }, input, goBtn),
      el("div", { class: "pfm-tune" },
        el("div", { class: "pfm-tune-group" }, switcher),
        eraRow.row,
        lengthRow.row
      )
    ),
    el("div", { class: "pfm-examples" },
      el("span", { class: "pfm-examples-label" }, "Try:"),
      ...EXAMPLES.map((ex) =>
        el("button", {
          type: "button",
          class: "pfm-example focusable",
          onclick: () => { input.value = ex; ask(); },
        }, ex))
    ),
    waiting,
    status,
    results
  );

  root.append(screen);

  if (last) {
    // Coming back to an answer we already have: put it up, restore where they
    // were reading, and leave the box alone rather than stealing focus.
    input.value = last.vibe;
    paint(last.items, last.status);
    // The router scrolls to the top before calling us, so the restore has to
    // happen after this frame's layout — the posters have a fixed aspect ratio,
    // so the page is already its full height without waiting on any image.
    if (last.scrollY) requestAnimationFrame(() => window.scrollTo(0, last.scrollY));
  } else {
    setTimeout(() => input.focus(), 60);
  }

  // The router calls this before tearing the screen down.
  return () => {
    gone = true;
    if (ticker) clearInterval(ticker);
    if (last) last.scrollY = window.scrollY;
  };
};
