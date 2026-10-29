// Settings on the phone — the website's Settings and the TV's, in the same
// sections and the same words: what you like, Aurora, playback, subtitles (the
// person's look, with its live sample), sound, downloads, saving to this phone,
// notifications, recommendations, privacy, this phone, the account. Everything
// that follows the PERSON (personPrefs.ts) goes to the profile on the server —
// change it here and the TV and the website have it too; what belongs to this
// phone stays on it (storage.ts).
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Switch, Text, View} from 'react-native';
import {api, getAuthMode, getBaseUrl, getSession, HouseholdSettings, setSession} from '../../api';
import {useApp} from '../../AppContext';
import {useMe} from '../../navSection';
import {openJoinParty, openReport} from '../../overlay';
import {loadPrefs, Prefs, PREFS_DEFAULTS, saveAuthSession, savePrefs} from '../../storage';
import {PERSON_KEYS, PersonKey, SUB_LANGS, SUB_LANG_LABEL} from '../../personPrefs';
import {onPersonPrefs, refreshPerson, setPersonPref} from '../../personSync';
import {showToast} from '../../toast';
import {setUsageEnabled} from '../../usage';
import {askNotificationPermission, setDownloadNotices} from '../../homeScreen';
import {SubStylePreview, useAudioFx} from '../../playerOptions';
import {nextChoice, readStyle, styleLabel, SUB_STYLE_KEYS, SUB_STYLE_SETTINGS, SubStyleKey} from '../../subStyle';
import {AUDIO_FX_KEYS, AUDIO_FX_NAMES, AUDIO_FX_NOTES} from '../../audioFx';
import {WORDS as HH} from '../../householdRecs';
import {householdChanged} from '../../householdLive';
import {pushPhone, usePNav} from '../nav';
import {BackBar, useColumn, usePageTop, useSolidBar} from '../ui/PageHead';
import ListRow from '../ui/Row';
import Glass from '../ui/Glass';
import Avatar from '../ui/Avatar';
import {ChipButton} from '../ui/Buttons';
import Icon from '../ui/Icon';
import {useTabBarSpace} from '../ui/TabBar';
import {resetTabs} from '../tabs';
import {OFFLINE_QUALITIES, offlinePrefs, setOfflinePrefs, useOfflineUsage} from '../offline/store';
import {colors, GUTTER} from '../theme';

import {PHONE_APP_VERSION as PHONE_VERSION} from '../../update';
import {checkNow} from '../update/store';

const Section = ({icon, title, sub, children}: {icon: React.ComponentProps<typeof Icon>['name']; title: string; sub?: string; children: React.ReactNode}) => (
  <Glass style={s.card}>
    <View style={s.head}>
      <View style={s.headIcon}>
        <Icon name={icon} size={18} color={colors.text} />
      </View>
      <View style={{flex: 1}}>
        <Text style={s.h2}>{title}</Text>
        {sub ? <Text style={s.headSub}>{sub}</Text> : null}
      </View>
    </View>
    {children}
  </Glass>
);

const Toggle = ({value, onChange, disabled}: {value: boolean; onChange: (v: boolean) => void; disabled?: boolean}) => (
  <Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{false: 'rgba(255,255,255,0.22)', true: colors.accentStrong}} thumbColor={value ? '#fff' : '#d8dae4'} />
);
const Value = ({text}: {text: string}) => <Text style={s.value}>{text}</Text>;

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
      householdChanged();
    } catch {
      setSt(before);
      showToast("Couldn't save that — try again in a moment", '⚠️');
    }
  };
  const mutedIds = (st?.people || []).filter(p => p.muted).map(p => p.id);
  return (
    <Section icon="send" title={HH.settingsSection}>
      <ListRow uiId="settings.hh.toggle" title={HH.settingsSwitch} detail={HH.settingsSwitchNote} right={<Toggle value={!!st?.on} disabled={!st} onChange={v => st && save({on: v}, {...st, on: v})} />} />
      {st && st.people.length ? (
        <>
          <Text style={s.note}>{HH.muteLine}</Text>
          <View style={s.chips}>
            {st.people.map(p => (
              <ChipButton uiId="settings.hh.mute"
                key={p.id}
                label={`${p.name} · ${p.muted ? HH.muted : HH.mute}`}
                active={p.muted}
                onPress={() => save({muted: p.muted ? mutedIds.filter(id => id !== p.id) : [...mutedIds, p.id]}, {...st, people: st.people.map(x => (x.id === p.id ? {...x, muted: !p.muted} : x))})}
              />
            ))}
          </View>
        </>
      ) : null}
      <ListRow uiId="settings.hh.sent" title="What you sent" detail="What you recommended, and whether each person saw it, put it on their list or watched it." chevron onPress={onSent} />
    </Section>
  );
}

