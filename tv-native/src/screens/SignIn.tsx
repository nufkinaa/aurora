// Sign in — the TV's face of the sign-in wall, shown when the server runs in
// CLOSED mode (or a session dies mid-run). [auth-round] redrawn in the round's
// look (docs/auth-round.md): the night sky, one glass panel, the Beam mark,
// "Sign in · Request access", labels above fields, errors in place, the
// mint→violet button and Google's dark one. The words are the contract's
// (authFlow.ts WORDS), the same as the website and the phone app.
//
// ONE PANEL, TWO WAYS IN, SIDE BY SIDE:
//   - typing: "Username or email" + "Password" (Show / Hide), Sign in, and
//     "Forgot password?" beside it; "Continue with Google" under them when the
//     server has a TV-type Google client (serverInfo.googleDevice);
//   - the phone: the QR of {base}/link?code=XXXXXX and the same code as text.
//     A household member's signed-in phone approves the TV in one tap. Codes
//     live 5 minutes; the QR refreshes itself on expiry (never on an
//     interval - `start` is rate-limited).
//
// The other views share the panel: Request access (with a password, Google
// or not - ask #2), Google's device flow, "Request sent", and Forgot password
// (Reset.tsx - every way back in without the old password; ask #4).
//
// BACK goes one step back (authFlow.ts signinBack); on the sign-in view it
// falls through (this screen is the app's floor - Back leaves the app).
// FOCUS opens on the first empty field, WITHOUT the keyboard (OK opens it);
// the keyboard's Next moves on and Go sends; a refused send puts focus on the
// field the words are about. Nothing typed is ever cleared by an error.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {BackHandler, Text, View} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {api, ApiError, getBaseUrl, GoogleOutcome, SigninResult} from '../api';
import {
  adminWord,
  FieldErrors,
  firstProblem,
  GoogleNext,
  hasProblems,
  refusalWords,
  requestProblems,
  signinBack,
  SignInView,
  signinProblems,
  suggestedName,
  WORDS,
} from '../authFlow';
import {PASSWORD_HELP} from '../passRules';
import {clearKidsLock, loadKidsLock, saveKidsLock} from '../storage';
import GoogleDevice from './GoogleDevice';
import Reset from './Reset';
import {
  A,
  as,
  AuthShell,
  Body,
  Field,
  FieldHandle,
  FormError,
  GoogleButton,
  MainButton,
  Row,
  Strength,
  Switch,
  TextLink,
  Title,
  Waiting,
} from './authKit';

const POLL_MS = 3000;
const hidden = {display: 'none'} as const;

type View_ = SignInView | 'sent';
type GoogleSignup = {pollId: string; email: string; name: string};

