// Aurora Play on the PHONE — the pieces the four play screens (Wrapped, Pick
// for me, Taste, Pick together) are dressed in: the website's play layer
// (public/css/play.css, "night-sky arcade") at its phone size, built natively.
//
//   PlayRoom   the deeper sky a play screen stands in (one baked picture,
//              assets/play-room.png — tools/gen_phone_play.py — and five
//              stars that twinkle now and then)
//   Key        the three keys of a game: aurora (the step forward), gold (the
//              win — one per page, only where something was won), glass
//              (everything else), quiet (a word); a chunky bottom edge, a
//              press that squishes and springs back
//   Eyebrow, Chip, PlayCard, ty   the type and the small surfaces
//
// The kit under it is the TV's (../../play: tokens, anim, Burst, Meter,
// Odometer, SkyLines, Cards, the pure rules), so a game is one thing on every
// screen. Motion: transform and opacity on the native driver; calm (Android's
// "Remove animations", or a phone the app marks lite) shows every finished
// state at once.
import React, {useEffect, useRef} from 'react';
import {Animated, Image, StyleProp, StyleSheet, Text, TextStyle, View, ViewStyle, useWindowDimensions} from 'react-native';
import Tap from '../ui/Tap';
import {EASE, SPRING, tween, useTimers, useValue} from '../../play/anim';
import {GLOW_SRC, Star} from '../../play/Star';
import {PLAY} from '../../play/tokens';

export const ROOM_SRC = require('../assets/play-room.png');

// the website's fills (play.css --play-aurora / --play-goldfill / .play-card)
export const AURORA = 'linear-gradient(90deg, #5cf5b8 0%, #3ad3e6 45%, #a083ff 100%)';
export const GOLDFILL = 'linear-gradient(135deg, #fff2c2 0%, #ffd166 38%, #f0a23a 100%)';
export const CARD_FILL = 'linear-gradient(180deg, rgba(255,255,255,0.085) 0%, rgba(255,255,255,0.025) 100%)';
export const ROSE_KEY = 'linear-gradient(180deg, #ff9fd9 0%, #ff6fbf 100%)';
export const GREEN_KEY = 'linear-gradient(180deg, #7ff8c8 0%, #3fe3a3 100%)';

// ---------- the room ----------
const SPOTS: [number, number, number][] = [
  [0.08, 0.16, 9],
  [0.88, 0.1, 11],
  [0.3, 0.05, 8],
  [0.93, 0.56, 9],
  [0.05, 0.7, 10],
];

/** The play room: absolute, behind everything of the screen. `on` = the screen is in front. */
export function PlayRoom({on = true, calm = false}: {on?: boolean; calm?: boolean}) {
  const {width, height} = useWindowDimensions();
  const lights = useRef(SPOTS.map(() => new Animated.Value(0))).current;
  const timers = useTimers();
  useEffect(() => {
    if (!on || calm) return;
    let k = 0;
    let stop = () => {};
    let running: Animated.CompositeAnimation | null = null;
    const next = () => {
      const v = lights[k % lights.length];
      k += 2;
      v.setValue(0);
      running = Animated.sequence([tween(v, 1, 380), tween(v, 0, 520)]);
      running.start();
      stop = timers.after(2600 + ((k * 700) % 1900), next);
    };
    stop = timers.after(1200, next);
    return () => {
      stop();
      running?.stop();
      for (const v of lights) v.setValue(0);
    };
  }, [on, calm, lights, timers]);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" importantForAccessibility="no-hide-descendants">
      <Image source={ROOM_SRC} style={{width, height}} resizeMode="stretch" fadeDuration={0} />
      {calm
        ? null
        : SPOTS.map(([x, y, size], i) => (
            <Animated.Image
              key={i}
              source={GLOW_SRC}
              fadeDuration={0}
              style={{position: 'absolute', left: x * width, top: y * height, width: size, height: size, opacity: lights[i]}}
            />
          ))}
    </View>
  );
}

// ---------- type ----------
export const ty = StyleSheet.create({
  eyebrow: {color: PLAY.green, fontSize: 12.5, lineHeight: 16, fontWeight: '800', letterSpacing: 2.2, textTransform: 'uppercase', includeFontPadding: false},
  // .play-h1 at a phone: 2.2rem / 900, tight
  h1: {color: PLAY.ink, fontSize: 35, lineHeight: 37, fontWeight: '900', letterSpacing: -1.1, textAlign: 'center', includeFontPadding: false},
  // .play-h2: 1.6rem / 850
  h2: {color: PLAY.ink, fontSize: 25.6, lineHeight: 28, fontWeight: '900', letterSpacing: -0.6, textAlign: 'center', includeFontPadding: false},
  // .play-lede: 1.08rem, dim
  lede: {color: PLAY.inkDim, fontSize: 17, lineHeight: 24, textAlign: 'center'},
  small: {color: PLAY.inkDim, fontSize: 15, lineHeight: 21.5},
  gold: {color: PLAY.gold},
  soft: {color: 'rgba(232,228,255,0.6)'},
  num: {fontVariant: ['tabular-nums']},
});

