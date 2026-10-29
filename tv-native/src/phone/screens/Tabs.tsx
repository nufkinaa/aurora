// The stack's first screen: the five tabs of the bottom bar, side by side.
// A tab is mounted the first time it is shown and then KEPT (its scroll, its
// typed search), hidden while another tab is up — the way an Android app's
// bottom navigation behaves. The hidden ones are frozen (react-native-screens'
// Freeze): no renders, no timers' re-renders, while they are out of sight.
import React, {useEffect, useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {Freeze} from 'react-freeze';
import {Tab, TABS, useTab} from '../tabs';
import {LOW_END} from '../lowEnd';

const SCREENS: Record<Tab, () => React.ComponentType> = {
  home: () => require('./Home').default,
  movies: () => require('./Browse').MoviesTab,
  shows: () => require('./Browse').ShowsTab,
  list: () => require('./MyList').default,
  search: () => require('./Search').default,
};

export default function Tabs() {
  const tab = useTab();
  const [opened, setOpened] = useState<Set<Tab>>(() => new Set([tab]));
  useEffect(() => {
    // a weak phone keeps Home and the tab on show; the others are let go when left
    setOpened(o => (LOW_END ? new Set<Tab>(['home', tab]) : o.has(tab) ? o : new Set([...o, tab])));
  }, [tab]);
  return (
    <View style={s.root}>
      {TABS.filter(t => opened.has(t) || t === tab).map(t => {
        const C = SCREENS[t]();
        const on = t === tab;
        return (
          <View key={t} style={[StyleSheet.absoluteFill, !on && s.hidden]} pointerEvents={on ? 'auto' : 'none'}>
            <Freeze freeze={!on}>
              <C />
            </Freeze>
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  hidden: {opacity: 0},
});
