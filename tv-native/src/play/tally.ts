// Aurora Play — telling a vote (pure). A port of public/js/play/tally.js. The
// server decides the result and its order; this only reads what it sent so the
// screen can show it: a row of stars for the pick, and whether the top two
// were level (then the reveal tells it as a tie-break).
export const MAX_MARKS = 12;

export type Mark = 'yes' | 'maybe' | 'no';
export type Votes = {yes?: number; maybe?: number; no?: number; missing?: number; of?: number; everyone?: boolean};

const count = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));

// The marks of the tally, in order: "yes" for every yes, "maybe" for every
// maybe, "no" for everyone else (a no, or no answer). [] for a room too big to
// draw or a pick without numbers.
export const tallyOf = (pick: Votes | null | undefined): Mark[] => {
  if (!pick) return [];
  const yes = count(pick.yes);
  const maybe = count(pick.maybe);
  const of = Math.max(count(pick.of), yes + maybe);
  if (!of || of > MAX_MARKS) return [];
  return [
    ...Array<Mark>(yes).fill('yes'),
    ...Array<Mark>(maybe).fill('maybe'),
    ...Array<Mark>(of - yes - maybe).fill('no'),
  ];
};

// True when the first two picks got exactly the same votes and it was not a
// clean "everyone said yes" (that one is a win, not a draw).
export const isTie = (result: {picks?: (Votes | null | undefined)[] | null} | null | undefined): boolean => {
  const picks = result && result.picks;
  if (!Array.isArray(picks) || picks.length < 2) return false;
  const [a, b] = picks;
  if (!a || !b || a.everyone) return false;
  return (['yes', 'maybe', 'no', 'missing'] as const).every(k => count(a[k]) === count(b[k]));
};

// The tie-break's light: which of the two posters (0 | 1) is lit, and when (ms
// from the start), slower with every jump, the last one on `winner`.
export const tieJumps = (
  winner = 0,
  {n = 9, first = 90, grow = 1.24}: {n?: number; first?: number; grow?: number} = {},
) => {
  const w = winner === 1 ? 1 : 0;
  const steps = Math.max(1, Math.floor(n));
  const out: {i: number; at: number}[] = [];
  let at = 0;
  let gap = first;
  for (let k = 0; k < steps; k++) {
    // counted back from the end, so the last jump lands on the winner
    out.push({i: (w + (steps - 1 - k)) % 2, at: Math.round(at)});
    at += gap;
    gap *= grow;
  }
  return out;
};
