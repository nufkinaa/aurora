// The picture a card draws, and the address it asks for — in ONE place.
//
// Card.tsx draws it; artPrefetch.ts fetches it before the card exists. The
// image pipeline keys its caches by the address (and, for the decoded
// picture, by the resize options — none for these), so a prefetch only saves
// anything when it asks for EXACTLY the address the card will: same picture
// chosen, same `?w=` step. Both call this function; neither builds an address
// of its own.
import {artPath, artPx, imgSrc, HeroItem, ImgSource} from './api';

export const CARD_W = 124;
export const CARD_H = 186; // 176 × 0.70, 2:3 (components.css:321-324)
// `.card.wide` is 300px at 16/9 (components.css:325-328). ×0.59, which is the one
// place the card set is not ×0.70 — D3 pinned both shapes directly.
export const WIDE_W = 176;
export const WIDE_H = 99;
// The compact poster (the AI page's results grid, 2026-10-08): 70% of the
// standard poster so eight columns fit a 960dp canvas. Same 2:3, same look.
// Wider than the first cut (88dp): the title and the reason under it were
// not readable from the sofa (elia, 2026-10-09). Six per row at 1080p.
export const COMPACT_W = 116;
export const COMPACT_H = 174;
// Continue Watching (glass.css, 2026-10-06): 320px at 16:10 on the site, with
// the picture you stopped on, the title set large on a deep fade and what is
// left under it. ×0.70 here.
export const FRAME_W = 224;
export const FRAME_H = 140;

// How wide the card's picture is drawn, in dp, for the server's width
// variants. A cover-fitted picture fills the box's HEIGHT when it is wider
// than the box: a 16:9 backdrop or still on the 16:10 frame card is drawn
// FRAME_H × 16/9 wide, not FRAME_W. Posters (2:3) and anything narrower than
// the box are width-bound.
export const FRAME_ART_W = Math.ceil((FRAME_H * 16) / 9);

export type CardShape = {wide?: boolean; frame?: boolean; compact?: boolean};
export type CardArt = {
  isEpisode: boolean;
  landscape: boolean;
  /** The server cuts the moment you stopped on (a frame card mid-way). */
  canFrame: boolean;
  /** The picture's address as the JSON carried it (or the frame's path). */
  picture: string | null | undefined;
  /** How wide it is drawn, dp. */
  artDp: number;
  /** The sized address (`?w=`), when the server can size this picture. */
  sizedPath: string | null;
  /** What the card's <Image> is given. */
  src: ImgSource | null;
  /** The address the blur-up placeholder is keyed by (blur.ts). */
  blurKey: string | null | undefined;
};

export function cardArt(item: HeroItem, {wide, frame, compact}: CardShape = {}): CardArt {
  const isEpisode = !!item.showId && item.type !== 'show';
  const landscape = !!wide || isEpisode;
  const prog = item.progress;
  // The picture. A frame card (Continue Watching) shows the moment you stopped
  // on when the server can cut it — a library title with a position — else the
  // title's landscape art, else the poster (components.js:164-170). Posters
  // keep the cover.
  const canFrame = !!(frame && prog && prog.position > 20 && item.id && !String(item.id).startsWith('torrent|'));
  const picture = canFrame
    ? `/img/frame/${encodeURIComponent(item.id)}?t=${Math.floor(prog!.position)}`
    : (frame && !isEpisode && item.backdrop) || item.cover || item.poster;
  // At the size it is drawn (api.ts artPath — the site's artUrl): the server
  // sends a variant that wide, so the box decodes the picture once, at size,
  // with no `resizeMethod="resize"` re-encode. Frames and hosts the server
  // does not proxy keep their address (and the on-device resize).
  const artDp = frame
    ? (!isEpisode && item.backdrop) || isEpisode
      ? FRAME_ART_W
      : FRAME_W
    : landscape
    ? WIDE_W
    : compact
    ? COMPACT_W
    : CARD_W;
  const sizedPath = canFrame ? null : artPath(picture, artPx(artDp));
  const src = imgSrc(sizedPath || picture);
  // A frame card's still has no placeholder of its own, so it borrows the
  // title's art — the still takes longest of all to arrive.
  const blurKey = canFrame
    ? item.backdrop || item.cover || item.poster
    : (frame && !isEpisode && item.backdrop) || item.cover || item.poster;
  return {isEpisode, landscape, canFrame, picture, artDp, sizedPath, src, blurKey};
}

/** The card's picture, when it is one that can be fetched ahead and land in
 *  the cache under the key the card will look up: the card draws it with
 *  `resizeMethod="auto"` (no resize options in the key) only when the server
 *  sized it, or it is a resume frame. An unsized picture is drawn with
 *  "resize" — keyed by the VIEW's pixel size — and is left to the card. */
export function prefetchable(item: HeroItem, shape: CardShape = {}): ImgSource | null {
  const a = cardArt(item, shape);
  return a.src && (a.canFrame || a.sizedPath) ? a.src : null;
}
