// Search on the phone — the website's search: one field at the top with the
// mic, your recent searches and "Popular in this house" while it is empty,
// suggestions (a title, a person, a genre) as you type, then the results and
// the related row. ONE search, the website's and the TV's (searchFlow.ts
// runSearch: what the server has at once, then the live catalogue, one retry,
// and a failure said as a failure); voice is the TV's VoiceModule (Android's
// recogniser) with the shared spoken-query rules (the server tidies what was
// heard — media/spoken.js).
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, BackHandler, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useIsFocused, useRoute, RouteProp} from '@react-navigation/native';
import {api, HeroItem, SearchAnswer, SearchSuggestion} from '../../api';
import {useApp} from '../../AppContext';
import {openItem} from '../../openItem';
import {track} from '../../usage';
import {createVoice, nativeVoiceDeps, voiceAvailability, VoiceController} from '../../voice';
import {LANG_NAME, LANG_SELF, otherLang, voiceActive, voiceLangFor, VoiceLang, voiceMessage, VoiceState, VOICE_IDLE} from '../../voiceLogic';
import {personNow, setPersonPref} from '../../personSync';
import {noResultsText, runSearch, SEARCH_TEXT, SettleNote, shortText} from '../../searchFlow';
import type {RootStackParamList} from '../../navigation';
import {usePNav} from '../nav';
import Grid from '../ui/Grid';
import {ChipButton, GlassButton} from '../ui/Buttons';
import SearchBox from '../ui/SearchBox';
import TopBar, {useBarTop} from '../ui/TopBar';
import {BackBar, useSolidBar} from '../ui/PageHead';
import Tap from '../ui/Tap';
import {PosterCard} from '../ui/Cards';
import {useTabBarSpace} from '../ui/TabBar';
import {onReselect, useTab} from '../tabs';
import {phoneNative} from '../native';
import {colors, GUTTER, radius} from '../theme';

const EMPTY: SearchAnswer = {results: [], related: [], relatedLabel: null, pending: false};
const clip = (s: string) => (s.length > 34 ? `${s.slice(0, 33)}…` : s);
const chipLabel = (s: SearchSuggestion) =>
  s.kind === 'person' ? `${clip(s.name || '')} · person` : s.kind === 'genre' ? `${s.name} · genre` : `${clip(s.title || '')}${s.year ? ` (${s.year})` : ''}`;

