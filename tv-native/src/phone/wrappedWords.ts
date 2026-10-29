// "Your Aurora Wrapped" on the phone — the website's numbers and roasts
// (public/js/screens/wrapped.js), PURE so the logic tests hold them to the
// site's words. Server: GET /api/profiles/:id/wrapped (routes/profiles.js,
// telemetry.js wrappedFor): { empty: true } until there is something to wrap.

export type Wrapped = {
  empty?: false;
  since: string;
  totalSec: number;
  plays: number;
  distinctTitles: number;
  topTitles: {name: string; sec: number}[];
  topWeekday: number;
  byDevice: {name: string; sec: number}[];
  biggestDay: {day: string; sec: number} | null;
  bestStreak: number;
  lateNightSessions: number;
  latestFinish: {hour: number; title: string} | null;
  longestSession: {title: string; watchedSec: number; at?: string} | null;
  activeDays: number;
  topGenres: {name: string; sec: number}[];
  started: number;
  finished: number;
};
export type WrappedReply = Wrapped | {empty: true};

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "12 hours", "2.5 hours", "40 minutes" — the site's fmtH. */
export const fmtH = (sec: number) => {
  const h = sec / 3600;
  return h >= 10 ? Math.round(h) + ' hours' : h >= 1 ? h.toFixed(1) + ' hours' : Math.round(sec / 60) + ' minutes';
};

const dayName = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString([], {month: 'long', day: 'numeric'});
  } catch {
    return iso;
  }
};

/** The roast engine: rules over the stats, worst behaviour first, four at most. */
export function roastsFor(w: Wrapped, name: string): string[] {
  const out: string[] = [];
  const topShare = w.topTitles.length && w.totalSec > 0 ? w.topTitles[0].sec / w.totalSec : 0;

  if (w.started >= 5 && w.finished > 0 && w.started > w.finished * 2) {
    out.push(`You've started ${w.started} things and finished ${w.finished}. Commitment issues, but make it streaming.`);
  } else if (w.started >= 8 && w.finished === 0) {
    out.push(`${w.started} titles started. Zero finished. Bold strategy.`);
  }
  if (w.latestFinish && w.latestFinish.hour >= 1 && w.latestFinish.hour <= 5) {
    out.push(`You once finished “${w.latestFinish.title}” at ${w.latestFinish.hour}am. The sunrise saw everything.`);
  }
  if (w.lateNightSessions >= 5) {
    out.push(`${w.lateNightSessions} sessions started after midnight. You and 3am are basically in a relationship.`);
  }
  if (w.biggestDay && w.biggestDay.sec >= 4 * 3600) {
    out.push(`On ${dayName(w.biggestDay.day)} you watched ${fmtH(w.biggestDay.sec)}. The sun called — you let it go to voicemail.`);
  }
  if (w.bestStreak >= 7) {
    out.push(`${w.bestStreak} days in a row. The couch has permanently taken your shape.`);
  }
  if (topShare > 0.4 && w.topTitles[0]) {
    out.push(`“${w.topTitles[0].name}” is ${Math.round(topShare * 100)}% of everything you've watched. It's not a phase, mom.`);
  }
  if (w.byDevice[0] && w.byDevice[0].name === 'Mobile' && w.byDevice.length > 1) {
    out.push(`Mostly watched on your phone. There's a beautiful big TV right there, ${name}. It misses you.`);
  }
  if (w.distinctTitles <= 3 && w.plays >= 10) {
    out.push(`${w.plays} sessions across ${w.distinctTitles} titles. Variety is overrated anyway.`);
  }
  if (!out.length) {
    out.push(`Honestly? Nothing to roast. Balanced viewing, reasonable hours. Who ARE you, ${name}?`);
  }
  return out.slice(0, 4);
}

export type BigCard = {value: string; label: string; sub: string | null};

/** The six cards, in the site's order (genre and longest sitting only when there are any). */
export function wrappedCards(w: Wrapped): BigCard[] {
  const out: BigCard[] = [
    {value: fmtH(w.totalSec), label: 'watched', sub: `${w.plays} sessions · ${w.activeDays} days with at least one`},
    {
      value: String(w.distinctTitles),
      label: 'different titles',
      sub: w.topTitles[0] ? `“${w.topTitles[0].name}” on top with ${fmtH(w.topTitles[0].sec)}` : null,
    },
    {value: DAYS[w.topWeekday] || DAYS[0], label: 'is your night', sub: null},
    {value: String(w.bestStreak), label: 'day streak', sub: w.biggestDay ? `biggest day: ${fmtH(w.biggestDay.sec)}` : null},
  ];
  if (w.topGenres && w.topGenres.length) {
    out.push({value: w.topGenres[0].name, label: 'your genre', sub: w.topGenres.slice(1, 3).map(g => g.name).join(' · ') || null});
  }
  if (w.longestSession) out.push({value: fmtH(w.longestSession.watchedSec), label: 'longest sitting', sub: `“${w.longestSession.title}”`});
  return out;
}

/** Nothing to wrap yet: the same cards with sample numbers, drawn dimmed (the site's preview). */
export const PREVIEW_CARDS: BigCard[] = [
  {value: '12h 40m', label: 'watched', sub: '9 sessions · 6 days with at least one'},
  {value: '7', label: 'different titles', sub: '“Something great” on top with 4h 10m'},
  {value: 'Friday', label: 'is your night', sub: null},
  {value: '4', label: 'day streak', sub: 'biggest day: 3h 05m'},
  {value: 'Sci-Fi', label: 'your genre', sub: 'Drama · Thriller'},
  {value: '2h 15m', label: 'longest sitting', sub: '“One you couldn\'t stop”'},
];

/** The line under the heading. */
export function sinceLine(name: string, since: string | null): string {
  if (!since) return `${name} · nothing to wrap yet — this is what it'll look like once you've watched a few things`;
  let d = since;
  try {
    d = new Date(since).toLocaleDateString([], {month: 'long', day: 'numeric', year: 'numeric'});
  } catch {}
  return `${name} · since ${d}`;
}
