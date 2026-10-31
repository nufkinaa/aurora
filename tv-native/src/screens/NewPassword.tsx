// A password before going on - the forced reset, and [auth-round] a
// Google-only profile's first password, on the TV.
//
// THE CONTRACT (server src/lib/resetgate.js - enforced there): the admin's
// People → Reset password ends every session and unlock token of the
// profile. The current password still signs in, and every sign-in answer
// (/api/auth/login, device/poll, google/poll, /api/profiles/:id/unlock) says
// `mustReset` - but what it hands out is a RESTRICTED credential: everything
// made with it is refused with
//     401 {signinRequired, passwordResetRequired, profileId}
// except GET /api/ping, /api/me, /api/server-info and POST /api/auth/logout,
// /api/auth/password, /api/profiles/<that id>/password. /api/me answers
// `user: null, passwordResetRequired, resetProfile {id, name, …}`.
//
// TWO SCREENS IN ONE (newPassword.ts newPasswordMode, from /api/me):
//   - "Choose a new password" - {admin} asked for one. The current password is
//     needed to save; after a typed sign-in or an unlock the TV holds it
//     (`current`), otherwise it asks. Saved with POST /api/profiles/:id/password.
//   - "Set a password" (`passwordSetup`) - the profile signs in with Google
//     only and has none yet (elia's ask #2: no profile without a password).
//     Nothing to ask; saved with POST /api/auth/password {newPassword}, which
//     the server allows right after a fresh sign-in on this TV.
// Either save's answer carries this TV's fresh credentials (`token`, and
// `session` when the profile signs in): they are handed up and the app goes on.
//
// IT BLOCKS (owner, 2026-10-10: "it should really force a new password"):
// the only ways off this screen are a saved password or signing out of this
// TV. Back does nothing; closing the app does not help either - AppRoot brings
// the screen back at the next launch, and whenever a request is refused with
// {passwordResetRequired:true}.
//
// ONLY THE ALLOWED ROUTES ARE CALLED FROM HERE: anything else would be
// refused. The name shown comes from /api/me (`resetProfile`).
import React, {useEffect, useRef, useState} from 'react';
import {BackHandler, View} from 'react-native';
import {api, ApiError} from '../api';
import {adminWord, FieldErrors, hasProblems, newPasswordProblems, WORDS} from '../authFlow';
import {newPasswordMode, saveRefusal} from '../newPassword';
import {PASSWORD_HELP} from '../passRules';
import {AuthShell, Field, FieldHandle, FormError, MainButton, PlainButton, Row, Strength, Title, Waiting} from './authKit';

type Me = {passwordSetup?: boolean; resetProfile?: {id: string; name: string} | null};

