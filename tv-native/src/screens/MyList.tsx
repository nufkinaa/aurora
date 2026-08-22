// My List — the site's `myListScreen` (public/js/screens/browse.js:143-260).
//
// The page where how far you got with each title IS the point: a list you keep
// adding to is only useful if you can ask it "what haven't I started", "what did
// I leave half-watched", "what did I pull onto this laptop last week". So it
// carries a genre picker, a sort picker and up to seven either/or chips — none of
// which this screen had before.
//
// One sort is dropped: "Saved to device" reads `localStorage` on the site
// (`downloadPicker.js:49-52`), which has no meaning on a TV that never downloads
// to itself. Seven, not eight (§3.7.1).
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Animated, FlatList, StyleSheet} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useIsFocused} from '@react-navigation/native';
import Chip from '../components/Chip';
import NavRail from '../components/NavRail';
import Picker from '../components/Picker';
import Skeleton from '../components/Skeleton';
import {Empty, ErrorState} from '../components/States';
import Card, {CARD_W} from '../components/Card';
import {api, HeroItem, ProfileState} from '../api';
import {openItem} from '../openItem';
import {goSection} from '../navSection';
import {railOpen, useFocusFallback, useListClaim, useTVKeys} from '../focus';
import {useScreenIn} from '../motion';
import {watchStateFor, Marks} from '../watchState';
import {useApp} from '../AppContext';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, CLEARANCE} = theme;

const GRID_GAP = 13;
const SKELETONS = 18;

const byTitle = (a: HeroItem, b: HeroItem) => (a.title || '').localeCompare(b.title || '');

// browse.js:151-162, minus `device`. No `cmp` means "leave the order alone" —
// the server returns the watchlist newest-addition-first, which is the sensible
// default for a list.
type Sort = {id: string; label: string; cmp?: (m: (i: HeroItem) => Marks) => (a: HeroItem, b: HeroItem) => number};
const SORTS: Sort[] = [
  {id: 'listed', label: 'Recently listed'},
  {id: 'title', label: 'A – Z', cmp: () => byTitle},
  {id: 'watched', label: 'Last watched', cmp: m => (a, b) => m(b).at - m(a).at},
  {id: 'added', label: 'Added to server', cmp: () => (a, b) => (b.addedAt || 0) - (a.addedAt || 0)},
  {id: 'year', label: 'Newest', cmp: () => (a, b) => (b.year || 0) - (a.year || 0)},
  {id: 'rating', label: 'Top rated', cmp: () => (a, b) => (b.rating || 0) - (a.rating || 0)},
  {id: 'duration', label: 'Longest', cmp: () => (a, b) => (b.duration || 0) - (a.duration || 0)},
];

// One chip at a time within a group; pressing the lit one clears it. Which chips
// appear is decided by the list itself — see `chipDefs`.
type Filter = {group: string; id: string; label: string; keep: (i: HeroItem, m: Marks) => boolean};
const FILTERS: Filter[] = [
  {group: 'status', id: 'unwatched', label: 'Unwatched', keep: (_i, m) => !m.started},
  {group: 'status', id: 'started', label: 'In progress', keep: (_i, m) => m.started && !m.finished},
  {group: 'status', id: 'watched', label: 'Watched', keep: (_i, m) => m.finished},
  {group: 'kind', id: 'movie', label: 'Films', keep: i => i.type !== 'show'},
  {group: 'kind', id: 'show', label: 'Series', keep: i => i.type === 'show'},
  {group: 'where', id: 'owned', label: 'Downloaded', keep: i => i.source !== 'stream'},
  {group: 'where', id: 'stream', label: 'Streamable', keep: i => i.source === 'stream'},
];

