// Shared UI pieces: media cards and horizontal rows.
import { el, icons, fmtDuration, toast, posterImg } from "./ui.js";
import { navigate } from "./router.js";
import { state, progressFor, ratingFor } from "./state.js";
import { api } from "./api.js";
import { attachRowArrows } from "./rowArrows.js";
import * as narrator from "./narrator.js";

// A flat "Rated 3★" wastes a moment the viewer just chose to have; the
// reaction scales with the score instead.
const RATING_QUIPS = {
  1: "brutal",
  2: "not for you, then",
  3: "perfectly fine",
  4: "a good one",
  5: "a favourite!",
};

// 1–5 star control. `key` is a library id or IMDb id; stored per profile.
// Clicking a filled star again clears the rating.
export const starRating = (key) => {
  const wrap = el("div", { class: "star-rating", role: "group", "aria-label": "Your rating" });
  const paint = () => {
    const val = ratingFor(key);
    [...wrap.children].forEach((s, i) => s.classList.toggle("on", i < val));
  };
  for (let i = 1; i <= 5; i++) {
    const star = el("button", {
      class: "star focusable",
      "aria-label": `${i} star${i > 1 ? "s" : ""}`,
      html: "★",
      onclick: async () => {
        if (!state.profile) return;
        const next = ratingFor(key) === i ? 0 : i;
        state.ratings[key] = next || undefined;
        if (!next) delete state.ratings[key];
        paint();
        try {
          await api.rate(state.profile.id, key, next);
          toast(next ? `${next}★ — ${RATING_QUIPS[next]}` : "Rating wiped. We saw nothing.", "⭐");
          // Jokes never get to break a rating: they run after the save, guarded.
          narrator.call("onRate", key);
        } catch {}
      },
    });
    wrap.append(star);
  }
  paint();
  return wrap;
};

export const openItem = (item) => {
  // Resume a streamed title from Continue Watching: hand the stored play-item
  // straight to the player (its transcode URLs etc. aren't reconstructable from
  // the id alone).
  if (item.id?.startsWith("torrent|")) {
    state.pendingItems[item.id] = item;
    navigate(`#/play/${item.id}`);
  }
  // Stream (Discover) titles open the streaming detail page by IMDb id
  else if (item.source === "stream" && item.imdbId) {
    navigate(`#/discover/${item.type === "show" ? "series" : "movie"}/${item.imdbId}`);
  } else if (item.type === "show") navigate(`#/show/${item.id}`);
  else if (item.type === "movie") navigate(`#/movie/${item.id}`);
  else if (item.showId) navigate(`#/play/${item.id}`); // episode
};

const NEW_WINDOW_MS = 7 * 24 * 3600 * 1000;

