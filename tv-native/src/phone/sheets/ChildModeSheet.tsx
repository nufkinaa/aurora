// Children mode on the phone (2026-11-11, docs/children-mode.md) — the
// website's sheet (public/js/childmode.js) as a bottom sheet, in the same
// words (childMode.ts WORDS). Opened from More, the profile menu and Settings.
//
//   off → Who is watching? All ages · 7+ · 12+ · 16+, and Turn on; the first
//         time ever the passcode is chosen too (twice), then never again.
//   on  → a younger age is one tap; an older one, or leaving, the passcode.
//         "Forgot the passcode?": the account's own password turns it off.
//         (Google is the website's — the phone's Google tab hands its answer
//         to the sign-in door, not to this sheet.)
import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, StyleSheet, Text, TextInput, View} from 'react-native';
import {api, ApiError, ChildModeView, Profile} from '../../api';
import {useApp} from '../../AppContext';
import {AGES, ageWords, childModeChanged, keepsLine, limitOf, validCode, WORDS} from '../../childMode';
import Sheet from '../ui/Sheet';
import Field from '../ui/Field';
import Tap from '../ui/Tap';
import {ChipButton, GlassButton, PrimaryButton} from '../ui/Buttons';
import {colors, GUTTER} from '../theme';

export default function ChildModeSheet({onClose}: {onClose: () => void}) {
  const {profileId} = useApp();
  const [view, setView] = useState<ChildModeView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [pick, setPick] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [again, setAgain] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const againRef = useRef<TextInput>(null);

  useEffect(() => {
    let live = true;
    api
      .childMode(profileId)
      .then(v => {
        if (!live) return;
        setView(v);
        setPick(v.on ? v.maxAge : null);
      })
      .catch(e => live && setLoadError(e instanceof ApiError ? e.message : 'Could not reach the server'));
    return () => {
      live = false;
    };
  }, [profileId]);

  // AppRoot follows (the lock, Home again, the toast); the sheet goes first
  const done = (profile: Profile, note?: string) => {
    onClose();
    childModeChanged({profileId, kids: limitOf(profile), note});
  };
  const fail = (e: unknown) => {
    setError(e instanceof ApiError ? e.message : 'Could not reach the server');
    setCode('');
    setAgain('');
  };
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const cur = view && view.on ? view.maxAge : null;
  const chips = (onPick: (a: number) => void) => (
    <View style={s.chips} accessibilityRole="radiogroup" accessibilityLabel={WORDS.who}>
      {AGES.map(a => (
        <ChipButton key={a} uiId="child.age" label={ageWords(a)} active={pick === a} onPress={() => onPick(a)} style={s.chip} />
      ))}
    </View>
  );

  let body: React.ReactNode;
  let title = WORDS.title;
  let sub: string | undefined;
  if (loadError || !view) {
    body = loadError ? <Text style={s.err}>{loadError}</Text> : <ActivityIndicator color={colors.text} style={{marginVertical: 24}} />;
  } else if (forgot) {
    title = WORDS.forgot;
    const can = !!(view.forgot && view.forgot.password);
    sub = can ? WORDS.forgotNote : WORDS.forgotNone('the admin');
    body = (
      <>
        {can ? (
          <Field
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoFocus
            placeholder={WORDS.password}
            returnKeyType="go"
            onSubmitEditing={() => run(async () => done((await api.childModeForgot(profileId, {password})).profile, 'You choose a new passcode next time.'))}
          />
        ) : null}
        {error ? <Text style={s.err}>{error}</Text> : null}
        <View style={s.row}>
          {can ? (
            <PrimaryButton
              uiId="child.forgot"
              label={WORDS.turnOff}
              busy={busy}
              disabled={!password}
              onPress={() => run(async () => done((await api.childModeForgot(profileId, {password})).profile, 'You choose a new passcode next time.'))}
              style={{flex: 1}}
            />
          ) : null}
          <GlassButton label="Back" onPress={() => (setForgot(false), setError(''))} />
        </View>
      </>
    );
  } else if (cur === null) {
    // ---- off: turn it on ----
    const first = !view.passcodeSet;
    sub = WORDS.intro;
    const turnOn = () =>
      run(async () => {
        if (pick === null) return;
        const b: {maxAge: number; newPasscode?: string} = {maxAge: pick};
        if (first) {
          if (!validCode(code)) throw new ApiError(400, WORDS.digits);
          if (again !== code) throw new ApiError(400, WORDS.mismatch);
          b.newPasscode = code;
        }
        done((await api.childModeOn(profileId, b)).profile);
      });
    body = (
      <>
        <Text style={s.label}>{WORDS.who}</Text>
        {chips(a => (setPick(a), setError('')))}
        <Text style={s.note}>{pick === null ? WORDS.pick : keepsLine(pick)}</Text>
        {first ? (
          <>
            <Text style={s.label}>{WORDS.choose}</Text>
            <Field
              value={code}
              onChangeText={t => setCode(t.replace(/\D/g, '').slice(0, 6))}
              secureTextEntry
              keyboardType="number-pad"
              maxLength={6}
              placeholder={WORDS.codeHint}
              returnKeyType="next"
              onSubmitEditing={() => againRef.current?.focus()}
            />
            <Field
              ref={againRef}
              value={again}
              onChangeText={t => setAgain(t.replace(/\D/g, '').slice(0, 6))}
              secureTextEntry
              keyboardType="number-pad"
              maxLength={6}
              placeholder={WORDS.once}
              returnKeyType="go"
              onSubmitEditing={turnOn}
              style={{marginTop: 8}}
            />
            <Text style={s.note}>{WORDS.chooseNote}</Text>
          </>
        ) : null}
        {error ? <Text style={s.err}>{error}</Text> : null}
        <View style={s.row}>
          <PrimaryButton uiId="child.on" label={WORDS.turnOn} busy={busy} disabled={pick === null} onPress={turnOn} style={{flex: 1}} />
          <GlassButton label={WORDS.cancel} onPress={onClose} />
        </View>
      </>
    );
  } else {
    // ---- on: younger is a tap; older, or leaving, the passcode ----
    const raise = pick !== null && pick > cur;
    sub = WORDS.onFor(cur);
    const submit = () =>
      run(async () => {
        if (!validCode(code)) throw new ApiError(400, WORDS.digits);
        const r = raise ? await api.childModeOn(profileId, {maxAge: pick as number, passcode: code}) : await api.childModeOff(profileId, code);
        done(r.profile);
      });
    body = (
      <>
        <Text style={s.label}>{WORDS.who}</Text>
        {chips(a => {
          setError('');
          if (a < cur) return run(async () => done((await api.childModeOn(profileId, {maxAge: a})).profile));
          setPick(a);
        })}
        <Text style={s.label}>{raise ? WORDS.enterToAllow(pick as number) : WORDS.enterToLeave}</Text>
        <Field
          value={code}
          onChangeText={t => setCode(t.replace(/\D/g, '').slice(0, 6))}
          secureTextEntry
          keyboardType="number-pad"
          maxLength={6}
          placeholder="Passcode"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        {error ? <Text style={s.err}>{error}</Text> : null}
        <Tap uiId="child.forgot" accessibilityRole="button" onPress={() => (setForgot(true), setError(''))} style={s.forgot}>
          <Text style={s.forgotText}>{WORDS.forgot}</Text>
        </Tap>
        <View style={s.row}>
          <PrimaryButton uiId={raise ? 'child.age' : 'child.off'} label={raise ? WORDS.allow(pick as number) : WORDS.leave} busy={busy} onPress={submit} style={{flex: 1}} />
          <GlassButton label={WORDS.cancel} onPress={onClose} />
        </View>
      </>
    );
  }
  return (
    <Sheet visible onClose={onClose} title={title} sub={sub}>
      <View style={s.pad}>{body}</View>
    </Sheet>
  );
}

const s = StyleSheet.create({
  pad: {paddingHorizontal: GUTTER + 4, paddingBottom: 8},
  label: {color: colors.text, fontSize: 15, fontWeight: '800', marginTop: 14, marginBottom: 8},
  // four even columns: the ages on one row on any phone
  chips: {flexDirection: 'row', gap: 8},
  chip: {flex: 1, justifyContent: 'center', paddingHorizontal: 4},
  note: {color: colors.textDim, fontSize: 13.5, lineHeight: 19, marginTop: 8},
  err: {color: '#ffb3b3', fontSize: 14, marginTop: 10},
  row: {flexDirection: 'row', gap: 10, marginTop: 16},
  forgot: {alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', marginTop: 4},
  forgotText: {color: colors.textDim, fontSize: 14, textDecorationLine: 'underline'},
});