export default function MyList({
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'MyList'>) {
  const {profileId} = useApp();
  const {width, safeBottom} = useTvMetrics();
  const isFocused = useIsFocused();
  const screenIn = useScreenIn();
  const cols = Math.max(
    3,
    Math.floor((width - spacing.contentLeft - spacing.pageX + GRID_GAP) / (CARD_W + GRID_GAP)),
  );

  const [items, setItems] = useState<HeroItem[] | null>(null);
  const [state, setState] = useState<ProfileState | null>(null);
  const [error, setError] = useState('');
  const [genre, setGenre] = useState('');
  const [sortId, setSortId] = useState('listed');
  const [picked, setPicked] = useState<Record<string, string | null>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reload, setReload] = useState(0);
  // Where focus goes if it is ever lost: this screen refetches on every return
  // (a title just removed from the list unmounts its own focused card), and the
  // Sort picker is the one control present whenever the grid is. The Empty and
  // Error states register their own.
  const sortRef = useRef(null);
  useFocusFallback(sortRef);
  // UP OUT OF THE GRID, DETERMINISTICALLY — same platform failure and same fix
  // as Browse: Android's focus search regularly finds nothing above a top-row
  // card, so UP died there. When the native search does work, the focus change
  // clears inGrid before this handler runs and it is a no-op.
  const inGrid = useRef(false);
  const gridIdx = useRef(0);
  const leaveGrid = useCallback((f: boolean) => {
    if (f) inGrid.current = false;
  }, []);
  // The band directly above the grid is the chips row when it exists; only a
  // list with no live chips escapes straight to the Sort picker.
  const firstChipRef = useRef(null);
  useTVKeys(
    useCallback(
      (evt: {eventType: string}) => {
        if (evt.eventType !== 'up') return;
        // Never while the nav rail's panel is up (see Browse's escape).
        if (railOpen()) return;
        if (!inGrid.current || gridIdx.current >= cols) return;
        const target =
          (firstChipRef.current as {requestTVFocus?: () => void} | null) ||
          (sortRef.current as {requestTVFocus?: () => void} | null);
        target?.requestTVFocus?.();
      },
      [cols],
    ),
  );
  const onCardFocus = useCallback((_item: HeroItem, index: number) => {
    inGrid.current = true;
    gridIdx.current = index;
  }, []);

  // Re-fetch whenever this screen comes back into focus: the viewer very likely
  // just went into a title and added or removed it, and a stale grid would show
  // something they know they just deleted.
  useEffect(() => {
    if (!isFocused) return;
    let live = true;
    setError('');
    api
      .watchlist(profileId)
      .then(w => live && setItems(w.items || []))
      .catch(() => live && setError('Could not load your list.'));
    api.state(profileId).then(s => live && setState(s)).catch(() => {});
    return () => {
      live = false;
    };
  }, [profileId, isFocused, reload]);

  // Memoised per list: resolving a series walks its whole episode tree, which is
  // not something to redo on every comparison.
  const mark = useMemo(() => {
    const resolve = watchStateFor(state);
    const marks = new Map<HeroItem, Marks>();
    for (const i of items || []) marks.set(i, resolve(i));
    return (i: HeroItem) => marks.get(i) || resolve(i);
  }, [items, state]);

  const genres = useMemo(
    () => [...new Set((items || []).flatMap(i => i.genres || []))].sort(),
    [items],
  );

  // A chip that can only ever empty the grid is a trap, and a group with one
  // live chip is not a choice — so an all-streamable list offers no Downloaded
  // toggle, and a list of films says nothing about Series.
  const chipDefs = useMemo(() => {
    const all = items || [];
    const live = FILTERS.filter(f => all.some(i => f.keep(i, mark(i))));
    return live.filter(f => live.filter(o => o.group === f.group).length > 1);
  }, [items, mark]);

  const shown = useMemo(() => {
    let list = items || [];
    if (genre) list = list.filter(i => (i.genres || []).includes(genre));
    for (const f of chipDefs) {
      if (picked[f.group] === f.id) list = list.filter(i => f.keep(i, mark(i)));
    }
    const sort = SORTS.find(s => s.id === sortId);
    if (sort?.cmp) list = [...list].sort(sort.cmp(mark));
    return list;
  }, [items, genre, chipDefs, picked, sortId, mark]);

  const openDetail = useCallback((item: HeroItem) => openItem(navigation, item), [navigation]);

  const claims = useListClaim('list', shown.length > 0);
  const renderCard = useCallback(
    ({item, index}: {item: HeroItem; index: number}) => (
      <Card
        item={item}
        index={index}
        onPress={openDetail}
        onFocus={onCardFocus}
        edgeLeft={index % cols === 0}
        hasTVPreferredFocus={claims(index)}
      />
    ),
    [openDetail, cols, claims, onCardFocus],
  );

  const total = items?.length ?? 0;
  const count =
    shown.length === total
      ? `${total} title${total === 1 ? '' : 's'}`
      : `${shown.length} of ${total}`;

  const toggle = (f: Filter) =>
    setPicked(p => ({...p, [f.group]: p[f.group] === f.id ? null : f.id}));

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.page, screenIn]}>
        <View style={styles.head}>
          <Text style={styles.h1}>My List</Text>
          {items ? <Text style={styles.count}>{count}</Text> : null}
        </View>

        {error ? (
          <ErrorState
            message={error}
            onAction={() => {
              setItems(null);
              setError('');
              setReload(n => n + 1);
            }}
          />
        ) : items === null ? (
          <View style={styles.skelGrid}>
            {Array.from({length: SKELETONS}, (_, i) => (
              <Skeleton key={i} />
            ))}
          </View>
        ) : total === 0 ? (
          // Deviation 4 (§6.2): the site's `.empty` has no focusable element,
          // which on a remote is a dead screen.
          <Empty
            glyph="🍿"
            message="My List is empty. Hit + on anything that catches your eye."
            actionLabel="Browse Movies"
            onAction={() => goSection(navigation, 'list', 'movies')}
          />
        ) : (
          <>
            {/* .filter-bar.tools — the genre picker only if there is more than
                nothing to pick (browse.js:152), the sort picker always. */}
            <View style={styles.tools}>
              {genres.length > 0 ? (
                <Picker
                  edgeLeft
                  label="Genre"
                  value={genre}
                  options={[
                    {label: 'All genres', value: ''},
                    ...genres.map(g => ({label: g, value: g})),
                  ]}
                  onPick={setGenre}
                  onOpenChange={setPickerOpen}
                  onFocusChange={leaveGrid}
                />
              ) : null}
              <Picker
                ref={sortRef}
                edgeLeft={genres.length === 0}
                label="Sort"
                value={sortId}
                options={SORTS.map(s => ({label: s.label, value: s.id}))}
                onPick={setSortId}
                onOpenChange={setPickerOpen}
                onFocusChange={leaveGrid}
              />
            </View>

            {chipDefs.length > 0 ? (
              <View style={styles.chips}>
                {chipDefs.map((f, at) => (
                  <React.Fragment key={f.id}>
                    {/* Hairline between groups: seven chips in an even row read
                        as seven unrelated toggles rather than three either/or
                        choices (screens.css:470-476). */}
                    {at > 0 && chipDefs[at - 1].group !== f.group ? (
                      <View style={styles.sep} />
                    ) : null}
                    <Chip
                      ref={at === 0 ? firstChipRef : undefined}
                      label={f.label}
                      on={picked[f.group] === f.id}
                      edgeLeft={at === 0}
                      onFocusChange={leaveGrid}
                      onPress={() => toggle(f)}
                    />
                  </React.Fragment>
                ))}
              </View>
            ) : null}

            {shown.length === 0 ? (
              <Empty
                glyph="🍿"
                message="Nothing matches. Try fewer filters?"
                actionLabel="Clear filters"
                onAction={() => {
                  setGenre('');
                  setPicked({});
                }}
              />
            ) : (
              <FlatList
                data={shown}
                key={`cols-${cols}`}
                style={styles.listFill}
                numColumns={cols}
                keyExtractor={it => it.id || it.imdbId || it.title}
                columnWrapperStyle={styles.rowGap}
                contentContainerStyle={[styles.grid, {paddingBottom: CLEARANCE.below + safeBottom}]}
                initialNumToRender={24}
                maxToRenderPerBatch={12}
                // See Browse: keeping every mounted cell attached is what made
                // the app degrade to a 750ms frame the longer you browsed.
                windowSize={3}
                removeClippedSubviews
                renderItem={renderCard}
              />
            )}
          </>
        )}
      </Animated.View>

      <NavRail active="list" disabled={pickerOpen} />
    </View>
  );
}

