// Aurora Play — what a sitting of Taste says about the person (pure; the
// screen is js/screens/taste.js). Only this sitting's answers are read: it is
// a remark, not the recommender.
//
//   readTaste(answers)  answers: [{ verdict: "love"|"nope"|"skip", genres }]
//       -> { love, nope, skip, liked: [{ genre, n }], less: [{ genre, n }], top }
//       liked: genres loved more often than refused, most loved first;
//       less: genres refused twice or more and never loved.
//   marksOf(goal)  -> the four answer counts at which a star of the meter
//       lights (25 / 50 / 75 / 100 % of the round).
//   litAt(answered, goal)  -> how many of the four are lit.
//   milestone(k, read)  -> the words for mark k (1..3), or "" for none.
const byCount = (a, b) => b.n - a.n || a.genre.localeCompare(b.genre);

export const readTaste = (answers) => {
  const love = new Map();
  const nope = new Map();
  const n = { love: 0, nope: 0, skip: 0 };
  for (const a of answers || []) {
    if (!a || !(a.verdict in n)) continue;
    n[a.verdict]++;
    const into = a.verdict === "love" ? love : a.verdict === "nope" ? nope : null;
    if (!into) continue;
    for (const g of new Set(a.genres || [])) if (g) into.set(g, (into.get(g) || 0) + 1);
  }
  const liked = [...love].map(([genre, c]) => ({ genre, n: c })).filter((g) => g.n > (nope.get(g.genre) || 0)).sort(byCount);
  const less = [...nope].map(([genre, c]) => ({ genre, n: c })).filter((g) => g.n >= 2 && !love.has(g.genre)).sort(byCount);
  return { ...n, liked, less, top: liked[0] || null };
};

export const marksOf = (goal) => [1, 2, 3, 4].map((k) => Math.max(1, Math.ceil(((Number(goal) || 0) * k) / 4)));

export const litAt = (answered, goal) => (goal > 0 ? marksOf(goal).filter((m) => answered >= m).length : 0);

export const milestone = (k, read) => {
  const r = read || {};
  const top = r.top;
  if (k === 1) return r.love >= 1 ? "First stars are lit" : "Tough crowd — keep going";
  if (k === 2) return top && top.n >= 2 ? `A pattern is showing: ${top.genre}` : "Halfway there";
  if (k === 3) {
    if (r.nope >= 4 && r.nope > 2 * (r.love || 0)) return "Picky. Aurora likes that.";
    if (top && top.n >= 3) return `You keep loving ${top.genre}`;
    return "Almost there";
  }
  return "";
};