export default function SignIn({
  onSignedIn,
  notice,
}: {
  // `extra.mustReset`: the admin asked for a new password, or (passwordSetup)
  // a Google-only profile has none yet — `typed` is the password just
  // entered, when this screen saw one (AppRoot → NewPassword).
  onSignedIn: (profileId: string, token: string, session: string, extra?: {mustReset?: boolean; typed?: string | null}) => void;
  // why the viewer is being asked to sign in again (a kick, a sign-out
  // from another device)
  notice?: string;
}) {
  const [view, setView] = useState<View_>('signin');
  // where focus lands when the sign-in view comes back (the control that left it)
  const [returnTo, setReturnTo] = useState<'forgot' | 'google' | 'requestGoogle' | null>(null);
  const [googleDevice, setGoogleDevice] = useState(false);
  const [admin, setAdmin] = useState('the admin');
  const [googleIntent, setGoogleIntent] = useState<'signin' | 'signup'>('signin');
  const [gSignup, setGSignup] = useState<GoogleSignup | null>(null);
  const [sentGoogle, setSentGoogle] = useState<string | null>(null); // the Google email, on a Google request
  const done = useRef(false); // success is single-shot across every poller
  const [requestDrawn, setRequestDrawn] = useState(false);
  const [backAt, setBackAt] = useState(0);
  const [forgotId, setForgotId] = useState(''); // what was typed on sign-in, carried into the reset
  useEffect(() => {
    if (view === 'request') setRequestDrawn(true);
    // the control that left the sign-in view has had its focus back
    if ((view === 'signin' || view === 'request') && returnTo) {
      const t = setTimeout(() => setReturnTo(null), 600);
      return () => clearTimeout(t);
    }
  }, [view, returnTo]);

  const finish = useCallback(
    (r: Partial<SigninResult>, typed: string | null = null) => {
      if (done.current) return;
      if (!r.profile?.id || !r.profileToken || !r.session) return;
      done.current = true;
      // The kids lock follows WHO signed this TV in. A pairing / sign-in as a
      // grown-up's profile is a grown-up letting the TV in: a lock left from an
      // earlier kids session no longer stands (the wall kept showing it after a
      // closed-mode re-pair — Mi TV, 2026-10-18). Signed in AS a kids profile,
      // the TV is locked to it, as entering it from the wall does.
      const kids = r.profile.kids;
      if (kids && typeof kids.maxAge === 'number') {
        console.log('[kids] signed in as kids profile', r.profile.id, '- TV locked to it');
        saveKidsLock({id: r.profile.id, maxAge: kids.maxAge});
      } else {
        loadKidsLock().then(l => {
          if (!l) return;
          console.log('[kids] signed in as', r.profile!.id, '- the lock on', l.id, 'is lifted');
          clearKidsLock();
        });
      }
      // mustReset covers both the forced reset and a Google-only profile's
      // first password (passwordSetup): NewPassword asks /api/me which it is.
      onSignedIn(r.profile.id, r.profileToken, r.session, r.mustReset ? {mustReset: true, typed} : undefined);
    },
    [onSignedIn],
  );

  // Whether to offer Google at all. Errors mean "don't" — the button would
  // only lead to a 501.
  useEffect(() => {
    let live = true;
    api
      .serverInfo()
      .then(i => {
        if (!live) return;
        setGoogleDevice(!!i.googleDevice);
        setAdmin(adminWord(i.adminName));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Back: one step back. The Reset view and the Google sign-up form keep their
  // own steps (their listeners are added later, so they are asked first).
  useEffect(() => {
    if (view === 'signin') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      goSignin(view === 'forgot' ? 'forgot' : view === 'google' ? 'google' : null);
      return true;
    });
    return () => sub.remove();
    // goSignin reads only view and googleIntent, both listed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, googleIntent]);

  // Back to where this step was started from: Google started on Request
  // access goes back there, everything else to Sign in.
  const goSignin = (from: 'forgot' | 'google' | null = null) => {
    const toRequest = view === 'google' && googleIntent === 'signup';
    if (!toRequest) setBackAt(n => n + 1);
    setReturnTo(from === 'google' && toRequest ? 'requestGoogle' : from);
    setGSignup(null);
    setView(toRequest ? 'request' : signinBack(view as SignInView) || 'signin');
  };

  const onGoogle = (next: GoogleNext, raw: GoogleOutcome) => {
    if (next.next === 'signedIn') finish(raw);
    else if (next.next === 'signup') setGSignup({pollId: next.pollId, email: next.email, name: next.name});
  };

  const panelWidth = view === 'signin' ? 880 : view === 'request' ? 840 : view === 'google' ? (gSignup ? 800 : 760) : view === 'forgot' ? 700 : 620;
  const tabs = view === 'signin' || view === 'request' ? (
    <Switch
      value={view}
      onChange={v => {
        setReturnTo(null);
        setView(v);
      }}
    />
  ) : null;

  return (
    <AuthShell top={tabs} width={panelWidth}>
      {/* Sign in and Request access stay mounted once drawn (hidden, not
          unmounted): switching between them never loses what was typed */}
      <View style={view === 'signin' ? null : hidden}>
        <SignInForm
          admin={admin}
          notice={notice}
          googleDevice={googleDevice}
          returnTo={returnTo === 'forgot' || returnTo === 'google' ? returnTo : null}
          backAt={backAt}
          finish={finish}
          paused={done}
          onForgot={id => {
            setForgotId(id);
            setView('forgot');
          }}
          onGoogle={() => {
            setGoogleIntent('signin');
            setGSignup(null);
            setView('google');
          }}
        />
      </View>
      {requestDrawn ? (
        <View style={view === 'request' ? null : hidden}>
        <RequestForm
          admin={admin}
          backFromGoogle={returnTo === 'requestGoogle'}
          googleDevice={googleDevice}
          onSent={() => {
            setSentGoogle(null);
            setView('sent');
          }}
          onGoogle={() => {
            setGoogleIntent('signup');
            setGSignup(null);
            setView('google');
          }}
        />
        </View>
      ) : null}
      {view === 'google' && !gSignup ? (
        <GoogleDevice
          intent={googleIntent}
          title={googleIntent === 'signup' ? WORDS.googleSignup : WORDS.google}
          onOutcome={onGoogle}
          onBack={() => goSignin('google')}
        />
      ) : null}
      {view === 'google' && gSignup ? (
        <GoogleSignupForm
          admin={admin}
          signup={gSignup}
          onBack={() => {
            setGSignup(null);
            goSignin(null);
          }}
          onSent={() => {
            setSentGoogle(gSignup.email);
            setGSignup(null);
            setView('sent');
          }}
        />
      ) : null}
      {view === 'forgot' ? <Reset admin={admin} googleDevice={googleDevice} identifier={forgotId} onSignedIn={r => finish(r)} onExit={() => goSignin('forgot')} /> : null}
      {view === 'sent' ? (
        <View>
          <Title line={sentGoogle !== null ? WORDS.sentLineGoogle(admin, sentGoogle) : WORDS.sentLine(admin)}>{WORDS.sentTitle}</Title>
          <Row>
            <MainButton uiId="signin.sent.back" label="Back to sign in" first onPress={() => goSignin(null)} />
          </Row>
        </View>
      ) : null}
    </AuthShell>
  );
}

// ---- Sign in: typing on the left, the phone on the right -------------------
function SignInForm({
  admin,
  notice,
  googleDevice,
  returnTo,
  backAt,
  finish,
  paused,
  onForgot,
  onGoogle,
}: {
  admin: string;
  notice?: string;
  googleDevice: boolean;
  returnTo: 'forgot' | 'google' | null;
  // bumped each time the view comes back to sign in from a step
  backAt: number;
  finish: (r: Partial<SigninResult>, typed?: string | null) => void;
  paused: React.MutableRefObject<boolean>;
  onForgot: (identifier: string) => void;
  onGoogle: () => void;
}) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const idRef = useRef<FieldHandle>(null);
  const pwRef = useRef<FieldHandle>(null);
  const forgotRef = useRef<View>(null);
  const googleRef = useRef<View>(null);
  // back on this view (from Forgot password, Google, Request sent): focus goes
  // back to the control that left, or else to the first empty field
  useEffect(() => {
    if (!backAt) return;
    const t = setTimeout(() => {
      if (returnTo) {
        const node = (returnTo === 'forgot' ? forgotRef : googleRef).current as unknown as {requestTVFocus?: () => void} | null;
        node?.requestTVFocus?.();
      } else (identifier ? pwRef : idRef).current?.focusQuietly();
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backAt]);

  const submit = async () => {
    if (busy) return;
    setFormError('');
    const problems = signinProblems(identifier, password);
    if (hasProblems(problems)) {
      setErrors(problems);
      (firstProblem(problems, ['identifier', 'password']) === 'identifier' ? idRef : pwRef).current?.focusQuietly();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const r = await api.login(identifier.trim(), password);
      finish(r, password);
    } catch (e) {
      const rw = refusalWords(e instanceof ApiError ? e : null, 'signin', admin);
      if (rw.field === 'identifier' || rw.field === 'password') {
        setErrors({[rw.field]: rw.words});
        (rw.field === 'identifier' ? idRef : pwRef).current?.focusQuietly();
      } else setFormError(rw.words);
    } finally {
      setBusy(false);
    }
  };

  // ---- QR pairing ----
  const [pair, setPair] = useState<{code: string; secret: string; linkPath: string} | null>(null);
  const [pairErr, setPairErr] = useState('');
  useEffect(() => {
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
        setPair({code: r.code, secret: r.secret, linkPath: r.linkPath});
        // A fresh code shortly before this one dies, so the QR on screen is
        // always scannable. 10s of slack keeps us clear of the server's edge.
        refresh = setTimeout(start, Math.max(30, (r.expiresIn || 300) - 10) * 1000);
        poll = setInterval(async () => {
          if (polling || paused.current) return;
          polling = true;
          try {
            const p = await api.devicePoll(r.code, r.secret);
            if (!live) return;
            if (!p.pending) finish(p);
          } catch (e) {
            if (!live) return;
            // 410 = expired or already spent: mint a fresh code right away.
            if (e instanceof ApiError && e.status === 410) start();
          } finally {
            polling = false;
          }
        }, POLL_MS);
      } catch (e) {
        if (!live) return;
        setPairErr(refusalWords(e instanceof ApiError ? e : null, 'signin', admin).words.replace(WORDS.badSignin, "Couldn't make a code. Try again soon."));
      }
    };
    start();
    return () => {
      live = false;
      if (poll) clearInterval(poll);
      if (refresh) clearTimeout(refresh);
    };
  }, [finish, paused, admin]);

  const base = getBaseUrl();
  const host = base.replace(/^https?:\/\//, '');
  // the first empty field, when the screen is first drawn (Field acts on it once)
  const firstField = !identifier ? 'identifier' : !password ? 'password' : null;
  return (
    <View style={as.cols}>
      <View style={as.col}>
        <Title line={WORDS.signinLine} notice={notice}>
          {WORDS.signinTitle}
        </Title>
        <Field
          ref={idRef}
          qaId="signin.identifier"
          first={firstField === 'identifier'}
          label={WORDS.identifier}
          value={identifier}
          onChangeText={t => {
            setIdentifier(t);
            if (errors.identifier) setErrors(x => ({...x, identifier: undefined}));
          }}
          error={errors.identifier}
          keyboardType="email-address"
          textContentType="username"
          autoComplete="username"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => pwRef.current?.focus()}
        />
        <Field
          ref={pwRef}
          qaId="signin.password"
          first={firstField === 'password'}
          label={WORDS.password}
          secret
          value={password}
          onChangeText={t => {
            setPassword(t);
            if (errors.password) setErrors(x => ({...x, password: undefined}));
          }}
          error={errors.password}
          textContentType="password"
          autoComplete="current-password"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <FormError text={formError} />
        <Row gap={10}>
          <MainButton uiId="signin.submit" claim={formError} label={WORDS.signinBtn} busyLabel={WORDS.signinBusy} busy={busy} onPress={submit} />
          <TextLink uiId="signin.forgot" ref={forgotRef} label={WORDS.forgot} onPress={() => onForgot(identifier.trim())} />
        </Row>
        {googleDevice ? (
          <View style={{marginTop: 12, alignSelf: 'flex-start'}}>
            <GoogleButton uiId="signin.mode.google" ref={googleRef} label={WORDS.google} onPress={onGoogle} />
          </View>
        ) : null}
      </View>
      <View style={as.divider} />
      <View style={{width: 252}}>
        <Text style={as.sideTitle}>Or use your phone</Text>
        <View style={as.qr}>{pair ? <QRCode value={base + pair.linkPath} size={156} backgroundColor="#ffffff" color="#0b0c14" /> : null}</View>
        <Text style={{color: A.dim, fontSize: 14, lineHeight: 19, marginTop: 10}}>
          Scan it, or open <Text style={{color: A.text, fontWeight: '700'}}>{host}/link</Text> and enter:
        </Text>
        <Text style={{color: A.text, fontSize: 30, fontWeight: '800', letterSpacing: 6, marginTop: 2, fontVariant: ['tabular-nums']}}>
          {pair ? pair.code : '· · · · · ·'}
        </Text>
        {pairErr ? <Text style={{color: A.error, fontSize: 14, lineHeight: 19}}>{pairErr}</Text> : pair ? <Waiting text="Waiting for your phone…" /> : null}
      </View>
    </View>
  );
}

// ---- Request access (a password, always) ----------------------------------
function RequestForm({
  admin,
  googleDevice,
  backFromGoogle,
  onSent,
  onGoogle,
}: {
  admin: string;
  googleDevice: boolean;
  backFromGoogle: boolean;
  onSent: () => void;
  onGoogle: () => void;
}) {
  const googleRef = useRef<View>(null);
  // back from Google's step: focus goes back to "Sign up with Google"
  useEffect(() => {
    if (!backFromGoogle) return;
    const t = setTimeout(() => (googleRef.current as unknown as {requestTVFocus?: () => void} | null)?.requestTVFocus?.(), 60);
    return () => clearTimeout(t);
  }, [backFromGoogle]);
  const [f, setF] = useState({name: '', username: '', email: '', password: '', confirm: '', note: ''});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const refs = {
    name: useRef<FieldHandle>(null),
    username: useRef<FieldHandle>(null),
    email: useRef<FieldHandle>(null),
    password: useRef<FieldHandle>(null),
    confirm: useRef<FieldHandle>(null),
    note: useRef<FieldHandle>(null),
  };
  const ORDER = ['name', 'username', 'email', 'password', 'confirm', 'note'] as const;
  const set = (k: keyof typeof f) => (t: string) => {
    setF(x => ({...x, [k]: t}));
    if (errors[k]) setErrors(x => ({...x, [k]: undefined}));
  };
  const submit = async () => {
    if (busy) return;
    setFormError('');
    const problems = requestProblems(f);
    if (hasProblems(problems)) {
      setErrors(problems);
      const first = firstProblem(problems, [...ORDER]);
      if (first && first in refs) refs[first as keyof typeof refs].current?.focusQuietly();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.signup({
        name: f.name.trim(),
        username: f.username.trim(),
        email: f.email.trim() || undefined,
        password: f.password,
        note: f.note.trim() || 'Requested from the TV app',
      });
      onSent();
    } catch (e) {
      const rw = refusalWords(e instanceof ApiError ? e : null, 'request', admin);
      if (rw.field && rw.field in refs) {
        setErrors({[rw.field]: rw.words});
        refs[rw.field as keyof typeof refs].current?.focusQuietly();
      } else setFormError(rw.words);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <Title line={WORDS.requestLine(admin)}>{WORDS.requestTitle}</Title>
      <View style={as.cols}>
        <View style={as.col}>
          <Field ref={refs.name} qaId="request.name" label={WORDS.name} value={f.name} onChangeText={set('name')} error={errors.name}
            autoCapitalize="words" textContentType="name" autoComplete="name" maxLength={24}
            returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => refs.username.current?.focus()} />
          <Field ref={refs.username} qaId="request.username" label={WORDS.username} value={f.username} onChangeText={set('username')}
            error={errors.username} help={WORDS.usernameHelp} textContentType="username" autoComplete="username-new" maxLength={24}
            returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => refs.email.current?.focus()} />
          <Field ref={refs.email} qaId="request.email" label={WORDS.email} value={f.email} onChangeText={set('email')} error={errors.email}
            keyboardType="email-address" textContentType="emailAddress" autoComplete="email" maxLength={80}
            returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => refs.password.current?.focus()} />
        </View>
        <View style={as.col}>
          <Field ref={refs.password} qaId="request.password" label={WORDS.password} secret value={f.password} onChangeText={set('password')}
            error={errors.password} help={PASSWORD_HELP} below={<Strength pw={f.password} personal={[f.name, f.username, f.email]} />}
            textContentType="newPassword" autoComplete="new-password" maxLength={128}
            returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => refs.confirm.current?.focus()} />
          <Field ref={refs.confirm} qaId="request.confirm" label={WORDS.confirm} secret value={f.confirm} onChangeText={set('confirm')}
            error={errors.confirm} textContentType="newPassword" autoComplete="new-password" maxLength={128}
            returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => refs.note.current?.focus()} />
          <Field ref={refs.note} qaId="request.note" label={WORDS.note(admin)} value={f.note} onChangeText={set('note')} error={errors.note}
            autoCapitalize="sentences" maxLength={200} returnKeyType="send" onSubmitEditing={submit} />
        </View>
      </View>
      <FormError text={formError} />
      <Row gap={14}>
        <MainButton uiId="request.submit" claim={formError} label={WORDS.sendRequest} busyLabel={WORDS.sending} busy={busy} onPress={submit} />
        {googleDevice ? <GoogleButton uiId="request.google" ref={googleRef} label={WORDS.googleSignup} onPress={onGoogle} /> : null}
      </Row>
    </View>
  );
}

