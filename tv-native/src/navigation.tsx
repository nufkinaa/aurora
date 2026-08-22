// The authenticated app's screen stack. Mounted only once a profile is chosen
// (App.tsx owns the setup/gate flow outside the navigator). Android TV's
// hardware Back pops this stack automatically via react-navigation.
import React from 'react';
import {View, StyleSheet} from 'react-native';
import {NavigationContainer, DefaultTheme} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import Home from './screens/Home';
import Browse from './screens/Browse';
import MyList from './screens/MyList';
import Settings from './screens/Settings';
import Games from './screens/Games';
import Search from './screens/Search';
import Detail from './screens/Detail';
import Sources from './screens/Sources';
import Player from './playback/Player';
import Ambient from './components/Ambient';
import {HeroItem, TorrentPlayItem} from './api';
import theme from './theme';

export type RootStackParamList = {
  Home: undefined;
  Browse: {kind: 'movie' | 'show'};
  MyList: undefined;
  Settings: undefined;
  Games: undefined;
  Search: undefined;
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
  Player: {id: string; title: string; stream?: TorrentPlayItem; restart?: boolean};
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// TRANSPARENT, not the page colour: the ambient canvas is mounted once behind
// the whole navigator (below), and an opaque screen background would hide it.
// On the site this background belongs to `html`/`body`, not to any one screen,
// so doing it here is both faithful and the only place it has to be written.
const navTheme = {
  ...DefaultTheme,
  colors: {...DefaultTheme.colors, background: 'transparent'},
};

export default function AppNavigator() {
  return (
    <View style={styles.root}>
      <Ambient />
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator
        // A short cross-fade between screens. This was 'none' on the theory that
        // instant swaps read as "fast", but with nothing easing the change the
        // whole app felt like it was cutting rather than moving, which is the
        // opposite of how the site behaves. 180ms is quick enough not to be a
        // wait and long enough to read as motion.
        //
        // freezeOnBlur: screens buried in the stack (Home under Detail under
        // Player…) stop re-rendering entirely, so none of their timers/effects
        // steal JS-thread time from the screen the user is actually on.
        screenOptions={{
          headerShown: false,
          animation: 'fade',
          // 260, up from 180. Measured off a screen recording, the swap was
          // landing inside two frames (~66ms) and reading as a cut. It is now
          // long enough to see and still well under the quarter-second where a
          // transition starts feeling like a wait.
          animationDuration: 260,
          freezeOnBlur: true,
          contentStyle: {backgroundColor: 'transparent'},
        }}>
        <Stack.Screen name="Home" component={Home} />
        <Stack.Screen name="Browse" component={Browse} />
        <Stack.Screen name="MyList" component={MyList} />
        <Stack.Screen name="Settings" component={Settings} />
        <Stack.Screen name="Games" component={Games} />
        <Stack.Screen name="Search" component={Search} />
        <Stack.Screen name="Detail" component={Detail} />
        <Stack.Screen name="Sources" component={Sources} />
        {/* No fade for the player: cross-fading a video surface is expensive
            on a TV GPU and reads as a flicker rather than a transition. */}
        <Stack.Screen name="Player" component={Player} options={{animation: 'none'}} />
        </Stack.Navigator>
      </NavigationContainer>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: theme.colors.bg},
});
