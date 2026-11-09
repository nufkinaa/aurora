// [franchise] FRANCHISE ORDER — one franchise's titles in order (the website's
// franchise page; the server's GET /api/franchises/:id, routes/franchises.js).
//
//   the heading   the franchise's name, its summary under it ("34 films · 9 on
//                 the server · 12 watched" — none for a kids profile)
//   the order     Release order / Story order, when the franchise has both:
//                 the other one is saved for this person on the server (every
//                 device and the website follow it) and the list comes back in it
//   the list      every entry in order: its number (none for an optional one),
//                 poster, title, year, Optional / Series, Watched / Started —
//                 OK on the row opens the title; the button beside it is the one
//                 thing to do (franchiseRules.ts entryAction): Play, Open,
//                 Save & watch (its title page presses Save & watch once), Choose episode
//
// Focus starts on the first main entry not watched yet. Back returns to the
// title page it was opened from.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Animated, FlatList, Image, StyleSheet, ActivityIndicator} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useIsFocused} from '@react-navigation/native';
import Btn from '../components/Btn';
import Chip from '../components/Chip';
import Focusable from '../components/Focusable';
import NavRail from '../components/NavRail';
import {ErrorState} from '../components/States';
import {api, artSrc, FranchiseEntry, FranchiseOrderId, FranchisePage} from '../api';
import {canNavigate} from '../navLock';
import {noteOwnFocusMove, pressMovedFocus, railOpen, useFocusFallback, useTVKeys} from '../focus';
import {useScreenIn} from '../motion';
import {useApp} from '../AppContext';
import {useRouteShown} from '../useRouteShown';
import {showToast} from '../toast';
import {RootStackParamList} from '../navigation';
import {entryAction, entryArt, entryItem, entryNumber, entryStateWord, entryTags, firstFocusIndex, FR_WORDS, showOrderSwitch} from '../franchiseRules';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, radius, CLEARANCE} = theme;

const THUMB_W = 52;
const THUMB_H = 78;
const ROW_PAD = 8;
const ROW_GAP = 8;
// fixed, so the list can open scrolled to where focus starts (getItemLayout)
const ROW_H = THUMB_H + ROW_PAD * 2 + 4;
const LIST_FADE = 36;

type Nav = NativeStackScreenProps<RootStackParamList, 'Franchise'>['navigation'];

const EntryRow = React.memo(function FranchiseEntryRow({
  e,
  index,
  claim,
  onOpen,
  onAct,
  onFocusRow,
}: {
  e: FranchiseEntry;
  index: number;
  claim: boolean;
  onOpen: (e: FranchiseEntry) => void;
  onAct: (e: FranchiseEntry) => void;
  onFocusRow: (index: number, focused: boolean) => void;
}) {
  const art = artSrc(entryArt(e), THUMB_W).src;
  const num = entryNumber(e);
  const tags = entryTags(e);
  const state = entryStateWord(e);
  const act = entryAction(e);
  return (
    <View style={styles.row}>
      <Focusable
        uiId="franchise.entry"
        scaleTo={1.01}
        edgeLeft
        holdLeft
        hasTVPreferredFocus={claim}
        highlightColor={colors.surfaceHover}
        onFocusChange={f => onFocusRow(index, f)}
        onPress={() => onOpen(e)}
        accessibilityLabel={[num, e.title, e.year, ...tags, state].filter(Boolean).join(', ')}
        style={styles.rowMain}>
        <Text style={[styles.num, !num && styles.numNone]}>{num || '·'}</Text>
        <View style={styles.thumb}>
          {art ? (
            <Image source={art} style={styles.thumbImg} resizeMode="cover" resizeMethod="resize" fadeDuration={0} />
          ) : (
            <Text style={styles.thumbTitle} numberOfLines={3}>
              {e.title}
            </Text>
          )}
        </View>
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {e.title}
            {e.year ? <Text style={styles.year}>{`  ${e.year}`}</Text> : null}
          </Text>
          <View style={styles.tags}>
            {tags.map(t => (
              <View key={t} style={styles.tag}>
                <Text style={styles.tagText}>{t}</Text>
              </View>
            ))}
            {state ? (
              <Text style={[styles.state, e.state === 'watched' ? styles.stateWatched : styles.stateStarted]}>
                {e.state === 'watched' ? `✓ ${state}` : state}
              </Text>
            ) : null}
          </View>
          {e.note ? (
            <Text style={styles.note} numberOfLines={1}>
              {e.note}
            </Text>
          ) : null}
        </View>
      </Focusable>
      <View style={styles.act}>
        <Btn uiId={act.kind === 'play' ? 'franchise.play' : act.kind === 'save' ? 'franchise.save' : 'franchise.entry'} small primary={act.kind === 'play'} label={act.label} onPress={() => onAct(e)} onFocusChange={f => onFocusRow(index, f)} />
      </View>
    </View>
  );
});

