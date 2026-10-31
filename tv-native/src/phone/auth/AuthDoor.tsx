// [auth-round] Every way into Aurora on the phone, on one glass panel (docs/auth-round.md):
//
//   signin    Username or email + Password (Forgot password? by its label), Continue
//             with Google, and "Sign in with a code instead" (a device already signed
//             in approves this phone: the TV's pairing, /api/auth/device).
//   request   Request access (a password is ALWAYS set here, Google or not: elia's
//             ask #2), Sign up with Google; with a verified Google identity it becomes
//             "Finish your request".
//   forgot    Reset your password: Use Google · Ask {admin} (a waiting screen that
//             carries on by itself) · I have a reset code · Email me a link (when the
//             server has it on), then one "Choose a new password" step that signs in.
//   device    Google with a code on this screen (no browser for the Custom Tab, or
//             the server says the tab cannot come back to the address this phone uses).
//
// The closed-mode sign-in stage (screens/SignIn.tsx) is this door with nowhere else to
// go; on an open server the profile wall opens it ("Add profile", "Forgot password?")
// and it has a way back to the wall (onLeave).
//
// Google's answer comes back as a link (aurora-phone://auth/google?code=…): links.ts
// hands it to whichever door is up — also after a cold start, when the app was closed
// while the tab was open (`initialLink`, or held in links.ts until this door listens).
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, AppState, BackHandler, Text, TextInput, View} from 'react-native';
import {api, ApiError, getBaseUrl, ResetOptions, SigninResult} from '../../api';
import {clearKidsLock, loadKidsLock, saveKidsLock} from '../../storage';
import {PASSWORD_HELP} from '../../passRules';
import {linkHosts, onAuthLink} from '../links';
import {parseGoogleAuth, parsePhoneLink} from '../linkParse';
import {dropPending, finishGoogleTab, GoogleProblem, openGoogleTab, pendingIntent} from './google';
import {markPasswordSetup} from './state';
import {
  adminName,
  ASK_POLL_MS,
  askStep,
  Field,
  firstProblem,
  GoogleIntent,
  googleRefusal,
  googleStep,
  googleWay,
  hasProblems,
  newPasswordProblems,
  Problems,
  refusalProblem,
  RequestFields,
  requestBody,
  requestProblems,
  resetWays,
  signInProblems,
  typedResetCode,
  W,
} from './rules';
import {A, as, AuthField, AuthShell, Check, Choice, Foot, FormError, GoogleButton, MainButton, Notice, Or, Segmented, Strength, TextLink, Title} from './ui';

/** The newest value of a callback, for effects that must not restart when it changes. */
function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

export type SignedIn = (profileId: string, token: string, sid: string, extra?: {mustReset?: boolean; typed?: string | null}) => void;
type Start = 'signin' | 'request' | 'forgot';
type GoogleCtx = {email: string; name: string; pollId: string};
type View_ =
  | {v: 'signin'}
  | {v: 'pair'}
  | {v: 'request'; google?: GoogleCtx}
  | {v: 'sent'}
  | {v: 'forgot'}
  | {v: 'ask'}
  | {v: 'askSent'; ticket: string}
  | {v: 'code'}
  | {v: 'email'}
  | {v: 'emailSent'}
  | {v: 'newPw'; token: string; name: string}
  | {v: 'device'; intent: GoogleIntent}
  | {v: 'google'; label: string};

type Info = {googleApp?: boolean; googleDevice?: boolean; adminName?: string | null};

