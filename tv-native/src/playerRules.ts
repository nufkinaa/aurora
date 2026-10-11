// The player's small rules that the website's player has too — next episode,
// Up next, "Still watching?", Skip intro / recap. PURE, no imports: the logic
// tests run this file as it is, and each rule names the website's lines
// (public/js/screens/player.js) it mirrors.

// ------------------------------------------------------------ what is next
// The server decides (GET /api/next-episode, src/media/nextep.js — one rule
// for the website and the TV): the REAL next episode. `library` = it is on
// disk, plays at once and may start by itself; `stream` = it is not on disk:
// it is offered ("Choose episode") and never started by itself.
export type NextEp =
  | {kind: 'library'; id: string; season: number; episode: number; name: string; label: string}
  | {kind: 'stream'; imdbId: string; season: number; episode: number; name: string; label: string};

const labelOf = (season: number, episode: number, name: string) => `S${season} E${episode}${name ? ` · ${name}` : ''}`;

/** The server's answer, read. `undefined` = that was not an answer at all (a
 *  server from before the route existed answers 404, or something else came
 *  back): the caller falls back to `nextFile`. `null` = nothing is next. */
export const readNext = (answer: unknown): NextEp | null | undefined => {
  if (!answer || typeof answer !== 'object' || !('next' in (answer as object))) return undefined;
  const n = (answer as {next: unknown}).next as Record<string, unknown> | null;
  if (!n) return null;
  const season = Number(n.season);
  const episode = Number(n.episode);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return undefined;
  const name = typeof n.title === 'string' && !/^Episode \d+$/.test(n.title) ? n.title : '';
  if (n.kind === 'library' && typeof n.id === 'string' && n.id) {
    return {kind: 'library', id: n.id, season, episode, name, label: labelOf(season, episode, name)};
  }
  if (n.kind === 'stream' && typeof n.imdbId === 'string' && n.imdbId) {
    return {kind: 'stream', imdbId: n.imdbId, season, episode, name, label: labelOf(season, episode, name)};
  }
  return undefined;
};

/** The old rule, kept ONLY as the fallback for a server without the route:
 *  the next file in the library's own list (which can skip episodes that are
 *  not on disk — the reason the server's answer exists). */
export const nextFile = (
  seasons: {episodes?: {id: string; season?: number; episode?: number; title?: string}[]}[] | null | undefined,
  id: string,
): NextEp | null => {
  const flat = (seasons || []).flatMap(s => s.episodes || []);
  const i = flat.findIndex(e => e.id === id);
  const n = i >= 0 ? flat[i + 1] : null;
  if (!n) return null;
  const season = Number(n.season) || 0;
  const episode = Number(n.episode) || 0;
  const name = n.title && !/^Episode \d+$/.test(n.title) ? n.title : '';
  return {kind: 'library', id: n.id, season, episode, name, label: labelOf(season, episode, name)};
};

// ------------------------------------------------------------------ Up next
/** How long the card counts down before the next episode starts by itself. */
export const UPNEXT_COUNTDOWN_SEC = 15;
/** How many episodes in a row may start BY THEMSELVES (the countdown ran out,
 *  nobody touched the remote in between) before the next one waits to be
 *  asked for (player.js :86 STILL_WATCHING_AFTER). */
export const STILL_WATCHING_AFTER = 3;

export type UpNextPlan = {
  /** the ordinary card, or "Still watching?" */
  card: 'upnext' | 'still';
  /** seconds to count down from; null = nothing starts by itself */
  countdown: number | null;
  /** the main button: Play now / Choose episode / Keep watching */
  primary: 'play' | 'choose' | 'keep';
};

/** What the card is, by the website's rule (player.js showUpNext):
 *   - it starts by itself only where "play" is unambiguous — an episode ON
 *     DISK — and the person's "play the next episode" setting is on;
 *   - a party GUEST never advances on their own (the host's move carries the
 *     room), so no countdown for them;
 *   - an episode not on disk needs a source picked: offered, never started;
 *   - after three in a row started by themselves with nobody touching
 *     anything: "Still watching?", and nothing starts until someone answers.
 *     Never in a watch party (the room decides together). */
