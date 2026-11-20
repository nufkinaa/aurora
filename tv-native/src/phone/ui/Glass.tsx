// A glass panel (glass.css .glass-panel): a light veil over the sky, a
// hairline edge, rounded. No backdrop blur — the sky behind is soft already
// and a live blur would cost every frame.
import React from 'react';
import {StyleProp, StyleSheet, View, ViewStyle} from 'react-native';
import {G_FILL, radius, RG_RINGED} from '../theme';
import GlassRim from './GlassRim';

export default function Glass({style, children, strong}: {style?: StyleProp<ViewStyle>; children?: React.ReactNode; strong?: boolean}) {
  return (
    <View style={[s.panel, strong && s.strong, style]}>
      <GlassRim r={radius.xl} edge={1} />
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  // .pref-section and friends (glass.css): --g-fill over a faint violet tint, --g-edge, 20 round
  panel: {
    backgroundColor: 'rgba(60,64,150,0.12)',
    experimental_backgroundImage: G_FILL,
    // the full glass (2026-11-20): a pane that stands alone wears the nav's edge - its split and rim,
    // GlassRim's ring and glint on the kept (now transparent) border
    ...RG_RINGED,
    borderRadius: radius.xl,
    overflow: 'hidden',
  },
  strong: {backgroundColor: 'rgba(16,18,36,0.86)'},
});