export default function AuthDoor({
  start = 'signin',
  onSignedIn,
  onLeave,
  notice,
  initialLink,
  identifier: identifierIn,
}: {
  start?: Start;
  onSignedIn: SignedIn;
  /** the way back to the profile wall (open server); absent at the closed-mode stage */
  onLeave?: () => void;
  notice?: string;
  initialLink?: string | null;
  identifier?: string;
}) {
  const [view, setView] = useState<View_>({v: start});
  const [info, setInfo] = useState<Info | null>(null);
  const [opts, setOpts] = useState<ResetOptions | null>(null);
  const [googleErr, setGoogleErr] = useState('');
  const [googleBusy, setGoogleBusy] = useState<GoogleIntent | null>(null);
  // what was typed is kept across the views (Forgot password? carries the username along)
  const [ident, setIdent] = useState(identifierIn || '');
  const done = useRef(false);
  // (server-info says "the admin" when it has no name; the reset options may carry the real one)
  const admin = adminName([info?.adminName, opts?.adminName].find(n => n && !/^the admin$/i.test(n.trim())) || null);
  const way = googleWay(info);

  useEffect(() => {
    let live = true;
    api
      .serverInfo()
      .then(i => live && setInfo(i as Info))
      .catch(() => live && setInfo({}));
    return () => {
      live = false;
    };
  }, []);
  const needOpts = view.v === 'forgot' || view.v === 'code' || view.v === 'ask';
  useEffect(() => {
    if (!needOpts || opts) return;
    let live = true;
    api
      .resetOptions()
      .then(o => live && setOpts(o))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [needOpts, opts]);

  // ---- signed in: the kids lock as the TV keeps it, then up to AppRoot ----
  const finish = useCallback(
    (r: Partial<SigninResult>, typed: string | null) => {
      if (done.current) return;
      if (!r.profile?.id || !r.profileToken || !r.session) return;
      done.current = true;
      const kids = r.profile.kids;
      if (kids && typeof kids.maxAge === 'number') saveKidsLock({id: r.profile.id, maxAge: kids.maxAge});
      else loadKidsLock().then(l => l && clearKidsLock());
      markPasswordSetup(r.passwordSetup ? r.profile.id : null);
      onSignedIn(r.profile.id, r.profileToken, r.session, r.mustReset ? {mustReset: true, typed} : undefined);
    },
    [onSignedIn],
  );

  // ---- Google: where its answer goes ----
  const whereFor = (intent: GoogleIntent | null): View_ => (intent === 'reset' ? {v: 'forgot'} : intent === 'signup' ? {v: 'request'} : {v: 'signin'});
  const onGoogleOutcome = useCallback(
    (intent: GoogleIntent, o: Parameters<typeof googleStep>[0]) => {
      const step = googleStep(o);
      setGoogleBusy(null);
      switch (step.kind) {
        case 'signedIn':
          finish(o as Partial<SigninResult>, null);
          return true;
        case 'signup':
          setGoogleErr('');
          setView({v: 'request', google: {email: step.email, name: step.name, pollId: step.pollId}});
          return true;
        case 'reset':
          setGoogleErr('');
          setView({v: 'newPw', token: step.token, name: step.name});
          return true;
        case 'pending':
          return false;
        default:
          setGoogleErr(W.failed);
          setView(whereFor(intent));
          return true;
      }
    },
    [finish],
  );

  const handleLink = useCallback(
    async (url: string) => {
      // an emailed reset link ({site}/#/reset/<token>): check it, then the new-password step
      const r = parsePhoneLink(url, linkHosts());
      if (r && r.kind === 'resetLink') {
        setGoogleErr('');
        setView({v: 'google', label: W.checkingLink});
        try {
          const c = await api.resetCheck(r.token);
          setView({v: 'newPw', token: r.token, name: c?.name || ''});
        } catch (e) {
          setGoogleErr(e instanceof ApiError && e.status === 410 ? W.errResetLinkGone : refusalProblem(e).text);
          setView({v: 'forgot'});
        }
        return;
      }
      const l = parseGoogleAuth(url);
      if (!l) return;
      const intent = await pendingIntent();
      if (l.error || !l.code) {
        await dropPending();
        setGoogleBusy(null);
        setGoogleErr(l.error || W.failed);
        setView(whereFor(intent));
        return;
      }
      setGoogleErr('');
      setView({v: 'google', label: W.googleFinishing});
      try {
        const r = await finishGoogleTab(l.code);
        onGoogleOutcome(r.intent, r.outcome);
      } catch (e) {
        setGoogleBusy(null);
        setGoogleErr(e instanceof GoogleProblem ? e.message : googleRefusal(e));
        setView(whereFor(intent));
      }
    },
    [onGoogleOutcome],
  );
  useEffect(() => onAuthLink(u => handleLink(u)), [handleLink]);
  useEffect(() => {
    if (initialLink) handleLink(initialLink);
    // (once: the wall hands the link that opened this door)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Back from the tab without finishing: the button is not left spinning
  useEffect(() => {
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active') setTimeout(() => setGoogleBusy(b => (b ? null : b)), 1200);
    });
    return () => sub.remove();
  }, []);

  const startGoogle = async (intent: GoogleIntent) => {
    if (googleBusy) return;
    setGoogleErr('');
    if (way === 'device') return setView({v: 'device', intent});
    if (way !== 'tab') return setGoogleErr(W.errGoogleOff);
    setGoogleBusy(intent);
    try {
      const r = await openGoogleTab(intent);
      if (r === 'noBrowser') {
        setGoogleBusy(null);
        if (info?.googleDevice) setView({v: 'device', intent});
        else setGoogleErr(W.errGoogleNone);
      }
    } catch {
      setGoogleBusy(null);
      if (info?.googleDevice) setView({v: 'device', intent});
      else setGoogleErr(W.errGoogleNone);
    }
  };

  // ---- Android's Back: one step back inside the door; out to the wall from its first page ----
  const back = useCallback((): boolean => {
    switch (view.v) {
      case 'pair':
        setView({v: 'signin'});
        return true;
      case 'sent':
        if (onLeave && start === 'request') onLeave();
        else setView({v: 'signin'});
        return true;
      case 'forgot':
        if (onLeave && start === 'forgot') onLeave();
        else setView({v: 'signin'});
        return true;
      case 'request':
        if (view.google) {
          setView({v: 'request'});
          return true;
        }
        if (onLeave && start === 'request') {
          onLeave();
          return true;
        }
        setView({v: 'signin'});
        return true;
      case 'ask':
      case 'code':
      case 'email':
      case 'emailSent':
      case 'askSent':
        setView({v: 'forgot'});
        return true;
      case 'newPw':
        setView({v: 'forgot'});
        return true;
      case 'device':
        setView(whereFor(view.intent));
        return true;
      case 'google':
        return true;
      default:
        if (onLeave) {
          onLeave();
          return true;
        }
        return false;
    }
  }, [view, start, onLeave]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', back);
    return () => sub.remove();
  }, [back]);

  const toSignIn = () => setView({v: 'signin'});
  const switcher = (on: 'left' | 'right') => (
    <Segmented
      value={on}
      left={W.tabSignIn}
      right={W.tabRequest}
      onChange={k => {
        setGoogleErr('');
        setView(k === 'left' ? {v: 'signin'} : {v: 'request'});
      }}
    />
  );
  const wallLink = onLeave ? <TextLink uiId="phone.auth.wall" label={W.backToProfiles} onPress={onLeave} /> : null;

  let body: React.ReactNode;
  switch (view.v) {
    case 'signin':
      body = (
        <SignInForm
          ident={ident}
          setIdent={setIdent}
          notice={notice}
          googleErr={googleErr}
          switcher={switcher('left')}
          google={way ? <GoogleButton uiId="phone.auth.google" label={W.google} busy={googleBusy === 'signin'} onPress={() => startGoogle('signin')} /> : null}
          onForgot={() => {
            setGoogleErr('');
            setView({v: 'forgot'});
          }}
          onCode={() => setView({v: 'pair'})}
          onDone={finish}
          foot={wallLink}
        />
      );
      break;
    case 'pair':
      body = <PairView onDone={r => finish(r, null)} onBack={toSignIn} />;
      break;
    case 'request':
      body = (
        <RequestForm
          key={view.google ? view.google.pollId : 'plain'}
          google={view.google}
          admin={admin}
          googleErr={googleErr}
          switcher={view.google ? null : switcher('right')}
          googleButton={way && !view.google ? <GoogleButton uiId="phone.auth.google.signup" label={W.googleSignUp} busy={googleBusy === 'signup'} onPress={() => startGoogle('signup')} /> : null}
          onSent={() => setView({v: 'sent'})}
          onCancel={() => setView({v: 'request'})}
          foot={view.google ? null : wallLink}
        />
      );
      break;
    case 'sent':
      body = (
        <>
          <Title line={W.sentLine(admin)}>{W.sentTitle}</Title>
          <MainButton uiId="phone.auth.sent.done" label={onLeave && start === 'request' ? W.done : W.backToSignIn} onPress={() => (onLeave && start === 'request' ? onLeave() : toSignIn())} />
        </>
      );
      break;
    case 'forgot': {
      const ways = resetWays(opts, !!way);
      body = (
        <>
          <Title line={W.forgotLine}>{W.forgotTitle}</Title>
          <FormError text={googleErr} />
          {!opts ? <ActivityIndicator color={A.dim} style={{marginVertical: 18}} /> : null}
          {ways.google ? <Choice uiId="phone.reset.google" title={W.wayGoogle} line={W.wayGoogleLine} busy={googleBusy === 'reset'} onPress={() => startGoogle('reset')} /> : null}
          {ways.admin ? <Choice uiId="phone.reset.admin" title={W.wayAdmin(admin)} line={W.wayAdminLine(admin)} onPress={() => setView({v: 'ask'})} /> : null}
          <Choice uiId="phone.reset.code" title={W.wayCode} line={W.wayCodeLine(admin)} onPress={() => setView({v: 'code'})} />
          {ways.email ? <Choice uiId="phone.reset.email" title={W.wayEmail} line={W.wayEmailLine} onPress={() => setView({v: 'email'})} /> : null}
          <Text style={[as.body, {marginTop: 8}]}>{W.elsewhere}</Text>
          <Foot>
            <TextLink uiId="phone.reset.back" label={start === 'forgot' && onLeave ? W.backToProfiles : W.backToSignIn} onPress={() => (start === 'forgot' && onLeave ? onLeave() : toSignIn())} />
          </Foot>
        </>
      );
      break;
    }
    case 'ask':
      body = <AskForm admin={admin} ident={ident} setIdent={setIdent} onSent={ticket => setView({v: 'askSent', ticket})} onBack={() => setView({v: 'forgot'})} />;
      break;
    case 'askSent':
      body = (
        <AskWait
          admin={admin}
          ticket={view.ticket}
          onApproved={(token, name) => setView({v: 'newPw', token, name})}
          onCode={() => setView({v: 'code'})}
          onOther={() => setView({v: 'forgot'})}
        />
      );
      break;
    case 'code':
      body = (
        <CodeForm
          admin={admin}
          len={opts?.codeLength || 8}
          ident={ident}
          setIdent={setIdent}
          onToken={(token, name) => setView({v: 'newPw', token, name})}
          onBack={() => setView({v: 'forgot'})}
        />
      );
      break;
    case 'email':
      body = <EmailForm ident={ident} setIdent={setIdent} onSent={() => setView({v: 'emailSent'})} onBack={() => setView({v: 'forgot'})} />;
      break;
    case 'emailSent':
      body = (
        <>
          <Title line={W.emailSentLine}>{W.emailSentTitle}</Title>
          <MainButton uiId="phone.reset.email.done" label={start === 'forgot' && onLeave ? W.backToProfiles : W.backToSignIn} onPress={() => (start === 'forgot' && onLeave ? onLeave() : toSignIn())} />
        </>
      );
      break;
    case 'newPw':
      body = (
        <ResetNewPassword
          token={view.token}
          name={view.name}
          onDone={r => finish(r, null)}
          onGone={() => setView({v: 'forgot'})}
        />
      );
      break;
    case 'device':
      body = <DeviceGoogle intent={view.intent} onOutcome={o => onGoogleOutcome(view.intent, o)} onBack={() => setView(whereFor(view.intent))} />;
      break;
    case 'google':
      body = (
        <>
          <Title>{view.label}</Title>
          <ActivityIndicator color={A.text} size="large" style={{marginVertical: 24}} />
        </>
      );
      break;
  }
  return <AuthShell>{body}</AuthShell>;
}

