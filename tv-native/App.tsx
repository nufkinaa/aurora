// Aurora TV — boot. THE RULES LIVE IN src/AppRoot.tsx (shared with the phone
// app, src/phone/PhoneApp.tsx); this file hands it the TV's screens. What
// follows is what AppRoot does:
//
//   loading → find the server, restore the session
//   offline → neither address answered; retry, and nothing else to do
//   gate    → have a server, need a profile
//   home    → have both
//   reset   → signed in, and the admin asked for a new password first. THIS
//             ONE BLOCKS: the only ways off it are a new password or signing
//             out; Back does nothing, and it comes up again at the next
//             launch (storage.ts `aurora.mustReset`) and whenever the server
//             refuses a request with {passwordResetRequired:true}.
//   banned  → the admin banned this address; nothing reconnects by itself
//
// LOSING THE SIGN-IN WHILE THE APP IS OPEN — an admin's kick, "Sign out
// everywhere else" pressed on another device — is answered the way the
// website answers it (public/js/session.js): say why, then start over from
// boot, which already knows where a TV without a sign-in belongs (the sign-in
// screen when the server requires one, the profile wall otherwise — or
// straight back in, when nothing this TV holds was actually revoked).
//
// EVERY PROFILE CHANGE EMPTIES WHAT WAS HELD IN MEMORY FOR THE LAST PROFILE
// (profileScope.ts clearProfileCaches): leaving a profile, entering one,
// signing out, being signed out.
//
// THE VIEWER IS NEVER ASKED WHERE THE SERVER IS. Two addresses live in
// api.ts's SERVER_CANDIDATES and are tried in that order (src/serverPick.ts):
// nufurora.com first, and the house server only when nufurora.com does not
// answer — for this run; the next launch, and every Retry, starts at the first
// address again. The setup screen that used to ask is deleted.
import {clearHomeScreen, noteAppRun} from './src/homeScreen';
import React from 'react';
import {View, StatusBar, ActivityIndicator, StyleSheet, Text} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {TvCanvas} from './src/canvas';
import ProfileGate from './src/screens/ProfileGate';
import SessionWiring from './src/SessionWiring';
import SignIn from './src/screens/SignIn';
import {ErrorState} from './src/components/States';
import NewPassword from './src/screens/NewPassword';
import AppNavigator from './src/navigation';
import AppRoot, {RootUi} from './src/AppRoot';
import theme from './src/theme';

export type {SignInExtra} from './src/AppRoot';

const Frame = ({children}: {children?: React.ReactNode}) => (
  <SafeAreaProvider>
    <View style={styles.root}>
      <StatusBar hidden />
      <TvCanvas>{children}</TvCanvas>
    </View>
  </SafeAreaProvider>
);

const TV_UI: RootUi = {
  Frame,
  Loading: ({note}) => (
    <View style={styles.center}>
      <ActivityIndicator color={theme.colors.text} size="large" />
      {/* the patient start (serverPick.ts pickServerPatiently): said once it is taking a while */}
      <Text style={[styles.note, {opacity: note ? 1 : 0}]}>{note || ' '}</Text>
    </View>
  ),
  Offline: ({onRetry}) => (
    <ErrorState
      message="Can't reach Aurora."
      detail="Tried nufurora.com and the house server. Check the server is running, then try again."
      edgeLeft={false}
      onAction={onRetry}
    />
  ),
  Banned: ({reason, onRetry}) => (
    <ErrorState
      message="Access denied"
      detail={reason || 'This TV has been banned from this server.'}
      actionLabel="Try again"
      edgeLeft={false}
      onAction={onRetry}
    />
  ),
  Gate: ProfileGate,
  SignIn,
  NewPassword,
  Main: () => (
    <>
      <SessionWiring />
      <AppNavigator />
    </>
  ),
  // A new run of the root (a new Activity — Back from Home ends one but keeps
  // the process): the launcher link it was opened with is opened (homeScreen.ts).
  onRun: () => {
    noteAppRun();
  },
  // this profile's rows leave the TV's home screen with it
  onLeaveProfile: clearHomeScreen,
};

export default function App() {
  return <AppRoot ui={TV_UI} />;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: theme.colors.bg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  note: {marginTop: 18, color: theme.colors.textDim, fontSize: theme.fontSize.body},
});
