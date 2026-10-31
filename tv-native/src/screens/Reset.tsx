// [auth-round] "Forgot password?" on the TV (ask #4: "make it easy and clear
// to reset it by themselves"). Every way back in without the old password,
// as the server offers them (GET /api/auth/reset/options - the same answer
// for everyone, nothing about any account):
//
//   Use Google       the device-code flow with intent "reset" → {reset:{token,name}}
//   Ask {admin}      identifier → a ticket; this screen asks for its status
//                    every 4 s and carries on BY ITSELF once approved. The
//                    same words whether the account exists or not.
//   I have a code    identifier + the 8-character code {admin} read out
//   Email me a link  only when the server has email switched on
//
// then New password + Confirm + "Sign out of all other devices" (on) →
// POST /api/auth/reset/complete → signed in on this TV.
//
// NOT here, on purpose: "change it without the old one" - the TV is a shared
// device, so that way lives on a signed-in phone or computer only (the server
// refuses it for a TV session anyway). The choice step says so in one line.
//
// Back goes one step back (authFlow.ts resetBack); from the choice it leaves
// to the sign-in view (onExit).
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {BackHandler, View} from 'react-native';
import {api, ApiError, ResetOptions, SigninResult} from '../api';
import {
  adminWord,
  codeProblems,
  FieldErrors,
  hasProblems,
  newPasswordProblems,
  normalizeCode,
  refusalWords,
  RESET_POLL_MS,
  resetBack,
  resetStatusNext,
  ResetStep,
  ResetWay,
  resetWays,
  WORDS,
} from '../authFlow';
import {PASSWORD_HELP} from '../passRules';
import GoogleDevice from './GoogleDevice';
import {AuthShell, Body, Check, Choice, Field, FieldHandle, FormError, MainButton, PlainButton, Row, Strength, Title, Waiting} from './authKit';

/** The reset on its own screen (the profile wall's "Forgot password?"): the
 *  same steps, in the same panel, asking the server who the admin is and
 *  whether Google can be used here. */
