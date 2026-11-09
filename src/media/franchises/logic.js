// FRANCHISE ORDER — the rules, and nothing else (pure: no store, no network).
// service.js gathers what a person has watched and what the server holds and
// hands it here; the website, the TV and the phone show what comes back.
//
// A franchise (index.js build(), or a TMDB collection in the same shape):
//   { id, name, the, orders: { release: [entry…], story?: [entry…] } }
// An entry: { imdbId, type, title, year, date, optional }
//
// THE RULES
//   · An order the franchise does not have is its release order.
//   · Only MAIN entries are counted: "12 of 34" is the 12th main entry of 34.
//     An optional one (a series between the films, a spin-off) is listed on
//     the franchise page and has no number ("Part of Star Wars").
//   · Next in order (the end card): the first MAIN entry after this one in the
//     person's order, skipping optional ones. Not out yet → nothing (the
//     franchise "ends here" for now). Not on the server → still the answer,
//     offered without a countdown (the client shows it, never starts it).
//     A title that is not in this order at all → nothing.
//   · Continue the franchise (Home): a franchise the person is mid-way through
//     — at least one main entry watched and a later main entry not watched.
//     Its card is the first unwatched main entry after the furthest watched
//     one (gaps the person skipped earlier are theirs to keep). A franchise
//     whose card is already playing (in Continue Watching) or that has none
//     left is not shown. Most recently watched franchise first.
"use strict";

const ORDER_LABELS = { release: "Release order", story: "Story order" };

const orderName = (fr, want) => (want && fr && fr.orders && Array.isArray(fr.orders[want]) ? want : "release");
const listOf = (fr, order) => (fr && fr.orders && fr.orders[orderName(fr, order)]) || [];
const mainOf = (list) => list.filter((e) => !e.optional);
const isOut = (e, now) => !e.date || Date.parse(e.date) <= now;

// "the Marvel Cinematic Universe" / "Star Wars"
const nameIn = (fr) => `${fr.the ? "the " : ""}${fr.name}`;

const ordersOf = (fr) =>
  Object.keys(ORDER_LABELS)
    .filter((k) => fr && fr.orders && Array.isArray(fr.orders[k]))
    .map((k) => ({ id: k, label: ORDER_LABELS[k] }));

// Where a title sits: { position (1-based, null for an optional entry), total
// (main entries), optional } — or null when it is not in this franchise.
const placeOf = (fr, imdbId, order) => {
  const list = listOf(fr, order);
  const e = list.find((x) => x.imdbId === imdbId);
  if (!e) return null;
  const main = mainOf(list);
  const i = main.findIndex((x) => x.imdbId === imdbId);
  return { position: i >= 0 ? i + 1 : null, total: main.length, optional: !!e.optional };
};

// The title page's line: "Part of the Marvel Cinematic Universe · 12 of 34".
const lineFor = (fr, imdbId, order) => {
  const p = placeOf(fr, imdbId, order);
  if (!p) return null;
  return {
    id: fr.id,
    name: fr.name,
    the: !!fr.the,
    order: orderName(fr, order),
    position: p.position,
    total: p.total,
    optional: p.optional,
    line: `Part of ${nameIn(fr)}${p.position ? ` · ${p.position} of ${p.total}` : ""}`,
    action: "Watch in order",
  };
};

// The entry after this one: { entry, position, total } | null (rules above).
const nextAfter = (fr, imdbId, order, now = Date.now()) => {
  const list = listOf(fr, order);
  const i = list.findIndex((x) => x.imdbId === imdbId);
  if (i < 0) return null;
  const main = mainOf(list);
  for (let j = i + 1; j < list.length; j++) {
    const e = list[j];
    if (e.optional) continue;
    if (!isOut(e, now)) return null;
    return { entry: e, position: main.indexOf(e) + 1, total: main.length };
  }
  return null;
};

// The end card's heading: "Next in the Marvel Cinematic Universe".
const nextKicker = (fr) => `Next in ${nameIn(fr)}`;

// stateOf(entry) → "watched" | "started" | null; lastAt(entry) → ms or 0.
// → { entry, position, total, at } | null
const continueFor = (fr, order, { stateOf, lastAt = () => 0, now = Date.now() }) => {
  const list = listOf(fr, order);
  const main = mainOf(list);
  let far = -1;
  let at = 0;
  main.forEach((e, i) => {
    if (stateOf(e) === "watched") {
      far = i;
      at = Math.max(at, lastAt(e) || 0);
    }
  });
  if (far < 0) return null;
  for (let j = far + 1; j < main.length; j++) {
    const e = main[j];
    if (!isOut(e, now)) return null;
    const s = stateOf(e);
    if (s === "watched") continue; // (cannot happen past the furthest, kept for clarity)
    if (s === "started") return null; // it is in Continue Watching already
    return { entry: e, position: j + 1, total: main.length, at };
  }
  return null;
};

// "34 films · 9 on the server · 12 watched" — the franchise page's summary,
// counted over the MAIN entries of the franchise.
const summaryOf = (fr, { onServer, stateOf }) => {
  const main = mainOf(listOf(fr, "release"));
  const films = main.every((e) => e.type === "movie");
  const kind = films ? (main.length === 1 ? "film" : "films") : main.length === 1 ? "title" : "titles";
  const have = main.filter((e) => onServer(e)).length;
  const seen = main.filter((e) => stateOf(e) === "watched").length;
  const optional = listOf(fr, "release").length - main.length;
  return [
    `${main.length} ${kind}`,
    optional ? `${optional} optional` : null,
    `${have} on the server`,
    seen ? `${seen} watched` : null,
  ].filter(Boolean).join(" · ");
};

module.exports = { ORDER_LABELS, orderName, listOf, mainOf, ordersOf, placeOf, lineFor, nextAfter, nextKicker, continueFor, summaryOf, nameIn, isOut };
