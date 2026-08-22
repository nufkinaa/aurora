// The pill family: `.cat-pill` (screens.css:411-419) and the surface chips
// `.picker-btn` / `.chip` (screens.css:440-450).
//
// One padding rule, per findings ★5: RULE A-2 at ×1.0 on the site's OWN padding,
// with 48dp as a floor. The spec had three incompatible methods for this — a
// re-derivation from the 48dp floor at the site's ratio, a different formula in
// §4.4, and a third set of literals in §4.5. The literals it invented (24, 22, 41,
// 20) are struck.
//
// Selected and focused are INDEPENDENT and can co-occur (§5.5). When both, the
// fill stays white and the shadow deepens — there is no third colour.
import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Focusable from './Focusable';
import theme from '../theme';

const {colors, radius} = theme;

export default function Chip({
  label,
  on,
  bare,
  hasTVPreferredFocus,
  edgeLeft,
  onPress,
  onFocusChange,
  ref,
}: {
  label: string;
  // `.chip.on` / `.cat-pill.on` — a white fill with dark text, which is the one
  // selected language the whole site uses.
  on?: boolean;
  // `.cat-pill` is transparent until it is the active one; the other chips carry
  // a --surface fill and a --line edge at rest.
  bare?: boolean;
  hasTVPreferredFocus?: boolean;
  edgeLeft?: boolean;
  onPress: () => void;
  // Bubbled straight from the Focusable — Browse reads it to know focus is back
  // in the filter bands (its collapsed header re-expands on that).
  onFocusChange?: (focused: boolean) => void;
  ref?: React.Ref<unknown>;
}) {
  return (
    <Focusable
      round
      ref={ref as never}
      // A white fill needs the ring held off it by a --bg gap, or a white ring on
      // white is invisible from the sofa (§4.1).
      light={on}
      hasTVPreferredFocus={hasTVPreferredFocus}
      edgeLeft={edgeLeft}
      onFocusChange={onFocusChange}
      onPress={onPress}
      style={[bare ? styles.bare : styles.surface, on && styles.on, bare && on && styles.barOnLift]}>
      {/* `.picker-btn`'s 1dp --line edge, as an absolutely-positioned child —
          NOT a border on the Focusable itself. A border there replaces the 3dp
          the ring is drawn inside, so the ring ends up painted over its own
          hairline. Same shape as Btn.tsx's rest-state edge. */}
      {!bare && !on ? <View style={styles.edge} pointerEvents="none" /> : null}
      <Text style={[bare ? styles.bareText : styles.text, on && styles.onText]} numberOfLines={1}>
        {label}
      </Text>
    </Focusable>
  );
}

const styles = StyleSheet.create({
  // `.cat-pill { padding: 9px 18px }`, height 40.8 natural → the 48dp floor bites.
  bare: {
    minHeight: 48,
    justifyContent: 'center',
    paddingVertical: 9,
    paddingHorizontal: 18,
    borderRadius: radius.pill,
    backgroundColor: 'transparent',
  },
  // `.picker-btn { padding: 8px 16px }`, height 36.4 natural → floor 48.
  surface: {
    minHeight: 48,
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  edge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.pill,
  },
  on: {backgroundColor: colors.white},
  // `.cat-pill.on` alone carries this (screens.css:427-431); the surface `.chip`
  // does not. It is what lifts the selected category off the strip.
  barOnLift: {boxShadow: '0 4px 14px rgba(0,0,0,0.35)'},
  // 0.95rem = 15.2 → 15, raised to 16 because `--text-faint` is 3.53:1 on the page
  // and the policy forbids it below 16dp (§3.6(a), P14).
  bareText: {color: colors.textFaint, fontSize: 16, fontWeight: '800'},
  text: {color: colors.text, fontSize: 16, fontWeight: '700'},
  onText: {color: colors.bg},
});