export const card = (item, { wide = false, onRemove = null, showKind = false } = {}) => {
  const isEpisode = !!item.showId && item.type !== "show";
  const prog = progressFor(item.id);
  const pct =
    prog && prog.duration > 0 && !prog.finished
      ? Math.min(100, (prog.position / prog.duration) * 100)
      : null;
  const isNew = item.addedAt && Date.now() - item.addedAt < NEW_WINDOW_MS && !prog;

  // A New Episodes card is a show poster, so on its own it cannot say the one
  // thing the row exists to tell you: which episode is waiting.
  //
  // The episode NUMBER only, deliberately. A poster carries the show's name set
  // large across its own bottom third, which is exactly where a card label sits —
  // repeating the title there put the word "Silo" on top of the artwork's own
  // "SILO". The row heading and the poster already say which show this is.
  const newEp = item.newEpisode;
  const waiting = newEp && item.newEpisodeCount > 1 ? item.newEpisodeCount : 0;
  const behind = waiting ? ` · ${waiting} new` : "";
  const labelFor = () => {
    if (isEpisode) {
      return el("div", { class: "card-label" },
        el("span", { class: "card-sub" }, item.showTitle || ""),
        `S${item.season} E${item.episode} · ${item.title}`);
    }
    if (newEp) {
      return el("div", { class: "card-label" }, `S${newEp.season} E${newEp.episode}${behind}`);
    }
    return el("div", { class: "card-label" }, item.title);
  };
  const label = labelFor();
  const showLabel = wide || isEpisode || item.upNext || !!newEp;

  const node = el(
    "button",
    {
      class: [
        "card focusable",
        wide || isEpisode ? "wide" : "poster",
        showLabel && "has-label",
      ]
        .filter(Boolean)
        .join(" "),
      // The visible label drops the show name, so the accessible one carries both
      // it and the episode.
      "aria-label": newEp
        ? `${item.title}, season ${newEp.season} episode ${newEp.episode}` +
          (waiting ? `, ${waiting} new episodes` : "")
        : item.title,
      onclick: () => openItem(item),
    },
    item.cover
      ? posterImg(item.cover, item.title)
      : el("div", { class: "card-fallback" }, item.title),
    el("div", { class: "card-shade" }),
    item.source === "stream" && el("span", { class: "card-tag stream" }, "STREAM"),
    // Series or film. Only where the row it sits in mixes the two, and never on an
    // episode (its own label already reads "S3 E2") or a card carrying the remove
    // ✕, which owns this corner.
    showKind && !isEpisode && !onRemove &&
      el("span", {
        class: `card-tag kind ${item.type === "show" ? "series" : "film"}`,
        html:
          (item.type === "show" ? icons.series : icons.film) +
          `<span>${item.type === "show" ? "SERIES" : "FILM"}</span>`,
      }),
    isNew && el("span", { class: "card-new" }, "NEW"),
    pct !== null && el("div", { class: "card-progress" }, el("div", { style: { width: pct + "%" } })),
    showLabel && label,
    onRemove &&
      el("span", {
        class: "card-remove",
        role: "button",
        title: "Remove from Continue Watching",
        html: "✕",
        onclick: (e) => {
          e.stopPropagation();
          onRemove(item, node);
        },
      })
  );
  return node;
};

export const row = (title, items, opts = {}) => {
  if (!items || items.length === 0) return null;
  const scroller = el("div", { class: "row-scroller", style: { paddingLeft: 0, paddingRight: 0 } },
    items.map((item) => card(item, opts))
  );
  const section = el(
    "section",
    { class: "row" },
    el("h2", { class: "row-title", style: { paddingLeft: 0, paddingRight: 0 } }, title),
    scroller
  );
  attachRowArrows(section, scroller);
  return section;
};

// Full-bleed row (used on home where rows span the page padding themselves)
export const shelfRow = (title, items, opts = {}) => {
  if (!items || items.length === 0) return null;
  const scroller = el("div", { class: "row-scroller" }, items.map((item) => card(item, opts)));
  const section = el(
    "section",
    { class: "row" },
    el("h2", { class: "row-title" }, title),
    scroller
  );
  attachRowArrows(section, scroller);
  return section;
};

// Continue Watching cards get a remove (✕) affordance
export const continueRow = (title, items, profileId, api) => {
  const opts = {
    wide: true,
    onRemove: async (item, node) => {
      node.remove();
      try {
        // An "up next" card is synthesized from the PREVIOUS episode's finished
        // progress — its own id has no progress row, so clearProgress on it was
        // a silent no-op and the card came back on the next visit.
        if (item.upNext && item.showId) {
          await api.dismissUpNext(profileId, item.showId, item.id);
        } else {
          await api.clearProgress(profileId, item.id);
        }
      } catch {}
    },
  };
  return shelfRow(title, items, opts);
};

export const metaLine = (item) => {
  const parts = [];
  if (item.year) parts.push(String(item.year));
  if (item.type === "show") parts.push(`${item.episodeCount} episodes`);
  if (item.duration) parts.push(fmtDuration(item.duration));
  return parts;
};
