// [household] "Recommended by your household" — the Show all page (the
// website's #/household; docs/qa/household-recs/DESIGN.md).
//
//   For you   every title the household recommended to this profile, in the
//             server's order (how many different people, then the newest), as
//             a grid of cards with their "From Dana…" line; a filter by person
//             ("Everyone" · Dana · Avi). OK opens the title, hold OK the sheet
//             (Add to My List, Not for me, Recommend).
//   You sent  what this profile recommended, newest first, and per person what
//             became of it: Sent · Seen · In their list · Watching · Watched.
//
// Opening the page counts everything as looked at (POST /household/seen): the
// row's "2 new" goes. Reached from the tile at the end of Home's row (only when
// there are more than 15) and from Settings → Recommendations → What you sent.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, Animated, FlatList, Image, ScrollView, StyleSheet} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useIsFocused} from '@react-navigation/native';
import Chip from '../components/Chip';
import Focusable from '../components/Focusable';
import NavRail from '../components/NavRail';
import Skeleton from '../components/Skeleton';
import {Empty, ErrorState} from '../components/States';
import Card, {CARD_W} from '../components/Card';
import {api, artSrc, HeroItem, HouseholdSentCard} from '../api';
import {openItem} from '../openItem';
import {warmItem} from '../prefetch';
import {noteOwnFocusMove, pressMovedFocus, railOpen, useFocusFallback, useListClaim, useTVKeys} from '../focus';
import {useScreenIn} from '../motion';
import {useApp} from '../AppContext';
import {useRouteShown} from '../useRouteShown';
import {RootStackParamList} from '../navigation';
import {filterOptions, iso, ltr, nameWord, statusWord, WORDS} from '../householdRecs';
import {householdChanged, noteShown, onHouseholdChanged} from '../householdLive';
import {track} from '../usage';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, radius, CLEARANCE} = theme;

const GRID_GAP = 13;
const STRIP_FADE = 64;
const GRID_FADE = 36;
const SKELETONS = 12;
const THUMB_W = 48;
const THUMB_H = 72;

// [household] what became of a recommendation, per person, in the colours the app already
// gives those states: a plain "Sent", a lit "Seen", the household's violet for "In their list",
// the series cyan for "Watching", the progress mint for "Watched".
const TONE: Record<string, string> = {
  sent: colors.textFaint,
  seen: colors.textDim,
  added: colors.accent,
  watching: colors.kindSeries,
  watched: '#8cffbe',
};

type Tab = 'forYou' | 'sent';

