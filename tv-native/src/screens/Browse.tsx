// Movies / Shows — the site's Browse (public/js/screens/browse.js), band for band:
// a heading with a live count and Surprise me, a search box, six CATEGORY pills,
// a genre picker with an Unwatched toggle, then the grid and one Load more.
//
// Built from SPEC/.findings/03-BUILD.md. Two departures from the site, both
// deliberate and both recorded in SPEC/99-open.md §E:
//
//   • The search box is a BUTTON that opens the Search screen. It cannot be typed
//     into here: the platform IME takes DPAD_LEFT/RIGHT for itself and covers the
//     lower half of the panel, which is why 06-search draws its own keyboard. A
//     second drawn keyboard on this screen would be the same screen twice.
//   • Nothing else. The library ordering, which used to interleave, now
//     transcribes the site — see `items`.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Animated, FlatList, StyleSheet, TVFocusGuideView} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Btn from '../components/Btn';
import Chip from '../components/Chip';
import Icon from '../components/Icon';
import Focusable from '../components/Focusable';
import MiniSpinner from '../components/MiniSpinner';
import NavRail from '../components/NavRail';
import Picker from '../components/Picker';
import Skeleton from '../components/Skeleton';
import {Empty} from '../components/States';
import Card, {CARD_W} from '../components/Card';
import {api, HeroItem, ProfileState} from '../api';
import {watchStateFor} from '../watchState';
import {canNavigate} from '../navLock';
import {railOpen, useFocusFallback, useListClaim, useTVKeys} from '../focus';
import {useScreenIn} from '../motion';
import {useApp} from '../AppContext';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, CLEARANCE} = theme;

// P17. 18px x 0.70 — the grid gap, not spacing.md.
const GRID_GAP = 13;
// browse.js:352 — the placeholder count is fixed, not derived from the viewport.
const SKELETONS = 18;

// The site's CATEGORIES, verbatim (browse.js:195-201). `withLocal` leads with
// your own library and then continues into the catalog; `local` is the library
// alone; `taste` re-ranks by the genres you actually watch.
type Category = {
  id: string;
  label: string;
  catalog?: string;
  withLocal?: boolean;
  local?: boolean;
  taste?: boolean;
};
const CATEGORIES: Category[] = [
  {id: 'all', label: 'All', catalog: 'trending', withLocal: true},
  {id: 'trending', label: 'Trending', catalog: 'trending'},
  {id: 'new', label: 'New', catalog: 'new'},
  {id: 'top', label: 'Top rated', catalog: 'top'},
  {id: 'recommended', label: 'For you', catalog: 'trending', taste: true},
  {id: 'downloaded', label: 'Downloaded', local: true},
];

const byTitle = (a: HeroItem, b: HeroItem) => (a.title || '').localeCompare(b.title || '');
const norm = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const keyOf = (i: HeroItem) => i.id || i.imdbId || i.title;

