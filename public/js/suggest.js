// The instant-suggestions list, shared by the Search screen and the
// Movies/Shows pages. Rows come from /api/search/suggest (v2) already in
// order: titles that start with what was typed (the library's first), then
// people and a genre, then looser and typo'd titles. Three kinds of row:
//   title   opens the title
//   person  searches for them (their titles)
//   genre   searches for it
// The matched part of each row is marked. A reply for anything but the text
// in the box right now is dropped, and a newer keystroke cancels the request.
import { el, debounce, posterImg } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { navigate } from "./router.js";

// Where a suggestion goes when opened: the library page when we own it,
// its Discover page otherwise.
export const suggestHref = (s) => {
  if (s.inLibrary && s.id) return s.type === "show" ? `#/show/${s.id}` : `#/movie/${s.id}`;
  if (s.imdbId) return `#/discover/${s.type === "show" ? "series" : "movie"}/${s.imdbId}`;
  return null;
};

const ICON = {
  person:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M4.500 20c1-4 4-5.600 7.500-5.600s6.500 1.600 7.500 5.600"/></svg>',
  genre:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.500 12.200V5a1.500 1.500 0 011.500-1.500h7.200a1.500 1.500 0 011.060.440l7 7a1.500 1.500 0 010 2.120l-7.200 7.200a1.500 1.500 0 01-2.120 0l-7-7a1.500 1.500 0 01-.440-1.060z"/><circle cx="8" cy="8" r="1.300"/></svg>',
};

// "Dune: Part Two" with [[0, 4]] → <mark>Dune</mark>: Part Two
export const marked = (text, ranges) => {
  const out = [];
  let at = 0;
  for (const [a, b] of Array.isArray(ranges) ? ranges : []) {
    if (a < at || b <= a || b > text.length) continue;
    if (a > at) out.push(text.slice(at, a));
    out.push(el("mark", {}, text.slice(a, b)));
    at = b;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
};

// Wire suggestions to an input, rendering into `host` (a .suggest-list).
// opts: { type: "movie"|"show" to suggest only titles of that kind,
//         onPick(s) for a title, onQuery(text, s) for a person or a genre }.
export const attachSuggest = (input, host, opts = {}) => {
  let token = 0;
  let squelched = false; // Enter/Escape said "stay hidden"
  let ctrl = null;
  const cancel = () => {
    if (ctrl) ctrl.abort();
    ctrl = null;
  };
  const hide = () => {
    host.classList.add("hidden");
    host.innerHTML = "";
  };
  const pick = (s) => {
    hide();
    if (s.kind === "person" || s.kind === "genre") {
      if (opts.onQuery) opts.onQuery(s.name, s);
      return;
    }
    if (opts.onPick) opts.onPick(s);
    else {
      const href = suggestHref(s);
      if (href) navigate(href);
    }
  };
  const row = (s) => {
    if (s.kind === "person" || s.kind === "genre") {
      return el(
        "button",
        {
          "data-ui": "search.suggestion.pick",
          class: `suggest-item suggest-${s.kind} focusable`,
          "aria-label": s.kind === "person" ? `${s.name}, person` : `${s.name}, genre`,
          onclick: () => pick(s),
        },
        el("span", { class: "suggest-thumb suggest-icon", html: ICON[s.kind] }),
        el("span", { class: "suggest-title" }, marked(s.name, s.hl)),
        el("span", { class: "suggest-meta" },
          s.kind === "person" ? (s.count > 1 ? `Person · ${s.count} titles` : "Person") : "Genre"),
      );
    }
    return el(
      "button",
      { "data-ui": "search.suggestion.pick", class: "suggest-item focusable", onclick: () => pick(s) },
      s.cover
        ? posterImg(s.cover, s.title, "suggest-thumb", "suggest-thumb")
        : el("span", { class: "suggest-thumb" }),
      el("span", { class: "suggest-title" }, marked(s.title, s.hl)),
      el("span", { class: "suggest-meta" },
        [s.year, s.type === "show" ? "Series" : "Film"].filter(Boolean).join(" · ")),
      s.inLibrary && el("span", { class: "disc-tag have" }, "IN LIBRARY"),
    );
  };
  const run = debounce(async () => {
    if (squelched) return; // a queued debounce tick outlives the keydown
    const q = input.value.trim();
    cancel();
    if (q.length < 1) return hide();
    const t = ++token;
    ctrl = typeof AbortController === "function" ? new AbortController() : null;
    // The list is in-flow (not an overlay): on a phone it stacks in ONE
    // column, so eight rows would shove the page below the fold — ask for
    // fewer there; wide screens flow into columns and take all eight.
    const limit = window.innerWidth < 700 ? 5 : 8;
    let suggestions = [];
    try {
      ({ suggestions } = await api.suggest(q, opts.type, limit, {
        profileId: (state.profile && state.profile.id) || "",
        signal: ctrl ? ctrl.signal : undefined,
      }));
    } catch {}
    if (t !== token || squelched || input.value.trim() !== q) return;
    if (!suggestions || !suggestions.length) return hide();
    // rows are replaced in one go, so the list never shows half of each answer
    host.replaceChildren(...suggestions.map(row));
    host.classList.remove("hidden");
  }, 90);
  input.addEventListener("input", () => {
    squelched = false; // fresh typing re-arms suggestions
    run();
  });
  // Down from the box goes to the FIRST row (the remote's geometric walk
  // would pick whichever row sits under the middle of the box).
  const onNav = (e) => {
    if (!input.isConnected) return document.removeEventListener("nav-move", onNav);
    if (e.detail !== "down" || document.activeElement !== input || host.classList.contains("hidden")) return;
    const first = host.querySelector(".suggest-item");
    if (!first) return;
    e.preventDefault(); // focus.js: a screen consumed the move
    first.focus();
  };
  document.addEventListener("nav-move", onNav);
  // Enter = "I'm committing to the full results" and Escape = "get out of my
  // way" — both dismiss the dropdown so it doesn't sit on top of the grid.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Escape") {
      squelched = true;
      token++; // drop any in-flight reply too
      cancel();
      hide();
    }
  });
  return { hide };
};