export function SearchScreen({pushed, startVoice: startWithVoice, startQ}: {pushed?: boolean; startVoice?: boolean; startQ?: string}) {
  const navigation = usePNav();
  const focused = useIsFocused();
  const tab = useTab();
  const shownTab = pushed || tab === 'search';
  const {profileId} = useApp();
  const barTop = useBarTop();
  const bar = useSolidBar();
  const bottom = useTabBarSpace();
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<SearchAnswer>(EMPTY);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [popular, setPopular] = useState<HeroItem[]>([]);
  const [busyText, setBusyText] = useState<string | null>(null);
  const [note, setNote] = useState<SettleNote>(null);
  const [phase, setPhase] = useState<'idle' | 'searching' | 'done'>('idle');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqId = useRef(0);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    let live = true;
    api.recentSearches(profileId).then(r => live && setRecent(r.items || [])).catch(() => {});
    api
      .popular(profileId)
      .then(r => live && setPopular((r.items || []).map(i => ({...i, source: 'downloaded' as const}))))
      .catch(() => {});
    const req = reqId;
    return () => {
      live = false;
      if (debounce.current) clearTimeout(debounce.current);
      req.current++;
    };
  }, [profileId]);

  const remember = useCallback(
    (text: string) => {
      const query = text.trim();
      if (query.length < 2) return;
      api.addRecentSearch(profileId, query).then(r => setRecent(r.items || [])).catch(() => {});
    },
    [profileId],
  );

  const run = useCallback(
    (text: string, now = false, voice = false) => {
      setQ(text);
      if (debounce.current) clearTimeout(debounce.current);
      const query = text.trim();
      const mine = ++reqId.current;
      if (!query) {
        setAnswer(EMPTY);
        setSuggestions([]);
        setPhase('idle');
        setNote(null);
        setBusyText(null);
        return;
      }
      setPhase('searching');
      setNote(null);
      setBusyText(SEARCH_TEXT.searching);
      debounce.current = setTimeout(
        async () => {
          const current = () => mine === reqId.current;
          api
            .searchSuggest(query, profileId)
            .then(s => current() && setSuggestions(now ? [] : s.suggestions || []))
            .catch(() => {});
          let shown = query;
          let remembered = false;
          const done = await runSearch<SearchAnswer>({
            ask: ({wait, pin}) => api.searchAll(query, {wait, commit: now, voice, pin: pin || undefined, profileId}),
            paint: (r, step) => {
              if (voice && r.q && r.q !== shown) {
                shown = r.q;
                setQ(r.q);
              }
              setAnswer(r);
              if (now && !remembered && r.results.length) {
                remembered = true;
                remember(shown);
              }
              if (step === 'local') track('feat', {f: 'search', hits: r.results.filter(i => i.source !== 'stream').length});
            },
            busy: setBusyText,
            live: current,
            committed: now,
            q: query,
          });
          if (!done || !current()) return;
          if (!done.answer) setAnswer(EMPTY);
          setNote(done.note);
          setPhase('done');
        },
        now ? 0 : 250,
      );
    },
    [profileId, remember],
  );
  const runRef = useRef(run);
  runRef.current = run;

  // ---- voice ----
  const [voice, setVoice] = useState<VoiceState>(VOICE_IDLE);
  const voiceCtl = useRef<VoiceController | null>(null);
  const beforeVoice = useRef('');
  const qRef = useRef('');
  qRef.current = q;
  useEffect(() => {
    const c = createVoice(nativeVoiceDeps(), s => {
      setVoice(s);
      if (s.phase === 'listening' && s.interim) setQ(s.interim);
      if (s.phase === 'heard') {
        c.done();
        runRef.current(s.text, true, true);
      }
    });
    voiceCtl.current = c;
    return () => {
      c.dispose();
      voiceCtl.current = null;
    };
  }, []);
  const startVoice = useCallback(async (lang?: VoiceLang) => {
    const c = voiceCtl.current;
    if (!c) return;
    phoneNative.haptic('tick');
    inputRef.current?.blur();
    if (!voiceActive(c.state())) beforeVoice.current = qRef.current;
    const avail = await voiceAvailability();
    c.start(lang || voiceLangFor(personNow()?.voiceLang, avail?.locale));
  }, []);
  const listening = voiceActive(voice);
  useEffect(() => {
    if (!listening) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      voiceCtl.current?.cancel();
      setQ(beforeVoice.current);
      return true;
    });
    return () => sub.remove();
  }, [listening]);
  // leaving the screen / the tab stops listening
  useEffect(() => {
    if ((!focused || !shownTab) && voiceCtl.current && voiceActive(voiceCtl.current.state())) voiceCtl.current.cancel();
  }, [focused, shownTab]);
  // opened to listen (a link, the app shortcut) or with words
  useEffect(() => {
    if (startQ) run(startQ, true);
    else if (startWithVoice) setTimeout(() => startVoice(), 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // the Search tab tapped again: the field, keyboard up
  useEffect(() => onReselect(t => t === 'search' && inputRef.current?.focus()), []);

  const open = useCallback((it: HeroItem) => openItem(navigation, it), [navigation]);
  const pickSuggestion = (s: SearchSuggestion) => {
    if (s.kind === 'title' && (s.id || s.imdbId)) {
      remember(s.title || q);
      openItem(navigation, {
        id: s.id || '',
        imdbId: s.imdbId,
        type: s.type,
        title: s.title || '',
        year: s.year || undefined,
        cover: s.cover,
        source: s.inLibrary ? 'downloaded' : 'stream',
      } as HeroItem);
      return;
    }
    run(s.kind === 'person' || s.kind === 'genre' ? s.name || '' : s.title || '', true);
  };

  const voiceText = voiceMessage(voice, 'tv') || (listening ? `Listening in ${LANG_NAME[voice.lang]}` : '');
  const noteText =
    note === 'offline'
      ? SEARCH_TEXT.offline
      : note === 'unreachable'
      ? SEARCH_TEXT.unreachable
      : note === 'partial'
      ? SEARCH_TEXT.partial
      : note === 'short'
      ? shortText(q.trim())
      : note === 'none'
      ? noResultsText(q.trim())
      : null;
  const idle = !q.trim();

  const head = (
    <View style={{paddingTop: barTop + 86}}>
      {/* .search-wrap: the site's one field, 16 in, the mic inside it */}
      <View style={s.fieldRow}>
        <SearchBox
          ref={inputRef}
          value={q}
          onChangeText={t => run(t)}
          onSubmitEditing={() => run(q, true)}
          onClear={() => run('')}
          placeholder="Search movies and shows…"
          accessibilityLabel="Search"
          onMic={() => (listening ? voiceCtl.current?.stop() : startVoice())}
          listening={listening}
          micLabel={listening ? 'Stop listening' : 'Search by voice'}
          style={{flex: 1}}
        />
      </View>
      {voiceText ? (
        <View style={s.voice}>
          <Text style={s.voiceText}>{voiceText}</Text>
          {listening ? (
            <ChipButton uiId="search.voice.lang"
              label={LANG_SELF[otherLang(voice.lang)]}
              onPress={() => {
                const next = otherLang(voice.lang);
                setPersonPref('voiceLang', next);
                startVoice(next);
              }}
            />
          ) : null}
        </View>
      ) : null}
      {idle && recent.length ? (
        <View style={s.block}>
          <View style={s.blockHead}>
            <Text style={s.blockTitle}>Recent searches</Text>
            <Tap
              flat
              onPress={() =>
                api
                  .removeRecentSearch(profileId)
                  .then(r => setRecent(r.items || []))
                  .catch(() => {})
              }>
              <Text style={s.link}>Clear</Text>
            </Tap>
          </View>
          <View style={s.wrap}>
            {recent.map(r => (
              <ChipButton uiId="search.recent.pick" key={r} label={r} icon="clock" onPress={() => run(r, true)} />
            ))}
          </View>
        </View>
      ) : null}
      {idle && popular.length ? (
        <View style={s.block}>
          <Text style={[s.blockTitle, {paddingHorizontal: GUTTER}]}>Popular in this house</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.shelf}>
            {popular.map((it, i) => (
              <PosterCard key={`${it.id}-${i}`} item={it} onPress={open} />
            ))}
          </ScrollView>
        </View>
      ) : null}
      {!idle && suggestions.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={s.shelf}>
          {suggestions.map((sg, i) => (
            <ChipButton uiId="search.suggestion.pick" key={`${sg.kind}-${i}`} label={chipLabel(sg)} icon={sg.kind === 'person' ? 'person' : sg.kind === 'genre' ? 'sparkle' : 'search'} onPress={() => pickSuggestion(sg)} />
          ))}
        </ScrollView>
      ) : null}
      {!idle && busyText ? (
        <View style={s.busy}>
          <ActivityIndicator color={colors.textDim} size="small" />
          <Text style={s.busyText}>{busyText}</Text>
        </View>
      ) : null}
      {!idle && noteText && phase === 'done' ? (
        <View style={s.noteBox}>
          <Text style={s.noteText}>{noteText}</Text>
          {note === 'offline' || note === 'unreachable' ? <GlassButton uiId="search.retry" label={SEARCH_TEXT.retry} icon="refresh" onPress={() => run(q, true)} style={{alignSelf: 'flex-start'}} /> : null}
        </View>
      ) : null}
    </View>
  );
  const related = answer.related || [];
  const foot =
    !idle && related.length ? (
      <View style={s.block}>
        <Text style={[s.blockTitle, {paddingHorizontal: GUTTER}]}>{answer.relatedLabel || 'Related'}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.shelf}>
          {related.map((it, i) => (
            <PosterCard key={`${it.key || it.id}-${i}`} item={it} onPress={open} />
          ))}
        </ScrollView>
      </View>
    ) : null;
  return (
    <View style={s.root}>
      <Grid items={idle ? [] : answer.results} onPress={open} header={head} footer={foot} bottomPad={bottom + 16} onScroll={bar.onScroll} />
      {pushed ? <BackBar solid={bar.solid} /> : <TopBar solid={bar.solid} />}
    </View>
  );
}

