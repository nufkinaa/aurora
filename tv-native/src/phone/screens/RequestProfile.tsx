// "Request access" on the phone — the website's request-access card
// (public/js/screens/login.js signupView + sentView), in its words: a name, a
// username and/or an email to sign in with, a password typed twice, a note for
// the admin. It files POST /api/auth/signup; nothing exists until the admin
// approves it, and the card then says so ("Request sent"). Two doors open it,
// as on the site: the sign-in card's "Request access" (its way out is "Back to
// sign in") and the profile wall's "Add profile" tile (standalone: "Cancel").
// The sign-in card's look — the sky, the wordmark, the glass card, the
// .lfield rows — lives here too (LoginShell, LoginField), shared with SignIn.
import React, {forwardRef, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, BackHandler, Image, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, TextInputProps, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Svg, {Path, Rect} from 'react-native-svg';
import {api, ApiError, apiPost} from '../../api';
import {adminOr, MAX, REQUEST, RequestForm, requestBody, requestProblem} from '../profiles';
import Tap from '../ui/Tap';
import Icon from '../ui/Icon';
import Sky from '../ui/Sky';
import {colors, G_EDGE, G_FILL} from '../theme';

// the site's gradient wordmark (.login-logo), as a picture: a gradient cannot fill text here
const WORDMARK = require('../assets/wordmark.png');

/** The sign-in gate (.login-gate): the sky, the wordmark and its line, one glass card. */
export function LoginShell({children}: {children: React.ReactNode}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={ls.root}>
      <Sky dim />
      <KeyboardAvoidingView behavior="height" style={ls.root}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[ls.body, {paddingTop: insets.top + 46, paddingBottom: insets.bottom + 40}]}>
          {/* .login-brand: the wordmark and its line */}
          <View style={ls.brand}>
            <Image source={WORDMARK} style={ls.wordmark} resizeMode="contain" accessibilityLabel="aurora" />
            <Text style={ls.tag}>YOUR LIVING-ROOM CINEMA</Text>
          </View>
          {/* .login-card: glass, 30 round, 28 inside */}
          <View style={ls.card}>{children}</View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

// login.js's own two line icons the phone set has not got (mail, note)
const LINE_EXTRA = {
  mail: (c: string) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Rect x={2} y={4} width={20} height={16} rx={2} />
      <Path d="m22 7-10 6L2 7" />
    </Svg>
  ),
  note: (c: string) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 20h9" />
      <Path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  ),
};
type LoginIcon = 'lineUser' | 'lineLock' | keyof typeof LINE_EXTRA;

/** The site's .lfield: a 50 dp field, 13 round, its icon on the left, lit while typing; the
 *  password one has the eye that shows what was typed. */
export const LoginField = forwardRef<TextInput, TextInputProps & {icon: LoginIcon; secret?: boolean}>(function LoginField({icon, secret, onFocus, onBlur, ...rest}, ref) {
  const [on, setOn] = useState(false);
  const [shown, setShown] = useState(false);
  const tint = on ? colors.text : colors.textFaint;
  return (
    <View style={[ls.lfield, on && ls.lfieldOn]}>
      {icon === 'mail' || icon === 'note' ? LINE_EXTRA[icon](tint) : <Icon name={icon} size={18} color={tint} />}
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
        style={ls.input}
      />
      {secret ? (
        <Tap borderless hitSlop={10} onPress={() => setShown(v => !v)} accessibilityRole="button" accessibilityLabel={shown ? 'Hide the password' : 'Show the password'} style={ls.eye}>
          <Icon name={shown ? 'eyeOff' : 'eye'} size={18} color={colors.textFaint} />
        </Tap>
      ) : null}
    </View>
  );
});

/** The primary .lbtn: 50 tall, the mint-to-violet sweep, dark words. */
export function LoginButton({label, onPress, busy, disabled, uiId}: {label: string; onPress: () => void; busy?: boolean; disabled?: boolean; uiId?: string}) {
  return (
    <Tap uiId={uiId} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled || busy} rippleColor="rgba(0,0,0,0.12)" style={ls.lbtn}>
      {busy ? <ActivityIndicator color="#061310" size="small" /> : <Text style={ls.lbtnText}>{label}</Text>}
    </Tap>
  );
}

const EMPTY: RequestForm = {name: '', username: '', email: '', password: '', again: '', note: ''};

/** The request-access card's insides. `standalone`: opened from the wall's "Add profile"
 *  (its way out is "Cancel" / "Done"); otherwise from the sign-in card ("Back to sign in"). */
