// The blocking password step on the phone (AppRoot's "reset" stage), in the sign-in
// panel's look (phone/auth/ui.tsx). Two cases, as the server says (docs/auth-round.md):
//
//   Set a password       the profile signs in with Google only and has no password yet
//                        (the login shape's / /api/me's passwordSetup): saved with
//                        POST /api/auth/password {newPassword} — there is no current one.
//   Choose a new password the admin asked for one (mustReset). Saved as before with the
//                        password just typed at sign-in; when the phone never saw one
//                        (Google, a code) and the server lets this device change it
//                        without the old one (password/options), without it.
//
// THIS ONE BLOCKS, as on the TV: Back does nothing; the ways off are a saved password or
// signing out. Whatever comes back (a fresh token / session) is handed up, as before.
import React, {useEffect, useRef, useState} from 'react';
import {BackHandler, TextInput} from 'react-native';
import {api, ApiError} from '../../api';
import {PASSWORD_HELP} from '../../passRules';
import {isPasswordSetup} from '../auth/state';
import {adminName, hasProblems, newPasswordProblems, Problems, refusalProblem, W} from '../auth/rules';
import {AuthField, AuthShell, Foot, FormError, MainButton, Strength, TextLink, Title} from '../auth/ui';

export default function NewPassword({
  profileId,
  current,
  onDone,
  onSignOut,
}: {
  profileId: string;
  current: string | null;
  onDone: (token: string | null, session: string | null) => void;
  onSignOut: () => void;
}) {
  const [setup, setSetup] = useState(isPasswordSetup(profileId));
  // the old password is asked for only when the phone has none and the server wants one
  const [needsCurrent, setNeedsCurrent] = useState(typeof current !== 'string' && !isPasswordSetup(profileId));
  const [cur, setCur] = useState('');
  const [fresh, setFresh] = useState('');
  const [again, setAgain] = useState('');
  const [errs, setErrs] = useState<Problems>({});
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<{name: string; admin: string}>({name: '', admin: adminName(null)});
  const curRef = useRef<TextInput>(null);
  const freshRef = useRef<TextInput>(null);
  const againRef = useRef<TextInput>(null);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);
  useEffect(() => {
    let live = true;
    api
      .serverInfo()
      .then(i => live && i.adminName && setWho(w => ({...w, admin: adminName(i.adminName)})))
      .catch(() => {});
    api
      .me()
      .then(me => {
        if (!live) return;
        const rp = me.resetProfile;
        if (rp && rp.id === profileId && rp.name) setWho(w => ({...w, name: rp.name}));
        if ((me as {passwordSetup?: boolean}).passwordSetup) {
          setSetup(true);
          setNeedsCurrent(false);
        }
      })
      .catch(() => {});
    if (typeof current !== 'string') {
      api
        .passwordOptions()
        .then(o => live && o && o.needsCurrent === false && setNeedsCurrent(false))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [profileId, current]);

  const askCurrent = needsCurrent && !setup;
  const save = async () => {
    if (busy) return;
    const p = newPasswordProblems({fresh, confirm: again, current: cur, askCurrent});
    setErrs(p);
    if (hasProblems(p)) return (p.current ? curRef : p.newPassword ? freshRef : againRef).current?.focus();
    setBusy(true);
    let token: string | null = null;
    let session: string | null = null;
    try {
      if (setup || (!askCurrent && typeof current !== 'string')) {
        const r = await api.changePassword(fresh);
        token = r?.token || null;
        session = r?.session || null;
      } else {
        const r = await api.setPassword(profileId, fresh, askCurrent ? cur : (current as string));
        token = r?.token || null;
        session = r?.session || null;
      }
    } catch (e) {
      setBusy(false);
      const pr = refusalProblem(e, {wrongField: 'current', fieldMap: {password: 'newPassword'}});
      if (e instanceof ApiError && e.status === 401 && !askCurrent) setNeedsCurrent(true);
      setErrs(pr.field === 'current' || pr.field === 'newPassword' || pr.field === 'confirm' ? {[pr.field]: pr.text} : {form: pr.text});
      return;
    }
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

  const clear = (k: keyof Problems) => () => (errs[k] || errs.form) && setErrs(e => ({...e, [k]: undefined, form: undefined}));
  return (
    <AuthShell>
      {setup ? (
        <Title line={W.setLine}>{W.setTitle}</Title>
      ) : (
        <Title line={W.forcedLine(who.admin)}>{W.forcedTitle}</Title>
      )}
      {askCurrent ? (
        <AuthField
          ref={curRef}
          label={W.currentPassword}
          secret
          value={cur}
          onChangeText={t => {
            setCur(t);
            clear('current')();
          }}
          error={errs.current}
          autoFocus
          autoComplete="current-password"
          textContentType="password"
          importantForAutofill="yes"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => freshRef.current?.focus()}
        />
      ) : null}
      <AuthField
        ref={freshRef}
        label={W.newPassword}
        help={PASSWORD_HELP}
        secret
        value={fresh}
        onChangeText={t => {
          setFresh(t);
          clear('newPassword')();
        }}
        error={errs.newPassword}
        below={<Strength pw={fresh} personal={[who.name]} />}
        autoFocus={!askCurrent}
        autoComplete="new-password"
        textContentType="newPassword"
        importantForAutofill="yes"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => againRef.current?.focus()}
      />
      <AuthField
        ref={againRef}
        label={W.confirm}
        secret
        value={again}
        onChangeText={t => {
          setAgain(t);
          clear('confirm')();
        }}
        error={errs.confirm}
        autoComplete="new-password"
        textContentType="newPassword"
        importantForAutofill="yes"
        returnKeyType="go"
        onSubmitEditing={save}
      />
      <FormError text={errs.form} />
      <MainButton uiId="newpassword.submit" label={setup ? W.setSave : W.saveContinue} busyLabel={W.saving} busy={busy} onPress={save} />
      <Foot>
        <TextLink uiId="newpassword.signout" label={W.signOut} onPress={onSignOut} />
      </Foot>
    </AuthShell>
  );
}
