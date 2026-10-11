// Search: the server's one ranked search (/api/search v2 — the same answer and
// the same order the website shows): the title you typed first, library and
// catalogue together, typo-tolerant, episode and cast names included, then a
// "More like …" tail. The TV used to filter the library list itself by
// substring and append the catalogue under it.
//
// Typing on a remote is slow, so the band under the field does the work:
//   an empty field   the profile's recent searches (kept on the server, the
//                    same list as the phone's) over "Popular in this house"
//   while typing     suggestions — a title opens it, a person or a genre
//                    searches for it
// Selecting a result routes to Detail.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, TextInput, FlatList, StyleSheet} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Card, {CARD_W} from '../components/Card';
import Chip from '../components/Chip';
import NavRail from '../components/NavRail';
import {api, HeroItem, SearchAnswer, SearchSuggestion} from '../api';
import {track} from '../usage';
import {tmLap, tmStart} from '../telemetry'; // [analytics]
import {canNavigate} from '../navLock';
import {warmItem} from '../prefetch';
import {noteFocus, noteOwnFocusMove, pressMovedFocus, railOpen, useFocusFallback, useTVKeys} from '../focus';
import {useRouteShown} from '../useRouteShown';
import {useApp} from '../AppContext';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

const {colors, radius, fontSize, spacing, CLEARANCE} = theme;
const EMPTY: SearchAnswer = {results: [], related: [], relatedLabel: null, pending: false};
// A chip is one line: a long title is cut, the year tells two "Dune"s apart.
const clip = (s: string) => (s.length > 30 ? `${s.slice(0, 29)}…` : s);
const chipLabel = (s: SearchSuggestion) =>
  s.kind === 'person'
    ? `${clip(s.name || '')} · person`
    : s.kind === 'genre'
      ? `${s.name} · genre`
      : `${clip(s.title || '')}${s.year ? ` (${s.year})` : ''}`;

