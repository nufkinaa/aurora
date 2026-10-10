// Aurora TV — boot.
//   loading → find the server, restore the session
//   offline → neither address answered; retry, and nothing else to do
//   gate    → have a server, need a profile
//   home    → have both
//   reset   → signed in, and the admin asked for a new password first
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
import {clearHomeScreen} from './src/homeScreen';
import React, {useEffect, useRef, useState} from 'react';
import {View, StatusBar, ActivityIndicator, StyleSheet} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {TvCanvas} from './src/canvas';
import './src/errors'; // the global error ring, installed once
import ProfileGate from './src/screens/ProfileGate';
import SessionWiring from './src/SessionWiring';
import SignIn from './src/screens/SignIn';
import {ErrorState} from './src/components/States';
import NewPassword from './src/screens/NewPassword';
import {clearProfileCaches} from './src/profileScope';
import {disconnect, onMessage} from './src/realtime';
import {showToast} from './src/toast';
import AppNavigator from './src/navigation';
import {AppContext} from './src/AppContext';
import {
  api,
  ApiError,
  getAuthMode,
  onSigninRequired,
  resolveServer,
  setActiveProfile,
  setBaseUrl,
  setSession,
  setToken,
} from './src/api';
import {
  loadSession,
  saveAuthSession,
  saveServerUrl,
  saveProfile,
  saveKidsLock,
  clearProfile,
  Session,
} from './src/storage';
import theme from './src/theme';