export default function SearchTab() {
  return <SearchScreen />;
}

/** The pushed route (a link, voice from elsewhere). */
export function SearchRoute() {
  const route = useRoute<RouteProp<RootStackParamList, 'Search'>>();
  return <SearchScreen pushed startVoice={!!route.params?.voice} startQ={route.params?.q} />;
}

const s = StyleSheet.create({
  root: {flex: 1},
  // .search-wrap: 16 in, 10 under the field
  fieldRow: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: GUTTER, paddingBottom: 10},
  voice: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: GUTTER, paddingVertical: 8},
  voiceText: {flex: 1, color: colors.text, fontSize: 16, fontWeight: '700'},
  block: {marginTop: 14},
  blockHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: GUTTER},
  blockTitle: {color: colors.text, fontSize: 17.6, fontWeight: '800', letterSpacing: -0.18, lineHeight: 26.4, marginBottom: 10},
  link: {color: colors.accent, fontSize: 15, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 14},
  wrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: GUTTER},
  shelf: {paddingHorizontal: GUTTER, gap: 9, paddingBottom: 6},
  busy: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: GUTTER, paddingVertical: 10},
  busyText: {color: colors.textDim, fontSize: 15},
  noteBox: {marginHorizontal: GUTTER, marginVertical: 12, padding: 16, borderRadius: radius.l, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge, gap: 12},
  noteText: {color: colors.text, fontSize: 16},
});
