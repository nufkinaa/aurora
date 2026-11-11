// Aurora Wrapped on the phone — what the story says, PURE (tested in
// __tests__/logic/phone-play-wrapped.test.ts). The words are the website's
// (public/js/screens/wrapped.js, the chapter builders and the page), the rules
// the kit's port of public/js/wrappedrules.js (../../play/wrappedRules.ts):
// nothing is decided twice. The screen is ../screens/Wrapped.tsx, the chapters
// ./WrappedChapters.tsx.
import {
  Chapter,
  chaptersFor,
  clock,
  DAYS,
  fmtH,
  genreShares,
  hourLabel,
  hoursFelt,
  interventionFor,
  primeHour,
  share,
  viewerType,
  ViewerType,
  WrappedStats,
} from '../../play/wrappedRules';

export type PhoneWrapped = WrappedStats & {
  topWeekday?: number;
  topTitles?: {name: string; sec: number; id?: string; poster?: string | null; show?: boolean}[];
};

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// the dates as the website writes them (the phone's own locale: "17 January 2026")
export const sinceText = (since: WrappedStats['since']): string => {
  if (since == null || since === '') return '';
  try {
    const d = new Date(since);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString([], {month: 'long', day: 'numeric', year: 'numeric'});
  } catch {
    return '';
  }
};
export const sinceMonth = (since: WrappedStats['since']): string => {
  if (since == null || since === '') return '';
  try {
    const d = new Date(since);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString([], {month: 'long', year: 'numeric'});
  } catch {
    return '';
  }
};
export const shortDay = (iso: string | null | undefined): string => {
  if (!iso) return '';
  try {
    const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString([], {month: 'long', day: 'numeric'});
  } catch {
    return String(iso);
  }
};
/** The day `n` days after `from` (YYYY-MM-DD). */
export const dayAfter = (from: string, n: number): string => {
  const d = new Date(`${from}T12:00:00`);
  d.setDate(d.getDate() + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** A colour per title (the drawn stand-in of a title without a picture). */
export const hashHue = (s: string): number => {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + (c.codePointAt(0) as number)) % 360;
  return h;
};

export type Ctx = {w: PhoneWrapped; name: string; kids: boolean; type: ViewerType; chapters: Chapter[]; words: string[]};
export const ctxOf = (w: PhoneWrapped, name: string, kids: boolean): Ctx => ({
  w,
  name,
  kids,
  type: viewerType(w, {kids}),
  chapters: chaptersFor(w),
  words: interventionFor(w, name, {kids}),
});

// ---------- the chapters' words ----------
export const opening = (c: Ctx) => ({
  eyebrow: 'Aurora Wrapped',
  name: `${c.name},`,
  title: 'your sky is ready.',
  line: `Every night you pressed play since ${sinceText(c.w.since)} left a star. We counted them all.`,
  chips: [plural(c.w.activeDays || 0, 'night'), plural(c.w.plays || 0, 'sitting'), plural(c.w.distinctTitles || 0, 'title')],
  hint: 'Tap to begin',
});

export const hours = (c: Ctx) => {
  const f = hoursFelt(c.w.totalSec || 0);
  return {eyebrow: c.kids ? 'Story time' : 'Time well spent (allegedly)', value: f.value, unit: `${f.unit} watched`, lines: f.lines};
};

export const top = (c: Ctx) => {
  const t = (c.w.topTitles || [])[0];
  if (!t) return null;
  const pct = Math.round(share(t.sec, c.w.totalSec) * 100);
  return {eyebrow: 'Your number one', name: t.name, hours: fmtH(t.sec), rest: ` — ${pct}% of everything you watched${t.show ? ', one episode at a time' : ''}.`};
};

/** The hand of the top title: the winner hides second from the left (the website's order). */
export const handOrder = <T,>(five: T[]): T[] => (five.length > 1 ? [five[1], five[0], ...five.slice(2)] : five.slice(0, 1));

export const podium = (c: Ctx) => {
  const t = c.w.topTitles || [];
  const place = (i: number) => ({rank: i + 1, name: t[i].name, poster: t[i].poster || null, hours: fmtH(t[i].sec)});
  return {eyebrow: 'The podium', places: t.length >= 3 ? [place(1), place(0), place(2)] : [], rest: t.slice(3, 5).map((_, i) => place(i + 3))};
};

export const genres = (c: Ctx) => {
  const g = genreShares(c.w).slice(0, 5);
  const max = g.length ? g[0].share : 1;
  return {
    eyebrow: 'Your genre DNA',
    first: g[0] ? g[0].name : '',
    second: g[1] ? g[1].name : '',
    // the race: the leader starts slow and surges; the others lead early
    bars: g.map((x, i) => {
      const f = max > 0 ? x.share / max : 0;
      return {name: x.name, f, mid: i === 0 ? f * 0.42 : Math.min(0.92, f * 1.18), pct: `${Math.round(x.share * 100)}%`};
    }),
  };
};

export const night = (c: Ctx) => {
  const prime = primeHour(c.w);
  const late = c.w.lateNightSessions || 0;
  const v = c.w.byWeekday || [];
  const best = v.indexOf(Math.max(...v));
  return {
    eyebrow: 'When you really watch',
    day: `${DAYS[c.w.topWeekday ?? best] || DAYS[0]}s, `,
    hour: prime == null ? '' : `${hourLabel(prime)}.`,
    prime,
    topDay: best,
    line: late
      ? c.kids
        ? `${late} late-night adventures. Shh — we won't tell.`
        : `${late} ${late === 1 ? 'sitting' : 'sittings'} started after midnight. We saw that.`
      : 'In bed before midnight. Mostly. Allegedly.',
  };
};

export const streak = (c: Ctx) => ({
  eyebrow: 'Your longest streak',
  count: String(c.w.bestStreak || 0),
  tail: ' nights in a row',
  line: c.w.streak ? `${shortDay(c.w.streak.from)} to ${shortDay(c.w.streak.to)}. Every star is a night you watched; these ones held hands.` : '',
});

export const longest = (c: Ctx) => {
  const s = c.w.longestSession;
  if (!s) return null;
  const h = s.watchedSec / 3600;
  const scale = Math.max(2, Math.ceil(h));
  return {
    eyebrow: 'Your longest sitting',
    clock: clock(s.watchedSec),
    unit: 'hours, in one go',
    title: s.title || '',
    fill: Math.max(0, Math.min(1, h / scale)),
    ticks: Array.from({length: scale + 1}, (_, i) => `${i}h`),
    quip: c.kids ? 'What a story marathon!' : h >= 3 ? 'Your couch would like a word.' : h >= 1.5 ? 'Respectable. Popcorn-refill-level commitment.' : 'Short and sweet. Like a good trailer.',
    poster: (c.w.topTitles || []).find(t => t.name === s.title) || null,
  };
};

export const typeWords = (c: Ctx) => ({eyebrow: 'Your viewer type', pre: 'Based on everything you watched, you are…', no: `No. ${String(c.type.no).padStart(2, '0')}`});

export const roasts = (c: Ctx) => ({
  eyebrow: c.kids ? 'The highlights' : 'The intervention',
  header: c.kids ? `Look at you go, ${c.name}!` : `We need to talk, ${c.name}.`,
  lines: c.words,
});

export const FINALE = {eyebrow: "That's a wrap", title: 'Your year in the sky, ', gold: 'in one picture.', share: 'Share', replay: 'Replay', all: 'All the numbers'};

// ---------- the clock and what a screen reader hears ----------
export type ChapterInfo = {label: string; ms: number; hold?: boolean; say: string};
export const chapterInfo = (id: Chapter, c: Ctx): ChapterInfo => {
  const w = c.w;
  switch (id) {
    case 'opening':
      return {label: 'Opening', ms: 6200, say: `${c.name}, your Aurora Wrapped. Since ${sinceText(w.since)}.`};
    case 'hours': {
      const f = hoursFelt(w.totalSec || 0);
      return {label: 'Your hours', ms: 7600, say: `${f.value} ${f.unit} watched. ${f.lines.join(' ')}`};
    }
    case 'top': {
      const t = (w.topTitles || [])[0];
      return {label: 'Your number one', ms: 8400, say: t ? `Your number one: ${t.name}, ${fmtH(t.sec)}.` : ''};
    }
    case 'podium':
      return {label: 'The podium', ms: 7800, say: `The podium: ${(w.topTitles || []).slice(0, 3).map((t, i) => `${i + 1}, ${t.name}`).join('; ')}.`};
    case 'genres':
      return {label: 'Your genre DNA', ms: 7400, say: `Your genres: ${genreShares(w).slice(0, 5).map(g => `${g.name} ${Math.round(g.share * 100)}%`).join(', ')}.`};
    case 'night': {
      const p = primeHour(w);
      return {label: 'Your night', ms: 8600, say: `Most of it on ${DAYS[w.topWeekday || 0]}s, prime time ${p == null ? '' : hourLabel(p)}.`};
    }
    case 'streak':
      return {label: 'Your streak', ms: 9400, say: w.streak ? `Your longest streak: ${w.bestStreak} nights in a row, ${shortDay(w.streak.from)} to ${shortDay(w.streak.to)}.` : ''};
    case 'longest':
      return {label: 'Your longest sitting', ms: 6800, say: w.longestSession ? `Your longest sitting: ${clock(w.longestSession.watchedSec)} of ${w.longestSession.title || ''}.` : ''};
    case 'type':
      return {label: 'Your viewer type', ms: 10500, say: `You are ${c.type.name}. ${c.type.verdict}`};
    case 'roasts':
      return {label: c.kids ? 'The highlights' : 'The intervention', ms: 1600 + c.words.length * 2700 + 1800, say: c.words.join(' ')};
    default:
      return {label: 'Your summary', ms: 0, hold: true, say: "That's a wrap. Your summary card, ready to share."};
  }
};

/** "3 of 11. Your number one: Northern Static, 45 hours." — the live region's line. */
export const announce = (c: Ctx, at: number): string => {
  const id = c.chapters[at];
  return id ? `${at + 1} of ${c.chapters.length}. ${chapterInfo(id, c).say}`.trim() : '';
};

/** Where the story goes on a tap: the left third goes back, the rest goes on. */
export const tapStep = (x: number, width: number): -1 | 1 => (x < width / 3 ? -1 : 1);
/** A swipe: left = on, right = back, down = close; null = not a swipe. */
export const swipeOf = (dx: number, dy: number): 'next' | 'back' | 'close' | null => {
  if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.3) return 'close';
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) return dx < 0 ? 'next' : 'back';
  return null;
};

