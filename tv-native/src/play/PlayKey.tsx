// Aurora Play — the three keys of a game.
//
//   aurora  the step forward  ("Find me something", "Deal the cards", "Keep going")
//   gold    the win           ("Open", "Play", "Done" at the end of a round)
//   glass   everything else   ("Another one", "Undo", "Skip")
//
// One per kind at most on a page, and gold only where something was won.
//
// Focus is the app's own and nothing else: the white ring and the small scale
// (components/Focusable). On the two bright faces the ring stands off the key
// by a dark gap, as on the app's white Play key, so it reads on any colour.
//
// A key that changes its meaning (the draw's "Thinking…" that becomes "Open")
// is this same mounted key with another `kind` and `label`: focus never moves.
import React, {useState} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import Focusable from '../components/Focusable';
import {trail} from '../trail'; // [report trail]
import {Star} from './Star';
import {PLAY} from './tokens';

export const RIBBON_SRC = require('../assets/play-ribbon.png');
export const GOLD_SRC = require('../assets/play-gold.png');

export type KeyKind = 'aurora' | 'gold' | 'glass';

export default function PlayKey({
  label,
  kind = 'glass',
  glyph,
  star,
  leading,
  small,
  big,
  dim,
  hasTVPreferredFocus,
  edgeLeft,
  onPress,
  onFocusChange,
  uiId,
  accessibilityLabel,
  ref,
}: {
  uiId?: string; // [analytics] which control this is (Focusable.uiId)
  label: string;
  kind?: KeyKind;
  glyph?: string; // a sign before the words ("↺"), in the label's colour
  star?: boolean; // the kit's star before the words
  leading?: React.ReactNode;
  small?: boolean;
  big?: boolean; // the one key of a page (the draw's, the result's)
  dim?: boolean; // still in focus, reads as "not yet"
  hasTVPreferredFocus?: boolean;
  edgeLeft?: boolean;
  onPress: () => void;
  onFocusChange?: (focused: boolean) => void;
  accessibilityLabel?: string;
  ref?: React.Ref<unknown>;
}) {
  const [focused, setFocused] = useState(false);
  const bright = kind !== 'glass';
  const ink = kind === 'aurora' ? PLAY.auroraInk : kind === 'gold' ? PLAY.goldInk : PLAY.ink;
  return (
    <Focusable
      round
      ref={ref as never}
      light={bright}
      ring="white"
      hasTVPreferredFocus={hasTVPreferredFocus}
      edgeLeft={edgeLeft}
      uiId={uiId}
      accessibilityLabel={accessibilityLabel || label}
      onFocusChange={f => {
        setFocused(f);
        onFocusChange?.(f);
      }}
      onPress={uiId ? onPress : () => {
        trail('tap', {r: 'button', l: label.slice(0, 40)}); // [report trail]
        onPress();
      }}
      style={[
        styles.key,
        small && styles.small,
        big && styles.big,
        kind === 'aurora' ? styles.aurora : kind === 'gold' ? styles.gold : focused ? styles.glassOn : styles.glass,
      ]}>
      {bright ? (
        // The face: a baked picture stretched over the whole key, the ring's
        // reserved edge included, clipped to the pill by its own holder.
        <View style={styles.face} pointerEvents="none">
          <Image source={kind === 'aurora' ? RIBBON_SRC : GOLD_SRC} resizeMode="stretch" fadeDuration={0} style={styles.faceImg} />
          {dim ? <View style={styles.faceDim} /> : null}
        </View>
      ) : !focused ? (
        <View style={styles.hairline} pointerEvents="none" />
      ) : null}
      {leading}
      {star ? <Star size={small ? 13 : big ? 18 : 15} color={bright ? ink : PLAY.gold} /> : null}
      {glyph ? <Text style={[styles.label, small && styles.labelSmall, big && styles.labelBig, {color: ink}]}>{glyph}</Text> : null}
      <Text
        style={[styles.label, small && styles.labelSmall, big && styles.labelBig, {color: ink}, dim && !bright && styles.labelDim]}
        numberOfLines={1}>
        {label}
      </Text>
    </Focusable>
  );
}

const EDGE = 3; // Focusable's reserved ring edge

const styles = StyleSheet.create({
  key: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 22,
    minHeight: 42,
    borderRadius: 999,
  },
  small: {paddingVertical: 6, paddingHorizontal: 14, minHeight: 34, gap: 6},
  big: {paddingVertical: 11, paddingHorizontal: 30, minHeight: 50, gap: 10},
  // the colour under the picture (what shows for the instant before it is drawn)
  aurora: {backgroundColor: PLAY.teal},
  gold: {backgroundColor: PLAY.gold},
  glass: {backgroundColor: PLAY.glass},
  glassOn: {backgroundColor: PLAY.glassHi},
  face: {position: 'absolute', top: -EDGE, left: -EDGE, right: -EDGE, bottom: -EDGE, borderRadius: 999, overflow: 'hidden'},
  faceImg: {width: '100%', height: '100%'},
  faceDim: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(3,4,12,0.45)'},
  hairline: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderWidth: 1, borderColor: PLAY.line, borderRadius: 999},
  label: {fontSize: 15, lineHeight: 22, fontWeight: '800', letterSpacing: 0.16, includeFontPadding: false},
  labelSmall: {fontSize: 13, lineHeight: 19},
  labelBig: {fontSize: 18, lineHeight: 25},
  labelDim: {color: PLAY.inkDim},
});
