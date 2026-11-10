// Aurora Wrapped on the TV — what each chapter says and when its pieces
// arrive. PURE: the screen (screens/Wrapped.tsx) keeps the clock, the chapters
// (./Chapters.tsx) draw; this file turns the server's answer into the words
// and numbers of the story, once, and says how long each chapter is.
//
// The words are the website's (public/js/screens/wrapped.js) and the rules
// are ../wrappedRules.ts — nothing is decided twice.
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
  primeDay,
  primeHour,
  share,
  SkyLayout,
  skyLayout,
  TYPE_IDS,
  ViewerType,
  viewerType,
  WrappedStats,
} from '../wrappedRules';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// "March 4" from a day ("2026-03-04"), or nothing when it is not a date
export const shortDay = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  return isNaN(d.getTime()) ? '' : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};
// "March 4, 2026" from the server's `since` (a time or a date)
export const longDay = (since: string | number | null | undefined): string => {
  if (since == null || since === '') return '';
  const d = new Date(since);
  return isNaN(d.getTime()) ? '' : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
};
// the day `n` days after `from`, as "March 4"
const dayAfter = (from: string | null | undefined, n: number): string => {
  if (!from) return '';
  const d = new Date(`${String(from).slice(0, 10)}T12:00:00`);
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + n);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

export type Place = {rank: number; name: string; poster: string | null; hours: string};

export type Story = {
  name: string;
  kids: boolean;
  chapters: Chapter[];
  sky: SkyLayout;
  // the first and the last night of the sky, for the line under it
  skyFrom: string;
  skyTo: string;
  opening: {title: string; line: string; chips: string[]};
  hours: {eyebrow: string; value: string; unit: string; lines: string[]};
  top: {name: string; poster: string | null; line: string} | null;
  podium: {places: Place[]; rest: Place[]} | null;
  genres: {title: string; bars: {name: string; fill: number; pct: string}[]} | null;
  night: {title: string; hours: number[]; peak: number; week: number[]; day: number | null; line: string} | null;
  streak: {title: string; line: string} | null;
  longest: {clock: string; of: string; fill: number; ticks: string[]; quip: string} | null;
  type: ViewerType;
  typeOf: number;
  roasts: {eyebrow: string; header: string; lines: string[]};
  finale: {stats: {value: string; label: string}[]};
};

const scaled = (list: number[] | undefined, n: number): number[] => {
  const a = Array.from({length: n}, (_, i) => Math.max(0, Number((list || [])[i]) || 0));
  const top = Math.max(...a, 0);
  return a.map(v => (top > 0 ? v / top : 0));
};

export const storyOf = (w: WrappedStats, rawName: string | null | undefined, kids: boolean): Story => {
  const name = String(rawName || '').trim();
  const chapters = chaptersFor(w);
  const has = (c: Chapter) => chapters.includes(c);
  const sky = skyLayout(w, true);
  const nights = w.nights || [];
  const total = w.totalSec || 0;
  const felt = hoursFelt(total);
  const since = longDay(w.since);
  const titles = w.topTitles || [];

  // ---- number one, the podium ----
  const win = titles[0];
  const winPct = win ? Math.round(share(win.sec, total) * 100) : 0;
  const place = (i: number): Place => ({rank: i + 1, name: titles[i].name, poster: titles[i].poster || null, hours: fmtH(titles[i].sec)});

  // ---- genres ----
  const g = genreShares(w).slice(0, 5);
  const gTop = Math.max(...g.map(x => x.share), 0);

  // ---- your hour ----
  const prime = primeHour(w);
  const day = primeDay(w);
  const late = w.lateNightSessions || 0;

  // ---- the longest sitting ----
  const sit = w.longestSession;
  const sitH = sit ? sit.watchedSec / 3600 : 0;
  const scale = Math.max(2, Math.ceil(sitH));
  const tickStep = Math.max(1, Math.ceil(scale / 6));
  const ticks: string[] = [];
  for (let h = 0; h <= scale; h += tickStep) ticks.push(`${h}h`);

  const type = viewerType(w, {kids});
  const lines = interventionFor(w, name || 'you', {kids}).slice(0, 4);

  return {
    name,
    kids,
    chapters,
    sky,
    skyFrom: nights.length ? dayAfter(w.nightsFrom, nights[0][0]) : '',
    skyTo: nights.length ? dayAfter(w.nightsFrom, nights[nights.length - 1][0]) : '',
    opening: {
      title: name ? `${name}, your year in Aurora` : 'Your year in Aurora',
      line: `Every night you pressed play${since ? ` since ${since}` : ''} left a star. We counted them all.`,
      chips: [plural(w.activeDays || 0, 'night'), plural(w.plays || 0, 'sitting'), plural(w.distinctTitles || 0, 'title')],
    },
    hours: {
      eyebrow: kids ? 'Story time' : 'Time well spent (allegedly)',
      value: felt.value,
      unit: `${felt.unit} watched`,
      lines: felt.lines.slice(0, 2),
    },
    top:
      has('top') && win
        ? {
            name: win.name,
            poster: win.poster || null,
            line: winPct > 0 ? `${fmtH(win.sec)} — ${winPct}% of everything you watched.` : `${fmtH(win.sec)} watched.`,
          }
        : null,
    podium: has('podium') ? {places: [0, 1, 2].map(place), rest: titles.slice(3, 5).map((_, i) => place(i + 3))} : null,
    genres:
      has('genres') && g.length >= 2
        ? {
            title: `Mostly ${g[0].name}, with a ${g[1].name} streak.`,
            bars: g.map(x => ({name: x.name, fill: gTop > 0 ? x.share / gTop : 0, pct: `${Math.round(x.share * 100)}%`})),
          }
        : null,
    night:
      has('night') && prime != null
        ? {
            title: day != null ? `${DAYS[day]}s, ${hourLabel(prime)}.` : `${cap(hourLabel(prime))} is your hour.`,
            hours: scaled(w.byHour, 24),
            peak: prime,
            week: scaled(w.byWeekday, 7),
            day,
            line: late
              ? kids
                ? `${plural(late, 'late-night adventure')}. Shh — we won't tell.`
                : `${plural(late, 'sitting')} started after midnight. We saw that.`
              : 'In bed before midnight. Mostly. Allegedly.',
          }
        : null,
    streak:
      has('streak') && w.streak
        ? {
            title: `${w.bestStreak} nights in a row`,
            line: `${shortDay(w.streak.from)} to ${shortDay(w.streak.to)}. Every star is a night you watched; these ones held hands.`,
          }
        : null,
    longest:
      has('longest') && sit
        ? {
            clock: clock(sit.watchedSec),
            of: sit.title ? `of “${sit.title}”.` : '',
            fill: Math.max(0, Math.min(1, sitH / scale)),
            ticks,
            quip: kids
              ? 'What a story marathon!'
              : sitH >= 3
                ? 'Your couch would like a word.'
                : sitH >= 1.5
                  ? 'Respectable. Popcorn-refill-level commitment.'
                  : 'Short and sweet. Like a good trailer.',
          }
        : null,
    type,
    typeOf: TYPE_IDS.length,
    roasts: {
      eyebrow: kids ? 'The highlights' : 'The intervention',
      header: kids ? (name ? `Look at you go, ${name}!` : 'Look at you go!') : name ? `We need to talk, ${name}.` : 'We need to talk.',
      lines,
    },
    finale: {
      stats: [
        {value: felt.value, label: felt.unit},
        {value: String(w.distinctTitles || 0), label: (w.distinctTitles || 0) === 1 ? 'title' : 'titles'},
        {value: String(w.activeDays || 0), label: (w.activeDays || 0) === 1 ? 'night' : 'nights'},
      ],
    },
  };
};