export function ResetScreen({onSignedIn, onExit}: {onSignedIn: (r: SigninResult) => void; onExit: () => void}) {
  const [info, setInfo] = useState<{admin: string; googleDevice: boolean}>({admin: 'the admin', googleDevice: false});
  useEffect(() => {
    let live = true;
    api
      .serverInfo()
      .then(i => live && setInfo({admin: adminWord(i.adminName), googleDevice: !!i.googleDevice}))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return (
    <AuthShell width={700}>
      <Reset admin={info.admin} googleDevice={info.googleDevice} onSignedIn={onSignedIn} onExit={onExit} />
    </AuthShell>
  );
}

export default function Reset({
  admin,
  googleDevice,
  identifier: typed = '',
  onSignedIn,
  onExit,
}: {
  admin: string;
  // what was typed on the sign-in screen: the reset's username or email to start with
  identifier?: string;
  // the server has a TV-type Google client (the device flow can run)
  googleDevice: boolean;
  onSignedIn: (r: SigninResult) => void;
  onExit: () => void;
}) {
  const [step, setStep] = useState<ResetStep>('choose');
  const [came, setCame] = useState<ResetStep | null>(null); // the step "I have a reset code" came from
  const [options, setOptions] = useState<ResetOptions | null>(null);
  const [identifier, setIdentifier] = useState(typed);
  const [token, setToken] = useState<{token: string; name: string} | null>(null);
  // which choice row gets focus when the choice comes back
  const [lastWay, setLastWay] = useState<ResetWay | null>(null);
  // the last "Ask {admin}" ticket: what the waiting step asks about
  const ticket = useRef('');

  useEffect(() => {
    let live = true;
    api
      .resetOptions()
      .then(o => live && setOptions(o))
      .catch(() => live && setOptions({google: false, email: false, admin: true}));
    return () => {
      live = false;
    };
  }, []);

  const go = useCallback((to: ResetStep, from?: ResetStep) => {
    setCame(from || null);
    setStep(to);
  }, []);
  const back = useCallback(() => {
    const to = resetBack(step, came);
    if (!to) return onExit();
    if (to === 'choose') setToken(null);
    setCame(null);
    setStep(to);
  }, [step, came, onExit]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      back();
      return true;
    });
    return () => sub.remove();
  }, [back]);

  const ways = resetWays({...(options || {}), google: !!options?.google && googleDevice});
  const codeLen = options?.codeLength || 8;
  const choose = (w: ResetWay) => {
    setLastWay(w);
    go(w === 'google' ? 'google' : w === 'admin' ? 'admin' : w === 'code' ? 'code' : 'email');
  };
  const gotToken = (t: string, name: string) => {
    setToken({token: t, name});
    setCame(null);
    setStep('newPassword');
  };

  if (step === 'choose') {
    const title = (w: ResetWay) =>
      w === 'google' ? WORDS.useGoogle : w === 'admin' ? WORDS.askAdmin(admin) : w === 'code' ? WORDS.haveCode : WORDS.emailLink;
    const line = (w: ResetWay) =>
      w === 'google' ? WORDS.useGoogleLine : w === 'admin' ? WORDS.askAdminLine(admin) : w === 'code' ? WORDS.haveCodeLine(admin) : WORDS.emailLinkLine;
    return (
      <View>
        <Title line={WORDS.forgotLine}>{WORDS.forgotTitle}</Title>
        {!options ? (
          <Waiting text="One moment…" />
        ) : (
          // one column, every option the same height: UP / DOWN walks them in order
          <View style={{gap: 8}}>
            {ways.map((w, i) => (
              <Choice key={w} uiId={`reset.way.${w}`} title={title(w)} line={line(w)} first={lastWay ? lastWay === w : i === 0} onPress={() => choose(w)} />
            ))}
          </View>
        )}
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 18, marginTop: 14}}>
          <PlainButton uiId="reset.back" label={WORDS.back} onPress={onExit} />
          <View style={{flex: 1, minWidth: 0}}>
            <Body>{WORDS.elsewhere}</Body>
          </View>
        </View>
      </View>
    );
  }

  if (step === 'google') {
    return (
      <GoogleDevice
        intent="reset"
        title={WORDS.useGoogle}
        line={WORDS.useGoogleLine}
        onBack={back}
        onOutcome={next => {
          if (next.next === 'reset') gotToken(next.token, next.name);
        }}
      />
    );
  }

  if (step === 'admin') {
    return (
      <AskAdmin
        admin={admin}
        identifier={identifier}
        setIdentifier={setIdentifier}
        onSent={t => {
          ticket.current = t;
          go('adminWait');
        }}
        onBack={back}
      />
    );
  }

  if (step === 'adminWait') {
    return (
      <AdminWait
        admin={admin}
        ticket={ticket.current}
        onApproved={gotToken}
        onCode={() => go('code', 'adminWait')}
        onAgain={() => go('admin')}
        onBack={back}
      />
    );
  }

  if (step === 'code') {
    return <CodeStep admin={admin} codeLen={codeLen} identifier={identifier} setIdentifier={setIdentifier} onToken={gotToken} onBack={back} />;
  }

  if (step === 'email') {
    return <EmailStep identifier={identifier} setIdentifier={setIdentifier} onSent={() => go('emailSent')} onBack={back} admin={admin} />;
  }

  if (step === 'emailSent') {
    return (
      <View>
        <Title line={WORDS.emailSentLine}>{WORDS.emailSentTitle}</Title>
        <Row>
          <MainButton uiId="reset.email.done" label="Back to sign in" first onPress={onExit} />
        </Row>
      </View>
    );
  }

  // newPassword
  return token ? <NewPasswordStep admin={admin} token={token} onSignedIn={onSignedIn} onBack={back} /> : null;
}

