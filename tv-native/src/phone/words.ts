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

const fmtBytes = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
const fmtDuration = (sec: number) => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
/** What the server holds of a title — the website's "On this server" lines on a title page
 *  (discover-detail.js serverInfoFor), each [text, tone]: "ok" reads green, "dim" quiet. */
export function onDiskLines(o: {
  isShow: boolean;
  film?: {sizeBytes?: number | null; duration?: number | null} | null;
  episodes?: {sizeBytes?: number | null}[] | null;
  listed?: number;
  canSource: boolean;
}): [string, 'ok' | 'dim'][] {
  const out: [string, 'ok' | 'dim'][] = [];
  const eps = o.episodes || [];
  const owned = o.isShow ? eps.length > 0 : !!o.film;
  if (!owned) {
    if (!o.canSource) out.push([o.isShow ? 'No episodes on this server yet' : 'Not on this server yet', 'dim']);
    else out.push([o.isShow ? 'No episodes on disk yet — stream, or save a source' : 'Not on disk yet — stream it, or save a source', 'dim']);
    return out;
  }
  if (o.isShow) {
    out.push([`${eps.length} of ${Math.max(o.listed || 0, eps.length)} episodes on disk`, 'ok']);
    const bytes = eps.reduce((n, e) => n + (e.sizeBytes || 0), 0);
    if (bytes) out.push([fmtBytes(bytes), 'dim']);
  } else {
    out.push(['On disk — plays instantly', 'ok']);
    const f = o.film!;
    const rest = [f.sizeBytes ? fmtBytes(f.sizeBytes) : null, f.duration ? fmtDuration(f.duration) : null].filter(Boolean).join(' · ');
    if (rest) out.push([rest, 'dim']);
  }
  return out;
}
