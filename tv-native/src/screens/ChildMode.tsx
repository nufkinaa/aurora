// Children mode on the TV (2026-11-11, docs/children-mode.md) — the account's
// own switch, the website's sheet (public/js/childmode.js) as a TV page, in
// the same words (childMode.ts WORDS).
//
//   off → Who is watching? All ages · 7+ · 12+ · 16+, and Turn on. The first
//         time ever on this account the parent also chooses a passcode
//         (typed twice); after that it is remembered on the account and not
//         asked again.
//   on  → a younger age is one press (it only restricts); an older one, or
//         leaving, takes the passcode. "Forgot the passcode?" points to the
//         phone or the website (a password is no thing to type on a remote,
//         and the TV has no Google sign-in for it).
//
// Reached from Settings, and from the rail's profile pill while children
// mode is on (there is no switching profile then). What the server answers is
// handed to childModeChanged: AppRoot follows (the lock, Home again, a toast).
import React, {useEffect, useRef, useState} from 'react';
import {View, Text, TextInput, StyleSheet, ScrollView, ActivityIndicator} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Chip from '../components/Chip';
import Focusable from '../components/Focusable';
import {api, ApiError, ChildModeView} from '../api';
import {useApp} from '../AppContext';
import {AGES, ageWords, childModeChanged, keepsLine, limitOf, validCode, WORDS} from '../childMode';
import {RootStackParamList} from '../navigation';
import theme from '../theme';

const {colors, fontSize, spacing, radius} = theme;

type Props = NativeStackScreenProps<RootStackParamList, 'ChildMode'>;

