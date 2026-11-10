// The Calendar — what is coming up, and what just came out, for everything in
// this person's My List, the shows they follow and the shows they watch (the
// website's #/calendar: public/js/screens/calendar.js; the phone's
// phone/screens/Calendar.tsx). The server makes the calendar and every word on
// it (src/media/calendar.js); calendar.ts asks for it and says the screen's own
// few words; this screen lays it out for the remote.
//
// TWO VIEWS, the Month / List chips at the top right (the choice stays on this
// TV, calendar.ts loadCalendarView): Month is a real month, the picked day's
// releases beside it (screens/CalendarMonth.tsx); List is the agenda below.
// A server without the month grid in its answer gets the List only.
//
//   the tabs     "Coming up · 12" / "Recently out · 3" (opens on firstTab)
//   a quiet line while some titles' dates are still being looked up
//   the days     a heading ("Today · 9 Nov") and its entries: poster, title,
//                what ("Season 2 premiere" lit), detail, why, the badge
//                ("On the server"), Play when the server has it, Save & watch
//                when it can ask for it. OK on the row opens the title.
//
// D-pad: the tabs on top; DOWN into the list; RIGHT from a row reaches its
// buttons; UP from the first row comes back to the tab that is on (Android's
// focus search often finds nothing above a list's first cell — MyList's
// escape); LEFT at a row opens the rail; BACK leaves (the stack's own).
//
// Nothing starts without a press: Save & watch is the title page's own pick
// and request (POST …/calendar/save), asked only when its button is pressed.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Animated, FlatList, Image, StyleSheet} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useIsFocused} from '@react-navigation/native';
import Btn from '../components/Btn';
import Chip from '../components/Chip';
import Focusable from '../components/Focusable';
import NavRail from '../components/NavRail';
import Skeleton from '../components/Skeleton';
import {Empty} from '../components/States';
import {artSrc} from '../api';
import CalendarMonth from './CalendarMonth';
import {
  afterSave,
  CAL_WORDS,
  CALENDAR_TABS,
  CALENDAR_TITLE,
  canPlay,
  dayHeading,
  emptyLine,
  entryLabel,
  FAILED_LINE,
  firstTab,
  hasGrid,
  loadCalendar,
  loadCalendarView,
  PLAY_WORD,
  RETRY_WORD,
  SAVE_FAILED,
  SAVE_WORD,
  saveCalendarView,
  saveFromCalendar,
  SAVING_WORD,
  tabLabel,
  withEntry,
} from '../calendar';
import type {Calendar as CalendarData, CalendarEntry, CalendarTab, CalendarView} from '../calendar';
import {openItem} from '../openItem';
import {warmItem} from '../prefetch';
import {goSection} from '../navSection';
import {canNavigate} from '../navLock';
import {noteOwnFocusMove, pressMovedFocus, railOpen, useFocusFallback, useListClaim, useTVKeys} from '../focus';
import {useScreenIn} from '../motion';
import {useApp} from '../AppContext';
import {useRouteShown} from '../useRouteShown';
import {showToast} from '../toast';
import {track} from '../usage';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, radius, CLEARANCE} = theme;


const POSTER_W = 54;
const POSTER_H = 81; // 2:3
const LIST_FADE = 36;
const SKELETONS = 4;
const ROW_MAX = 1000;
// the "on the server" mint the title page gives a downloaded episode (Detail.tsx)
const ON_SERVER = '#8cffbe';
const BADGE_TONE: Record<string, string> = {
  have: ON_SERVER,
  partial: ON_SERVER,
  saving: colors.accent,
  waiting: colors.star,
};

type NodeRef = {requestTVFocus?: () => void} | null;
type Row =
  | {t: 'day'; key: string; text: string; today: boolean; first: boolean}
  | {t: 'entry'; key: string; e: CalendarEntry; n: number};

