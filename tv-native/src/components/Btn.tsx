// `.btn` and `.btn-primary` (components.css:108-152), the two button shapes the
// whole app uses.
//
// P3, and the arithmetic matters because the pin's own first version got it
// wrong: `.btn` sets NO line-height, so it inherits `base.css:12`'s 1.5 — 16 × 1.5
// = 24, and 13 + 24 + 13 = ~50dp natural. `minHeight: 48` is the FLOOR, not the
// product. In RN a 16dp Roboto line box is ~19-20dp, so without the explicit
// `lineHeight: 24` a button lands at ~45-46dp and genuinely needs the floor —
// which is why both are written out.
import React, {useState} from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Svg, {Defs, LinearGradient, Rect, Stop} from 'react-native-svg';
import Focusable from './Focusable';
import Icon, {IconName} from './Icon';
import theme from '../theme';

const {colors, radius} = theme;

export default function Btn({
  label,
  icon,
  glyph,
  leading,
  primary,
  small,
  dim,
  hasTVPreferredFocus,
  edgeLeft,
  onPress,
  onFocusChange,
  ref,
}: {
  label: string;
  icon?: IconName;
  // An emoji drawn as its own flex child, which is how the site writes the two
  // buttons that have one (`browse.js:531` — `🎲 <span>Surprise me</span>`), so
  // it takes the 10dp gap rather than a text space.
  glyph?: string;
  // Anything drawn where the icon goes. The load-more button's `.mini-spinner`
  // is the case: `browse.js:396-398` swaps the button's CHILDREN and never the
  // button, so the focus you pressed it with survives paging.
  leading?: React.ReactNode;
  // `.btn-primary` — Play and Stream, and nothing else. It is the ONLY violet
  // focus treatment in the app; if a second one appears it is a bug (§5.3).
  primary?: boolean;
  // `.btn.small` (components.css:229-230): 9/18 at 0.9rem. Natural height 39.6,
  // so the 48dp floor bites here too.
  small?: boolean;
  // `.load-more.busy` (screens.css:1249-1251) — still focusable, reads as busy.
  dim?: boolean;
  hasTVPreferredFocus?: boolean;
  edgeLeft?: boolean;
  onPress: () => void;
  onFocusChange?: (focused: boolean) => void;
  ref?: React.Ref<unknown>;
}) {
  // The rest-state hairline is `box-shadow: inset 0 0 0 1px rgba(255,255,255,.07)`
  // and `:focus` replaces the box-shadow WHOLESALE (components.css:117, :132-134),
  // so the hairline goes while the ring is up. Transcribed literally. A handful of
  // buttons hold focus state; the no-re-render rule is about the ninety cards.
  const [focused, setFocused] = useState(false);
  return (
    <Focusable
      round
      ref={ref as never}
      light={primary}
      ring={primary ? 'violet' : 'white'}
      hasTVPreferredFocus={hasTVPreferredFocus}
      edgeLeft={edgeLeft}
      onFocusChange={f => {
        setFocused(f);
        onFocusChange?.(f);
      }}
      onPress={onPress}
      style={[styles.btn, small && styles.small, primary ? styles.primary : styles.surface]}>
      {primary ? (
        // "Soft top-light: reads as a physical white key, not a flat fill"
        // (components.css:143) — #ffffff → #eceef7, top to bottom.
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          <Defs>
            <LinearGradient id="btnKey" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#ffffff" />
              <Stop offset="1" stopColor="#eceef7" />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" rx={999} fill="url(#btnKey)" />
        </Svg>
      ) : null}
      {!primary && !focused ? <View style={styles.hairline} pointerEvents="none" /> : null}
      {leading}
      {icon ? (
        <Icon name={icon} size={20} color={primary ? colors.bg : colors.text} />
      ) : null}
      {glyph ? <Text style={small ? styles.labelSmall : styles.label}>{glyph}</Text> : null}
      <Text
        style={[
          styles.label,
          small && styles.labelSmall,
          primary && styles.labelPrimary,
          dim && styles.labelDim,
        ]}
        numberOfLines={1}>
        {label}
      </Text>
    </Focusable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 26,
    minHeight: 48,
    borderRadius: radius.pill,
  },
  // 0.9rem = 14.4 -> 14 at the reading floor; lh 1.5 x 14 = 21. The label is
  // --text, so P14's 16dp faint-colour floor does not apply.
  small: {paddingVertical: 9, paddingHorizontal: 18},
  surface: {backgroundColor: colors.surface},
  // The gradient is drawn as a child, so the fill underneath only shows through
  // the pill's own corners while the SVG rasterises.
  primary: {backgroundColor: '#ffffff', boxShadow: '0 8px 24px rgba(0,0,0,0.38)'},
  hairline: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: radius.pill,
  },
  // 1rem at 0.01em tracking; lineHeight from base.css:12's 1.5.
  label: {color: colors.text, fontSize: 16, lineHeight: 24, fontWeight: '700', letterSpacing: 0.16},
  labelSmall: {fontSize: 14, lineHeight: 21},
  labelPrimary: {color: colors.bg},
  labelDim: {color: colors.textDim},
});
