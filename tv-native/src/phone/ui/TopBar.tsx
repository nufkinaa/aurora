// The top bar of a tab screen (the website's glass look): the Aurora mark on
// the left, your TVs (while one is on), settings and you on the right — round glass buttons floating over
// the page, the status bar's height clear of the top.
import React from 'react';
import {Image, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useApp} from '../../AppContext';
import {useMe} from '../../navSection';
import {pushScreen} from '../../rootNav';
import {IconCircle} from './Buttons';
import Avatar from './Avatar';
import {openProfileMenu} from '../profileMenu';
import {useDevices} from '../remote/controller';
import {pushPhone} from '../nav';
import {setTab} from '../tabs';
import {E, E_EDGE_FLOAT, GUTTER} from '../theme';
import Tap from './Tap';
import {BarBand, StatusScrim} from './Scrims';

const LOGO = require('../../assets/logo-mark.png');

/** The right-hand pills (.nav-gear · .nav-profile): settings and you, 10 apart — and, while
 *  one of your TVs is on, the TV button before them (Your TVs, one tap: docs/android-phone/NAV.md §3). */
export function TopRight({noSettings, tv}: {noSettings?: boolean; tv?: boolean}) {
  const {profileId} = useApp();
  const me = useMe(profileId);
  const tvs = useDevices();
  // (on the tab screens' bar only: a pushed page's bar keeps its room for its title)
  return (
    <View style={s.right}>
      {tv && tvs.length ? <IconCircle uiId="nav.remote" icon="tv" label="Your TVs" onPress={() => pushPhone('Remote')} /> : null}
      {noSettings ? null : <IconCircle uiId="nav.settings" icon="navGear" label="Settings" onPress={() => pushScreen('Settings', undefined)} />}
      <IconCircle uiId="nav.profile" label={`${me?.name || 'Profile'} — profile menu`} onPress={() => openProfileMenu()} size={40}>
        <Avatar p={me} size={30} round />
      </IconCircle>
    </View>
  );
}

/** Where the pills' row starts (dp from the window's top): the site's
 *  `max(10px, env(safe-area-inset-top)) + 2px` (glass.css, phone). */
export const useBarTop = () => Math.max(10, useSafeAreaInsets().top) + 2;

export default function TopBar({solid}: {transparent?: boolean; solid?: boolean}) {
  const top = useBarTop();
  return (
    <>
    {solid ? <BarBand /> : <StatusScrim />}
    <View pointerEvents="box-none" style={[s.bar, {top}]}>
      {/* .nav-logo: the mark in a glass pill, 50 x 40, 2 lower than the round ones */}
      <Tap uiId="nav.home" accessibilityRole="button" accessibilityLabel="Aurora — Home" onPress={() => setTab('home')} borderless style={s.logo}>
        <Image source={LOGO} style={{width: 26, height: 26}} resizeMode="contain" />
      </Tap>
      <View style={{flex: 1}} />
      <TopRight tv />
    </View>
    </>
  );
}

/** The bar's height below its top (the 42 dp gear). */
export const TOP_BAR_H = 42;
export {StatusScrim};

const s = StyleSheet.create({
  bar: {position: 'absolute', left: GUTTER, right: GUTTER, height: 42, flexDirection: 'row', alignItems: 'center', zIndex: 10},
  right: {flexDirection: 'row', alignItems: 'center', gap: 10},
  logo: {
    width: 50,
    height: 40,
    marginTop: 4,
    borderRadius: 20,
    paddingLeft: 8,
    justifyContent: 'center',
    backgroundColor: E.chrome,
    ...E_EDGE_FLOAT,
  },
});
