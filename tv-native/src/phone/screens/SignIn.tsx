// Sign in on the phone (closed mode, or anyone who prefers it): username and
// password, as the website's sign-in page — and, for a phone with nothing
// typed yet, "Use a code": the code this phone shows is approved on any device
// already signed in (the TV's pairing, the same /api/auth/device routes).
// What a sign-in means for the kids lock is the TV's rule (SignIn.tsx finish).
// "First time here? Request access" opens the site's request-access card
// (RequestProfile.tsx), whose way out is "Back to sign in".
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {api, ApiError, getBaseUrl, SigninResult} from '../../api';
import {clearKidsLock, loadKidsLock, saveKidsLock} from '../../storage';
import Tap from '../ui/Tap';
import {colors} from '../theme';
import {REQUEST} from '../profiles';
import RequestAccess, {LoginButton, LoginField, LoginShell, ls} from './RequestProfile';

const POLL_MS = 2000;

type Extra = {mustReset?: boolean; typed?: string | null};

export default function SignIn({onSignedIn, notice}: {onSignedIn: (profileId: string, token: string, sid: string, extra?: Extra) => void; notice: string}) {
  const [mode, setMode] = useState<'typed' | 'code' | 'request'>('typed');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const passRef = useRef<TextInput>(null);
  const done = useRef(false);

  const finish = useCallback(
    (r: Partial<SigninResult>, typed: string | null = null) => {
      if (done.current) return;
      if (!r.profile?.id || !r.profileToken || !r.session) return;
      done.current = true;
      const kids = r.profile.kids;
      if (kids && typeof kids.maxAge === 'number') saveKidsLock({id: r.profile.id, maxAge: kids.maxAge});
      else loadKidsLock().then(l => l && clearKidsLock());
      onSignedIn(r.profile.id, r.profileToken, r.session, r.mustReset ? {mustReset: true, typed} : undefined);
    },
    [onSignedIn],
  );

  const submit = async () => {
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      finish(await api.login(username.trim(), password), password);
    } catch (e) {
      setError(e instanceof ApiError && e.message ? e.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  // ---- a code to approve on another device ----
  const [pair, setPair] = useState<{code: string; linkPath: string} | null>(null);
  const [pairErr, setPairErr] = useState('');
  useEffect(() => {
    if (mode !== 'code') return;
    let live = true;
    let poll: ReturnType<typeof setInterval> | null = null;
    let refresh: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    const start = async () => {
      if (poll) clearInterval(poll);
      if (refresh) clearTimeout(refresh);
      setPair(null);
      setPairErr('');
      try {
        const r = await api.deviceStart();
        if (!live) return;
        setPair({code: r.code, linkPath: r.linkPath});
        refresh = setTimeout(start, Math.max(30, (r.expiresIn || 300) - 10) * 1000);
        poll = setInterval(async () => {
          if (polling || done.current) return;
          polling = true;
          try {
            const p = await api.devicePoll(r.code, r.secret);
            if (live && !p.pending) finish(p);
          } catch (e) {
            if (live && e instanceof ApiError && e.status === 410) start();
          } finally {
            polling = false;
          }
        }, POLL_MS);
      } catch (e) {
        if (live) setPairErr(e instanceof ApiError && e.message ? e.message : 'Could not start pairing');
      }
    };
    start();
    return () => {
      live = false;
      if (poll) clearInterval(poll);
      if (refresh) clearTimeout(refresh);
    };
  }, [mode, finish]);

  const host = getBaseUrl().replace(/^https?:\/\//, '');
  const backToTyped = useCallback(() => setMode('typed'), []);
  if (mode === 'request') {
    return (
      <LoginShell>
        <RequestAccess onLeave={backToTyped} />
      </LoginShell>
    );
  }
  return (
    <LoginShell>
      <Text style={ls.lhead} accessibilityRole="header">
        {mode === 'typed' ? 'Welcome back' : 'Sign in with a code'}
      </Text>
      <Text style={ls.lsub}>{mode === 'typed' ? 'Sign in to pick up where you left off.' : 'No password on this phone? A device that is signed in can let it in.'}</Text>
      {notice ? <Text style={ls.notice}>{notice}</Text> : null}
      {mode === 'typed' ? (
        <>
          <LoginField
            icon="lineUser"
            value={username}
            onChangeText={setUsername}
            placeholder="Username or email"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
            returnKeyType="next"
            onSubmitEditing={() => passRef.current?.focus()}
          />
          <LoginField
            ref={passRef}
            icon="lineLock"
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            secret
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={submit}
          />
          {error ? <Text style={ls.error}>{error}</Text> : null}
          <LoginButton uiId="signin.submit" label="Sign in" onPress={submit} busy={busy} disabled={!username.trim() || !password} />
          {/* .lfoot: "First time here? Request access" (login.js signinView) */}
          <View style={ls.lfoot}>
            <Text style={ls.lfootText}>{REQUEST.firstTime}</Text>
            <Tap uiId="signin.request" flat onPress={() => setMode('request')} accessibilityRole="button" style={ls.linkTap}>
              <Text style={ls.llink}>{REQUEST.link}</Text>
            </Tap>
          </View>
          <View style={[ls.lfoot, s.tight]}>
            <Text style={ls.lfootText}>No password here? </Text>
            <Tap uiId="signin.mode.qr" flat onPress={() => setMode('code')} accessibilityRole="button" style={ls.linkTap}>
              <Text style={ls.llink}>Use a code instead</Text>
            </Tap>
          </View>
        </>
      ) : (
        <>
          <View style={s.codeBox}>
            <Text style={s.codeLabel}>Your code</Text>
            <Text style={s.code} selectable>
              {pair ? pair.code : '· · · · · ·'}
            </Text>
            <Text style={s.codeHelp}>
              {`On a phone, tablet or computer that's signed in, open ${host}${pair?.linkPath || '/#/pair'} and enter this code. This phone signs in by itself.`}
            </Text>
          </View>
          {pairErr ? <Text style={ls.error}>{pairErr}</Text> : null}
          <View style={ls.lfoot}>
            <Tap uiId="signin.mode.typed" flat onPress={() => setMode('typed')} accessibilityRole="button" style={ls.linkTap}>
              <Text style={ls.llink}>Type a password instead</Text>
            </Tap>
          </View>
        </>
      )}
    </LoginShell>
  );
}

// The card's look (LoginShell, LoginField, the .lbtn, the .lfoot links) is
// RequestProfile.tsx's, shared with the request-access card; the code box is this card's own.
const s = StyleSheet.create({
  tight: {marginTop: 0},
  codeBox: {padding: 18, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.055)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)', alignItems: 'center'},
  codeLabel: {color: colors.textDim, fontSize: 12, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase'},
  code: {color: colors.text, fontSize: 38, fontWeight: '900', letterSpacing: 6, marginVertical: 10},
  codeHelp: {color: 'rgb(154,163,186)', fontSize: 14.4, lineHeight: 21, textAlign: 'center'},
});
