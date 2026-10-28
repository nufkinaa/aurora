// Settings — a port of the site's #/preferences.
//
// The site's groups: the liked genres that feed Home's recommendations,
// Playback, Subtitles, Downloads, Privacy. WHAT FOLLOWS THE PERSON (autoplay,
// subtitles on / language, the two download switches, usage stats — and the
// genres, and since 2026-10-19 the subtitle look and the sound) is read from
// and written to their PROFILE, so it is the same on the website and on every
// TV; the billboard's trailers and this TV's notifications stay on the box
// (personPrefs.ts has the table, personSync.ts keeps it in step). Profile editing is left off
// deliberately: on the site it opens a modal with a password field, and typing a
// password on a remote is worse than doing it on the phone or laptop.
//
// Genres are toggled against the same endpoint the site uses, so a change here
// shows up in the browser's rows too.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, ScrollView, StyleSheet, ActivityIndicator, TVFocusGuideView} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Chip from '../components/Chip';
import Focusable from '../components/Focusable';
import NavRail from '../components/NavRail';
import {api, getSession, setSession} from '../api';
import {useApp} from '../AppContext';
import {useRouteShown} from '../useRouteShown';
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
import RenderDevPanel from '../components/RenderDevPanel';
// [player-options] the sound and the look of subtitles, the person's (2026-10-19)
import {SubStylePreview, useAudioFx} from '../playerOptions';
import {nextChoice, readStyle, styleLabel, SUB_STYLE_KEYS, SUB_STYLE_SETTINGS, SubStyleKey} from '../subStyle';
import {AUDIO_FX_KEYS, AUDIO_FX_NAMES, AUDIO_FX_NOTES} from '../audioFx';
import TvNamePicker, {useTvName} from '../remote/TvNamePicker'; // [phone-remote]
import {HouseholdSettings} from '../api'; // [household]
import {nameWord, WORDS as HH} from '../householdRecs'; // [household]
import {householdChanged} from '../householdLive'; // [household]

const {colors, fontSize, spacing, radius} = theme;

// How long Settings waits for its genre chips before giving first focus to
// the row under them (see firstFocus).
const FIRST_FOCUS_WAIT_MS = 800;

