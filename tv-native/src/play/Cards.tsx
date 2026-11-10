// Aurora Play — the pieces of a card deck (Taste, Pick together): the stamp
// that is slammed on a card, the plates under the top two cards, the stand-in
// for a title without a poster, and the answer's label beside the card.
import React from 'react';
import {Animated, Image, StyleSheet, Text, View, ViewStyle, StyleProp} from 'react-native';
import {layerAt, platesOf} from './deck';
import {Star} from './Star';
import {PLAY} from './tokens';

export const SHADE_SRC = require('../assets/play-shade.png');
export const BACK_SRC = require('../assets/play-back.png');

// LOVE / NOPE / YES / NO / MAYBE: thick, tilted, in the answer's colour, on a
// dark plate so it reads on any poster.
export function Stamp({label, color, tilt = 0, size = 30}: {label: string; color: string; tilt?: number; size?: number}) {
  return (
    <View style={[styles.stamp, {borderColor: color, transform: [{rotate: `${tilt}deg`}]}]}>
      <Text style={[styles.stampText, {color, fontSize: size, lineHeight: Math.round(size * 1.15)}]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

// The deck under the two real cards: two plates, then one, then none as the
// cards run out (`left` = cards still to answer, the top one included).
export function Plates({left, width, height, radius = 18}: {left: number; width: number; height: number; radius?: number}) {
  const n = platesOf(left);
  if (!n) return null;
  const a = layerAt(1, height);
  const b = layerAt(2, height);
  return (
    <>
      {n > 1 ? (
        <View
          pointerEvents="none"
          style={[styles.plate, {width, height, borderRadius: radius, backgroundColor: PLAY.plateLow, transform: [{translateY: b.translateY}, {scale: b.scale}]}]}
        />
      ) : null}
      <View
        pointerEvents="none"
        style={[styles.plate, {width, height, borderRadius: radius, backgroundColor: PLAY.plate, transform: [{translateY: a.translateY}, {scale: a.scale}]}]}
      />
    </>
  );
}

// A title without a poster: a tile in the card's colours with the title on it
// (the website's drawn stand-in).
export function Tile({title, style, size = 20}: {title?: string; style?: StyleProp<ViewStyle>; size?: number}) {
  return (
    <View style={[styles.tile, style]}>
      <Star size={Math.round(size * 1.4)} color="rgba(232,228,255,0.3)" />
      {title ? (
        <Text style={[styles.tileText, {fontSize: size, lineHeight: Math.round(size * 1.25)}]} numberOfLines={4}>
          {title}
        </Text>
      ) : null}
    </View>
  );
}

// The foot of a card: the baked shade, so a title can sit on a poster.
export function Shade({height}: {height: number | `${number}%`}) {
  return <Image source={SHADE_SRC} resizeMode="stretch" fadeDuration={0} style={[styles.shade, {height}]} />;
}

// An answer's label beside the card ("◀ Not for me"): not a key — the card is
// what is in focus — but it lights when its key is pressed. `hit` is a value
// the screen pulses 0 -> 1 -> 0.
export function Answer({
  glyph,
  label,
  color,
  hit,
  side,
}: {
  glyph: string;
  label: string;
  color: string;
  hit: Animated.Value;
  side: 'left' | 'right' | 'down';
}) {
  const scale = hit.interpolate({inputRange: [0, 1], outputRange: [1, 1.14]});
  const lit = hit.interpolate({inputRange: [0, 1], outputRange: [0, 1]});
  return (
    <View style={[styles.answer, side === 'down' && styles.answerDown]} pointerEvents="none">
      <Animated.View style={[styles.disc, side === 'down' && styles.discSmall, {borderColor: color, transform: [{scale}]}]}>
        <Animated.View style={[styles.discFill, {backgroundColor: color, opacity: lit}]} />
        <Text style={[styles.discGlyph, side === 'down' && styles.discGlyphSmall, {color}]}>{glyph}</Text>
      </Animated.View>
      <Text style={styles.answerLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stamp: {
    borderWidth: 4,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 3,
    backgroundColor: 'rgba(3,4,12,0.62)',
  },
  stampText: {fontWeight: '900', letterSpacing: 2, includeFontPadding: false},
  plate: {position: 'absolute', left: 0, top: 0, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)'},
  tile: {
    backgroundColor: PLAY.tile,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    gap: 12,
  },
  tileText: {color: PLAY.ink, fontWeight: '800', textAlign: 'center'},
  shade: {position: 'absolute', left: 0, right: 0, bottom: 0, width: '100%'},
  answer: {alignItems: 'center', gap: 8, width: 120},
  answerDown: {flexDirection: 'row', width: undefined, gap: 10},
  disc: {
    width: 54,
    height: 54,
    borderRadius: 27,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
  },
  discSmall: {width: 34, height: 34, borderRadius: 17},
  discFill: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0},
  discGlyph: {fontSize: 22, lineHeight: 28, fontWeight: '900', includeFontPadding: false},
  discGlyphSmall: {fontSize: 14, lineHeight: 18},
  answerLabel: {color: PLAY.inkDim, fontSize: 14, lineHeight: 19, fontWeight: '800'},
});