export default function Settings() {
  const bar = useSolidBar();
  const pageTop = usePageTop();
  const column = useColumn();
  const navigation = usePNav();
  const {profileId, switchProfile} = useApp();
  const me = useMe(profileId);
  const bottom = useTabBarSpace();
  const [prefs, setPrefs] = useState<Prefs>(PREFS_DEFAULTS);
  const [checking, setChecking] = useState(false);
  const [genres, setGenres] = useState<string[] | null>(null);
  const [liked, setLiked] = useState<Set<string>>(new Set());
  const [notifyNote, setNotifyNote] = useState<string | null>(null);
  const [offline, setOffline] = useState(offlinePrefs());
  const usage = useOfflineUsage();
  const genreGroups = useRef(new Map<string, string[]>());

  useEffect(() => {
    loadPrefs().then(setPrefs);
    refreshPerson();
    return onPersonPrefs(person => setPrefs(cur => ({...cur, ...person})));
  }, []);
  useEffect(() => {
    let live = true;
    Promise.all([api.library(), api.state(profileId)])
      .then(([lib, st]) => {
        if (!live) return;
        const all = [...lib.movies, ...lib.shows].flatMap(i => i.genres || []);
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
  const spellingsOf = useCallback((label: string): string[] => {
    for (const [k, v] of genreGroups.current) if ((k === 'scifi' ? 'Sci-Fi' : v[0]) === label) return v;
    return [label];
  }, []);
  const toggleGenre = (g: string) => {
    const next = new Set(liked);
    const all = spellingsOf(g);
    const on = all.some(x => next.has(x));
    for (const x of all) on ? next.delete(x) : next.add(x);
    setLiked(next);
    api.setPreferences(profileId, [...next]).catch(() => {});
  };
  const set = useCallback(
    <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
      const next = {...prefs, [key]: value};
      setPrefs(next);
      if ((PERSON_KEYS as string[]).includes(key)) setPersonPref(key as PersonKey, value as never);
      else savePrefs(next);
      if (key === 'usageStats') setUsageEnabled(!!value);
    },
    [prefs],
  );
  const cycle = <K extends keyof Prefs>(key: K, values: Prefs[K][]) => set(key, values[(values.indexOf(prefs[key]) + 1) % values.length]);
  const subStyle = useMemo(
    () => readStyle(prefs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefs.subSize, prefs.subColor, prefs.subBg, prefs.subOpacity, prefs.subWeight, prefs.subPos],
  );
  const fxWhy = useAudioFx(prefs.nightMode === true, prefs.dialogueBoost === true, {perFilm: false});
  const signOut = async () => {
    try {
      await api.logout();
    } catch {}
    setSession(null);
    await saveAuthSession(null);
    resetTabs();
    switchProfile();
  };
  const gb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

  return (
    <View style={s.root}>
      <ScrollView onScroll={bar.onScroll} scrollEventThrottle={32} contentContainerStyle={[{paddingTop: pageTop, paddingBottom: bottom + 24, paddingHorizontal: GUTTER}, column]}>
        <Text style={s.h1} accessibilityRole="header">Settings</Text>
        <Text style={s.sub}>for {me?.name || 'this profile'}</Text>

        <Section icon="person" title="Your profile">
          <View style={s.me}>
            <Avatar p={me} size={56} />
            <View style={{flex: 1}}>
              <Text style={s.meName}>{me?.name || ''}</Text>
              <Text style={s.meSub}>{me?.hasPassword ? 'Password set' : 'No password set'}{me?.kids ? ` · Kids, up to ${me.kids.maxAge}` : ''}</Text>
            </View>
          </View>
          <ListRow uiId="phone.settings.switch" icon="swap" title={getAuthMode() === 'closed' ? 'Sign out' : 'Switch profile'} chevron onPress={() => (resetTabs(), switchProfile())} />
        </Section>

        <Section icon="sparkle" title="What you like" sub="Pick the genres you enjoy — Home leans its rows towards them.">
          {genres === null ? (
            <ActivityIndicator color={colors.text} style={{margin: 16, alignSelf: 'flex-start'}} />
          ) : !genres.length ? (
            <Text style={s.note}>Nothing to pick from yet — the library has no genres.</Text>
          ) : (
            <View style={s.chips}>
              {genres.map(g => (
                <ChipButton uiId="settings.genre" key={g} label={g} active={spellingsOf(g).some(x => liked.has(x))} onPress={() => toggleGenre(g)} />
              ))}
            </View>
          )}
        </Section>

        <Section icon="info" title="Aurora">
          <ListRow uiId="settings.downloads" icon="download" title="My downloads" detail="What you asked the server to fetch — ready, on its way, waiting. And what is saved on this phone." chevron onPress={() => navigation.push('Downloads', undefined)} />
          <ListRow uiId="phone.settings.remote" icon="remote" title="Your TVs" detail="Use this phone as the remote, or play something on a TV." chevron onPress={() => pushPhone('Remote', undefined)} />
          <ListRow uiId="settings.party" icon="people" title="Join a watch party" detail="Type the code from another screen and watch in step." chevron onPress={openJoinParty} />
          <ListRow uiId="settings.report" icon="warning" title="Report a problem" detail="A few words; where you were and the last errors come along by themselves." chevron onPress={() => openReport()} />
        </Section>

        <Section icon="play" title="Playback">
          <ListRow uiId="settings.autoplay" title="Autoplay next episode" detail="Start the next episode automatically when one finishes." right={<Toggle value={!!prefs.autoplayNext} onChange={v => set('autoplayNext', v)} />} />
        </Section>

        <Section icon="cc" title="Subtitles">
          <ListRow uiId="settings.subs.auto" title="Turn subtitles on automatically" detail="When a title offers subtitles, switch one on without asking." right={<Toggle value={!!prefs.subsDefault} onChange={v => set('subsDefault', v)} />} />
          <ListRow uiId="settings.subs.lang" title="Preferred subtitle language" detail="The language to pick. If a title doesn't have it, Aurora goes and gets it." right={<Value text={SUB_LANG_LABEL[prefs.subLang] || SUB_LANG_LABEL.any} />} onPress={() => cycle('subLang', SUB_LANGS)} />
          <View style={s.preview}>
            <SubStylePreview style={subStyle} sizePx={{S: 16, M: 20, L: 24, XL: 28}[subStyle.subSize]} />
          </View>
          {SUB_STYLE_KEYS.filter(k => k !== 'subOpacity' || subStyle.subBg === 'box').map((k: SubStyleKey) => (
            <ListRow key={k} title={SUB_STYLE_SETTINGS[k][0]} detail={SUB_STYLE_SETTINGS[k][1] || undefined} right={<Value text={styleLabel(k, subStyle)} />} onPress={() => set(k, nextChoice(k, subStyle[k]) as never)} />
          ))}
        </Section>

        <Section icon="volume" title="Sound">
          {AUDIO_FX_KEYS.map(k => (
            <ListRow
              key={k}
              title={AUDIO_FX_NAMES[k]}
              detail={fxWhy || AUDIO_FX_NOTES[k]}
              right={fxWhy ? <Value text="Not here" /> : <Toggle value={prefs[k] === true} onChange={v => set(k, v)} />}
              onPress={fxWhy ? () => showToast(fxWhy, '🔈') : undefined}
            />
          ))}
        </Section>

        {me?.kids ? null : (
          <Section icon="download" title="Downloads">
            <ListRow title="Get the next episode ready" detail="While you watch, Aurora fetches the next episode so it starts at once." right={<Toggle value={!!prefs.smartDownloads} onChange={v => set('smartDownloads', v)} />} />
            <ListRow title="Tidy up after watching" detail="Episodes Aurora fetched for you are removed once you've watched them. Nothing you saved yourself is touched." right={<Toggle value={!!prefs.smartCleanup} onChange={v => set('smartCleanup', v)} />} />
          </Section>
        )}

        <Section icon="downloadDevice" title="Saved on this phone" sub={usage.count ? `${usage.count} saved · ${gb(usage.bytes)} used · ${gb(usage.free)} free` : 'Nothing saved yet'}>
          <ListRow
            title="Quality"
            detail="What a film or an episode is saved at. Ask: choose each time, with the sizes."
            right={<Value text={(OFFLINE_QUALITIES.find(q => q.id === offline.quality) || OFFLINE_QUALITIES[0]).label} />}
            onPress={() => {
              const i = OFFLINE_QUALITIES.findIndex(q => q.id === offline.quality);
              const next = {...offline, quality: OFFLINE_QUALITIES[(i + 1) % OFFLINE_QUALITIES.length].id};
              setOffline(next);
              setOfflinePrefs(next);
            }}
          />
          <ListRow
            title="Save on Wi-Fi only"
            detail="Saves wait for Wi-Fi instead of using mobile data."
            right={
              <Toggle
                value={offline.wifiOnly}
                onChange={v => {
                  const next = {...offline, wifiOnly: v};
                  setOffline(next);
                  setOfflinePrefs(next);
                }}
              />
            }
          />
          <ListRow uiId="phone.settings.saved" icon="storage" title="On this phone" detail="Play, or remove, what is saved here." chevron onPress={() => navigation.push('Downloads', undefined)} />
        </Section>

        <Section icon="bell" title="Notifications">
          <ListRow
            title="Tell me when a download lands"
            detail={notifyNote || 'When something you asked for or follow has downloaded, this phone says so.'}
            right={
              <Toggle
                value={prefs.downloadNotices !== false}
                onChange={on => {
                  set('downloadNotices', on);
                  setDownloadNotices(on);
                  setNotifyNote(null);
                  if (on)
                    askNotificationPermission(true).then(ok => {
                      if (!ok) setNotifyNote('Android is not letting Aurora post notifications — allow them in Settings → Apps → Aurora → Notifications.');
                    });
                }}
              />
            }
          />
        </Section>

        <HouseholdPrefs profileId={profileId} onSent={() => navigation.push('Household', {tab: 'sent'})} />

        <Section icon="lock" title="Privacy">
          <ListRow uiId="settings.usagestats"
            title="Usage stats"
            detail="Which screens and features get used, and how long they took — to your own server only, never anything typed. Off here is off for you on every device."
            right={<Toggle value={prefs.usageStats !== false} onChange={v => set('usageStats', v)} />}
          />
        </Section>

        <Section icon="phone" title="This phone">
          <ListRow title={`Aurora for Android ${PHONE_VERSION}`} detail={`Connected to ${getBaseUrl().replace(/^https?:\/\//, '')}`} />
          <ListRow
            icon="downloadDevice"
            title="Check for updates"
            detail={checking ? 'Asking the server…' : 'A newer Aurora for this phone, from your server. Android asks you to confirm before it installs.'}
            uiId="settings.update"
            onPress={async () => {
              if (checking) return;
              setChecking(true);
              const r = await checkNow().catch(() => 'latest' as const);
              setChecking(false);
              if (r === 'latest') showToast(`You're on the latest version (${PHONE_VERSION})`, '✓');
            }}
          />
        </Section>

        {getSession() && !me?.kids ? (
          <Section icon="logout" title="Account">
            <ListRow uiId="settings.signout" icon="logout" title="Sign out on this phone" detail="Ends this phone's session — you'll sign in again with your password or a code." danger onPress={signOut} />
          </Section>
        ) : null}
      </ScrollView>
      <BackBar solid={bar.solid} noSettings />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  // the page's head is the site's .browse-head: "Settings" 24/900, "for <name>" 16/600 faint
  h1: {color: colors.text, fontSize: 24, fontWeight: '900', letterSpacing: -0.72, lineHeight: 36},
  sub: {color: colors.textFaint, fontSize: 16, fontWeight: '600', lineHeight: 24, marginTop: 2, marginBottom: 14},
  // .pref-section: a glass card 20 round, 18 / 20 inside, 16 apart
  card: {marginBottom: 16, paddingTop: 18, paddingBottom: 8},
  head: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 4},
  headIcon: {width: 34, height: 34, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center'},
  h2: {color: colors.text, fontSize: 17.6, fontWeight: '800', letterSpacing: -0.18, lineHeight: 26.4},
  headSub: {color: colors.textDim, fontSize: 14.4, marginTop: 4, lineHeight: 21.6},
  note: {color: colors.textDim, fontSize: 14.4, lineHeight: 21.6, paddingHorizontal: 20, marginTop: 4},
  value: {color: colors.textDim, fontSize: 14.4, fontWeight: '700'},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20, paddingVertical: 10},
  preview: {marginHorizontal: 20, marginVertical: 8},
  // .pref-profile: a 56 dp avatar, the name 16.8/800, "No password set" 13.44
  me: {flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 10},
  meName: {color: colors.text, fontSize: 16.8, fontWeight: '800', lineHeight: 25.2},
  meSub: {color: colors.textDim, fontSize: 13.44, lineHeight: 20.2, marginTop: 2},
});
