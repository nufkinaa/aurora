// Movies / Shows — the site's Browse (public/js/screens/browse.js), re-shaped
// for a 10-foot screen with a remote.
//
// THE GRID IS THE PAGE. Everything that used to sit above it — the search stop,
// the category pills, the genre/unwatched band — lives in a FILTER PANEL that
// opens from the RIGHT edge, the mirror of the nav rail on the left: RIGHT from
// the last column opens it, LEFT or Back closes it and hands focus straight
// back to the card you left. One slim heading line (title + count) is all the
// chrome the grid pays for.
//
// This replaced a collapsing header (2026-08-23, elia): the collapse looked
// junky, the search stop duplicated the Search page, and a sticky Load-more
// strip under the grid read as a stray control. Paging is now automatic —
// the next page is fetched as focus nears the end of what is loaded, and a
// page APPENDS, so nothing under the focused card ever moves.
//
// The category list, the genre picker, the Unwatched toggle and Surprise me
// are the site's own controls; only their home changed.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  Animated,
  BackHandler,
  Easing,
  FlatList,
  StyleSheet,
  TVFocusGuideView,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Btn from '../components/Btn';
import Chip from '../components/Chip';
import MiniSpinner from '../components/MiniSpinner';
import NavRail from '../components/NavRail';
import Picker from '../components/Picker';
import Skeleton from '../components/Skeleton';
import {Empty} from '../components/States';
import Card, {CARD_W} from '../components/Card';
import {api, HeroItem, ProfileState} from '../api';
import {watchStateFor} from '../watchState';
import {canNavigate} from '../navLock';
import {
  atRightEdge,
  captureFocus,
  focusJustMoved,
  railOpen,
  useFocusFallback,
  useListClaim,
  useTVKeys,
} from '../focus';
import {useScreenIn} from '../motion';
import {useApp} from '../AppContext';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, CLEARANCE, motion, focus} = theme;

const EASE = Easing.bezier(...(focus.ease as unknown as [number, number, number, number]));

