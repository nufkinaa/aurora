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

/** The bar once the page has scrolled: the site's light scrim behind the floating pills
 *  (glass.css .nav.solid::after — the page colour at 0.82, fading out under them). The
 *  pills stay round glass; no solid app bar. */
export function BarBand() {
  const insets = useSafeAreaInsets();
  return <View pointerEvents="none" style={[s.band, {height: Math.max(10, insets.top) + 74}]} />;
}

const s = StyleSheet.create({
  scrim: {position: 'absolute', top: 0, left: 0, right: 0, zIndex: 9, experimental_backgroundImage: 'linear-gradient(180deg, rgba(7,8,17,0.78) 0%, rgba(7,8,17,0.45) 55%, rgba(7,8,17,0) 100%)'},
  band: {position: 'absolute', top: 0, left: 0, right: 0, zIndex: 9, experimental_backgroundImage: 'linear-gradient(180deg, rgba(7,8,17,0.96) 0%, rgba(7,8,17,0.9) 50%, rgba(7,8,17,0) 100%)'},
});
