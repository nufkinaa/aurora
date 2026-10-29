// A page's heading under the top bar (the website's .page-head): the title,
// big, and a line under it. On a pushed screen (`back`) a round Back button
// takes the logo's place.
import React, {useCallback, useState} from 'react';
import {NativeScrollEvent, NativeSyntheticEvent, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import {IconCircle} from './Buttons';
import {scrollReporter} from './tabBarShown';
import {BarBand, StatusScrim} from './Scrims';
import {colors, GUTTER} from '../theme';

export const usePageTop = () => useSafeAreaInsets().top + 70;

/** The floating bar turns SOLID once the page has scrolled: what scrolls up then goes under
 *  the bar's dark glass instead of under (and through) its round buttons — the title page's
 *  rule, on every page (2026-10-29 screen pass: Settings' cards and Home's billboard ran
 *  under the buttons). `at`: how far the page scrolls before (the page's own heading
 *  starts ~12 dp below the buttons). */
/** Landscape / a tablet: a list page's body in a readable centred column (the title page's
 *  rule) — settings cards 2,000 px wide read badly. Null in portrait. */
export function useColumn() {
  const {width, height} = useWindowDimensions();
  return width > height && width >= 700 ? ({width: '100%', maxWidth: 820, alignSelf: 'center'} as const) : null;
}

export function useSolidBar(at = 12) {
  const [solid, setSolid] = useState(false);
  // the same scroll tells the tab bar when to step aside (ui/tabBarShown.ts)
  const [report] = useState(scrollReporter);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y;
      const past = y > at;
      setSolid(was => (was === past ? was : past));
      report(y);
    },
    [at, report],
  );
  return {solid, onScroll};
}


export default function PageHead({title, sub, children}: {title: string; sub?: string | null; children?: React.ReactNode}) {
  const top = usePageTop();
  return (
    <View style={[s.head, {paddingTop: top}]}>
      <Text style={s.title} accessibilityRole="header" numberOfLines={2}>
        {title}
      </Text>
      {sub ? <Text style={s.sub}>{sub}</Text> : null}
      {children}
    </View>
  );
}

/** A pushed screen's own top bar: Back on the left, the screen's title beside it. */
export function BackBar({title, right, solid}: {title?: string; right?: React.ReactNode; solid?: boolean}) {
  const insets = useSafeAreaInsets();
  const nav = useNavigation();
  return (
    <>
    {solid ? <BarBand /> : <StatusScrim />}
    <View pointerEvents="box-none" style={[s.back, {top: insets.top + 8}]}>
      <IconCircle icon="back" label="Back" onPress={() => nav.canGoBack() && nav.goBack()} />
      {title ? (
        <Text style={s.backTitle} numberOfLines={1}>
          {title}
        </Text>
      ) : (
        <View style={{flex: 1}} />
      )}
      {right}
    </View>
    </>
  );
}

const s = StyleSheet.create({
  head: {paddingHorizontal: GUTTER, paddingBottom: 12},
  title: {color: colors.text, fontSize: 32, fontWeight: '900', letterSpacing: -0.3},
  sub: {color: colors.textDim, fontSize: 16, marginTop: 4},
  back: {position: 'absolute', left: GUTTER, right: GUTTER, flexDirection: 'row', alignItems: 'center', gap: 12, zIndex: 10},
  backTitle: {flex: 1, color: colors.text, fontSize: 18, fontWeight: '800'},
});