function AskAdmin({
  admin,
  identifier,
  setIdentifier,
  onSent,
  onBack,
}: {
  admin: string;
  identifier: string;
  setIdentifier: (s: string) => void;
  onSent: (ticket: string) => void;
  onBack: () => void;
}) {
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<FieldHandle>(null);
  const send = async () => {
    if (busy) return;
    setFormError('');
    if (!identifier.trim()) {
      setError(WORDS.noIdentifier);
      ref.current?.focusQuietly();
      return;
    }
    setBusy(true);
    try {
      const r = await api.resetRequest(identifier.trim());
      onSent(r.ticket);
    } catch (e) {
      const rw = refusalWords(e instanceof ApiError ? e : null, 'resetRequest', admin);
      if (rw.field === 'identifier') {
        setError(rw.words);
        ref.current?.focusQuietly();
      } else setFormError(rw.words);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <Title line={WORDS.askAdminLine(admin)}>{WORDS.askAdmin(admin)}</Title>
      <Field
        ref={ref}
        qaId="reset.admin.identifier"
        first={!identifier}
        label={WORDS.identifier}
        value={identifier}
        onChangeText={t => {
          setIdentifier(t);
          if (error) setError('');
        }}
        error={error}
        keyboardType="email-address"
        textContentType="username"
        autoComplete="username"
        returnKeyType="send"
        onSubmitEditing={send}
      />
      <FormError text={formError} />
      <Row>
        <MainButton uiId="reset.admin.send" claim={formError} label={WORDS.sendRequest} busyLabel={WORDS.sending} busy={busy} first={!!identifier} onPress={send} />
        <PlainButton uiId="reset.admin.back" label={WORDS.back} onPress={onBack} />
      </Row>
    </View>
  );
}

function AdminWait({
  admin,
  ticket,
  onApproved,
  onCode,
  onAgain,
  onBack,
}: {
  admin: string;
  ticket: string;
  onApproved: (token: string, name: string) => void;
  onCode: () => void;
  onAgain: () => void;
  onBack: () => void;
}) {
  const [stopped, setStopped] = useState('');
  const [offline, setOffline] = useState(false);
  const approved = useRef(onApproved);
  approved.current = onApproved;
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!live) return;
      try {
        const s = await api.resetStatus(ticket);
        if (!live) return;
        setOffline(false);
        const n = resetStatusNext(s);
        if (n.next === 'approved') {
          approved.current(n.token, s.name || '');
          return;
        }
        if (n.next === 'stop') {
          setStopped(n.words(admin));
          return;
        }
      } catch (e) {
        if (!live) return;
        if (e instanceof ApiError && e.status === 429) {
          // asked too often: wait the server's time, then keep waiting
          t = setTimeout(tick, Math.max(RESET_POLL_MS, (e.retryAfter || 10) * 1000));
          return;
        }
        if (e instanceof ApiError && e.status !== 0) {
          setStopped(refusalWords(e, 'resetRequest', admin).words);
          return;
        }
        setOffline(true); // no answer: keep asking
      }
      t = setTimeout(tick, RESET_POLL_MS);
    };
    t = setTimeout(tick, RESET_POLL_MS);
    return () => {
      live = false;
      if (t) clearTimeout(t);
    };
  }, [ticket, admin]);
  return (
    <View>
      <Title line={WORDS.askSentLine(admin)}>{WORDS.askSentTitle}</Title>
      {stopped ? <FormError text={stopped} /> : <Waiting text={offline ? WORDS.offline : WORDS.waitingFor(admin)} />}
      <View style={{height: 12}} />
      <Row>
        {stopped ? <MainButton uiId="reset.admin.again" label="Send a new request" first onPress={onAgain} /> : null}
        <PlainButton uiId="reset.admin.code" label={WORDS.haveCode} first={!stopped} onPress={onCode} />
        <PlainButton uiId="reset.admin.waitback" label={WORDS.back} onPress={onBack} />
      </Row>
    </View>
  );
}

