// "What do we watch tonight?" on the TV — the small rules only the TV screen
// (screens/GroupPick.tsx) needs, kept pure so __tests__/logic/group-pick-tv.test.ts
// holds them: which view is up, this box's own answers while the server has
// not said them back yet, the countdown, a person's line, where Play goes.
// The words and the rules every app shares are groupPick.ts.
import type {GroupCard, GroupMember, GroupOptions, GroupSession, GroupSettings, GroupVerdict} from './groupPick';
import {WORDS, currentPick, hasNextPick, limitLabel, playsHere, secondsLeft, stepOf, timeLeft} from './groupPick';

// ---------- which view ----------
export type TvView = 'loading' | 'failed' | 'tutorial' | 'start' | 'lobby' | 'swipe' | 'waiting' | 'result' | 'nomatch' | 'chosen' | 'ended';
export const viewOf = (o: {
  options: GroupOptions | null;
  optionsFailed: boolean;
  session: GroupSession | null;
  lost: string | null; // the server no longer knows this session (its message)
  tutorial: boolean; // the explanation is open (first time, or "How it works")
}): TvView => {
  if (o.tutorial) return 'tutorial';
  if (o.lost != null) return 'ended';
  if (o.session) {
    const step = stepOf(o.session);
    if (step === 'result') return currentPick(o.session) ? 'result' : 'nomatch';
    return step;
  }
  if (o.optionsFailed) return 'failed';
  if (!o.options) return 'loading';
  return 'start';
};

/** The start form's first choices: the server's defaults (films, anything, any length, 3 min). */
export const firstSettings = (options: GroupOptions | null): GroupSettings => {
  const limits = options?.limits || [];
  return {
    kind: 'movie',
    mood: 'any',
    length: 'any',
    limitSec: limits.includes(180) ? 180 : limits[0] || 180,
  };
};

/** "Films · Funny · Any length · 3 min" — the chosen settings on one line. */
export const settingsLine = (s: GroupSettings, options: GroupOptions | null): string => {
  const label = (list: {id: string; label: string}[] | undefined, id: string) => (list || []).find(x => x.id === id)?.label || '';
  return [label(options?.kinds, s.kind), label(options?.moods, s.mood), label(options?.lengths, s.length), s.limitSec ? limitLabel(s.limitSec) : '']
    .filter(Boolean)
    .join(' · ');
};

// ---------- this box's answers, before the server says them back ----------
// A vote is answered {ok} and not a session; the next copy of the session
// carries it. Until then the card must not come back (a slow poll that left
// before the vote landed would bring it back for a moment). `local` holds
// key → verdict (null: taken back) until the server agrees.
export type LocalVotes = Record<string, GroupVerdict | null>;
export const mergeMine = (server: Record<string, GroupVerdict>, local: LocalVotes): Record<string, GroupVerdict> => {
  const out: Record<string, GroupVerdict> = {...server};
  for (const [k, v] of Object.entries(local)) {
    if (v) out[k] = v;
    else delete out[k];
  }
  return out;
};
/** What is still waiting for the server, once a new copy of the session is in
 *  (a card no longer in the deck — a new round — is dropped). */
export const settleLocal = (s: Pick<GroupSession, 'mine' | 'deck'>, local: LocalVotes): LocalVotes => {
  const keys = new Set(s.deck.map(c => c.key));
  const out: LocalVotes = {};
  for (const [k, v] of Object.entries(local)) if (keys.has(k) && (s.mine[k] || null) !== v) out[k] = v;
  return out;
};
export const withMine = (s: GroupSession, local: LocalVotes): GroupSession =>
  Object.keys(local).length ? {...s, mine: mergeMine(s.mine, local)} : s;

/** Undo: the last card this box answered that still has an answer. */
export const undoTarget = (history: string[], mine: Record<string, GroupVerdict>): {key: string | null; history: string[]} => {
  const h = [...history];
  while (h.length) {
    const key = h.pop()!;
    if (mine[key]) return {key, history: h};
  }
  return {key: null, history: h};
};

// ---------- the countdown ----------
/** The line and how full the bar is (1 → 0), counted from the copy's arrival. */
export const countdown = (s: Pick<GroupSession, 'deadline' | 'now' | 'limitSec'>, sinceMs: number): {text: string; frac: number; left: number} => {
  const left = secondsLeft(s, sinceMs);
  const whole = Math.max(s.limitSec || 0, left, 1);
  return {text: timeLeft(s, sinceMs), frac: s.deadline ? Math.max(0, Math.min(1, left / whole)) : 0, left};
};