export default function Franchise({route, navigation}: NativeStackScreenProps<RootStackParamList, 'Franchise'>) {
  const {id, name} = route.params;
  const {profileId} = useApp();
  const {safeBottom} = useTvMetrics();
  const screenIn = useScreenIn();

  const [page, setPage] = useState<FranchisePage | null>(null);
  const [error, setError] = useState('');
  const [want, setWant] = useState<FranchiseOrderId | null>(null); // null: the person's own
  const [reload, setReload] = useState(0);
  const [switching, setSwitching] = useState(false);
  useRouteShown(page !== null || !!error);

  // Read on arrival and again on every return (a film played from here, or a
  // Save & watch on its title page, changes Watched / Started / On the server
  // — the website reads the page afresh each time it is shown). A failed
  // re-read keeps what is on screen; only a page never read shows the failure.
  const isFocused = useIsFocused();
  const have = useRef(false);
  useEffect(() => {
    if (!isFocused) return;
    let live = true;
    setError('');
    api
      .franchise(id, profileId, want)
      .then(p => {
        if (!live) return;
        have.current = true;
        setPage(p);
        setSwitching(false);
      })
      .catch(() => {
        if (!live) return;
        setSwitching(false);
        if (!have.current) setError(FR_WORDS.loadError);
      });
    return () => {
      live = false;
    };
  }, [id, profileId, want, reload, isFocused]);

  // The order switch: saved for this person, then the list in that order
  // (shown in it even if the save is refused — the page asks with ?order=).
  const pickOrder = useCallback(
    (o: FranchiseOrderId) => {
      if (!page || o === page.order || switching) return;
      setSwitching(true);
      api.franchiseSetOrder(id, profileId, o).catch(() => showToast("Couldn't save that", '⚠'));
      setWant(o);
    },
    [page, switching, id, profileId],
  );

  // Where focus starts: once per page (not again when the order is switched —
  // focus stays on the chip that was pressed, as on the website).
  const claimed = useRef(false);
  const startAt = useMemo(() => (page ? firstFocusIndex(page.entries) : 0), [page]);
  const claimIndex = page && !claimed.current ? startAt : -1;
  useEffect(() => {
    if (page) claimed.current = true;
  }, [page]);
  // the list opens with the row above that one at its top (fixed rows: getItemLayout)
  const initialScroll = useRef<number | null>(null);
  if (page && initialScroll.current == null) initialScroll.current = Math.max(0, startAt - 1);

  const open = useCallback(
    (e: FranchiseEntry) => {
      if (canNavigate(navigation)) navigation.push('Detail', {item: entryItem(e)});
    },
    [navigation],
  );
  const act = useCallback(
    (e: FranchiseEntry) => {
      if (!canNavigate(navigation)) return;
      const a = entryAction(e);
      if (a.kind === 'play' && e.onServer) navigation.push('Player', {id: e.onServer.id, title: e.title});
      else if (a.kind === 'save') navigation.push('Detail', {item: entryItem(e), save: true});
      else navigation.push('Detail', {item: entryItem(e)});
    },
    [navigation],
  );

  // UP out of the list's first row, to the order chips (Android's focus search
  // often finds nothing above a list's top row — Household's escape)
  const inList = useRef(-1);
  const onFocusRow = useCallback((index: number, f: boolean) => {
    if (f) inList.current = index;
  }, []);
  const leaveList = useCallback((f: boolean) => {
    if (f) inList.current = -1;
  }, []);
  const chipRef = useRef(null);
  const retryRef = useRef(null);
  useFocusFallback(chipRef);
  useTVKeys(
    useCallback((evt: {eventType: string}) => {
      if (evt.eventType !== 'up' || railOpen() || pressMovedFocus()) return;
      if (inList.current !== 0) return;
      const target = chipRef.current as {requestTVFocus?: () => void} | null;
      if (!target?.requestTVFocus) return;
      noteOwnFocusMove();
      target.requestTVFocus();
    }, []),
  );

  const renderRow = useCallback(
    ({item, index}: {item: FranchiseEntry; index: number}) => (
      <EntryRow e={item} index={index} claim={index === claimIndex} onOpen={open} onAct={act} onFocusRow={onFocusRow} />
    ),
    [claimIndex, open, act, onFocusRow],
  );
  const layout = useCallback((_: unknown, index: number) => ({length: ROW_H + ROW_GAP, offset: (ROW_H + ROW_GAP) * index, index}), []);

  const title = page?.name || name || '';
  const orders = page?.orders || [];
  return (
    <View style={styles.root}>
      <Animated.View style={[styles.page, screenIn]}>
        <View style={styles.head}>
          <Text style={styles.h1} numberOfLines={1}>
            {title}
          </Text>
          {page?.summary ? (
            <Text style={styles.summary} numberOfLines={1}>
              {page.summary}
            </Text>
          ) : null}
        </View>
        {page && showOrderSwitch(orders) ? (
          <View style={styles.band}>
            {orders.map((o, i) => (
              <Chip
                key={o.id}
                uiId="franchise.order"
                ref={o.id === page.order ? chipRef : undefined}
                label={o.label}
                on={o.id === page.order}
                edgeLeft={i === 0}
                onFocusChange={leaveList}
                onPress={() => pickOrder(o.id)}
              />
            ))}
            {switching ? <ActivityIndicator color={colors.textDim} size="small" /> : null}
          </View>
        ) : null}

        {error && !page ? (
          <ErrorState message={error} onAction={() => setReload(n => n + 1)} />
        ) : !page ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.text} />
          </View>
        ) : (
          <FlatList
            data={page.entries}
            // a new order is a new list: it opens at its top
            key={`order-${page.order}`}
            style={styles.listFill}
            fadingEdgeLength={LIST_FADE}
            keyExtractor={(e, i) => `${e.imdbId}-${i}`}
            contentContainerStyle={[styles.list, {paddingBottom: CLEARANCE.below + safeBottom}]}
            getItemLayout={layout}
            initialScrollIndex={claimIndex >= 0 ? initialScroll.current || 0 : 0}
            initialNumToRender={8}
            maxToRenderPerBatch={8}
            windowSize={5}
            ItemSeparatorComponent={Gap}
            renderItem={renderRow}
          />
        )}
        {error && page ? (
          // a reload that failed with the list still up (the order switch): the list stays
          <View style={styles.inlineError}>
            <Text style={styles.inlineErrorText}>{error}</Text>
            <Btn uiId="state.action" ref={retryRef} small label="Retry" onPress={() => setReload(n => n + 1)} />
          </View>
        ) : null}
      </Animated.View>
      <NavRail active="home" />
    </View>
  );
}

