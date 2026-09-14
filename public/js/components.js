// Shared UI pieces: media cards and horizontal rows.
import { el, icons, fmtDuration, toast, posterImg } from "./ui.js";
import { navigate } from "./router.js";
import { state, progressFor, ratingFor } from "./state.js";
import { api } from "./api.js";
import { attachRowArrows } from "./rowArrows.js";
import * as narrator from "./narrator.js";
import { attachPeek } from "./peek.js";
import { warmTitle } from "./prefetch.js";

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
  // A synthesized card (a party to join, a download that landed) knows where
  // it goes; nothing else about it is a library item.
  if (typeof item._open === "function") return item._open();
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
  // Both keys, on purpose: a library-backed list card may carry progress
  // under its STREAM identity (watched via Discover before the download).
  const prog =
    progressFor(item.id) ||
    (item.imdbId && state.streamProgress && state.streamProgress[item.imdbId]) ||
    null;
  const pct =
    prog && prog.duration > 0 && !prog.finished
      ? Math.min(100, (prog.position / prog.duration) * 100)
      : null;
  const isNew = item.addedAt && Date.now() - item.addedAt < NEW_WINDOW_MS && !prog;
  // Glass look only: how much is left, under the label of a card mid-way.
  const glass = document.documentElement.dataset.look === "glass";
  const left =
    glass && prog && pct !== null && prog.duration > 0
      ? `${Math.max(1, Math.round((prog.duration - prog.position) / 60))} min left`
      : null;

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
        `S${item.season} E${item.episode} · ${item.title}`,
        (item.meta || left) && el("span", { class: "card-meta" }, item.meta || left));
    }
    if (item.meta) {
      return el("div", { class: "card-label" }, item.title, el("span", { class: "card-meta" }, item.meta));
    }
    if (newEp) {
      return el("div", { class: "card-label" }, `S${newEp.season} E${newEp.episode}${behind}`);
    }
    return el("div", { class: "card-label" }, item.title);
  };
  const label = labelFor();
  const showLabel = wide || isEpisode || item.upNext || !!newEp || !!item.meta;

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
      // it and the episode — and it starts with what the label shows, so a
      // screen reader's name matches the words on the card (the tags below
      // are decoration and sit outside the name).
      "aria-label": (newEp
        ? `${item.title}, S${newEp.season} E${newEp.episode}${behind}` // reads as the label prints it
        : isEpisode
          ? `${item.showTitle ? `${item.showTitle} ` : ""}S${item.season} E${item.episode} · ${item.title}`
          : item.title) +
        // every word printed on the card, so the spoken name never disagrees
        // with what a sighted person reads off it (a11y label-content rule);
        // "stream" and "series"/"film" are also useful things to hear
        [
          item.source === "stream" && !item.badge && "stream",
          item.badge && String(item.badge.text || "").toLowerCase(),
          showKind && !isEpisode && !onRemove && (item.type === "show" ? "series" : "film"),
          isNew && "new",
          item.meta || left,
        ].filter(Boolean).map((w) => `, ${w}`).join(""),
      // the recommender's honesty: hover a recommended card and it says WHY
      ...(item.why ? { title: item.why } : {}),
      onclick: () => openItem(item),
    },
    // sized for the card (wide cards are 300px, posters 176px; the server
    // scales the artwork to about twice that for sharp screens)
    item.cover
      ? posterImg(item.cover, item.title, "card-poster", "card-fallback", { w: wide || isEpisode ? 320 : 180 })
      : el("div", { class: "card-fallback" }, item.title),
    el("div", { class: "card-shade" }),
    // The tag words are drawn by CSS from data-t (components.css) rather than
    // written into the DOM: text inside the button that isn't in its name
    // trips the label-in-name accessibility rule, and the name already says
    // "stream" / "film" in words.
    item.source === "stream" && !item.badge && el("span", { class: "card-tag stream", "aria-hidden": "true", "data-t": "STREAM" }),
    // Tonight-row state (glass look): READY · plays from disk, LIVE · a party, NEW
    item.badge && el("span", { class: `card-tag ${item.badge.tone || ""}`, "aria-hidden": "true", "data-t": item.badge.text }),
    // Series or film. Only where the row it sits in mixes the two, and never on an
    // episode (its own label already reads "S3 E2") or a card carrying the remove
    // ✕, which owns this corner.
    showKind && !isEpisode && !onRemove &&
      el("span", {
        class: `card-tag kind ${item.type === "show" ? "series" : "film"}`,
        "aria-hidden": "true",
        html:
          (item.type === "show" ? icons.series : icons.film) +
          `<span data-t="${item.type === "show" ? "SERIES" : "FILM"}"></span>`,
      }),
    isNew && el("span", { class: "card-new", "aria-hidden": "true", "data-t": "NEW" }),
    pct !== null && el("div", { class: "card-progress" }, el("div", { style: { width: pct + "%" } })),
    showLabel && label,
    onRemove && !item._noRemove &&
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
  // Hold (or right-click) for the peek sheet — synthesized cards (a party to
  // join, a download that landed) have nothing to peek at.
  if (typeof item._open !== "function") {
    attachPeek(node, item, { open: openItem, onRemove: onRemove && !item._noRemove ? (it) => onRemove(it, node) : null });
    // intent: the pointer arriving, focus landing or a finger touching down
    // warms this title's page (prefetch.js — cached, low priority, once)
    const intent = () => warmTitle(item);
    node.addEventListener("pointerenter", intent);
    node.addEventListener("focus", intent);
    node.addEventListener("pointerdown", intent, { passive: true });
  }
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
    // `opts.sub` is the quiet reason line the glass look shows beside a title
    el("h2", { class: "row-title" }, title, opts.sub && el("span", { class: "row-sub" }, opts.sub)),
    scroller
  );
  attachRowArrows(section, scroller);
  return section;
};