// One tappable row: label, explanation, and the current value on the right. The
// site's `prefRow` in the same shape — pressing it cycles the value.
const Row = React.memo(function PrefRow({
  uiId,
  label,
  note,
  value,
  onPress,
  hasTVPreferredFocus,
  onLongPress,
}: {
  uiId?: string; // [analytics] which control this is (Focusable.uiId)
  label: string;
  note?: string;
  value: string;
  onPress: () => void;
  hasTVPreferredFocus?: boolean;
  onLongPress?: () => void;
}) {
  return (
    // 1.01, the site's .source-row / .episode figure: a full-width row lifts a
    // touch instead of growing by tens of dp and landing on its neighbours.
    <Focusable
      scaleTo={1.01}
      // A full-width row has nothing to its left, so LEFT belongs to the rail.
      edgeLeft
      uiId={uiId}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onPress={onPress}
      onLongPress={onLongPress}
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

// [household] "Recommendations": the switch and the mute list — the person's,
// kept on the server (GET/POST /api/profiles/:id/household/settings), so the
// same on the website and on every TV; nothing of it is stored on this box.
// "What you sent" opens the Show all page on its You sent tab (the page is
// otherwise only reached from Home's row when there are more than 15).
function HouseholdPrefs({profileId, onSent}: {profileId: string; onSent: () => void}) {
  const [st, setSt] = useState<HouseholdSettings | null>(null);
  useEffect(() => {
    let live = true;
    api
      .householdSettings(profileId)
      .then(r => live && setSt(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [profileId]);
  const save = async (body: {on?: boolean; muted?: string[]}, optimistic: HouseholdSettings) => {
    const before = st;
    setSt(optimistic);
    try {
      setSt(await api.setHouseholdSettings(profileId, body));
      householdChanged(); // Home's row follows
    } catch {
      setSt(before);
      showToast("Couldn't save that — try again in a moment", '⚠️');
    }
  };
  const mutedIds = (st?.people || []).filter(p => p.muted).map(p => p.id);
  const mute = (p: HouseholdSettings['people'][number]) => {
    if (!st) return;
    const muted = p.muted ? mutedIds.filter(id => id !== p.id) : [...mutedIds, p.id];
    save({muted}, {...st, people: st.people.map(x => (x.id === p.id ? {...x, muted: !p.muted} : x))});
  };
  return (
    <>
      <Text style={styles.h2}>{HH.settingsSection}</Text>
      <View style={styles.list}>
        <Row uiId="settings.hh.toggle"
          label={HH.settingsSwitch}
          note={HH.settingsSwitchNote}
          value={!st ? '…' : st.on ? 'On' : 'Off'}
          onPress={() => st && save({on: !st.on}, {...st, on: !st.on})}
        />
      </View>
      {/* the mute list only while recommendations are on (the website's: off, nobody reaches you) */}
      {st && st.on && st.people.length ? (
        <>
          <Text style={[styles.note, styles.hhMuteLine]}>{HH.muteLine}</Text>
          {/* the website's chips: "Dana · Mute" / "Avi · Muted". A focus guide: DOWN from the
              switch lands on the FIRST chip (or the one last used), and UP from What you sent
              too — Android's own search picked a chip in the middle of the second line (Mi TV). */}
          <TVFocusGuideView autoFocus style={styles.hhChips}>
            {st.people.map((p, i) => (
              <Chip uiId="settings.hh.mute" key={p.id} small edgeLeft={i === 0} on={p.muted} label={nameWord(p.name, p.muted ? HH.muted : HH.mute)} onPress={() => mute(p)} />
            ))}
          </TVFocusGuideView>
        </>
      ) : null}
      <View style={[styles.list, styles.hhSent]}>
        <Row uiId="settings.hh.sent"
          label="What you sent"
          note="What you recommended, and whether each person saw it, put it on their list or watched it."
          value="›"
          onPress={onSent}
        />
      </View>
    </>
  );
}

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
  // The developer's rendering switches (RenderDevPanel.tsx): hidden until OK is HELD
  // on the version row, for this visit of the screen only.
  const [devRender, setDevRender] = useState(false);
  // [phone-remote] what the phone remote calls this TV, and its picker
  const tvName = useTvName();
  const [tvNamePicker, setTvNamePicker] = useState(false);
  const closeTvNamePicker = useCallback(() => setTvNamePicker(false), []);
  // [/phone-remote]

  const [genres, setGenres] = useState<string[] | null>(null);
  // FIRST FOCUS (5.2.0 device pass: Settings opened with nothing visibly
  // focused — the rail's press left focus in the rail, which then folded
  // away). The screen's first item takes it: the first genre chip when the
  // genres are here within FIRST_FOCUS_WAIT_MS (they usually are: the library
  // read is memoised), else "What's new", which is always there — never a
  // chip that turns up later and yanks focus from where the viewer went.
  const [firstFocus, setFirstFocus] = useState<'genre' | 'row' | null>(null);
  useEffect(() => {
    if (firstFocus) return;
    if (genres) {
      setFirstFocus(genres.length ? 'genre' : 'row');
      return;
    }
    const t = setTimeout(() => setFirstFocus(f => f || 'row'), FIRST_FOCUS_WAIT_MS);
    return () => clearTimeout(t);
  }, [genres, firstFocus]);
  // usage stats: this screen's content is on (routeTiming.ts)
  useRouteShown(genres !== null);
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
  // [player-options] the look (with its live sample) and the sound
  const subStyle = useMemo(
    () => readStyle(prefs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefs.subSize, prefs.subColor, prefs.subBg, prefs.subOpacity, prefs.subWeight, prefs.subPos],
  );
  // (what this TV can do — not what the last film's sound was: a passthrough
  // track greys the switches in the player, not here)
  const fxWhy = useAudioFx(prefs.nightMode === true, prefs.dialogueBoost === true, {perFilm: false});

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
            {genres.map((g, gi) => {
              const on = spellingsOf(g).some(x => liked.has(x));
              return (
                // The wrapper exists to MEASURE: with flexWrap, which chips
                // start a row depends on text widths, so edgeLeft is read off
                // the real layout x rather than guessed from the index.
                <View key={g} onLayout={e => noteChipLayout(g, e.nativeEvent.layout.x)}>
                  <Focusable uiId="settings.genre"
                    round
                    light={on}
                    edgeLeft={edgeGenres.has(g)}
                    // in the same commit as the chip itself (not a render later)
                    hasTVPreferredFocus={gi === 0 && firstFocus !== 'row'}
                    onPress={() => toggleGenre(g)}
                    style={[styles.chip, on && styles.chipOn]}>
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{g}</Text>
                  </Focusable>
                </View>
              );
            })}
          </View>
        )}

        <View style={[styles.list, {marginTop: spacing.md}]}>
          <Row uiId="settings.taste"
            label="Swipe your taste"
            note="One title at a time: ▶ love it, ◀ not for me, ▼ haven't seen. Home learns from every answer."
            value="›"
            onPress={() => navigation.push('Taste')}
          />
        </View>

        <Text style={styles.h2}>Aurora</Text>
        <View style={styles.list}>
          <Row uiId="settings.whatsnew"
            hasTVPreferredFocus={firstFocus === 'row'}
            label={newUnseen ? "What's new  •" : "What's new"}
            note="What this TV can do now, and how."
            value="›"
            onPress={() => navigation.push('WhatsNew')}
          />
          <Row uiId="settings.downloads"
            label="My downloads"
            note="What you asked the server to fetch — ready, on its way, waiting."
            value="›"
            onPress={() => navigation.push('Downloads')}
          />
          <Row uiId="settings.party"
            label="Join a watch party"
            note="Type the four-letter code from another screen and watch in step."
            value="›"
            onPress={openJoinParty}
          />
          <Row uiId="settings.report"
            label="Report a problem"
            note="A few words; where you were and the last errors come along by themselves."
            value="›"
            onPress={() => openReport()}
          />
        </View>

        <Text style={styles.h2}>Playback</Text>
        <View style={styles.list}>
          <Row uiId="settings.autoplay"
            label="Autoplay next episode"
            note="Start the next episode automatically when one finishes."
            value={prefs.autoplayNext ? 'On' : 'Off'}
            onPress={() => set('autoplayNext', !prefs.autoplayNext)}
          />
          <Row uiId="settings.trailers"
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

        {/* ---- picture and sound (TV round 2026-10-19): both follow the person (personPrefs.ts) ---- */}
        <Text style={styles.h2}>Picture and sound</Text>
        <View style={styles.list}>
          <Row uiId="settings.av.fps"
            label="Match frame rate"
            note="While a film plays, the screen switches to the film's own frame rate (24, 25, 50, 60…), so slow pans don't judder. The screen goes dark for a second when it switches."
            value={prefs.matchFrameRate === 'off' ? 'Off' : 'Auto'}
            onPress={() => set('matchFrameRate', prefs.matchFrameRate === 'off' ? 'auto' : 'off')}
          />
          <Row uiId="settings.av.surround"
            label="Surround sound"
            note="Auto: Dolby and DTS sound goes to the TV or soundbar as it is, when they take it — 5.1 and Atmos included. Stereo only: every film plays in plain stereo."
            value={prefs.surround === 'stereo' ? 'Stereo only' : 'Auto'}
            onPress={() => set('surround', prefs.surround === 'stereo' ? 'auto' : 'stereo')}
          />
        </View>
        {/* ---- end picture and sound ---- */}

        <Text style={styles.h2}>Subtitles</Text>
        <View style={styles.list}>
          <Row uiId="settings.subs.auto"
            label="Turn subtitles on automatically"
            note="When a title offers subtitles, switch one on without asking."
            value={prefs.subsDefault ? 'On' : 'Off'}
            onPress={() => set('subsDefault', !prefs.subsDefault)}
          />
          <Row uiId="settings.subs.lang"
            label="Preferred subtitle language"
            note="The language to pick. If a title doesn't have it, Aurora goes and gets it."
            value={subLangLabel}
            onPress={() => cycle('subLang', SUB_LANGS)}
          />
          {/* [player-options] how they look — the person's, the website's
              same six — with the sample drawn exactly as the player draws a cue */}
          <View style={styles.preview}>
            <SubStylePreview style={subStyle} sizePx={{S: 18, M: 24, L: 30, XL: 36}[subStyle.subSize]} />
          </View>
          {SUB_STYLE_KEYS.filter(k => k !== 'subOpacity' || subStyle.subBg === 'box').map((k: SubStyleKey) => (
            <Row
              key={k}
              uiId={STYLE_UI[k]}
              label={SUB_STYLE_SETTINGS[k][0]}
              note={SUB_STYLE_SETTINGS[k][1] || undefined}
              value={styleLabel(k, subStyle)}
              onPress={() => set(k, nextChoice(k, subStyle[k]) as never)}
            />
          ))}
        </View>

        {/* [player-options] the sound — the person's, the website's same two */}
        <Text style={styles.h2}>Sound</Text>
        <View style={styles.list}>
          {AUDIO_FX_KEYS.map(k => (
            <Row
              key={k}
              uiId={k === 'nightMode' ? 'settings.audio.night' : 'settings.audio.dialogue'}
              label={AUDIO_FX_NAMES[k]}
              note={fxWhy || AUDIO_FX_NOTES[k]}
              value={fxWhy ? 'Not here' : prefs[k] ? 'On' : 'Off'}
              // where it cannot apply the row says why, and a press says it again
              onPress={() => (fxWhy ? showToast(fxWhy, '🔈') : set(k, !prefs[k]))}
            />
          ))}
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
          <Row uiId="settings.notices"
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
        {/* [household] Recommendations (the person's, on the server) */}
        <HouseholdPrefs profileId={profileId} onSent={() => navigation.push('Household', {tab: 'sent'})} />
        <Text style={styles.h2}>Privacy</Text>
        <View style={styles.list}>
          <Row uiId="settings.usagestats"
            label="Usage stats"
            note="Which screens and features get used, and how long they took — to your own server only, never anything typed. Off here is off for you on every device."
            value={prefs.usageStats ? 'On' : 'Off'}
            onPress={() => set('usageStats', !prefs.usageStats)}
          />
        </View>

        <Text style={styles.h2}>This TV</Text>
        <View style={styles.list}>
          {/* [phone-remote] the name phones show for this TV ("Play on Living room TV"); the website's row is "This device's name" */}
          <Row uiId="settings.tvname"
            label="This TV's name"
            note="What your phone calls this TV when it plays something here or works as its remote."
            value={tvName || '…'}
            onPress={() => setTvNamePicker(o => !o)}
          />
          {tvNamePicker ? <TvNamePicker current={tvName} onClose={closeTvNamePicker} /> : null}
          {/* [/phone-remote] */}
          <Row uiId="settings.update"
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
            onLongPress={() => setDevRender(true)}
          />
        </View>
        {devRender ? <RenderDevPanel /> : null}

        {getSession() && !me?.kids ? (
          <>
            <Text style={styles.h2}>Account</Text>
            <Focusable uiId="settings.signout"
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

// [analytics] each subtitle-look row's uiId (one line: test/tel-contract reads tags line by line)
// prettier-ignore
const STYLE_UI: Record<SubStyleKey, string> = {subSize: 'settings.subs.size', subColor: 'settings.subs.color', subBg: 'settings.subs.bg', subOpacity: 'settings.subs.opacity', subWeight: 'settings.subs.weight', subPos: 'settings.subs.pos'}; // uiId

const styles = StyleSheet.create({
  hhMuteLine: {marginTop: spacing.md}, // [household]
  hhChips: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm}, // [household]
  hhSent: {marginTop: spacing.md}, // [household]
  // [player-options] the subtitle sample, as wide as a row
  preview: {marginVertical: spacing.sm, maxWidth: 900},
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