export default function NewPassword({
  profileId,
  current,
  onDone,
  onSignOut,
}: {
  profileId: string;
  // The password that was just typed to get in; null when the TV never saw
  // one (QR pairing, Google) and has to ask - or, for a Google-only profile,
  // there is none.
  current: string | null;
  // The profile's fresh unlock token (null when none could be had - the app
  // carries on with the session), and a new session if the save minted one.
  onDone: (token: string | null, session: string | null) => void;
  onSignOut: () => void;
}) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [admin, setAdmin] = useState('the admin');
  const [cur, setCur] = useState('');
  const [fresh, setFresh] = useState('');
  const [again, setAgain] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const curRef = useRef<FieldHandle>(null);
  const freshRef = useRef<FieldHandle>(null);
  const againRef = useRef<FieldHandle>(null);
  const {mode, askCurrent} = newPasswordMode(current, me);
  const name = me?.resetProfile && me.resetProfile.id === profileId ? me.resetProfile.name : '';

  // Back is not a way out of this screen.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    let live = true;
    api
      .serverInfo()
      .then(i => live && setAdmin(adminWord(i.adminName)))
      .catch(() => {});
    api
      .me()
      .then(r => live && setMe(r as Me))
      .catch(() => live && setMe(null));
    return () => {
      live = false;
    };
  }, [profileId]);

  const save = async () => {
    if (busy || mode === 'loading') return;
    setFormError('');
    const p = newPasswordProblems({fresh, again, askCurrent, current: cur});
    if (hasProblems(p)) {
      setErrors(p);
      (p.current ? curRef : p.newPassword ? freshRef : againRef).current?.focusQuietly();
      return;
    }
    setErrors({});
    setBusy(true);
    let token: string | null = null;
    let session: string | null = null;
    try {
      if (mode === 'setup') {
        const saved = await api.changePassword(fresh);
        token = saved?.token || null;
        session = saved?.session || null;
      } else {
        const saved = await api.setPassword(profileId, fresh, askCurrent ? cur : (current as string));
        token = saved?.token || null;
        session = saved?.session || null;
      }
    } catch (e) {
      setBusy(false);
      const rw = saveRefusal(e instanceof ApiError ? e : null, admin);
      const field = rw.field === 'current' && !askCurrent ? null : rw.field;
      if (field === 'current' || field === 'newPassword' || field === 'confirm') {
        setErrors({[field]: rw.words});
        (field === 'current' ? curRef : field === 'newPassword' ? freshRef : againRef).current?.focusQuietly();
      } else setFormError(rw.words);
      return;
    }
    // Saved. The answer carried this TV's fresh credentials; what follows is
    // only for a save that came back without them (the server no longer owed
    // one): every unlock of the profile just ended, this TV's with it.
    if (!token) {
      try {
        const r = await api.unlock(profileId, fresh);
        token = r.token || null;
        session = session || r.session || null;
      } catch {}
    }
    if (!token) {
      try {
        token = (await api.profileTokenFromSession()).token || null;
      } catch {}
    }
    onDone(token, session);
  };

  const title = mode === 'setup' ? WORDS.setTitle : WORDS.forcedTitle;
  const line =
    mode === 'setup'
      ? WORDS.setLine
      : `${name ? `For ${name}. ` : ''}${WORDS.forcedLine(admin)}`;
  return (
    <AuthShell width={640}>
      {mode === 'loading' ? (
        <Waiting text="One moment…" />
      ) : (
        <View>
          <Title line={line}>{title}</Title>
          {askCurrent ? (
            <Field
              ref={curRef}
              qaId="newpassword.current"
              first
              label="Current password"
              secret
              value={cur}
              onChangeText={t => {
                setCur(t);
                if (errors.current) setErrors(x => ({...x, current: undefined}));
              }}
              error={errors.current}
              textContentType="password"
              autoComplete="current-password"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => freshRef.current?.focus()}
            />
          ) : null}
          <Field
            ref={freshRef}
            qaId="newpassword.new"
            first={!askCurrent}
            // a first password is "Password"; replacing one is "New password" (as on the website and phone)
            label={mode === 'setup' ? WORDS.password : WORDS.newPassword}
            secret
            value={fresh}
            onChangeText={t => {
              setFresh(t);
              if (errors.newPassword) setErrors(x => ({...x, newPassword: undefined}));
            }}
            error={errors.newPassword}
            help={PASSWORD_HELP}
            aside={<Strength pw={fresh} personal={[name]} />}
            textContentType="newPassword"
            autoComplete="new-password"
            maxLength={128}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => againRef.current?.focus()}
          />
          <Field
            ref={againRef}
            qaId="newpassword.confirm"
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
          <FormError text={formError} />
          <Row>
            <MainButton uiId="newpassword.submit" claim={formError} label={WORDS.setBtn} busyLabel={WORDS.saving} busy={busy} onPress={save} />
            <PlainButton uiId="newpassword.signout" label="Sign out" onPress={() => !busy && onSignOut()} />
          </Row>
        </View>
      )}
    </AuthShell>
  );
}