const SentRow = React.memo(function HouseholdSentRow({
  item,
  first,
  onOpen,
}: {
  item: HouseholdSentCard;
  first: boolean;
  onOpen: (item: HeroItem) => void;
}) {
  const art = artSrc(item.cover || item.poster, THUMB_W).src;
  const to = item.hh.to || [];
  // the note you sent (the same to everyone you picked at once; the newest one otherwise)
  const note = (to.find(t => t.note && t.note.trim()) || {note: ''}).note || '';
  return (
    <Focusable scaleTo={1.01} edgeLeft hasTVPreferredFocus={first} highlightColor={colors.surfaceHover} onPress={() => onOpen(item)} style={styles.sentRow}>
      <View style={styles.thumb}>
        {art ? (
          <Image source={art} style={styles.thumbImg} resizeMode="cover" fadeDuration={0} />
        ) : (
          <Text style={styles.thumbTitle} numberOfLines={3}>
            {item.title}
          </Text>
        )}
      </View>
      <View style={styles.sentText}>
        <Text style={styles.sentTitle} numberOfLines={1}>
          {ltr(iso(String(item.title || '')))}
          {item.year ? <Text style={styles.sentYear}>{`  ${item.year}`}</Text> : null}
        </Text>
        {note ? (
          <Text style={styles.sentNote} numberOfLines={1}>
            {/* “note” — you: the sender's own words, as the title page shows them */}
            {ltr(`“${iso(note.trim())}”`)}
          </Text>
        ) : null}
        <View style={styles.sentWho}>
          {to.map(t => (
            <View key={t.id} style={styles.status}>
              <View style={[styles.statusDot, {backgroundColor: TONE[t.status] || TONE.sent}]} />
              <Text style={[styles.statusText, t.status !== 'sent' && t.status !== 'seen' && {color: TONE[t.status]}]} numberOfLines={1}>
                {nameWord(t.name, statusWord(t.status))}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </Focusable>
  );
});

export default function Household({route, navigation}: NativeStackScreenProps<RootStackParamList, 'Household'>) {
  const {profileId} = useApp();
  const {width, safeBottom} = useTvMetrics();
  const isFocused = useIsFocused();
  const screenIn = useScreenIn();
  const cols = Math.max(3, Math.floor((width - spacing.contentLeft - spacing.pageX + GRID_GAP) / (CARD_W + GRID_GAP)));

  const [tab, setTab] = useState<Tab>(route.params?.tab === 'sent' ? 'sent' : 'forYou');
  const [from, setFrom] = useState('');
  const [items, setItems] = useState<HeroItem[] | null>(null);
  const [people, setPeople] = useState<{id: string; name: string}[]>([]);
  const [sent, setSent] = useState<HouseholdSentCard[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useRouteShown(tab === 'forYou' ? items !== null : sent !== null);

  // once per visit: the page was opened, and everything on it is now "seen"
  useEffect(() => {
    track('feat', {f: 'hhrec-all'});
    api
      .householdSeen(profileId)
      .then(r => {
        if (r && r.n) householdChanged(); // Home's "2 new" goes
      })
      .catch(() => {});
  }, [profileId]);

  // a recommendation arrived (or one was hidden from the sheet) while this page is up
  useEffect(() => onHouseholdChanged(() => setReload(n => n + 1)), []);

  // Read again on every return (a title was just added to My List from its page,
  // so it left the list) and whenever the tab or the filter changes.
  useEffect(() => {
    if (!isFocused) return;
    let live = true;
    setError('');
    if (tab === 'forYou') {
      api
        .household(profileId, from || null)
        .then(r => {
          if (!live) return;
          setItems(r.items || []);
          setPeople(r.people || []);
          noteShown(r.items as never);
        })
        .catch(() => live && setError('Could not load the recommendations.'));
    } else {
      api
        .householdSent(profileId)
        .then(r => live && setSent(r.items || []))
        .catch(() => live && setError('Could not load what you sent.'));
    }
    return () => {
      live = false;
    };
  }, [profileId, isFocused, tab, from, reload]);

  // UP out of the grid's top row, to the band above (MyList's escape: Android's
  // focus search often finds nothing above a top-row card).
  const inGrid = useRef(false);
  const gridIdx = useRef(0);
  const leaveGrid = useCallback((f: boolean) => {
    if (f) inGrid.current = false;
  }, []);
  const tabRef = useRef(null);
  const filterRef = useRef(null);
  useFocusFallback(tabRef);
  useTVKeys(
    useCallback(
      (evt: {eventType: string}) => {
        if (evt.eventType !== 'up' || railOpen() || pressMovedFocus()) return;
        if (!inGrid.current || gridIdx.current >= cols) return;
        noteOwnFocusMove();
        const target = (filterRef.current as {requestTVFocus?: () => void} | null) || (tabRef.current as {requestTVFocus?: () => void} | null);
        target?.requestTVFocus?.();
      },
      [cols],
    ),
  );
  const onCardFocus = useCallback((item: HeroItem, index: number) => {
    warmItem(item);
    inGrid.current = true;
    gridIdx.current = index;
  }, []);
  const open = useCallback((item: HeroItem) => openItem(navigation, item), [navigation]);
  // one claim per tab, NOT per filter (focus.ts useListClaim): a chip pressed keeps the focus, as
  // on the website — keyed on the filter too, the new list took it and it fell to the tabs (Mi TV)
  const claims = useListClaim(`hh-${tab}`, tab === 'forYou' && !!items && items.length > 0);
  const renderCard = useCallback(
    ({item, index}: {item: HeroItem; index: number}) => (
      <Card item={item} index={index} caption onPress={open} onFocus={onCardFocus} edgeLeft={index % cols === 0} hasTVPreferredFocus={claims(index)} />
    ),
    [open, cols, claims, onCardFocus],
  );

  const switchTab = (t: Tab) => {
    if (t === tab) return;
    setTab(t);
    setError('');
  };
  const options = filterOptions(people);
  const list = tab === 'forYou' ? items : sent;
  const count = list ? `${list.length} title${list.length === 1 ? '' : 's'}` : '';

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.page, screenIn]}>
        <View style={styles.head}>
          <Text style={styles.h1}>{WORDS.pageTitle}</Text>
          {count ? <Text style={styles.count}>{count}</Text> : null}
        </View>
        <View style={styles.band}>
          {/* the focus fallback (and UP out of the list) is the tab that is on: opened on You sent
              (Settings → What you sent), focus used to wait on For you — OK there left the page */}
          <Chip uiId="household.tab" ref={tab === 'forYou' ? tabRef : undefined} label={WORDS.tabForYou} on={tab === 'forYou'} edgeLeft onFocusChange={leaveGrid} onPress={() => switchTab('forYou')} />
          <Chip uiId="household.tab" ref={tab === 'sent' ? tabRef : undefined} label={WORDS.tabSent} on={tab === 'sent'} onFocusChange={leaveGrid} onPress={() => switchTab('sent')} />
        </View>
        {tab === 'forYou' && people.length > 0 ? (
          // One line that scrolls with the focus, however many people there are: wrapped, a big
          // household took two or three lines and left the grid one row of room (Mi TV).
          // fadingEdgeLength: Android keeps a focused chip that far from the strip's ends when it
          // scrolls it into view (else it stopped on the panel's edge, its ring cut — Mi TV), and
          // fades the chips out there. Native: a JS scrollTo on every focus swallowed presses.
          <ScrollView horizontal style={styles.strip} contentContainerStyle={styles.stripIn} showsHorizontalScrollIndicator={false} fadingEdgeLength={STRIP_FADE}>
            {options.map((o, i) => (
              // UP out of the grid comes back to the person the page is filtered by
              <Chip uiId="household.filter" key={o.id || 'all'} ref={from === o.id ? filterRef : undefined} label={o.id ? ltr(iso(o.label)) : o.label} on={from === o.id} small edgeLeft={i === 0} onFocusChange={leaveGrid} onPress={() => setFrom(o.id)} />
            ))}
          </ScrollView>
        ) : null}

        {error ? (
          <ErrorState
            message={error}
            onAction={() => {
              setError('');
              setReload(n => n + 1);
            }}
          />
        ) : list === null ? (
          <View style={styles.skelGrid}>
            {Array.from({length: SKELETONS}, (_, i) => (
              <Skeleton key={i} />
            ))}
          </View>
        ) : list.length === 0 ? (
          <Empty glyph="💌" message={tab === 'forYou' ? WORDS.emptyForYou : WORDS.emptySent} actionLabel="Back" onAction={() => navigation.goBack()} />
        ) : tab === 'forYou' ? (
          <FlatList
            data={items || []}
            key={`cols-${cols}`}
            style={styles.listFill}
            // the focused row is kept this far off the panel's foot (Android scrolls a focused cell
            // only just into view: the last row sat on the edge, outside the safe area), and the
            // grid fades out under the filter instead of being cut there
            fadingEdgeLength={GRID_FADE}
            numColumns={cols}
            keyExtractor={it => it.id || it.imdbId || it.title}
            columnWrapperStyle={styles.rowGap}
            contentContainerStyle={[styles.grid, {paddingBottom: CLEARANCE.below + safeBottom}]}
            initialNumToRender={18}
            maxToRenderPerBatch={12}
            windowSize={3}
            removeClippedSubviews
            renderItem={renderCard}
          />
        ) : (
          <FlatList
            data={sent || []}
            style={styles.listFill}
            fadingEdgeLength={GRID_FADE}
            keyExtractor={it => it.hh.key}
            contentContainerStyle={[styles.sentList, {paddingBottom: CLEARANCE.below + safeBottom}]}
            initialNumToRender={8}
            windowSize={5}
            renderItem={({item, index}) => <SentRow item={item} first={index === 0} onOpen={open} />}
          />
        )}
      </Animated.View>
      <NavRail active="home" />
    </View>
  );
}

const frame = {paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX};

const styles = StyleSheet.create({
  root: {flex: 1},
  page: {flex: 1},
  head: {flexDirection: 'row', alignItems: 'baseline', gap: 16, paddingTop: 27, paddingBottom: 4, ...frame},
  h1: {color: colors.text, fontSize: fontSize.title, lineHeight: 39, fontWeight: '900', letterSpacing: -0.52},
  count: {color: colors.textFaint, fontSize: 16, lineHeight: 24, fontWeight: '600'},
  band: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, paddingTop: 2, paddingBottom: 6, ...frame},
  // the filter: one scrolling line; its padding is room for the focused chip's ring and scale
  strip: {flexGrow: 0},
  stripIn: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 4, paddingBottom: 8, ...frame},
  listFill: {flex: 1},
  grid: {paddingTop: CLEARANCE.above, ...frame},
  rowGap: {gap: GRID_GAP, marginBottom: GRID_GAP},
  skelGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP, paddingTop: CLEARANCE.above, ...frame},
  sentList: {paddingTop: spacing.sm, gap: spacing.sm, ...frame},
  sentRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.surface, borderRadius: radius.m, paddingVertical: 8, paddingHorizontal: 10, maxWidth: 1000},
  thumb: {width: THUMB_W, height: THUMB_H, borderRadius: radius.s, backgroundColor: colors.bgRaised, overflow: 'hidden', justifyContent: 'center'},
  thumbImg: {width: '100%', height: '100%'},
  thumbTitle: {color: colors.textDim, fontSize: 10, fontWeight: '700', textAlign: 'center', paddingHorizontal: 3},
  sentText: {flex: 1, minWidth: 0, gap: 5},
  sentTitle: {color: colors.text, fontSize: fontSize.body, fontWeight: '800'},
  sentYear: {color: colors.textFaint, fontWeight: '600'},
  sentNote: {color: colors.textDim, fontSize: fontSize.small, fontStyle: 'italic'},
  sentWho: {flexDirection: 'row', flexWrap: 'wrap', gap: 6},
  // a status: a quiet pill, its dot in the state's colour
  status: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 3, paddingLeft: 8, paddingRight: 10, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)'},
  statusDot: {width: 7, height: 7, borderRadius: 3.5},
  statusText: {color: colors.textDim, fontSize: fontSize.small, fontWeight: '700'},
});
