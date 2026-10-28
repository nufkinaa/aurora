// Home on the phone — the website's phone Home, glass look:
//
//   the billboard     a swipeable carousel of the server's picks, each with its
//                     kicker (FILM / SERIES), title, score · year · kind · genres,
//                     Stream/Play + Details, and the dots; turns by itself every
//                     9 s while nobody touches it and it is on screen
//   the greeting      "Good evening, <name>" and the day's line
//   watching together a strip per party in progress, one tap to join
//   the shelves       every row the server sends, in its order — Continue
//                     Watching as frame cards (✕ takes one off), "Recommended by
//                     your household" with its Show all tile, the rest posters
//
// What each press means is the TV's (openItem.ts; Home.tsx heroPlay /
// playContinue / removeFromContinue): a library film plays at once, anything
// else opens its page — which presses its own Play for the billboard's Stream.
// The first frame can be the last answer kept on the phone (homeSnapshot.ts),
// and a fresh answer never moves what is on screen while you look (homeMerge.ts
// "quiet"); pull down to read it again.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Image,
  NativeScrollEvent,
  NativeSyntheticEvent,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {useIsFocused} from '@react-navigation/native';
import {api, audienceOf, getBaseUrl, HeroItem, Home as HomeData, HomeRow, keptHomeText, PartySummary} from '../../api';
import {useApp} from '../../AppContext';
import {useMe} from '../../navSection';
import {openItem} from '../../openItem';
import {canNavigate} from '../../navLock';
import {showToast} from '../../toast';
import {onMessage} from '../../realtime';
import {locksFor, mergeHome} from '../../homeMerge';
import {expectedAudience, markLaunch, Primed, primedSnapshot, saveSnapshot, snapshotHome, usable, whenSnapshot} from '../../homeSnapshot';
import {isShowAll, withShowAll} from '../../householdRecs';
import {noteShown, onHouseholdChanged} from '../../householdLive';
import {openActions, openRecommend} from '../../overlay';
import {emptyHomeLine} from '../../browseCopy';
import {resolvePartyRoute} from '../../party';
import {usePNav} from '../nav';
import {artSrc, FrameCard, PosterCard} from '../ui/Cards';
import {PrimaryButton, GlassButton} from '../ui/Buttons';
import Tap from '../ui/Tap';
import Icon from '../ui/Icon';
import TopBar from '../ui/TopBar';
import {useTabBarSpace} from '../ui/TabBar';
import {greeting} from '../greeting';
import {onReselect} from '../tabs';
import {phoneNative} from '../native';
import {colors, FRAME_W, GUTTER, POSTER_W, radius, SHELF_GAP} from '../theme';


const HERO_DWELL_MS = 9000; // the site's billboard turn (home.js HERO_DWELL_MS)
const NEW_MS = 7 * 24 * 3600 * 1000;

function snapshotFor(profileId: string, got: Primed | undefined): HomeData | null {
  if (!got || !got.rec) return null;
  const audience = expectedAudience(profileId, audienceOf(profileId), got.lock);
  if (!usable(got.rec, {server: getBaseUrl(), profileId, audience, now: Date.now()})) return null;
  return snapshotHome<HomeData>(got.rec);
}

const kindOf = (it: HeroItem) => (it.type === 'show' || (it as {type?: string}).type === 'series' ? 'show' : 'movie');

// ---------------------------------------------------------------- billboard
const Slide = React.memo(function Slide({item, w, h, onPlay, onDetails}: {item: HeroItem; w: number; h: number; onPlay: (it: HeroItem) => void; onDetails: (it: HeroItem) => void}) {
  const show = kindOf(item) === 'show';
  const portrait = h > w;
  // a tall phone shows more of a poster than of a 16:9 backdrop: the backdrop is the
  // billboard's picture, cropped to the middle (the site does the same)
  const {src} = artSrc(item.backdrop || item.poster || item.cover, portrait ? Math.round((h * 16) / 9) : w);
  const facts = [item.year, show ? 'Series' : 'Film', ...(item.genres || []).slice(0, 3)].filter(Boolean).join(' · ');
  const score = typeof item.rating === 'number' && item.rating > 0 ? item.rating.toFixed(1) : null;
  return (
    <View style={{width: w, height: h, paddingHorizontal: 8}}>
      <Tap flat onPress={() => onDetails(item)} style={[s.slide, {height: h}]} accessibilityLabel={`${item.title}, details`}>
        {src ? <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={200} /> : null}
        <View style={s.slideFade} pointerEvents="none" />
        <View style={s.slideText}>
          <View style={[s.kicker, {borderColor: show ? 'rgba(127,209,232,0.4)' : 'rgba(240,198,126,0.4)'}]}>
            <Text style={[s.kickerText, {color: show ? colors.kindSeries : colors.kindFilm}]}>{show ? 'SERIES' : 'FILM'}</Text>
          </View>
          <Text style={s.heroTitle} numberOfLines={2}>
            {item.title}
          </Text>
          {score || facts ? (
            <Text style={s.heroMeta} numberOfLines={1}>
              {score ? <Text style={s.star}>★ {score}   </Text> : null}
              {facts}
            </Text>
          ) : null}
          <View style={s.heroBtns}>
            <PrimaryButton testID="phone.hero.play" icon="play" label={item.source === 'stream' ? 'Stream' : 'Play'} onPress={() => onPlay(item)} style={s.heroBtn} />
            <GlassButton testID="phone.hero.details" icon="info" label="Details" onPress={() => onDetails(item)} style={s.heroBtn} />
          </View>
        </View>
      </Tap>
    </View>
  );
});

