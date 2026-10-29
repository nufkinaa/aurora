// A page's heading under the top bar (the website's .page-head): the title,
// big, and a line under it. On a pushed screen (`back`) a round Back button
// takes the logo's place.
import React, {useCallback, useState} from 'react';
import {NativeScrollEvent, NativeSyntheticEvent, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {IconCircle} from './Buttons';
import {scrollReporter} from './tabBarShown';
import {BarBand, StatusScrim} from './Scrims';
import {colors, GUTTER} from '../theme';
import {TopRight, useBarTop} from './TopBar';

/** Where a page's heading starts: the site's .browse-head, 98 below the pills' row
 *  (padding-top 110 with the pills at 12 in a browser tab). */
export const usePageTop = () => useBarTop() + 98;

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


export default function PageHead({title, sub, children, right}: {title: string; sub?: string | null; children?: React.ReactNode; right?: React.ReactNode}) {
  const top = usePageTop();
  return (
    <View style={[s.head, {paddingTop: top}]}>
      <View style={s.titleRow}>
        <Text style={s.title} accessibilityRole="header" numberOfLines={2}>
          {title}
        </Text>
        {right}
      </View>
      {sub ? <Text style={s.sub}>{sub}</Text> : null}
      {children}
    </View>
  );
}

/** A pushed screen's own top bar: the site's pills (settings · you) on the right, as on
 *  every page of the site, and Back — the one thing the site leaves to the browser — a
 *  round glass pill where the logo sits. (`title` is kept for callers; the site's bar
 *  carries no words, so neither does this one.) */
export function BackBar({right, solid, noSettings}: {title?: string; right?: React.ReactNode; solid?: boolean; noSettings?: boolean}) {
  const top = useBarTop();
  const nav = useNavigation();
  return (
    <>
    {solid ? <BarBand /> : <StatusScrim />}
    <View pointerEvents="box-none" style={[s.back, {top}]}>
      <IconCircle icon="back" label="Back" onPress={() => nav.canGoBack() && nav.goBack()} />
      <View style={{flex: 1}} />
      {right === undefined ? <TopRight noSettings={noSettings} /> : right}
    </View>
    </>
  );
}

const s = StyleSheet.create({
  // .browse-head: h1 24/900 on a 36 line, the count 16/600 in the faint grey 2 under it
  head: {paddingHorizontal: GUTTER, paddingBottom: 8},
  titleRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 16},
  title: {flexShrink: 1, color: colors.text, fontSize: 24, fontWeight: '900', letterSpacing: -0.72, lineHeight: 36},
  sub: {color: colors.textFaint, fontSize: 16, fontWeight: '600', lineHeight: 24, marginTop: 2},
  back: {position: 'absolute', left: GUTTER, right: GUTTER, height: 42, flexDirection: 'row', alignItems: 'center', zIndex: 10},
});
