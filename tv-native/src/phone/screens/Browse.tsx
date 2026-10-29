// Movies / Shows on the phone — the website's browse page: the categories as a
// row of chips (All · Trending · New · Top rated · For you · Downloaded), the
// genre and Unwatched beside them, and a grid of posters that pages in as you
// scroll. The categories, what "All" and "For you" mean and what an empty grid
// says are the TV's (screens/Browse.tsx, browseCopy.ts), which are the site's.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useRoute, RouteProp} from '@react-navigation/native';
import {api, HeroItem, ProfileState} from '../../api';
import {useApp} from '../../AppContext';
import {useMe} from '../../navSection';
import {openItem} from '../../openItem';
import {watchStateFor} from '../../watchState';
import {emptyGridLine} from '../../browseCopy';
import type {RootStackParamList} from '../../navigation';
import {usePNav} from '../nav';
import Grid from '../ui/Grid';
import {ChipButton, GlassButton, PickerChip} from '../ui/Buttons';
import SearchBox from '../ui/SearchBox';
import {showToast} from '../../toast';
import PageHead, {BackBar, useSolidBar} from '../ui/PageHead';
import TopBar from '../ui/TopBar';
import {useTabBarSpace} from '../ui/TabBar';
import Sheet from '../ui/Sheet';
import ListRow from '../ui/Row';
import Icon from '../ui/Icon';
import {onReselect} from '../tabs';
import {colors, GUTTER} from '../theme';

type Category = {id: string; label: string; catalog?: string; withLocal?: boolean; local?: boolean; taste?: boolean};
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

