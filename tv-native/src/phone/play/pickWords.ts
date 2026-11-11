// Pick for me on the phone, "The Draw" — the words and small rules, PURE (tested in
// __tests__/logic/phone-play-pick.test.ts). The words are the website's
// (public/js/screens/pickforme.js DRAW); the reel's rules are the kit's port of
// public/js/play/reel.js (../../play/reel.ts).
import {cellAt, reelPos} from '../../play/reel';

export const DRAW = {
  kicker: "Tonight's pick",
  of: (n: number, of: number) => `${n} of ${of}`,
  said: (title: string) => `Tonight's pick: ${title}`,
  open: 'Open',
  another: 'Another one',
  hand: 'The whole hand',
};

/** "2019 · Film" (the prize's line). */
export const metaLine = (it: {year?: number | null; type?: string | null}): string =>
  [it.year, it.type === 'show' ? 'Series' : 'Film'].filter(Boolean).join(' · ');

/** The moments (ms from the start of a roll of `ms`) a poster passes the payline: a tick each. */
export const tickTimes = (last: number, ms: number, samples = 240): number[] => {
  const out: number[] = [];
  let at = cellAt(reelPos(0, last));
  for (let k = 1; k <= samples; k++) {
    const t = k / samples;
    const c = cellAt(reelPos(t, last));
    if (c !== at) {
      at = c;
      out.push(Math.round(t * ms));
    }
  }
  return out;
};

/** The pips under the prize: shown for 2 to 12 picks. */
export const showPips = (n: number) => n >= 2 && n <= 12;
