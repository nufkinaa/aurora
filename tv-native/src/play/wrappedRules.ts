// Aurora Wrapped's words and rules, PURE: what the story says and which
// chapters it has, from the server's answer (GET /api/profiles/:id/wrapped).
// A port of the website's public/js/wrappedrules.js, sentence for sentence and
// rule for rule (the tests in __tests__/logic/play-wrapped.test.ts hold the
// two to the same answers). The TV's screen is screens/Wrapped.tsx.
//
// Kids profiles: the same story, the same types, kinder verdicts and no roasts
// — "The highlights" instead of "The intervention".

export type WrappedStats = {
  empty?: boolean;
  since?: string | number | null;
  totalSec?: number;
  plays?: number;
  activeDays?: number;
  distinctTitles?: number;
  started?: number;
  finished?: number;
  bestStreak?: number;
  streak?: {from: string; to: string} | null;
  nights?: [number, number][];
  nightsFrom?: string | null;
  byHour?: number[];
  byWeekday?: number[];
  byDevice?: {name: string; sec: number}[];
  topTitles?: {name: string; sec: number; id?: string; poster?: string | null; kind?: string}[];
  topGenres?: {name: string; sec: number}[];
  biggestDay?: {day: string; sec: number} | null;
  longestSession?: {watchedSec: number; title?: string} | null;
  lateNightSessions?: number;
  latestFinish?: {title: string; hour: number} | null;
  roasts?: unknown;
};

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const fmtH = (sec: number) => {
  const h = sec / 3600;
  return h >= 10 ? Math.round(h) + ' hours' : h >= 1 ? h.toFixed(1) + ' hours' : Math.round(sec / 60) + ' minutes';
};

// 3:41 — hours and minutes of a sitting
export const clock = (sec: number) => {
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

export const hourLabel = (h: number) => (h === 0 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h} am` : `${h - 12} pm`);

const sum = (a: (number | null | undefined)[] | null | undefined) => (a || []).reduce<number>((n, v) => n + (v || 0), 0);
export const share = (part: number | undefined, whole: number | undefined) =>
  (whole || 0) > 0 ? (part || 0) / (whole as number) : 0;
const pct = (x: number) => Math.round(x * 100);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const fmtNum = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// The big number of the Hours chapter, and what it feels like.
export const hoursFelt = (sec: number) => {
  const h = sec / 3600;
  const value = h >= 10 ? fmtNum(Math.round(h)) : h >= 1 ? h.toFixed(1) : String(Math.max(1, Math.round(sec / 60)));
  const unit = h >= 10 ? 'hours' : h >= 1 ? (value === '1.0' ? 'hour' : 'hours') : value === '1' ? 'minute' : 'minutes';
  const lines: string[] = [];
  if (h >= 48) {
    const days = Math.floor(h / 24);
    const rest = Math.round(h - days * 24);
    lines.push(`That's ${plural(days, 'day')}${rest ? ` and ${plural(rest, 'hour')}` : ''}, back to back.`);
  }
  if (h >= 44) lines.push(`Or flying London to Sydney ${plural(Math.round(h / 22), 'time')} — without the jet lag.`);
  else if (h >= 16) lines.push(`Enough to fly London to New York ${Math.round(h / 8)} times.`);
  else if (h >= 4) lines.push(`About ${Math.round(h / 2)} feature films, credits included.`);
  else if (h >= 1) lines.push('About one feature film, credits and all.');
  else lines.push('One episode and a snack. A gentle start.');
  return {value, unit, lines};
};

export const weekendShare = (w: WrappedStats) =>
  share(sum((w.byWeekday || []).filter((_, i) => i === 0 || i >= 5)), sum(w.byWeekday));
