// The website's profile menu on a phone (glass.css .nav-menu): a 220 dp glass
// panel under the avatar, 20 round — the name at the top over a hairline, then
// one 44 dp line per place — over a dimmed page. A tap outside or Back closes it.
import React, {useEffect, useRef} from 'react';
import {Animated, BackHandler, Pressable, StyleSheet, Text, View} from 'react-native';
import {closeProfileMenu, useProfileMenu} from '../profileMenu';
import {useBarTop} from './TopBar';
import Tap from './Tap';
import {colors, G_EDGE, G_FILL, GUTTER} from '../theme';

export default function ProfileMenu() {
  const {shown, name, items} = useProfileMenu();
  const top = useBarTop();
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!shown) return;
    a.setValue(0);
    Animated.timing(a, {toValue: 1, duration: 160, useNativeDriver: true}).start();
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeProfileMenu();
      return true;
    });
    return () => sub.remove();
  }, [shown, a]);
  if (!shown) return null;
  return (
    <Animated.View style={[StyleSheet.absoluteFill, s.wrap, {opacity: a}]}>
      <Pressable style={[StyleSheet.absoluteFill, s.dim]} onPress={closeProfileMenu} accessibilityLabel="Close the menu" />
      <Animated.View
        accessibilityViewIsModal
        style={[s.panel, {top: top + 52, transform: [{translateY: a.interpolate({inputRange: [0, 1], outputRange: [-6, 0]})}]}]}>
        <View style={s.head}>
          <Text style={s.name} numberOfLines={1}>
            {name}
          </Text>
        </View>
        {items.map(it => (
          <Tap
            key={it.uiId}
            uiId={it.uiId}
            flat
            accessibilityRole="menuitem"
            onPress={() => {
              closeProfileMenu();
              setTimeout(it.onPress, 0);
            }}
            style={s.item}>
            <Text style={s.itemText} numberOfLines={1}>
              {it.label}
            </Text>
          </Tap>
        ))}
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: {zIndex: 50, elevation: 50},
  // .nav-menu-wrap.ui-overlay: the page dimmed behind it
  dim: {backgroundColor: 'rgba(4,5,12,0.62)'},
  panel: {
    position: 'absolute',
    right: GUTTER + 2,
    width: 220,
    padding: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(14,16,30,0.94)',
    experimental_backgroundImage: G_FILL,
    ...G_EDGE,
    elevation: 16,
    shadowColor: '#000',
  },
  head: {paddingTop: 8, paddingHorizontal: 12, paddingBottom: 10, marginBottom: 6, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)'},
  name: {color: colors.text, fontSize: 16, fontWeight: '800', lineHeight: 24},
  item: {height: 44, borderRadius: 12, paddingHorizontal: 12, justifyContent: 'center', overflow: 'hidden'},
  itemText: {color: 'rgba(243,244,248,0.9)', fontSize: 14.88, lineHeight: 22.3},
});