/** The small spaced line over a heading ("YOUR NUMBER ONE"); `star` puts the kit's star before it. */
export function Eyebrow({children, star, color = PLAY.green, style}: {children: string; star?: boolean; color?: string; style?: StyleProp<ViewStyle>}) {
  return (
    <View style={[st.eyebrow, style]} accessibilityRole="header">
      {star ? <Star size={13} color={color} /> : null}
      <Text style={[ty.eyebrow, {color}]} numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

/** A small pill (.play-chip): "115 nights". */
export function Chip({label, gold, ghost, lead, style, textStyle}: {label: string; gold?: boolean; ghost?: boolean; lead?: React.ReactNode; style?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle>}) {
  return (
    <View style={[st.chip, ghost && st.chipGhost, gold && st.chipGold, style]}>
      {lead}
      <Text style={[st.chipText, gold && {color: PLAY.gold}, textStyle]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** A play surface (.play-card): a faint sheen, a hairline, rounded. */
export function PlayCard({children, style}: {children?: React.ReactNode; style?: StyleProp<ViewStyle>}) {
  return <View style={[st.card, style]}>{children}</View>;
}

// ---------- keys ----------
export type KeyKind = 'aurora' | 'gold' | 'glass' | 'quiet';

/** A press that squishes (90 ms) and springs back (420 ms) — the website's .play-press. */
export const usePress = (calm = false) => {
  const v = useValue(1);
  return {
    scale: v,
    onPressIn: () => {
      if (calm) return;
      tween(v, 0.93, 90).start();
    },
    onPressOut: () => {
      if (calm) return;
      tween(v, 1, 420, {easing: SPRING}).start();
    },
  };
};

export function Key({
  label,
  kind = 'glass',
  onPress,
  uiId,
  small,
  big,
  glyph,
  trailing,
  star,
  disabled,
  calm,
  style,
  accessibilityLabel,
}: {
  label: string;
  kind?: KeyKind;
  onPress: () => void;
  uiId?: string;
  small?: boolean;
  big?: boolean;
  glyph?: string; // a sign before the words (▶)
  trailing?: string; // a sign after the words (↻)
  star?: boolean;
  disabled?: boolean;
  calm?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const press = usePress(calm);
  const ink = kind === 'gold' ? PLAY.goldInk : kind === 'aurora' ? '#04131a' : kind === 'quiet' ? PLAY.inkDim : PLAY.ink;
  return (
    <Tap
      uiId={uiId}
      flat
      rippleColor="rgba(0,0,0,0)"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      accessibilityState={{disabled: !!disabled}}
      disabled={disabled}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={style}>
      <Animated.View
        style={[
          st.key,
          small && st.keySmall,
          big && st.keyBig,
          kind === 'gold' ? st.gold : kind === 'aurora' ? st.aurora : kind === 'quiet' ? st.quiet : st.glass,
          disabled && st.off,
          {transform: [{scale: press.scale}]},
        ]}>
        {star ? <Star size={small ? 13 : 16} color={kind === 'glass' || kind === 'quiet' ? PLAY.gold : ink} /> : null}
        {glyph ? <Text style={[st.keyText, small && st.keyTextSmall, big && st.keyTextBig, {color: ink}]}>{glyph}</Text> : null}
        <Text style={[st.keyText, small && st.keyTextSmall, big && st.keyTextBig, {color: ink}]} numberOfLines={1}>
          {label}
        </Text>
        {trailing ? <Text style={[st.keyText, st.trailing, {color: ink}]}>{trailing}</Text> : null}
      </Animated.View>
    </Tap>
  );
}

/** A round glass icon key of the story's frame (pause, close): 44 round. */
export function RoundKey({glyph, onPress, label, uiId, size = 44}: {glyph: React.ReactNode; onPress: () => void; label: string; uiId?: string; size?: number}) {
  const press = usePress();
  return (
    <Tap uiId={uiId} flat rippleColor="rgba(0,0,0,0)" accessibilityRole="button" accessibilityLabel={label} onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut} hitSlop={8}>
      <Animated.View style={[st.round, {width: size, height: size, borderRadius: size / 2, transform: [{scale: press.scale}]}]}>
        {typeof glyph === 'string' ? <Text style={st.roundGlyph}>{glyph}</Text> : glyph}
      </Animated.View>
    </Tap>
  );
}

/** A chunky game chip (.pg-chip): a thick pill with a bottom edge; the chosen one lit and pressed in. */
export function GameChip({label, on, onPress, uiId, small, disabled}: {label: string; on?: boolean; onPress: () => void; uiId?: string; small?: boolean; disabled?: boolean}) {
  const press = usePress();
  return (
    <Tap
      uiId={uiId}
      flat
      rippleColor="rgba(0,0,0,0)"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{selected: !!on, disabled: !!disabled}}
      disabled={disabled}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={st.chunkHit}>
      <Animated.View style={[st.chunk, small && st.chunkSmall, on ? st.chunkOn : null, disabled && st.off, {transform: [{scale: press.scale}]}]}>
        <Text style={[st.chunkText, small && st.chunkTextSmall, on && st.chunkTextOn]} numberOfLines={2}>
          {label}
        </Text>
      </Animated.View>
    </Tap>
  );
}

// ---------- arrival ----------
/** Comes up into place after `delay` (the website's [data-in]); calm: simply there. */
export function In({
  children,
  delay = 0,
  ms = 520,
  dy = 16,
  pop,
  fade,
  drop,
  calm,
  run = 1,
  style,
}: {
  children?: React.ReactNode;
  delay?: number;
  ms?: number;
  dy?: number;
  pop?: boolean; // arrives from a little smaller, with an overshoot
  fade?: boolean; // only fades
  drop?: boolean; // falls into place from above
  calm?: boolean;
  run?: unknown;
  style?: StyleProp<ViewStyle>;
}) {
  const v = useValue(calm ? 1 : 0);
  useEffect(() => {
    if (calm) {
      v.setValue(1);
      return;
    }
    v.setValue(0);
    const a = tween(v, 1, pop ? 620 : ms, {delay, easing: pop || drop ? SPRING : EASE});
    a.start();
    return () => a.stop();
  }, [v, calm, delay, ms, pop, drop, run]);
  const opacity = v.interpolate({inputRange: [0, 0.4, 1], outputRange: [0, 1, 1], extrapolate: 'clamp'});
  const transform = fade
    ? []
    : pop
    ? [{scale: v.interpolate({inputRange: [0, 1], outputRange: [0.82, 1]})}]
    : drop
    ? [{translateY: v.interpolate({inputRange: [0, 1], outputRange: [-46, 0]})}]
    : [{translateY: v.interpolate({inputRange: [0, 1], outputRange: [dy, 0]})}];
  return <Animated.View style={[style, {opacity, transform}]}>{children}</Animated.View>;
}

const st = StyleSheet.create({
  eyebrow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 34,
    paddingHorizontal: 13,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: PLAY.line,
    backgroundColor: PLAY.glass,
  },
  chipGhost: {backgroundColor: 'rgba(0,0,0,0.2)'},
  chipGold: {borderColor: 'rgba(255,209,102,0.45)', backgroundColor: 'rgba(255,209,102,0.12)'},
  chipText: {color: PLAY.ink, fontSize: 13.6, fontWeight: '800', includeFontPadding: false},
  card: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: PLAY.line,
    backgroundColor: 'rgba(14,13,36,0.55)',
    experimental_backgroundImage: CARD_FILL,
  },
  key: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 50,
    paddingHorizontal: 24,
    borderRadius: 999,
  },
  keySmall: {minHeight: 40, paddingHorizontal: 16, gap: 7},
  keyBig: {minHeight: 56, paddingHorizontal: 30},
  glass: {borderWidth: 1, borderColor: PLAY.line, backgroundColor: 'rgba(20,18,44,0.72)', experimental_backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.04) 100%)'},
  quiet: {backgroundColor: 'transparent'},
  // the arcade edge: a lit top line, a darker bottom (the website's inset shadows), and the glow under it
  gold: {
    backgroundColor: PLAY.gold,
    experimental_backgroundImage: GOLDFILL,
    borderBottomWidth: 3,
    borderBottomColor: 'rgba(170,96,10,0.55)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.7)',
    boxShadow: '0 12px 26px -10px rgba(255,180,70,0.75)',
  },
  aurora: {
    backgroundColor: PLAY.teal,
    experimental_backgroundImage: AURORA,
    borderBottomWidth: 3,
    borderBottomColor: 'rgba(0,50,70,0.4)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.55)',
    boxShadow: '0 12px 26px -12px rgba(58,211,230,0.75)',
  },
  off: {opacity: 0.45},
  keyText: {color: PLAY.ink, fontSize: 16, lineHeight: 21, fontWeight: '800', letterSpacing: 0.1, includeFontPadding: false},
  keyTextSmall: {fontSize: 14, lineHeight: 19},
  keyTextBig: {fontSize: 18, lineHeight: 23},
  trailing: {fontSize: 19},
  round: {alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.1)'},
  chunkHit: {maxWidth: '100%'},
  chunk: {
    minHeight: 40,
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    borderBottomWidth: 3,
    borderBottomColor: 'rgba(0,0,0,0.35)',
    backgroundColor: 'rgba(40,36,84,0.6)',
  },
  chunkSmall: {minHeight: 36, paddingVertical: 7, paddingHorizontal: 14},
  chunkOn: {backgroundColor: '#f2efff', borderColor: '#ffffff', borderBottomColor: 'rgba(120,100,200,0.5)', transform: [{translateY: 1}]},
  chunkText: {color: PLAY.inkDim, fontSize: 14, fontWeight: '800', textAlign: 'center'},
  chunkTextSmall: {fontSize: 13.4},
  chunkTextOn: {color: '#1a1640'},
  roundGlyph: {color: PLAY.ink, fontSize: 20, lineHeight: 24, fontWeight: '700', includeFontPadding: false},
});