export default function Search({
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'Search'>) {
  const {width, safeBottom} = useTvMetrics();
  const {profileId} = useApp();
  // How many posters actually fit. The row width used to be hardcoded to six
  // columns (6*150 + 5*16 = 980dp) inside an 864dp content box, so every row
  // ran off the right edge of the screen.
  const cols = Math.max(
    3,
    Math.floor((width - spacing.contentLeft - spacing.pageX + spacing.md) / (CARD_W + spacing.md)),
  );
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<SearchAnswer>(EMPTY);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [popular, setPopular] = useState<HeroItem[]>([]);
  // searching / failed / done, told apart on screen (they used to share one line)
  const [phase, setPhase] = useState<'idle' | 'searching' | 'failed' | 'done'>('idle');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqId = useRef(0);
  // The input, adapted to the shape useFocusFallback wants: TextInput is not a
  // Focusable, so if the focused result card unmounts (a new result set lands),
  // focus returns to the field rather than nowhere.
  const inputRef = useRef<TextInput>(null);
  const inputFallback = useRef({requestTVFocus: () => inputRef.current?.focus()});
  useFocusFallback(inputFallback);
  // UP OUT OF THE GRID, DETERMINISTICALLY — same platform failure and fix as
  // Browse: the native focus search regularly finds nothing above a top-row
  // card, so UP from the results could never reach what is above them. The
  // band directly above the grid is the chips row when it has chips (as on
  // My List), the field otherwise; UP from the chips is the field.
  const inGrid = useRef(false);
  const gridIdx = useRef(0);
  const inChips = useRef(false);
  const firstChipRef = useRef(null);
  const hasChips = useRef(false);
  useTVKeys(
    useCallback(
      (evt: {eventType: string}) => {
        if (evt.eventType !== 'up') return;
        // Never while the nav rail's panel is up (see Browse's escape) — this
        // one would even summon the IME on top of the open rail.
        if (railOpen()) return;
        // JS hears this UP on its RELEASE; Android already moved focus on the
        // key-down. So the UP that carried focus from the second row INTO the
        // top row (or from the top row into the chips, when the native search
        // did find them) must not also be read as "UP from the top row" (or
        // "UP from the chips") and jump a second band — focus.ts
        // pressMovedFocus. A press that STARTS there moved nothing, and acts.
        if (pressMovedFocus()) return;
        if (inChips.current) {
          inChips.current = false;
          noteOwnFocusMove();
          inputRef.current?.focus();
          return;
        }
        if (!inGrid.current || gridIdx.current >= cols) return;
        inGrid.current = false;
        noteOwnFocusMove();
        const chip = hasChips.current ? (firstChipRef.current as {requestTVFocus?: () => void} | null) : null;
        if (chip?.requestTVFocus) chip.requestTVFocus();
        else inputRef.current?.focus();
      },
      [cols],
    ),
  );
  const onCardFocus = useCallback((item: HeroItem, index: number) => {
    warmItem(item);
    inGrid.current = true;
    inChips.current = false;
    gridIdx.current = index;
  }, []);
  const onChipFocus = useCallback((f: boolean) => {
    if (f) {
      inChips.current = true;
      inGrid.current = false;
    }
  }, []);

  // usage stats: this screen's content is on (routeTiming.ts) — the shelf
  // under the empty field has arrived, or was refused
  const [shown, setShown] = useState(false);
  useRouteShown(shown);
  useEffect(() => {
    let live = true;
    // Everything on this screen was asked AS a profile (recents, the popular
    // shelf, results filtered for a kids profile): none of it outlives it.
    setRecent([]);
    setPopular([]);
    setAnswer(EMPTY);
    setSuggestions([]);
    setQ('');
    setPhase('idle');
    if (profileId) {
      api.recentSearches(profileId).then(r => live && setRecent(r.items || [])).catch(() => {});
      api
        .popular(profileId)
        .then(r => live && setPopular((r.items || []).map(i => ({...i, source: 'downloaded' as const}))))
        .catch(() => {})
        .then(() => live && setShown(true));
    } else {
      setShown(true);
    }
    return () => {
      live = false;
      // A pending debounce (and its request) must die with the screen.
      if (debounce.current) clearTimeout(debounce.current);
      reqId.current++;
    };
  }, [profileId]);

  const remember = useCallback(
    (text: string) => {
      const query = text.trim();
      if (!profileId || query.length < 2) return;
      api.addRecentSearch(profileId, query).then(r => setRecent(r.items || [])).catch(() => {});
    },
    [profileId],
  );

  // `now`: OK on the keyboard, a recent, a person or a genre — no typing pause
  // to wait out, and the catalogue is asked whatever the length.
  const run = useCallback(
    (text: string, now = false) => {
      setQ(text);
      if (debounce.current) clearTimeout(debounce.current);
      const query = text.trim();
      // Invalidate whatever is in flight — a late answer must never repaint
      // the grid for a query that is no longer in the field.
      const mine = ++reqId.current;
      if (!query) {
        setAnswer(EMPTY);
        setSuggestions([]);
        setPhase('idle');
        return;
      }
      setPhase('searching');
      debounce.current = setTimeout(
        async () => {
          const current = () => mine === reqId.current;
          api
            .searchSuggest(query, profileId)
            .then(s => current() && setSuggestions(now ? [] : s.suggestions || []))
            .catch(() => {});
          try {
            // what the server has in memory, at once…
            tmStart('search'); // [analytics] query sent → results shown (the time only; never the text)
            let r = await api.searchAll(query, {commit: now, profileId});
            if (!current()) return;
            setAnswer(r);
            tmLap('search_results', 'search', 'library'); // [analytics]
            track('feat', {f: 'search', hits: r.results.filter(i => i.source !== 'stream').length}); // how often, never what (as the site)
            // …then the live catalogue and the related row; the first card
            // stays where it is unless something matches better
            if (r.pending) {
              r = await api.searchAll(query, {wait: true, commit: now, pin: r.results[0]?.key, profileId});
              if (!current()) return;
              setAnswer(r);
              tmLap('search_results', 'search', 'catalogue'); // [analytics]
            }
            setPhase('done');
            if (now && r.results.length) remember(query);
          } catch {
            if (current()) setPhase('failed');
          }
        },
        now ? 0 : 250,
      );
    },
    [profileId, remember],
  );

  const qRef = useRef('');
  qRef.current = q;
  const openDetail = useCallback(
    (item: HeroItem) => {
      if (!canNavigate(navigation)) return;
      // opening a result is what makes a search worth remembering
      if (qRef.current.trim()) remember(qRef.current);
      navigation.push('Detail', {item});
    },
    [navigation, remember],
  );
  const pickSuggestion = useCallback(
    (s: SearchSuggestion) => {
      if (s.kind === 'person' || s.kind === 'genre') return run(s.name || '', true);
      openDetail({
        id: s.id || '',
        imdbId: s.imdbId,
        type: s.type,
        title: s.title || '',
        year: s.year || undefined,
        cover: s.cover,
        poster: s.cover,
        inLibrary: s.inLibrary && s.id ? s.id : null,
        source: s.inLibrary ? 'downloaded' : 'stream',
      });
    },
    [run, openDetail],
  );
  const clearRecent = useCallback(() => {
    setRecent([]);
    if (profileId) api.removeRecentSearch(profileId).catch(() => {});
    inChips.current = false;
    inputRef.current?.focus();
  }, [profileId]);

  const query = q.trim();
  const data = query ? answer.results : popular;
  const renderCard = useCallback(
    ({item, index}: {item: HeroItem; index: number}) => (
      <Card
        item={item}
        index={index}
        onPress={openDetail}
        onFocus={onCardFocus}
        edgeLeft={index % cols === 0}
      />
    ),
    [openDetail, cols, onCardFocus],
  );
  // The related tail: its heading, then the grid goes on. In the footer (a
  // divider cannot sit inside a multi-column list) — eighteen cards at most.
  const related = query ? answer.related : [];
  const footer = useMemo(() => {
    if (!related.length) return null;
    const first = answer.results.length ? cols : 0; // never mistaken for the grid's top row
    const rows: HeroItem[][] = [];
    for (let i = 0; i < related.length; i += cols) rows.push(related.slice(i, i + cols));
    return (
      <View>
        <Text style={styles.heading}>{answer.relatedLabel}</Text>
        {rows.map((row, r) => (
          <View key={r} style={styles.rowGap}>
            {row.map((item, c) => (
              <Card
                key={`${item.id || item.imdbId}-${c}`}
                item={item}
                index={first + r * cols + c}
                onPress={openDetail}
                onFocus={onCardFocus}
                edgeLeft={c === 0}
              />
            ))}
          </View>
        ))}
      </View>
    );
  }, [related, answer.results.length, answer.relatedLabel, cols, openDetail, onCardFocus]);

  // The band under the field.
  const chips = query ? suggestions.slice(0, 6) : [];
  const recents = query ? [] : recent.slice(0, 6);
  hasChips.current = chips.length > 0 || recents.length > 0;
  const nothing = query && phase === 'done' && !answer.results.length && !related.length;

  return (
    <View style={styles.root}>
      <NavRail active="search" />
      <View style={styles.body}>
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={q}
        onChangeText={t => run(t)}
        onSubmitEditing={() => run(qRef.current, true)}
        returnKeyType="search"
        autoFocus
        // The input is not a Focusable, so it never wrote to focus.ts — the rail
        // was still reading whatever the LAST screen's element reported, and
        // when that said "left edge", pressing LEFT to move the text caret
        // opened the nav rail over the keyboard. While the field has focus,
        // LEFT belongs to the field.
        onFocus={() => {
          inGrid.current = false;
          inChips.current = false;
          noteFocus(null, false);
        }}
        placeholder="Search movies & shows…"
        placeholderTextColor={colors.textFaint}
      />
      {chips.length > 0 ? (
        <View style={styles.chips}>
          {chips.map((s, at) => (
            <Chip
              uiId="search.suggestion.pick"
              key={`${s.kind}-${s.id || s.imdbId || s.name}`}
              ref={at === 0 ? firstChipRef : undefined}
              small
              label={chipLabel(s)}
              edgeLeft={at === 0}
              onFocusChange={onChipFocus}
              onPress={() => pickSuggestion(s)}
            />
          ))}
        </View>
      ) : null}
      {recents.length > 0 ? (
        <View style={styles.chips}>
          <Text style={styles.bandLabel}>Recent</Text>
          {recents.map((r, at) => (
            <Chip
              uiId="search.recent.pick"
              key={r}
              ref={at === 0 ? firstChipRef : undefined}
              small
              label={clip(r)}
              edgeLeft={at === 0}
              onFocusChange={onChipFocus}
              onPress={() => run(r, true)}
            />
          ))}
          <Chip small bare label="Clear" onFocusChange={onChipFocus} onPress={clearRecent} />
        </View>
      ) : null}
      {query && phase === 'searching' && !answer.results.length ? (
        <Text style={styles.empty}>Searching…</Text>
      ) : null}
      {query && phase === 'failed' ? (
        <Text style={styles.empty}>Couldn't reach the server — check the connection and type again.</Text>
      ) : null}
      {nothing ? <Text style={styles.empty}>No results for “{query}”.</Text> : null}
      {!query && popular.length > 0 ? <Text style={styles.heading}>Popular in this house</Text> : null}
      <FlatList
        data={data}
        style={styles.listFill}
        numColumns={cols}
        key={`cols-${cols}`}
        keyExtractor={(it, i) => `${it.id || it.imdbId}-${i}`}
        columnWrapperStyle={styles.rowGap}
        contentContainerStyle={[styles.grid, {paddingBottom: CLEARANCE.below + safeBottom}]}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={5}
        renderItem={renderCard}
        ListFooterComponent={footer}
      />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // No backgroundColor: android:windowBackground is already this colour, and
  // painting it again cost a second full-screen fill on every frame.
  // Padding lives on `body`, not root: the header has to span the full width
  // like the site's does, so it cannot sit inside the page gutter.
  root: {flex: 1},
  body: {
    flex: 1,
    paddingLeft: spacing.contentLeft,
    paddingRight: spacing.pageX,
    paddingTop: 27,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.m,
    color: colors.text,
    fontSize: fontSize.row,
    paddingVertical: 16,
    paddingHorizontal: 22,
    marginBottom: spacing.lg,
  },
  // suggestions / recent searches: one wrapped band of small pills
  chips: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: spacing.md, zIndex: 10},
  bandLabel: {color: colors.textFaint, fontSize: fontSize.small, fontWeight: '700', marginRight: 4},
  // a row heading, as the site's `.row-title` over the related tail and the popular shelf
  heading: {color: colors.text, fontSize: fontSize.row, fontWeight: '800', marginTop: spacing.sm, marginBottom: spacing.md},
  empty: {color: colors.textDim, fontSize: fontSize.body, marginBottom: spacing.md},
  // Vertical FlatLists need flex here: on TV the list is wrapped in a focus
  // guide that mirrors this style (see the virtualized-lists patch); without
  // it the list sizes to its content and overflows the screen instead of
  // scrolling inside it.
  listFill: {flex: 1},
  // paddingTop leaves room for the focus scale on the top row (see Browse).
  // safeBottom belongs HERE (scrolled content), not on the list's own style —
  // there it shrank the viewport instead of extending the content, twice (the
  // focus-guide wrapper mirrors the list style; see the virtualized-lists patch).
  grid: {paddingTop: CLEARANCE.above, paddingBottom: CLEARANCE.below, gap: spacing.md},
  rowGap: {flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md},
});
