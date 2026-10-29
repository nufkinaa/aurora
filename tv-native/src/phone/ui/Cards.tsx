// The phone's cards — the website's at 412 px (components.css + glass.css):
//
//   PosterCard  2:3 poster, hairline edge, film / series tag top-right, NEW,
//               the watched bar at the foot
//   FrameCard   Continue Watching: the moment you stopped on (16:10), the
//               title set large on a deep fade, what is left, the bar + bead,
//               ✕ to take it off the row
//
// Pictures are asked for at the width they are drawn (api.ts artSrc → the
// server's ?w= variants): a phone decodes a picture already its size.
import React, {memo, useState} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import {artSrc as sharedArtSrc, ART_LADDER, HeroItem, imgSrc} from '../../api';
import {PixelRatio} from 'react-native';
import Tap from './Tap';
import Icon from './Icon';
import {colors, FRAME_H, FRAME_W, POSTER_H, POSTER_W} from '../theme';
import {FADE_MS} from '../lowEnd';

/** artSrc (api.ts), never asking past the server's widest variant: a picture drawn wider than
 *  that is asked for at the widest (the original, unsized, would be fetched from the internet
 *  by the phone itself — and is refused on a server that fences it). */
export const artSrc = (path: string | null | undefined, dp: number) =>
  sharedArtSrc(path, Math.min(dp, Math.floor(ART_LADDER[ART_LADDER.length - 1] / PixelRatio.get())));

const isShow = (it: HeroItem) => it.type === 'show' || (it as {type?: string}).type === 'series';

/** Watched fraction 0..1 of an item's saved position (null: none). */
export const progressOf = (it: HeroItem): number | null => {
  const p = it.progress;
  if (!p || !p.duration || p.finished) return null;
  const f = p.position / p.duration;
  return f > 0.01 ? Math.min(1, f) : null;
};