const frame = {paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX};

const styles = StyleSheet.create({
  // No backgroundColor: android:windowBackground already paints it.
  root: {flex: 1},
  page: {flex: 1},
  head: {flexDirection: 'row', alignItems: 'baseline', gap: 16, paddingTop: 27, paddingBottom: 4, ...frame},
  h1: {color: colors.text, fontSize: fontSize.title, lineHeight: 39, fontWeight: '900', letterSpacing: -0.52},
  count: {color: colors.textFaint, fontSize: 16, lineHeight: 24, fontWeight: '600'},
  // Both bands are `.filter-bar.tools`. They differ only in stacking: the picker
  // row must out-stack the chip row BELOW it, or an open panel is painted over by
  // chips that come later in the tree — measured, "In progress" and "Watched"
  // showed through the sort panel.
  tools: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 2, paddingBottom: 6, zIndex: 20, ...frame},
  chips: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 2, paddingBottom: 6, zIndex: 10, ...frame},
  sep: {width: 1, height: 18, marginHorizontal: 4, backgroundColor: colors.line},
  listFill: {flex: 1},
  grid: {paddingTop: CLEARANCE.above, ...frame},
  rowGap: {gap: GRID_GAP, marginBottom: GRID_GAP},
  skelGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP, paddingTop: CLEARANCE.above, ...frame},
});
