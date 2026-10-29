// The floating glass tab bar (the website's phone nav, glass look): Home ·
// Movies · Shows · My List · Search, the tab you are on in a lit pill. Drawn
// over every screen but the player; a tap from deeper in the stack (a title
// page) goes back to the tabs first, as the site's bar does.
import React, {useEffect, useRef} from 'react';
import {Animated, Easing, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useTabBarShown} from './tabBarShown';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {StackActions} from '@react-navigation/native';
import Tap from './Tap';
import Icon from './Icon';
import {navRef} from '../../rootNav';
import {setTab, Tab, useTab} from '../tabs';
import {phoneNative} from '../native';
import {G_EDGE, GUTTER, TAB_H, TAB_INSET, TAB_SIDE} from '../theme';

const ITEMS: {tab: Tab; label: string; uiId: string}[] = [
  {tab: 'home', label: 'Home', uiId: 'nav.home'},
  {tab: 'movies', label: 'Movies', uiId: 'nav.movies'},
  {tab: 'shows', label: 'Shows', uiId: 'nav.shows'},
  {tab: 'list', label: 'My List', uiId: 'nav.mylist'},
];

/** How much room the bar takes at the bottom of a screen (content pads by it). */
export const useTabBarSpace = () => {
  const insets = useSafeAreaInsets();
  const {width, height} = useWindowDimensions();
  // sideways the bar is at the top (the site's wide layout), so the foot needs only its inset
  if (barAtTop(width, height)) return insets.bottom + 24;
  return TAB_H + TAB_INSET + tabBottom(insets.bottom) + 11; // the site's #app padding-bottom: 84
};
/** Held sideways, the site's nav island sits at the TOP of the page, beside the logo — the
 *  phone's bar goes there too (the bottom of a landscape phone is the content's). */
export const barAtTop = (width: number, height: number) => width > height;
/** The site's `bottom: max(10px, env(safe-area-inset-bottom) - 14px)`: the bar rides low,
 *  over the gesture strip rather than a whole inset above it. */
export const tabBottom = (inset: number) => (inset >= 40 ? inset + TAB_INSET : Math.max(TAB_INSET, inset - 14));
// (an inset of 40+ is a 3-button / 2-button navigation bar, not the gesture strip: the bar
// sits 10 above it, as the site's does above a browser's own bar — sizes pass 2026-10-29)

export default function TabBar() {
  const tab = useTab();
  const insets = useSafeAreaInsets();
  const {width, height} = useWindowDimensions();
  const top = barAtTop(width, height);
  const go = (t: Tab) => {
    phoneNative.haptic('tick');
    if (navRef.isReady() && navRef.canGoBack()) navRef.dispatch(StackActions.popToTop());
    setTab(t);
  };
  // sideways: between the logo pill and the pills on the right, as wide as the site's island
  const barW = top ? Math.min(width - 2 * (GUTTER + 50 + 24) - 2 * 100, 440) : Math.min(width - TAB_SIDE * 2, 696); // (the site's island spans the phone; a tablet's top nav takes over past ~720)
  // out of the way while a page scrolls down (ui/tabBarShown.ts)
  const shown = useTabBarShown();
  const away = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(away, {toValue: shown ? 0 : 1, duration: shown ? 180 : 220, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
  }, [shown, away]);
  const drop = top ? -(TAB_H + Math.max(10, insets.top) + 12) : TAB_H + tabBottom(insets.bottom) + 12;
  return (
    <Animated.View
      pointerEvents={shown ? 'box-none' : 'none'}
      style={[s.wrap, top ? {top: Math.max(10, insets.top) - 3} : {bottom: tabBottom(insets.bottom)}, {transform: [{translateY: away.interpolate({inputRange: [0, 1], outputRange: [0, drop]})}]}]}>
      <View style={[s.bar, {width: barW}]} accessibilityRole="tablist">
        {ITEMS.map(it => {
          const on = tab === it.tab;
          return (
            <Tap
              uiId={it.uiId}
              key={it.tab}
              flat
              accessibilityRole="tab"
              accessibilityState={{selected: on}}
              accessibilityLabel={it.label}
              onPress={() => go(it.tab)}
              style={s.item}>
              {/* the lit pill is its own layer: the item itself never changes style
                  (an item that went from lit to plain lost its word under Fabric —
                  Pixel 9 emulator, 2026-10-28) */}
              <View style={[s.pill, !on && s.pillOff]} pointerEvents="none" />
              <Text style={[s.label, on && s.labelOn]} numberOfLines={1} maxFontSizeMultiplier={1.2}>
                {it.label}
              </Text>
            </Tap>
          );
        })}
        <Tap
          uiId="nav.search"
          flat
          accessibilityRole="tab"
          accessibilityState={{selected: tab === 'search'}}
          accessibilityLabel="Search"
          onPress={() => go('search')}
          style={s.search}>
          <View style={[s.pill, tab !== 'search' && s.pillOff]} pointerEvents="none" />
          <Icon name="navSearch" size={18} color="rgba(243,244,248,0.9)" />
        </Tap>
      </View>
    </Animated.View>
  );
}

const PILL_H = TAB_H - 12;
const s = StyleSheet.create({
  wrap: {position: 'absolute', left: 0, right: 0, alignItems: 'center'},
  // .nav-items (glass): a 53 tall island, 6 inside, the items 2 apart. The site's is frosted
  // glass (a backdrop blur over the sky); a blur every frame is what a weak phone cannot pay,
  // so the island is the colour that glass shows over this sky (sampled at 411 px: blue at the
  // left where the sky is, navy to the right) — a still fill, the same edge light.
  bar: {
    height: TAB_H,
    borderRadius: TAB_H / 2,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 6,
    gap: 2,
    backgroundColor: 'rgba(28,32,66,0.9)',
    experimental_backgroundImage:
      'linear-gradient(90deg, rgba(26,72,150,0.92) 0%, rgba(44,54,96,0.9) 32%, rgba(30,35,72,0.9) 66%, rgba(24,28,60,0.92) 100%)',
    ...G_EDGE,
    elevation: 12,
    shadowColor: '#000',
  },
  item: {flex: 1, height: PILL_H, borderRadius: PILL_H / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  // .nav-item.active: a white veil with a lit top edge
  pill: {...StyleSheet.absoluteFill, borderRadius: PILL_H / 2, backgroundColor: 'rgba(255,255,255,0.14)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', borderTopColor: 'rgba(255,255,255,0.35)'},
  pillOff: {opacity: 0},
  label: {color: 'rgba(243,244,248,0.82)', fontSize: 12.16, fontWeight: '700', lineHeight: 18.24},
  labelOn: {color: '#ffffff'},
  search: {flex: 1, height: PILL_H, borderRadius: PILL_H / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
});