// Continue Watching cards get a remove (✕) affordance
export const continueRow = (title, items, profileId, api, extra = {}) => {
  const opts = {
    ...extra,
    wide: true,
    onRemove: async (item, node) => {
      // Captured BEFORE the clear so Undo can put the exact row back.
      const prev = progressFor(item.id);
      const parent = node.parentNode;
      const anchor = node.nextSibling;
      node.remove();
      try {
        // An "up next" card is synthesized from the PREVIOUS episode's finished
        // progress — its own id has no progress row, so clearProgress on it was
        // a silent no-op and the card came back on the next visit.
        if (item.upNext && item.showId) {
          await api.dismissUpNext(profileId, item.showId, item.id);
          toast("Hidden from Continue Watching", "✅");
        } else {
          await api.clearProgress(profileId, item.id);
          toast(
            "Removed from Continue Watching",
            "✅",
            prev && prev.duration
              ? {
                  label: "Undo",
                  onClick: async () => {
                    try {
                      // A stream card's clear deletes its WHOLE stored
                      // play-item (streamItems row: cover, videoUrl,
                      // transcodeBase…), not just progress — undo must send
                      // the full item back or the rebuilt card is a zombie
                      // with no id/poster/URL that can never be removed.
                      const isStream =
                        typeof item.id === "string" && item.id.startsWith("torrent|");
                      let meta;
                      if (isStream) {
                        const { progress, upNext, ...rest } = item;
                        meta = rest;
                      }
                      await api.saveProgress(profileId, item.id, prev.position, prev.duration, meta);
                      if (parent && parent.isConnected) parent.insertBefore(node, anchor && anchor.isConnected ? anchor : null);
                    } catch {
                      toast("Couldn't undo that", "⚠️");
                    }
                  },
                }
              : null,
          );
        }
      } catch {
        // The clear FAILED — a vanished card would be a lie; put it back.
        if (parent && parent.isConnected) parent.insertBefore(node, anchor && anchor.isConnected ? anchor : null);
        toast("Couldn't remove — try again", "⚠️");
      }
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
