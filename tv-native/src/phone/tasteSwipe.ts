// "Swipe your taste" on the phone — what a finger on the card means, and the
// page's words. PURE (no React Native), tested (__tests__/logic/phone-taste.test.ts).
// The rules are the website's (public/js/screens/taste.js); the queue, the
// answers and Undo are the shared tasteSession.ts, not forked here.
//
//   drag right   Love           (or the ♥ button)
//   drag left    Not for me     (or the ✕ button)
//   drag up      Haven't seen   (or the ↑ button)
//
// A drag counts when it went far enough (DIST_X / DIST_Y) or was flung fast
// enough (FLING px/ms, and at least FLING_MIN px), and mostly in that
// direction; anything less springs the card back to the middle.
import type {TasteCard, Verdict} from '../tasteSession';

export const DIST_X = 110;
export const DIST_Y = 100;
export const FLING = 0.55; // px per ms (React Native's gesture vx / vy are px per ms too)
export const FLING_MIN = 30;
/** the "Haven't seen" stamp only shows while the drag is this close to straight up */
export const SKIP_STAMP_X = 60;
/** degrees of tilt per px of sideways drag */
export const TILT = 0.05;
export const LABEL: Record<Verdict, string> = {love: 'Love', nope: 'Not for me', skip: "Haven't seen"};
export const STAMP: Record<Verdict, string> = {love: 'LOVE', nope: 'NOPE', skip: "HAVEN'T SEEN"};
export const GLYPH: Record<Verdict, string> = {love: '♥', nope: '✕', skip: '↑'};

export type Drag = {dx: number; dy: number; vx?: number; vy?: number};

/** What a finished drag answers (null: back to the middle). `cancelled`: the system took the touch. */
export function swipeVerdict({dx, dy, vx = 0, vy = 0}: Drag, cancelled = false): Verdict | null {
  if (cancelled) return null;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if ((dx > DIST_X || (vx > FLING && dx > FLING_MIN)) && ax >= ay * 0.6) return 'love';
  if ((dx < -DIST_X || (vx < -FLING && dx < -FLING_MIN)) && ax >= ay * 0.6) return 'nope';
  if ((dy < -DIST_Y || (vy < -FLING && dy < -FLING_MIN)) && ay > ax) return 'skip';
  return null;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** How much of each stamp shows at this point of a drag (0..1). */
export function stampLevels(dx: number, dy: number): Record<Verdict, number> {
  return {
    love: clamp01(dx / DIST_X),
    nope: clamp01(-dx / DIST_X),
    skip: Math.abs(dx) < SKIP_STAMP_X ? clamp01(-dy / DIST_Y) : 0,
  };
}

/** Where an answered card flies to (from where the finger left it), and its tilt in degrees. */
export function flyTo(verdict: Verdict, from: {dx: number; dy: number} | null, width: number, height: number): {x: number; y: number; rotate: number} {
  const w = Math.max(width, 600);
  const dx = from ? from.dx : 0;
  const dy = from ? from.dy : 0;
  if (verdict === 'love') return {x: w, y: dy * 1.5, rotate: 24};
  if (verdict === 'nope') return {x: -w, y: dy * 1.5, rotate: -24};
  return {x: dx * 1.5, y: -Math.max(height, 700), rotate: dx * 0.03};
}

/** The card's size on a stage of w x h: 2:3, as tall as fits, never past 640 (the site's .ts-stage). */
export function cardSize(stageW: number, stageH: number): {w: number; h: number} {
  let h = Math.max(0, Math.min(stageH, 640));
  let w = (h * 2) / 3;
  if (w > stageW) {
    w = Math.max(0, stageW);
    h = (w * 3) / 2;
  }
  return {w: Math.floor(w), h: Math.floor(h)};
}

/** The line under a card's title: "2019 · Film · Drama · Crime". */
export const cardMeta = (c: Pick<TasteCard, 'year' | 'type' | 'genres'>) =>
  [c.year, c.type === 'show' ? 'Series' : 'Film', ...(c.genres || []).slice(0, 2)].filter(Boolean).join(' · ');

/** What a screen reader says for the card. */
export const cardLabel = (c: Pick<TasteCard, 'title' | 'year'>) =>
  `${c.title}${c.year ? ` (${c.year})` : ''}. Drag right: love. Left: not for me. Up: haven't seen.`;

/** The round's end, in the site's words. `dry`: the server has nothing more to ask about. */
export function endWords(answered: number, tally: Record<Verdict, number>, dry: boolean) {
  return {
    glyph: dry ? '🎬' : '✨',
    title: dry ? "That's every title we had for you" : `${answered} answers — Home is already using them`,
    tally: `♥ ${tally.love} loved · ✕ ${tally.nope} not for you · ${tally.skip} not seen`,
    keepGoing: !dry,
  };
}

// ---------- Edit list (#/taste/list): the poster grid ----------

export type TasteTitle = {id?: string; imdbId?: string; title: string; cover?: string | null; poster?: string | null; year?: number | null};
export const keyOf = (t: {imdbId?: string | null; id?: string | null}) => t.imdbId || t.id || '';

/** The Edit list's count line. */
export const lovedLine = (n: number) => (n ? `${n} loved` : 'tap everything you love');

/** What one tap saves: the title as the liked list keeps it. */
export const likedEntry = (t: TasteTitle) => ({id: t.id, imdbId: t.imdbId, title: t.title});

/** The grid, as the site builds it: the loved titles first (this is where they are seen and
 *  taken out), then the wide catalogue with a familiar library face every fifth tile, no title
 *  twice, catalogue and library tiles only with a picture; 120 at most. `catalog` and `library`
 *  come already shuffled. */
export function editPool(liked: TasteTitle[], catalog: TasteTitle[], library: TasteTitle[], max = 120): TasteTitle[] {
  const seen = new Set<string>();
  const pool: TasteTitle[] = [];
  const add = (t: TasteTitle, needPicture = true) => {
    const k = keyOf(t);
    if (!k || seen.has(k) || (needPicture && !t.cover)) return;
    seen.add(k);
    pool.push(t);
  };
  for (const t of liked) add({...t, cover: t.cover || t.poster || null}, false);
  let li = 0;
  catalog.forEach((c, i) => {
    add(c);
    if (i % 5 === 4 && li < library.length) add(library[li++]);
  });
  while (li < library.length) add(library[li++]);
  return pool.slice(0, max);
}

/** Fisher–Yates, with the random source given (tests pass their own). */
export function shuffled<T>(a: T[], rnd: () => number = Math.random): T[] {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
