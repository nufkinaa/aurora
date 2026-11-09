// "What do we watch tonight?" on the phone — what a finger on the card means,
// and this phone's own answers until the server has them. PURE (no React
// Native), tested (__tests__/logic/phone-group-swipe.test.ts).
//
//   drag right   Yes     (or the ✓ button)
//   drag left    No      (or the ✕ button)
//   drag up      Maybe   (or the ? button in the middle)
//
// The finger's rules are Swipe your taste's (tasteSwipe.ts swipeVerdict: how
// far, how fast, mostly in that direction) — one gesture across the app.
//
// Optimistic answers: an answer moves to the next card at once. It is kept
// here (`Answers.local`) until a copy of the session from the server carries
// it, so a slow poll that left before the vote cannot bring the card back.
// Undo takes back this phone's last answer of the round (verdict null to the server).
import type {Verdict} from '../tasteSession';
import {flyTo as tasteFlyTo, stampLevels as tasteStamps, swipeVerdict} from './tasteSwipe';
import {GroupCard, GroupSession, GroupVerdict, WORDS} from '../groupPick';

const FROM_TASTE: Record<Verdict, GroupVerdict> = {love: 'yes', nope: 'no', skip: 'maybe'};
const TO_TASTE: Record<GroupVerdict, Verdict> = {yes: 'love', no: 'nope', maybe: 'skip'};

/** What a finished drag answers (null: back to the middle). `cancelled`: the system took the touch. */
export const groupVerdict = (drag: {dx: number; dy: number; vx?: number; vy?: number}, cancelled = false): GroupVerdict | null => {
  const v = swipeVerdict(drag, cancelled);
  return v ? FROM_TASTE[v] : null;
};

/** How much of each stamp shows at this point of a drag (0..1). */
export const stampLevels = (dx: number, dy: number): Record<GroupVerdict, number> => {
  const t = tasteStamps(dx, dy);
  return {yes: t.love, no: t.nope, maybe: t.skip};
};

/** Where an answered card flies to, and its tilt (Undo flies it back from there). */
export const flyTo = (v: GroupVerdict, from: {dx: number; dy: number} | null, width: number, height: number) => tasteFlyTo(TO_TASTE[v], from, width, height);

export const GLYPH: Record<GroupVerdict, string> = {yes: '✓', maybe: '?', no: '✕'};
export const LABEL: Record<GroupVerdict, string> = {yes: WORDS.yes, maybe: WORDS.maybe, no: WORDS.no};
export const STAMP: Record<GroupVerdict, string> = {yes: WORDS.yes.toUpperCase(), maybe: WORDS.maybe.toUpperCase(), no: WORDS.no.toUpperCase()};
export const TINT: Record<GroupVerdict, string> = {yes: '#6ee7a8', maybe: '#ffd27a', no: '#ff7b8a'};
/** The order of the three buttons under the card: No · Maybe · Yes (Yes under the right thumb). */
export const BUTTONS: GroupVerdict[] = ['no', 'maybe', 'yes'];

/** What a screen reader says for the card. */
export const cardLabel = (c: Pick<GroupCard, 'title' | 'year'>) => `${c.title}${c.year ? ` (${c.year})` : ''}. Drag right: yes. Left: no. Up: maybe.`;

// ---------- this phone's answers ----------
/** A local answer (null: taken back) per card key, the order this phone gave them in, and the round. */
export type Answers = {round: number; code: string; local: Record<string, GroupVerdict | null>; history: string[]};
export const noAnswers = (code = '', round = 0): Answers => ({round, code, local: {}, history: []});

/** The answers as they stand on this phone: the server's, with this phone's own on top. */
export const mineOf = (s: Pick<GroupSession, 'mine'>, a: Answers): Record<string, GroupVerdict> => {
  const out: Record<string, GroupVerdict> = {...s.mine};
  for (const k of Object.keys(a.local)) {
    const v = a.local[k];
    if (v) out[k] = v;
    else delete out[k];
  }
  return out;
};

/** A new copy from the server: a new round (or session) starts clean; answers it now carries are dropped from `local`. */
export const settle = (a: Answers, s: Pick<GroupSession, 'code' | 'round' | 'mine'>): Answers => {
  if (a.code !== s.code || a.round !== s.round) return noAnswers(s.code, s.round);
  let changed = false;
  const local: Record<string, GroupVerdict | null> = {};
  for (const k of Object.keys(a.local)) {
    const v = a.local[k];
    if (v === (s.mine[k] || null)) changed = true;
    else local[k] = v;
  }
  return changed ? {...a, local} : a;
};

/** Answer a card here (before the server has it). */
export const answer = (a: Answers, key: string, v: GroupVerdict): Answers => ({
  ...a,
  local: {...a.local, [key]: v},
  history: [...a.history.filter(k => k !== key), key],
});

/** Undo: this phone's last answer back (null when there is none), and the answers after it. */
export const undo = (a: Answers): {key: string; next: Answers} | null => {
  if (!a.history.length) return null;
  const key = a.history[a.history.length - 1];
  return {key, next: {...a, local: {...a.local, [key]: null}, history: a.history.slice(0, -1)}};
};

/** A vote the server never got (no connection): as if it had not been given. */
export const forget = (a: Answers, key: string): Answers => {
  const local = {...a.local};
  delete local[key];
  return {...a, local, history: a.history.filter(k => k !== key)};
};

/** The session as this phone shows it: its own answers in `mine`. */
export const withMine = (s: GroupSession, a: Answers): GroupSession =>
  Object.keys(a.local).length && a.code === s.code && a.round === s.round ? {...s, mine: mineOf(s, a)} : s;
