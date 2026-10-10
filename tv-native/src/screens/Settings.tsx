// Settings — a port of the site's #/preferences.
//
// The site's groups: the liked genres that feed Home's recommendations,
// Playback, Subtitles, Downloads, Privacy. WHAT FOLLOWS THE PERSON (autoplay,
// subtitles on / language, the two download switches, usage stats — and the
// genres) is read from and written to their PROFILE, so it is the same on the
// website and on every TV; subtitle size and background, the billboard's
// trailers and this TV's notifications stay on the box (personPrefs.ts has
// the table, personSync.ts keeps it in step). Profile editing is left off
// deliberately: on the site it opens a modal with a password field, and typing a
// password on a remote is worse than doing it on the phone or laptop.
//
// Genres are toggled against the same endpoint the site uses, so a change here
// shows up in the browser's rows too.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, ScrollView, StyleSheet, ActivityIndicator} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Focusable from '../components/Focusable';
import NavRail from '../components/NavRail';
import {api, getSession, setSession} from '../api';
import {useApp} from '../AppContext';
import {useMe, useNewUnseen} from '../navSection';
import {openJoinParty, openReport, openUpdate} from '../overlay';
import {loadPrefs, savePrefs, Prefs, PREFS_DEFAULTS, saveAuthSession} from '../storage';
import {PERSON_KEYS, PersonKey, SUB_LANGS, SUB_LANG_LABEL} from '../personPrefs';
import {onPersonPrefs, refreshPerson, setPersonPref} from '../personSync';
import {showToast} from '../toast';
import {APP_VERSION, checkForUpdate, UpdateInfo} from '../update';
import {setUsageEnabled} from '../usage';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';
import {isLite} from '../perfTier';
import {askNotificationPermission, setDownloadNotices} from '../homeScreen';

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

