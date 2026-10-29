// Small pure pieces of the phone's screens (tested in __tests__/logic/phone-links-update.test.ts):
// kept here so a test needs no screen, no navigation and no network.

/** "Mi TV Stick · Android" — what the server knows of a device asking to sign in (the
 *  website's pair.js words). PairTv.tsx */
export const askerName = (a: {device?: {device?: string | null; os?: string | null} | null} | null | undefined) =>
  a?.device ? [a.device.device, a.device.os].filter(x => x && x !== 'Other').join(' · ') || 'A device' : 'A device';

/** Your rating's words, the website's (components.js RATING_QUIPS). ui/StarRating.tsx */
export const RATING_QUIPS: Record<number, string> = {1: 'brutal', 2: 'not for you, then', 3: 'perfectly fine', 4: 'a good one', 5: 'a favourite!'};
/** Tapping star `i` when `cur` is lit: the new rating (the same star again clears it). */
export const nextRating = (cur: number, i: number) => (cur === i ? 0 : i);

/** A changelog line's Markdown → the pieces to draw: **bold** bold, `code` plain. screens/WhatsNew.tsx */
export const mdPieces = (line: string): {text: string; bold: boolean}[] => {
  const out: {text: string; bold: boolean}[] = [];
  const clean = String(line || '').replace(/`([^`]+)`/g, '$1');
  const re = /\*\*(.+?)\*\*/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    if (m.index > at) out.push({text: clean.slice(at, m.index), bold: false});
    out.push({text: m[1], bold: true});
    at = m.index + m[0].length;
  }
  if (at < clean.length) out.push({text: clean.slice(at), bold: false});
  return out;
};