function CodeStep({
  admin,
  codeLen,
  identifier,
  setIdentifier,
  onToken,
  onBack,
}: {
  admin: string;
  codeLen: number;
  identifier: string;
  setIdentifier: (s: string) => void;
  onToken: (token: string, name: string) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const idRef = useRef<FieldHandle>(null);
  const codeRef = useRef<FieldHandle>(null);
  const send = async () => {
    if (busy) return;
    setFormError('');
    const p = codeProblems(identifier, code);
    if (hasProblems(p)) {
      setErrors(p);
      (p.identifier ? idRef : codeRef).current?.focusQuietly();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const r = await api.resetWithCode(identifier.trim(), normalizeCode(code));
      onToken(r.token, r.name || '');
    } catch (e) {
      const rw = refusalWords(e instanceof ApiError ? e : null, 'resetCode', admin);
      if (rw.field === 'identifier' || rw.field === 'code') {
        setErrors({[rw.field]: rw.words});
        (rw.field === 'identifier' ? idRef : codeRef).current?.focusQuietly();
      } else setFormError(rw.words);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <Title line={`Enter the code ${admin} gave you, and your username or email.`}>{WORDS.haveCode}</Title>
      <Field
        ref={idRef}
        qaId="reset.code.identifier"
        first={!identifier}
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
        onSubmitEditing={() => codeRef.current?.focus()}
      />
      <Field
        ref={codeRef}
        qaId="reset.code.code"
        first={!!identifier}
        label={WORDS.codeLabel}
        value={code}
        onChangeText={t => {
          setCode(t.toUpperCase());
          if (errors.code) setErrors(x => ({...x, code: undefined}));
        }}
        error={errors.code}
        help={WORDS.codeHelp(codeLen)}
        autoCapitalize="characters"
        keyboardType="visible-password"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={codeLen + 4}
        returnKeyType="go"
        onSubmitEditing={send}
        style={{letterSpacing: 3, fontWeight: '700'}}
      />
      <FormError text={formError} />
      <Row>
        <MainButton uiId="reset.code.send" claim={formError} label={WORDS.continue} busyLabel={WORDS.checking} busy={busy} onPress={send} />
        <PlainButton uiId="reset.code.back" label={WORDS.back} onPress={onBack} />
      </Row>
    </View>
  );
}

function EmailStep({
  admin,
  identifier,
  setIdentifier,
  onSent,
  onBack,
}: {
  admin: string;
  identifier: string;
  setIdentifier: (s: string) => void;
  onSent: () => void;
  onBack: () => void;
}) {
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<FieldHandle>(null);
  const send = async () => {
    if (busy) return;
    setFormError('');
    if (!identifier.trim()) {
      setError(WORDS.noIdentifier);
      ref.current?.focusQuietly();
      return;
    }
    setBusy(true);
    try {
      await api.resetEmail(identifier.trim());
      onSent();
    } catch (e) {
      setFormError(refusalWords(e instanceof ApiError ? e : null, 'resetRequest', admin).words);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <Title line={WORDS.emailLinkLine}>{WORDS.emailLink}</Title>
      <Field
        ref={ref}
        qaId="reset.email.identifier"
        first={!identifier}
        label={WORDS.identifier}
        value={identifier}
        onChangeText={t => {
          setIdentifier(t);
          if (error) setError('');
        }}
        error={error}
        keyboardType="email-address"
        returnKeyType="send"
        onSubmitEditing={send}
      />
      <FormError text={formError} />
      <Row>
        <MainButton uiId="reset.email.send" claim={formError} label="Send link" busyLabel={WORDS.sending} busy={busy} first={!!identifier} onPress={send} />
        <PlainButton uiId="reset.email.back" label={WORDS.back} onPress={onBack} />
      </Row>
    </View>
  );
}

function NewPasswordStep({
  admin,
  token,
  onSignedIn,
  onBack,
}: {
  admin: string;
  token: {token: string; name: string};
  onSignedIn: (r: SigninResult) => void;
  onBack: () => void;
}) {
  const [fresh, setFresh] = useState('');
  const [again, setAgain] = useState('');
  const [others, setOthers] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(false); // the token is gone: only Back is left
  const freshRef = useRef<FieldHandle>(null);
  const againRef = useRef<FieldHandle>(null);
  const save = async () => {
    if (busy || spent) return;
    setFormError('');
    const p = newPasswordProblems({fresh, again});
    if (hasProblems(p)) {
      setErrors(p);
      (p.newPassword ? freshRef : againRef).current?.focusQuietly();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const r = await api.resetComplete(token.token, fresh, others);
      onSignedIn(r);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      const rw = refusalWords(err, 'resetComplete', admin);
      if (rw.field === 'newPassword' || rw.field === 'confirm') {
        setErrors({[rw.field]: rw.words});
        (rw.field === 'newPassword' ? freshRef : againRef).current?.focusQuietly();
      } else {
        setFormError(rw.words);
        if (err && (err.status === 410 || err.code === 'expired' || err.code === 'used')) setSpent(true);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <Title line={token.name ? `For ${token.name}. You'll be signed in on this TV once it's saved.` : "You'll be signed in on this TV once it's saved."}>
        {WORDS.forcedTitle}
      </Title>
      <Field
        ref={freshRef}
        qaId="reset.new.password"
        first
        label={WORDS.newPassword}
        secret
        value={fresh}
        onChangeText={t => {
          setFresh(t);
          if (errors.newPassword) setErrors(x => ({...x, newPassword: undefined}));
        }}
        error={errors.newPassword}
        help={PASSWORD_HELP}
        aside={<Strength pw={fresh} personal={[token.name]} />}
        textContentType="newPassword"
        autoComplete="new-password"
        maxLength={128}
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => againRef.current?.focus()}
      />
      <Field
        ref={againRef}
        qaId="reset.new.confirm"
        label={WORDS.confirm}
        secret
        value={again}
        onChangeText={t => {
          setAgain(t);
          if (errors.confirm) setErrors(x => ({...x, confirm: undefined}));
        }}
        error={errors.confirm}
        textContentType="newPassword"
        autoComplete="new-password"
        maxLength={128}
        returnKeyType="go"
        onSubmitEditing={save}
      />
      <Check uiId="reset.new.others" label={WORDS.signOutOthers} value={others} onChange={setOthers} />
      <View style={{height: 10}} />
      <FormError text={formError} />
      <Row>
        {spent ? (
          <MainButton uiId="reset.new.restart" label="Start again" first onPress={onBack} />
        ) : (
          <MainButton uiId="reset.new.save" claim={formError} label={WORDS.saveAndSignIn} busyLabel={WORDS.saving} busy={busy} onPress={save} />
        )}
        <PlainButton uiId="reset.new.back" label={WORDS.back} onPress={onBack} />
      </Row>
    </View>
  );
}