// P17. 18px x 0.70 — the grid gap, not spacing.md.
const GRID_GAP = 13;
// browse.js:352 — the placeholder count is fixed, not derived from the viewport.
const SKELETONS = 18;
// The filter panel: wide enough for "Downloaded" and the genre picker at row
// type, narrow enough to leave four columns of the grid showing behind it.
const PANEL_W = 300;
// The passive edge strip that says a panel lives here (the rail's collapsed
// 72dp strip, mirrored and slimmer — it carries one glyph and no focus target).
const STRIP_W = 44;
// How close to the end of the loaded list focus has to get before the next page
// is fetched: two rows out, so the page lands before the viewer reaches it.
const PREFETCH_ROWS = 2;

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
  // column. The content box now ends at the edge strip rather than the safe
  // inset: the strip is chrome the grid must not slide under.
  const cols = Math.max(
    3,
    Math.floor((width - spacing.contentLeft - STRIP_W - spacing.sm + GRID_GAP) / (CARD_W + GRID_GAP)),
  );

  const [lib, setLib] = useState<HeroItem[] | null>(null);
  const [category, setCategory] = useState('all');
  const [genre, setGenre] = useState('');
  const [unwatched, setUnwatched] = useState(false);
  const [genreList, setGenreList] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

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
  // Read through a ref by the card focus handler, which must keep a stable
  // identity (it is a prop on every memoized card).
  const loadNextRef = useRef(loadNext);
  loadNextRef.current = loadNext;

  // ---- what to show ------------------------------------------------------
  // `visible()` transcribed (browse.js:310-327): the WHOLE downloaded library,
  // alphabetical, ahead of the catalog whenever the category asks for it.
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
  const itemCount = items.length;
  const itemCountRef = useRef(itemCount);
  itemCountRef.current = itemCount;

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

  // ---- the filter panel --------------------------------------------------
  const [panel, setPanel] = useState(false);
  const slide = useRef(new Animated.Value(0)).current;
  // Who had focus before the panel took it — the card you were on — so closing
  // can give it straight back (the rail does exactly this).
  const restore = useRef<(() => void) | null>(null);
  // The grid's first card and the list itself: where focus lands when the
  // panel closes on a CHANGED grid (the card you came from may be filtered
  // away), and this screen's focus fallback.
  const firstCard = useRef(null);
  const listRef = useRef<FlatList<HeroItem>>(null);
  // Did a filter change while the panel was open? Decides restore-vs-first.
  const dirty = useRef(false);
  const openPanel = useCallback(() => {
    restore.current = captureFocus();
    dirty.current = false;
    setPanel(true);
  }, []);
  const closePanel = useCallback(() => {
    setPanel(false);
    slide.setValue(0);
    if (dirty.current) {
      // New results: start them from the top, on the first card. Restoring to
      // the old card would aim at a cell the filter may have unmounted —
      // focus would land nowhere.
      listRef.current?.scrollToOffset({offset: 0, animated: false});
      (firstCard.current as {requestTVFocus?: () => void} | null)?.requestTVFocus?.();
    } else {
      restore.current?.();
    }
    restore.current = null;
  }, [slide]);
  const pick = useCallback((fn: () => void) => {
    dirty.current = true;
    fn();
  }, []);
  useEffect(() => {
    if (!panel) return;
    Animated.timing(slide, {
      toValue: 1,
      duration: motion.med,
      easing: EASE,
      useNativeDriver: true,
      isInteraction: false,
    }).start();
  }, [panel, slide]);

  // RIGHT from the last column opens it; LEFT inside it closes it. The race
  // guard is the rail's: the press that carried focus INTO the last column must
  // not also open the panel. Deaf while the rail is open, while the genre
  // picker's trap is up (useTVKeys handles that), and while the panel's own
  // Back is pending.
  const onTV = useCallback(
    (evt: {eventType: string}) => {
      const t = evt.eventType;
      if (!panel) {
        if (t === 'right' && atRightEdge() && !railOpen() && !focusJustMoved(120)) openPanel();
        return;
      }
      if (t === 'left') closePanel();
    },
    [panel, openPanel, closePanel],
  );
  useTVKeys(onTV);
  useEffect(() => {
    if (!panel) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closePanel();
      return true;
    });
    return () => sub.remove();
  }, [panel, closePanel]);

  // Where focus goes if it is ever lost on this screen: the first card. The
  // Empty state brings its own.
  useFocusFallback(firstCard);

  // Claim the first card once, when the grid first fills. NOT per filter: the
  // panel hands focus back to the card you left when it closes. See focus.ts.
  const claims = useListClaim('grid', items.length > 0);
  const onCardFocus = useCallback((_item: HeroItem, index: number) => {
    // Automatic paging, two rows ahead of the focus. The page APPENDS, so no
    // card already on screen moves; the only visible change is more rows
    // below, which is what "scrolling" is.
    if (index >= itemCountRef.current - cols * PREFETCH_ROWS) loadNextRef.current();
  }, [cols]);
  const renderCard = useCallback(
    ({item, index}: {item: HeroItem; index: number}) => (
      <Card
        item={item}
        index={index}
        ref={index === 0 ? firstCard : undefined}
        onPress={openDetail}
        onFocus={onCardFocus}
        // Column 0 has nothing to its left, so LEFT from it opens the rail; the
        // last column has nothing to its right, so RIGHT opens the filters.
        edgeLeft={index % cols === 0}
        edgeRight={index % cols === cols - 1}
        hasTVPreferredFocus={claims(index)}
      />
    ),
    [openDetail, onCardFocus, cols, claims],
  );

  // paintCount, transcribed (browse.js:411-423).
  const count = localOnly
    ? `${items.length} downloaded`
    : (owned ? `${owned} downloaded · ` : '') +
      `${items.length - owned} to stream${hasMore ? ' · more available' : ''}`;
  const taste = cat.taste && !genre ? tasteGenres.slice(0, 3) : [];
  const note = taste.length ? `From your ${taste.join(', ')}` : '';

  const skeletons = (lib === null || loading) && items.length === 0;
  // The spinner row under the grid while the next page is on its way. Not a
  // focus target — there is nothing to press.
  const footer =
    !localOnly && loading && items.length > 0 ? (
      <View style={styles.footer}>
        <MiniSpinner />
      </View>
    ) : null;

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.page, screenIn]}>
        {/* One line of chrome: the title, the live count, and — on the right
            — which category is showing, next to the strip that opens it. */}
        <View style={styles.head}>
          <Text style={styles.h1}>{title}</Text>
          <Text style={styles.count} numberOfLines={1}>
            {count}
          </Text>
          <View style={styles.spacer} />
          <Text style={styles.active} numberOfLines={1}>
            {[cat.label, genre, unwatched ? 'Unwatched' : ''].filter(Boolean).join(' · ')}
          </Text>
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
            actionLabel="Change filters"
            onAction={openPanel}
          />
        ) : (
          <FlatList
            ref={listRef}
            data={items}
            // numColumns cannot be changed in place, so the list is re-keyed.
            key={`${kind}-${cols}`}
            style={styles.listFill}
            numColumns={cols}
            // keyOf ALONE. With the index in the key, appending a page would
            // remount every card behind the insertion.
            keyExtractor={keyOf}
            columnWrapperStyle={styles.rowGap}
            contentContainerStyle={[styles.grid, {paddingBottom: CLEARANCE.below + safeBottom}]}
            initialNumToRender={24}
            maxToRenderPerBatch={12}
            // Measured on the Streamer (see git history for the numbers): with
            // clipping off the grid degraded to 750ms frames the longer you
            // browsed; on, it stays flat. The clearance is contentContainer
            // padding, so a focused card's ring on the last row is never clipped.
            removeClippedSubviews
            windowSize={3}
            renderItem={renderCard}
            ListFooterComponent={footer}
          />
        )}
      </Animated.View>

      {/* The passive edge strip — the panel's "collapsed" state, mirroring the
          rail's: a tune glyph, no focus target, fading out as the panel arrives. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.strip, {opacity: slide.interpolate({inputRange: [0, 1], outputRange: [1, 0]})}]}>
        <View style={styles.tune}>
          <View style={[styles.tuneBar, {width: 18}]} />
          <View style={[styles.tuneBar, {width: 12}]} />
          <View style={[styles.tuneBar, {width: 6}]} />
        </View>
      </Animated.View>

      {panel ? (
        <Animated.View
          style={[
            styles.panel,
            {transform: [{translateX: slide.interpolate({inputRange: [0, 1], outputRange: [PANEL_W, 0]})}]},
          ]}>
          {/* Traps all four directions: the grid behind is unreachable while the
              panel is up; LEFT is handled above as "close". The active category
              claims focus on open — the most useful place to start. */}
          <TVFocusGuideView
            autoFocus
            trapFocusLeft
            trapFocusRight
            trapFocusUp
            trapFocusDown
            style={styles.panelInner}>
            <Text style={styles.kicker}>{title.toUpperCase()}</Text>
            <View style={styles.cats}>
              {CATEGORIES.map(c => (
                <Chip
                  key={c.id}
                  bare
                  label={c.label}
                  on={category === c.id}
                  hasTVPreferredFocus={category === c.id}
                  onPress={() => category !== c.id && pick(() => setCategory(c.id))}
                />
              ))}
            </View>
            <View style={styles.rule} />
            <Picker
              label="Genre"
              value={genre}
              options={[{label: 'All genres', value: ''}, ...genreList.map(g => ({label: g, value: g}))]}
              onPick={g => pick(() => setGenre(g))}
              onOpenChange={setPickerOpen}
            />
            <View style={styles.toolRow}>
              <Chip label="Unwatched" on={unwatched} onPress={() => pick(() => setUnwatched(u => !u))} />
            </View>
            {note ? <Text style={styles.note}>{note}</Text> : null}
            <View style={styles.spacer} />
            <Btn small glyph="🎲" label="Surprise me" onPress={surprise} />
          </TVFocusGuideView>
        </Animated.View>
      ) : null}

      {/* Outside the sliding page: `.nav` is not inside `.screen` on the site,
          and the entry animation is the screen's, not the app's. Gone while a
          panel or the genre picker owns the screen (§5.8). */}
      <NavRail active={kind === 'show' ? 'shows' : 'movies'} disabled={pickerOpen || panel} />
    </View>
  );
}

