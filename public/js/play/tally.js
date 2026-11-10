// Aurora Play — telling a vote (pure; the screen is js/screens/group.js).
// The server decides the result and its order; this only reads what it sent
// so the page can show it: a row of stars for the pick, and whether the top
// two were level (then the reveal tells it as a tie-break).
//
//   tallyOf(pick)  pick: { yes, maybe, no, missing, of } -> the marks of the
//       tally, in order: "yes" for every yes, "maybe" for every maybe, "no"
//       for everyone else (a no, or no answer). [] for a room too big to
//       draw (more than MAX_MARKS voters) or a pick without numbers.
//   isTie(result)  result: { picks: [...] } -> true when the first two picks
//       got exactly the same votes and it was not a clean "everyone said
//       yes" (that one is a win, not a draw).
//   tieJumps(winner, { n, first, grow })  -> [{ i, at }]: the tie-break's
//       light — which of the two posters (0 | 1) is lit, and when (ms from
//       the start), slower with every jump, the last one on `winner`.
export const MAX_MARKS = 12;

const count = (v) => Math.max(0, Math.floor(Number(v) || 0));

export const tallyOf = (pick) => {
  if (!pick) return [];
  const yes = count(pick.yes);
  const maybe = count(pick.maybe);
  const of = Math.max(count(pick.of), yes + maybe);
  if (!of || of > MAX_MARKS) return [];
  return [
    ...Array(yes).fill("yes"),
    ...Array(maybe).fill("maybe"),
    ...Array(of - yes - maybe).fill("no"),
  ];
};

export const isTie = (result) => {
  const picks = result && result.picks;
  if (!Array.isArray(picks) || picks.length < 2) return false;
  const [a, b] = picks;
  if (!a || !b || a.everyone) return false;
  return ["yes", "maybe", "no", "missing"].every((k) => count(a[k]) === count(b[k]));
};

export const tieJumps = (winner = 0, { n = 9, first = 90, grow = 1.24 } = {}) => {
  const w = winner === 1 ? 1 : 0;
  const steps = Math.max(1, Math.floor(n));
  const out = [];
  let at = 0;
  let gap = first;
  for (let k = 0; k < steps; k++) {
    // counted back from the end, so the last jump lands on the winner
    out.push({ i: (w + (steps - 1 - k)) % 2, at: Math.round(at) });
    at += gap;
    gap *= grow;
  }
  return out;
};
