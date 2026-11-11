// Aurora Play — what a sitting of Taste says about the person (pure). A port
// of public/js/play/tasteread.js. Only this sitting's answers are read: it is
// a remark, not the recommender.
export type TasteAnswer = {verdict: string; genres?: string[] | null};
export type GenreCount = {genre: string; n: number};
export type TasteRead = {
  love: number;
  nope: number;
  skip: number;
  liked: GenreCount[];
  less: GenreCount[];
  top: GenreCount | null;
};

const byCount = (a: GenreCount, b: GenreCount) => b.n - a.n || a.genre.localeCompare(b.genre);

// liked: genres loved more often than refused, most loved first;
// less: genres refused twice or more and never loved.
export const readTaste = (answers: (TasteAnswer | null | undefined)[] | null | undefined): TasteRead => {
  const love = new Map<string, number>();
  const nope = new Map<string, number>();
  const n: {love: number; nope: number; skip: number} = {love: 0, nope: 0, skip: 0};
  for (const a of answers || []) {
    if (!a || !(a.verdict in n)) continue;
    n[a.verdict as keyof typeof n]++;
    const into = a.verdict === 'love' ? love : a.verdict === 'nope' ? nope : null;
    if (!into) continue;
    for (const g of new Set(a.genres || [])) if (g) into.set(g, (into.get(g) || 0) + 1);
  }
  const liked = [...love]
    .map(([genre, c]) => ({genre, n: c}))
    .filter(g => g.n > (nope.get(g.genre) || 0))
    .sort(byCount);
  const less = [...nope]
    .map(([genre, c]) => ({genre, n: c}))
    .filter(g => g.n >= 2 && !love.has(g.genre))
    .sort(byCount);
  return {...n, liked, less, top: liked[0] || null};
};

// The four answer counts at which a star of the meter lights (25 / 50 / 75 /
// 100 % of the round).
export const marksOf = (goal: number) =>
  [1, 2, 3, 4].map(k => Math.max(1, Math.ceil(((Number(goal) || 0) * k) / 4)));

// How many of the four are lit.
export const litAt = (answered: number, goal: number) =>
  goal > 0 ? marksOf(goal).filter(m => answered >= m).length : 0;

// The words for mark k (1..3), or "" for none.
export const milestone = (k: number, read: Partial<TasteRead> | null | undefined): string => {
  const r = read || {};
  const top = r.top;
  if (k === 1) return (r.love || 0) >= 1 ? 'First stars are lit' : 'Tough crowd — keep going';
  if (k === 2) return top && top.n >= 2 ? `A pattern is showing: ${top.genre}` : 'Halfway there';
  if (k === 3) {
    if ((r.nope || 0) >= 4 && (r.nope || 0) > 2 * (r.love || 0)) return 'Picky. Aurora likes that.';
    if (top && top.n >= 3) return `You keep loving ${top.genre}`;
    return 'Almost there';
  }
  return '';
};
