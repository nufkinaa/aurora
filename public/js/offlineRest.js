// [offline-look] With no connection, a page that needs the server RESTS: it
// does not fail, and it does not send the person Home without a word.
//
//   unreachable(err)        was that failure "Aurora is out of reach"?
//   restTitle(screen, …)    a title page: what is known of the title, whether
//                           it is on this device, and the one button that helps
//   restPlay(id)            the player's side: the copy on this device plays;
//                           with none, one calm line and back where you were
//
// Loaded only on those failure paths (a dynamic import) — nothing of it is in
// the way of a page that opens. Values and words: docs/offline-look.md.
import { el, icons, toast } from "./ui.js";
import { state, progressFor } from "./state.js";
import { navigate } from "./router.js";
import * as offline from "./offline.js";
import { mark, restIcon, deviceIcon, PLACE } from "./offlineUi.js";

// A request that never got an answer: the worker's own "offline" (503), a
// fetch that failed, one that ran out of time. A refusal (a kids profile, a
// title that is gone) is an answer — not this.
export const unreachable = (err) =>
  navigator.onLine === false || !!(err && (err.message === "offline" || err.timeout || (!err.status && err.name !== "AbortError")));

const who = () => (state.profile ? { id: state.profile.id, kids: !!state.profile.kids } : offline.lastWho());
// what this person holds on this device of a title: the film itself, or a show's episodes in order
const copiesOf = async (id) => {
  let list = [];
  try { list = await offline.listSavedFor(who()); } catch {}
  // (a library id, or — from a catalogue page — the title's IMDb id)
  const own = list.find((c) => c.id === id || (c.imdbId && c.imdbId === id && c.season == null));
  if (own) return { film: own, eps: [] };
  const eps = list.filter((c) => (c.showId === id || (c.imdbId && c.imdbId === id)) && c.season != null && c.episode != null).sort((a, b) => a.season - b.season || a.episode - b.episode);
  return { film: null, eps };
};
// what the app already knows of it without asking anybody
const known = (id) => {
  const lib = state.library;
  if (!lib) return null;
  return (lib.movies || []).find((x) => x.id === id) || (lib.shows || []).find((x) => x.id === id) || null;
};
const epName = (c) => `S${c.season} E${c.episode}`;

export const restTitle = async (screen, { id, source = "library" } = {}) => {
  const entry = location.hash;
  const { film, eps } = await copiesOf(id);
  if (location.hash !== entry || !screen.isConnected) return;
  const k = source === "library" ? known(id) : null;
  const title = (film && film.title) || (eps[0] && eps[0].showTitle) || (k && k.title) || null;
  const cover = (film && film.cover) || (eps[0] && eps[0].cover) || (k && k.cover) || null;
  // the next episode on this device that is not finished (else the first)
  const next = eps.find((e) => { const p = progressFor(e.id); return !(p && p.finished); }) || eps[0] || null;
  const here = film || next;
  const line = film
    ? "It is on this device, so it plays with no connection."
    : eps.length
      ? `${eps.length === 1 ? "One episode is" : `${eps.length} episodes are`} on this device — ${eps.length === 1 ? "it plays" : "they play"} with no connection.`
      : `${title ? "It" : "This page"} isn't on this device, so it waits for the connection.`;
  const go = (hash) => () => navigate(hash);
  // no picture (or one that cannot be had now): a sign in its place — the
  // device when the title is here, the resting cloud when it is not
  const glyph = () => el("div", { class: "rest-glyph", html: here ? deviceIcon : restIcon, "aria-hidden": "true" });
  let art = glyph();
  if (cover) {
    const img = el("img", { src: cover, alt: "" });
    art = el("div", { class: "rest-cover" }, img, here ? mark("saved", 0, "rest-cover-mark") : null);
    const box = art;
    img.onerror = () => box.replaceWith(glyph());
  }
  const page = el("div", { class: "rest-page", "data-here": here ? "1" : "0" },
    art,
    el("div", { class: "rest-kicker" }, el("span", { class: "rest-kicker-ic", html: restIcon, "aria-hidden": "true" }), "No connection"),
    el("h1", { class: "rest-title" }, title || "This page is resting"),
    el("p", { class: "rest-line" }, line),
    el("div", { class: "rest-actions" },
      here
        ? el("button", { "data-ui": "saved.rest.play", class: "btn btn-primary focusable", html: `${icons.play}<span>${film ? "Play" : `Play ${epName(next)}`}</span>`, onclick: go(`#/play/${here.id}?offline=1`) })
        : null,
      offline.available()
        ? el("button", { "data-ui": "saved.rest.open", class: `btn focusable${here ? "" : " btn-primary"}`, html: `${deviceIcon}<span>${PLACE}</span>`, onclick: go("#/saved") })
        : null,
      el("button", { "data-ui": "saved.rest.retry", class: "btn focusable", onclick: go(entry) }, "Try again")));
  screen.classList.add("rest-screen");
  screen.replaceChildren(page);
  const first = page.querySelector(".rest-actions .focusable");
  if (first && document.activeElement === document.body) { try { first.focus({ preventScroll: true }); } catch {} }
};

// The player was asked for a title and Aurora did not answer. True when this
// took care of it (the caller only returns).
export const restPlay = async (id) => {
  const entry = location.hash;
  const { film } = await copiesOf(id);
  if (location.hash !== entry) return true;
  if (film) {
    // the copy on this device, in place of the page that could not open
    try { history.replaceState(null, "", `#/play/${id}?offline=1`); } catch {}
    navigate(`#/play/${id}?offline=1`);
    return true;
  }
  toast("This one isn't on this device — it plays when the connection is back", mark("none"), offline.available() ? { label: PLACE, onClick: () => navigate("#/saved") } : null);
  if (history.length > 1) history.back();
  else navigate(offline.available() ? "#/saved" : "#/");
  return true;
};
