// Sign in on the phone (closed mode, or anyone who prefers it): username and
// password, as the website's sign-in page — and, for a phone with nothing
// typed yet, "Use a code": the code this phone shows is approved on any device
// already signed in (the TV's pairing, the same /api/auth/device routes).
// What a sign-in means for the kids lock is the TV's rule (SignIn.tsx finish).
import React, {forwardRef, useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Image, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, TextInputProps, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {api, ApiError, getBaseUrl, SigninResult} from '../../api';
import {clearKidsLock, loadKidsLock, saveKidsLock} from '../../storage';
import Tap from '../ui/Tap';
import Icon from '../ui/Icon';
import Sky from '../ui/Sky';
import {colors, G_EDGE, G_FILL} from '../theme';

// the site's gradient wordmark (.login-logo), as a picture: a gradient cannot fill text here
const WORDMARK = require('../assets/wordmark.png');
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
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[s.body, {paddingTop: insets.top + 46, paddingBottom: insets.bottom + 40}]}>
          {/* .login-brand: the wordmark and its line */}
          <View style={s.brand}>
            <Image source={WORDMARK} style={s.wordmark} resizeMode="contain" accessibilityLabel="aurora" />
            <Text style={s.tag}>YOUR LIVING-ROOM CINEMA</Text>
          </View>
          {/* .login-card: glass, 30 round, 28 inside */}
          <View style={s.card}>
            <Text style={s.lhead} accessibilityRole="header">
              {mode === 'typed' ? 'Welcome back' : 'Sign in with a code'}
            </Text>
            <Text style={s.lsub}>{mode === 'typed' ? 'Sign in to pick up where you left off.' : 'No password on this phone? A device that is signed in can let it in.'}</Text>
            {notice ? <Text style={s.notice}>{notice}</Text> : null}
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
                {error ? <Text style={s.error}>{error}</Text> : null}
                <Tap
                  uiId="signin.submit"
                  accessibilityRole="button"
                  accessibilityLabel="Sign in"
                  onPress={submit}
                  disabled={busy || !username.trim() || !password}
                  rippleColor="rgba(0,0,0,0.12)"
                  style={s.lbtn}>
                  {busy ? <ActivityIndicator color="#061310" size="small" /> : <Text style={s.lbtnText}>Sign in</Text>}
                </Tap>
                <View style={s.lfoot}>
                  <Text style={s.lfootText}>No password here? </Text>
                  <Tap uiId="signin.mode.qr" flat onPress={() => setMode('code')} accessibilityRole="button" style={s.linkTap}>
                    <Text style={s.llink}>Use a code instead</Text>
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
                {pairErr ? <Text style={s.error}>{pairErr}</Text> : null}
                <View style={s.lfoot}>
                  <Tap uiId="signin.mode.typed" flat onPress={() => setMode('typed')} accessibilityRole="button" style={s.linkTap}>
                    <Text style={s.llink}>Type a password instead</Text>
                  </Tap>
                </View>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/** The site's .lfield: a 50 dp field, 13 round, its icon on the left, lit while typing; the
 *  password one has the eye that shows what was typed. */
const LoginField = forwardRef<TextInput, TextInputProps & {icon: 'lineUser' | 'lineLock'; secret?: boolean}>(function LoginField({icon, secret, onFocus, onBlur, ...rest}, ref) {
  const [on, setOn] = useState(false);
  const [shown, setShown] = useState(false);
  return (
    <View style={[s.lfield, on && s.lfieldOn]}>
      <Icon name={icon} size={18} color={on ? colors.text : colors.textFaint} />
      <TextInput
        ref={ref}
        placeholderTextColor="rgba(154,163,186,0.75)"
        selectionColor={colors.accent}
        cursorColor={colors.accent}
        secureTextEntry={!!secret && !shown}
        {...rest}
        onFocus={e => {
          setOn(true);
          onFocus?.(e);
        }}
        onBlur={e => {
          setOn(false);
          onBlur?.(e);
        }}
        style={s.input}
      />
      {secret ? (
        <Tap borderless hitSlop={10} onPress={() => setShown(v => !v)} accessibilityRole="button" accessibilityLabel={shown ? 'Hide the password' : 'Show the password'} style={s.eye}>
          <Icon name={shown ? 'eyeOff' : 'eye'} size={18} color={colors.textFaint} />
        </Tap>
      ) : null}
    </View>
  );
});

const s = StyleSheet.create({
  root: {flex: 1},
  // .login-gate: 20 from the sides, the brand 26 over the card, the whole in the middle
  body: {flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20, maxWidth: 480, width: '100%', alignSelf: 'center'},
  brand: {alignItems: 'center', marginBottom: 26},
  wordmark: {width: 194, height: 48},
  tag: {color: 'rgb(139,147,171)', fontSize: 11.52, letterSpacing: 1.84, lineHeight: 17.3, marginTop: 4},
  card: {
    borderRadius: 30,
    padding: 28,
    backgroundColor: 'rgba(40,52,110,0.18)',
    experimental_backgroundImage: G_FILL,
    ...G_EDGE,
  },
  lhead: {color: 'rgb(238,241,250)', fontSize: 23.2, fontWeight: '800', letterSpacing: -0.35, lineHeight: 34.8},
  lsub: {color: 'rgb(154,163,186)', fontSize: 14.4, lineHeight: 21.6, marginTop: 6, marginBottom: 18},
  notice: {color: '#ffd28a', fontSize: 14.4, marginBottom: 12},
  lfield: {height: 50, borderRadius: 13, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 15, marginBottom: 10, backgroundColor: 'rgba(255,255,255,0.055)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)'},
  lfieldOn: {backgroundColor: 'rgba(255,255,255,0.08)', borderColor: 'rgba(122,162,255,0.55)', boxShadow: '0 0 0 3px rgba(110,150,255,0.16)'},
  input: {flex: 1, minWidth: 0, height: 48, padding: 0, color: colors.text, fontSize: 15.5},
  eye: {width: 26, height: 26, alignItems: 'center', justifyContent: 'center'},
  error: {color: '#ffb3b3', fontSize: 14.4, marginTop: 2, marginBottom: 8},
  // .lbtn.primary: 50 tall, 13 round, the mint-to-violet sweep, dark words
  lbtn: {
    height: 50,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    experimental_backgroundImage: 'linear-gradient(115deg, rgb(63,216,164) 0%, rgb(127,140,255) 90%)',
    boxShadow: '0 6px 24px rgba(70,200,160,0.25)',
  },
  lbtnText: {color: 'rgb(6,19,16)', fontSize: 15.52, fontWeight: '700'},
  lfoot: {flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: 12, flexWrap: 'wrap'},
  lfootText: {color: 'rgb(139,147,171)', fontSize: 14.4},
  linkTap: {minHeight: 40, justifyContent: 'center'},
  llink: {color: 'rgb(143,184,255)', fontSize: 14.4, textDecorationLine: 'underline'},
  codeBox: {padding: 18, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.055)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)', alignItems: 'center'},
  codeLabel: {color: colors.textDim, fontSize: 12, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase'},
  code: {color: colors.text, fontSize: 38, fontWeight: '900', letterSpacing: 6, marginVertical: 10},
  codeHelp: {color: 'rgb(154,163,186)', fontSize: 14.4, lineHeight: 21, textAlign: 'center'},
});
