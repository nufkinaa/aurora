// Search across the downloaded library AND streamable (Discover) titles.
// Local hits show instantly; stream results arrive from the debounced server
// search. Selecting a result routes to Detail.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, TextInput, FlatList, StyleSheet} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Card, {CARD_W} from '../components/Card';
import NavRail from '../components/NavRail';
import {api, HeroItem, Item} from '../api';
import {canNavigate} from '../navLock';
import {noteFocus, railOpen, useFocusFallback, useTVKeys} from '../focus';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

const {colors, radius, fontSize, spacing, CLEARANCE} = theme;
const norm = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export default function Search({
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'Search'>) {
  const {width, safeBottom} = useTvMetrics();
  // How many posters actually fit. The row width used to be hardcoded to six
  // columns (6*150 + 5*16 = 980dp) inside an 864dp content box, so every row
  // ran off the right edge of the screen.
  const cols = Math.max(
    3,
    Math.floor((width - spacing.contentLeft - spacing.pageX + spacing.md) / (CARD_W + spacing.md)),
  );
  const [q, setQ] = useState('');
  const [libAll, setLibAll] = useState<Item[]>([]);
  const [results, setResults] = useState<HeroItem[]>([]);
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
  // card, so UP from the results could never reach the input.
  const inGrid = useRef(false);
  const gridIdx = useRef(0);
  useTVKeys(
    useCallback(
      (evt: {eventType: string}) => {
        if (evt.eventType !== 'up') return;
        // Never while the nav rail's panel is up (see Browse's escape) — this
        // one would even summon the IME on top of the open rail.
        if (railOpen()) return;
        if (!inGrid.current || gridIdx.current >= cols) return;
        inGrid.current = false;
        inputRef.current?.focus();
      },
      [cols],
    ),
  );
  const onCardFocus = useCallback((_item: HeroItem, index: number) => {
    inGrid.current = true;
    gridIdx.current = index;
  }, []);

  useEffect(() => {
    let live = true;
    api
      .library()
      .then(l => live && setLibAll([...l.movies, ...l.shows]))
      .catch(() => {});
    return () => {
      live = false;
      // A pending debounce (and its request) must die with the screen.
      if (debounce.current) clearTimeout(debounce.current);
      reqId.current++;
    };
  }, []);

  const run = useCallback(
    (text: string, lib: Item[]) => {
      setQ(text);
      if (debounce.current) clearTimeout(debounce.current);
      const query = text.trim();
      if (!query) {
        // Invalidate the in-flight request too — without this, clearing the box
        // let a late response repopulate the grid for a query no longer shown.
        reqId.current++;
        setResults([]);
        return;
      }
      // instant local hits
      const ql = norm(query);
      const local: HeroItem[] = lib
        .filter(i => norm(i.title).includes(ql))
        .map(i => ({...i, source: 'downloaded' as const}));
      setResults(local);
      // server (stream) results, debounced + race-guarded
      debounce.current = setTimeout(async () => {
        const mine = ++reqId.current;
        try {
          const d = await api.discoverSearch(query);
          if (mine !== reqId.current) return; // superseded
          const libTitles = new Set(lib.map(i => norm(i.title)));
          const stream = [...d.movies, ...d.shows]
            .filter(m => m.imdbId && !libTitles.has(norm(m.title)))
            .map(i => ({...i, source: 'stream' as const}));
          setResults([...local, ...stream]);
        } catch {}
      }, 350);
    },
    [],
  );

  // The library loads asynchronously; a query typed before it landed showed no
  // downloaded matches and nothing would ever recompute them. MERGE the local
  // hits in front of whatever stream results are already on screen — re-running
  // the whole query here would wipe rendered stream rows (unmounting a focused
  // card) and re-arm the server debounce for nothing.
  const qRef = useRef('');
  qRef.current = q;
  useEffect(() => {
    const query = qRef.current.trim();
    if (!libAll.length || !query) return;
    const ql = norm(query);
    const local: HeroItem[] = libAll
      .filter(i => norm(i.title).includes(ql))
      .map(i => ({...i, source: 'downloaded' as const}));
    const libTitles = new Set(libAll.map(i => norm(i.title)));
    setResults(prev => [
      ...local,
      ...prev.filter(m => m.source === 'stream' && !libTitles.has(norm(m.title))),
    ]);
  }, [libAll]);

  const openDetail = useCallback(
    (item: HeroItem) => {
      if (!canNavigate(navigation)) return;
      navigation.push('Detail', {item});
    },
    [navigation],
  );
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

  return (
    <View style={styles.root}>
      <NavRail active="search" />
      <View style={styles.body}>
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={q}
        onChangeText={t => run(t, libAll)}
        autoFocus
        // The input is not a Focusable, so it never wrote to focus.ts — the rail
        // was still reading whatever the LAST screen's element reported, and
        // when that said "left edge", pressing LEFT to move the text caret
        // opened the nav rail over the keyboard. While the field has focus,
        // LEFT belongs to the field.
        onFocus={() => {
          inGrid.current = false;
          noteFocus(null, false);
        }}
        placeholder="Search movies & shows…"
        placeholderTextColor={colors.textFaint}
      />
      {q.trim() && results.length === 0 ? (
        <Text style={styles.empty}>No matches yet…</Text>
      ) : null}
      <FlatList
        data={results}
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
  rowGap: {gap: spacing.md, marginBottom: spacing.md},
});
