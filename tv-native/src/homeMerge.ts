// Fresh Home data, merged in without moving what the viewer is looking at.
//
// A LINE-FOR-LINE PORT of the website's public/js/homeMerge.js — the rule,
// the natural moments and the reasons are written out there. Both are held
// to the same cases (test/home-merge-cases.json: the website's test and
// __tests__/logic/home-merge.test.ts run every one of them and must agree).
// Change one, change the other.
//
// In short: shelves from the top down to the last one on screen keep their
// places; on screen a shelf's cards up to the last visible one keep their
// places and titles (data updates in place); the focused card never moves;
// the billboard keeps its slide; everything else takes the new answer. The
// held parts catch up at the natural moments — "quiet" (the view settled
// somewhere new), "idle" (nothing pressed for a few seconds: on-screen
// shelves update slot by slot), "away" (Home is not being looked at).
//
// Pure. Items it did not change come back as THE SAME OBJECTS (and the whole
// answer when nothing changed), so React.memo(Row) / React.memo(Card) hold.

export type MergeItem = {id?: string; imdbId?: string; title?: string} & Record<string, unknown>;
export type MergeRow<T extends MergeItem = MergeItem> = {id: string; title?: string; items: T[]} & Record<string, unknown>;
export type MergeHome<T extends MergeItem = MergeItem> = {hero: T[]; rows: MergeRow<T>[]} & Record<string, unknown>;

export type Look = {
  /** The shelves on screen, each with the card range [from, to) on screen. */
  rows?: {id: string; from: number; to: number}[];
  /** How many shelves from the top lie (wholly or partly) above the viewport. */
  above?: number;
  focus?: {rowId: string; key: string; index: number} | null;
  heroVisible?: boolean;
  heroIndex?: number;
};
export type Mode = 'quiet' | 'idle' | 'away';
export type Locks = {
  keepRows: number;
  cards: Record<string, {keep: number; floor: number}>;
  focus: {rowId: string; key: string; index: number} | null;
  hero: {hold: boolean; index: number};
  holdHeads: string[];
};

/** A title's identity on Home (Row.tsx pinKey, the site's rowSig). */
export const itemKey = (it: MergeItem | null | undefined): string => (it && (it.id || it.imdbId || it.title)) || '';

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/** Two copies of one card with nothing to tell apart. */
export const sameItem = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a as object);
  if (ka.length !== Object.keys(b as object).length) return false;
  for (const k of ka) if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
};

// The new copy of a card, or the old object when nothing in it changed.
const settle = <T,>(old: T, fresh: T): T => (sameItem(old, fresh) ? old : fresh);

const byKey = <T extends MergeItem>(items: T[] | null | undefined): Map<string, T> => {
  const m = new Map<string, T>();
  for (const it of items || []) {
    const k = itemKey(it);
    if (k && !m.has(k)) m.set(k, it);
  }
  return m;
};

const sameList = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * One shelf's cards.
 *   lock.keep   cards [0, keep) of `shown` keep their places (rule 2)
 *   lock.floor  the shelf is at least this long (held cards fill it) — "idle"
 *   lock.pin    {key, index}: this card stays at `index` (rule 3)
 */