export default function Settings({
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'Settings'>) {
  const {profileId, switchProfile} = useApp();
  const newUnseen = useNewUnseen();
  // This TV's build, and whether the server has a newer one.
  const [update, setUpdate] = useState<UpdateInfo | null | 'checking' | 'none'>(null);
  const checkUpdate = useCallback(async () => {
    setUpdate('checking');
    const u = await checkForUpdate();
    setUpdate(u || 'none');
    if (u) openUpdate(u);
    else showToast(`You're on the latest version (${APP_VERSION})`, '✓');
  }, []);
  useEffect(() => {
    checkForUpdate().then(u => setUpdate(u || 'none'));
  }, []);
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
    // Opening Settings asks the profile again, so a choice made on the phone
    // a moment ago is what this screen shows; and one that changes while the
    // screen is up (the server says so) repaints it.
    refreshPerson();
    return onPersonPrefs(person => setPrefs(cur => ({...cur, ...person})));
  }, []);

  // Genre list comes from the library, exactly as the site builds it, and the
  // current selection from the profile's own state.
  useEffect(() => {
    let live = true;
    Promise.all([api.library(), api.state(profileId)])
      .then(([lib, st]) => {
        if (!live) return;
        const all = [...lib.movies, ...lib.shows].flatMap(i => i.genres || []);
        // One chip per genre, however the sources spell it (preferences.js
        // genreKey): "Sci-Fi", "Science Fiction" and "Science-Fiction" were
        // three chips. The chip's label is the first spelling (Sci-Fi for
        // that one) and pressing it likes every spelling behind it.
        const groups = new Map<string, string[]>();
        for (const g of [...new Set(all)].sort()) {
          const k0 = g.toLowerCase().replace(/[^a-z0-9]+/g, '');
          const k = k0 === 'sciencefiction' ? 'scifi' : k0;
          groups.set(k, [...(groups.get(k) || []), g]);
        }
        genreGroups.current = groups;
        setGenres([...groups.entries()].map(([k, v]) => (k === 'scifi' ? 'Sci-Fi' : v[0])));
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
  // label → every spelling it stands for
  const genreGroups = useRef(new Map<string, string[]>());
  const spellingsOf = useCallback((label: string): string[] => {
    for (const [k, v] of genreGroups.current) if ((k === 'scifi' ? 'Sci-Fi' : v[0]) === label) return v;
    return [label];
  }, []);
  const toggleGenre = useCallback(
    (g: string) => {
      const next = new Set(liked);
      const all = spellingsOf(g);
      const on = all.some(x => next.has(x));
      for (const x of all) on ? next.delete(x) : next.add(x);
      setLiked(next);
      // Fire and forget, like the site: the chips are the source of truth on
      // screen and a failed save is not worth interrupting the viewer for.
      api.setPreferences(profileId, [...next]).catch(() => {});
    },
    [profileId, liked, spellingsOf],
  );

  const [notifyNote, setNotifyNote] = useState<string | null>(null);
  const set = useCallback(
    <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
      const next = {...prefs, [key]: value};
      setPrefs(next);
      // the person's choices go to their profile, the screen's stay here
      if ((PERSON_KEYS as string[]).includes(key)) setPersonPref(key as PersonKey, value as never);
      else savePrefs(next);
      if (key === 'usageStats') setUsageEnabled(!!value);
    },
    [prefs],
  );

  const cycle = <K extends keyof Prefs>(key: K, values: Prefs[K][]) => {
    const i = values.indexOf(prefs[key]);
    set(key, values[(i + 1) % values.length]);
  };

  const subLangLabel = SUB_LANG_LABEL[prefs.subLang] || SUB_LANG_LABEL.any;
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
              const on = spellingsOf(g).some(x => liked.has(x));
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

        <Text style={styles.h2}>Aurora</Text>
        <View style={styles.list}>
          <Row
            label={newUnseen ? "What's new  •" : "What's new"}
            note="What this TV can do now, and how."
            value="›"
            onPress={() => navigation.push('WhatsNew')}
          />
          <Row
            label="My downloads"
            note="What you asked the server to fetch — ready, on its way, waiting."
            value="›"
            onPress={() => navigation.push('Downloads')}
          />
          <Row
            label="Join a watch party"
            note="Type the four-letter code from another screen and watch in step."
            value="›"
            onPress={openJoinParty}
          />
          <Row
            label="Report a problem"
            note="A few words; where you were and the last errors come along by themselves."
            value="›"
            onPress={() => openReport()}
          />
        </View>

        <Text style={styles.h2}>Playback</Text>
        <View style={styles.list}>
          <Row
            label="Autoplay next episode"
            note="Start the next episode automatically when one finishes."
            value={prefs.autoplayNext ? 'On' : 'Off'}
            onPress={() => set('autoplayNext', !prefs.autoplayNext)}
          />
          <Row
            label="Trailers on the home billboard"
            note={
              isLite()
                ? 'Off on this box: it runs smoother without them. The billboard still rotates.'
                : 'A title that holds still for a few seconds plays its trailer, muted — two per visit to Home.'
            }
            value={isLite() ? 'Off' : prefs.heroTrailers ? 'On' : 'Off'}
            onPress={() => set('heroTrailers', !prefs.heroTrailers)}
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
            note="The language to pick. If a title doesn't have it, Aurora goes and gets it."
            value={subLangLabel}
            onPress={() => cycle('subLang', SUB_LANGS)}
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
        {/* A kids profile's settings leave out what a child shouldn't change —
            what Aurora downloads by itself, and the sign-in (below) — as on
            the site (preferences.js `kid`). */}
        {me?.kids ? null : (
          <>
            <Text style={styles.h2}>Downloads</Text>
            <View style={styles.list}>
              <Row
                label="Get the next episode ready"
                note="While you watch, Aurora fetches the next episode so it starts at once."
                value={prefs.smartDownloads ? 'On' : 'Off'}
                onPress={() => set('smartDownloads', !prefs.smartDownloads)}
              />
              <Row
                label="Tidy up after watching"
                note="Episodes Aurora fetched for you are removed once you've watched them. Nothing you saved yourself is touched."
                value={prefs.smartCleanup ? 'On' : 'Off'}
                onPress={() => set('smartCleanup', !prefs.smartCleanup)}
              />
            </View>
          </>
        )}
        <Text style={styles.h2}>Notifications</Text>
        <View style={styles.list}>
          <Row
            label="Tell me when a download lands (TV notification)"
            note={
              notifyNote ||
              'When something you asked for or follow has downloaded, the TV says so — and it shows as “New” in Aurora’s row on the home screen.'
            }
            value={prefs.downloadNotices ? 'On' : 'Off'}
            onPress={() => {
              const on = !prefs.downloadNotices;
              set('downloadNotices', on);
              setDownloadNotices(on);
              setNotifyNote(null);
              // Android 13+: turning it on is the moment to ask (again)
              if (on) {
                askNotificationPermission(true).then(ok => {
                  if (!ok) setNotifyNote('The TV is not letting Aurora post notifications — allow them in the TV’s Settings → Apps → Aurora → Notifications.');
                });
              }
            }}
          />
        </View>
        <Text style={styles.h2}>Privacy</Text>
        <View style={styles.list}>
          <Row
            label="Usage stats"
            note="Which screens and features get used, and how long they took — to your own server only, never anything typed. Off here is off for you on every device."
            value={prefs.usageStats ? 'On' : 'Off'}
            onPress={() => set('usageStats', !prefs.usageStats)}
          />
        </View>

        <Text style={styles.h2}>This TV</Text>
        <View style={styles.list}>
          <Row
            label={`Aurora TV ${APP_VERSION}`}
            note={
              update && typeof update === 'object'
                ? `Version ${update.version} is available — press to update.`
                : update === 'checking'
                ? 'Checking…'
                : 'Press to check for a newer version.'
            }
            value={update && typeof update === 'object' ? 'Update' : 'Check'}
            onPress={() => (update && typeof update === 'object' ? openUpdate(update) : checkUpdate())}
          />
        </View>

        {getSession() && !me?.kids ? (
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