// ================= sign in =================

function SignInForm({
  ident,
  setIdent,
  notice,
  googleErr,
  switcher,
  google,
  onForgot,
  onCode,
  onDone,
  foot,
}: {
  ident: string;
  setIdent: (s: string) => void;
  notice?: string;
  googleErr: string;
  switcher: React.ReactNode;
  google: React.ReactNode;
  onForgot: () => void;
  onCode: () => void;
  onDone: (r: Partial<SigninResult>, typed: string | null) => void;
  foot: React.ReactNode;
}) {
  const [password, setPassword] = useState('');
  const [errs, setErrs] = useState<Problems>({});
  const [busy, setBusy] = useState(false);
  const identRef = useRef<TextInput>(null);
  const passRef = useRef<TextInput>(null);
  const refs: Partial<Record<Field, React.RefObject<TextInput | null>>> = {identifier: identRef, password: passRef};

  const submit = async () => {
    if (busy) return;
    const p = signInProblems(ident, password);
    setErrs(p);
    if (hasProblems(p)) {
      const f = firstProblem(p, ['identifier', 'password']);
      if (f) refs[f]?.current?.focus();
      return;
    }
    setBusy(true);
    try {
      onDone(await api.login(ident.trim(), password), password);
    } catch (e) {
      const pr = refusalProblem(e, {wrongField: 'password'});
      setErrs(pr.field ? {[pr.field]: pr.text} : {form: pr.text});
      if (pr.field === 'password') passRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {switcher}
      <Title line={W.signInLine}>{W.signInTitle}</Title>
      <Notice text={notice} />
      <AuthField
        ref={identRef}
        label={W.identifier}
        value={ident}
        onChangeText={t => {
          setIdent(t);
          if (errs.identifier || errs.form) setErrs(e => ({...e, identifier: undefined, form: undefined}));
        }}
        error={errs.identifier}
        autoComplete="username"
        textContentType="username"
        importantForAutofill="yes"
        keyboardType="default"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => passRef.current?.focus()}
      />
      <AuthField
        ref={passRef}
        label={W.password}
        aside={<TextLink uiId="phone.auth.forgot" compact label={W.forgot} onPress={onForgot} />}
        secret
        value={password}
        onChangeText={t => {
          setPassword(t);
          if (errs.password || errs.form) setErrs(e => ({...e, password: undefined, form: undefined}));
        }}
        error={errs.password}
        autoComplete="current-password"
        textContentType="password"
        importantForAutofill="yes"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <FormError text={errs.form || googleErr} />
      <MainButton uiId="signin.submit" label={W.signIn} busyLabel={W.signingIn} busy={busy} onPress={submit} />
      {google ? (
        <>
          <Or />
          {google}
        </>
      ) : null}
      <Foot>
        <TextLink uiId="signin.mode.qr" label={W.useCode} onPress={onCode} />
        {foot}
      </Foot>
    </>
  );
}

