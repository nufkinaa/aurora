// The picture above the scrub point: one tile of the server's sheet
// (scrubPreview.ts), the time under it. The TV's scrubber, the phone's
// scrubber and the phone's sideways seek drag all draw this one.
//
// The tile is a clipped box with the WHOLE sheet behind it, moved so the
// wanted tile shows through: the sheet is fetched once and every second of
// its ~16 minutes is a change of position, not a new picture.
import React, {useEffect} from 'react';
import {Image, NativeModules, StyleProp, StyleSheet, Text, View, ViewStyle} from 'react-native';
import type {ImgSource} from '../api';
import {isLowRam} from '../perfTier';
import {ScrubIndex, sheetsToWarm, tileLayout, WARM_SHEETS, WARM_SHEETS_LOW_RAM} from './scrubPreview';

/** The edge around the picture (dp). */
export const THUMB_EDGE = 1.5;

const fmt = (s: number) => {
  const a = Math.max(0, Math.floor(s));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const sec = a % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
};

// The sheets are fetched AND decoded ahead, with the session headers a
// closed server needs (artPrefetch.ts's native module, android
// ArtPrefetchModule.kt: React Native's Image.prefetch sends no headers). The
// request it builds is keyed like an <Image resizeMethod="auto"> of the same
// address, which is how the tile below is drawn — so a warmed sheet draws at once.
type Native = {prefetch: (uri: string, headers: Record<string, string> | null) => Promise<string>};
const native = (NativeModules as {AuroraArt?: Native}).AuroraArt;
const warmed = new Set<string>();

export function warmScrubSheet(src: ImgSource | null | undefined) {
  if (!src || !src.uri || warmed.has(src.uri)) return;
  warmed.add(src.uri);
  if (native) {
    native.prefetch(src.uri, src.headers || null).then(
      r => {
        if (r === 'fail') warmed.delete(src.uri);
      },
      () => warmed.delete(src.uri),
    );
  } else if (!src.headers) {
    Image.prefetch(src.uri).catch(() => warmed.delete(src.uri));
  }
}

/** The sheet under `t` and its neighbours (fewer on a low-memory box). */
export function warmScrubAround(index: ScrubIndex, sources: (ImgSource | null)[], t: number, dir = 0) {
  for (const n of sheetsToWarm(index, t, dir, isLowRam() ? WARM_SHEETS_LOW_RAM : WARM_SHEETS)) warmScrubSheet(sources[n]);
}

/** A video's index with its sheets' <Image> sources (what the players pass around). */
export type ScrubPics = {index: ScrubIndex; sources: (ImgSource | null)[]};

export type ScrubThumbProps = {
  index: ScrubIndex;
  /** the sheets' <Image> sources, made once when the index arrived (api.ts imgSrc) */
  sources: (ImgSource | null)[];
  /** the second to show */
  t: number;
  /** the picture's drawn width (dp); its height keeps the tile's aspect */
  width: number;
  /** the time under the picture (default on) */
  showTime?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** The whole thing's width with its edge: what to centre on the scrub point. */
export const thumbOuterWidth = (width: number) => width + 2 * THUMB_EDGE;

export default function ScrubThumb({index, sources, t, width, showTime = true, style}: ScrubThumbProps) {
  const l = tileLayout(index, t, width);
  const src = sources[l.tile.sheet] || null;
  // moving into another sheet: have the ones beyond it ready too
  useEffect(() => {
    warmScrubAround(index, sources, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, sources, l.tile.sheet]);
  return (
    <View style={[s.wrap, style]} pointerEvents="none">
      <View style={[s.box, {width: l.boxW + 2 * THUMB_EDGE, height: l.boxH + 2 * THUMB_EDGE}]}>
        {src ? (
          <Image
            source={src}
            fadeDuration={0}
            resizeMode="stretch"
            style={{position: 'absolute', left: l.left, top: l.top, width: l.sheetW, height: l.sheetH}}
          />
        ) : null}
      </View>
      {showTime ? <Text style={s.time}>{fmt(t)}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {alignItems: 'center'},
  box: {
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: THUMB_EDGE,
    borderColor: 'rgba(255,255,255,0.75)',
    // (no shadow: this box moves up to 30 times a second on a weak TV)
    backgroundColor: '#05060c',
  },
  time: {
    marginTop: 4,
    color: '#ffffff',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 6,
  },
});
