// Games — the site's 21 arcade games, shown in a WebView.
//
// This is the one screen that is NOT a native reimplementation, on purpose. The
// games are HTML5 canvas games driven by /js/games/engine.js + arcade.js, with
// their own leaderboards and overlay contract. React Native has no canvas, so a
// native port would mean rewriting all 21 by hand and then maintaining two
// copies of every game — while the WebView runs the exact same code the browser
// runs, from the same server, and stays in sync for free.
//
// The remote works because the engine already reads arrow keys and Enter: an
// Android TV D-pad arrives as those very key events.
import React, {useRef, useState} from 'react';
import {View, Text, StyleSheet, ActivityIndicator, BackHandler} from 'react-native';
import {WebView} from 'react-native-webview';
import type {WebViewProps} from 'react-native-webview';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useFocusEffect} from '@react-navigation/native';
import Focusable from '../components/Focusable';
import NavRail from '../components/NavRail';
import {getBaseUrl, getToken} from '../api';
import {useApp} from '../AppContext';
import {canNavigate} from '../navLock';
import {RootStackParamList} from '../navigation';
import theme from '../theme';

const {colors, fontSize, spacing} = theme;

// react-native-webview types its export as a plain FunctionComponent, which has
// no `ref` in React's typings — even though the component does forward one at
// runtime. Only the ref is re-declared here; every other prop stays checked.
type WebViewHandle = {goBack: () => void};
const RefWebView = WebView as unknown as React.ComponentType<
  WebViewProps & {ref?: React.Ref<WebViewHandle>}
>;

export default function Games({
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'Games'>) {
  const {profileId} = useApp();
  const token = getToken();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const webRef = useRef<WebViewHandle>(null);

  // BACK inside a game should leave the game, not the whole screen — the games
  // page is a hash route, so history.back() lands on its own grid. Only once the
  // WebView has nowhere left to go do we pop the screen.
  //
  // Belt and braces: `canGoBack` is whatever the WebView last REPORTED, and a
  // stale `true` would make this screen inescapable (the rail is passive here,
  // so Back is the only exit). A second Back inside 1.2s therefore always pops —
  // mashing Back can never be trapped by a WebView that stopped answering.
  const canGoBack = useRef(false);
  const lastWebBack = useRef(0);
  useFocusEffect(
    React.useCallback(() => {
      const onBack = () => {
        const now = Date.now();
        if (canGoBack.current && now - lastWebBack.current > 1200) {
          lastWebBack.current = now;
          webRef.current?.goBack();
          return true;
        }
        return false; // let the navigator pop
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
      return () => sub.remove();
    }, []),
  );

  const url = `${getBaseUrl()}/#/games`;

  // The WebView is a fresh browser with empty storage, so the site showed its own
  // "Who's watching?" gate instead of the games. The native app has already
  // picked a profile and holds its unlock token, so seed the exact keys the site
  // reads (state.js): the id in localStorage, the token in sessionStorage for
  // this session only — the same split the site itself uses.
  const seed = `
    try {
      localStorage.setItem('aurora-profile', ${JSON.stringify(profileId)});
      ${token ? `sessionStorage.setItem('aurora-token-' + ${JSON.stringify(profileId)}, ${JSON.stringify(token)});` : ''}
    } catch (e) {}
    // Hide the site's own header inside the WebView — the native one is already
    // on screen above it, and two stacked navs looked like a rendering fault.
    // Its screens pad the top to clear a fixed nav that is no longer there, so
    // that gap is reclaimed too.
    (function () {
      var css = '#nav,.nav{display:none!important}' +
                '#app>.screen>*:first-child{padding-top:16px!important}';
      var add = function () {
        if (!document.head) return false;
        var el = document.createElement('style');
        el.textContent = css;
        document.head.appendChild(el);
        return true;
      };
      if (!add()) document.addEventListener('DOMContentLoaded', add);
    })();
    true;
  `;

  return (
    <View style={styles.root}>
      {/* passive: the WebView never reports where focus is, so LEFT cannot be
          trusted here — and inside a game LEFT is how you steer. The strip still
          says which section you are in; Back is the way out. The native games
          grid in 09-secondary is what makes the gesture safe here. */}
      <NavRail active="games" passive />
      {failed ? (
        <View style={styles.center}>
          <Text style={styles.error}>Couldn't load the games.</Text>
          <Focusable
            round
            hasTVPreferredFocus
            edgeLeft
            onPress={() => canNavigate(navigation) && navigation.goBack()}
            style={styles.back}>
            <Text style={styles.backText}>‹ Back</Text>
          </Focusable>
        </View>
      ) : (
        <>
          <RefWebView
            ref={webRef}
            source={{uri: url}}
            style={styles.web}
            // Must run BEFORE the page's own scripts, or the site's boot has
            // already decided to show the profile gate.
            injectedJavaScriptBeforeContentLoaded={seed}
            // The page is our own server's; nothing here needs to reach outside.
            javaScriptEnabled
            domStorageEnabled
            mediaPlaybackRequiresUserAction={false}
            // Keep the games' own dark page from flashing white while it loads.
            containerStyle={styles.web}
            onLoadEnd={() => setLoading(false)}
            onError={() => {
              setLoading(false);
              setFailed(true);
            }}
            onNavigationStateChange={s => (canGoBack.current = s.canGoBack)}
          />
          {loading ? (
            <View style={styles.center} pointerEvents="none">
              <ActivityIndicator color={colors.text} size="large" />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // No backgroundColor: android:windowBackground already paints it.
  root: {flex: 1},
  // The document starts after the rail, same as every other screen's content.
  // Note the WebView owns the D-pad while it holds focus, so LEFT does not reach
  // the rail from inside a game — Back is the way out.
  web: {flex: 1, marginLeft: spacing.contentLeft, backgroundColor: colors.bg},
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  error: {color: colors.textDim, fontSize: fontSize.body},
  back: {backgroundColor: colors.surface, paddingVertical: 12, paddingHorizontal: 28},
  backText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
});
