// The pill family: `.cat-pill` (screens.css:411-419) and the surface chips
// `.picker-btn` / `.chip` (screens.css:440-450).
//
// One padding rule, per findings ★5: RULE A-2 at ×1.0 on the site's OWN padding,
// with 48dp as a floor. The spec had three incompatible methods for this — a
// re-derivation from the 48dp floor at the site's ratio, a different formula in
// §4.4, and a third set of literals in §4.5. The literals it invented (24, 22, 41,
// 20) are struck.
//
// Selected and focused are INDEPENDENT and can co-occur (§5.5). CHOSEN is the
// glass's well - a darker capsule pressed in, the word in the accent mixed with
// white (glass.ts, docs/glass-tv.md); FOCUSED is the white ring, as ever. Chosen
// used to be a white fill with dark text, the same white the rail and the
// buttons use for "focused": with the well, white means focus and nothing else.
import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Focusable from './Focusable';
import {ink, well} from '../glass';
import theme from '../theme';

const {colors, radius} = theme;

export default function Chip({
  label,
  on,
  bare,
  small,
  hasTVPreferredFocus,
  edgeLeft,
  onPress,
  onFocusChange,
  uiId,
  ref,
}: {
  uiId?: string; // [analytics] which control this is (Focusable.uiId)
  label: string;
  // `.chip.on` / `.cat-pill.on` — the chosen one: a well, the word in ink.on.
  on?: boolean;
  // `.cat-pill` is transparent until it is the active one; the other chips carry
  // a --surface fill and a --line edge at rest.
  bare?: boolean;
  // A tighter pill for pages that set several labelled groups of them close
  // together (the AI page's What / Era / Length). Same look, 36dp tall at
  // 14dp type — the precedent is Btn's `small` (34dp).
  small?: boolean;
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
      // The white ring for every chip, chosen or not: the chosen one is a dark
      // well now, so the ring no longer has a white fill to be held off, and a
      // focused chosen pill reads as "ring around the lilac word" (it took a
      // violet ring while chosen meant a white fill - Mi TV, 2026-10-09).
      hasTVPreferredFocus={hasTVPreferredFocus}
      edgeLeft={edgeLeft}
      uiId={uiId}
      onFocusChange={onFocusChange}
      onPress={onPress}
      style={[bare ? styles.bare : styles.surface, small && styles.small]}>
      {/* `.picker-btn`'s 1dp --line edge, as an absolutely-positioned child —
          NOT a border on the Focusable itself. A border there replaces the 3dp
          the ring is drawn inside, so the ring ends up painted over its own
          hairline. Same shape as Btn.tsx's rest-state edge. */}
      {on ? <View style={styles.well} pointerEvents="none" /> : !bare ? <View style={styles.edge} pointerEvents="none" /> : null}
      <Text style={[bare ? styles.bareText : styles.text, small && !bare && styles.smallText, on && styles.onText]} numberOfLines={1}>
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
  small: {minHeight: 36, paddingVertical: 6, paddingHorizontal: 13},
  // (a bare pill's faint label keeps its 16dp — P14's faint-colour floor)
  smallText: {fontSize: 14},
  // The chosen pill: the well, as an absolute child like `edge` (same reason).
  well,
  // The bare pills live on the filter pane's glass, where the page's faint grey
  // is 2.7:1: the glass's third voice instead (7.3:1).
  bareText: {color: ink.third, fontSize: 16, fontWeight: '800'},
  text: {color: colors.text, fontSize: 16, fontWeight: '700'},
  onText: {color: ink.on},
});