export const planUpNext = (o: {
  next: NextEp;
  autoplayPref: boolean;
  inParty: boolean;
  guest: boolean;
  /** episodes that started by themselves, in a row, up to and including this one */
  autoRun: number;
}): UpNextPlan => {
  if (o.next.kind === 'stream') return {card: 'upnext', countdown: null, primary: 'choose'};
  const autoplay = o.autoplayPref && !(o.inParty && o.guest);
  if (autoplay && !o.inParty && o.autoRun >= STILL_WATCHING_AFTER) return {card: 'still', countdown: null, primary: 'keep'};
  return {card: 'upnext', countdown: autoplay ? UPNEXT_COUNTDOWN_SEC : null, primary: 'play'};
};

/** The run of self-started episodes the NEXT player inherits: one more when
 *  this one ended by the countdown, none when a person chose (Play now, the
 *  Next button, Keep watching) — and a party's episodes are never counted. */
export const nextAutoRun = (o: {byCountdown: boolean; inParty: boolean; autoRun: number}): number =>
  o.byCountdown && !o.inParty ? o.autoRun + 1 : 0;

/** When Up next is on (player.js maybeUpNext): from the detected credits, else
 *  a window near the end that scales with the runtime (a fixed 30 s missed the
 *  long credits of hour-long episodes). 'retract' = the viewer went back out
 *  of the credits by more than 15 s: the card goes and is armed again. */
export const upNextWindow = (duration: number) => Math.max(30, Math.min(90, duration * 0.05));
export const upNextState = (content: number, duration: number, creditsStart: number | null): 'show' | 'hold' | 'retract' => {
  if (!duration) return 'hold';
  const win = creditsStart != null && creditsStart > 0 && creditsStart < duration - 5 ? duration - creditsStart : upNextWindow(duration);
  const remaining = duration - content;
  if (remaining <= win) return 'show';
  if (remaining > win + 15) return 'retract';
  return 'hold';
};

// ------------------------------------------------------- Skip intro / recap
export type Range = {start: number; end: number};
/** A usable range out of whatever the server sent. */
export const rangeOf = (x: unknown): Range | null => {
  if (!x || typeof x !== 'object') return null;
  const start = Number((x as {start?: unknown}).start);
  const end = Number((x as {end?: unknown}).end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? {start, end} : null;
};
/** What the Skip button would skip at this moment (player.js skippableNow):
 *  the recap while inside it, else the intro. Never in a range's final second
 *  — skipping to "one second from now" reads as a broken button. */
export const skippableAt = (
  t: number,
  o: {recap: Range | null; intro: Range | null},
): {kind: 'recap' | 'intro'; range: Range} | null => {
  const inside = (x: Range | null): x is Range => !!x && t >= x.start && t < x.end - 1;
  if (inside(o.recap)) return {kind: 'recap', range: o.recap};
  if (inside(o.intro)) return {kind: 'intro', range: o.intro};
  return null;
};

// ------------------------------------------------- a stall on direct play
// The website's staged recovery (player.js :4704): a picture that stops with
// nothing said is nudged at 6 s, its source is handed over again at 20 s, and
// at 45 s a card says so and offers a way out. The TV did this for repackaged
// streams only; a file played as it is could sit on a spinner for ever.
export const STALL_NUDGE_MS = 6000;
export const STALL_REBUILD_MS = 20000;
export const STALL_CARD_MS = 45000;
export type StallStep = 'nudge' | 'rebuild' | 'card' | null;
/** The next step for a stall that has lasted `ms`, given what was already
 *  done for THIS stall. One of each per stall, in order. */
export const stallStep = (ms: number, done: {nudged: boolean; rebuilt: boolean; carded: boolean}): StallStep => {
  if (ms >= STALL_CARD_MS && !done.carded) return 'card';
  if (ms >= STALL_REBUILD_MS && !done.rebuilt) return 'rebuild';
  if (ms >= STALL_NUDGE_MS && !done.nudged) return 'nudge';
  return null;
};
