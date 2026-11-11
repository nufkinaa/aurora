// The floating glass tab bar (the website's phone nav, glass look): Home ·
// Movies · Shows · My List · More · Search, the tab you are on in a lit pill.
// Drawn over every screen but the player; a tap from deeper in the stack (a
// title page) goes back to the tabs first, as the site's bar does. "More" is
// not a tab: it opens the sheet with every other place (moreMenu.ts,
// docs/android-phone/NAV.md). The words are measured and fitted to the width
// and the phone's font size (tabFit.ts) — none is ever cut off.
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, Easing, LayoutChangeEvent, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useTabBarShown} from './tabBarShown';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {StackActions} from '@react-navigation/native';
import Tap from './Tap';
import Icon from './Icon';
import {navRef} from '../../rootNav';
import {setTab, Tab, useTab} from '../tabs';
import {openMore, useMoreShown} from '../moreMenu';
import {phoneNative} from '../native';
import {E, E_EDGE_FLOAT, E_WELL, E_WORDS, GUTTER, TAB_H, TAB_INSET, TAB_SIDE} from '../theme';
import {BASE_FONT, fitTabs, guessWidth, tabSlots} from './tabFit';

const ITEMS: {tab: Tab; label: string; uiId: string}[] = [
  {tab: 'home', label: 'Home', uiId: 'nav.home'},
  {tab: 'movies', label: 'Movies', uiId: 'nav.movies'},
  {tab: 'shows', label: 'Shows', uiId: 'nav.shows'},
  {tab: 'list', label: 'My List', uiId: 'nav.mylist'},
];
const MORE = 'More';
const WORDS = [...ITEMS.map(i => i.label), MORE];
/** The words are allowed to grow with the phone's font size up to this. */
const MAX_SCALE = 1.2;

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
 *  over the gesture strip rather than a whole inset above it — but clear of the gesture
 *  handle: at inset - 14 Android's handle (drawn 11–14 dp up a 24 dp strip) sat on the
 *  bar's bottom edge (Pixel 9, ui-phone 2026-11-10), so inset - 6 leaves ~4 dp between. */
export const tabBottom = (inset: number) => (inset >= 40 ? inset + TAB_INSET : Math.max(TAB_INSET, inset - 6));
// (an inset of 40+ is a 3-button / 2-button navigation bar, not the gesture strip: the bar
// sits 10 above it, as the site's does above a browser's own bar — sizes pass 2026-10-29)

