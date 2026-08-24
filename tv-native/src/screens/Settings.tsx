// Settings — a port of the site's #/preferences.
//
// Same three groups the site has: the liked genres that feed Home's
// recommendations, then Playback, then Subtitles. Profile editing is left off
// deliberately: on the site it opens a modal with a password field, and typing a
// password on a remote is worse than doing it on the phone or laptop.
//
// Genres are toggled against the same endpoint the site uses, so a change here
// shows up in the browser's rows too.
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {View, Text, ScrollView, StyleSheet, ActivityIndicator} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Focusable from '../components/Focusable';
import NavRail from '../components/NavRail';
import {api, getSession, setSession} from '../api';
import {useApp} from '../AppContext';
import {useMe} from '../navSection';
import {loadPrefs, savePrefs, Prefs, PREFS_DEFAULTS, saveAuthSession} from '../storage';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, radius} = theme;

// One tappable row: label, explanation, and the current value on the right. The
// site's `prefRow` in the same shape — pressing it cycles the value.
const Row = React.memo(function PrefRow({
  label,
  note,
  value,
  onPress,
}: {
  label: string;
  note?: string;
  value: string;
  onPress: () => void;
}) {
  return (
    // 1.01, the site's .source-row / .episode figure: a full-width row lifts a
    // touch instead of growing by tens of dp and landing on its neighbours.
    <Focusable
      scaleTo={1.01}
      // A full-width row has nothing to its left, so LEFT belongs to the rail.
      edgeLeft
      onPress={onPress}
      style={styles.row}
      highlightColor={colors.surfaceHover}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {note ? <Text style={styles.rowNote}>{note}</Text> : null}
      </View>
      <Text style={styles.rowValue}>{value}</Text>
    </Focusable>
  );
});

