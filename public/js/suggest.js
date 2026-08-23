// The instant-suggestions dropdown, shared by the Search screen and the
// Movies/Shows pages. One implementation: typo-tolerant rows from
// /api/search/suggest, related-titles fill labeled honestly, Enter/Escape
// dismissal with the queued-debounce squelch.
import { el, debounce, posterImg } from "./ui.js";
import { api } from "./api.js";
import { navigate } from "./router.js";

// Where a suggestion goes when opened: the library page when we own it,
// its Discover page otherwise.
export const suggestHref = (s) => {
  if (s.inLibrary && s.id) return s.type === "show" ? `#/show/${s.id}` : `#/movie/${s.id}`;
  if (s.imdbId) return `#/discover/${s.type === "show" ? "series" : "movie"}/${s.imdbId}`;
  return null;
};

// Wire suggestions to an input, rendering into `host` (a .suggest-list).
// opts: { type: "movie"|"show" to suggest only that kind, onPick(s) }.
export const attachSuggest = (input, host, opts = {}) => {
  let token = 0;
  let squelched = false; // Enter/Escape said "stay hidden"
  const hide = () => {
    host.classList.add("hidden");
    host.innerHTML = "";
  };
  const pick = (s) => {
    hide();
    if (opts.onPick) opts.onPick(s);
    else {
      const href = suggestHref(s);
      if (href) navigate(href);
    }
  };
  const run = debounce(async () => {
    if (squelched) return; // a queued debounce tick outlives the keydown
    const q = input.value.trim();
    if (q.length < 2) return hide();
    const t = ++token;
    // The list is in-flow (not an overlay): on a phone it stacks in ONE
    // column, so ten rows would shove the page below the fold — ask for
    // fewer there; wide screens flow into columns and take the full ten.
    const limit = window.innerWidth < 700 ? 5 : 10;
    let suggestions = [];
    try {
      ({ suggestions } = await api.suggest(q, opts.type, limit));
    } catch {}
    if (t !== token || squelched || input.value.trim() !== q) return;
    host.innerHTML = "";
    if (!suggestions.length) return hide();
    let dividerDone = false;
    for (const s of suggestions) {
      // the related fill starts here — label it so it never reads as a match
      if (s.relatedTo && !dividerDone) {
        dividerDone = true;
        host.append(el("div", { class: "suggest-divider" }, `More like ${s.relatedTo}`));
      }
      host.append(
        el(
          "button",
          { class: "suggest-item focusable", onclick: () => pick(s) },
          s.cover
            ? posterImg(s.cover, s.title, "suggest-thumb", "suggest-thumb")
            : el("span", { class: "suggest-thumb" }),
          el("span", { class: "suggest-title" }, s.title),
          el("span", { class: "suggest-meta" },
            [s.year, s.type === "show" ? "Series" : "Film"].filter(Boolean).join(" · ")),
          s.inLibrary && el("span", { class: "disc-tag have" }, "IN LIBRARY"),
        ),
      );
    }
    host.classList.remove("hidden");
  }, 120);
  input.addEventListener("input", () => {
    squelched = false; // fresh typing re-arms suggestions
    run();
  });
  // Enter = "I'm committing to the full results" and Escape = "get out of my
  // way" — both dismiss the dropdown so it doesn't sit on top of the grid.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Escape") {
      squelched = true;
      token++; // cancel any in-flight reply too
      hide();
    }
  });
  return { hide };
};