export function mergeItems<T extends MergeItem>(
  shownIn: T[] | null | undefined,
  freshIn: T[] | null | undefined,
  lock: {keep?: number; floor?: number; pin?: {key: string; index: number} | null} = {},
): {items: T[]; held: number} {
  const shown = shownIn || [];
  const fresh = freshIn || [];
  const keep = Math.max(0, Math.min(lock.keep || 0, shown.length));
  const freshBy = byKey(fresh);
  const shownBy = byKey(shown);
  const out: T[] = [];
  const used = new Set<string>();
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
  const fill = (upTo: number, except: string) => {
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
  fill(Math.min(lock.floor || 0, shown.length), (pin && pin.key) || '');
  if (pin && pin.key) {
    const at = out.findIndex(it => itemKey(it) === pin.key);
    const want = Math.max(0, pin.index || 0);
    let card: T | null = null;
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
  return {items: sameList(out, shown) ? shown : out, held};
}

const sameRowHead = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ka = Object.keys(a).filter(k => k !== 'items');
  const kb = Object.keys(b).filter(k => k !== 'items');
  return ka.length === kb.length && ka.every(k => sameValue(a[k], b[k]));
};

/** What the locks are for one of the natural moments (homeMerge.js says what each means). */
export function locksFor(mode: Mode, look: Look = {}, rows: {id: string}[] = []): Locks {
  const indexOf = new Map(rows.map((r, i) => [r.id, i] as [string, number]));
  let lastVisible = -1;
  const cards: Locks['cards'] = {};
  for (const r of look.rows || []) {
    const i = indexOf.has(r.id) ? indexOf.get(r.id)! : -1;
    if (i < 0) continue;
    lastVisible = Math.max(lastVisible, i);
    if (mode === 'quiet') cards[r.id] = {keep: Math.max(0, r.to || 0), floor: 0};
    else if (mode === 'idle') cards[r.id] = {keep: 0, floor: Math.max(0, r.to || 0)};
  }
  const focus = look.focus && look.focus.key ? look.focus : null;
  const focusRow = focus && indexOf.has(focus.rowId) ? indexOf.get(focus.rowId)! : -1;
  const above = Math.max(0, look.above || 0);
  const keepRows = mode === 'away' ? Math.max(above, focusRow + 1) : Math.max(above, lastVisible + 1, focusRow + 1);
  return {
    keepRows,
    cards,
    focus,
    hero: {hold: mode !== 'away' && !!look.heroVisible, index: Math.max(0, look.heroIndex || 0)},
    holdHeads: mode === 'quiet' ? (look.rows || []).map(r => r.id) : [],
  };
}

/** Do two answers show the same thing (same order, same data)? */
export function sameHome(a: MergeHome | null | undefined, b: MergeHome | null | undefined): boolean {
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
}

/** The merge: what to show, given what is shown, the new answer and the locks. */
export function mergeHome<H extends MergeHome>(
  shown: H | null | undefined,
  fresh: H | null | undefined,
  locks: Partial<Locks> = {},
): {home: H | null | undefined; pending: boolean; held: number; heroIndex: number} {
  if (!fresh) return {home: shown, pending: false, held: 0, heroIndex: (locks.hero && locks.hero.index) || 0};
  if (!shown) return {home: fresh, pending: false, held: 0, heroIndex: 0};
  type Item = H['hero'][number];
  type Row = H['rows'][number];
  const sRows = (shown.rows || []) as Row[];
  const fRows = (fresh.rows || []) as Row[];
  const freshById = new Map<string, Row>();
  for (const r of fRows) if (r && r.id && !freshById.has(r.id)) freshById.set(r.id, r);
  const shownById = new Map<string, Row>();
  for (const r of sRows) if (r && r.id && !shownById.has(r.id)) shownById.set(r.id, r);
  const cards = locks.cards || {};
  const focus = locks.focus || null;
  const holdHeads = new Set(locks.holdHeads || []);
  const keepRows = Math.max(0, Math.min(locks.keepRows || 0, sRows.length));
  let held = 0;

  const rowFor = (s: Row, f: Row, lock: {keep: number; floor: number} | null | undefined): Row => {
    const pin = focus && focus.rowId === s.id ? {key: focus.key, index: focus.index} : null;
    const m = mergeItems(s.items, f.items, {keep: lock ? lock.keep : 0, floor: lock ? lock.floor : 0, pin});
    held += m.held;
    const head = holdHeads.has(s.id) ? s : f;
    if (m.items === s.items && sameRowHead(head, s)) return s;
    return {...head, items: m.items};
  };

  const rows: Row[] = [];
  const used = new Set<string>();
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
  const sHero = (shown.hero || []) as Item[];
  const fHero = (fresh.hero || []) as Item[];
  const hl = locks.hero || {hold: false, index: 0};
  const at = Math.max(0, Math.min(hl.index || 0, Math.max(0, sHero.length - 1)));
  let hero: Item[];
  let heroIndex = 0;
  if (!sHero.length) {
    hero = fHero;
  } else if (hl.hold) {
    const fBy = byKey(fHero);
    const next = sHero.map(h => {
      const f = fBy.get(itemKey(h));
      if (!f) held++;
      return f ? settle(h, f) : h;
    });
    hero = sameList(next, sHero) ? sHero : next;
    heroIndex = at;
  } else {
    const pinKey = itemKey(sHero[at]);
    const m = mergeItems(sHero, fHero, {pin: {key: pinKey, index: at}});
    held += m.held;
    hero = m.items;
    heroIndex = Math.max(0, hero.findIndex(h => itemKey(h) === pinKey));
  }

  const unchanged = hero === sHero && sameList(rows, sRows);
  const home = unchanged ? shown : ({...fresh, hero, rows} as H);
  return {home, pending: held > 0 || !sameHome(home, fresh), held, heroIndex};
}

/** How many things on screen moved between `before` and `after` (0 is the goal in "quiet"). */
export function visibleMoves(before: MergeHome | null | undefined, after: MergeHome | null | undefined, look: Look = {}): number {
  let moved = 0;
  const bRows = (before && before.rows) || [];
  const aRows = (after && after.rows) || [];
  for (const r of look.rows || []) {
    const bi = bRows.findIndex(x => x.id === r.id);
    const ai = aRows.findIndex(x => x.id === r.id);
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
}