// ================= a code to approve on another device (the TV's pairing) =================

const PAIR_POLL_MS = 2000;
function PairView({onDone, onBack}: {onDone: (r: Partial<SigninResult>) => void; onBack: () => void}) {
  const doneRef = useLatest(onDone);
  const [pair, setPair] = useState<{code: string; linkPath: string} | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    let poll: ReturnType<typeof setInterval> | null = null;
    let refresh: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    const begin = async () => {
      if (poll) clearInterval(poll);
      if (refresh) clearTimeout(refresh);
      setPair(null);
      setErr('');
      try {
        const r = await api.deviceStart();
        if (!live) return;
        setPair({code: r.code, linkPath: r.linkPath});
        refresh = setTimeout(begin, Math.max(30, (r.expiresIn || 300) - 10) * 1000);
        poll = setInterval(async () => {
          if (polling) return;
          polling = true;
          try {
            const p = await api.devicePoll(r.code, r.secret);
            if (live && !p.pending) doneRef.current(p);
          } catch (e) {
            if (live && e instanceof ApiError && e.status === 410) begin();
          } finally {
            polling = false;
          }
        }, PAIR_POLL_MS);
      } catch (e) {
        if (live) setErr(refusalProblem(e).text);
      }
    };
    begin();
    return () => {
      live = false;
      if (poll) clearInterval(poll);
      if (refresh) clearTimeout(refresh);
    };
  }, [doneRef]);
  const host = getBaseUrl().replace(/^https?:\/\//, '');
  return (
    <>
      <Title line="A phone, tablet or computer that's signed in can let this phone in.">Sign in with a code</Title>
      <View style={as.codeBox} accessible accessibilityLabel={pair ? `Your code: ${pair.code.split('').join(' ')}` : 'Getting a code'}>
        <Text style={as.codeLabel}>Your code</Text>
        <Text style={as.code} selectable>
          {pair ? pair.code : '· · · · · ·'}
        </Text>
        <Text style={as.body}>{`On the signed-in device, open ${host}${pair?.linkPath || '/#/pair'} and enter this code. This phone signs in by itself.`}</Text>
      </View>
      <FormError text={err} />
      <Foot>
        <TextLink uiId="signin.mode.typed" label="Use a password instead" onPress={onBack} />
      </Foot>
    </>
  );
}