export const lateShare = (w: WrappedStats) => share(sum((w.byHour || []).slice(0, 5)), sum(w.byHour));
// the hour most of the watching starts in, or null without the data
export const primeHour = (w: WrappedStats): number | null => {
  const b = w.byHour || [];
  if (!sum(b)) return null;
  let best = 0;
  for (let i = 1; i < 24; i++) if ((b[i] || 0) > (b[best] || 0)) best = i;
  return best;
};
// the day of the week with the most watching, or null without the data
export const primeDay = (w: WrappedStats): number | null => {
  const b = w.byWeekday || [];
  if (!sum(b)) return null;
  let best = 0;
  for (let i = 1; i < 7; i++) if ((b[i] || 0) > (b[best] || 0)) best = i;
  return best;
};
// each genre's share of the genre-attributed hours (a title in two genres
// counts in both, so these are shares of the genre total, not of all hours)
export const genreShares = (w: WrappedStats) => {
  const g = w.topGenres || [];
  const total = sum(g.map(x => x.sec));
  return g.map(x => ({name: x.name, sec: x.sec, share: share(x.sec, total)}));
};
const topShare = (w: WrappedStats) => (w.topTitles && w.topTitles[0] ? share(w.topTitles[0].sec, w.totalSec) : 0);
const mobileShare = (w: WrappedStats) => {
  const d = w.byDevice || [];
  const m = d.find(x => x.name === 'Mobile');
  return m ? share(m.sec, sum(d.map(x => x.sec))) : 0;
};

// ---------- the viewer type: the collectible ----------
// Each rule scores how far past its bar the stats go (1 = just there). The
// highest score wins; a tie goes to the earlier row. Fewer than three
// sittings is always The Newcomer; nothing past its bar, The Casual.
// `stars` / `lines`: the type's own constellation, in a 100 x 100 box.
type TypeRow = {
  id: string;
  name: string;
  hue: number;
  score?: (w: WrappedStats) => number;
  because: (w: WrappedStats) => string;
  verdict: string;
  kids: string;
  stars: [number, number][];
  lines: [number, number][];
};