const EntryRow = React.memo(function CalendarEntryRow({
  e,
  n,
  claim,
  saving,
  onOpen,
  onPlay,
  onSave,
  onTop,
}: {
  e: CalendarEntry;
  n: number;
  claim: boolean;
  saving: boolean;
  onOpen: (e: CalendarEntry) => void;
  onPlay: (e: CalendarEntry) => void;
  onSave: (e: CalendarEntry) => void;
  onTop: (top: boolean, e: CalendarEntry | null) => void;
}) {
  const rowRef = useRef<NodeRef>(null);
  // The Save button goes once its answer is in: focus on it would be lost with
  // it, so it lands on the row instead.
  const saveFocused = useRef(false);
  useEffect(() => {
    if (!e.canSave && saveFocused.current) {
      saveFocused.current = false;
      rowRef.current?.requestTVFocus?.();
    }
  }, [e.canSave]);
  const top = n === 0;
  const art = artSrc(e.poster || e.item?.cover || null, POSTER_W).src;
  const play = canPlay(e);
  return (
    <View style={styles.entry}>
      <Focusable
        uiId="calendar.open"
        ref={rowRef as never}
        scaleTo={1.01}
        edgeLeft
        hasTVPreferredFocus={claim}
        highlightColor={colors.surfaceHover}
        accessibilityLabel={entryLabel(e)}
        onFocusChange={f => f && onTop(top, e)}
        onPress={() => onOpen(e)}
        style={styles.open}>
        <View style={styles.poster}>
          {art ? (
            <Image source={art} style={styles.posterImg} resizeMode="cover" fadeDuration={0} />
          ) : (
            <Text style={styles.posterTitle} numberOfLines={3}>
              {e.title}
            </Text>
          )}
        </View>
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {e.title}
          </Text>
          <Text style={[styles.what, e.kind === 'premiere' && styles.whatPremiere]} numberOfLines={1}>
            {e.what}
          </Text>
          {e.detail ? (
            <Text style={styles.detail} numberOfLines={1}>
              {e.detail}
            </Text>
          ) : null}
          <View style={styles.meta}>
            {e.badge ? (
              <View style={[styles.badge, {borderColor: BADGE_TONE[e.state] || colors.line}]}>
                <View style={[styles.badgeDot, {backgroundColor: BADGE_TONE[e.state] || colors.textDim}]} />
                <Text style={[styles.badgeText, {color: BADGE_TONE[e.state] || colors.textDim}]} numberOfLines={1}>
                  {e.badge}
                </Text>
              </View>
            ) : null}
            {e.why ? (
              <Text style={styles.why} numberOfLines={1}>
                {e.why}
              </Text>
            ) : null}
          </View>
        </View>
      </Focusable>
      {play || e.canSave ? (
        <View style={styles.actions}>
          {play ? <Btn uiId="calendar.play" primary small label={PLAY_WORD} onFocusChange={f => f && onTop(top, null)} onPress={() => onPlay(e)} /> : null}
          {e.canSave ? (
            <Btn
              uiId="calendar.save"
              small
              dim={saving}
              label={saving ? SAVING_WORD : SAVE_WORD}
              onFocusChange={f => {
                saveFocused.current = f;
                if (f) onTop(top, null);
              }}
              // disabled while asking: a second press does nothing
              onPress={() => !saving && onSave(e)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

function Failed({onRetry}: {onRetry: () => void}) {
  const retry = useRef(null);
  useFocusFallback(retry);
  return (
    <View style={styles.state}>
      <Text style={styles.stateGlyph}>📡</Text>
      <Text style={styles.stateLine}>{FAILED_LINE}</Text>
      <Btn uiId="calendar.retry" ref={retry} small label={RETRY_WORD} hasTVPreferredFocus edgeLeft onPress={onRetry} />
    </View>
  );
}

export default function Calendar({navigation}: NativeStackScreenProps<RootStackParamList, 'Calendar'>) {
  const {profileId} = useApp();
  const {safeBottom} = useTvMetrics();
  const isFocused = useIsFocused();
  const screenIn = useScreenIn();

  const [cal, setCal] = useState<CalendarData | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<CalendarTab | null>(null);
  const [saving, setSaving] = useState<Record<string, true>>({});
  const [reload, setReload] = useState(0);
  // Month or List (null until this TV's choice is read)
  const [view, setView] = useState<CalendarView | null>(null);
  useEffect(() => {
    let on = true;
    loadCalendarView().then(v => on && setView(v));
    return () => {
      on = false;
    };
  }, []);
  // usage stats: the first answer is on (routeTiming.ts → `tv:calendar`)
  useRouteShown((cal !== null && view !== null) || failed);

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    track('feat', {f: 'calendar'});
    return () => {
      live.current = false;
    };
  }, []);

  // Read on arrival and again on every return (a title page's Save & watch, or
  // its My List button, changes what the calendar says). A failed re-read
  // keeps what is on screen; only a calendar never read shows the failure.
  const have = useRef(false);
  useEffect(() => {
    if (!isFocused) return;
    let on = true;
    loadCalendar(profileId)
      .then(c => {
        if (!on || !c) return;
        have.current = true;
        setCal(c);
        setFailed(false);
        setTab(t => t || firstTab(c));
      })
      .catch(() => {
        if (on && !have.current) setFailed(true);
      });
    return () => {
      on = false;
    };
  }, [profileId, isFocused, reload]);

  const shownTab: CalendarTab = tab || 'upcoming';
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let n = 0;
    for (const d of (cal && cal[shownTab]) || []) {
      out.push({t: 'day', key: `d:${d.day}`, text: dayHeading(d), today: d.label === 'Today', first: out.length === 0});
      for (const e of d.items) out.push({t: 'entry', key: e.key, e, n: n++});
    }
    return out;
  }, [cal, shownTab]);

  // UP out of the list's first row (or its buttons) to the tab that is on.
  const atTop = useRef(false);
  const tabRef = useRef(null);
  const viewRef = useRef(null);
  useFocusFallback(tabRef);
  useFocusFallback(viewRef);
  useTVKeys(
    useCallback((evt: {eventType: string}) => {
      if (evt.eventType !== 'up' || railOpen() || pressMovedFocus()) return;
      if (!atTop.current) return;
      noteOwnFocusMove();
      (tabRef.current as NodeRef)?.requestTVFocus?.();
    }, []),
  );
  const onTop = useCallback((top: boolean, e: CalendarEntry | null) => {
    atTop.current = top;
    if (e) warmItem(e.item);
  }, []);
  const leaveList = useCallback((f: boolean) => {
    if (f) atTop.current = false;
  }, []);

  const open = useCallback((e: CalendarEntry) => openItem(navigation, e.item), [navigation]);
  const play = useCallback(
    (e: CalendarEntry) => {
      if (!e.play || !canNavigate(navigation)) return;
      const p = e.play;
      // an episode as the title page plays one ("Show · S2 E5"); a film by its name
      const title = e.type === 'show' && p.season != null && p.episode != null ? `${e.title} · S${p.season} E${p.episode}` : e.title;
      navigation.push('Player', {id: p.id, title});
    },
    [navigation],
  );
  const busy = useRef(new Set<string>());
  const save = useCallback(
    async (e: CalendarEntry) => {
      if (!e.canSave || !e.save || busy.current.has(e.key)) return;
      busy.current.add(e.key);
      setSaving(s => ({...s, [e.key]: true}));
      try {
        const r = await saveFromCalendar(profileId, e);
        if (r && r.line) showToast(r.line, r.ok ? '⬇️' : '🔍');
        if (r && r.ok && live.current) setCal(c => (c ? withEntry(c, e.key, x => afterSave(x, r)) : c));
      } catch (err) {
        showToast((err instanceof Error && err.message) || SAVE_FAILED, '⚠️');
      } finally {
        busy.current.delete(e.key);
        if (live.current)
          setSaving(s => {
            const next = {...s};
            delete next[e.key];
            return next;
          });
      }
    },
    [profileId],
  );

  // the first row takes focus once, on the first answer (focus.ts useListClaim):
  // never again on a re-read or a tab switch — focus stays where you put it
  // (nor after a tab press: an empty Coming up, then Recently out pressed, keeps the tab)
  const tabbed = useRef(false);
  const claims = useListClaim('calendar', rows.length > 0 && !tabbed.current);
  const renderRow = useCallback(
    ({item}: {item: Row}) =>
      item.t === 'day' ? (
        <Text style={[styles.day, item.first && styles.dayFirst, item.today && styles.dayToday]} numberOfLines={1}>
          {item.text}
        </Text>
      ) : (
        <EntryRow e={item.e} n={item.n} claim={claims(item.n)} saving={!!saving[item.key]} onOpen={open} onPlay={play} onSave={save} onTop={onTop} />
      ),
    [claims, saving, open, play, save, onTop],
  );

  const switchTab = (t: CalendarTab) => {
    tabbed.current = true;
    if (t !== shownTab) setTab(t);
  };
  const switchView = (v: CalendarView) => {
    tabbed.current = true;
    if (v === view) return;
    setView(v);
    saveCalendarView(v);
  };
  const month = view === 'month' && hasGrid(cal);
  const retry = () => {
    setFailed(false);
    setReload(n => n + 1);
  };

  const pending = cal?.empty.pending || null;
  const empty = emptyLine(cal, shownTab);
  const other: CalendarTab = shownTab === 'upcoming' ? 'recent' : 'upcoming';

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.page, screenIn]}>
        <View style={styles.head}>
          <Text style={styles.h1}>{CALENDAR_TITLE}</Text>
          {hasGrid(cal) && view ? (
            <View style={styles.views}>
              {(['month', 'list'] as const).map(v => (
                <Chip
                  uiId="calendar.view"
                  key={v}
                  small
                  ref={v === view ? viewRef : undefined}
                  label={CAL_WORDS[v]}
                  on={v === view}
                  onFocusChange={leaveList}
                  onPress={() => switchView(v)}
                />
              ))}
            </View>
          ) : null}
        </View>
        {month ? null : (
        <View style={styles.band}>
          {CALENDAR_TABS.map((t, i) => (
            <Chip
              uiId="calendar.tab"
              key={t.key}
              ref={t.key === shownTab ? tabRef : undefined}
              label={tabLabel(cal, t.key)}
              on={t.key === shownTab}
              edgeLeft={i === 0}
              // while it loads the tab that is on holds the focus; the first row takes it on arrival
              hasTVPreferredFocus={t.key === shownTab && !cal && !failed}
              onFocusChange={leaveList}
              onPress={() => switchTab(t.key)}
            />
          ))}
        </View>
        )}
        {pending && !failed ? <Text style={styles.pending}>{pending}</Text> : null}

        {failed ? (
          <Failed onRetry={retry} />
        ) : !cal || !view ? (
          <View style={styles.skel}>
            {Array.from({length: SKELETONS}, (_, i) => (
              <Skeleton key={i} width={ROW_MAX - 240} height={POSTER_H + 16} />
            ))}
          </View>
        ) : month ? (
          <View style={[styles.monthBody, {paddingBottom: 18 + safeBottom}]}>
            <CalendarMonth cal={cal} saving={saving} claimFocus={!tabbed.current} onOpen={open} onPlay={play} onSave={save} />
          </View>
        ) : empty ? (
          cal.counts.titles && cal[other].length ? (
            <Empty glyph="🗓️" message={empty} actionLabel={tabLabel(cal, other)} claimFocus={!tabbed.current} onAction={() => switchTab(other)} />
          ) : cal.counts.titles ? (
            <Empty glyph="🗓️" message={empty} actionLabel="Back" claimFocus={!tabbed.current} onAction={() => navigation.goBack()} />
          ) : (
            <Empty glyph="🗓️" message={empty} actionLabel="Browse Movies" claimFocus={!tabbed.current} onAction={() => goSection(navigation, 'calendar', 'movies')} />
          )
        ) : (
          <FlatList
            data={rows}
            key={shownTab}
            style={styles.listFill}
            fadingEdgeLength={LIST_FADE}
            keyExtractor={r => r.key}
            contentContainerStyle={[styles.list, {paddingBottom: CLEARANCE.below + safeBottom}]}
            initialNumToRender={8}
            maxToRenderPerBatch={6}
            windowSize={5}
            renderItem={renderRow}
          />
        )}
      </Animated.View>
      <NavRail active="calendar" />
    </View>
  );
}

const frame = {paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX};

const styles = StyleSheet.create({
  root: {flex: 1},
  page: {flex: 1},
  head: {flexDirection: 'row', alignItems: 'center', gap: 16, paddingTop: 27, paddingBottom: 4, ...frame},
  views: {flexDirection: 'row', gap: 6, marginLeft: 'auto'},
  monthBody: {flex: 1, paddingTop: 4, ...frame},
  h1: {color: colors.text, fontSize: fontSize.title, lineHeight: 39, fontWeight: '900', letterSpacing: -0.52},
  band: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 2, paddingBottom: 6, ...frame},
  pending: {color: colors.textDim, fontSize: fontSize.small, paddingBottom: 4, ...frame},
  listFill: {flex: 1},
  list: {paddingTop: spacing.sm, ...frame},
  skel: {gap: spacing.sm, paddingTop: spacing.sm, ...frame},
  // a day's heading: quiet, Today lit
  day: {color: colors.textDim, fontSize: fontSize.body, fontWeight: '800', paddingTop: spacing.lg, paddingBottom: spacing.sm},
  dayFirst: {paddingTop: spacing.xs},
  dayToday: {color: colors.text}, // (the website's .cal-day-head.today)
  entry: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, maxWidth: ROW_MAX, marginBottom: spacing.sm},
  open: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.surface, borderRadius: radius.m, paddingVertical: 8, paddingHorizontal: 10},
  poster: {width: POSTER_W, height: POSTER_H, borderRadius: radius.s, backgroundColor: colors.bgRaised, overflow: 'hidden', justifyContent: 'center'},
  posterImg: {width: '100%', height: '100%'},
  posterTitle: {color: colors.textDim, fontSize: 10, fontWeight: '700', textAlign: 'center', paddingHorizontal: 3},
  text: {flex: 1, minWidth: 0, gap: 3},
  title: {color: colors.text, fontSize: fontSize.body, fontWeight: '800'},
  // the website's .cal-what: the accent; a premiere in gold
  what: {color: colors.accent, fontSize: fontSize.small, fontWeight: '700'},
  whatPremiere: {color: '#ffd479'},
  detail: {color: colors.text, opacity: 0.88, fontSize: fontSize.small},
  meta: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2},
  why: {flexShrink: 1, color: colors.textFaint, fontSize: fontSize.small, fontWeight: '600'},
  // the badge: a quiet pill, its dot and word in the state's colour
  badge: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2, paddingLeft: 8, paddingRight: 10, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1},
  badgeDot: {width: 7, height: 7, borderRadius: 3.5},
  badgeText: {fontSize: fontSize.small, fontWeight: '700'},
  actions: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  state: {alignItems: 'center', justifyContent: 'center', paddingVertical: 45, paddingHorizontal: spacing.pageX, gap: 14},
  stateGlyph: {fontSize: 35, marginBottom: -2},
  stateLine: {color: colors.textDim, fontSize: 16, textAlign: 'center'},
});