// ================= request access =================

const EMPTY: RequestFields = {name: '', username: '', email: '', password: '', confirm: '', note: ''};
const REQ_ORDER: Field[] = ['name', 'username', 'email', 'password', 'confirm', 'note'];

function RequestForm({
  google,
  admin,
  googleErr,
  switcher,
  googleButton,
  onSent,
  onCancel,
  foot,
}: {
  google?: GoogleCtx;
  admin: string;
  googleErr: string;
  switcher: React.ReactNode;
  googleButton: React.ReactNode;
  onSent: () => void;
  onCancel: () => void;
  foot: React.ReactNode;
}) {
  const [f, setF] = useState<RequestFields>({...EMPTY, name: google?.name || ''});
  const [errs, setErrs] = useState<Problems>({});
  const [busy, setBusy] = useState(false);
  const refs = {
    name: useRef<TextInput>(null),
    username: useRef<TextInput>(null),
    email: useRef<TextInput>(null),
    password: useRef<TextInput>(null),
    confirm: useRef<TextInput>(null),
    note: useRef<TextInput>(null),
  } as Record<string, React.RefObject<TextInput | null>>;
  const set = (k: keyof RequestFields) => (t: string) => {
    setF(cur => ({...cur, [k]: t}));
    if (errs[k] || errs.form) setErrs(e => ({...e, [k]: undefined, form: undefined}));
  };
  const next = (k: string) => () => refs[k]?.current?.focus();

  const send = async () => {
    if (busy) return;
    const p = requestProblems(f, !!google);
    setErrs(p);
    if (hasProblems(p)) {
      const first = firstProblem(p, REQ_ORDER);
      if (first) refs[first]?.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await api.signup(requestBody(f, google?.pollId));
      onSent();
    } catch (e) {
      const pr = refusalProblem(e);
      setErrs(pr.field && pr.field in refs ? {[pr.field]: pr.text} : {form: pr.text});
      if (pr.field && refs[pr.field]) refs[pr.field].current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {switcher}
      {google ? (
        <Title
          line={
            <>
              <Text style={as.strong}>{W.googleAs(google.email || 'your Google account')}</Text>
              {`\n${W.googleSignupLine}`}
            </>
          }>
          {W.googleSignupTitle}
        </Title>
      ) : (
        <Title line={W.requestLine(admin)}>{W.requestTitle}</Title>
      )}
      <FormError text={googleErr} />
      {googleButton ? (
        <>
          {googleButton}
          <Or />
        </>
      ) : null}
      <AuthField ref={refs.name} label={W.name} value={f.name} onChangeText={set('name')} error={errs.name} maxLength={24} autoCapitalize="words" autoComplete="name" textContentType="name" returnKeyType="next" submitBehavior="submit" onSubmitEditing={next('username')} />
      <AuthField
        ref={refs.username}
        label={google ? W.usernameOptional : W.username}
        help={google ? W.usernameHelpGoogle : W.usernameHelp}
        value={f.username}
        onChangeText={set('username')}
        error={errs.username}
        maxLength={24}
        autoComplete="username-new"
        textContentType="username"
        importantForAutofill="yes"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={next(google ? 'password' : 'email')}
      />
      {google ? null : (
        <AuthField
          ref={refs.email}
          label={W.email}
          help={W.emailHelp}
          value={f.email}
          onChangeText={set('email')}
          error={errs.email}
          maxLength={80}
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={next('password')}
        />
      )}
      <AuthField
        ref={refs.password}
        label={W.password}
        help={PASSWORD_HELP}
        secret
        value={f.password}
        onChangeText={set('password')}
        error={errs.password}
        below={<Strength pw={f.password} personal={[f.name, f.username, f.email, google?.email]} />}
        autoComplete="new-password"
        textContentType="newPassword"
        importantForAutofill="yes"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={next('confirm')}
      />
      <AuthField
        ref={refs.confirm}
        label={W.confirm}
        secret
        value={f.confirm}
        onChangeText={set('confirm')}
        error={errs.confirm}
        autoComplete="new-password"
        textContentType="newPassword"
        importantForAutofill="yes"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={next('note')}
      />
      <AuthField ref={refs.note} label={W.note(admin)} value={f.note} onChangeText={set('note')} error={errs.note} maxLength={200} autoCapitalize="sentences" autoCorrect autoComplete="off" importantForAutofill="no" returnKeyType="send" onSubmitEditing={send} />
      <FormError text={errs.form} />
      <MainButton uiId="phone.request.send" label={W.send} busyLabel={W.sending} busy={busy} onPress={send} />
      <Foot>
        {google ? <TextLink uiId="phone.request.leave" label={W.cancel} onPress={onCancel} /> : null}
        {foot}
      </Foot>
    </>
  );
}

// ================= reset: ask the admin =================

function AskForm({admin, ident, setIdent, onSent, onBack}: {admin: string; ident: string; setIdent: (s: string) => void; onSent: (ticket: string) => void; onBack: () => void}) {
  const [note, setNote] = useState('');
  const [errs, setErrs] = useState<Problems>({});
  const [busy, setBusy] = useState(false);
  const identRef = useRef<TextInput>(null);
  const noteRef = useRef<TextInput>(null);
  const send = async () => {
    if (busy) return;
    if (!ident.trim()) {
      setErrs({identifier: W.errIdentifier});
      identRef.current?.focus();
      return;
    }
    setErrs({});
    setBusy(true);
    try {
      const r = await api.resetRequest(ident.trim(), note.trim() || undefined);
      onSent(r.ticket);
    } catch (e) {
      const pr = refusalProblem(e);
      setErrs(pr.field === 'identifier' ? {identifier: pr.text} : {form: pr.text});
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Title line={W.askLine(admin)}>{W.askTitle(admin)}</Title>
      <AuthField
        ref={identRef}
        label={W.identifier}
        value={ident}
        onChangeText={t => {
          setIdent(t);
          setErrs({});
        }}
        error={errs.identifier}
        autoComplete="username"
        textContentType="username"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => noteRef.current?.focus()}
      />
      <AuthField ref={noteRef} label={W.note(admin)} value={note} onChangeText={setNote} maxLength={200} autoCapitalize="sentences" autoCorrect importantForAutofill="no" returnKeyType="send" onSubmitEditing={send} />
      <FormError text={errs.form} />
      <MainButton uiId="phone.reset.admin.send" label={W.send} busyLabel={W.sending} busy={busy} onPress={send} />
      <Foot>
        <TextLink uiId="phone.reset.other" label={W.back} onPress={onBack} />
      </Foot>
    </>
  );
}

function AskWait({admin, ticket, onApproved, onCode, onOther}: {admin: string; ticket: string; onApproved: (token: string, name: string) => void; onCode: () => void; onOther: () => void}) {
  const approvedRef = useLatest(onApproved);
  const [state, setState] = useState<'wait' | 'declined' | 'expired'>('wait');
  const [visible, setVisible] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', st => setVisible(st === 'active'));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (state !== 'wait' || !visible) return;
    let live = true;
    let busy = false;
    const ask = async () => {
      if (busy) return;
      busy = true;
      try {
        const st = askStep(await api.resetStatus(ticket));
        if (!live) return;
        if (st.kind === 'approved') {
          live = false;
          approvedRef.current(st.token, st.name);
        }
        else if (st.kind !== 'wait') setState(st.kind);
      } catch (e) {
        if (live && e instanceof ApiError && e.status === 410) setState('expired');
      } finally {
        busy = false;
      }
    };
    ask();
    const t = setInterval(ask, ASK_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [ticket, state, visible, approvedRef]);
  if (state !== 'wait') {
    return (
      <>
        <Title line={state === 'declined' ? W.askDeclined(admin) : W.askExpired}>{W.forgotTitle}</Title>
        <MainButton uiId="phone.reset.other" label="Try another way" onPress={onOther} />
      </>
    );
  }
  return (
    <>
      <Title line={W.askSentLine(admin)}>{W.askSentTitle}</Title>
      <View style={as.waitRow} accessible accessibilityLiveRegion="polite" accessibilityLabel={W.askWaiting}>
        <ActivityIndicator color={A.dim} size="small" />
        <Text style={as.body}>{W.askWaiting}</Text>
      </View>
      <Foot>
        <TextLink uiId="phone.reset.code" label={W.haveCode} onPress={onCode} />
        <TextLink uiId="phone.reset.other" label="Try another way" onPress={onOther} />
      </Foot>
    </>
  );
}

// ================= reset: a code from the admin =================

function CodeForm({admin, len, ident, setIdent, onToken, onBack}: {admin: string; len: number; ident: string; setIdent: (s: string) => void; onToken: (token: string, name: string) => void; onBack: () => void}) {
  const [code, setCode] = useState('');
  const [errs, setErrs] = useState<Problems>({});
  const [busy, setBusy] = useState(false);
  const identRef = useRef<TextInput>(null);
  const codeRef = useRef<TextInput>(null);
  const send = async () => {
    if (busy) return;
    const p: Problems = {};
    if (!ident.trim()) p.identifier = W.errIdentifier;
    if (!code) p.code = W.errCode;
    setErrs(p);
    if (hasProblems(p)) return (p.identifier ? identRef : codeRef).current?.focus();
    setBusy(true);
    try {
      const r = await api.resetWithCode(ident.trim(), code);
      onToken(r.token, r.name);
    } catch (e) {
      const pr = refusalProblem(e, {wrongField: 'code'});
      setErrs(pr.field === 'identifier' || pr.field === 'code' ? {[pr.field]: pr.text} : {form: pr.text});
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Title line={W.codeLine(admin, len)}>{W.codeTitle}</Title>
      <AuthField
        ref={identRef}
        label={W.identifier}
        value={ident}
        onChangeText={t => {
          setIdent(t);
          setErrs({});
        }}
        error={errs.identifier}
        autoComplete="username"
        textContentType="username"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => codeRef.current?.focus()}
      />
      <AuthField
        ref={codeRef}
        label={W.code}
        value={code}
        onChangeText={t => {
          setCode(typedResetCode(t, Math.max(len, 8) + 4));
          setErrs({});
        }}
        error={errs.code}
        autoCapitalize="characters"
        autoComplete="off"
        importantForAutofill="no"
        keyboardType="visible-password"
        returnKeyType="go"
        onSubmitEditing={send}
        style={{letterSpacing: 2, fontVariant: ['tabular-nums']}}
      />
      <FormError text={errs.form} />
      <MainButton uiId="phone.reset.code.send" label={W.continue} busy={busy} onPress={send} />
      <Foot>
        <TextLink uiId="phone.reset.other" label={W.back} onPress={onBack} />
      </Foot>
    </>
  );
}

// ================= reset: email (when the server has it on) =================

function EmailForm({ident, setIdent, onSent, onBack}: {ident: string; setIdent: (s: string) => void; onSent: () => void; onBack: () => void}) {
  const [errs, setErrs] = useState<Problems>({});
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (busy) return;
    if (!ident.trim()) return setErrs({identifier: W.errIdentifier});
    setBusy(true);
    try {
      await api.resetEmail(ident.trim());
      onSent();
    } catch (e) {
      setErrs({form: refusalProblem(e).text});
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Title line={W.emailLine}>{W.emailTitle}</Title>
      <AuthField
        label={W.identifier}
        value={ident}
        onChangeText={t => {
          setIdent(t);
          setErrs({});
        }}
        error={errs.identifier}
        autoComplete="username"
        textContentType="username"
        returnKeyType="send"
        onSubmitEditing={send}
      />
      <FormError text={errs.form} />
      <MainButton uiId="phone.reset.email.send" label={W.sendLink} busy={busy} onPress={send} />
      <Foot>
        <TextLink uiId="phone.reset.other" label={W.back} onPress={onBack} />
      </Foot>
    </>
  );
}

// ================= reset: the new password (every way ends here) =================

function ResetNewPassword({token, name, onDone, onGone}: {token: string; name: string; onDone: (r: SigninResult) => void; onGone: () => void}) {
  const [fresh, setFresh] = useState('');
  const [confirm, setConfirm] = useState('');
  const [others, setOthers] = useState(true);
  const [errs, setErrs] = useState<Problems>({});
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const freshRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);
  const save = async () => {
    if (busy) return;
    const p = newPasswordProblems({fresh, confirm});
    setErrs(p);
    if (hasProblems(p)) return (p.newPassword ? freshRef : confirmRef).current?.focus();
    setBusy(true);
    try {
      onDone(await api.resetComplete(token, fresh, others));
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) setGone(true);
      const pr = refusalProblem(e, {fieldMap: {password: 'newPassword'}});
      setErrs(pr.field === 'newPassword' || pr.field === 'confirm' ? {[pr.field]: pr.text} : {form: e instanceof ApiError && e.status === 410 ? W.errResetGone : pr.text});
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Title line={W.newLine(name)}>{W.newTitle}</Title>
      <AuthField
        ref={freshRef}
        label={W.newPassword}
        help={PASSWORD_HELP}
        secret
        value={fresh}
        onChangeText={t => {
          setFresh(t);
          setErrs({});
        }}
        error={errs.newPassword}
        below={<Strength pw={fresh} personal={[name]} />}
        autoFocus
        autoComplete="new-password"
        textContentType="newPassword"
        importantForAutofill="yes"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => confirmRef.current?.focus()}
      />
      <AuthField
        ref={confirmRef}
        label={W.confirm}
        secret
        value={confirm}
        onChangeText={t => {
          setConfirm(t);
          setErrs({});
        }}
        error={errs.confirm}
        autoComplete="new-password"
        textContentType="newPassword"
        importantForAutofill="yes"
        returnKeyType="go"
        onSubmitEditing={save}
      />
      <Check uiId="phone.reset.signoutothers" label={W.signOutOthers} help={W.signOutOthersHelp} value={others} onChange={setOthers} />
      <FormError text={errs.form} />
      {gone ? (
        <MainButton uiId="phone.reset.restart" label="Start again" onPress={onGone} />
      ) : (
        <MainButton uiId="phone.reset.save" label={W.saveAndSignIn} busyLabel={W.saving} busy={busy} onPress={save} />
      )}
    </>
  );
}

