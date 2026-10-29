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
import {useSafeAreaInsets} from 'react-native-safe-area-context';
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
import {useSolidBar} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import {greeting} from '../greeting';
import {heroCover} from '../heroArt';
import {onReselect} from '../tabs';
import {phoneNative} from '../native';
import {FADE_MS, LISTS} from '../lowEnd';
import {colors, FRAME_W, GUTTER, POSTER_H, POSTER_W, radius, SHELF_GAP} from '../theme';


const HERO_DWELL_MS = 9000; // the site's billboard turn (home.js HERO_DWELL_MS)
const NEW_MS = 7 * 24 * 3600 * 1000;

function snapshotFor(profileId: string, got: Primed | undefined): HomeData | null {
  if (!got || !got.rec) return null;
  const audience = expectedAudience(profileId, audienceOf(profileId), got.lock);
  if (!usable(got.rec, {server: getBaseUrl(), profileId, audience, now: Date.now()})) return null;
  return snapshotHome<HomeData>(got.rec);
}

/** "Good evening, <name>": the name lit as the site lights it (.greet-name — a violet-to-blue
 *  gradient through the letters; here its middle colour, a gradient cannot fill text). */
function greetLine(line: string, name?: string) {
  const i = name ? line.lastIndexOf(name) : -1;
  if (!name || i < 0) return line;
  return (
    <>
      {line.slice(0, i)}
      <Text style={s.greetName}>{name}</Text>
      {line.slice(i + name.length)}
    </>
  );
}

const kindOf = (it: HeroItem) => (it.type === 'show' || (it as {type?: string}).type === 'series' ? 'show' : 'movie');

// ---------------------------------------------------------------- billboard
const Slide = React.memo(function Slide({item, w, h, land, onPlay, onDetails, onTextH}: {item: HeroItem; w: number; h: number; land?: boolean; onPlay: (it: HeroItem) => void; onDetails: (it: HeroItem) => void; onTextH?: (h: number) => void}) {
  const show = kindOf(item) === 'show';
  const portrait = h > w;
  // a phone held upright: the POSTER (large) fills the billboard, as on the site (ui.js
  // heroShowsPoster / heroCover); sideways, the wide backdrop
  const {src} = portrait
    ? artSrc(heroCover(item.cover || item.poster) || item.backdrop, w)
    : artSrc(item.backdrop || item.poster || item.cover, w);
  const facts = [item.year, show ? 'Series' : 'Film', ...(item.genres || []).slice(0, 3)].filter(Boolean).join(' · ');
  const score = typeof item.rating === 'number' && item.rating > 0 ? item.rating.toFixed(1) : null;
  return (
    <View style={{width: w, height: h + (land ? 12 : 8), paddingHorizontal: land ? 12 : 8}}>
      <Tap flat onPress={() => onDetails(item)} style={[s.slide, {height: h}, land && s.slideLand]} accessibilityLabel={`${item.title}, details`}>
        {src ? <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={FADE_MS} /> : null}
        <View style={s.slideFade} pointerEvents="none" />
        <View style={s.slideText} onLayout={onTextH ? e => onTextH(Math.ceil(e.nativeEvent.layout.height)) : undefined}>
          <View style={s.kicker}>
            <Text style={[s.kickerText, {color: show ? colors.kindSeries : colors.kindFilm}]}>{show ? 'SERIES' : 'FILM'}</Text>
          </View>
          <Text style={s.heroTitle} numberOfLines={2}>
            {item.title}
          </Text>
          {score || facts ? (
            <View style={s.heroMetaRow}>
              {score ? <Text style={s.star}>★ {score}</Text> : null}
              <Text style={s.heroMeta} numberOfLines={1}>
                {facts}
              </Text>
            </View>
          ) : null}
          <View style={s.heroBtns}>
            <PrimaryButton uiId="home.hero.play" testID="phone-hero-play" icon="play" label={item.source === 'stream' ? 'Stream' : 'Play'} onPress={() => onPlay(item)} style={s.heroBtn} />
            <GlassButton uiId="home.hero.details" testID="phone-hero-details" icon="info" label="Details" onPress={() => onDetails(item)} style={s.heroBtn} />
          </View>
        </View>
      </Tap>
    </View>
  );
});

