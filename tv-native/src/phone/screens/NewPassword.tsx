// "Pick a new password" — the forced reset, on the phone. THIS ONE BLOCKS, as
// on the TV (screens/NewPassword.tsx, whose rules these are: newPassword.ts
// says what is wrong with a choice, the server's refusals are read the same
// way): Back does nothing; the ways off are a saved password or signing out.
import React, {useEffect, useRef, useState} from 'react';
import {BackHandler, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {api, ApiError} from '../../api';
import {MIN_PASSWORD, newPasswordProblem, saveRefusal} from '../../newPassword';
import Field from '../ui/Field';
import {GlassButton, PrimaryButton} from '../ui/Buttons';
import Sky from '../ui/Sky';
import {colors, GUTTER} from '../theme';

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
  const insets = useSafeAreaInsets();
  const askCurrent = typeof current !== 'string';
  const [cur, setCur] = useState('');
  const [fresh, setFresh] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<{name: string; admin: string}>({name: 'this profile', admin: 'The admin'});
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
      .then(i => live && i.adminName && setWho(w => ({...w, admin: i.adminName as string})))
      .catch(() => {});
    api
      .me()
      .then(me => {
        const rp = me.resetProfile;
        if (live && rp && rp.id === profileId && rp.name) setWho(w => ({...w, name: rp.name}));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [profileId]);

  const save = async () => {
    if (busy) return;
    const problem = newPasswordProblem({askCurrent, current: cur, fresh, again});
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    let token: string | null = null;
    let session: string | null = null;
    try {
      const saved = await api.setPassword(profileId, fresh, askCurrent ? cur : (current as string));
      token = saved?.token || null;
      session = saved?.session || null;
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiError ? saveRefusal(e.status, e.code, e.message) : "Couldn't save it. Try again.");
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

  return (
    <KeyboardAvoidingView behavior="height" style={s.root}>
      <Sky dim />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[s.body, {paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24}]}>
        <Text style={s.kicker}>NEW PASSWORD</Text>
        <Text style={s.heading}>Pick a new password</Text>
        <Text style={s.sub}>{`${who.admin} asked you to choose a new password for “${who.name}” before going on. It is your sign-in password too.`}</Text>
        {askCurrent ? (
          <Field
            value={cur}
            onChangeText={setCur}
            autoFocus
            secureTextEntry
            placeholder="Current password"
            returnKeyType="next"
            onSubmitEditing={() => freshRef.current?.focus()}
            style={s.field}
          />
        ) : null}
        <Field
          ref={freshRef}
          value={fresh}
          onChangeText={setFresh}
          autoFocus={!askCurrent}
          secureTextEntry
          placeholder={`New password (at least ${MIN_PASSWORD})`}
          autoComplete="new-password"
          returnKeyType="next"
          onSubmitEditing={() => againRef.current?.focus()}
          style={s.field}
        />
        <Field ref={againRef} value={again} onChangeText={setAgain} secureTextEntry placeholder="The same again" returnKeyType="go" onSubmitEditing={save} style={s.field} />
        {error ? <Text style={s.error}>{error}</Text> : null}
        <PrimaryButton label="Save and go on" onPress={save} busy={busy} style={s.primary} />
        <GlassButton label="Sign out" icon="logout" onPress={onSignOut} style={s.secondary} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  body: {flexGrow: 1, paddingHorizontal: GUTTER + 8, maxWidth: 520, width: '100%', alignSelf: 'center'},
  kicker: {color: colors.accent, fontSize: 13, fontWeight: '900', letterSpacing: 1.5},
  heading: {color: colors.text, fontSize: 28, fontWeight: '800', marginTop: 6},
  sub: {color: colors.textDim, fontSize: 16, lineHeight: 22, marginTop: 8, marginBottom: 8},
  field: {marginTop: 12},
  error: {color: '#ffb3b3', fontSize: 15, marginTop: 12},
  primary: {marginTop: 20},
  secondary: {marginTop: 12},
});