// ---------- the page (All the numbers), the teaser, the share ----------
export const page = (c: Ctx) => {
  const w = c.w;
  const f = hoursFelt(w.totalSec || 0);
  const p = primeHour(w);
  return {
    eyebrow: 'Aurora Wrapped',
    title: 'All the numbers',
    lede: ` · since ${sinceText(w.since)} · ${plural(w.plays || 0, 'sitting')} over ${plural(w.activeDays || 0, 'night')}`,
    play: 'Play the story',
    share: 'Share the picture',
    hours: {head: 'Time watched', value: f.value, unit: `${f.unit} watched`, lines: f.lines, chips: [plural(w.plays || 0, 'sitting'), plural(w.activeDays || 0, 'night'), plural(w.distinctTitles || 0, 'title')]},
    type: {head: 'Your viewer type'},
    top: {head: 'Your top five', rows: (w.topTitles || []).slice(0, 5).map((t, i) => ({rank: i + 1, name: t.name, poster: t.poster || null, hours: fmtH(t.sec)}))},
    genres: {head: 'Your genre DNA'},
    night:
      Array.isArray(w.byHour) && w.byHour.some(Boolean)
        ? {head: 'When you really watch', line: `${DAYS[w.topWeekday || 0]}s, ${p == null ? '' : hourLabel(p)}`, late: `${plural(w.lateNightSessions || 0, 'sitting')} started after midnight.`}
        : {head: 'Your night', line: `${DAYS[w.topWeekday || 0]}s`, late: ''},
    streak: {
      head: 'Longest streak',
      value: String(w.bestStreak || 1),
      tail: ` ${(w.bestStreak || 1) === 1 ? 'night' : 'nights in a row'}`,
      dates: w.streak && (w.bestStreak || 0) > 1 ? `${shortDay(w.streak.from)} to ${shortDay(w.streak.to)}` : '',
      biggest: w.biggestDay ? `Biggest day: ${shortDay(w.biggestDay.day)}, ${fmtH(w.biggestDay.sec)}` : '',
    },
    longest: w.longestSession ? {head: 'Longest sitting', clock: clock(w.longestSession.watchedSec), title: `“${w.longestSession.title || ''}”`} : null,
    devices: (() => {
      const d = w.byDevice || [];
      const total = d.reduce((n, x) => n + x.sec, 0);
      return {head: 'Where you watch', rows: d.map(x => ({label: x.name === 'Mobile' ? 'Phone' : x.name === '?' ? 'Somewhere' : x.name, share: share(x.sec, total), pct: `${Math.round(share(x.sec, total) * 100)}%`}))};
    })(),
    roasts: {head: c.kids ? 'The highlights' : 'The intervention', lines: c.words},
    browse: 'Back to browsing',
  };
};

