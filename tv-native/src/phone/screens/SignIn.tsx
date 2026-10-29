// Sign in on the phone (closed mode, or anyone who prefers it): username and
// password, as the website's sign-in page — and, for a phone with nothing
// typed yet, "Use a code": the code this phone shows is approved on any device
// already signed in (the TV's pairing, the same /api/auth/device routes).
// What a sign-in means for the kids lock is the TV's rule (SignIn.tsx finish).
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Image, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {api, ApiError, getBaseUrl, SigninResult} from '../../api';
import {clearKidsLock, loadKidsLock, saveKidsLock} from '../../storage';
import Field from '../ui/Field';
import {GlassButton, PrimaryButton} from '../ui/Buttons';
import Sky from '../ui/Sky';
import {colors, GUTTER, radius} from '../theme';

const LOGO = require('../../assets/logo-mark.png');
const POLL_MS = 2000;

type Extra = {mustReset?: boolean; typed?: string | null};

export default function SignIn({onSignedIn, notice}: {onSignedIn: (profileId: string, token: string, sid: string, extra?: Extra) => void; notice: string}) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<'typed' | 'code'>('typed');
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
  return (
    <View style={s.root}>
      <Sky dim />
      <KeyboardAvoidingView behavior="height" style={s.root}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[s.body, {paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24}]}>
          <Image source={LOGO} style={s.logo} resizeMode="contain" />
          <Text style={s.heading}>Sign in to Aurora</Text>
          {notice ? <Text style={s.notice}>{notice}</Text> : null}
          {mode === 'typed' ? (
            <>
              <Field
                value={username}
                onChangeText={setUsername}
                placeholder="Username or email"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                textContentType="username"
                returnKeyType="next"
                onSubmitEditing={() => passRef.current?.focus()}
                style={s.field}
              />
              <Field
                ref={passRef}
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                secureTextEntry
                autoCapitalize="none"
                autoComplete="current-password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={submit}
                style={s.field}
              />
              {error ? <Text style={s.error}>{error}</Text> : null}
              <PrimaryButton uiId="signin.submit" label="Sign in" onPress={submit} busy={busy} disabled={!username.trim() || !password} style={s.primary} />
              <GlassButton uiId="signin.mode.qr" label="Use a code instead" icon="phone" onPress={() => setMode('code')} style={s.secondary} />
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
              {pairErr ? <Text style={s.error}>{pairErr}</Text> : null}
              <GlassButton uiId="signin.mode.typed" label="Type a password instead" onPress={() => setMode('typed')} style={s.secondary} />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  body: {flexGrow: 1, paddingHorizontal: GUTTER + 8, maxWidth: 520, width: '100%', alignSelf: 'center'},
  logo: {width: 64, height: 64, alignSelf: 'center', marginBottom: 18},
  heading: {color: colors.text, fontSize: 28, fontWeight: '800', textAlign: 'center', marginBottom: 12},
  notice: {color: '#ffd28a', fontSize: 15, textAlign: 'center', marginBottom: 8},
  field: {marginTop: 12},
  error: {color: '#ffb3b3', fontSize: 15, marginTop: 12, textAlign: 'center'},
  primary: {marginTop: 20},
  secondary: {marginTop: 12},
  codeBox: {marginTop: 16, padding: 20, borderRadius: radius.xl, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge, alignItems: 'center'},
  codeLabel: {color: colors.textDim, fontSize: 13, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase'},
  code: {color: colors.text, fontSize: 40, fontWeight: '900', letterSpacing: 6, marginVertical: 10},
  codeHelp: {color: colors.textDim, fontSize: 15, lineHeight: 21, textAlign: 'center'},
});
