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
import {colors, FRAME_H, FRAME_W, POSTER_H, POSTER_W, radius} from '../theme';

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

export const Bar = ({f, bead = true, style}: {f: number; bead?: boolean; style?: object}) => (
  <View style={[s.track, style]}>
    <View style={[s.fill, {width: `${Math.round(f * 100)}%`}]}>{bead ? <View style={s.bead} /> : null}</View>
  </View>
);

/** The kind tag: a film strip (warm) or a screen (cool) in a dark disc. */
const KindTag = ({show}: {show: boolean}) => (
  <View style={s.kind}>
    <Icon name={show ? 'series' : 'film'} size={13} color={show ? colors.kindSeries : colors.kindFilm} />
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
      accessibilityRole="button"
      accessibilityLabel={item.title}
      onPress={() => onPress?.(item)}
      onLongPress={onLongPress ? () => onLongPress(item) : undefined}
      delayLongPress={380}
      style={[s.poster, {width, height: h}]}>
      {src && !failed ? (
        <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setFailed(true)} fadeDuration={150} />
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
      accessibilityRole="button"
      accessibilityLabel={sub ? `${title}, ${sub}` : title}
      onPress={() => onPress?.(item)}
      style={[s.frame, {width, height: h}]}>
      {src && !failed ? (
        <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setFailed(true)} fadeDuration={150} />
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
        {left ? <Text style={s.frameLeft}>▶  {left}</Text> : null}
        {f != null ? <Bar f={f} style={{marginTop: 10}} /> : null}
      </View>
      {onRemove ? (
        <Tap
          accessibilityRole="button"
          accessibilityLabel={`Remove ${title} from Continue Watching`}
          onPress={() => onRemove(item)}
          borderless
          style={s.remove}>
          <Icon name="close" size={18} color={colors.text} />
        </Tap>
      ) : null}
    </Tap>
  );
});

const s = StyleSheet.create({
  poster: {
    borderRadius: radius.l,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  tile: {alignItems: 'center', justifyContent: 'center', padding: 10, backgroundColor: 'rgba(110,90,220,0.28)'},
  tileText: {color: colors.text, fontSize: 15, fontWeight: '800', textAlign: 'center'},
  kind: {
    position: 'absolute',
    top: 7,
    right: 7,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(8,9,16,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  newTag: {
    position: 'absolute',
    top: 7,
    left: 7,
    paddingHorizontal: 8,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#6c58ff',
    justifyContent: 'center',
  },
  newText: {color: '#fff', fontSize: 11, fontWeight: '900', letterSpacing: 1},
  posterBar: {position: 'absolute', left: 10, right: 10, bottom: 10},
  track: {height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.28)', justifyContent: 'center'},
  fill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.accent,
    experimental_backgroundImage: 'linear-gradient(90deg, #6c58ff, #a99bff)',
    justifyContent: 'center',
  },
  bead: {
    position: 'absolute',
    right: -5,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#fff',
  },
  frame: {
    borderRadius: radius.xl,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  frameFade: {
    ...StyleSheet.absoluteFill,
    experimental_backgroundImage: 'linear-gradient(180deg, rgba(5,6,12,0) 35%, rgba(5,6,12,0.55) 62%, rgba(5,6,12,0.92) 100%)',
  },
  frameText: {position: 'absolute', left: 14, right: 14, bottom: 12},
  frameTitle: {color: '#fff', fontSize: 20, fontWeight: '800'},
  frameSub: {color: 'rgba(255,255,255,0.86)', fontSize: 14, fontWeight: '600', marginTop: 2},
  frameLeft: {color: 'rgba(255,255,255,0.86)', fontSize: 14, fontWeight: '600', marginTop: 4},
  remove: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(8,9,16,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