export default function ChildMode({navigation}: Props) {
  const {profileId} = useApp();
  const [view, setView] = useState<ChildModeView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [pick, setPick] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [fieldOn, setFieldOn] = useState<'code' | 'again' | null>(null);
  const againRef = useRef<TextInput>(null);
  const codeRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const rowY = useRef(0);
  // a field is being typed in: its row to the top of the screen, above the keyboard
  const onField = (which: 'code' | 'again') => {
    setFieldOn(which);
    scrollRef.current?.scrollTo({y: Math.max(0, rowY.current - spacing.lg), animated: true});
  };

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

  const done = (profile: Parameters<typeof limitOf>[0], note?: string) => {
    // AppRoot follows: the kids lock, everything held dropped, Home, the toast
    childModeChanged({profileId, kids: limitOf(profile), note});
  };
  const fail = (e: unknown) => {
    setError(e instanceof ApiError ? e.message : 'Could not reach the server');
    setCode('');
    setAgain('');
  };

  if (loadError || !view) {
    return (
      <View style={styles.root}>
        <Text style={styles.heading}>{WORDS.title}</Text>
        {loadError ? (
          <>
            <Text style={styles.error}>{loadError}</Text>
            <View style={styles.row}>
              <Focusable round hasTVPreferredFocus onPress={() => navigation.goBack()} style={styles.btnGhost}>
                <Text style={styles.btnGhostText}>Back</Text>
              </Focusable>
            </View>
          </>
        ) : (
          <ActivityIndicator color={colors.text} style={styles.spinner} />
        )}
      </View>
    );
  }

  const cur = view.on ? view.maxAge : null;

  if (forgot) {
    return (
      <View style={styles.root}>
        <Text style={styles.heading}>{WORDS.forgot}</Text>
        <Text style={styles.sub}>{WORDS.forgotTv}</Text>
        <View style={styles.row}>
          <Focusable round hasTVPreferredFocus onPress={() => setForgot(false)} style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>Back</Text>
          </Focusable>
        </View>
      </View>
    );
  }

  // ---- off: turn it on ----
  if (cur === null) {
    const first = !view.passcodeSet;
    const turnOn = async () => {
      if (busy || pick === null) return;
      setError('');
      const body: {maxAge: number; newPasscode?: string} = {maxAge: pick};
      if (first) {
        if (!validCode(code)) return setError(WORDS.digits);
        if (again !== code) {
          setAgain('');
          return setError(WORDS.mismatch);
        }
        body.newPasscode = code;
      }
      setBusy(true);
      try {
        const r = await api.childModeOn(profileId, body);
        done(r.profile);
      } catch (e) {
        fail(e);
      } finally {
        setBusy(false);
      }
    };
    return (
      <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.heading}>{WORDS.title}</Text>
        <Text style={styles.sub}>{WORDS.intro}</Text>
        <Text style={styles.label}>{WORDS.who}</Text>
        <View style={styles.chips}>
          {AGES.map((a, i) => (
            <Chip
              key={a}
              uiId="child.age"
              label={ageWords(a)}
              on={pick === a}
              hasTVPreferredFocus={i === 0}
              onPress={() => {
                setPick(a);
                setError('');
              }}
            />
          ))}
        </View>
        <Text style={styles.note}>{pick === null ? WORDS.pick : keepsLine(pick)}</Text>
        {first ? (
          <>
            <Text style={styles.label}>{WORDS.choose}</Text>
            <Text style={styles.note}>{WORDS.chooseNote}</Text>
          </>
        ) : null}
        {/* the fields and the buttons on ONE row: with the TV's keyboard up
            (it takes the lower half) the row is scrolled to the top, so the
            buttons stay in sight beside what is typed (Mi TV pass) */}
        <View style={styles.formRow} onLayout={e => (rowY.current = e.nativeEvent.layout.y)}>
          {first ? (
            <>
              <TextInput
                ref={codeRef}
                style={[styles.input, styles.inputRow, fieldOn === 'code' && styles.inputOn]}
                onFocus={() => onField('code')}
                onBlur={() => setFieldOn(null)}
                value={code}
                onChangeText={t => setCode(t.replace(/\D/g, '').slice(0, 6))}
                secureTextEntry
                keyboardType="number-pad"
                maxLength={6}
                placeholder={WORDS.codeHint}
                placeholderTextColor={colors.textFaint}
                onSubmitEditing={() => againRef.current?.focus()}
              />
              <TextInput
                ref={againRef}
                style={[styles.input, styles.inputRow, fieldOn === 'again' && styles.inputOn]}
                onFocus={() => onField('again')}
                onBlur={() => setFieldOn(null)}
                value={again}
                onChangeText={t => setAgain(t.replace(/\D/g, '').slice(0, 6))}
                secureTextEntry
                keyboardType="number-pad"
                maxLength={6}
                placeholder={WORDS.once}
                placeholderTextColor={colors.textFaint}
                onSubmitEditing={turnOn}
              />
            </>
          ) : null}
          <Focusable uiId="child.on" round onPress={turnOn} style={[styles.btnPrimary, pick === null && styles.btnDim]}>
            {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.btnPrimaryText}>{WORDS.turnOn}</Text>}
          </Focusable>
          <Focusable round onPress={() => navigation.goBack()} style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>{WORDS.cancel}</Text>
          </Focusable>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    );
  }

  // ---- on: a younger age is a press; an older one, or leaving, the passcode ----
  const raise = pick !== null && pick > cur;
  const submit = async () => {
    if (busy) return;
    setError('');
    if (!validCode(code)) return setError(WORDS.digits);
    setBusy(true);
    try {
      const r = raise ? await api.childModeOn(profileId, {maxAge: pick as number, passcode: code}) : await api.childModeOff(profileId, code);
      done(r.profile);
    } catch (e) {
      // (the keyboard is NOT opened again by itself: the field is one press away)
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const younger = async (a: number) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.childModeOn(profileId, {maxAge: a});
      done(r.profile);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>{WORDS.title}</Text>
      <Text style={styles.sub}>{WORDS.onFor(cur)}</Text>
      <Text style={styles.label}>{WORDS.who}</Text>
      <View style={styles.chips}>
        {AGES.map(a => (
          <Chip
            key={a}
            uiId="child.age"
            label={ageWords(a)}
            on={pick === a}
            // first focus: the age it is on (no keyboard opens by itself)
            hasTVPreferredFocus={a === cur}
            onPress={() => {
              if (a < cur) return younger(a);
              setPick(a);
              setError('');
            }}
          />
        ))}
      </View>
      <Text style={styles.label}>{raise ? WORDS.enterToAllow(pick as number) : WORDS.enterToLeave}</Text>
      <View style={styles.formRow} onLayout={e => (rowY.current = e.nativeEvent.layout.y)}>
        <TextInput
          ref={codeRef}
          style={[styles.input, styles.inputRow, fieldOn === 'code' && styles.inputOn]}
          onFocus={() => onField('code')}
          onBlur={() => setFieldOn(null)}
          value={code}
          onChangeText={t => setCode(t.replace(/\D/g, '').slice(0, 6))}
          secureTextEntry
          keyboardType="number-pad"
          maxLength={6}
          placeholder="Passcode"
          placeholderTextColor={colors.textFaint}
          onSubmitEditing={submit}
        />
        <Focusable uiId={raise ? 'child.age' : 'child.off'} round onPress={submit} style={styles.btnPrimary}>
          {busy ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text style={styles.btnPrimaryText}>{raise ? WORDS.allow(pick as number) : WORDS.leave}</Text>
          )}
        </Focusable>
        <Focusable round onPress={() => navigation.goBack()} style={styles.btnGhost}>
          <Text style={styles.btnGhostText}>{WORDS.cancel}</Text>
        </Focusable>
        <Focusable uiId="child.forgot" round onPress={() => setForgot(true)} style={styles.btnGhost}>
          <Text style={styles.btnGhostText}>{WORDS.forgot}</Text>
        </Focusable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

// The profile wall's PIN view (ProfileGate.tsx), from the top of the screen:
// the TV's keyboard covers the lower half.
const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg, padding: spacing.pageX, justifyContent: 'flex-start'},
  scroll: {flex: 1, backgroundColor: colors.bg},
  // (room below: the field row can be scrolled to the top while the keyboard is up)
  content: {padding: spacing.pageX, paddingBottom: 600},
  spinner: {marginTop: spacing.xl, alignSelf: 'flex-start'},
  heading: {color: colors.text, fontSize: fontSize.hero, fontWeight: '900'},
  sub: {color: colors.textDim, fontSize: fontSize.row, marginTop: spacing.sm, maxWidth: 1100},
  label: {color: colors.text, fontSize: fontSize.body, fontWeight: '800', marginTop: spacing.lg},
  note: {color: colors.textFaint, fontSize: fontSize.small, marginTop: spacing.sm, maxWidth: 900},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm},
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.m,
    color: colors.text,
    fontSize: fontSize.row,
    paddingVertical: 16,
    paddingHorizontal: 22,
    maxWidth: 480,
    marginTop: spacing.sm,
  },
  // the fields beside the buttons, on one row
  formRow: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md, marginTop: spacing.sm},
  inputRow: {marginTop: 0, width: 300},
  inputOn: {borderColor: colors.focusRing},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.lg},
  btnPrimary: {backgroundColor: colors.white, paddingVertical: 14, paddingHorizontal: 40, minWidth: 150, alignItems: 'center'},
  btnDim: {opacity: 0.5},
  btnPrimaryText: {color: colors.bg, fontSize: fontSize.body, fontWeight: '800'},
  btnGhost: {backgroundColor: colors.surface, paddingVertical: 14, paddingHorizontal: 28, alignItems: 'center'},
  btnGhostText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  error: {color: '#ff8080', fontSize: fontSize.small, marginTop: spacing.md},
});
