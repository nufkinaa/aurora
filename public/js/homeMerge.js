// Fresh Home data, merged in without moving what the viewer is looking at.
//
// elia, 2026-10-19: "we want fresh data but not a whole change of everything
// when the user is seeing this". Home paints at once from the last answer
// this device kept (screens/home.js; the TV's homeSnapshot.ts), and the
// server's new answer arrives a moment later — a different billboard draw, a
// re-ranked shelf, Continue Watching after a film. Swapping it in wholesale
// moved the shelves under the viewer's eyes. This file decides what may
// change NOW and what waits for a moment nobody is looking.
//
// THE RULE (the same function runs on the website and on the TV —
// tv-native/src/homeMerge.ts is a line-for-line port, and both are held to
// the cases in test/home-merge-cases.json):
//
//  1. ROWS THAT HOLD THE LAYOUT keep their place. Every shelf from the top of
//     the page down to the last one on screen (and the one focus is in) stays
//     where it is, in the same order, and none of them disappears — a shelf
//     inserted or removed above or inside the viewport would shove everything
//     below it. A shelf the new answer no longer has is HELD (drawn as it
//     was) until it is off screen. New shelves, and shelves that moved, take
//     their new places BELOW those.
//  2. ON SCREEN, A SHELF'S CARDS DO NOT MOVE. In a shelf that is on screen,
//     every card from the first one up to the last visible one keeps its
//     place and its title. A title that is still in the answer takes its new
//     data in place (Continue Watching's progress, a NEW tag, a badge — they
//     are expected to change); a title that is gone is held. The rest of the
//     shelf — past the right edge — follows the new order.
//  3. THE FOCUSED CARD keeps its place and its identity, always — also at the
//     moments below, and held there if the answer no longer has it.
//  4. THE BILLBOARD keeps the slide on show. While it is on screen its list
//     is kept as it is (each pick takes its new data in place); once it is
//     not, the new list is taken with the current pick pinned at its index.
//  5. EVERYTHING ELSE TAKES THE NEW ANSWER AS IT IS: shelves below the
//     viewport, the cards of shelves above it.
//
// The NATURAL MOMENTS, when the held parts catch up (`locksFor` modes):
//   "quiet"  fresh data while the viewer looks: rules 1–5 as written. Asked
//            again whenever the view settles somewhere new (a scroll ends,
//            focus lands on another shelf), so a shelf that has left the
//            viewport takes its new cards then.
//   "idle"   nothing touched for a few seconds: on-screen shelves update IN
//            PLACE — each slot takes the card the new order puts there
//            (screens cross-fade it), no shelf moves and none gets shorter
//            than what is on screen (held cards fill the gap until they are
//            off screen). Rules 1, 3 and 4 still hold.
//   "away"   Home is not being looked at (another screen is over it, the app
//            is in the background): only the shelves above the viewport and
//            the focused one keep their places — what is ON screen may
//            change, because nobody sees it change; the billboard takes its
//            new list (current pick pinned).
//
// Pure: no DOM, no React, no clock. A screen hands in what it shows, the new
// answer and what the viewer can see (`look`); it gets back what to show.
// Items it did not change are handed back as THE SAME OBJECTS (and the whole
// answer, when nothing changed at all), so a memoised card does not redraw
// and a shelf can be patched card by card.

/** A title's identity on Home (the TV's Row pinKey, the site's rowSig). */
export const itemKey = (it) => (it && (it.id || it.imdbId || it.title)) || "";

const sameValue = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/** Two copies of one card with nothing to tell apart. */
export const sameItem = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!sameValue(a[k], b[k])) return false;
  return true;
};

// The new copy of a card, or the old object when nothing in it changed.
const settle = (old, fresh) => (sameItem(old, fresh) ? old : fresh);

const byKey = (items) => {
  const m = new Map();
  for (const it of items || []) {
    const k = itemKey(it);
    if (k && !m.has(k)) m.set(k, it);
  }
  return m;
};

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * One shelf's cards.
 *   lock.keep   cards [0, keep) of `shown` keep their places (rule 2)
 *   lock.floor  the shelf is at least this long (held cards fill it) — "idle"
 *   lock.pin    {key, index}: this card stays at `index` (rule 3)
 * -> { items, held }  (`held`: cards drawn although the answer has dropped them)
 */