export default function RequestAccess({standalone, onLeave}: {standalone?: boolean; onLeave: () => void}) {
  const [f, setF] = useState<RequestForm>(EMPTY);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [admin, setAdmin] = useState(adminOr(null));
  const refs = {
    username: useRef<TextInput>(null),
    email: useRef<TextInput>(null),
    password: useRef<TextInput>(null),
    again: useRef<TextInput>(null),
    note: useRef<TextInput>(null),
  };
  useEffect(() => {
    let live = true;
    api
      .serverInfo()
      .then(i => live && setAdmin(adminOr(i.adminName)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  // Android's Back is the card's own way out
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onLeave();
      return true;
    });
    return () => sub.remove();
  }, [onLeave]);
  const set = (k: keyof RequestForm) => (t: string) => setF(cur => ({...cur, [k]: t}));

  const send = async () => {
    if (busy) return;
    setError('');
    const problem = requestProblem(f);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await apiPost<{ok?: boolean}>('/api/auth/signup', requestBody(f));
      setSent(f.name.trim());
    } catch (e) {
      setError(e instanceof ApiError && e.message && !/^\d{3} \//.test(e.message) ? e.message : REQUEST.failed);
    } finally {
      setBusy(false);
    }
  };

  if (sent !== null) {
    return (
      <View style={ls.sent}>
        <Text style={ls.sentGlyph}>🍿</Text>
        <Text style={[ls.lhead, ls.center]} accessibilityRole="header">
          {REQUEST.sentHeading}
        </Text>
        <Text style={[ls.lsub, ls.center]}>
          {REQUEST.sentLead(sent, admin)}
          <Text style={ls.strong}>{REQUEST.sentStrong}</Text>
          {REQUEST.sentTail}
        </Text>
        <View style={ls.sentBtn}>
          <LoginButton uiId="phone.request.done" label={standalone ? REQUEST.done : REQUEST.backToSignIn} onPress={onLeave} />
        </View>
      </View>
    );
  }

  return (
    <>
      <Text style={ls.lhead} accessibilityRole="header">
        {REQUEST.heading}
      </Text>
      <Text style={ls.lsub}>
        {REQUEST.sub(admin)}
        <Text style={ls.dim}>{REQUEST.subDim}</Text>
      </Text>
      <LoginField icon="note" value={f.name} onChangeText={set('name')} placeholder={REQUEST.name} maxLength={MAX.name} autoComplete="name" textContentType="name" returnKeyType="next" onSubmitEditing={() => refs.username.current?.focus()} autoFocus />
      <LoginField ref={refs.username} icon="lineUser" value={f.username} onChangeText={set('username')} placeholder={REQUEST.username} maxLength={MAX.username} autoCapitalize="none" autoCorrect={false} autoComplete="off" returnKeyType="next" onSubmitEditing={() => refs.email.current?.focus()} />
      <LoginField ref={refs.email} icon="mail" value={f.email} onChangeText={set('email')} placeholder={REQUEST.email} maxLength={MAX.email} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="emailAddress" returnKeyType="next" onSubmitEditing={() => refs.password.current?.focus()} />
      <LoginField ref={refs.password} icon="lineLock" secret value={f.password} onChangeText={set('password')} placeholder={REQUEST.password} autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" returnKeyType="next" onSubmitEditing={() => refs.again.current?.focus()} />
      <LoginField ref={refs.again} icon="lineLock" secret value={f.again} onChangeText={set('again')} placeholder={REQUEST.again} autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" returnKeyType="next" onSubmitEditing={() => refs.note.current?.focus()} />
      <LoginField ref={refs.note} icon="note" value={f.note} onChangeText={set('note')} placeholder={REQUEST.note} maxLength={MAX.note} autoComplete="off" returnKeyType="send" onSubmitEditing={send} />
      {error ? (
        <Text style={ls.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      <LoginButton uiId="phone.request.send" label={REQUEST.send} onPress={send} busy={busy} />
      <View style={ls.lfoot}>
        <Tap uiId="phone.request.leave" flat onPress={onLeave} accessibilityRole="button" style={ls.linkTap}>
          <Text style={ls.llink}>{standalone ? REQUEST.cancel : REQUEST.back}</Text>
        </Tap>
      </View>
    </>
  );
}

export const ls = StyleSheet.create({
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
  dim: {color: 'rgb(110,118,140)'},
  strong: {color: 'rgb(238,241,250)', fontWeight: '700'},
  center: {textAlign: 'center'},
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
  // .lsent: the popcorn, the words in the middle, the button under them
  sent: {alignItems: 'stretch'},
  sentGlyph: {fontSize: 46, textAlign: 'center', marginBottom: 6},
  sentBtn: {marginTop: 8},
});