// Every chrome band carries the same horizontal frame (P1/P2): the rail plus its
// gutter on the left, the edge strip on the right.
const frame = {paddingLeft: spacing.contentLeft, paddingRight: STRIP_W + spacing.sm};

const styles = StyleSheet.create({
  // No backgroundColor: android:windowBackground is already this colour, and
  // painting it again cost a second full-screen fill on every frame.
  root: {flex: 1},
  page: {flex: 1},
  head: {flexDirection: 'row', alignItems: 'baseline', gap: 16, paddingTop: 27, paddingBottom: 2, ...frame},
  // --fs-title 35.2 x 0.72 = 26 (P8), lh 1.5, -0.02em.
  h1: {color: colors.text, fontSize: fontSize.title, lineHeight: 39, fontWeight: '900', letterSpacing: -0.52},
  count: {color: colors.textFaint, fontSize: 16, lineHeight: 24, fontWeight: '600', flexShrink: 1},
  spacer: {flex: 1},
  // What the panel currently says, in its own words, so the grid never has to
  // be guessed at while the panel is shut.
  active: {color: colors.textDim, fontSize: 16, lineHeight: 24, fontWeight: '700', flexShrink: 1},
  listFill: {flex: 1},
  // A vertical FlatList spends the clearance as padding and takes NO cancelling
  // margins: a recycled cell cannot be relied on to carry them (§F.4 / G.1).
  grid: {paddingTop: CLEARANCE.above, ...frame},
  // NOT space-between: the gap is pinned at 13 and the residue stays trailing,
  // so the grid stays left-aligned under the content inset.
  rowGap: {gap: GRID_GAP, marginBottom: GRID_GAP},
  skelGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP, paddingTop: CLEARANCE.above, ...frame},
  footer: {alignItems: 'center', paddingVertical: spacing.md},

  // ---- the filter panel ------------------------------------------------
  strip: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: STRIP_W,
    alignItems: 'center',
    paddingTop: 27 + 8,
    zIndex: 100,
  },
  tune: {gap: 4, alignItems: 'flex-end', width: 18},
  tuneBar: {height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.35)'},
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: PANEL_W,
    // Opaque, like the rail: measured on the Streamer, a 3% see-through reads
    // as ghost posters behind the controls.
    backgroundColor: '#0a0b14',
    borderLeftWidth: 1,
    borderLeftColor: 'rgba(255,255,255,0.09)',
    zIndex: 101,
  },
  // Insets to the 48dp safe edge on the right, the panel's own gutter on the left.
  // Budgeted against a 540dp panel: 18 + kicker 24 + six 48dp chips + rule 9 +
  // picker 48 + chip 48 + Surprise 48 + 27 = 510. The first cut had 27/8/6 here
  // and came to 543 — Surprise me sat clipped below the safe inset.
  panelInner: {flex: 1, paddingLeft: 18, paddingRight: spacing.pageX, paddingTop: 18, paddingBottom: 27},
  kicker: {color: colors.accent, fontSize: fontSize.small, fontWeight: '800', letterSpacing: 3, marginBottom: 4},
  cats: {alignItems: 'flex-start'},
  rule: {height: 1, backgroundColor: colors.line, marginVertical: 4},
  toolRow: {flexDirection: 'row', alignItems: 'center'},
  note: {color: colors.textFaint, fontSize: 14, fontWeight: '600', marginTop: 2},
});