export default function Browse({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'Browse'>) {
  const {kind} = route.params;
  const title = kind === 'show' ? 'Shows' : 'Movies';
  const {profileId} = useApp();
  const {width, safeBottom} = useTvMetrics();
  const screenIn = useScreenIn();
  // P17 — a FIXED 124dp cell at a 13dp gap in the content box, not a fluid
  // column. RN has no auto-fill/minmax and numColumns is an integer, so the
  // site's fluidity cannot be transcribed; rather than invent an approximation
  // the cell is the same card the rows use. At 960dp that is 6 columns of 809 in
  // 816 — 7dp of TRAILING slack, which stays trailing (§3.4 forbids spending it
  // into the gaps).
  const cols = Math.max(
    3,
    Math.floor((width - spacing.contentLeft - spacing.pageX + GRID_GAP) / (CARD_W + GRID_GAP)),
  );

  const [lib, setLib] = useState<HeroItem[] | null>(null);
  const [category, setCategory] = useState('all');
  const [genre, setGenre] = useState('');
  const [unwatched, setUnwatched] = useState(false);
  const [genreList, setGenreList] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  // THE HEADER COLLAPSES WHILE FOCUS IS DOWN IN THE GRID. The full chrome —
  // heading, count, Surprise, the search stop — is ~150dp of a 540dp panel, and
  // with it up the grid showed barely one row of posters. Focus is the TV's
  // scroll position: a card gaining focus collapses the top bands, any pill or
  // filter gaining focus brings them back. The category pills and the filter
  // bar stay in both states, so UP from the grid always lands on something and
  // the collapsed state still says which category is live.
  const [compact, setCompact] = useState(false);
  // The FIRST card focus is the programmatic claim on arrival (useListClaim),
  // not the viewer moving down — collapsing on it made the header flash and
  // vanish on every entry to the screen. Arm on the first, collapse from the
  // second onward, so the chrome stays until the viewer actually moves.
  const gridArmed = useRef(false);
  // Whether focus is in the grid, and on which index — the deterministic
  // UP-escape below needs both.
  const inGrid = useRef(false);
  const gridIdx = useRef(0);
  const collapseHead = useCallback((_item: HeroItem, index: number) => {
    inGrid.current = true;
    gridIdx.current = index;
    if (!gridArmed.current) {
      gridArmed.current = true;
      return;
    }
    setCompact(true);
  }, []);
  const expandHead = useCallback((f: boolean) => {
    if (!f) return;
    inGrid.current = false;
    setCompact(false);
  }, []);

  // UP OUT OF THE GRID, DETERMINISTICALLY. Measured on the Streamer: Android's
  // own focus search regularly finds NOTHING above a top-row card (it worked
  // from column 0, and was a dead key from every other column), which read as
  // "moving up toward the top panel takes several presses and sometimes never
  // lands". Same solution as the nav rail's LEFT: the platform already failed
  // to move focus by the time this handler runs, so requesting the filter band
  // directly cannot double-move — and when the native search DOES work, the
  // focus change flips inGrid false before this runs and it is a no-op.
  const genreRef = useRef(null);
  useTVKeys(
    useCallback(
      (evt: {eventType: string}) => {
        if (evt.eventType !== 'up') return;
        // Never while the nav rail's panel is up — its focus containment is
        // native-only, so this handler still hears keys and would yank focus
        // out of the open rail onto the page behind it.
        if (railOpen()) return;
        if (!inGrid.current || gridIdx.current >= cols) return;
        (genreRef.current as {requestTVFocus?: () => void} | null)?.requestTVFocus?.();
      },
      [cols],
    ),
  );
  // Clears the in-grid flag WITHOUT re-expanding the header — for the pager
  // strip below the grid, where UP must go back to the cards, not teleport to
  // the filter band (the escape's top-row test can't tell the pager apart from
  // a top-row card when the grid is a single row).
  const leaveGridOnly = useCallback((f: boolean) => {
    if (f) inGrid.current = false;
  }, []);
  // Where focus goes if it is ever lost: the first category pill is the one
  // focusable this screen has in every state.
  const firstPill = useRef(null);
  useFocusFallback(firstPill);
  // UP out of the tools band must land on the ACTIVE pill, not on whichever pill
  // happens to sit above by x. A focus guide with an explicit destination is the
  // mechanism for that, and it takes the native instance rather than a ref — so
  // the nodes are collected by six ref callbacks whose identity never changes
  // (a fresh callback each render would detach and reattach on every render).
  const pillNodes = useRef<unknown[]>([]);
  const setPillRef = useMemo(
    () =>
      CATEGORIES.map((_, i) => (n: unknown) => {
        pillNodes.current[i] = n;
        if (i === 0) (firstPill as React.MutableRefObject<unknown>).current = n;
      }),
    [],
  );
  // One render after mount, so the guide sees the nodes the refs just filled in.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Catalog items fetched so far, in catalog order — that order IS the ranking.
  const [fetched, setFetched] = useState<HeroItem[]>([]);
  const [page, setPage] = useState(-1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [profState, setProfState] = useState<ProfileState | null>(null);
  const [likedGenres, setLikedGenres] = useState<string[]>([]);
  // Started/finished across ALL THREE progress maps. A bare progress[id] lookup
  // only ever answers for downloaded FILMS — catalog items have no library id
  // at all and streamed history lives in streamProgress/episodeProgress — so
  // the Unwatched toggle was a no-op for every streamable title on the grid.
  const marks = useMemo(() => watchStateFor(profState), [profState]);

  // OPEN DEFECT — focus is lost when a page lands. The Load more button stays
  // mounted (browse.js:385-387's whole point) and stays on screen, but after the
  // 48 new rows commit nothing on the screen is focused: UP and DOWN just scroll.
  // The rail is still reachable with LEFT, so the remote is not dead, but the
  // highlight is gone until you go out to the rail and come back.
  //
  // FOUR fixes were tried on the device and all four failed. Recorded so the
  // fifth does not repeat them:
  //   1. Re-focus the button if `focusHeld()` says nothing holds focus. Never
  //      ran — Android drops the focus without firing onBlur, so `held` still
  //      named the button.
  //   2. Re-focus it unconditionally after the press, twice, at 150/450ms. No
  //      effect.
  //   3. Same, with a probe attached: `node=true fn=function`. The ref is live
  //      and `requestTVFocus()` is called and ignored. Imperative focus does not
  //      land on that view once the list has re-laid-out around it.
  //   4. Claim the FIRST NEW CARD with `hasTVPreferredFocus` at mount, set in the
  //      same commit as the data. It moved the list to the new page and still
  //      focused nothing — strictly worse, so it came out (RULES rule 5).

  const cat = CATEGORIES.find(c => c.id === category) || CATEGORIES[0];
  const localOnly = !!cat.local;

  useEffect(() => {
    let live = true;
    api
      .library()
      .then(
        l =>
          live &&
          setLib(
            (kind === 'show' ? l.shows : l.movies).map(i => ({
              ...i,
              source: 'downloaded' as const,
            })),
          ),
      )
      .catch(() => live && setLib([]));
    api.catalogGenres(kind).then(r => live && setGenreList(r.genres || [])).catch(() => {});
    // Unwatched needs saved progress, and "For you" needs the genres this profile
    // said it likes — the same two things the site reads off `state`.
    api
      .state(profileId)
      .then(s => {
        if (!live) return;
        setProfState(s);
        setLikedGenres(s.likedGenres || []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [kind, profileId]);

  // What "For you" is built from: the genres you picked in Preferences if you
  // picked any, otherwise the ones your own library leans on.
  const tasteGenres = useMemo(() => {
    if (likedGenres.length) return likedGenres.slice(0, 6);
    const tally = new Map<string, number>();
    for (const i of lib || []) for (const g of i.genres || []) tally.set(g, (tally.get(g) || 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g);
  }, [likedGenres, lib]);

  // ---- catalog paging ----------------------------------------------------
  // One effect owns the fetch: it resets on any change of category/genre and
  // then fills page by page. `reqId` makes a superseded round of fetches unable
  // to append to the new list. A category already opened is not fetched again —
  // session-scoped, like the site's own viewState.
  const reqId = useRef(0);
  const cache = useRef(
    new Map<string, {items: HeroItem[]; page: number; hasMore: boolean}>(),
  );
  const cacheKey = `${kind}|${category}|${genre}`;
  useEffect(() => {
    if (localOnly) {
      // Bump the request id here too: an in-flight catalog fetch from the
      // previous category must not write into the Downloaded view's state.
      ++reqId.current;
      setFetched([]);
      setHasMore(false);
      setPage(-1);
      setLoading(false);
      return;
    }
    const id = ++reqId.current;
    const hit = cache.current.get(cacheKey);
    if (hit) {
      setFetched(hit.items);
      setPage(hit.page);
      setHasMore(hit.hasMore);
      setLoading(false);
      return;
    }
    setFetched([]);
    setLoading(true);
    api
      .catalog({type: kind, category: cat.catalog || 'trending', genre: genre || null, page: 0})
      .then(r => {
        if (id !== reqId.current) return;
        const list = r.items || [];
        cache.current.set(cacheKey, {items: list, page: 0, hasMore: !!r.hasMore});
        setFetched(list);
        setPage(0);
        setHasMore(!!r.hasMore);
      })
      .catch(() => {
        if (id !== reqId.current) return;
        setFetched([]);
        setHasMore(false);
      })
      .finally(() => id === reqId.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, category, genre, localOnly, cacheKey]);

  const loadNext = useCallback(() => {
    if (loading || !hasMore || localOnly || page < 0) return;
    const id = reqId.current;
    setLoading(true);
    api
      .catalog({type: kind, category: cat.catalog || 'trending', genre: genre || null, page: page + 1})
      .then(r => {
        if (id !== reqId.current) return;
        // De-dupe on append: the catalogs overlap between pages often enough that
        // letting them through gave the grid the same poster twice.
        const nextPage = r.page ?? page + 1;
        setFetched(prev => {
          const have = new Set(prev.map(keyOf));
          const merged = [...prev, ...(r.items || []).filter(i => !have.has(keyOf(i)))];
          cache.current.set(cacheKey, {items: merged, page: nextPage, hasMore: !!r.hasMore});
          return merged;
        });
        setPage(nextPage);
        setHasMore(!!r.hasMore);
      })
      .catch(() => id === reqId.current && setHasMore(false))
      .finally(() => id === reqId.current && setLoading(false));
  }, [cacheKey, cat.catalog, genre, hasMore, kind, loading, localOnly, page]);

  // ---- what to show ------------------------------------------------------
  // `visible()` transcribed (browse.js:310-327): the WHOLE downloaded library,
  // alphabetical, ahead of the catalog whenever the category asks for it.
  //
  // This screen used to interleave — three owned titles at the head and the rest
  // folded in behind the catalog's ranking — on the argument that a TV shows ~12
  // posters and a 30-title library would fill the first three screens with things
  // sorted by nothing but their first letter. That argument is about ergonomics,
  // not about the old app, so rule 13 does not void it; but nothing authorised
  // the departure either, and D1 says the site is the source of truth. Recorded
  // as an open question rather than kept silently.
  const {list: items, owned} = useMemo(() => {
    const downloaded = lib || [];
    let local: HeroItem[] = [];
    if (localOnly || cat.withLocal) {
      local = downloaded;
      if (genre) local = local.filter(i => (i.genres || []).includes(genre));
      if (unwatched) local = local.filter(i => !marks(i).finished);
      // Alphabetical, always. A sort control here was one more thing to read for
      // a list you can already see all of.
      local = [...local].sort(byTitle);
    }
    if (localOnly) return {list: local, owned: local.length};

    const libTitles = new Set(downloaded.map(i => norm(i.title)));
    let stream = fetched.filter(m => m.imdbId && !libTitles.has(norm(m.title)));
    if (unwatched) stream = stream.filter(m => !marks(m).finished);
    let tagged = stream.map(i => ({...i, source: 'stream' as const}));
    // "For you": float the genres this profile actually watches to the front,
    // keeping catalog order within each group.
    if (cat.taste && tasteGenres.length && !genre) {
      const liked = new Set(tasteGenres);
      const hit = tagged.filter(i => (i.genres || []).some(g => liked.has(g)));
      const rest = tagged.filter(i => !(i.genres || []).some(g => liked.has(g)));
      tagged = [...hit, ...rest];
    }
    return {list: [...local, ...tagged], owned: local.length};
  }, [cat, fetched, genre, lib, localOnly, marks, tasteGenres, unwatched]);

  const openDetail = useCallback(
    (item: HeroItem) => {
      if (!canNavigate(navigation)) return;
      navigation.push('Detail', {item});
    },
    [navigation],
  );
  // The site rolls over everything the screen could show, not over what is
  // currently filtered in (browse.js:534).
  const surprise = () => {
    const pool = [...(lib || []), ...fetched];
    if (pool.length) openDetail(pool[Math.floor(Math.random() * pool.length)]);
  };

  // Claim the first card once, when the grid first fills. NOT per filter: the
  // site leaves focus on the pill you pressed, and the picker hands focus back
  // to its own opener (useKeyTrap). See focus.ts.
  const claims = useListClaim('grid', items.length > 0);
  const renderCard = useCallback(
    ({item, index}: {item: HeroItem; index: number}) => (
      <Card
        item={item}
        index={index}
        onPress={openDetail}
        // Any card gaining focus is "the viewer is in the grid" — collapse.
        onFocus={collapseHead}
        // Column 0 has nothing to its left, so LEFT from it opens the rail.
        edgeLeft={index % cols === 0}
        hasTVPreferredFocus={claims(index)}
      />
    ),
    [openDetail, cols, claims, collapseHead],
  );

  // paintCount, transcribed (browse.js:411-423). The query branch is gone with
  // the query — see the header note on the search box.
  const count = localOnly
    ? `${items.length} downloaded`
    : (owned ? `${owned} downloaded · ` : '') +
      `${items.length - owned} to stream${hasMore ? ' · more available' : ''}`;
  // The pills-row copy while the header is collapsed: ONE fact, because the
  // full line kept ellipsizing against six pills ("46 to st…"). The downloaded
  // split is still one UP away on the full header.
  const compactCount = localOnly
    ? `${items.length} downloaded`
    : `${items.length - owned} to stream`;

  const taste = cat.taste && !genre ? tasteGenres.slice(0, 3) : [];
  const note = taste.length ? `from your ${taste.join(', ')}` : '';


  // Local lists are already complete — there is nothing to page (browse.js:391).
  const showMore = !localOnly && (hasMore || loading);
  const skeletons = (lib === null || loading) && items.length === 0;
  const active = pillNodes.current[CATEGORIES.findIndex(c => c.id === category)];
  const activePill = mounted && active ? [active as never] : undefined;

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.page, screenIn]}>
        {/* .browse-head — heading, count, then Surprise me pushed right by the
            inline `margin-left: auto` (browse.js:532). Gone while the grid holds
            focus; the pills below re-expand it. */}
        {compact ? null : (
          <View style={styles.head}>
            <Text style={styles.h1}>{title}</Text>
            <Text style={styles.count}>{count}</Text>
            <View style={styles.spacer} />
            <Btn
              small
              glyph="🎲"
              label="Surprise me"
              edgeLeft
              onFocusChange={expandHead}
              onPress={surprise}
            />
          </View>
        )}

        {/* .search-wrap / .search-box. A stop, not an input — see the header. */}
        {compact ? null : (
          <View style={styles.searchWrap}>
            <Focusable
              edgeLeft
              onFocusChange={f => {
                setSearchFocused(f);
                if (f) inGrid.current = false;
              }}
              onPress={() => canNavigate(navigation) && navigation.push('Search')}
              style={styles.searchBox}>
              <View
                style={[styles.searchEdge, searchFocused && styles.searchEdgeOn]}
                pointerEvents="none"
              />
              <Icon name="search" size={22} color={colors.textDim} />
              <Text style={styles.searchText}>{`Search ${title.toLowerCase()}…`}</Text>
            </Focusable>
          </View>
        )}

        {/* .cat-row — present in BOTH header states: it is where UP from the
            grid lands, and a pill gaining focus is what re-expands the header. */}
        <TVFocusGuideView style={styles.catRow} destinations={activePill}>
          {CATEGORIES.map((c, i) => (
            <Chip
              key={c.id}
              bare
              label={c.label}
              on={category === c.id}
              ref={setPillRef[i]}
              edgeLeft={i === 0}
              onFocusChange={expandHead}
              onPress={() => category !== c.id && setCategory(c.id)}
            />
          ))}
          {/* The count keeps a home while the head is away — it is the one line
              of the head that still orients ("312 to stream · more available"). */}
          {compact ? (
            <>
              <View style={styles.spacer} />
              {/* flexShrink: pills win the row; a long count ellipsizes rather
                  than pushing past the safe inset. */}
              <Text style={[styles.count, styles.countShrink]} numberOfLines={1}>
                {compactCount}
              </Text>
            </>
          ) : null}
        </TVFocusGuideView>

        {/* .filter-bar.tools. zIndex so the genre panel paints over the grid —
            the panel is a child of the picker, which is a child of this band. */}
        <View style={styles.tools}>
          <Picker
            ref={genreRef}
            edgeLeft
            label="Genre"
            value={genre}
            options={[{label: 'All genres', value: ''}, ...genreList.map(g => ({label: g, value: g}))]}
            onPick={setGenre}
            onOpenChange={setPickerOpen}
            onFocusChange={expandHead}
          />
          <Chip
            label="Unwatched"
            on={unwatched}
            onFocusChange={expandHead}
            onPress={() => setUnwatched(u => !u)}
          />
          {/* Hidden, never unmounted: the flex gap would otherwise leave a
              phantom notch as it comes and goes (browse.js:499-500). */}
          <Text style={[styles.note, !note && styles.gone]}>{note}</Text>
        </View>

        {skeletons ? (
          <View style={styles.skelGrid}>
            {Array.from({length: SKELETONS}, (_, i) => (
              <Skeleton key={i} />
            ))}
          </View>
        ) : items.length === 0 ? (
          <Empty
            glyph="🍿"
            message={
              genre
                ? `Nothing in ${genre} here. Try another genre?`
                : 'Nothing matches. Try fewer filters?'
            }
            actionLabel="All titles"
            onAction={() => {
              setCategory('all');
              setGenre('');
              setUnwatched(false);
            }}
          />
        ) : (
          <>
          <FlatList
            data={items}
            // numColumns cannot be changed in place, so the list is re-keyed.
            key={`${kind}-${cols}`}
            style={styles.listFill}
            numColumns={cols}
            // keyOf ALONE. With the index in the key, inserting a page's worth of
            // items at the front remounts every card behind the insertion.
            keyExtractor={keyOf}
            columnWrapperStyle={styles.rowGap}
            contentContainerStyle={[styles.grid, {paddingBottom: CLEARANCE.below + safeBottom}]}
            // appendProgressive(…, 24, 12) — ui.js:183.
            initialNumToRender={24}
            maxToRenderPerBatch={12}
            // THIS IS THE PERFORMANCE FIX. It was `false`, on §G.1's reasoning
            // that a clipped subview is a clipped focus treatment — and the cost
            // of that was the app becoming unusable the longer you browsed.
            // Measured on the Streamer, four identical 60-press bursts in a row:
            //
            //   false, windowSize 5 :  53ms -> 600 -> 750 -> 750ms median frame,
            //                          100% janky, GPU 92 -> 125MB and climbing
            //   true,  windowSize 3 :  34 -> 32 -> 31 -> 32ms, 4-13% janky,
            //                          GPU flat at 87MB
            //
            // The same burst on the nav rail never degraded, which is what
            // identified the grid as the accumulator. §G.1's worry does not
            // materialise: the clearance is contentContainer padding, so the CELL
            // is not what gets clipped — verified on screen, a focused card on the
            // last row keeps its ring on all four sides.
            removeClippedSubviews
            windowSize={3}
            renderItem={renderCard}
            // NO onEndReached. The site's only pager is the button
            // (browse.js:385-400) and an auto-pager moves the grid under the
            // reader's own focus.
          />
          {/* The pager, as a SIBLING below the list rather than a
              ListFooterComponent. Inside the footer it was a list cell: when a
              page landed, the list re-laid-out around it and Android silently
              dropped its focus — the OPEN DEFECT recorded above, where four
              in-place re-focus attempts all failed because requestTVFocus on a
              re-attached cell is accepted and ignored. As a sibling it never
              re-lays-out with the list, so the focus it was pressed with simply
              survives. Still ONE button relabelled in place (browse.js:385-387). */}
          {showMore ? (
            // safeBottom here too: this strip sits BELOW the list now, so the
            // list's own bottom inset no longer covers it against overscan.
            <View style={[styles.moreHost, {paddingBottom: 12 + safeBottom}]}>
              <Btn
                edgeLeft
                dim={loading}
                leading={loading ? <MiniSpinner /> : null}
                label={loading ? 'Loading…' : 'Load more'}
                onFocusChange={leaveGridOnly}
                onPress={loadNext}
              />
            </View>
          ) : null}
          </>
        )}
      </Animated.View>

      {/* Outside the sliding page: `.nav` is not inside `.screen` on the site,
          and the entry animation is the screen's, not the app's. */}
      <NavRail active={kind === 'show' ? 'shows' : 'movies'} disabled={pickerOpen} />
    </View>
  );
}

// Every chrome band carries the same horizontal frame (P1/P2): the rail plus its
// gutter on the left, the safe inset on the right.
const frame = {paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX};

const styles = StyleSheet.create({
  // No backgroundColor: android:windowBackground is already this colour, and
  // painting it again cost a second full-screen fill on every frame.
  root: {flex: 1},
  page: {flex: 1},
  // `padding: calc(--nav-h + 42px) --page-x 8px`. The top bar is gone, and 42x0.505
  // = 21 is inside the 27dp vertical safe inset, so it is absorbed rather than
  // added (P2).
  head: {flexDirection: 'row', alignItems: 'baseline', gap: 16, paddingTop: 27, paddingBottom: 4, ...frame},
  // --fs-title 35.2 x 0.72 = 26 (P8), lh 1.5, -0.02em.
  h1: {color: colors.text, fontSize: fontSize.title, lineHeight: 39, fontWeight: '900', letterSpacing: -0.52},
  // No font-size of its own: it inherits --fs-body. P14 keeps it at 16.
  count: {color: colors.textFaint, fontSize: 16, lineHeight: 24, fontWeight: '600'},
  countShrink: {flexShrink: 1},
  spacer: {flex: 1},
  // browse.js:540's inline padding beats screens.css:552-554.
  searchWrap: {paddingTop: 6, paddingBottom: 4, ...frame},
  // 16/22 over --surface at radius 14 — natural 64dp, since `border-box` leaves
  // the height auto and 1rem x 1.25 x 1.5 = 30 for the line box.
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 16,
    paddingHorizontal: 22,
    borderRadius: 14,
    backgroundColor: colors.surface,
  },
  searchEdge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
  },
  // `.search-box:focus-within` (screens.css:567-570). The 3dp 0.12 glow it also
  // carries is not drawn: this is a button here, so it takes --focus-ring like
  // every other one, and two cues would fight.
  searchEdgeOn: {borderColor: 'rgba(255,255,255,0.45)'},
  // The input's own 1.25rem/600; the placeholder colour, since there is never a
  // value to show.
  searchText: {color: colors.textFaint, fontSize: 20, fontWeight: '600'},
  // Vertical padding is load-bearing on the site (it stops the pills' focus ring
  // being clipped by the strip's own overflow) and is transcribed as-is.
  catRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, ...frame},
  tools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 2,
    paddingBottom: 6,
    zIndex: 20,
    ...frame,
  },
  note: {color: colors.textFaint, fontSize: 16, fontWeight: '600', alignSelf: 'center'},
  gone: {display: 'none'},
  // Vertical FlatLists need flex here: on TV the list is wrapped in a focus
  // guide that mirrors this style (see the virtualized-lists patch); without it
  // the list sizes to its content and overflows the screen instead of scrolling
  // inside it.
  listFill: {flex: 1},
  // A vertical FlatList spends the clearance as padding and takes NO cancelling
  // margins: a recycled cell cannot be relied on to carry them (§F.4 / G.1).
  grid: {paddingTop: CLEARANCE.above, ...frame},
  // NOT space-between: P17 leaves 7dp of slack at 960dp and §3.4 forbids
  // spending it into the gaps — the gap is pinned at 13 and the residue stays
  // trailing, so the grid stays left-aligned under the content inset.
  rowGap: {gap: GRID_GAP, marginBottom: GRID_GAP},
  skelGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP, paddingTop: CLEARANCE.above, ...frame},
  // A fixed strip under the list now (see the sibling note at the render): it
  // only exists while more pages exist, so it earns its ~60dp. The render adds
  // safeBottom to the 12.
  moreHost: {alignItems: 'center', paddingTop: 4},
});