function Billboard({items, onPlay, onDetails, active}: {items: HeroItem[]; onPlay: (it: HeroItem) => void; onDetails: (it: HeroItem) => void; active: boolean}) {
  const {width, height} = useWindowDimensions();
  const h = Math.round(height > width ? Math.min(height * 0.6, width * 1.45) : height * 0.82);
  const [idx, setIdx] = useState(0);
  const list = useRef<FlatList<HeroItem>>(null);
  const touchedAt = useRef(0);
  const n = items.length;
  useEffect(() => {
    if (!active || n < 2) return;
    const t = setInterval(() => {
      if (Date.now() - touchedAt.current < HERO_DWELL_MS) return;
      setIdx(i => {
        const next = (i + 1) % n;
        list.current?.scrollToOffset({offset: next * width, animated: true});
        return next;
      });
    }, HERO_DWELL_MS);
    return () => clearInterval(t);
  }, [active, n, width]);
  const onEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== idx) setIdx(Math.max(0, Math.min(n - 1, i)));
  };
  if (!n) return null;
  return (
    <View>
      <FlatList
        ref={list}
        data={items}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(it, i) => `${it.id || it.imdbId || it.title}-${i}`}
        renderItem={({item}) => <Slide item={item} w={width} h={h} onPlay={onPlay} onDetails={onDetails} />}
        getItemLayout={(_, i) => ({length: width, offset: width * i, index: i})}
        onScrollBeginDrag={() => {
          touchedAt.current = Date.now();
        }}
        onMomentumScrollEnd={onEnd}
        initialNumToRender={2}
        windowSize={3}
        extraData={width}
      />
      <View style={s.dots} pointerEvents="none">
        {items.map((_, i) => (
          <View key={i} style={[s.dot, i === idx && s.dotOn]} />
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- shelves
const Shelf = React.memo(function Shelf({
  row,
  onOpen,
  onLong,
  onRemove,
}: {
  row: HomeRow;
  onOpen: (row: HomeRow, it: HeroItem) => void;
  onLong: (it: HeroItem) => void;
  onRemove: (it: HeroItem) => void;
}) {
  const frame = row.id === 'continue';
  const items = row.id === 'household' ? (withShowAll(row.items, row.more) as HeroItem[]) : row.items;
  const w = frame ? FRAME_W : POSTER_W;
  const now = Date.now();
  const render = useCallback(
    ({item}: {item: HeroItem}) => {
      if (isShowAll(item)) {
        return (
          <Tap onPress={() => onOpen(row, item)} style={s.showAll} accessibilityRole="button" accessibilityLabel="Show all">
            <Icon name="chevronRight" size={28} color={colors.text} />
            <Text style={s.showAllText}>Show all</Text>
          </Tap>
        );
      }
      if (frame) return <FrameCard item={item} onPress={it => onOpen(row, it)} onRemove={onRemove} />;
      const added = (item as {addedAt?: number}).addedAt;
      return (
        <PosterCard
          item={item}
          onPress={it => onOpen(row, it)}
          onLongPress={onLong}
          isNew={row.id.startsWith('recent') && !!added && now - added < NEW_MS}
        />
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [row, frame, onOpen, onLong, onRemove],
  );
  if (!items.length) return null;
  return (
    <View style={s.shelf}>
      <Text style={s.shelfTitle} accessibilityRole="header">
        {row.title}
      </Text>
      {row.sub ? <Text style={s.shelfSub}>{row.sub}</Text> : null}
      <FlatList
        data={items}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(it, i) => `${it.id || it.imdbId || it.title}-${i}`}
        renderItem={render}
        contentContainerStyle={s.shelfList}
        ItemSeparatorComponent={Gap}
        getItemLayout={(_, i) => ({length: w + SHELF_GAP, offset: (w + SHELF_GAP) * i, index: i})}
        initialNumToRender={frame ? 2 : 4}
        maxToRenderPerBatch={4}
        windowSize={5}
        removeClippedSubviews
        decelerationRate="fast"
        snapToInterval={w + SHELF_GAP}
        snapToAlignment="start"
      />
    </View>
  );
});
const Gap = () => <View style={{width: SHELF_GAP}} />;

function Parties({parties, onJoin}: {parties: PartySummary[]; onJoin: (p: PartySummary) => void}) {
  if (!parties.length) return null;
  return (
    <View style={s.parties}>
      {parties.map(p => (
        <Tap key={p.code} onPress={() => onJoin(p)} style={s.party} accessibilityRole="button" accessibilityLabel={`Join ${p.host}'s watch party`}>
          <Text style={s.partyIcon}>👥</Text>
          <Text style={s.partyText} numberOfLines={2}>
            <Text style={{fontWeight: '800'}}>{p.host}</Text>
            {` is watching ${p.title} together`}
            <Text style={{color: colors.textDim}}>{` · ${p.members} watching · code ${p.code}`}</Text>
          </Text>
          <Text style={s.partyCta}>Join</Text>
        </Tap>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- the screen
type Block = {key: string; row?: HomeRow};

export default function Home() {
  const navigation = usePNav();
  const focused = useIsFocused();
  const {profileId} = useApp();
  const me = useMe(profileId);
  const bottom = useTabBarSpace();
  const first = useRef<HomeData | null | undefined>(undefined);
  if (first.current === undefined) first.current = snapshotFor(profileId, primedSnapshot(profileId));
  const [data, setData] = useState<HomeData | null>(first.current);
  const dataRef = useRef<HomeData | null>(first.current);
  dataRef.current = data;
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const [parties, setParties] = useState<PartySummary[]>([]);
  const [heroOn, setHeroOn] = useState(true);
  const touched = useRef(false);
  const lastFetch = useRef(0);
  const savedText = useRef<string | null>(null);
  const listRef = useRef<FlatList<Block>>(null);

  // the box's copy, when it had not been read yet at mount
  useEffect(() => {
    if (dataRef.current) return;
    let on = true;
    whenSnapshot(profileId).then(got => {
      if (!on || dataRef.current) return;
      const snap = snapshotFor(profileId, got);
      if (snap) setData(snap);
    });
    return () => {
      on = false;
    };
  }, [profileId]);

  const take = useCallback(
    (h: HomeData) => {
      const prev = dataRef.current;
      // nothing on screen yet, or nobody has touched it: the answer as it is; else the
      // shelves on screen keep their cards where they are (the TV's "quiet" merge)
      const next = !prev || !touched.current ? h : mergeHome(prev, h, locksFor('quiet', {heroVisible: true, rows: prev.rows.slice(0, 3).map(r => ({id: r.id, from: 0, to: 3}))}, prev.rows)).home || h;
      setData(next);
      setError('');
      noteShown(h.rows.find(r => r.id === 'household')?.items as never);
      const text = keptHomeText(profileId, h);
      const server = getBaseUrl();
      if (text && server && text !== savedText.current) {
        savedText.current = text;
        const rec = {v: 1 as const, at: Date.now(), server, profileId, audience: audienceOf(profileId) || 'all', chars: text.length, text};
        setTimeout(() => saveSnapshot(rec), 4000);
      }
      markLaunch('fresh', `phone merged=${prev ? 'yes' : 'no'}`);
    },
    [profileId],
  );

  const load = useCallback(
    (force = false) => {
      if (!force && dataRef.current && Date.now() - lastFetch.current < 15000) return Promise.resolve();
      lastFetch.current = Date.now();
      return api
        .home(profileId)
        .then(take)
        .catch(e => {
          if (!dataRef.current) setError(String(e?.message || e));
        });
    },
    [profileId, take],
  );
  useEffect(() => {
    if (focused) load();
  }, [focused, load, tick]);
  useEffect(() => {
    const a = onMessage('library_updated', () => {
      lastFetch.current = 0;
      setTick(n => n + 1);
    });
    const b = onHouseholdChanged(() => {
      lastFetch.current = 0;
      setTick(n => n + 1);
    });
    const c = AppState.addEventListener('change', st => {
      if (st === 'active') setTick(n => n + 1);
    });
    return () => {
      a();
      b();
      c.remove();
    };
  }, []);
  // watching together, right now
  useEffect(() => {
    let on = true;
    api
      .parties()
      .then(d => on && setParties((d.parties || []).filter(p => p.code)))
      .catch(() => {});
    const off = onMessage('party_list', d => setParties(((d.parties as PartySummary[]) || []).filter(p => p.code)));
    return () => {
      on = false;
      off();
    };
  }, []);
  // the Home tab tapped again: back to the top
  useEffect(
    () =>
      onReselect(t => {
        if (t === 'home') listRef.current?.scrollToOffset({offset: 0, animated: true});
      }),
    [],
  );

  const onRefresh = async () => {
    setRefreshing(true);
    touched.current = false;
    await load(true);
    setRefreshing(false);
  };

  // ---- presses (the TV's rules) ----
  const heroPlay = useCallback(
    (item: HeroItem) => {
      if (!canNavigate(navigation as never)) return;
      const copy = item.type === 'movie' ? (item.source !== 'stream' ? item.id : item.inLibrary) : null;
      if (copy) navigation.push('Player', {id: copy, title: item.title});
      else navigation.push('Detail', {item, play: true});
    },
    [navigation],
  );
  const openDetail = useCallback((item: HeroItem) => openItem(navigation, item), [navigation]);
  const onOpen = useCallback(
    (row: HomeRow, item: HeroItem) => {
      if (row.id === 'household' && isShowAll(item)) {
        if (canNavigate(navigation as never)) navigation.push('Household', undefined);
        return;
      }
      if (row.id === 'continue') {
        const libraryFilm = item.type === 'movie' && item.source !== 'stream' && !!item.id && !String(item.id).startsWith('torrent|');
        if (libraryFilm) {
          if (canNavigate(navigation as never)) navigation.push('Player', {id: item.id, title: item.title});
          return;
        }
      }
      openItem(navigation, item);
    },
    [navigation],
  );
  const onLong = useCallback(
    (item: HeroItem) => {
      phoneNative.haptic('long');
      openActions({
        title: item.title,
        sub: [item.year, kindOf(item) === 'show' ? 'Series' : 'Film'].filter(Boolean).join(' · '),
        items: [
          {label: 'Details', uiId: 'phone.peek.details', onPress: () => openItem(navigation, item)},
          {label: 'Recommend', uiId: 'phone.peek.recommend', onPress: () => openRecommend(item as never)},
        ],
      });
    },
    [navigation],
  );
  const onRemove = useCallback(
    (item: HeroItem) => {
      if (!item.id) return;
      const was = dataRef.current;
      setData(d => (d ? {...d, rows: d.rows.map(r => (r.id !== 'continue' ? r : {...r, items: r.items.filter(i => i.id !== item.id)}))} : d));
      const done = () => showToast('Removed from Continue Watching', '✓');
      const back = () => {
        showToast("Couldn't remove it — it is back in Continue Watching", '⚠');
        if (was) setData(was);
      };
      if (item.upNext && item.showId) api.dismissUpNext(profileId, item.showId, item.id).then(done, back);
      else api.clearProgress(profileId, item.id).then(done, back);
    },
    [profileId],
  );
  const joinParty = useCallback(
    async (p: PartySummary) => {
      const r = await resolvePartyRoute(p.code);
      if (!r) return showToast('That watch party has ended', '👥');
      if (canNavigate(navigation as never)) navigation.push('Player', {...r, party: p.code});
    },
    [navigation],
  );

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = [{key: 'hero'}, {key: 'greet'}, {key: 'parties'}];
    for (const r of data?.rows || []) out.push({key: `row-${r.id}`, row: r});
    return out;
  }, [data]);
  const g = greeting(me?.name || '');
  const renderBlock = ({item}: {item: Block}) => {
    if (item.key === 'hero') return <Billboard items={data?.hero || []} onPlay={heroPlay} onDetails={openDetail} active={focused && heroOn} />;
    if (item.key === 'greet')
      return me ? (
        <View style={s.greet}>
          <Text style={s.greetLine}>{g.line}</Text>
          <Text style={s.greetSub}>{g.sub}</Text>
        </View>
      ) : null;
    if (item.key === 'parties') return <Parties parties={parties} onJoin={joinParty} />;
    return item.row ? <Shelf row={item.row} onOpen={onOpen} onLong={onLong} onRemove={onRemove} /> : null;
  };

  if (!data) {
    return (
      <View style={s.center}>
        {error ? (
          <>
            <Text style={s.errTitle}>Couldn't load Home</Text>
            <Text style={s.errSub}>{error}</Text>
            <GlassButton label="Try again" icon="refresh" onPress={() => load(true)} style={{marginTop: 16}} />
          </>
        ) : (
          <ActivityIndicator color={colors.text} size="large" />
        )}
        <TopBar />
      </View>
    );
  }
  const empty = !data.hero.length && !data.rows.length;
  return (
    <View style={s.root}>
      <FlatList
        ref={listRef}
        data={blocks}
        keyExtractor={b => b.key}
        renderItem={renderBlock}
        contentContainerStyle={{paddingBottom: bottom + 12, paddingTop: data.hero.length ? 0 : 120}}
        onScrollBeginDrag={() => {
          touched.current = true;
        }}
        onScroll={e => {
          const y = e.nativeEvent.contentOffset.y;
          const on = y < 300;
          if (on !== heroOn) setHeroOn(on);
        }}
        scrollEventThrottle={64}
        initialNumToRender={5}
        maxToRenderPerBatch={3}
        windowSize={7}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} colors={[colors.accentStrong]} progressBackgroundColor="#1b1d36" />}
        ListEmptyComponent={null}
      />
      {empty ? <Text style={s.empty}>{emptyHomeLine(me?.kids?.maxAge ?? null).message}</Text> : null}
      <TopBar />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: GUTTER},
  errTitle: {color: colors.text, fontSize: 20, fontWeight: '800'},
  errSub: {color: colors.textDim, fontSize: 15, marginTop: 6, textAlign: 'center'},
  empty: {position: 'absolute', top: 200, left: GUTTER, right: GUTTER, color: colors.textDim, fontSize: 16, textAlign: 'center'},
  slide: {borderBottomLeftRadius: radius.xl + 4, borderBottomRightRadius: radius.xl + 4, borderTopLeftRadius: radius.xl + 4, borderTopRightRadius: radius.xl + 4, overflow: 'hidden', backgroundColor: '#11131f', marginTop: 8},
  slideFade: {
    ...StyleSheet.absoluteFill,
    experimental_backgroundImage: 'linear-gradient(180deg, rgba(8,9,16,0.35) 0%, rgba(8,9,16,0) 22%, rgba(8,9,16,0) 42%, rgba(8,9,16,0.72) 70%, rgba(8,9,16,0.96) 100%)',
  },
  slideText: {position: 'absolute', left: 18, right: 18, bottom: 40},
  kicker: {alignSelf: 'flex-start', paddingHorizontal: 12, height: 28, borderRadius: 14, borderWidth: 1, backgroundColor: 'rgba(8,9,16,0.4)', justifyContent: 'center', marginBottom: 10},
  kickerText: {fontSize: 12, fontWeight: '900', letterSpacing: 1.5},
  heroTitle: {color: '#fff', fontSize: 34, fontWeight: '900', letterSpacing: -0.5, lineHeight: 38},
  heroMeta: {color: 'rgba(255,255,255,0.86)', fontSize: 15, fontWeight: '600', marginTop: 8},
  star: {color: colors.star, fontWeight: '800'},
  heroBtns: {flexDirection: 'row', gap: 10, marginTop: 16},
  heroBtn: {paddingHorizontal: 22},
  dots: {position: 'absolute', bottom: 16, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 8},
  dot: {width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.45)'},
  dotOn: {width: 22, backgroundColor: '#fff'},
  greet: {paddingHorizontal: GUTTER, paddingTop: 26, paddingBottom: 4},
  greetLine: {color: colors.text, fontSize: 26, fontWeight: '800'},
  greetSub: {color: colors.textDim, fontSize: 16, marginTop: 6},
  parties: {paddingHorizontal: GUTTER, marginTop: 14, gap: 8},
  party: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: radius.l, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge},
  partyIcon: {fontSize: 20},
  partyText: {flex: 1, color: colors.text, fontSize: 14},
  partyCta: {color: '#fff', fontWeight: '800', fontSize: 15, backgroundColor: colors.accentStrong, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14, overflow: 'hidden'},
  shelf: {marginTop: 22},
  shelfTitle: {color: colors.text, fontSize: 20, fontWeight: '800', paddingHorizontal: GUTTER},
  shelfSub: {color: colors.textDim, fontSize: 14, paddingHorizontal: GUTTER, marginTop: 2},
  shelfList: {paddingHorizontal: GUTTER, paddingTop: 12},
  showAll: {width: POSTER_W, height: Math.round((POSTER_W * 3) / 2), borderRadius: radius.l, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge, alignItems: 'center', justifyContent: 'center', gap: 6},
  showAllText: {color: colors.text, fontSize: 15, fontWeight: '800'},
});