export default function Settings(
  _props: NativeStackScreenProps<RootStackParamList, 'Settings'>,
) {
  const {profileId, switchProfile} = useApp();
  const {safeBottom} = useTvMetrics();
  const me = useMe(profileId);

  const [genres, setGenres] = useState<string[] | null>(null);
  const [liked, setLiked] = useState<Set<string>>(new Set());
  const [prefs, setPrefs] = useState<Prefs>(PREFS_DEFAULTS);
  // Which genre chips actually sit at the START of a wrapped row — measured,
  // because with flexWrap it cannot be derived from the index. Only those are
  // edgeLeft: marking EVERY chip was wrong the other way (the key event can
  // beat the native focus move, so LEFT from mid-row could both step a chip
  // AND open the rail — the exact double-action the rail guard exists for).
  const [edgeGenres, setEdgeGenres] = useState<Set<string>>(new Set());
  const noteChipLayout = useCallback((g: string, x: number) => {
    setEdgeGenres(prev => {
      const isEdge = x < 2;
      if (prev.has(g) === isEdge) return prev;
      const next = new Set(prev);
      if (isEdge) next.add(g);
      else next.delete(g);
      return next;
    });
  }, []);

  useEffect(() => {
    loadPrefs().then(setPrefs);
  }, []);

  // Genre list comes from the library, exactly as the site builds it, and the
  // current selection from the profile's own state.
  useEffect(() => {
    let live = true;
    Promise.all([api.library(), api.state(profileId)])
      .then(([lib, st]) => {
        if (!live) return;
        const all = [...lib.movies, ...lib.shows].flatMap(i => i.genres || []);
        setGenres([...new Set(all)].sort());
        setLiked(new Set(st.likedGenres || []));
      })
      .catch(() => live && setGenres([]));
    return () => {
      live = false;
    };
  }, [profileId]);

  // Side effects OUTSIDE the state updaters: an updater must be pure — React is
  // allowed to run it twice (StrictMode) or discard the render, which here
  // meant a double POST or persisting a value that never committed.
  const toggleGenre = useCallback(
    (g: string) => {
      const next = new Set(liked);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      setLiked(next);
      // Fire and forget, like the site: the chips are the source of truth on
      // screen and a failed save is not worth interrupting the viewer for.
      api.setPreferences(profileId, [...next]).catch(() => {});
    },
    [profileId, liked],
  );

  const set = useCallback(
    <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
      const next = {...prefs, [key]: value};
      setPrefs(next);
      savePrefs(next);
    },
    [prefs],
  );

  const cycle = <K extends keyof Prefs>(key: K, values: Prefs[K][]) => {
    const i = values.indexOf(prefs[key]);
    set(key, values[(i + 1) % values.length]);
  };

  const subLangLabel = useMemo(
    () =>
      ({any: 'First available', he: 'Hebrew', en: 'English'}[prefs.subLang] ||
      'First available'),
    [prefs.subLang],
  );
  const cueLabel = useMemo(
    () => ({S: 'Small', M: 'Medium', L: 'Large'}[prefs.cueSize] || 'Medium'),
    [prefs.cueSize],
  );

  return (
    <View style={styles.root}>
      <NavRail active="settings" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, {paddingBottom: safeBottom + spacing.xl}]}>
        <Text style={styles.h1}>Settings</Text>
        <Text style={styles.sub}>for {me?.name || 'this profile'}</Text>

        <Text style={styles.h2}>What you like</Text>
        <Text style={styles.note}>
          Pick the genres you enjoy — Home leans its rows towards them.
        </Text>
        {genres === null ? (
          <ActivityIndicator color={colors.text} style={{marginTop: spacing.md, alignSelf: 'flex-start'}} />
        ) : (
          <View style={styles.chips}>
            {genres.map(g => {
              const on = liked.has(g);
              return (
                // The wrapper exists to MEASURE: with flexWrap, which chips
                // start a row depends on text widths, so edgeLeft is read off
                // the real layout x rather than guessed from the index.
                <View key={g} onLayout={e => noteChipLayout(g, e.nativeEvent.layout.x)}>
                  <Focusable
                    round
                    light={on}
                    edgeLeft={edgeGenres.has(g)}
                    onPress={() => toggleGenre(g)}
                    style={[styles.chip, on && styles.chipOn]}>
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{g}</Text>
                  </Focusable>
                </View>
              );
            })}
          </View>
        )}

        <Text style={styles.h2}>Playback</Text>
        <View style={styles.list}>
          <Row
            label="Autoplay next episode"
            note="Start the next episode automatically when one finishes."
            value={prefs.autoplayNext ? 'On' : 'Off'}
            onPress={() => set('autoplayNext', !prefs.autoplayNext)}
          />
        </View>

        <Text style={styles.h2}>Subtitles</Text>
        <View style={styles.list}>
          <Row
            label="Turn subtitles on automatically"
            note="When a title offers subtitles, switch one on without asking."
            value={prefs.subsDefault ? 'On' : 'Off'}
            onPress={() => set('subsDefault', !prefs.subsDefault)}
          />
          <Row
            label="Preferred subtitle language"
            note="Which one to pick when a title offers several."
            value={subLangLabel}
            onPress={() => cycle('subLang', ['any', 'he', 'en'])}
          />
          <Row
            label="Subtitle size"
            value={cueLabel}
            onPress={() => cycle('cueSize', ['S', 'M', 'L'])}
          />
          <Row
            label="Subtitle background"
            note="A dark plate behind the text. Off is cleaner; on is readable over anything."
            value={prefs.cueBackground ? 'On' : 'Off'}
            onPress={() => set('cueBackground', !prefs.cueBackground)}
          />
        </View>
        {getSession() ? (
          <>
            <Text style={styles.h2}>Account</Text>
            <Focusable
              scaleTo={1.01}
              highlightColor={colors.surfaceHover}
              onPress={async () => {
                // Revoke server-side first (best-effort), THEN forget locally —
                // switchProfile routes to the gate or the login screen by mode.
                try {
                  await api.logout();
                } catch {}
                setSession(null);
                await saveAuthSession(null);
                switchProfile();
              }}
              style={styles.signOut}>
              <Text style={styles.signOutText}>Sign out on this TV</Text>
              <Text style={styles.signOutNote}>
                Ends this TV's session — you'll sign in again with the QR or your password.
              </Text>
            </Focusable>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  signOut: {
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    paddingVertical: 14,
    paddingHorizontal: 18,
    marginTop: 2,
  },
  signOutText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  signOutNote: {color: colors.textFaint, fontSize: fontSize.small, marginTop: 2},
  // No backgroundColor: android:windowBackground already paints it.
  root: {flex: 1},
  scroll: {flex: 1},
  content: {paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX, paddingTop: 27},
  h1: {color: colors.text, fontSize: fontSize.title, fontWeight: '900', marginTop: spacing.md},
  sub: {color: colors.textDim, fontSize: fontSize.body, marginTop: 2},
  h2: {
    color: colors.text,
    fontSize: fontSize.row,
    fontWeight: '800',
    marginTop: spacing.xl,
    marginBottom: spacing.xs,
  },
  note: {color: colors.textDim, fontSize: fontSize.small, marginBottom: spacing.md, maxWidth: 720},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  chip: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 8,
    paddingHorizontal: 18,
  },
  chipOn: {backgroundColor: colors.white, borderColor: 'transparent'},
  chipText: {color: colors.textDim, fontSize: fontSize.small, fontWeight: '700'},
  chipTextOn: {color: colors.bg},
  list: {gap: spacing.sm},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
  },
  rowText: {flex: 1},
  rowLabel: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  rowNote: {color: colors.textFaint, fontSize: fontSize.small, marginTop: 2},
  rowValue: {color: colors.accent, fontSize: fontSize.body, fontWeight: '800'},
});
