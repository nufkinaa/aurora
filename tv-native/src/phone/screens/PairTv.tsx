// "Sign in a TV" — the website's #/pair (public/js/screens/pair.js), in the
// same steps and the same words. Where a TV's sign-in QR lands the phone
// (nufurora.com/link?code=… opens the app here, links.ts), and where a TV's
// code is TYPED (Settings → Sign in a TV, Your TVs).
//
//   no code      the field: six letters and numbers, checked with the server
//                before going on, so a mistyped one is answered next to it
//   a code       who is asking (the TV's model), then one tap: "Yes — sign it
//                in as @you". The server hands the TV THIS profile's sign-in
//                (POST /api/auth/device/approve with this phone's session).
//   no session   (open / transition servers: a profile picked on the wall
//                without a sign-in) "Sign in to approve": the profile's
//                username and password, then the same tap.
//
// The pure parts (the code's shape) are linkParse.ts's, tested.
import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useRoute} from '@react-navigation/native';
import {api, ApiError, getBaseUrl, getSession, SigninUser, setSession} from '../../api';
import {useApp} from '../../AppContext';
import {useMe} from '../../navSection';
import {saveAuthSession} from '../../storage';
import {replacePhone, usePNav} from '../nav';
import {BackBar, useColumn, usePageTop} from '../ui/PageHead';
import Glass from '../ui/Glass';
import Field from '../ui/Field';
import Avatar from '../ui/Avatar';
import {GlassButton, PrimaryButton} from '../ui/Buttons';
import {pairCode, PAIR_CODE_LEN, typedPairCode} from '../linkParse';
import {askerName} from '../words';
import {colors, GUTTER, radius} from '../theme';

const TOO_MANY = 'Too many tries from this device — wait a few minutes, then try again.';
const NO_REACH = "Couldn't reach Aurora — try again.";

type Asker = {ip?: string | null; device?: {device?: string | null; os?: string | null} | null; approved?: boolean};
type Phase =
  | {k: 'form'}
  | {k: 'loading'}
  | {k: 'expired'}
  | {k: 'slow'}
  | {k: 'offline'}
  | {k: 'already'}
  | {k: 'confirm'; who: string; user: SigninUser | null}
  | {k: 'signin'; who: string; note?: string}
  | {k: 'done'};

function Card({glyph, title, children}: {glyph: string; title: string; children?: React.ReactNode}) {
  return (
    <Glass style={s.card}>
      <Text style={s.glyph} allowFontScaling={false}>
        {glyph}
      </Text>
      <Text style={s.h1} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </Glass>
  );
}

