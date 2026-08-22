// Aurora TV — boot.
//   loading → find the server, restore the session
//   offline → neither address answered; retry, and nothing else to do
//   gate    → have a server, need a profile
//   home    → have both
//
// THE VIEWER IS NEVER ASKED WHERE THE SERVER IS. Two addresses live in
// api.ts's SERVER_CANDIDATES: the LAN one is tried first, and if it does not
// answer on the first try the remote one becomes the server for this run. The
// setup screen that used to ask is deleted.
import React, {useEffect, useState} from 'react';
import {View, StatusBar, ActivityIndicator, StyleSheet} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import ProfileGate from './src/screens/ProfileGate';
import {ErrorState} from './src/components/States';
import AppNavigator from './src/navigation';
import {AppContext} from './src/AppContext';
import {api, setBaseUrl, setToken, resolveServer} from './src/api';
import {
  loadSession,
  saveServerUrl,
  saveProfile,
  clearProfile,
  Session,
} from './src/storage';
import theme from './src/theme';

type Stage = 'loading' | 'offline' | 'gate' | 'home';

export default function App() {
  const [stage, setStage] = useState<Stage>('loading');
  // Bumped by the offline state's Retry, so boot runs again.
  const [boot, setBoot] = useState(0);
  const [session, setSession] = useState<Session>({
    serverUrl: null,
    profileId: null,
    token: null,
  });

  // Boot: restore whatever we remembered and jump to the furthest valid stage.
  // The saved server URL is health-checked first; if it stopped answering
  // (the PC's IP changed), the known fallback addresses are tried and the one
  // that answers replaces it. Only when nothing answers does setup reappear.
  useEffect(() => {
    // Cancellation guard: two Retry presses used to run two boots in parallel,
    // and the slower one's `offline` verdict could land AFTER the faster one
    // had already reached home.
    let alive = true;
    setStage('loading');
    (async () => {
      const s = await loadSession();
      // No saved URL is not a special case any more: the addresses are in code.
      const live = await resolveServer(s.serverUrl);
      if (!alive) return;
      if (!live) {
        setSession(s);
        setStage('offline');
        return;
      }
      if (live !== s.serverUrl) await saveServerUrl(live);
      if (!alive) return;
      setBaseUrl(live);
      setToken(s.token);

      // Validate the remembered profile session. Unlock tokens live in server
      // RAM, so after a server restart the saved token is silently dead — the
      // app then "worked" but got the NON-personalized home (no My List, no
      // Continue Watching, stream rows missing). Catch that here and drop to
      // the gate instead so the user re-enters the profile properly.
      if (s.profileId) {
        try {
          await api.state(s.profileId); // 200 = profile accessible with this token
          if (!alive) return;
        } catch {
          if (!alive) return;
          await clearProfile();
          setToken(null);
          setSession({...s, serverUrl: live, profileId: null, token: null});
          setStage('gate');
          return;
        }
      }

      setSession({...s, serverUrl: live});
      setStage(s.profileId ? 'home' : 'gate');
    })();
    return () => {
      alive = false;
    };
  }, [boot]);

  const onChosen = async (profileId: string, token: string | null) => {
    setToken(token);
    await saveProfile(profileId, token);
    setSession(s => ({...s, profileId, token}));
    setStage('home');
  };

  const switchProfile = async () => {
    await clearProfile();
    // Deliberately NOT setToken(null) here: the navigator is still mounted at
    // this point, and the Player's unmount cleanup saves the current playback
    // position — clearing the api token first made that final save go out
    // without X-Profile-Token, a silent 403 on any protected profile, so
    // switching profiles mid-film lost your place. The effect below clears the
    // token AFTER the stage change has committed (and the unmount saves have
    // been dispatched with the old token).
    setSession(s => ({...s, profileId: null, token: null}));
    setStage('gate');
  };
  useEffect(() => {
    if (stage === 'gate') setToken(null);
  }, [stage]);

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar hidden />
        {stage === 'loading' ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.colors.text} size="large" />
          </View>
        ) : null}

        {stage === 'offline' ? (
          <ErrorState
            message="Can't reach Aurora."
            detail="Tried the house server and the remote one. Check the server is running, then try again."
            edgeLeft={false}
            onAction={() => setBoot(n => n + 1)}
          />
        ) : null}

        {stage === 'gate' ? (
          <ProfileGate onChosen={onChosen} />
        ) : null}

        {stage === 'home' && session.profileId ? (
          <AppContext.Provider
            value={{profileId: session.profileId, switchProfile}}>
            <AppNavigator />
          </AppContext.Provider>
        ) : null}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: theme.colors.bg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
});
