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
import SignIn from './src/screens/SignIn';
import {ErrorState} from './src/components/States';
import AppNavigator from './src/navigation';
import {AppContext} from './src/AppContext';
import {
  api,
  getAuthMode,
  onSigninRequired,
  resolveServer,
  setBaseUrl,
  setSession,
  setToken,
} from './src/api';
import {
  loadSession,
  saveAuthSession,
  saveServerUrl,
  saveProfile,
  clearProfile,
  Session,
} from './src/storage';
import theme from './src/theme';

type Stage = 'loading' | 'offline' | 'gate' | 'login' | 'home';

export default function App() {
  const [stage, setStage] = useState<Stage>('loading');
  // Bumped by the offline state's Retry, so boot runs again.
  const [boot, setBoot] = useState(0);
  const [session, setLocal] = useState<Session>({
    serverUrl: null,
    profileId: null,
    token: null,
    session: null,
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
        setLocal(s);
        setStage('offline');
        return;
      }
      if (live !== s.serverUrl) await saveServerUrl(live);
      if (!alive) return;
      setBaseUrl(live);
      setToken(s.token);
      setSession(s.session);
      const mode = getAuthMode(); // captured by the ping that found the server

      // CLOSED mode (prompt 10): the picker is gone — a session is the only
      // way in. Validate the stored one, then mint a fresh unlock token from
      // it (tokens live in server RAM and die on restart; the session is what
      // survives). No session, or a dead one, means the login screen.
      if (mode === 'closed') {
        if (s.session) {
          try {
            const who = await api.me();
            if (!alive) return;
            if (who.user) {
              const t = await api.profileTokenFromSession();
              if (!alive) return;
              setToken(t.token);
              await saveProfile(t.profileId, t.token);
              if (!alive) return;
              setLocal({...s, serverUrl: live, profileId: t.profileId, token: t.token});
              setStage('home');
              return;
            }
          } catch {
            if (!alive) return;
          }
          // Dead/revoked session: forget it so nothing keeps sending it.
          setSession(null);
          await saveAuthSession(null);
          if (!alive) return;
        }
        setLocal({...s, serverUrl: live, profileId: null, token: null, session: null});
        setStage('login');
        return;
      }

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
          // A live session can revive the profile with no password typing: it
          // was minted by the very password the gate would ask for.
          if (s.session) {
            try {
              const t = await api.profileTokenFromSession();
              if (!alive) return;
              setToken(t.token);
              await saveProfile(t.profileId, t.token);
              if (!alive) return;
              setLocal({...s, serverUrl: live, profileId: t.profileId, token: t.token});
              setStage('home');
              return;
            } catch {
              if (!alive) return;
            }
          }
          await clearProfile();
          setToken(null);
          setLocal({...s, serverUrl: live, profileId: null, token: null});
          setStage('gate');
          return;
        }
      }

      setLocal({...s, serverUrl: live});
      setStage(s.profileId ? 'home' : 'gate');
    })();
    return () => {
      alive = false;
    };
  }, [boot]);

  // From the gate (open/transition). `sid` rides along when the unlock of a
  // claimed profile signed the device in (MUST #3 — the silent migration).
  const onChosen = async (profileId: string, token: string | null, sid?: string | null) => {
    setToken(token);
    if (sid) {
      setSession(sid);
      await saveAuthSession(sid);
    }
    await saveProfile(profileId, token);
    setLocal(s => ({...s, profileId, token, session: sid || s.session}));
    setStage('home');
  };

  // From the login screen (closed mode, or anyone preferring QR/typed login).
  const onSignedIn = async (profileId: string, token: string, sid: string) => {
    setToken(token);
    setSession(sid);
    await saveAuthSession(sid);
    await saveProfile(profileId, token);
    setLocal(s => ({...s, profileId, token, session: sid}));
    setStage('home');
  };

  // The wall answered 401 {signinRequired:true} mid-session — the mode was
  // flipped to closed, or this session was revoked. Credentials are dead:
  // clear them and show the login screen. Registered once; api.ts debounces.
  useEffect(() => {
    onSigninRequired(() => {
      setToken(null);
      setSession(null);
      saveAuthSession(null).catch(() => {});
      clearProfile().catch(() => {});
      setLocal(s => ({...s, profileId: null, token: null, session: null}));
      setStage('login');
    });
    return () => onSigninRequired(null);
  }, []);

  const switchProfile = async () => {
    await clearProfile();
    // Deliberately NOT setToken(null) here: the navigator is still mounted at
    // this point, and the Player's unmount cleanup saves the current playback
    // position — clearing the api token first made that final save go out
    // without X-Profile-Token, a silent 403 on any protected profile, so
    // switching profiles mid-film lost your place. The effect below clears the
    // token AFTER the stage change has committed (and the unmount saves have
    // been dispatched with the old token).
    // In CLOSED mode there is no picker — switching profile means switching
    // ACCOUNT, so it is a real sign-out: revoke the session server-side
    // (best-effort) and forget it, then show the login screen.
    if (getAuthMode() === 'closed') {
      api.logout().catch(() => {});
      setSession(null);
      await saveAuthSession(null);
      setLocal(s => ({...s, profileId: null, token: null, session: null}));
      setStage('login');
      return;
    }
    setLocal(s => ({...s, profileId: null, token: null}));
    setStage('gate');
  };
  useEffect(() => {
    if (stage === 'gate' || stage === 'login') setToken(null);
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

        {stage === 'login' ? <SignIn onSignedIn={onSignedIn} /> : null}

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
