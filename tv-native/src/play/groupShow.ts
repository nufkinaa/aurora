// Aurora Play — Pick together on the TV: the words the play look adds and the
// small rules of its show (pure, tested in __tests__/logic/group-play.test.ts).
//
// The words are the website's (public/js/screens/group.js SHOW) — the test
// holds them to that file — so the reveal says the same thing on every screen.
// The vote, its result and its order are the server's; this only tells them.
import {tieJumps} from './tally';

export const SHOW = {
  votesIn: 'The votes are in…',
  tie: 'A tie — the stars decide',
  tieLine: 'It was a tie — the stars decided',
  skip: 'Skip',
  card: (n: number, of: number) => `Card ${n} of ${of}`,
} as const;

export type GroupVerdictKey = 'yes' | 'no' | 'maybe';

// The deck on the TV is driven like Taste's: the card holds the focus and the
// answer is the direction it is thrown. RIGHT (or OK on the card) = Yes,
// LEFT = No, DOWN = Maybe, UP = the keys above.
export const verdictForGroupKey = (eventType: string): GroupVerdictKey | null =>
  eventType === 'right' ? 'yes' : eventType === 'left' ? 'no' : eventType === 'down' ? 'maybe' : null;

// How big a seat is: the room's screen is read from the sofa, so a seat is
// big while the room is small and shrinks as it fills (two rows from about
// eight people on).
export const seatSize = (people: number) => (people <= 6 ? 64 : people <= 10 ? 52 : 44);

// The two dashed seats that say "there is room": only while the room is
// small enough for them to mean something, and never on a row of their own
// (five seats fill the lobby's row).
export const freeSeats = (people: number) => Math.max(0, Math.min(2, 5 - people));

// The reveal's beats, in ms from its start. Without a tie: the three stars
// light (380 ms apart from 200), a breath, then the curtain lifts. With one:
// the words change to the tie, the light jumps between the two posters
// (slower and slower, tally.ts tieJumps) and lands on the server's pick, holds,
// then the curtain lifts.
export const STAR_AT = [200, 580, 960] as const;
export const revealPlan = (tie: boolean, winner = 0) => {
  const votesEnd = 1500;
  if (!tie) return {tieAt: -1, jumps: [] as {i: number; at: number}[], wonAt: -1, end: votesEnd};
  const jumps = tieJumps(winner).map(j => ({i: j.i, at: votesEnd + 460 + j.at}));
  const landed = jumps[jumps.length - 1].at;
  return {tieAt: votesEnd, jumps, wonAt: landed + 140, end: landed + 820};
};

// Which side the server's pick stands on in the tie-break (not always the
// left: the result's own time decides, as on the website).
export const tieSides = (at: number | undefined) => ((Number(at) || 0) % 2 === 1 ? {swap: true, winner: 1} : {swap: false, winner: 0});
