// "Pick a new password" — the forced reset, on the TV.
//
// THE CONTRACT (server 1.6.91, src/lib/resetgate.js — enforced there):
// the admin's People → Reset password ends every session and unlock token of
// the profile. The current password still signs in, and every sign-in answer
// (/api/auth/login, device/poll, google/poll, /api/profiles/:id/unlock) says
// `mustReset` — but what it hands out is a RESTRICTED credential: everything
// made with it is refused with
//     401 {signinRequired, passwordResetRequired, profileId}
// except GET /api/ping, /api/me, /api/server-info and POST /api/auth/logout,
// /api/auth/password, /api/profiles/<that id>/password. /api/me answers
// `user: null, passwordResetRequired, resetProfile {id, name, …}`; the socket
// says {type: "password_reset_required", profileId}.
//   - the new password, twice, at least four characters;
//   - the current one is needed to save. After a typed sign-in or an unlock
//     the TV already holds it (`current`); after QR pairing or Google, or
//     when the screen came up on a relaunch or a refusal, it asks;
//   - the save's own answer carries this TV's fresh credentials (`token`,
//     and `session` when the profile signs in): they are stored and the app
//     goes on — its socket opens again with them (SessionWiring).
//   - refused: 401 wrong current password, 400 `code: "same" | "needed"`, 429.
//
// IT BLOCKS (owner, 2026-10-10: "it should really force a new password"):
// the only ways off this screen are a saved new password or signing out of
// this TV. Back does nothing; closing the app does not help either — App.tsx
// brings the screen back at the next launch (the server says so), and
// whenever a request is refused with {passwordResetRequired:true}.
//
// ONLY THE ALLOWED ROUTES ARE CALLED FROM HERE: anything else would be
// refused. The name shown comes from /api/me (`resetProfile`), never from
// the profile list.
import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, BackHandler, StyleSheet, Text, TextInput, View} from 'react-native';
import Focusable from '../components/Focusable';
import {api, ApiError} from '../api';
import {useFocusFallback} from '../focus';
import {MIN_PASSWORD, newPasswordProblem, saveRefusal} from '../newPassword';
import theme from '../theme';

const {colors, radius, fontSize, spacing} = theme;

export default function NewPassword({
  profileId,
  current,
  onDone,
  onSignOut,
}: {
  profileId: string;
  // The password that was just typed to get in; null when the TV never saw
  // one (QR pairing, Google) and has to ask.
  current: string | null;
  // The profile's fresh unlock token (null when none could be had — the app
  // carries on with the session), and a new session if the unlock minted one.
  onDone: (token: string | null, session: string | null) => void;
  onSignOut: () => void;
}) {
  const askCurrent = typeof current !== 'string';
  const [cur, setCur] = useState('');
  const [fresh, setFresh] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<{name: string; admin: string}>({name: 'this profile', admin: 'The admin'});
  const freshRef = useRef<TextInput>(null);
  const againRef = useRef<TextInput>(null);
  const anchor = useRef(null);
  useFocusFallback(anchor);
  // Back is not a way out of this screen.
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
    // Saved. A forced reset's answer carried this TV's fresh credentials;
    // what follows is only for a save that was not forced (the server no
    // longer owed one): every unlock of the profile just ended, this TV's
    // with it.
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
    <View style={styles.root}>
      <Text style={styles.kicker}>NEW PASSWORD</Text>
      <Text style={styles.heading}>Pick a new password</Text>
      <Text style={styles.sub}>{`${who.admin} asked you to choose a new password for “${who.name}” before going on. It is your sign-in password too.`}</Text>
      {askCurrent ? (
        <TextInput
          style={styles.input}
          value={cur}
          onChangeText={setCur}
          autoFocus
          secureTextEntry
          placeholder="Current password"
          placeholderTextColor={colors.textFaint}
          onSubmitEditing={() => freshRef.current?.focus()}
        />
      ) : null}
      <TextInput
        ref={freshRef}
        style={styles.input}
        value={fresh}
        onChangeText={setFresh}
        autoFocus={!askCurrent}
        secureTextEntry
        placeholder={`New password (${MIN_PASSWORD}+ characters)`}
        placeholderTextColor={colors.textFaint}
        onSubmitEditing={() => againRef.current?.focus()}
      />
      <TextInput
        ref={againRef}
        style={styles.input}
        value={again}
        onChangeText={setAgain}
        secureTextEntry
        placeholder="Once more"
        placeholderTextColor={colors.textFaint}
        onSubmitEditing={save}
      />
      <View style={styles.row}>
        <Focusable uiId="newpassword.submit" round ref={anchor} onPress={save} style={styles.btnPrimary}>
          {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.btnPrimaryText}>Set new password</Text>}
        </Focusable>
        <Focusable uiId="newpassword.signout" round onPress={() => !busy && onSignOut()} style={styles.btnGhost}>
          <Text style={styles.btnGhostText}>Sign out</Text>
        </Focusable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

// (SignIn.tsx's own figures: the two screens are one flow)
const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.pageX + 24, justifyContent: 'center'},
  kicker: {color: colors.accent, fontSize: fontSize.small, fontWeight: '800', letterSpacing: 3},
  heading: {color: colors.text, fontSize: fontSize.hero, fontWeight: '900', marginTop: 4},
  sub: {color: colors.textDim, fontSize: fontSize.body, marginTop: 6, maxWidth: 620},
  row: {flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl},
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.m,
    color: colors.text,
    fontSize: fontSize.row,
    paddingVertical: 14,
    paddingHorizontal: 22,
    maxWidth: 520,
    marginTop: spacing.md,
  },
  btnPrimary: {backgroundColor: colors.white, paddingVertical: 13, paddingHorizontal: 34, minWidth: 150, alignItems: 'center'},
  btnPrimaryText: {color: colors.bg, fontSize: fontSize.body, fontWeight: '800'},
  btnGhost: {backgroundColor: colors.surface, paddingVertical: 13, paddingHorizontal: 24, alignItems: 'center'},
  btnGhostText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  error: {color: '#ff8080', fontSize: fontSize.body, marginTop: spacing.md, maxWidth: 560},
});
