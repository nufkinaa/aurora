// The floating glass tab bar (the website's phone nav, glass look): Home ·
// Movies · Shows · My List · Search, the tab you are on in a lit pill. Drawn
// over every screen but the player; a tap from deeper in the stack (a title
// page) goes back to the tabs first, as the site's bar does.
import React from 'react';
import {StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {StackActions} from '@react-navigation/native';
import Tap from './Tap';
import Icon from './Icon';
import {navRef} from '../../rootNav';
import {setTab, Tab, useTab} from '../tabs';
import {phoneNative} from '../native';
import {colors, TAB_H, TAB_INSET} from '../theme';

const ITEMS: {tab: Tab; label: string}[] = [
  {tab: 'home', label: 'Home'},
  {tab: 'movies', label: 'Movies'},
  {tab: 'shows', label: 'Shows'},
  {tab: 'list', label: 'My List'},
];

/** How much room the bar takes at the bottom of a screen (content pads by it). */
export const useTabBarSpace = () => {
  const insets = useSafeAreaInsets();
  return TAB_H + TAB_INSET * 2 + insets.bottom;
};

export default function TabBar() {
  const tab = useTab();
  const insets = useSafeAreaInsets();
  const {width} = useWindowDimensions();
  const go = (t: Tab) => {
    phoneNative.haptic('tick');
    if (navRef.isReady() && navRef.canGoBack()) navRef.dispatch(StackActions.popToTop());
    setTab(t);
  };
  const barW = Math.min(width - TAB_INSET * 2, 560);
  return (
    <View pointerEvents="box-none" style={[s.wrap, {bottom: insets.bottom + TAB_INSET}]}>
      <View style={[s.bar, {width: barW}]} accessibilityRole="tablist">
        {ITEMS.map(it => {
          const on = tab === it.tab;
          return (
            <Tap
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
              <Text style={[s.label, {opacity: on ? 1 : 0.8}]} numberOfLines={1}>
                {it.label}
              </Text>
            </Tap>
          );
        })}
        <Tap
          flat
          accessibilityRole="tab"
          accessibilityState={{selected: tab === 'search'}}
          accessibilityLabel="Search"
          onPress={() => go('search')}
          style={s.search}>
          <View style={[s.pill, tab !== 'search' && s.pillOff]} pointerEvents="none" />
          <Icon name="search" size={26} color="#fff" />
        </Tap>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {position: 'absolute', left: 0, right: 0, alignItems: 'center'},
  bar: {
    height: TAB_H,
    borderRadius: TAB_H / 2,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 5,
    backgroundColor: colors.tabBar,
    experimental_backgroundImage:
      'linear-gradient(100deg, rgba(120,92,235,0.88) 0%, rgba(70,48,160,0.84) 45%, rgba(56,40,130,0.86) 100%)',
    borderWidth: 1,
    borderColor: colors.tabBarEdge,
    elevation: 12,
    shadowColor: '#000',
  },
  item: {flex: 1, height: TAB_H - 10, borderRadius: (TAB_H - 10) / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  pill: {...StyleSheet.absoluteFill, borderRadius: (TAB_H - 10) / 2, backgroundColor: colors.tabPill, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)'},
  pillOff: {opacity: 0},
  label: {color: '#fff', fontSize: 15, fontWeight: '800'},
  search: {width: 58, height: TAB_H - 10, borderRadius: (TAB_H - 10) / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
});
