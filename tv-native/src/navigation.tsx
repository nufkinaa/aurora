// The authenticated app's screen stack. Mounted only once a profile is chosen
// (App.tsx owns the setup/gate flow outside the navigator). Android TV's
// hardware Back pops this stack automatically via react-navigation.
import React, {useEffect, useRef} from 'react';
import {View, StyleSheet} from 'react-native';
import {DefaultTheme, NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import Home from './screens/Home';
import Ambient from './components/Ambient';
import Overlays from './components/Overlays';
import {HeroItem, TorrentPlayItem} from './api';
import {navRef} from './rootNav';
import {track} from './usage';
import {frameScreen} from './perfTier';
import {focusJustMoved} from './focus';

// EVERY SCREEN BUT HOME IS LOADED WHEN IT IS FIRST WANTED.
//
// Metro inlines requires (@react-native/metro-config: inlineRequires), so an
// `import Player from './playback/Player'` is only evaluated where `Player` is
// first READ — and `component={Player}` read all eleven in this navigator's
// first render: the 4,000-line player, the title page, react-native-video's
// JS, every StyleSheet, all before Home's first frame. `getComponent` is read
// by the navigator only when a route of that name is rendered, so each module
// is now evaluated on the first visit to its screen (the require is cached:
// the same component every time after).
//
// So that the first visit does not pay for it either, they are also evaluated
// one at a time once Home has been up a few seconds — and only while the
// remote is at rest, because evaluating a module is tens of milliseconds of
// JS that must not sit in front of a keypress (`warmScreens`, below). A
// screen opened before its turn is simply evaluated then, as part of opening.
//
// In the order they are likely to be wanted.
const SCREENS = {
  Detail: () => require('./screens/Detail').default,
  Player: () => require('./playback/Player').default,
  Browse: () => require('./screens/Browse').default,
  Search: () => require('./screens/Search').default,
  MyList: () => require('./screens/MyList').default,
  Settings: () => require('./screens/Settings').default,
  Downloads: () => require('./screens/Downloads').default,
  Pick: () => require('./screens/Pick').default,
  WhatsNew: () => require('./screens/WhatsNew').default,
  Sources: () => require('./screens/Sources').default,
} as const;

const WARM_FIRST_MS = 6000; // after Home's own first seconds (its rows, its pictures, the trailer lookup)
const WARM_GAP_MS = 600;
const WARM_IDLE_MS = 1500; // "the remote is at rest": no focus move for this long
function warmScreens() {
  const todo = Object.values(SCREENS);
  let i = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const next = () => {
    timer = null;
    if (i >= todo.length) return;
    if (focusJustMoved(WARM_IDLE_MS)) {
      timer = setTimeout(next, 1000);
      return;
    }
    try {
      todo[i++]();
    } catch {}
    timer = setTimeout(next, WARM_GAP_MS);
  };
  timer = setTimeout(next, WARM_FIRST_MS);
  return () => {
    if (timer) clearTimeout(timer);
  };
}

export type RootStackParamList = {
  Home: undefined;
  Browse: {kind: 'movie' | 'show'};
  MyList: undefined;
  Settings: undefined;
  Search: undefined;
  WhatsNew: undefined;
  Pick: undefined;
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
  // `epTitle` is the episode's real name from the page that launched it (the
  // library record may only know "Episode 1").
  Player: {id: string; title: string; epTitle?: string; stream?: TorrentPlayItem; restart?: boolean; party?: string};
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
  useEffect(() => warmScreens(), []);
  return (
    <View style={styles.root}>
      <Ambient />
      <NavigationContainer
        ref={navRef}
        theme={navTheme}
        // The frame monitor (perfTier.ts) tags what it counts with the screen
        // on show.
        onReady={() => frameScreen((navRef.getCurrentRoute()?.name || 'home').toLowerCase())}
        // Usage stats: which screens are opened, and how long the last one held.
        onStateChange={() => {
          const r = navRef.getCurrentRoute();
          if (!r) return;
          const p = r.params as {kind?: string} | undefined;
          const name = r.name === 'Browse' && p?.kind ? `${r.name}/${p.kind}` : r.name;
          track('route', {r: `tv:${name.toLowerCase()}`, ms: Math.min(120000, Date.now() - routeAt.current)});
          routeAt.current = Date.now();
          frameScreen(r.name.toLowerCase());
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
        <Stack.Screen name="Browse" getComponent={SCREENS.Browse} />
        <Stack.Screen name="MyList" getComponent={SCREENS.MyList} />
        <Stack.Screen name="Settings" getComponent={SCREENS.Settings} />
        <Stack.Screen name="Search" getComponent={SCREENS.Search} />
        <Stack.Screen name="WhatsNew" getComponent={SCREENS.WhatsNew} />
        <Stack.Screen name="Pick" getComponent={SCREENS.Pick} />
        <Stack.Screen name="Downloads" getComponent={SCREENS.Downloads} />
        <Stack.Screen name="Detail" getComponent={SCREENS.Detail} />
        <Stack.Screen name="Sources" getComponent={SCREENS.Sources} />
        {/* No fade for the player: cross-fading a video surface is expensive
            on a TV GPU and reads as a flicker rather than a transition. */}
        <Stack.Screen name="Player" getComponent={SCREENS.Player} options={{animation: 'none'}} />
        </Stack.Navigator>
      </NavigationContainer>
      {/* Toasts and the one app-wide sheet, above every screen. */}
      <Overlays />
    </View>
  );
}

const styles = StyleSheet.create({
  // No page colour here: Ambient (below everything) paints it until its
  // opaque canvas has drawn, and nothing after that — a full-screen fill
  // under an opaque picture was one more layer of overdraw on every frame.
  root: {flex: 1},
});