// ---------- the clock ----------
// A chapter is told in beats: beat 0 is what is there when it opens, and each
// entry of `beats` is when (ms from its opening) the next piece arrives. `ms`
// is when the story moves on by itself; 0 = it never does (the finale).
// Under calm the screen shows every chapter at ALL and keeps no clock.
export type Plan = {ms: number; beats: number[]};
export const ALL = 99;
// the beat of the viewer-type chapter at which the card has turned: the burst
export const BURST_BEAT = 2;

export const planOf = (chapter: Chapter, s: Story): Plan => {
  switch (chapter) {
    case 'opening':
      return {ms: 7000, beats: [900, 1700, 2600]};
    case 'hours':
      return {ms: 7600, beats: [1700, 2300, 2950].slice(0, 1 + s.hours.lines.length)};
    case 'top':
      return {ms: 8400, beats: [1400, 2200, 2800]};
    case 'podium':
      return {ms: 7800, beats: [700, 1300, 2100, 2900]};
    case 'genres':
      return {ms: 7400, beats: [600, 3000]};
    case 'night':
      return {ms: 8600, beats: [500, 1800, 2600, 3400]};
    case 'streak':
      return {ms: 9400, beats: [1300, 3600, 4300]};
    case 'longest':
      return {ms: 7000, beats: [1500, 2100, 3100]};
    case 'type':
      return {ms: 10500, beats: [2200, 2500, 3300, 4000]};
    case 'roasts': {
      const n = s.roasts.lines.length;
      return {ms: 1100 + n * 2400 + 2200, beats: s.roasts.lines.map((_, k) => 1100 + k * 2400)};
    }
    default:
      return {ms: 0, beats: []};
  }
};

// What a chapter is called when it is read out (the progress row's label).
export const chapterName = (chapter: Chapter, s: Story): string => {
  switch (chapter) {
    case 'opening':
      return 'Your year in Aurora';
    case 'hours':
      return `${s.hours.value} ${s.hours.unit}`;
    case 'top':
      return `Your number one: ${s.top ? s.top.name : ''}`;
    case 'podium':
      return 'The podium';
    case 'genres':
      return s.genres ? s.genres.title : 'Your genres';
    case 'night':
      return s.night ? s.night.title : 'Your hour';
    case 'streak':
      return s.streak ? s.streak.title : 'Your longest streak';
    case 'longest':
      return `Your longest sitting: ${s.longest ? s.longest.clock : ''} hours`;
    case 'type':
      return 'Your viewer type';
    case 'roasts':
      return s.roasts.eyebrow;
    default:
      return "That's a wrap";
  }
};
