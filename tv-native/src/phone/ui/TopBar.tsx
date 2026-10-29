// The top bar of a tab screen (the website's glass look): the Aurora mark on
// the left, settings and you on the right — round glass buttons floating over
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
import {setTab} from '../tabs';
import {G_EDGE, G_FILL, GUTTER} from '../theme';
import Tap from './Tap';
import {BarBand, StatusScrim} from './Scrims';

const LOGO = require('../../assets/logo-mark.png');

/** The right-hand pills (.nav-gear · .nav-profile): settings and you, 10 apart. */
export function TopRight({noSettings}: {noSettings?: boolean}) {
  const {profileId} = useApp();
  const me = useMe(profileId);
  return (
    <View style={s.right}>
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
      <TopRight />
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
    backgroundColor: 'rgba(96,84,230,0.16)',
    experimental_backgroundImage: G_FILL,
    ...G_EDGE,
  },
});