const minutesLeft = (it: HeroItem): string | null => {
  const p = it.progress;
  if (!p || !p.duration) return null;
  const left = Math.max(0, p.duration - p.position);
  const m = Math.max(1, Math.round(left / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
};

/** The site's watch bar (glass.css .card-progress): a 3 dp capsule (2.5 on a wide card), the
 *  violet-to-ice fill with its glow, a 7 dp white head. */
export const Bar = ({f, bead = true, thin, style}: {f: number; bead?: boolean; thin?: boolean; style?: object}) => (
  <View style={[s.track, thin && s.thin, style]}>
    <View style={[s.fill, thin && s.thin, {width: `${Math.round(f * 100)}%`}]}>{bead ? <View style={s.bead} /> : null}</View>
  </View>
);

/** The kind tag: a film strip (warm) or a screen (cool) in a dark disc. */
const KindTag = ({show}: {show: boolean}) => (
  <View style={s.kind}>
    <Icon name={show ? 'series' : 'film'} size={9} color={show ? colors.kindSeries : colors.kindFilm} />
  </View>
);

/** No picture (or it failed): the title on a tinted tile, as the site does. */
const TitleTile = ({title, wide}: {title: string; wide?: boolean}) => (
  <View style={[StyleSheet.absoluteFill, s.tile]}>
    <Text style={[s.tileText, wide && {fontSize: 18}]} numberOfLines={3}>
      {title}
    </Text>
  </View>
);

export const PosterCard = memo(function PosterCard({
  item,
  onPress,
  onLongPress,
  width = POSTER_W,
  isNew,
}: {
  item: HeroItem;
  onPress?: (it: HeroItem) => void;
  onLongPress?: (it: HeroItem) => void;
  width?: number;
  isNew?: boolean;
}) {
  const h = Math.round((width * POSTER_H) / POSTER_W);
  const pic = item.poster || item.cover;
  const {src} = artSrc(pic, width);
  const [failed, setFailed] = useState(false);
  const f = progressOf(item);
  return (
    <Tap
      uiId="card.open"
      accessibilityRole="button"
      accessibilityLabel={item.title}
      onPress={() => onPress?.(item)}
      onLongPress={onLongPress ? () => onLongPress(item) : undefined}
      delayLongPress={380}
      style={[s.poster, {width, height: h}]}>
      {src && !failed ? (
        <Image source={src} style={[StyleSheet.absoluteFill, s.round]} resizeMode="cover" onError={() => setFailed(true)} fadeDuration={FADE_MS} />
      ) : (
        <TitleTile title={item.title} />
      )}
      <KindTag show={isShow(item)} />
      {isNew ? (
        <View style={s.newTag}>
          <Text style={s.newText}>NEW</Text>
        </View>
      ) : null}
      {f != null ? <Bar f={f} style={s.posterBar} /> : null}
    </Tap>
  );
});

export const FrameCard = memo(function FrameCard({
  item,
  onPress,
  onRemove,
  width = FRAME_W,
}: {
  item: HeroItem;
  onPress?: (it: HeroItem) => void;
  onRemove?: (it: HeroItem) => void;
  width?: number;
}) {
  const h = Math.round((width * FRAME_H) / FRAME_W);
  const ep = !!item.showId && item.type !== 'show';
  const prog = item.progress;
  // the moment you stopped on (the server cuts it), else the title's landscape art
  const canFrame = !!(prog && prog.position > 20 && item.id && !String(item.id).startsWith('torrent|'));
  const src = canFrame
    ? imgSrc(`/img/frame/${encodeURIComponent(item.id)}?t=${Math.floor(prog!.position)}`)
    : artSrc((!ep && item.backdrop) || item.cover || item.poster, width).src;
  const [failed, setFailed] = useState(false);
  const f = progressOf(item);
  const title = ep ? item.showTitle || item.title : item.title;
  const sub = ep && item.season != null && item.episode != null ? `S${item.season} E${item.episode} · ${item.title}` : null;
  const left = minutesLeft(item);
  return (
    <Tap
      uiId="card.open"
      accessibilityRole="button"
      accessibilityLabel={sub ? `${title}, ${sub}` : title}
      onPress={() => onPress?.(item)}
      style={[s.frame, {width, height: h}]}>
      {src && !failed ? (
        <Image source={src} style={[StyleSheet.absoluteFill, {borderRadius: 16}]} resizeMode="cover" onError={() => setFailed(true)} fadeDuration={FADE_MS} />
      ) : (
        <TitleTile title={title} wide />
      )}
      <View style={s.frameFade} pointerEvents="none" />
      <View style={s.frameText} pointerEvents="none">
        <Text style={s.frameTitle} numberOfLines={1}>
          {title}
        </Text>
        {sub ? (
          <Text style={s.frameSub} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
        {left ? (
          <Text style={s.frameLeft}>
            <Text style={s.frameLeftGlyph}>▶</Text>
            {'  '}
            {left}
          </Text>
        ) : null}
      </View>
      {f != null ? <Bar f={f} thin style={s.frameBar} /> : null}
      {onRemove ? (
        <Tap
          uiId="phone.home.remove"
          accessibilityRole="button"
          accessibilityLabel={`Remove ${title} from Continue Watching`}
          onPress={() => onRemove(item)}
          hitSlop={14}
          borderless
          style={s.remove}>
          <Text style={s.removeX}>✕</Text>
        </Tap>
      ) : null}
    </Tap>
  );
});

const s = StyleSheet.create({
  // NO overflow clipping on the cards: a rounded clip on every card of a shelf is a
  // clip-path per card per frame while it scrolls; the picture rounds itself
  // (Fresco draws it rounded) and nothing else on the card reaches its corners.
  // .card.poster on a phone: 12 round, a faint fill under the picture, no edge
  round: {borderRadius: 12},
  poster: {
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  tile: {alignItems: 'center', justifyContent: 'center', padding: 10, backgroundColor: 'rgba(110,90,220,0.28)', borderRadius: 12},
  tileText: {color: colors.text, fontSize: 14, fontWeight: '800', textAlign: 'center'},
  // .card-tag.kind: a 15 dp dark disc 6 in from the corner, the 9 dp icon, a hairline ring
  kind: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 15,
    height: 15,
    borderRadius: 7.5,
    backgroundColor: 'rgba(6,8,16,0.8)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // .card-new: the violet pill, 6 in
  newTag: {
    position: 'absolute',
    top: 6,
    left: 6,
    paddingHorizontal: 6,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#6c58ff',
    justifyContent: 'center',
    elevation: 3,
    shadowColor: '#6c58ff',
  },
  newText: {color: '#fff', fontSize: 8, fontWeight: '900', letterSpacing: 0.64},
  posterBar: {position: 'absolute', left: 12, right: 12, bottom: 10},
  track: {height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', justifyContent: 'center'},
  thin: {height: 2.5},
  fill: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.accent,
    experimental_backgroundImage: 'linear-gradient(90deg, #8b7bff, #a6c8ff)',
    boxShadow: '0 0 10px rgba(139,123,255,0.6)',
    justifyContent: 'center',
  },
  bead: {
    position: 'absolute',
    right: -3,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#fff',
    boxShadow: '0 0 8px rgba(255,255,255,0.9)',
  },
  // .card.wide: 16 round, the picture under a fade from the foot
  frame: {
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  frameFade: {
    ...StyleSheet.absoluteFill,
    borderRadius: 16,
    experimental_backgroundImage: 'linear-gradient(0deg, rgba(5,6,12,0.95) 0%, rgba(5,6,12,0.72) 24%, rgba(5,6,12,0.18) 52%, rgba(5,6,12,0) 68%)',
  },
  // .card.wide .card-label: 14 from the sides, 21 from the foot
  frameText: {position: 'absolute', left: 14, right: 14, bottom: 21},
  frameTitle: {color: '#fff', fontSize: 16.32, fontWeight: '800', letterSpacing: -0.16, lineHeight: 19.6},
  frameSub: {color: 'rgba(243,244,248,0.84)', fontSize: 11.84, fontWeight: '600', lineHeight: 14.2, marginTop: 1},
  frameLeft: {color: 'rgba(243,244,248,0.8)', fontSize: 11.84, fontWeight: '600', lineHeight: 14.2, marginTop: 3},
  frameLeftGlyph: {fontSize: 9.3},
  frameBar: {position: 'absolute', left: 14, right: 14, bottom: 11},
  // .card-remove: a 24 dp dark disc, 6 in from the corner
  remove: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeX: {color: colors.text, fontSize: 11.2, fontWeight: '800'},
});
