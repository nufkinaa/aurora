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
import {GUTTER} from '../theme';
import {BarBand, StatusScrim} from './Scrims';

const LOGO = require('../../assets/logo-mark.png');

export default function TopBar({transparent = true, solid}: {transparent?: boolean; solid?: boolean}) {
  const insets = useSafeAreaInsets();
  const {profileId} = useApp();
  const me = useMe(profileId);
  return (
    <>
    {solid ? <BarBand /> : <StatusScrim />}
    <View pointerEvents="box-none" style={[s.bar, {top: insets.top + 8}, !transparent && s.solid]}>
      <IconCircle uiId="nav.home" label="Aurora — Home" onPress={() => setTab('home')} size={46} style={s.logo}>
        <Image source={LOGO} style={{width: 30, height: 30}} resizeMode="contain" />
      </IconCircle>
      <View style={{flex: 1}} />
      <IconCircle uiId="nav.settings" icon="gear" label="Settings" onPress={() => pushScreen('Settings', undefined)} />
      <IconCircle uiId="nav.profile" label={`${me?.name || 'Profile'} — profile menu`} onPress={() => openProfileMenu()} style={{marginLeft: 10}}>
        <Avatar p={me} size={38} round />
      </IconCircle>
    </View>
    </>
  );
}


export const TOP_BAR_H = 62;
export {StatusScrim};

const s = StyleSheet.create({
  bar: {position: 'absolute', left: GUTTER, right: GUTTER, flexDirection: 'row', alignItems: 'center', zIndex: 10},
  solid: {},
  logo: {width: 58, borderRadius: 23},
});
