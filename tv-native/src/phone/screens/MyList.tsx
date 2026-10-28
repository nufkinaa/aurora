// My List on the phone — the website's list page: the sort and either/or
// chips (Unwatched · In progress · Watched, Films · Series, Downloaded ·
// Streamable) over the grid. The sorts and filters are the TV's, which are
// the site's (screens/MyList.tsx).
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useIsFocused} from '@react-navigation/native';
import {api, HeroItem, ProfileState} from '../../api';
import {useApp} from '../../AppContext';
import {openItem} from '../../openItem';
import {Marks, watchStateFor} from '../../watchState';
import {usePNav} from '../nav';
import Grid from '../ui/Grid';
import {ChipButton, GlassButton} from '../ui/Buttons';
import PageHead from '../ui/PageHead';
import TopBar from '../ui/TopBar';
import {useTabBarSpace} from '../ui/TabBar';
import Sheet from '../ui/Sheet';
import ListRow from '../ui/Row';
import Icon from '../ui/Icon';
import {onReselect, setTab} from '../tabs';
import {colors, GUTTER} from '../theme';

const byTitle = (a: HeroItem, b: HeroItem) => (a.title || '').localeCompare(b.title || '');
type Sort = {id: string; label: string; cmp?: (m: (i: HeroItem) => Marks) => (a: HeroItem, b: HeroItem) => number};
const SORTS: Sort[] = [
  {id: 'listed', label: 'Recently listed'},
  {id: 'title', label: 'A – Z', cmp: () => byTitle},
  {id: 'watched', label: 'Last watched', cmp: m => (a, b) => m(b).at - m(a).at},
  {id: 'added', label: 'Added to server', cmp: () => (a, b) => ((b as {addedAt?: number}).addedAt || 0) - ((a as {addedAt?: number}).addedAt || 0)},
  {id: 'year', label: 'Newest', cmp: () => (a, b) => (b.year || 0) - (a.year || 0)},
  {id: 'rating', label: 'Top rated', cmp: () => (a, b) => (b.rating || 0) - (a.rating || 0)},
];
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

export default function MyList() {
  const navigation = usePNav();
  const focused = useIsFocused();
  const {profileId} = useApp();
  const bottom = useTabBarSpace();
  const [items, setItems] = useState<HeroItem[] | null>(null);
  const [state, setState] = useState<ProfileState | null>(null);
  const [err, setErr] = useState('');
  const [sortId, setSortId] = useState('listed');
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [sortSheet, setSortSheet] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<any>(null);
  const load = useCallback(
    () =>
      Promise.all([api.watchlist(profileId), api.state(profileId).catch(() => null)])
        .then(([w, st]) => {
          setItems(w.items || []);
          if (st) setState(st);
          setErr('');
        })
        .catch(e => setErr(String(e?.message || "Couldn't load My List"))),
    [profileId],
  );
  useEffect(() => {
    if (focused) load();
  }, [focused, load]);
  useEffect(() => onReselect(t => t === 'list' && listRef.current?.scrollToOffset?.({offset: 0, animated: true})), []);
  const mark = useMemo(() => watchStateFor(state), [state]);
  const shown = useMemo(() => {
    let list = items || [];
    for (const [group, id] of Object.entries(picked)) {
      const f = FILTERS.find(x => x.group === group && x.id === id);
      if (f) list = list.filter(i => f.keep(i, mark(i)));
    }
    const sort = SORTS.find(x => x.id === sortId);
    if (sort?.cmp) list = [...list].sort(sort.cmp(mark));
    return list;
  }, [items, picked, sortId, mark]);
  const toggle = (f: Filter) => setPicked(p => (p[f.group] === f.id ? Object.fromEntries(Object.entries(p).filter(([g]) => g !== f.group)) : {...p, [f.group]: f.id}));
  const open = useCallback((it: HeroItem) => openItem(navigation, it), [navigation]);
  const sortLabel = SORTS.find(x => x.id === sortId)?.label || 'Sort';
  const header = (
    <View>
      <PageHead title="My List" sub={items ? `${items.length} ${items.length === 1 ? 'title' : 'titles'}` : null} />
      {items && items.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
          <ChipButton label={sortLabel} icon="chevronDown" onPress={() => setSortSheet(true)} />
          {FILTERS.map(f => (
            <ChipButton key={`${f.group}-${f.id}`} label={f.label} active={picked[f.group] === f.id} onPress={() => toggle(f)} />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
  return (
    <View style={s.root}>
      <Grid
        listRef={listRef}
        items={shown}
        onPress={open}
        header={header}
        bottomPad={bottom + 16}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
            tintColor={colors.text}
            colors={[colors.accentStrong]}
            progressBackgroundColor="#1b1d36"
          />
        }
        empty={
          items === null ? null : (
            <View style={s.empty}>
              <Icon name="bookmark" size={40} color={colors.textFaint} />
              <Text style={s.emptyText}>
                {err || (items.length ? 'Nothing matches. Try fewer filters?' : 'My List is empty. Tap + on anything that catches your eye.')}
              </Text>
              {!items.length && !err ? <GlassButton label="Browse movies" icon="film" onPress={() => setTab('movies')} /> : null}
            </View>
          )
        }
      />
      <TopBar />
      <Sheet visible={sortSheet} onClose={() => setSortSheet(false)} title="Sort">
        {SORTS.map(x => (
          <ListRow
            key={x.id}
            title={x.label}
            right={sortId === x.id ? <Icon name="check" size={22} color={colors.accent} /> : null}
            onPress={() => {
              setSortId(x.id);
              setSortSheet(false);
            }}
          />
        ))}
      </Sheet>
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  chips: {paddingHorizontal: GUTTER, paddingVertical: 10, gap: 8},
  empty: {alignItems: 'center', padding: 40, gap: 14},
  emptyText: {color: colors.textDim, fontSize: 16, textAlign: 'center', lineHeight: 22},
});