export const mergeItems = (shown, fresh, lock = {}) => {
  shown = shown || [];
  fresh = fresh || [];
  const keep = Math.max(0, Math.min(lock.keep || 0, shown.length));
  const freshBy = byKey(fresh);
  const shownBy = byKey(shown);
  const out = [];
  const used = new Set();
  let held = 0;
  for (let i = 0; i < keep; i++) {
    const old = shown[i];
    const k = itemKey(old);
    if (used.has(k)) continue;
    used.add(k);
    const f = freshBy.get(k);
    if (f) out.push(settle(old, f));
    else {
      out.push(old);
      held++;
    }
  }
  for (const f of fresh) {
    const k = itemKey(f);
    if (!k || used.has(k)) continue;
    used.add(k);
    const old = shownBy.get(k);
    out.push(old ? settle(old, f) : f);
  }
  // Cards held from what was shown, in its order, to fill a gap below.
  const placed = new Set(out.map(itemKey));
  let next = 0;
  const fill = (upTo, except) => {
    while (out.length < upTo && next < shown.length) {
      const old = shown[next++];
      const k = itemKey(old);
      if (placed.has(k) || k === except) continue;
      placed.add(k);
      out.push(old);
      held++;
    }
  };
  const pin = lock.pin;
  // idle: a shelf on screen is at least as long as what shows
  fill(Math.min(lock.floor || 0, shown.length), (pin && pin.key) || "");
  if (pin && pin.key) {
    const at = out.findIndex((it) => itemKey(it) === pin.key);
    const want = Math.max(0, pin.index || 0);
    let card = null;
    if (at < 0) {
      card = shownBy.get(pin.key) || null;
      if (card) held++;
    } else if (at !== want && want >= keep) {
      card = out.splice(at, 1)[0];
    }
    if (card) {
      // a shelf the answer shortened: held cards keep the focused one where it is
      fill(want, pin.key);
      out.splice(Math.min(want, out.length), 0, card);
    }
  }
  return { items: sameList(out, shown) ? shown : out, held };
};

const sameRowHead = (a, b) => {
  const ka = Object.keys(a).filter((k) => k !== "items");
  const kb = Object.keys(b).filter((k) => k !== "items");
  return ka.length === kb.length && ka.every((k) => sameValue(a[k], b[k]));
};

/**
 * What the locks are for one of the natural moments.
 *   mode   "quiet" | "idle" | "away"
 *   look   what the viewer can see:
 *     rows        [{ id, from, to }] the shelves on screen, each with the
 *                 card range [from, to) that is on screen
 *     above       how many shelves from the top lie (wholly or partly) above
 *                 the viewport
 *     focus       { rowId, key, index } the focused card, or null
 *     heroVisible the billboard is on screen
 *     heroIndex   the slide on show
 *   rows   the shelves as shown (to find where the visible ones stand)
 */
export const locksFor = (mode, look = {}, rows = []) => {
  const indexOf = new Map(rows.map((r, i) => [r.id, i]));
  let lastVisible = -1;
  const cards = {};
  for (const r of look.rows || []) {
    const i = indexOf.has(r.id) ? indexOf.get(r.id) : -1;
    if (i < 0) continue;
    lastVisible = Math.max(lastVisible, i);
    if (mode === "quiet") cards[r.id] = { keep: Math.max(0, r.to || 0), floor: 0 };
    else if (mode === "idle") cards[r.id] = { keep: 0, floor: Math.max(0, r.to || 0) };
  }
  const focus = look.focus && look.focus.key ? look.focus : null;
  const focusRow = focus && indexOf.has(focus.rowId) ? indexOf.get(focus.rowId) : -1;
  const above = Math.max(0, look.above || 0);
  const keepRows = mode === "away"
    ? Math.max(above, focusRow + 1)
    : Math.max(above, lastVisible + 1, focusRow + 1);
  return {
    keepRows,
    cards,
    focus,
    hero: { hold: mode !== "away" && !!look.heroVisible, index: Math.max(0, look.heroIndex || 0) },
    // the shelves on screen keep their heading and their row-level fields
    holdHeads: mode === "quiet" ? (look.rows || []).map((r) => r.id) : [],
  };
};

/** Do two answers show the same thing (same order, same data)? */
export const sameHome = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const ha = a.hero || [];
  const hb = b.hero || [];
  if (ha.length !== hb.length || ha.some((x, i) => !sameItem(x, hb[i]))) return false;
  const ra = a.rows || [];
  const rb = b.rows || [];
  if (ra.length !== rb.length) return false;
  for (let i = 0; i < ra.length; i++) {
    const x = ra[i];
    const y = rb[i];
    if (x.id !== y.id || !sameRowHead(x, y)) return false;
    const xi = x.items || [];
    const yi = y.items || [];
    if (xi.length !== yi.length || xi.some((it, j) => !sameItem(it, yi[j]))) return false;
  }
  return true;
};

/**
 * The merge.
 *   shown   the answer on screen now ({ hero, rows })
 *   fresh   the server's new answer
 *   locks   from locksFor()
 * -> { home, pending, held, heroIndex }
 *   home      what to show (=== shown when nothing changes)
 *   pending   the new answer is not all on screen yet: ask again at the
 *             next natural moment
 *   heroIndex where the slide on show stands in home.hero
 */
