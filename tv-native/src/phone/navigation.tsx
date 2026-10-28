// The phone app's screen stack. The same route NAMES as the TV's
// (navigation.tsx RootStackParamList), so every shared module that opens a
// screen — openItem.ts, the party client, the overlays — opens the phone's
// version of it. The first route, "Home", is the five tabs of the bottom bar
// (screens/Tabs.tsx); the rest are pushed over them with Android's own slide.
// Back, the gesture or the button, pops — predictive back included.
import React, {useEffect, useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {DefaultTheme, NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../navigation';
import {navRef} from '../rootNav';
import {routeStarted} from '../routeTiming';
import {frameScreen} from '../perfTier';
import Tabs from './screens/Tabs';
import TabBar from './ui/TabBar';
import Sky from './ui/Sky';
import PhoneOverlays from './Overlays';
import {useLinks} from './links';

export type PhoneStackParamList = RootStackParamList & {
  Remote: undefined;
  OfflinePlayer: {id: string};
};

const SCREENS = {
  Detail: () => require('./screens/Detail').default,
  Player: () => require('./screens/Player').default,
  Sources: () => require('./screens/Sources').default,
  Settings: () => require('./screens/Settings').default,
  Downloads: () => require('./screens/Downloads').default,
  Household: () => require('./screens/Household').default,
  Remote: () => require('./screens/Remote').default,
  Browse: () => require('./screens/Browse').default,
  Search: () => require('./screens/Search').SearchRoute,
  MyList: () => require('./screens/MyList').default,
  OfflinePlayer: () => require('./screens/OfflinePlayer').default,
} as const;

// evaluated one at a time after Home has had its first seconds (the TV's warmScreens)
function warm() {
  const todo = [SCREENS.Detail, SCREENS.Player, SCREENS.Sources, SCREENS.Settings];
  let i = 0;
  let t: ReturnType<typeof setTimeout> | null = setTimeout(function next() {
    t = null;
    if (i >= todo.length) return;
    try {
      todo[i++]();
    } catch {}
    t = setTimeout(next, 700);
  }, 5000);
  return () => {
    if (t) clearTimeout(t);
  };
}

const Stack = createNativeStackNavigator<PhoneStackParamList>();
const navTheme = {...DefaultTheme, dark: true, colors: {...DefaultTheme.colors, background: 'transparent', card: 'transparent', text: '#f3f4f8'}};


export default function PhoneNavigator() {
  useEffect(() => warm(), []);
  useLinks();
  // the tab bar is drawn over every screen but the player
  const [route, setRoute] = useState('Home');
  return (
    <View style={s.root}>
      <Sky />
      <NavigationContainer
        ref={navRef as never}
        theme={navTheme}
        onReady={() => {
          const r = navRef.getCurrentRoute();
          if (r) routeStarted(`phone:${r.name.toLowerCase()}`, r.key);
          frameScreen((r?.name || 'home').toLowerCase());
          setRoute(r?.name || 'Home');
        }}
        onStateChange={() => {
          const r = navRef.getCurrentRoute();
          if (!r) return;
          routeStarted(`phone:${r.name.toLowerCase()}`, r.key);
          frameScreen(r.name.toLowerCase());
          setRoute(r.name);
        }}>
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            animation: 'slide_from_right',
            freezeOnBlur: true,
            contentStyle: {backgroundColor: 'transparent'},
            statusBarTranslucent: true,
            statusBarStyle: 'light',
            navigationBarTranslucent: true,
          }}>
          <Stack.Screen name="Home" component={Tabs} />
          <Stack.Screen name="Detail" getComponent={SCREENS.Detail} />
          <Stack.Screen name="Sources" getComponent={SCREENS.Sources} />
          <Stack.Screen name="Settings" getComponent={SCREENS.Settings} />
          <Stack.Screen name="Downloads" getComponent={SCREENS.Downloads} />
          <Stack.Screen name="Household" getComponent={SCREENS.Household} />
          <Stack.Screen name="Remote" getComponent={SCREENS.Remote} />
          <Stack.Screen name="Browse" getComponent={SCREENS.Browse} />
          <Stack.Screen name="Search" getComponent={SCREENS.Search} />
          <Stack.Screen name="MyList" getComponent={SCREENS.MyList} />
          <Stack.Screen
            name="OfflinePlayer"
            getComponent={SCREENS.OfflinePlayer}
            options={{animation: 'fade', statusBarHidden: true, navigationBarHidden: true, orientation: 'landscape'}}
          />
          <Stack.Screen
            name="Player"
            getComponent={SCREENS.Player}
            options={{animation: 'fade', statusBarHidden: true, navigationBarHidden: true, orientation: 'landscape'}}
          />
        </Stack.Navigator>
      </NavigationContainer>
      {route !== 'Player' && route !== 'OfflinePlayer' ? <TabBar /> : null}
      <PhoneOverlays />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
});
