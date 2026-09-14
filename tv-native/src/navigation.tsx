// The authenticated app's screen stack. Mounted only once a profile is chosen
// (App.tsx owns the setup/gate flow outside the navigator). Android TV's
// hardware Back pops this stack automatically via react-navigation.
import React, {useRef} from 'react';
import {View, StyleSheet} from 'react-native';
import {DefaultTheme, NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import Home from './screens/Home';
import Browse from './screens/Browse';
import MyList from './screens/MyList';
import Settings from './screens/Settings';
import Search from './screens/Search';
import Detail from './screens/Detail';
import Sources from './screens/Sources';
import WhatsNew from './screens/WhatsNew';
import Downloads from './screens/Downloads';
import Player from './playback/Player';
import Ambient from './components/Ambient';
import Overlays from './components/Overlays';
import {HeroItem, TorrentPlayItem} from './api';
import {navRef} from './rootNav';
import {track} from './usage';
import theme from './theme';

export type RootStackParamList = {
  Home: undefined;
  Browse: {kind: 'movie' | 'show'};
  MyList: undefined;
  Settings: undefined;
  Search: undefined;
  WhatsNew: undefined;
  Downloads: undefined;
  Detail: {item: HeroItem};
  Sources: {
    type: 'movie' | 'series';
    imdbId: string;
    title: string;
    year?: number | null;
    season?: number | null;
    episode?: number | null;
    // The title's runtime, so the play item can give the player a real total
    // length for a file that is still downloading.
    runtime?: string | number | null;
    // The poster, carried only so a torrent play-item can save a Continue
    // Watching card that isn't blank (see TorrentPlayItem's card metadata).
    poster?: string | null;
  };
  // `stream` is set for torrent playback (built by the Sources screen); library
  // items pass only id + title and the player fetches /api/item.
  // `restart` is the site's `?restart=1`: play from 0 and ignore the saved
  // position (Detail's "Start over").
  // `party` is a watch-party code to join once the player is up.
  Player: {id: string; title: string; stream?: TorrentPlayItem; restart?: boolean; party?: string};
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// TRANSPARENT, not the page colour: the ambient canvas is mounted once behind
// the whole navigator (below), and an opaque screen background would hide it.
const navTheme = {
  ...DefaultTheme,
  colors: {...DefaultTheme.colors, background: 'transparent'},
};

export default function AppNavigator() {
  const routeAt = useRef(Date.now());
  return (
    <View style={styles.root}>
      <Ambient />
      <NavigationContainer
        ref={navRef}
        theme={navTheme}
        // Usage stats: which screens are opened, and how long the last one held.
        onStateChange={() => {
          const r = navRef.getCurrentRoute();
          if (!r) return;
          const p = r.params as {kind?: string} | undefined;
          const name = r.name === 'Browse' && p?.kind ? `${r.name}/${p.kind}` : r.name;
          track('route', {r: `tv:${name.toLowerCase()}`, ms: Math.min(120000, Date.now() - routeAt.current)});
          routeAt.current = Date.now();
        }}>
        <Stack.Navigator
        // freezeOnBlur: screens buried in the stack stop re-rendering entirely,
        // so none of their timers/effects steal JS-thread time from the screen
        // the user is actually on.
        screenOptions={{
          headerShown: false,
          animation: 'fade',
          animationDuration: 260,
          freezeOnBlur: true,
          contentStyle: {backgroundColor: 'transparent'},
        }}>
        <Stack.Screen name="Home" component={Home} />
        <Stack.Screen name="Browse" component={Browse} />
        <Stack.Screen name="MyList" component={MyList} />
        <Stack.Screen name="Settings" component={Settings} />
        <Stack.Screen name="Search" component={Search} />
        <Stack.Screen name="WhatsNew" component={WhatsNew} />
        <Stack.Screen name="Downloads" component={Downloads} />
        <Stack.Screen name="Detail" component={Detail} />
        <Stack.Screen name="Sources" component={Sources} />
        {/* No fade for the player: cross-fading a video surface is expensive
            on a TV GPU and reads as a flicker rather than a transition. */}
        <Stack.Screen name="Player" component={Player} options={{animation: 'none'}} />
        </Stack.Navigator>
      </NavigationContainer>
      {/* Toasts and the one app-wide sheet, above every screen. */}
      <Overlays />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: theme.colors.bg},
});
