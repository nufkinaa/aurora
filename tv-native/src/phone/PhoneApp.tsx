// Aurora for Android phones — the root (index.phone.js registers it as
// "AuroraPhone"). Boot, sign-in and every rule about who is in which profile
// are the TV app's own (src/AppRoot.tsx); this file hands it the phone's
// screens: the glass "Who's watching?" wall, the sign-in page, the forced new
// password, and — once inside a profile — the tabs and the stack
// (navigation.tsx), with the same session wiring as the TV (the socket, usage
// stats, settings that follow the person, the household's recommendations).
import React, {useEffect} from 'react';
import {ActivityIndicator, Image, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import AppRoot, {RootUi} from '../AppRoot';
import SessionWiring from '../SessionWiring';
import {useApp} from '../AppContext';
import {loadMe} from '../navSection';
import Gate from './screens/Gate';
import SignIn from './screens/SignIn';
import NewPassword from './screens/NewPassword';
import PhoneNavigator from './navigation';
import Sky from './ui/Sky';
import {GlassButton} from './ui/Buttons';
import {wireProfileMenu} from './profileMenu';
import {resetTabs} from './tabs';
import {flushOfflineProgress} from './offline/store';
import './remote/controller'; // the profile's TVs, heard from the first socket open
import {colors, GUTTER} from './theme';

const LOGO = require('../assets/logo-mark.png');

const Frame = ({children}: {children?: React.ReactNode}) => (
  <SafeAreaProvider>
    <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />
    <View style={s.root}>{children}</View>
  </SafeAreaProvider>
);

function Notice({title, detail, action, onAction}: {title: string; detail: string; action: string; onAction: () => void}) {
  return (
    <View style={s.center}>
      <Sky dim />
      <Image source={LOGO} style={s.logo} resizeMode="contain" />
      <Text style={s.title}>{title}</Text>
      <Text style={s.detail}>{detail}</Text>
      <GlassButton label={action} icon="refresh" onPress={onAction} style={{marginTop: 20}} />
    </View>
  );
}

function Main() {
  const {profileId, switchProfile} = useApp();
  useEffect(() => {
    wireProfileMenu({
      switchProfile: () => {
        resetTabs();
        switchProfile();
      },
      name: () => '',
    });
    // what was watched on a saved copy while the server could not hear it
    flushOfflineProgress();
    loadMe(profileId)
      .then(me => wireProfileMenu({switchProfile: () => (resetTabs(), switchProfile()), name: () => me?.name || ''}))
      .catch(() => {});
  }, [profileId, switchProfile]);
  return (
    <>
      <SessionWiring />
      <PhoneNavigator />
    </>
  );
}

const PHONE_UI: RootUi = {
  Frame,
  Loading: () => (
    <View style={s.center}>
      <Sky dim />
      <Image source={LOGO} style={s.logo} resizeMode="contain" />
      <ActivityIndicator color={colors.text} size="large" style={{marginTop: 18}} />
    </View>
  ),
  Offline: ({onRetry}) => (
    <Notice
      title="Can't reach Aurora."
      detail="Tried nufurora.com and the house server. Check your connection, then try again."
      action="Try again"
      onAction={onRetry}
    />
  ),
  Banned: ({reason, onRetry}) => (
    <Notice title="Access denied" detail={reason || 'This phone has been banned from this server.'} action="Try again" onAction={onRetry} />
  ),
  Gate,
  SignIn,
  NewPassword,
  Main,
};

export default function PhoneApp() {
  return <AppRoot ui={PHONE_UI} />;
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: GUTTER * 2},
  logo: {width: 72, height: 72},
  title: {color: colors.text, fontSize: 24, fontWeight: '800', marginTop: 18, textAlign: 'center'},
  detail: {color: colors.textDim, fontSize: 16, marginTop: 8, textAlign: 'center', lineHeight: 22},
});