// ================= Google with a code on this screen =================

function DeviceGoogle({intent, onOutcome, onBack}: {intent: GoogleIntent; onOutcome: (o: Parameters<typeof googleStep>[0]) => boolean; onBack: () => void}) {
  const outcomeRef = useLatest(onOutcome);
  const [d, setD] = useState<{userCode: string; verificationUrl: string} | null>(null);
  const [err, setErr] = useState('');
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      try {
        const s = await api.googleStartFor(intent);
        if (!live) return;
        setD({userCode: s.userCode, verificationUrl: s.verificationUrl});
        const every = Math.max(3, s.interval || 5) * 1000;
        const until = Date.now() + (s.expiresIn || 600) * 1000;
        const tick = async () => {
          if (!live) return;
          if (Date.now() > until) return setErr(W.errGoogleLate);
          try {
            const o = await api.googlePollFor(s.pollId);
            if (!live) return;
            if (outcomeRef.current(o)) return;
          } catch (e) {
            if (!live) return;
            if (e instanceof ApiError && (e.status === 410 || e.status === 404)) return setErr(W.errGoogleLate);
            if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) return setErr(googleRefusal(e));
          }
          t = setTimeout(tick, every);
        };
        t = setTimeout(tick, every);
      } catch (e) {
        if (live) setErr(refusalProblem(e).text);
      }
    })();
    return () => {
      live = false;
      if (t) clearTimeout(t);
    };
  }, [intent, round, outcomeRef]);
  const url = (d?.verificationUrl || '').replace(/^https?:\/\//, '');
  return (
    <>
      <Title line={d ? W.deviceLine(url) : undefined}>{W.deviceTitle}</Title>
      <View style={as.codeBox} accessible accessibilityLabel={d ? `Code: ${d.userCode.split('').join(' ')}` : 'Getting a code'}>
        <Text style={as.codeLabel}>Code</Text>
        <Text style={as.code} selectable>
          {d ? d.userCode : '· · · ·'}
        </Text>
        <Text style={as.body}>{W.deviceWaiting}</Text>
      </View>
      <FormError text={err} />
      {err ? (
        <MainButton
          uiId="phone.auth.device.retry"
          label="Get a new code"
          onPress={() => {
            setErr('');
            setD(null);
            setRound(n => n + 1);
          }}
        />
      ) : null}
      <Foot>
        <TextLink uiId="phone.auth.device.back" label={W.back} onPress={onBack} />
      </Foot>
    </>
  );
}