const TYPES: TypeRow[] = [
  {
    id: 'night-owl',
    name: 'The Night Owl',
    hue: 265,
    score: w => Math.max((w.lateNightSessions || 0) / 5, lateShare(w) / 0.2),
    because: w => `${plural(w.lateNightSessions || 0, 'sitting')} after midnight`,
    verdict: 'Your bedtime is a rumour. The moon thinks you work together.',
    kids: 'You love a late adventure — the stars stay up with you.',
    stars: [[18, 30], [34, 20], [50, 30], [66, 20], [82, 30], [50, 52], [40, 76], [60, 76]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5], [5, 6], [5, 7]],
  },
  {
    id: 'marathoner',
    name: 'The Marathoner',
    hue: 18,
    score: w =>
      Math.max(
        ((w.biggestDay && w.biggestDay.sec) || 0) / (5 * 3600),
        ((w.longestSession && w.longestSession.watchedSec) || 0) / (3 * 3600),
      ),
    because: w => (w.biggestDay ? `${fmtH(w.biggestDay.sec)} in one day` : ''),
    verdict: 'Breaks are for people with less ambition.',
    kids: 'When a story grabs you, you go all the way!',
    stars: [[12, 78], [28, 62], [42, 66], [56, 46], [70, 50], [84, 24], [90, 14]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]],
  },
  {
    id: 'loyalist',
    name: 'The Loyalist',
    hue: 330,
    score: w => topShare(w) / 0.4,
    because: w => (w.topTitles && w.topTitles[0] ? `${pct(topShare(w))}% of your hours on one title` : ''),
    verdict: 'You found your show and you are not leaving. Ever.',
    kids: 'You know what you love, and you stick with it.',
    stars: [[50, 14], [30, 34], [70, 34], [24, 60], [76, 60], [50, 86]],
    lines: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [4, 5]],
  },
  {
    id: 'creature',
    name: 'The Creature of Habit',
    hue: 160,
    score: w => (w.bestStreak || 0) / 9,
    because: w => `${plural(w.bestStreak || 0, 'night')} in a row`,
    verdict: 'Same time, same couch, same you. The couch wants partial custody.',
    kids: 'Every night, like clockwork — a real star-keeper.',
    stars: [[14, 50], [30, 36], [46, 50], [62, 36], [78, 50], [90, 38]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]],
  },
  {
    id: 'finisher',
    name: 'The Finisher',
    hue: 45,
    score: w => ((w.finished || 0) >= 3 ? share(w.finished, (w.finished || 0) + (w.started || 0)) / 0.6 : 0),
    because: w => `${plural(w.finished || 0, 'title')} finished`,
    verdict: 'You actually finish things. Suspicious, but impressive.',
    kids: 'You finish what you start. Superstar!',
    stars: [[16, 54], [36, 74], [84, 22], [60, 46]],
    lines: [[0, 1], [1, 3], [3, 2]],
  },
  {
    id: 'sampler',
    name: 'The Sampler',
    hue: 195,
    score: w =>
      (w.distinctTitles || 0) >= 8 && (w.plays || 0) >= 10 ? share(w.distinctTitles, w.plays) / 0.35 : 0,
    because: w => `${plural(w.distinctTitles || 0, 'title')} tried`,
    verdict: 'Three episodes and a vibe. Next!',
    kids: 'So many stories to try — a true explorer.',
    stars: [[20, 24], [80, 22], [50, 50], [22, 78], [78, 80], [50, 14]],
    lines: [[0, 2], [1, 2], [3, 2], [4, 2], [5, 2]],
  },
  {
    id: 'explorer',
    name: 'The Genre Hopper',
    hue: 120,
    score: w => {
      const g = genreShares(w);
      return g.length >= 4 && g[0].share > 0 ? 0.3 / g[0].share : 0;
    },
    because: w => `${plural((w.topGenres || []).length, 'genre')}, no favourite`,
    verdict: 'No genre can hold you. Your taste has a passport.',
    kids: 'Funny, scary, magical — you like it all!',
    stars: [[50, 10], [84, 36], [70, 82], [30, 82], [16, 36], [50, 50]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]],
  },
  {
    id: 'weekender',
    name: 'The Weekend Warrior',
    hue: 290,
    score: w => weekendShare(w) / 0.62,
    because: w => `${pct(weekendShare(w))}% on Friday to Sunday`,
    verdict: "Monday to Thursday you're a citizen. Friday, a legend.",
    kids: 'Weekends are for stories, and you know it.',
    stars: [[20, 70], [35, 30], [50, 62], [65, 30], [80, 70]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'pocket',
    name: 'The Pocket Watcher',
    hue: 210,
    score: w => mobileShare(w) / 0.6,
    because: w => `${pct(mobileShare(w))}% on a phone`,
    verdict: "There's a big TV in the house and you chose a phone. Iconic.",
    kids: 'Stories on the go — small screen, big imagination.',
    stars: [[36, 16], [64, 16], [64, 84], [36, 84], [50, 72]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 0]],
  },
];
const NEWCOMER: TypeRow = {
  id: 'newcomer',
  name: 'The Newcomer',
  hue: 175,
  because: w => plural(w.plays || 0, 'sitting'),
  verdict: 'Every legend starts with a pilot episode.',
  kids: 'Your very first stars! Lots more sky to light up.',
  stars: [[50, 50], [70, 30]],
  lines: [[0, 1]],
};
const CASUAL: TypeRow = {
  id: 'casual',
  name: 'The Casual',
  hue: 230,
  because: w => plural(w.activeDays || 0, 'night'),
  verdict: 'A little here, a little there. Very healthy. Slightly boring.',
  kids: 'Just the right amount of stories. Nice balance!',
  stars: [[22, 60], [44, 40], [66, 58], [84, 36]],
  lines: [[0, 1], [1, 2], [2, 3]],
};
export const TYPE_IDS = [...TYPES.map(t => t.id), NEWCOMER.id, CASUAL.id];

export type ViewerType = {
  id: string;
  no: number;
  name: string;
  hue: number;
  verdict: string;
  because: string;
  stars: [number, number][];
  lines: [number, number][];
};

export const viewerType = (w: WrappedStats, {kids = false}: {kids?: boolean} = {}): ViewerType => {
  let pick: TypeRow | null = null;
  if ((w.plays || 0) < 3) pick = NEWCOMER;
  else {
    let best = 1 - 1e-9;
    for (const t of TYPES) {
      const s = (t.score && t.score(w)) || 0;
      if (s > best + 1e-9) {
        best = s;
        pick = t;
      }
    }
    if (!pick) pick = CASUAL;
  }
  const no = TYPE_IDS.indexOf(pick.id) + 1;
  return {
    id: pick.id,
    no,
    name: pick.name,
    hue: pick.hue,
    verdict: kids ? pick.kids : pick.verdict,
    because: pick.because(w),
    stars: pick.stars,
    lines: pick.lines,
  };
};

// ---------- the intervention ----------
const dayName = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString([], {month: 'long', day: 'numeric'});
  } catch {
    return iso;
  }
};