export const mergeHome = (shown, fresh, locks = {}) => {
  if (!fresh) return { home: shown, pending: false, held: 0, heroIndex: (locks.hero && locks.hero.index) || 0 };
  if (!shown) return { home: fresh, pending: false, held: 0, heroIndex: 0 };
  const sRows = shown.rows || [];
  const fRows = fresh.rows || [];
  const freshById = new Map();
  for (const r of fRows) if (r && r.id && !freshById.has(r.id)) freshById.set(r.id, r);
  const shownById = new Map();
  for (const r of sRows) if (r && r.id && !shownById.has(r.id)) shownById.set(r.id, r);
  const cards = locks.cards || {};
  const focus = locks.focus || null;
  const holdHeads = new Set(locks.holdHeads || []);
  const keepRows = Math.max(0, Math.min(locks.keepRows || 0, sRows.length));
  let held = 0;

  const rowFor = (s, f, lock) => {
    const pin = focus && focus.rowId === s.id ? { key: focus.key, index: focus.index } : null;
    const m = mergeItems(s.items, f.items, { keep: lock ? lock.keep : 0, floor: lock ? lock.floor : 0, pin });
    held += m.held;
    const head = holdHeads.has(s.id) ? s : f;
    if (m.items === s.items && sameRowHead(head, s)) return s;
    return { ...head, items: m.items };
  };

  const rows = [];
  const used = new Set();
  for (let i = 0; i < keepRows; i++) {
    const s = sRows[i];
    if (!s || used.has(s.id)) continue;
    used.add(s.id);
    const f = freshById.get(s.id);
    // an empty shelf draws nothing: it stays empty here, or it would grow
    // inside the part of the page that must not move
    if (!(s.items || []).length) {
      rows.push(s);
      continue;
    }
    if (!f || !(f.items || []).length) {
      rows.push(s);
      held += (s.items || []).length;
      continue;
    }
    rows.push(rowFor(s, f, cards[s.id]));
  }
  for (const f of fRows) {
    if (!f || !f.id || used.has(f.id)) continue;
    used.add(f.id);
    const s = shownById.get(f.id);
    rows.push(s ? rowFor(s, f, null) : f);
  }

  // the billboard
  const sHero = shown.hero || [];
  const fHero = fresh.hero || [];
  const hl = locks.hero || { hold: false, index: 0 };
  const at = Math.max(0, Math.min(hl.index || 0, Math.max(0, sHero.length - 1)));
  let hero;
  let heroIndex = 0;
  if (!sHero.length) {
    hero = fHero;
  } else if (hl.hold) {
    const fBy = byKey(fHero);
    const next = sHero.map((h) => {
      const f = fBy.get(itemKey(h));
      if (!f) held++;
      return f ? settle(h, f) : h;
    });
    hero = sameList(next, sHero) ? sHero : next;
    heroIndex = at;
  } else {
    const pinKey = itemKey(sHero[at]);
    const m = mergeItems(sHero, fHero, { pin: { key: pinKey, index: at } });
    held += m.held;
    hero = m.items;
    heroIndex = Math.max(0, hero.findIndex((h) => itemKey(h) === pinKey));
  }

  const unchanged = hero === sHero && sameList(rows, sRows);
  const home = unchanged ? shown : { ...fresh, hero, rows };
  return { home, pending: held > 0 || !sameHome(home, fresh), held, heroIndex };
};

/**
 * How many things on screen moved between `before` and `after` — the number
 * this whole file exists to keep at 0 in "quiet": a visible shelf that is not
 * where it was, a visible card slot that now holds another title, the
 * billboard's slide changing title.
 */
export const visibleMoves = (before, after, look = {}) => {
  let moved = 0;
  const bRows = (before && before.rows) || [];
  const aRows = (after && after.rows) || [];
  for (const r of look.rows || []) {
    const bi = bRows.findIndex((x) => x.id === r.id);
    const ai = aRows.findIndex((x) => x.id === r.id);
    if (bi < 0) continue;
    if (ai !== bi) {
      moved++;
      continue;
    }
    const bItems = bRows[bi].items || [];
    const aItems = aRows[ai].items || [];
    for (let j = Math.max(0, r.from || 0); j < Math.min(r.to || 0, bItems.length); j++) {
      if (itemKey(bItems[j]) !== itemKey(aItems[j])) moved++;
    }
  }
  if (look.heroVisible) {
    const i = Math.max(0, look.heroIndex || 0);
    const b = ((before && before.hero) || [])[i];
    const a = ((after && after.hero) || [])[i];
    if (b && itemKey(b) !== itemKey(a)) moved++;
  }
  return moved;
};