export const TEASER = {
  eyebrow: 'Aurora Wrapped',
  title: 'Your sky is still dark, ',
  line: "Every night you watch lights a star. Watch a few things and we'll draw your constellation, count your hours — and tell you exactly what kind of viewer you are. Politely or not.",
  locked: ['Your hours', 'Your number one', 'Your genre DNA', 'Your streak', 'Your viewer type', 'The intervention'],
  lockedLabel: 'Chapters waiting for you',
  browse: 'Find something to watch',
};

export const ERR = {text: "Couldn't load your stats.", retry: 'Try again'};

/** The share sheet's words (the website's shareCard). */
export const shareWords = (c: Ctx) => ({
  title: 'My Aurora Wrapped',
  text: `My Aurora Wrapped: ${fmtH(c.w.totalSec || 0)}, and I'm ${c.type.name}.`,
  file: `aurora-wrapped-${c.name.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase() || 'me'}.png`,
});

/** The share card's three tiles (the website's paintShareCard). */
export const shareTiles = (c: Ctx): [string, string][] => {
  const w = c.w;
  const genre = w.topGenres && w.topGenres[0] ? w.topGenres[0].name : null;
  const best = w.bestStreak || 1;
  return [genre ? ['TOP GENRE', genre] : ['TITLES', String(w.distinctTitles || 0)], ['BEST STREAK', `${best} ${best === 1 ? 'night' : 'nights'}`], ['YOUR NIGHT', DAYS[w.topWeekday || 0] || '–']];
};