export default function PairTv() {
  const route = useRoute();
  const nav = usePNav();
  const top = usePageTop();
  const column = useColumn();
  const {profileId} = useApp();
  const me = useMe(profileId);
  const code = pairCode((route.params as {code?: string | null} | undefined)?.code);
  const [phase, setPhase] = useState<Phase>(code ? {k: 'loading'} : {k: 'form'});
  const [typed, setTyped] = useState('');
  const [fieldErr, setFieldErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [approveErr, setApproveErr] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const passRef = useRef<TextInput>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const back = () => (nav.canGoBack() ? nav.goBack() : undefined);

  // a code: who is asking, and is this phone signed in to approve it
  const look = async () => {
    if (!code) return;
    setPhase({k: 'loading'});
    setApproveErr('');
    let info: Asker | null = null;
    try {
      info = (await api.devicePairDescribe(code)) as Asker;
    } catch (e) {
      if (!live.current) return;
      const st = e instanceof ApiError ? e.status : 0;
      return setPhase(st === 429 ? {k: 'slow'} : st === 404 || st === 410 ? {k: 'expired'} : {k: 'offline'});
    }
    if (!live.current) return;
    if (info?.approved) return setPhase({k: 'already'});
    const who = askerName(info);
    let user: SigninUser | null = null;
    if (getSession()) {
      try {
        user = (await api.me()).user || null;
      } catch {}
    }
    // The server hands the TV the SESSION's profile. On an open / transition server this
    // phone can hold one profile's sign-in while it is in another (picked on the wall): then
    // it is not this profile's to give — sign in as this profile first (measured: the page
    // read "Unclaimed QA" over "sign it in as @phoneqa").
    if (user && user.profileId !== profileId) user = null;
    if (!live.current) return;
    setPhase(user ? {k: 'confirm', who, user} : {k: 'signin', who});
  };
  useEffect(() => {
    look();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // the field: check the code with the server, then the very flow the QR opens
  const goTyped = async () => {
    if (busy) return;
    setFieldErr('');
    const c = pairCode(typed);
    if (!c) return setFieldErr(`The code is ${PAIR_CODE_LEN} letters and numbers — it is on the TV's sign-in screen.`);
    setBusy(true);
    try {
      await api.devicePairDescribe(c);
      if (live.current) replacePhone('PairTv', {code: c});
    } catch (e) {
      const st = e instanceof ApiError ? e.status : 0;
      if (live.current)
        setFieldErr(
          st === 429
            ? TOO_MANY
            : st === 404 || st === 410
            ? 'No TV is showing that code right now. Check it against the screen — codes live five minutes, so the TV may have a fresh one.'
            : NO_REACH,
        );
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const approve = async () => {
    if (!code || busy) return;
    setBusy(true);
    setApproveErr('');
    try {
      await api.devicePairApprove(code);
      if (live.current) setPhase({k: 'done'});
    } catch (e) {
      if (!live.current) return;
      if (e instanceof ApiError && e.status === 401) setPhase({k: 'signin', who: phase.k === 'confirm' ? phase.who : 'A device'});
      else if (e instanceof ApiError && e.status === 410) setApproveErr(/already/i.test(e.message || '') ? 'Already approved — the TV should be signing in right now.' : 'That code expired — ask the TV for a fresh one.');
      else setApproveErr((e instanceof ApiError && e.message) || "That didn't work — scan again");
    } finally {
      if (live.current) setBusy(false);
    }
  };

  // open / transition servers: this phone is in the profile without a sign-in
  const signIn = async () => {
    if (busy || !username.trim() || !password || phase.k !== 'signin') return;
    setBusy(true);
    try {
      const r = await api.login(username.trim(), password);
      if (!r.session || r.profile?.id !== profileId) {
        // another profile's sign-in: never give the TV someone this phone is not in
        if (r.session) {
          const had = getSession();
          setSession(r.session);
          await api.logout().catch(() => {});
          setSession(had);
        }
        if (live.current) setPhase({...phase, note: `That is another profile's sign-in. Switch to that profile first, or sign in as ${me?.name || 'this profile'}.`});
        return;
      }
      setSession(r.session);
      await saveAuthSession(r.session);
      setPassword('');
      if (!live.current) return;
      setPhase({k: 'confirm', who: phase.who, user: r.user || null});
    } catch (e) {
      if (live.current) setPhase({...phase, note: (e instanceof ApiError && e.message) || 'Could not sign in'});
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const host = getBaseUrl().replace(/^https?:\/\//, '');
  let body: React.ReactNode = null;
  switch (phase.k) {
    case 'loading':
      body = <ActivityIndicator color={colors.text} size="large" style={{marginTop: 40}} />;
      break;
    case 'form':
      body = (
        <Card glyph="📺" title="Sign in a TV">
          <Text style={s.sub}>Type the code shown on the TV's sign-in screen.</Text>
          <Field
            value={typed}
            onChangeText={t => {
              setTyped(typedPairCode(t));
              setFieldErr('');
            }}
            placeholder="CODE"
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            maxLength={PAIR_CODE_LEN}
            returnKeyType="go"
            onSubmitEditing={goTyped}
            autoFocus
            accessibilityLabel="The code on the TV"
            style={s.codeField}
          />
          {fieldErr ? (
            <Text style={s.error} accessibilityRole="alert">
              {fieldErr}
            </Text>
          ) : null}
          <PrimaryButton uiId="phone.pair.continue" label="Continue" onPress={goTyped} busy={busy} disabled={!typed} style={s.btn} />
          <GlassButton uiId="phone.pair.cancel" label="Cancel" onPress={back} style={s.btn} />
          <Text style={s.small}>{`Or scan the QR on the TV with this phone's camera — Aurora opens by itself. No Aurora on the TV yet? ${host}/install#tv has the TV app.`}</Text>
        </Card>
      );
      break;
    case 'slow':
      body = (
        <Card glyph="✋" title="Slow down">
          <Text style={s.sub}>{TOO_MANY}</Text>
          <PrimaryButton uiId="phone.pair.done" label="Back to Aurora" onPress={back} style={s.btn} />
        </Card>
      );
      break;
    case 'offline':
      body = (
        <Card glyph="📡" title="Couldn't reach Aurora">
          <Text style={s.sub}>Check this phone's connection, then try again.</Text>
          <PrimaryButton uiId="phone.pair.retry" label="Try again" icon="refresh" onPress={look} style={s.btn} />
          <GlassButton uiId="phone.pair.done" label="Back to Aurora" onPress={back} style={s.btn} />
        </Card>
      );
      break;
    case 'expired':
      body = (
        <Card glyph="⌛" title="That code expired">
          <Text style={s.sub}>Pairing codes live five minutes. Ask the TV for a fresh one and scan again — or type the new code.</Text>
          <PrimaryButton uiId="phone.pair.type" label="Type a code" onPress={() => replacePhone('PairTv', {code: null})} style={s.btn} />
          <GlassButton uiId="phone.pair.done" label="Back to Aurora" onPress={back} style={s.btn} />
        </Card>
      );
      break;
    case 'already':
      body = (
        <Card glyph="✅" title="Already approved">
          <Text style={s.sub}>The TV should be signing in right now.</Text>
          <PrimaryButton uiId="phone.pair.done" label="Done" onPress={back} style={s.btn} />
        </Card>
      );
      break;
    case 'done':
      body = (
        <Card glyph="🎉" title="Done">
          <Text style={s.sub}>Look at the TV — it's signing in as you right now.</Text>
          <PrimaryButton uiId="phone.pair.done" label="Back to Aurora" onPress={back} style={s.btn} />
        </Card>
      );
      break;
    case 'confirm': {
      const handle = phase.user?.username ? `@${phase.user.username}` : phase.user?.name || me?.name || 'you';
      body = (
        <Card glyph="📺" title="Sign this TV in?">
          <Text style={s.sub}>
            <Text style={s.strong}>{phase.who}</Text>
            {' is asking to use your Aurora sign-in. Only approve this if the code on its screen is '}
            <Text style={s.strong}>{code}</Text>.
          </Text>
          <View style={s.as}>
            <Avatar p={me} size={44} />
            <View style={{flex: 1}}>
              <Text style={s.asName} numberOfLines={1}>
                {me?.name || ''}
              </Text>
              <Text style={s.asSub} numberOfLines={1}>
                {`The TV signs in as ${handle}`}
              </Text>
            </View>
          </View>
          {approveErr ? (
            <Text style={s.error} accessibilityRole="alert">
              {approveErr}
            </Text>
          ) : null}
          <PrimaryButton uiId="phone.pair.approve" label={`Yes — sign it in as ${handle}`} onPress={approve} busy={busy} style={s.btn} />
          <GlassButton uiId="phone.pair.ignore" label="No, ignore it" onPress={back} style={s.btn} />
        </Card>
      );
      break;
    }
    case 'signin':
      body = (
        <Card glyph="📺" title="Sign in to approve">
          <Text style={s.sub}>{`${phase.who} wants to sign in to Aurora as you. Prove it's you first — then one tap finishes the TV.`}</Text>
          <Text style={s.small}>{`Your username (or email) and password for ${me?.name || 'this profile'}. A profile without sign-in set up can't sign a TV in — on the TV, pick it on Who's watching? instead.`}</Text>
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
            onSubmitEditing={signIn}
            style={s.field}
          />
          {phase.note ? (
            <Text style={s.error} accessibilityRole="alert">
              {phase.note}
            </Text>
          ) : null}
          <PrimaryButton uiId="phone.pair.signin" label="Sign in" onPress={signIn} busy={busy} disabled={!username.trim() || !password} style={s.btn} />
          <GlassButton uiId="phone.pair.ignore" label="No, ignore it" onPress={back} style={s.btn} />
        </Card>
      );
      break;
  }

  return (
    <View style={s.root}>
      <KeyboardAvoidingView behavior="height" style={s.root}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[{paddingTop: top, paddingBottom: 40, paddingHorizontal: GUTTER}, column]}>
          {body}
        </ScrollView>
      </KeyboardAvoidingView>
      <BackBar />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  card: {padding: 22, alignItems: 'stretch', maxWidth: 520, width: '100%', alignSelf: 'center'},
  glyph: {fontSize: 40, textAlign: 'center', marginBottom: 6},
  h1: {color: colors.text, fontSize: 24, fontWeight: '900', textAlign: 'center'},
  sub: {color: colors.textDim, fontSize: 16, lineHeight: 23, textAlign: 'center', marginTop: 8},
  strong: {color: colors.text, fontWeight: '800'},
  small: {color: colors.textFaint, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 16},
  codeField: {marginTop: 18, textAlign: 'center', fontSize: 26, fontWeight: '800', letterSpacing: 6},
  field: {marginTop: 12},
  error: {color: '#ffb3b3', fontSize: 15, lineHeight: 21, marginTop: 12, textAlign: 'center'},
  btn: {marginTop: 12, alignSelf: 'stretch'},
  as: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18, padding: 12, borderRadius: radius.l, backgroundColor: 'rgba(255,255,255,0.06)'},
  asName: {color: colors.text, fontSize: 17, fontWeight: '800'},
  asSub: {color: colors.textDim, fontSize: 14, marginTop: 2},
});
