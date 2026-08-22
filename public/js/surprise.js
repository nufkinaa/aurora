// "Surprise me" — the roll itself, plus enough memory to let you re-roll from
// wherever it dropped you.
//
// The button used to live only on Browse, so a bad roll meant going back before
// you could try again. Now the pool and the page it sent you to are remembered,
// and any detail page that IS that page can offer another roll. Navigate
// anywhere else and the offer disappears, because `dest` no longer matches the
// address bar — no flag to reset, nothing to leak.
import { toast } from "./ui.js";
import { navigate } from "./router.js";
import { progressFor } from "./state.js";
import * as narrator from "./narrator.js";

let pool = null; // the candidate list the last roll came from
let dest = null; // the hash that roll navigated to

// Where a picked item lives. Stream titles go to Discover, library titles to
// their own detail page.
const hashFor = (pick, libraryType) =>
  pick.source === "stream"
    ? `#/discover/${pick.type === "show" ? "series" : "movie"}/${pick.imdbId}`
    : `#/${pick.type === "show" || libraryType === "show" ? "show" : "movie"}/${pick.id}`;

// Prefer something you haven't started; fall back to the whole pool once
// everything has been touched.
const pickFrom = (items) => {
  const fresh = items.filter((i) => {
    const p = progressFor(i.id);
    return !p || (!p.finished && p.position < 60);
  });
  const from = fresh.length ? fresh : items;
  return from[Math.floor(Math.random() * from.length)];
};

// Roll from `items`. `libraryType` is the Browse kind ("movie"/"show") used when
// an item doesn't carry its own type.
export const roll = (items, libraryType) => {
  const all = (items || []).filter(Boolean);
  if (!all.length) {
    toast("Nothing to roll for yet", "🎲");
    return false;
  }
  const pick = pickFrom(all);
  if (!pick) return false;
  toast(`The dice say: ${pick.title}`, "🎲");
  narrator.call("onSurprise");
  pool = all;
  dest = hashFor(pick, libraryType);
  // A beat, so the toast is readable before the page changes underneath it.
  const to = dest;
  setTimeout(() => navigate(to), 600);
  return true;
};

// True only on the page the last roll actually landed on.
export const landedHere = () => !!dest && location.hash === dest;

// Re-roll from the same pool. Kept separate from roll() so a detail page never
// needs to know what the pool was.
export const rollAgain = () => {
  if (!pool) return false;
  return roll(pool, null);
};
