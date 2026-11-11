// Taste and Pick together on the phone, in the Aurora Play look — the small words the play
// layer adds, PURE (tested in __tests__/logic/phone-play-games.test.ts). They are the
// website's (public/js/screens/taste.js endPanel, group.js SHOW); the rules underneath are
// the kit's (../../play/tasteRead.ts, tally.ts).
import type {TasteRead} from '../../play/tasteRead';

type Verdict = 'love' | 'nope' | 'skip';

/** What Aurora learned this sitting: the genres loved most, lit; the ones only refused, dim. */
export const learnedTags = (read: Pick<TasteRead, 'liked' | 'less'>): {label: string; lit: boolean}[] => [
  ...read.liked.slice(0, 4).map(g => ({label: `${g.genre}${g.n > 1 ? ` ×${g.n}` : ''}`, lit: true})),
  ...read.less.slice(0, 2).map(g => ({label: `less ${g.genre}`, lit: false})),
];

/** The round's tally as three chips. */
export const tallyChips = (t: Record<Verdict, number>): {key: Verdict; label: string}[] => [
  {key: 'love', label: `♥ ${t.love} loved`},
  {key: 'nope', label: `✕ ${t.nope} not for you`},
  {key: 'skip', label: `${t.skip} not seen`},
];

// Pick together's show (group.js SHOW): words that exist only in the play look
export const SHOW = {
  votesIn: 'The votes are in…',
  tie: 'A tie — the stars decide',
  tieLine: 'It was a tie — the stars decided',
  skip: 'Skip',
  card: (n: number, of: number) => `Card ${n} of ${of}`,
  kicker: "Tonight's pick",
};