function Billboard({items, onPlay, onDetails, active}: {items: HeroItem[]; onPlay: (it: HeroItem) => void; onDetails: (it: HeroItem) => void; active: boolean}) {
  const {width, height} = useWindowDimensions();
  // landscape: a shorter billboard, so the greeting sits above the tab bar at rest — but never
  // so short that a slide's words (kicker, name, buttons; measured) reach up under the top bar
  const insets = useSafeAreaInsets();
  const [textH, setTextH] = useState(0);
  const onTextH = useCallback((t: number) => setTextH(was => (t > was ? t : was)), []);
  const floor = textH ? textH + 40 + insets.top + 8 + 46 + 12 : 0;
  // the site's phone billboard: min(60vh, 530px) (glass.css)
  // sideways, the site's wide billboard: 12 from the edges and nearly the whole height (345 of 411)
  const h = Math.max(Math.round(height > width ? Math.min(height * 0.6, 530) : height - 66), floor);
  const land = width > height;
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
  // a turn of the phone: the pager stays on the slide it showed (its offset was in the old width)
  const idxRef = useRef(idx);
  idxRef.current = idx;
  // (once the list has its new size: a jump made before that is clamped to the old one)
  const snap = useCallback(() => list.current?.scrollToOffset({offset: idxRef.current * width, animated: false}), [width]);
  useEffect(() => {
    snap();
  }, [snap]);
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
        renderItem={({item}) => <Slide item={item} w={width} h={h} land={land} onPlay={onPlay} onDetails={onDetails} onTextH={onTextH} />}
        getItemLayout={(_, i) => ({length: width, offset: width * i, index: i})}
        onScrollBeginDrag={() => {
          touchedAt.current = Date.now();
        }}
        onMomentumScrollEnd={onEnd}
        initialNumToRender={2}
        windowSize={3}
        extraData={width}
        onContentSizeChange={snap}
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
      <FlatList
        data={items}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(it, i) => `${it.id || it.imdbId || it.title}-${i}`}
        renderItem={render}
        contentContainerStyle={s.shelfList}
        ItemSeparatorComponent={Gap}
        getItemLayout={(_, i) => ({length: w + SHELF_GAP, offset: (w + SHELF_GAP) * i, index: i})}
        initialNumToRender={frame ? 2 : LISTS.shelfInitial}
        maxToRenderPerBatch={4}
        windowSize={LISTS.shelfWindow}
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
  // the billboard's picture may sit under the bar; its words and buttons may not
  const bar = useSolidBar(data?.hero.length ? 140 : 12);

  // the launch mark the device checks read: Home's shelves first on screen
  const firstData = useRef(data);
  useEffect(() => {
    if (!data) return;
    requestAnimationFrame(() => markLaunch('paint', data === firstData.current ? 'src=snapshot' : 'src=network'));
  }, [data]);

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
          <Text style={s.greetLine}>{greetLine(g.line, me.name)}</Text>
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
            <GlassButton uiId="home.retry" label="Try again" icon="refresh" onPress={() => load(true)} style={{marginTop: 16}} />
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
          bar.onScroll(e);
          const y = e.nativeEvent.contentOffset.y;
          const on = y < 300;
          if (on !== heroOn) setHeroOn(on);
        }}
        scrollEventThrottle={64}
        initialNumToRender={LISTS.homeInitial}
        maxToRenderPerBatch={LISTS.homeBatch}
        windowSize={LISTS.homeWindow}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} colors={[colors.accentStrong]} progressBackgroundColor="#1b1d36" />}
        ListEmptyComponent={null}
      />
      {empty ? <Text style={s.empty}>{emptyHomeLine(me?.kids?.maxAge ?? null).message}</Text> : null}
      <TopBar solid={bar.solid} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: GUTTER},
  errTitle: {color: colors.text, fontSize: 20, fontWeight: '800'},
  errSub: {color: colors.textDim, fontSize: 15, marginTop: 6, textAlign: 'center'},
  empty: {position: 'absolute', top: 200, left: GUTTER, right: GUTTER, color: colors.textDim, fontSize: 16, textAlign: 'center'},
  // .hero (glass, phone): 8 from the sides and the top, 24 round, the art under a fade from the foot
  slide: {borderRadius: 24, overflow: 'hidden', backgroundColor: '#11131f', marginTop: 8},
  slideLand: {borderRadius: 32, marginTop: 12},
  slideFade: {
    ...StyleSheet.absoluteFill,
    experimental_backgroundImage: 'linear-gradient(0deg, rgba(7,8,17,0.95) 0%, rgba(7,8,17,0.4) 50%, rgba(7,8,17,0) 80%)',
  },
  // .hero-inner: 20 in, 44 above the foot (the dots sit under the buttons)
  slideText: {position: 'absolute', left: 20, right: 20, bottom: 44},
  // .hero-kicker: a white veil with a hairline ring, 11.2/800 in the kind's colour
  kicker: {alignSelf: 'flex-start', paddingHorizontal: 12, height: 28.8, borderRadius: 14.4, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center'},
  kickerText: {fontSize: 11.2, fontWeight: '800', letterSpacing: 0.9},
  heroTitle: {color: colors.text, fontSize: 33.6, fontWeight: '900', letterSpacing: -1, lineHeight: 36, marginTop: 13},
  heroMetaRow: {flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 11},
  heroMeta: {flexShrink: 1, color: colors.textDim, fontSize: 14.4, fontWeight: '600', lineHeight: 21.6},
  star: {color: colors.star, fontSize: 14.4, fontWeight: '800', lineHeight: 21.6},
  heroBtns: {flexDirection: 'row', gap: 12, marginTop: 12},
  heroBtn: {paddingHorizontal: 26},
  // .hero-dots: 7 dp dots 18 apart, the one on 22 wide and lit, 19 above the foot
  dots: {position: 'absolute', bottom: 19, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 18},
  dot: {width: 7, height: 7, borderRadius: 3.5, backgroundColor: 'rgba(255,255,255,0.36)'},
  dotOn: {width: 22, backgroundColor: '#fff', boxShadow: '0 0 10px rgba(255,255,255,0.5)'},
  // .home-greeting.big: 14 under the billboard, 22.4/900 on a 33.6 line, the day's line 15.68/600
  greet: {paddingHorizontal: GUTTER, paddingTop: 14, marginBottom: -6},
  greetLine: {color: colors.text, fontSize: 22.4, fontWeight: '900', letterSpacing: -0.22, lineHeight: 33.6},
  greetName: {color: '#a68cff'},
  greetSub: {color: colors.textDim, fontSize: 15.68, fontWeight: '600', lineHeight: 23.5, marginTop: 4},
  parties: {paddingHorizontal: GUTTER, marginTop: 14, gap: 8},
  party: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: radius.l, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge},
  partyIcon: {fontSize: 20},
  partyText: {flex: 1, color: colors.text, fontSize: 14},
  partyCta: {color: '#fff', fontWeight: '800', fontSize: 15, backgroundColor: colors.accentStrong, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14, overflow: 'hidden'},
  // section.row: 18 under the last row's cards (12 under the greeting), .row-title 17.6/800 on
  // a 26.4 line, the cards 18 under it; the row's small explanation is not shown on a phone
  shelf: {marginTop: 18},
  shelfTitle: {color: colors.text, fontSize: 17.6, fontWeight: '800', letterSpacing: -0.18, lineHeight: 26.4, paddingHorizontal: GUTTER},
  shelfList: {paddingHorizontal: GUTTER, paddingTop: 18},
  showAll: {width: POSTER_W, height: POSTER_H, borderRadius: 12, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge, alignItems: 'center', justifyContent: 'center', gap: 6},
  showAllText: {color: colors.text, fontSize: 15, fontWeight: '800'},
});
