// The one calm line with no connection (docs/offline-look.md §7, the website's ws.js banner): a
// pill above the tab bar — the amber no-signal sign, "No connection" (or "Can't reach Aurora —
// trying again…"), a hairline, then "On this device" in mint. Not an alarm: what is saved here
// still plays, and the line leads there. On the place itself its link gives way; over a player
// the whole line is hidden. It fades up 6 dp in 280 ms (no movement under "remove animations").
import React, {useEffect, useRef} from 'react';
import {AccessibilityInfo, Animated, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Svg, {Path} from 'react-native-svg';
import {pushPhone} from '../nav';
import Tap from '../ui/Tap';
import {tabBottom} from '../ui/TabBar';
import {TAB_H, TAB_INSET} from '../theme';
import {AMBER, MINT} from './Mark';
import {PLACE} from './rules';
import {awayWords, setPillShown, useAway} from './reach';

const REST = 'M9.3 7.2A5.6 5.6 0 0 1 17.6 11a3.8 3.8 0 0 1 2.3 6.5M16.5 18.5H7.2a4.2 4.2 0 0 1-1-8.28M4 4l16 16';

export default function OfflinePill({route}: {route: string}) {
  const away = useAway();
  const insets = useSafeAreaInsets();
  const a = useRef(new Animated.Value(0)).current;
  const hidden = route === 'Player' || route === 'OfflinePlayer';
  const there = route === 'Downloads';
  useEffect(() => {
    if (!away) return;
    a.setValue(0);
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then(calm => (calm ? a.setValue(1) : Animated.timing(a, {toValue: 1, duration: 280, useNativeDriver: true}).start()))
      .catch(() => a.setValue(1));
  }, [away, a]);
  const shown = !!away && !hidden;
  useEffect(() => {
    setPillShown(shown);
    return () => setPillShown(false);
  }, [shown]);
  if (!shown) return null;
  return (
    <View pointerEvents="box-none" style={[s.wrap, {bottom: tabBottom(insets.bottom) + TAB_H + TAB_INSET + 8}]}>
      <Animated.View accessibilityRole="text" accessibilityLiveRegion="polite" style={[s.pill, {opacity: a, transform: [{translateY: a.interpolate({inputRange: [0, 1], outputRange: [6, 0]})}]}]}>
        <Svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke={AMBER} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
          <Path d={REST} />
        </Svg>
        <Text style={s.text}>{away === 'server' ? `${awayWords(away)} — trying again…` : awayWords(away)}</Text>
        {there ? null : (
          <>
            <View style={s.hair} />
            <Tap uiId="saved.rest.open" flat onPress={() => pushPhone('Downloads')} style={s.link} accessibilityRole="link" accessibilityLabel={PLACE}>
              <Text style={s.linkText}>{PLACE}</Text>
            </Tap>
          </>
        )}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {position: 'absolute', left: 16, right: 16, alignItems: 'center'},
  pill: {flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingLeft: 14, paddingRight: 6, borderRadius: 999, backgroundColor: 'rgba(20,22,30,0.94)', borderWidth: 1, borderColor: 'rgba(245,197,66,0.32)', elevation: 6},
  text: {color: '#e9ecf4', fontSize: 13.4, fontWeight: '600', flexShrink: 1, paddingVertical: 10},
  hair: {width: StyleSheet.hairlineWidth, alignSelf: 'stretch', marginVertical: 10, backgroundColor: 'rgba(255,255,255,0.28)'},
  link: {minHeight: 44, minWidth: 44, paddingHorizontal: 8, justifyContent: 'center'},
  linkText: {color: MINT, fontSize: 13.4, fontWeight: '700'},
});