// ---- Google said who you are, and no profile is linked yet: a request,
// with a password as well (ask #2) --------------------------------------------
function GoogleSignupForm({admin, signup, onBack, onSent}: {admin: string; signup: GoogleSignup; onBack: () => void; onSent: () => void}) {
  const [name, setName] = useState(suggestedName(signup.name, signup.email));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<FieldHandle>(null);
  const pwRef = useRef<FieldHandle>(null);
  const cfRef = useRef<FieldHandle>(null);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);
  const submit = async () => {
    if (busy) return;
    setFormError('');
    const problems = requestProblems({name, password, confirm, google: true});
    if (hasProblems(problems)) {
      setErrors(problems);
      const first = firstProblem(problems, ['name', 'password', 'confirm']);
      (first === 'name' ? nameRef : first === 'password' ? pwRef : cfRef).current?.focusQuietly();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.signup({name: name.trim(), pollId: signup.pollId, password, note: 'Requested from the TV app (Google)'});
      onSent();
    } catch (e) {
      const rw = refusalWords(e instanceof ApiError ? e : null, 'request', admin);
      if (rw.field === 'name' || rw.field === 'password' || rw.field === 'confirm') {
        setErrors({[rw.field]: rw.words});
        (rw.field === 'name' ? nameRef : rw.field === 'password' ? pwRef : cfRef).current?.focusQuietly();
      } else setFormError(rw.words);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <Title line={WORDS.googleSignupLine}>{WORDS.googleSignupTitle}</Title>
      <View style={as.cols}>
        <View style={as.col}>
          <CodeBlockLike label="Google" value={signup.email} />
          <Field ref={nameRef} qaId="gsignup.name" first={!name} label={WORDS.name} value={name}
            onChangeText={t => {
              setName(t);
              if (errors.name) setErrors(x => ({...x, name: undefined}));
            }}
            error={errors.name} autoCapitalize="words" maxLength={24}
            returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => pwRef.current?.focus()} />
        </View>
        <View style={as.col}>
          <Field ref={pwRef} qaId="gsignup.password" first={!!name} label={WORDS.password} secret value={password}
            onChangeText={t => {
              setPassword(t);
              if (errors.password) setErrors(x => ({...x, password: undefined}));
            }}
            error={errors.password} help={PASSWORD_HELP} below={<Strength pw={password} personal={[name, signup.email]} />}
            textContentType="newPassword" autoComplete="new-password" maxLength={128}
            returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => cfRef.current?.focus()} />
          <Field ref={cfRef} qaId="gsignup.confirm" label={WORDS.confirm} secret value={confirm}
            onChangeText={t => {
              setConfirm(t);
              if (errors.confirm) setErrors(x => ({...x, confirm: undefined}));
            }}
            error={errors.confirm} textContentType="newPassword" autoComplete="new-password" maxLength={128}
            returnKeyType="send" onSubmitEditing={submit} />
        </View>
      </View>
      <FormError text={formError} />
      {/* no Back button here: under the password fields it was the nearest thing
          to a DOWN press (Mi TV), and it threw Google's answer away. The remote's
          Back leaves (to where Google was started from). */}
      <Row gap={14}>
        <MainButton uiId="gsignup.submit" claim={formError} label={WORDS.sendRequest} busyLabel={WORDS.sending} busy={busy} onPress={submit} />
      </Row>
    </View>
  );
}

/** The Google account the request is for: read-only, in the field's shape. */
function CodeBlockLike({label, value}: {label: string; value: string}) {
  return (
    <View style={{marginBottom: 14}}>
      <Text style={{color: A.label, fontSize: 15, fontWeight: '600', marginBottom: 6}}>{label}</Text>
      <Body strong>{value || '—'}</Body>
    </View>
  );
}
