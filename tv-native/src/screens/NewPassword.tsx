// "Pick a new password" — the forced reset, on the TV.
//
// The admin's People → Reset password marks a profile `mustReset`; the server
// then says so in the answer of every sign-in (/api/auth/login, device/poll,
// google/poll) and of /api/profiles/:id/unlock. The flag is a note to the
// client — the session and the unlock token work in full — and the website
// answers it with a sheet (public/js/screens/profiles.js newPasswordPrompt).
// The TV never asked: a person whose password the admin had reset went on
// with the old one for ever (audit A16). Same rule here as on the site:
//   - the new password, twice, at least four characters;
//   - the current one is needed to save. After a typed sign-in or an unlock
//     the TV already holds it (`current`); after QR pairing or Google it does
//     not, and asks;
//   - saving ends EVERY unlock token of the profile, this TV's too, so it
//     unlocks again with the new password (or, signed in, asks the session for
//     a token) and hands the fresh one up.
//
// IT BLOCKS (owner, 2026-10-10: "it should really force a new password"):
// the only ways off this screen are a saved new password or signing out of
// this TV. Back does nothing; closing the app does not help either — App.tsx
// brings the screen back at the next launch, and whenever the server refuses
// a request with {passwordResetRequired:true}.
//
// WRITTEN AGAINST TWO SERVERS. Today's (1.6.86) only notes `mustReset` and
// keeps the session fully working. The coming one holds a must-reset
// credential back (403 {passwordResetRequired:true} on everything but the
// password route, /api/me and sign-out) and may return the fresh credentials
// in the password route's own answer. So: nothing this screen needs besides
// the save itself is allowed to fail it (the names it shows are a courtesy),
// the answer's `token` / `profileToken` / `session` are used when present,
// and otherwise the TV unlocks again with the new password, or asks its
// session for a token.
import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, BackHandler, StyleSheet, Text, TextInput, View} from 'react-native';
import Focusable from '../components/Focusable';
import {api, ApiError} from '../api';
import {useFocusFallback} from '../focus';
import {MIN_PASSWORD, newPasswordProblem} from '../newPassword';
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
      .profiles()
      .then(list => {
        const me = list.find(p => p.id === profileId);
        if (live && me) setWho(w => ({...w, name: me.name}));
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
      token = saved?.token || saved?.profileToken || null;
      session = saved?.session || null;
    } catch (e) {
      setBusy(false);
      const msg = e instanceof ApiError ? e.message : '';
      setError(msg === 'wrong password' ? 'That is not the current password.' : msg || "Couldn't save it. Try again.");
      return;
    }
    // Saved — and every unlock of this profile just ended, this TV's with it
    // (unless the answer itself carried the fresh ones).
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