const Gap = () => <View style={{height: ROW_GAP}} />;

const frame = {paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX};

const styles = StyleSheet.create({
  root: {flex: 1},
  page: {flex: 1},
  head: {paddingTop: 27, paddingBottom: 4, ...frame},
  h1: {color: colors.text, fontSize: fontSize.title, lineHeight: 39, fontWeight: '900', letterSpacing: -0.52},
  summary: {color: colors.textDim, fontSize: 15, lineHeight: 22, fontWeight: '600'},
  band: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 6, paddingBottom: 6, ...frame},
  loading: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  listFill: {flex: 1},
  list: {paddingTop: spacing.sm, ...frame},
  row: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, height: ROW_H, maxWidth: 1000},
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    height: ROW_H,
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    paddingVertical: ROW_PAD,
    paddingHorizontal: 10,
  },
  num: {width: 34, textAlign: 'center', color: colors.text, fontSize: fontSize.row, fontWeight: '900'},
  numNone: {color: colors.textFaint},
  thumb: {width: THUMB_W, height: THUMB_H, borderRadius: radius.s, backgroundColor: colors.bgRaised, overflow: 'hidden', justifyContent: 'center'},
  thumbImg: {width: '100%', height: '100%'},
  thumbTitle: {color: colors.textDim, fontSize: 10, fontWeight: '700', textAlign: 'center', paddingHorizontal: 3},
  text: {flex: 1, minWidth: 0, gap: 5},
  title: {color: colors.text, fontSize: fontSize.body + 1, fontWeight: '800'},
  year: {color: colors.textFaint, fontWeight: '600'},
  tags: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6},
  tag: {paddingVertical: 2, paddingHorizontal: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)'},
  tagText: {color: colors.textDim, fontSize: 12, fontWeight: '700'},
  state: {fontSize: fontSize.small, fontWeight: '800'},
  stateWatched: {color: '#8cffbe'},
  stateStarted: {color: colors.accent},
  note: {color: colors.textFaint, fontSize: 12, fontWeight: '600'},
  act: {minWidth: 150, alignItems: 'flex-start'},
  inlineError: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, ...frame},
  inlineErrorText: {color: '#ff7a7a', fontSize: 15, fontWeight: '700'},
});