// ---------- the people ----------
/** The small words on a person's chip. */
export const badgesOf = (m: GroupMember, phase: GroupSession['phase']): string[] => {
  const out: string[] = [];
  if (m.host) out.push(WORDS.hostBadge);
  if (m.role === 'screen') out.push(WORDS.screenBadge);
  if (m.away) out.push(WORDS.awayBadge);
  if (phase === 'swiping' && m.role === 'voter' && m.done) out.push(WORDS.doneBadge);
  return out;
};
/** While swiping: "Done", or how far a person is ("4 of 20"). */
export const personProgress = (m: GroupMember, deckLength: number): string =>
  m.done ? WORDS.doneBadge : deckLength ? `${Math.min(m.answered, deckLength)} of ${deckLength}` : '';
/** The voters only (the room's screens are not swiping), one per person. */
export const votersOf = (people: GroupMember[]): GroupMember[] => people.filter(m => m.role === 'voter');

// ---------- the result ----------
/** "Something else": the next pick, or back to the first once they are all seen. */
export const nextPick = (s: GroupSession): {index: number; label: string} | null => {
  const r = s.result;
  if (!r || r.picks.length < 2) return null;
  return hasNextPick(s) ? {index: r.index + 1, label: WORDS.somethingElse} : {index: 0, label: WORDS.firstPick};
};
/** "Pick 2 of 3", or nothing with only one. */
export const pickCount = (s: GroupSession): string => {
  const r = s.result;
  if (!r || r.picks.length < 2) return '';
  return `${Math.min(r.index, r.picks.length - 1) + 1} of ${r.picks.length}`;
};

// ---------- Play ----------
/** groupPickApi.playTarget's answer, turned into the screen the TV opens. */
export type PlayTarget = {kind: 'library'; id: string; type: 'movie' | 'show'} | {kind: 'discover'; imdbId: string; type: 'movie' | 'show'} | null;
export type DetailItem = {id: string; type: 'movie' | 'show'; title: string; year?: number; cover?: string | null; poster?: string | null; backdrop?: string | null; genres?: string[]; imdbId?: string; source: 'stream' | 'downloaded'};
export type PlayRoute = {screen: 'Player'; params: {id: string; title: string}} | {screen: 'Detail'; params: {item: DetailItem}} | null;
export const routeFor = (target: PlayTarget, card: GroupCard): PlayRoute => {
  if (!target) return null;
  // a library film: straight into the player (the player fetches /api/item)
  if (target.kind === 'library' && target.type === 'movie') return {screen: 'Player', params: {id: target.id, title: card.title}};
  const common = {
    type: target.type,
    title: card.title,
    year: card.year || undefined,
    backdrop: card.backdrop || null,
    genres: card.genres,
  };
  // a library series: its page (which episode is the page's question)
  if (target.kind === 'library') return {screen: 'Detail', params: {item: {...common, id: target.id, cover: card.poster || null, imdbId: card.imdbId, source: 'downloaded'}}};
  // a catalogue title: its page, as the catalogue opens it (it saves the copy)
  return {screen: 'Detail', params: {item: {...common, id: target.imdbId, imdbId: target.imdbId, poster: card.poster || null, source: 'stream'}}};
};

/** Which chosen session this is — so the TV starts it once, not on every copy. */
export const chosenKey = (s: GroupSession): string | null =>
  s.phase === 'chosen' && s.chosen ? `${s.code}:${s.round}:${s.chosen.key}` : null;
/** The chosen title to start on this box now, or null (not chosen / not here / already started). */
export const autoStart = (s: GroupSession, pressedKey: string | null, startedFor: string | null): GroupCard | null => {
  const key = chosenKey(s);
  if (!key || key === startedFor || !s.chosen) return null;
  const pressedHere = !!pressedKey && pressedKey === s.chosen.key;
  return playsHere(s, pressedHere) ? s.chosen.card : null;
};

/** Is this box inside a session that is still going (Back then asks first)? */
export const sessionLive = (s: GroupSession | null, lost: string | null): boolean =>
  !!s && lost == null && (s.phase === 'lobby' || s.phase === 'swiping' || s.phase === 'result');