export default function TabBar() {
  const tab = useTab();
  const moreOn = useMoreShown();
  const insets = useSafeAreaInsets();
  const {width, height, fontScale} = useWindowDimensions();
  const top = barAtTop(width, height);
  const go = (t: Tab) => {
    phoneNative.haptic('tick');
    if (navRef.isReady() && navRef.canGoBack()) navRef.dispatch(StackActions.popToTop());
    setTab(t);
  };
  // sideways: between the logo pill and the pills on the right, as wide as the site's island
  const barW = top ? Math.min(width - 2 * (GUTTER + 50 + 24) - 2 * 100, 440) : Math.min(width - TAB_SIDE * 2, 696); // (the site's island spans the phone; a tablet's top nav takes over past ~720)
  // the words' real widths at the full size (measured once per font scale, below)
  const scale = Math.min(fontScale || 1, MAX_SCALE);
  const [measured, setMeasured] = useState<{scale: number; w: number[]} | null>(null);
  const words = useMemo(() => (measured && measured.scale === scale ? measured.w : WORDS.map(w => guessWidth(w, scale))), [measured, scale]);
  const fit = useMemo(() => fitTabs(barW, words, scale), [barW, words, scale]);
  const slots = useMemo(() => tabSlots(barW, words, fit), [barW, words, fit]);
  const got = useRef<number[]>([]);
  const onWord = (i: number) => (e: LayoutChangeEvent) => {
    got.current[i] = Math.ceil(e.nativeEvent.layout.width) + 1;
    if (WORDS.every((_, k) => got.current[k] > 0)) {
      const w = [...got.current];
      got.current = [];
      setMeasured(m => (m && m.scale === scale && m.w.every((x, k) => x === w[k]) ? m : {scale, w}));
    }
  };
  // out of the way while a page scrolls down (ui/tabBarShown.ts)
  const shown = useTabBarShown();
  const away = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(away, {toValue: shown ? 0 : 1, duration: shown ? 180 : 220, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
  }, [shown, away]);
  const drop = top ? -(TAB_H + Math.max(10, insets.top) + 12) : TAB_H + tabBottom(insets.bottom) + 12;
  const label = {fontSize: fit.font, lineHeight: Math.round(fit.font * 150) / 100};
  const slot = (i: number) => ({width: slots[i], flex: 0});
  const moreAt = ITEMS.length; // More's slot: right after the words (a word or an icon)
  return (
    <Animated.View
      pointerEvents={shown ? 'box-none' : 'none'}
      style={[s.wrap, top ? {top: Math.max(10, insets.top) - 3} : {bottom: tabBottom(insets.bottom)}, {transform: [{translateY: away.interpolate({inputRange: [0, 1], outputRange: [0, drop]})}]}]}>
      {/* the words at the full size, unseen, to measure them (again when the font size changes) */}
      <View style={s.measure} pointerEvents="none" importantForAccessibility="no-hide-descendants" key={`m${scale}`}>
        {WORDS.map((w, i) => (
          <Text key={w} onLayout={onWord(i)} style={[s.label, s.labelOn]} numberOfLines={1} maxFontSizeMultiplier={MAX_SCALE}>
            {w}
          </Text>
        ))}
      </View>
      <View style={[s.bar, {width: barW}]} accessibilityRole="tablist">
        {ITEMS.map((it, i) => {
          const on = tab === it.tab && !moreOn;
          return (
            <Tap
              uiId={it.uiId}
              key={it.tab}
              flat
              accessibilityRole="tab"
              accessibilityState={{selected: on}}
              accessibilityLabel={it.label}
              onPress={() => go(it.tab)}
              style={[s.item, slot(i)]}>
              {/* the lit pill is its own layer: the item itself never changes style
                  (an item that went from lit to plain lost its word under Fabric —
                  Pixel 9 emulator, 2026-10-28) */}
              <View style={[s.pill, !on && s.pillOff]} pointerEvents="none" />
              <Text style={[s.label, label, on && s.labelOn]} numberOfLines={1} maxFontSizeMultiplier={MAX_SCALE}>
                {it.label}
              </Text>
            </Tap>
          );
        })}
        <Tap
          uiId="nav.more"
          flat
          accessibilityRole="button"
          accessibilityState={{expanded: moreOn}}
          accessibilityLabel={MORE}
          accessibilityHint="Every other place: what's new, saved copies, your TVs, settings"
          onPress={() => {
            phoneNative.haptic('tick');
            openMore();
          }}
          style={[s.item, slot(moreAt)]}>
          <View style={[s.pill, !moreOn && s.pillOff]} pointerEvents="none" />
          {fit.moreIcon ? (
            <Icon name="moreH" size={20} color="#ffffff" />
          ) : (
            <Text style={[s.label, label, moreOn && s.labelOn]} numberOfLines={1} maxFontSizeMultiplier={MAX_SCALE}>
              {MORE}
            </Text>
          )}
        </Tap>
        <Tap
          uiId="nav.search"
          flat
          accessibilityRole="tab"
          accessibilityState={{selected: tab === 'search' && !moreOn}}
          accessibilityLabel="Search"
          onPress={() => go('search')}
          style={[s.search, slot(moreAt + 1)]}>
          <View style={[s.pill, (tab !== 'search' || moreOn) && s.pillOff]} pointerEvents="none" />
          <Icon name="navSearch" size={18} color="#ffffff" />
        </Tap>
      </View>
    </Animated.View>
  );
}

const PILL_H = TAB_H - 12;
const s = StyleSheet.create({
  wrap: {position: 'absolute', left: 0, right: 0, alignItems: 'center'},
  // .nav-items (glass E, "Clear"): a 53 tall island, 6 inside, the items 2 apart. The
  // website's is a light 3 px blur with the poster behind dimmed hard; a blur every frame
  // is what a weak phone cannot pay, so the body does the dimming (Aurora's navy at 58 %: the
  // picture's light and colour come through, words 4.9:1 over white) — a still fill, the strong edge, the depth.
  bar: {
    height: TAB_H,
    borderRadius: TAB_H / 2,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 6,
    gap: 2,
    backgroundColor: E.chrome,
    ...E_EDGE_FLOAT,
  },
  item: {flex: 1, height: PILL_H, borderRadius: PILL_H / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  // .nav-item.active: Aurora's violet capsule with its own line (glass E keeps the colour)
  pill: {...StyleSheet.absoluteFill, borderRadius: PILL_H / 2, ...E_WELL},
  pillOff: {opacity: 0},
  // --g-ink: white words, each with its soft shadow (the clearest glass)
  label: {color: '#ffffff', fontSize: BASE_FONT, fontWeight: '700', lineHeight: 18.24, ...E_WORDS},
  // the words measured at the full size: out of sight, never laid out against the bar
  measure: {position: 'absolute', left: 0, top: 0, opacity: 0, flexDirection: 'row', alignItems: 'flex-start', width: 2000},
  labelOn: {color: '#ffffff'},
  search: {flex: 1, height: PILL_H, borderRadius: PILL_H / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
});