/** Lines of `text` that fit `max` units wide, at most `lines` (the last one cut with …), by an
 *  estimate of each character's width (no canvas to measure with): wide letters count more. */
export const wrapEstimate = (text: string, max: number, size: number, lines = 2, bold = true): string[] => {
  const wOf = (s: string) => {
    let n = 0;
    for (const ch of s) n += /[MW@]/.test(ch) ? 0.92 : /[A-Z0-9&%]/.test(ch) ? 0.68 : /[iljtf.,'’!|:;]/.test(ch) ? 0.3 : ch === ' ' ? 0.28 : /[֐-׿]/.test(ch) ? 0.56 : 0.56;
    return n * size * (bold ? 1.04 : 0.98);
  };
  const words = String(text).split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (wOf(next) <= max || !cur) cur = next;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  if (out.length <= lines) return out;
  const kept = out.slice(0, lines);
  let last = kept[lines - 1];
  while (last.length > 1 && wOf(`${last}…`) > max) last = last.slice(0, -1).trimEnd();
  kept[lines - 1] = `${last}…`;
  return kept;
};

/** A size that fits `text` on one line in `max`, between `big` and `small`. */
export const fitSize = (text: string, max: number, big: number, small: number): number => {
  for (let s = big; s > small; s -= 2) if (wrapEstimate(text, max, s, 1)[0] === text) return s;
  return small;
};

export {DAYS, fmtH, clock, hourLabel, primeHour, genreShares, hoursFelt, share};
export type {Chapter, ViewerType};