// The roast engine: rules over the stats, worst behavior first. Playful and
// insulting BY REQUEST — this is elia's household, they can take it. (The
// words are the website's and the phone app's too.)
export const roastsFor = (w: WrappedStats, name: string): string[] => {
  const out: string[] = [];
  const ts = topShare(w);
  const started = w.started || 0;
  const finished = w.finished || 0;

  if (started >= 5 && finished > 0 && started > finished * 2) {
    out.push(`You've started ${started} things and finished ${finished}. Commitment issues, but make it streaming.`);
  } else if (started >= 8 && w.finished === 0) {
    out.push(`${started} titles started. Zero finished. Bold strategy.`);
  }
  if (w.latestFinish && w.latestFinish.hour >= 1 && w.latestFinish.hour <= 5) {
    out.push(`You once finished “${w.latestFinish.title}” at ${w.latestFinish.hour}am. The sunrise saw everything.`);
  }
  if ((w.lateNightSessions || 0) >= 5) {
    out.push(`${w.lateNightSessions} sessions started after midnight. You and 3am are basically in a relationship.`);
  }
  if (w.biggestDay && w.biggestDay.sec >= 4 * 3600) {
    out.push(`On ${dayName(w.biggestDay.day)} you watched ${fmtH(w.biggestDay.sec)}. The sun called — you let it go to voicemail.`);
  }
  if ((w.bestStreak || 0) >= 7) {
    out.push(`${w.bestStreak} days in a row. The couch has permanently taken your shape.`);
  }
  if (ts > 0.4 && w.topTitles && w.topTitles[0]) {
    out.push(`“${w.topTitles[0].name}” is ${Math.round(ts * 100)}% of everything you've watched. It's not a phase, mom.`);
  }
  if (w.byDevice && w.byDevice[0] && w.byDevice[0].name === 'Mobile' && w.byDevice.length > 1) {
    out.push(`Mostly watched on your phone. There's a beautiful big TV right there, ${name}. It misses you.`);
  }
  if ((w.distinctTitles ?? Infinity) <= 3 && (w.plays || 0) >= 10) {
    out.push(`${w.plays} sessions across ${w.distinctTitles} titles. Variety is overrated anyway.`);
  }
  if (!out.length) {
    out.push(`Honestly? Nothing to roast. Balanced viewing, reasonable hours. Who ARE you, ${name}?`);
  }
  return out.slice(0, 4);
};

// A kids profile's "highlights": the same stats, said kindly.
export const kindWordsFor = (w: WrappedStats, name: string): string[] => {
  const out: string[] = [];
  if (w.topTitles && w.topTitles[0]) out.push(`Your favourite was “${w.topTitles[0].name}”. Great pick, ${name}!`);
  if ((w.bestStreak || 0) >= 3) out.push(`${w.bestStreak} days in a row — that's a real streak!`);
  if ((w.activeDays || 0) >= 2) out.push(`You lit up ${w.activeDays} nights of stories.`);
  if ((w.distinctTitles || 0) >= 3) out.push(`${w.distinctTitles} different stories explored. What an adventurer.`);
  if ((w.finished || 0) >= 1) out.push(`${plural(w.finished || 0, 'story', 'stories')} watched all the way to the end.`);
  if (!out.length) out.push(`Your sky is just getting started, ${name}. Every show you watch adds a star!`);
  return out.slice(0, 4);
};

// The intervention's lines. The server's `roasts` (up to four ready strings,
// chosen per visit) are used as sent — order kept, only the empty ones
// dropped and the layout's four kept; an older server sends none and the
// rules above speak instead. Never roasts to a kids profile.
export const interventionFor = (w: WrappedStats, name: string, {kids = false}: {kids?: boolean} = {}): string[] => {
  if (kids) return kindWordsFor(w, name);
  const sent = Array.isArray(w.roasts)
    ? (w.roasts as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim())
    : [];
  return sent.length ? sent.slice(0, 4) : roastsFor(w, name);
};

// ---------- the chapters ----------
// In order; a chapter whose data is missing (an older server, a tiny year)
// is left out. "type", "roasts" and "finale" are always there.
export type Chapter =
  | 'opening'
  | 'hours'
  | 'top'
  | 'podium'
  | 'genres'
  | 'night'
  | 'streak'
  | 'longest'
  | 'type'
  | 'roasts'
  | 'finale';

