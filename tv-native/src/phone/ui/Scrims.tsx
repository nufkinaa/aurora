// What sits under a floating top bar (TopBar, BackBar): a soft scrim under the
// status bar while the page is at its top, and the solid band once it scrolls.
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

/** A soft dark band under the status bar, so the clock stays readable over whatever scrolls beneath it. */
export function StatusScrim() {
  const insets = useSafeAreaInsets();
  return <View pointerEvents="none" style={[s.scrim, {height: insets.top + 40}]} />;
}

/** The bar once the page has scrolled: dark glass under the status bar and the bar's buttons. */
export function BarBand() {
  const insets = useSafeAreaInsets();
  return <View pointerEvents="none" style={[s.band, {height: insets.top + 64}]} />;
}

const s = StyleSheet.create({
  scrim: {position: 'absolute', top: 0, left: 0, right: 0, zIndex: 9, experimental_backgroundImage: 'linear-gradient(180deg, rgba(7,8,17,0.78) 0%, rgba(7,8,17,0.45) 55%, rgba(7,8,17,0) 100%)'},
  band: {position: 'absolute', top: 0, left: 0, right: 0, zIndex: 9, backgroundColor: '#0c0d1a', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)'},
});
