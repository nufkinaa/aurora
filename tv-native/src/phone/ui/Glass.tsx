// A glass panel (glass.css .glass-panel): a light veil over the sky, a
// hairline edge, rounded. No backdrop blur — the sky behind is soft already
// and a live blur would cost every frame.
import React from 'react';
import {StyleProp, StyleSheet, View, ViewStyle} from 'react-native';
import {G_EDGE, G_FILL, radius} from '../theme';

export default function Glass({style, children, strong}: {style?: StyleProp<ViewStyle>; children?: React.ReactNode; strong?: boolean}) {
  return <View style={[s.panel, strong && s.strong, style]}>{children}</View>;
}

const s = StyleSheet.create({
  // .pref-section and friends (glass.css): --g-fill over a faint violet tint, --g-edge, 20 round
  panel: {
    backgroundColor: 'rgba(60,64,150,0.12)',
    experimental_backgroundImage: G_FILL,
    ...G_EDGE,
    borderRadius: radius.xl,
    overflow: 'hidden',
  },
  strong: {backgroundColor: 'rgba(16,18,36,0.86)'},
});