export const chaptersFor = (w: WrappedStats): Chapter[] => {
  const list: Chapter[] = ['opening', 'hours'];
  if (w.topTitles && w.topTitles[0]) list.push('top');
  if (w.topTitles && w.topTitles.length >= 3) list.push('podium');
  if (w.topGenres && w.topGenres.length >= 2) list.push('genres');
  if ((w.plays || 0) >= 3 && Array.isArray(w.byHour) && Array.isArray(w.byWeekday) && sum(w.byHour) > 0) list.push('night');
  if ((w.bestStreak || 0) >= 2 && Array.isArray(w.nights) && w.nights.length >= 2 && w.streak) list.push('streak');
  if ((w.plays || 0) >= 2 && w.longestSession && w.longestSession.watchedSec >= 20 * 60) list.push('longest');
  list.push('type', 'roasts', 'finale');
  return list;
};

// ---------- the sky of nights ----------
// Every night watched is a star on a calendar: one column a week (`wide`),
// or one row a week (a tall screen), the day of the week across the other
// way — shaken a little so it reads as a sky, not a table. The best
// streak's nights then rise out of the calendar into a constellation of
// their own: `con`, at most CON_MAX stars (a longer streak is sampled
// evenly), strung along a wandering line across the sky. Positions are 0..1
// of the sky's box.
export const CON_MAX = 24;
const jitter = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
export type SkyLayout = {
  stars: {x: number; y: number; m: number; streak: boolean}[];
  path: number[];
  con: {i: number; x: number; y: number}[];
  brightest: number | null;
  weeks: number;
};
const noon = (iso: string) => new Date(`${iso}T12:00:00`);
export const skyLayout = (w: WrappedStats, wide = true): SkyLayout => {
  const nights = w.nights || [];
  if (!nights.length || !w.nightsFrom) return {stars: [], path: [], con: [], brightest: null, weeks: 0};
  const from = noon(w.nightsFrom);
  const dow0 = isNaN(from.getTime()) ? 0 : from.getDay();
  const span = nights[nights.length - 1][0] + dow0;
  const weeks = Math.floor(span / 7) + 1;
  const streakFrom = w.streak ? Math.round((noon(w.streak.from).getTime() - from.getTime()) / 86400000) : -1;
  const streakTo = w.streak ? Math.round((noon(w.streak.to).getTime() - from.getTime()) / 86400000) : -2;
  const stars: SkyLayout['stars'] = [];
  const path: number[] = [];
  nights.forEach(([d, m], i) => {
    const cell = d + dow0;
    const week = Math.floor(cell / 7);
    const dow = cell % 7;
    const a = (week + 0.5) / weeks + (jitter(d) - 0.5) * (0.55 / weeks);
    const b = (dow + 0.5) / 7 + (jitter(d + 999) - 0.5) * 0.07;
    const inStreak = d >= streakFrom && d <= streakTo;
    stars.push({x: wide ? a : b, y: wide ? b : a, m, streak: inStreak});
    if (inStreak) path.push(i);
  });
  // the constellation
  const L = path.length;
  const M = Math.min(L, CON_MAX);
  const con: SkyLayout['con'] = [];
  for (let k = 0; k < M; k++) {
    const i = path[M === 1 ? 0 : Math.round((k * (L - 1)) / (M - 1))];
    const t = M === 1 ? 0.5 : k / (M - 1);
    // uneven steps and a wandering line: a constellation, not a chart
    const along =
      0.1 +
      0.8 * Math.max(0, Math.min(1, t + (M > 2 && k > 0 && k < M - 1 ? (jitter(k + 5) - 0.5) * (0.7 / (M - 1)) : 0)));
    const across = Math.max(
      0.16,
      Math.min(0.84, 0.5 + 0.22 * Math.sin(k * 1.15 + 0.7) + 0.1 * Math.sin(k * 2.7 + 1.3) + (jitter(k + 17) - 0.5) * 0.18),
    );
    con.push({i, x: wide ? along : across, y: wide ? across : along});
  }
  let brightest: number | null = null;
  con.forEach((c, k) => {
    if (brightest == null || stars[c.i].m > stars[con[brightest].i].m) brightest = k;
  });
  return {stars, path, con, brightest, weeks};
};