export function BrowseScreen({kind, pushed}: {kind: 'movie' | 'show'; pushed?: boolean}) {
  const bar = useSolidBar();
  const navigation = usePNav();
  const {profileId} = useApp();
  const me = useMe(profileId);
  const kidsAge = me?.kids?.maxAge ?? null;
  const bottom = useTabBarSpace();
  const [category, setCategory] = useState('all');
  const [genre, setGenre] = useState('');
  const [unwatched, setUnwatched] = useState(false);
  const [genres, setGenres] = useState<string[]>([]);
  const [genreSheet, setGenreSheet] = useState(false);
  const [lib, setLib] = useState<HeroItem[] | null>(null);
  const [fetched, setFetched] = useState<HeroItem[]>([]);
  const [page, setPage] = useState(-1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);
  const [tryN, setTryN] = useState(0);
  const [state, setState] = useState<ProfileState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [queryText, setQueryText] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<HeroItem[]>([]);
  const [searching, setSearching] = useState(false);
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qId = useRef(0);
  const runQuery = useCallback(
    (q: string) => {
      if (qTimer.current) clearTimeout(qTimer.current);
      setQuery(q);
      setFound([]);
      if (!q) {
        setSearching(false);
        return;
      }
      const id = ++qId.current;
      setSearching(true);
      api
        .discoverSearch(q)
        .then(d => id === qId.current && setFound((kind === 'show' ? d.shows : d.movies) || []))
        .catch(() => {})
        .finally(() => id === qId.current && setSearching(false));
    },
    [kind],
  );
  const onQuery = (t: string) => {
    setQueryText(t);
    if (qTimer.current) clearTimeout(qTimer.current);
    if (!t.trim()) return runQuery('');
    qTimer.current = setTimeout(() => runQuery(t.trim()), 300);
  };
  const reqId = useRef(0);
  const cache = useRef(new Map<string, {items: HeroItem[]; page: number; hasMore: boolean}>());
  const listRef = useRef<any>(null);
  const cat = CATEGORIES.find(c => c.id === category) || CATEGORIES[0];
  const key = `${kind}|${category}|${genre}`;

  useEffect(() => {
    let on = true;
    api
      .library()
      .then(l => on && setLib((kind === 'show' ? l.shows : l.movies).map(i => ({...i, source: 'downloaded' as const}))))
      .catch(() => on && setLib(l => l || []));
    api
      .catalogGenres(kind)
      .then(g => on && setGenres(g.genres || []))
      .catch(() => {});
    api
      .state(profileId)
      .then(st => on && setState(st))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [kind, profileId, tryN]);

  useEffect(() => {
    if (cat.local) {
      ++reqId.current;
      setFetched([]);
      setHasMore(false);
      setLoading(false);
      return;
    }
    const id = ++reqId.current;
    const hit = cache.current.get(key);
    if (hit) {
      setFetched(hit.items);
      setPage(hit.page);
      setHasMore(hit.hasMore);
      return;
    }
    setFetched([]);
    setPage(-1);
    setHasMore(true);
    setLoading(true);
    setErr(false);
    api
      .catalog({type: kind, category: cat.catalog || 'trending', genre: genre || null, page: 0})
      .then(r => {
        if (id !== reqId.current) return;
        const list = r.items || [];
        cache.current.set(key, {items: list, page: 0, hasMore: !!r.hasMore});
        setFetched(list);
        setPage(0);
        setHasMore(!!r.hasMore);
      })
      .catch(() => id === reqId.current && setErr(true))
      .finally(() => id === reqId.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tryN]);

  const more = useCallback(() => {
    if (loading || !hasMore || page < 0 || cat.local) return;
    const id = reqId.current;
    setLoading(true);
    api
      .catalog({type: kind, category: cat.catalog || 'trending', genre: genre || null, page: page + 1})
      .then(r => {
        if (id !== reqId.current) return;
        setFetched(f => {
          const seen = new Set(f.map(i => i.imdbId || i.id));
          const next = [...f, ...(r.items || []).filter(i => !seen.has(i.imdbId || i.id))];
          cache.current.set(key, {items: next, page: page + 1, hasMore: !!r.hasMore});
          return next;
        });
        setPage(page + 1);
        setHasMore(!!r.hasMore);
      })
      .catch(() => {})
      .finally(() => id === reqId.current && setLoading(false));
  }, [loading, hasMore, page, cat, kind, genre, key]);

  const marks = useMemo(() => watchStateFor(state), [state]);
  const liked = useMemo(() => {
    const picked = ((me?.prefs as {likedGenres?: string[]} | undefined)?.likedGenres || []).slice(0, 6);
    if (picked.length) return picked;
    const tally = new Map<string, number>();
    for (const i of lib || []) for (const g of i.genres || []) tally.set(g, (tally.get(g) || 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g);
  }, [me, lib]);
  const items = useMemo(() => {
    const downloaded = lib || [];
    if (query) {
      // the site's in-page search: what is on the server by that name at once, then the catalogue's
      const qn = norm(query);
      const local = downloaded.filter(i => norm(i.title).includes(qn)).sort(byTitle);
      const libTitles = new Set(downloaded.map(i => norm(i.title)));
      const stream = found.filter(m => m.imdbId && !libTitles.has(norm(m.title))).map(i => ({...i, source: 'stream' as const}));
      return [...local, ...stream];
    }
    let local: HeroItem[] = [];
    if (cat.local || cat.withLocal) {
      local = downloaded;
      if (genre) local = local.filter(i => (i.genres || []).includes(genre));
      if (unwatched) local = local.filter(i => !marks(i).finished);
      local = [...local].sort(byTitle);
    }
    if (cat.local) return local;
    const libTitles = new Set(downloaded.map(i => norm(i.title)));
    let stream = fetched.filter(m => m.imdbId && !libTitles.has(norm(m.title)));
    if (unwatched) stream = stream.filter(m => !marks(m).finished);
    let tagged = stream.map(i => ({...i, source: 'stream' as const}));
    if (cat.taste && liked.length && !genre) {
      const set = new Set(liked);
      tagged = [...tagged.filter(i => (i.genres || []).some(g => set.has(g))), ...tagged.filter(i => !(i.genres || []).some(g => set.has(g)))];
    }
    return [...local, ...tagged];
  }, [cat, fetched, genre, lib, marks, unwatched, liked, query, found]);

  useEffect(
    () =>
      pushed
        ? () => {}
        : onReselect(t => {
            if ((t === 'movies' && kind === 'movie') || (t === 'shows' && kind === 'show')) listRef.current?.scrollToOffset?.({offset: 0, animated: true});
          }),
    [kind, pushed],
  );

  const open = useCallback((it: HeroItem) => openItem(navigation, it), [navigation]);
  // 🎲 Surprise me (the site's surprise.js): anything on the page, something not started first
  const surprise = () => {
    const pool = items.length ? items : lib || [];
    if (!pool.length) return showToast('Nothing to roll for yet', '🎲');
    const fresh = pool.filter(i => {
      const m = marks(i);
      return !m.finished && !m.started;
    });
    const from = fresh.length ? fresh : pool;
    open(from[Math.floor(Math.random() * from.length)]);
  };
  const title = kind === 'show' ? 'Shows' : 'Movies';
  const owned = (lib || []).length;
  const empty = emptyGridLine({kind, category, genre, unwatched, kidsAge});
  // the site's count line (browse.js paintCount)
  const streamable = items.length - (cat.local || cat.withLocal ? items.filter(i => i.source === 'downloaded').length : 0);
  const countLine = query
    ? searching && !items.length
      ? 'Searching…'
      : `${items.length} result${items.length === 1 ? '' : 's'}`
    : cat.local
      ? `${items.length} downloaded`
      : `${cat.withLocal && owned ? `${owned} downloaded · ` : ''}${streamable} to stream${hasMore && !err ? ' · more available' : ''}`;
  const header = (
    <View>
      <PageHead
        title={title}
        sub={lib === null && !items.length ? null : countLine}
        right={<GlassButton uiId="browse.surprise" label="Surprise me" emoji="🎲" onPress={surprise} small style={s.surprise} />}
      />
      <View style={s.searchWrap}>
        <SearchBox
          value={queryText}
          onChangeText={onQuery}
          onSubmitEditing={() => runQuery(queryText.trim())}
          onClear={() => onQuery('')}
          uiIdClear="browse.filter.clear"
          placeholder={`Search ${title.toLowerCase()}…`}
          accessibilityLabel={`Search ${title}`}
        />
      </View>
      {query ? null : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.cats}>
            {CATEGORIES.map(c => (
              <ChipButton uiId="browse.category.pick" key={c.id} label={c.label} big active={category === c.id} onPress={() => setCategory(c.id)} />
            ))}
          </ScrollView>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tools}>
            <PickerChip uiId="phone.browse.genre" label="Genre" value={genre || 'All'} onPress={() => setGenreSheet(true)} />
            <ChipButton uiId="browse.unwatched" label="Unwatched" active={unwatched} onPress={() => setUnwatched(u => !u)} />
          </ScrollView>
        </>
      )}
    </View>
  );
  return (
    <View style={s.root}>
      <Grid
        onScroll={bar.onScroll}
        listRef={listRef}
        items={items}
        onPress={open}
        header={header}
        bottomPad={bottom + 16}
        onEndReached={more}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              cache.current.clear();
              setTryN(n => n + 1);
              setTimeout(() => setRefreshing(false), 800);
            }}
            tintColor={colors.text}
            colors={[colors.accentStrong]}
            progressBackgroundColor="#1b1d36"
          />
        }
        footer={loading ? <ActivityIndicator color={colors.text} style={{margin: 24}} /> : null}
        empty={
          loading || lib === null ? null : err ? (
            <View style={s.empty}>
              <Text style={s.emptyText}>Couldn't load this list.</Text>
              <GlassButton uiId="browse.retry" label="Try again" icon="refresh" onPress={() => setTryN(n => n + 1)} style={{marginTop: 12}} />
            </View>
          ) : (
            <View style={s.empty}>
              <Icon name={kind === 'show' ? 'series' : 'film'} size={40} color={colors.textFaint} />
              <Text style={s.emptyText}>{empty.message}</Text>
            </View>
          )
        }
      />
      {pushed ? <BackBar solid={bar.solid} title={bar.solid ? title : undefined} /> : <TopBar solid={bar.solid} />}
      <Sheet visible={genreSheet} onClose={() => setGenreSheet(false)} title="Genre">
        <ListRow
          title="All genres"
          right={!genre ? <Icon name="check" size={22} color={colors.accent} /> : null}
          onPress={() => {
            setGenre('');
            setGenreSheet(false);
          }}
        />
        {genres.map(g => (
          <ListRow
            key={g}
            title={g}
            right={genre === g ? <Icon name="check" size={22} color={colors.accent} /> : null}
            onPress={() => {
              setGenre(g);
              setGenreSheet(false);
            }}
          />
        ))}
      </Sheet>
    </View>
  );
}

export const MoviesTab = () => <BrowseScreen kind="movie" />;
export const ShowsTab = () => <BrowseScreen kind="show" />;

/** The pushed route ("Show all" from somewhere, a link). */
export default function Browse() {
  const route = useRoute<RouteProp<RootStackParamList, 'Browse'>>();
  return <BrowseScreen kind={route.params?.kind || 'movie'} pushed />;
}

const s = StyleSheet.create({
  root: {flex: 1},
  // .search-wrap 6 16 4 · .cat-row 8 16, 8 apart · .filter-bar.tools 6 16 8, 4 apart
  searchWrap: {paddingHorizontal: GUTTER, paddingTop: 6, paddingBottom: 4},
  cats: {paddingHorizontal: GUTTER, paddingVertical: 8, gap: 8},
  tools: {paddingHorizontal: GUTTER, paddingTop: 6, paddingBottom: 0, gap: 4},
  surprise: {marginLeft: 'auto', marginTop: 3},
  empty: {alignItems: 'center', padding: 40, gap: 12},
  emptyText: {color: colors.textDim, fontSize: 16, textAlign: 'center'},
});
