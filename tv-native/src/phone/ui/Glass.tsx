// A glass panel (glass.css .pref-section and friends, glass E): a pane in the
// page — --g-fill-slab (70 % of near-black: no blur or dim on the website
// either, the body alone holds the words over the sky's brightest band) —
// with the strong edge, rounded. No backdrop blur — a live blur would cost
// every frame.
import React from 'react';
import {StyleProp, StyleSheet, View, ViewStyle} from 'react-native';
import {E, G_EDGE, G_FILL, radius} from '../theme';

export default function Glass({style, children, strong}: {style?: StyleProp<ViewStyle>; children?: React.ReactNode; strong?: boolean}) {
  return <View style={[s.panel, strong && s.strong, style]}>{children}</View>;
}

const s = StyleSheet.create({
  // .pref-section and friends (glass.css): --g-fill over a faint violet tint, --g-edge, 20 round
  panel: {
    backgroundColor: E.slab,
    experimental_backgroundImage: G_FILL,
    ...G_EDGE,
    borderRadius: radius.xl,
    overflow: 'hidden',
  },
  strong: {backgroundColor: E.thick},
});