type Stage = 'loading' | 'offline' | 'gate' | 'login' | 'home' | 'reset' | 'banned';
// What a sign-in says beside the profile and its token: the admin wants a new
// password picked (`typed` is the password just entered, when one was).
export type SignInExtra = {mustReset?: boolean; typed?: string | null};

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
  // Why the viewer is looking at the wall / the sign-in screen again (a kick,
  // a sign-out from another device) — shown there, cleared once they are in.
  const [notice, setNotice] = useState('');
  // The ban's reason, in the admin's words.
  const [banReason, setBanReason] = useState('');
  // The forced reset: whose, and the password that was just typed (null when
  // the TV never saw one — QR pairing, Google).
  const [reset, setReset] = useState<{profileId: string; typed: string | null} | null>(null);
  const wasBanned = useRef(false);
  const profileRef = useRef<string | null>(null);
  profileRef.current = stage === 'home' ? session.profileId : null;

  // Boot: restore whatever we remembered and jump to the furthest valid stage.
  // The saved server URL decides nothing: the known addresses are tried in
  // their own order and the one that answers is saved (resolveServer). Only
  // when none answers does the offline state appear.
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
        // A banned address is refused by the server's HTTP side as well, so
        // "Try again" on the ban screen finds no server: that is still the
        // ban, not an outage.
        setStage(wasBanned.current ? 'banned' : 'offline');
        return;
      }
      wasBanned.current = false;
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
              setActiveProfile(t.profileId);
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
              setActiveProfile(t.profileId);
              await saveProfile(t.profileId, t.token);
              if (!alive) return;
              setLocal({...s, serverUrl: live, profileId: t.profileId, token: t.token});
              setStage('home');
              return;
            } catch (e) {
              if (!alive) return;
              // The server REFUSED the session (revoked by a kick or by "sign
              // out everywhere else", or run out): it is dead — stop sending
              // it. A request that merely did not get through proves nothing.
              if (e instanceof ApiError && e.status === 401) {
                setSession(null);
                await saveAuthSession(null);
                if (!alive) return;
                s.session = null;
              }
            }
          }
          await clearProfile();
          setToken(null);
          setLocal({...s, serverUrl: live, profileId: null, token: null});
          setStage('gate');
          return;
        }
      }

      // Said BEFORE the screens mount (their first requests go out from their
      // own effects, which run ahead of any effect here): every request from
      // now on names the profile — see setActiveProfile in api.ts. This is the
      // path a kids profile takes after a server restart: its unlock token is
      // dead, the profile needs none to open, and the name alone keeps the
      // server filtering.
      setActiveProfile(s.profileId);
      if (s.profileId) console.log('[kids] boot: back in profile', s.profileId, '(X-Profile set)');
      // A TV that was already inside a kids profile when this build arrived
      // (or when the admin switched kids mode on) has no lock written yet:
      // write it now, so "Switch profile" asks for the PIN. Never awaited.
      if (s.profileId) {
        const pid = s.profileId;
        api
          .profiles()
          .then(list => {
            const me = list.find(p => p.id === pid);
            if (me && me.kids) {
              console.log('[kids] boot: profile', pid, 'is a kids profile - TV locked to it');
              saveKidsLock({id: pid, maxAge: me.kids.maxAge});
            }
          })
          .catch(() => {});
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
  const enter = (extra: SignInExtra | undefined, profileId: string) => {
    setNotice('');
    // The admin asked for a new password at the next sign-in: that screen
    // first (screens/NewPassword.tsx). The sign-in itself is complete.
    if (extra?.mustReset) {
      setReset({profileId, typed: typeof extra.typed === 'string' ? extra.typed : null});
      setStage('reset');
    } else {
      setStage('home');
    }
  };
  const onChosen = async (profileId: string, token: string | null, sid?: string | null, extra?: SignInExtra) => {
    clearProfileCaches(); // nothing of whoever was here before
    setToken(token);
    setActiveProfile(profileId);
    if (sid) {
      setSession(sid);
      await saveAuthSession(sid);
    }
    await saveProfile(profileId, token);
    setLocal(s => ({...s, profileId, token, session: sid || s.session}));
    enter(extra, profileId);
  };

  // From the login screen (closed mode, or anyone preferring QR/typed login).
  const onSignedIn = async (profileId: string, token: string, sid: string, extra?: SignInExtra) => {
    clearProfileCaches();
    setToken(token);
    setActiveProfile(profileId);
    setSession(sid);
    await saveAuthSession(sid);
    await saveProfile(profileId, token);
    setLocal(s => ({...s, profileId, token, session: sid}));
    enter(extra, profileId);
  };

  // The new password is saved (or put off): on to the app. Saving it ended
  // every unlock token of the profile, so the screen hands up a fresh one.
  const onResetDone = async (token: string | null, sid: string | null) => {
    const profileId = reset?.profileId;
    setReset(null);
    if (profileId && token) {
      setToken(token);
      await saveProfile(profileId, token);
    }
    if (sid) {
      setSession(sid);
      await saveAuthSession(sid);
    }
    setLocal(s => ({...s, token: token || s.token, session: sid || s.session}));
    setStage('home');
  };

  // THE SIGN-IN WAS TAKEN AWAY (or may have been): say why and start over
  // from boot. Boot validates what this TV still holds — a dead session is
  // forgotten, a dead token means the wall — and lands where the TV belongs.
  // Nothing loops: the socket is not reconnected by itself after a kick
  // (realtime.ts `halted`); only the boot that follows opens a new one.
  const leaveFor = (why: string) => {
    setNotice(why);
    showToast(why, '🚫', 8000); // seen if boot lands straight back in the app
    clearProfileCaches();
    setBoot(n => n + 1);
  };
  const leaveRef = useRef(leaveFor);
  leaveRef.current = leaveFor;
  useEffect(() => {
    let checking = false;
    const offs = [
      // An admin signed this person out (People → Sign out, a forced reset)
      // or dropped this one socket. The server's reason is written for the
      // viewer; a bare kick has none.
      onMessage('kicked', d => leaveRef.current(String(d.reason || '') || 'Signed out by the admin')),
      // Banned: this address is refused from now on. Stop; nothing to retry
      // into (every request would be refused the same way).
      onMessage('banned', d => {
        disconnect();
        clearProfileCaches();
        wasBanned.current = true;
        setBanReason(String(d.reason || ''));
        setStage('banned');
      }),
      // "Sign out everywhere else", pressed on another device of this
      // profile. It ended every other session and unlock token — but this TV
      // may still be fine (a profile with no password). So ask the server,
      // once, with what the TV holds, and leave only when refused.
      onMessage('profile_signed_out', async d => {
        const pid = profileRef.current;
        if (!pid || String(d.profileId || '') !== pid || checking) return;
        checking = true;
        try {
          await api.state(pid);
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) leaveRef.current('This profile was signed out from another device');
        } finally {
          checking = false;
        }
      }),
    ];
    return () => offs.forEach(off => off());
  }, []);

  // The wall answered 401 {signinRequired:true} mid-session — the mode was
  // flipped to closed, or this session was revoked. Credentials are dead:
  // clear them and show the login screen. Registered once; api.ts debounces.
  useEffect(() => {
    onSigninRequired(() => {
      clearProfileCaches();
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
    // this profile's rows leave the TV's home screen with it — and everything
    // else held in memory for it (the request cache, warmed lists, the AI
    // page's answer, its settings…): the next profile must be handed nothing
    // of this one's. Again once the screens have unmounted (the effect below).
    clearHomeScreen();
    clearProfileCaches();
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
    if (stage === 'gate' || stage === 'login') {
      // (the screens are gone now: whatever they read on the way out goes too)
      clearProfileCaches();
      setToken(null);
      // (same timing as the token, for the same reason: the Player's unmount
      // save has gone out by now)
      setActiveProfile(null);
    }
  }, [stage]);

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar hidden />
        <TvCanvas>
        {stage === 'loading' ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.colors.text} size="large" />
          </View>
        ) : null}

        {stage === 'offline' ? (
          <ErrorState
            message="Can't reach Aurora."
            detail="Tried nufurora.com and the house server. Check the server is running, then try again."
            edgeLeft={false}
            onAction={() => setBoot(n => n + 1)}
          />
        ) : null}

        {stage === 'gate' ? (
          <ProfileGate onChosen={onChosen} notice={notice} />
        ) : null}

        {stage === 'login' ? <SignIn onSignedIn={onSignedIn} notice={notice} /> : null}

        {stage === 'reset' && reset ? (
          <NewPassword
            profileId={reset.profileId}
            current={reset.typed}
            onDone={onResetDone}
            onLater={() => onResetDone(null, null)}
          />
        ) : null}

        {stage === 'banned' ? (
          <ErrorState
            message="Access denied"
            detail={banReason || 'This TV has been banned from this server.'}
            actionLabel="Try again"
            edgeLeft={false}
            onAction={() => setBoot(n => n + 1)}
          />
        ) : null}

        {stage === 'home' && session.profileId ? (
          <AppContext.Provider
            value={{profileId: session.profileId, switchProfile}}>
            <SessionWiring />
            <AppNavigator />
          </AppContext.Provider>
        ) : null}
        </TvCanvas>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: theme.colors.bg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
});
