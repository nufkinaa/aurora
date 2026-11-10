// The Calendar on the phone — the website's #/calendar and the TV's
// screens/Calendar.tsx, same layout and words (the shared half and the words
// are calendar.ts; the server makes the calendar, src/media/calendar.js).
//
// TWO VIEWS, a Month / List switch under the head (kept on this phone):
//   Month   the month grid (phone/ui/CalendarGrid.tsx) and, under it, the
//           picked day's releases as the rows below — the website's phone layout
//   List    the agenda:
//
//   Calendar                        the page head, Back on the left
//   [Coming up · 12] [Recently out · 3]
//   (Still looking up the dates of 2 titles — …)
//   TODAY · 9 NOV
//   ┌ poster │ Title / what (a premiere in the accent) / detail / why ┐
//   │        │ [On the server]                                         │
//   │ [Play] [Save & watch]                                            ┘
//
// A row opens the title (openItem, as every card does); Play starts the copy
// the server has; Save & watch asks the server for it — only ever on a tap:
// the calendar itself never starts anything.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Image, RefreshControl, ScrollView, SectionList, StyleSheet, Text, View} from 'react-native';
import {useIsFocused} from '@react-navigation/native';
import {useApp} from '../../AppContext';
import {
  afterSave,
  CAL_WORDS,
  CALENDAR_TABS,
  CALENDAR_TITLE,
  canPlay,
  dayEmptyLine,
  dayHeading,
  emptyLine,
  entryLabel,
  FAILED_LINE,
  firstPick,
  firstTab,
  gridDayHeading,
  hasGrid,
  loadCalendar,
  loadCalendarView,
  monthKeys,
  monthOf,
  monthPick,
  PLAY_WORD,
  RETRY_WORD,
  SAVE_FAILED,
  SAVE_WORD,
  saveCalendarView,
  saveFromCalendar,
  SAVING_WORD,
  tabLabel,
  withEntry,
} from '../../calendar';
import type {Calendar as Cal, CalendarDay, CalendarEntry, CalendarTab, CalendarView} from '../../calendar';
import {canNavigate} from '../../navLock';
import {openItem} from '../../openItem';
import {registerProfileCache} from '../../profileScope';
import {showToast} from '../../toast';
import {useRouteShown} from '../../useRouteShown';
import {usePNav} from '../nav';
import {ChipButton, GlassButton} from '../ui/Buttons';
import {artSrc} from '../ui/Cards';
import CalendarGrid from '../ui/CalendarGrid';
import Icon from '../ui/Icon';
import PageHead, {BackBar, useColumn, useSolidBar} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import Tap from '../ui/Tap';
import {colors, GUTTER, radius} from '../theme';

const PIC_W = 52;
// the site's .cal-badge.have / .partial / .saving / .waiting
const BADGE: Partial<Record<CalendarEntry['state'], {pill: object; text: object}>> = {
  have: {pill: {backgroundColor: 'rgba(70,200,120,0.22)'}, text: {color: '#9df0bd'}},
  partial: {pill: {backgroundColor: 'rgba(70,200,120,0.14)'}, text: {color: '#b9f2cf'}},
  saving: {pill: {backgroundColor: 'rgba(127,209,232,0.18)'}, text: {color: '#bfe9f5'}},
  waiting: {pill: {backgroundColor: 'rgba(127,209,232,0.18)'}, text: {color: '#bfe9f5'}},
};

type Section = {key: string; title: string; today: boolean; data: CalendarEntry[]};

// kept while this profile is here: Back from a title lands on the same day of
// the month view. The next profile starts on its own next release
// (profileScope.ts).
let lastPick: string | null = null;
registerProfileCache('phone/screens/Calendar', () => {
  lastPick = null;
});

function Entry({e, saving, onOpen, onPlay, onSave}: {e: CalendarEntry; saving: boolean; onOpen: (e: CalendarEntry) => void; onPlay: (e: CalendarEntry) => void; onSave: (e: CalendarEntry) => void}) {
  const src = e.poster ? artSrc(e.poster, PIC_W).src : null;
  const play = canPlay(e);
  const save = e.canSave || saving;
  return (
    <Tap uiId="calendar.open" flat onPress={() => onOpen(e)} style={s.row} accessibilityRole="button" accessibilityLabel={entryLabel(e)}>
      <View style={s.top}>
        <View style={s.pic}>{src ? <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <Icon name={e.type === 'show' ? 'series' : 'film'} size={22} color={colors.textFaint} />}</View>
        <View style={s.words}>
          <Text style={s.title}>{e.title}</Text>
          <Text style={[s.what, e.kind === 'premiere' && s.premiere]}>{e.what}</Text>
          {e.detail ? <Text style={s.detail}>{e.detail}</Text> : null}
          {e.why || e.badge ? (
            <View style={s.meta}>
              {e.why ? <Text style={s.why}>{e.why}</Text> : null}
              {e.badge ? (
                <View style={[s.badge, BADGE[e.state]?.pill]}>
                  <Text style={[s.badgeText, BADGE[e.state]?.text]}>{e.badge}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
      {play || save ? (
        // the site's phone layout: under the words, the row's whole width; a second line when the words are big
        <View style={s.actions}>
          {play ? <GlassButton uiId="calendar.play" small label={PLAY_WORD} icon="play" onPress={() => onPlay(e)} style={s.act} /> : null}
          {save ? <GlassButton uiId="calendar.save" small label={saving ? SAVING_WORD : SAVE_WORD} disabled={saving} onPress={() => onSave(e)} style={s.act} /> : null}
        </View>
      ) : null}
    </Tap>
  );
}

export default function CalendarScreen() {
  const bar = useSolidBar();
  const column = useColumn();
  const navigation = usePNav();
  const focused = useIsFocused();
  const {profileId} = useApp();
  const bottom = useTabBarSpace();
  const [cal, setCal] = useState<Cal | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<CalendarTab | null>(null);
  const [saving, setSaving] = useState<Record<string, true>>({});
  const [refreshing, setRefreshing] = useState(false);
  // Month or List (null until this phone's choice is read)
  const [view, setView] = useState<CalendarView | null>(null);
  const [pick, setPickState] = useState<string | null>(lastPick);
  const setPick = useCallback((d: string) => {
    lastPick = d;
    setPickState(d);
  }, []);
  useEffect(() => {
    let on = true;
    loadCalendarView().then(v => on && setView(v));
    return () => {
      on = false;
    };
  }, []);
  const calRef = useRef<Cal | null>(null);
  calRef.current = cal;
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const load = useCallback(
    () =>
      loadCalendar(profileId)
        .then(c => {
          if (!live.current) return;
          setCal(c);
          setFailed(false);
        })
        .catch(() => {
          if (!live.current) return;
          // a calendar already on screen stays; the first load failing says so
          if (calRef.current) showToast(FAILED_LINE, '⚠️');
          else setFailed(true);
        }),
    [profileId],
  );
  useEffect(() => {
    if (focused) load();
  }, [focused, load]);
  useRouteShown((cal !== null && view !== null) || failed);

  const shownTab: CalendarTab = tab || firstTab(cal);
  const month = view === 'month' && hasGrid(cal);
  // the picked day: the one kept, if this answer can show it; else today or the next day with something
  const months = hasGrid(cal) ? monthKeys(cal.grid) : [];
  const picked = cal && hasGrid(cal) ? (pick && cal.grid.byDay[pick] && months.includes(monthOf(pick)) ? pick : firstPick(cal) || cal.today) : null;
  const onMonth = useCallback(
    (dir: -1 | 1) => {
      const c = calRef.current;
      if (!c || !hasGrid(c) || !picked) return;
      const ms = monthKeys(c.grid);
      const j = ms.indexOf(monthOf(picked)) + dir;
      if (j >= 0 && j < ms.length) setPick(monthPick(c.grid, picked, ms[j], c.today));
    },
    [picked, setPick],
  );
  const onPick = useCallback(
    (d: string) => {
      const c = calRef.current;
      if (c && hasGrid(c) && monthKeys(c.grid).includes(monthOf(d))) setPick(d);
    },
    [setPick],
  );
  const switchView = (v: CalendarView) => {
    if (v === view) return;
    setView(v);
    saveCalendarView(v);
  };
  const sections = useMemo<Section[]>(() => {
    if (!cal) return [];
    if (month && picked) {
      const d = cal.grid!.byDay[picked];
      return d && d.items.length ? [{key: picked, title: gridDayHeading(cal, picked), today: picked === cal.today, data: d.items}] : [];
    }
    return (cal[shownTab] || []).map((d: CalendarDay) => ({key: d.day, title: dayHeading(d), today: d.day === cal.today, data: d.items}));
  }, [cal, shownTab, month, picked]);

  const open = useCallback((e: CalendarEntry) => openItem(navigation, e.item), [navigation]);
  const play = useCallback(
    (e: CalendarEntry) => {
      const p = e.play;
      if (!p || !canNavigate(navigation as never)) return;
      // an episode as the title page plays one (Show · S2 E5), a film by its name
      const title = p.season != null && p.episode != null ? `${e.title} · S${p.season} E${p.episode}` : e.title;
      navigation.push('Player', {id: p.id, title});
    },
    [navigation],
  );
  const save = useCallback(
    async (e: CalendarEntry) => {
      if (saving[e.key] || !e.canSave) return;
      setSaving(m => ({...m, [e.key]: true}));
      try {
        const r = await saveFromCalendar(profileId, e);
        if (!live.current) return;
        if (r?.line) showToast(r.line, r.ok ? '⬇' : '⚠️');
        if (r?.ok) setCal(c => (c ? withEntry(c, e.key, x => afterSave(x, r)) : c));
      } catch (err) {
        if (live.current) showToast((err as Error)?.message || SAVE_FAILED, '⚠️');
      } finally {
        if (live.current)
          setSaving(m => {
            const n = {...m};
            delete n[e.key];
            return n;
          });
      }
    },
    [profileId, saving],
  );
  const retry = () => {
    setFailed(false);
    load();
  };

  const empty = month ? null : emptyLine(cal, shownTab);
  const header = (
    <View>
      <PageHead title={CALENDAR_TITLE} />
      {cal && view && hasGrid(cal) ? (
        <View style={s.chips}>
          {(['month', 'list'] as const).map(v => (
            <ChipButton uiId="calendar.view" key={v} label={CAL_WORDS[v]} active={view === v} onPress={() => switchView(v)} />
          ))}
        </View>
      ) : null}
      {cal && view && !month ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
          {CALENDAR_TABS.map(t => (
            <ChipButton uiId="calendar.tab" key={t.key} label={tabLabel(cal, t.key)} active={shownTab === t.key} onPress={() => setTab(t.key)} />
          ))}
        </ScrollView>
      ) : null}
      {cal?.empty?.pending ? <Text style={s.pending}>{cal.empty.pending}</Text> : null}
      {month && cal && picked ? (
        <View style={s.month}>
          <CalendarGrid cal={cal as Cal & {grid: NonNullable<Cal['grid']>}} pick={picked} onPick={onPick} onMonth={onMonth} />
        </View>
      ) : null}
    </View>
  );
  const body = failed ? (
    <View style={s.empty}>
      <Icon name="calendar" size={40} color={colors.textFaint} />
      <Text style={s.emptyText}>{FAILED_LINE}</Text>
      <GlassButton uiId="calendar.retry" label={RETRY_WORD} icon="refresh" onPress={retry} />
    </View>
  ) : !cal || !view ? (
    <ActivityIndicator color={colors.text} style={{marginTop: 30}} />
  ) : month && picked ? (
    // the picked day has nothing: its heading and the server's words
    <View>
      <Text style={[s.day, picked === cal.today && s.today]} accessibilityRole="header">
        {gridDayHeading(cal, picked)}
      </Text>
      <Text style={s.dayEmpty}>{dayEmptyLine(cal)}</Text>
    </View>
  ) : empty ? (
    <View style={s.empty}>
      <Icon name="calendar" size={40} color={colors.textFaint} />
      <Text style={s.emptyText}>{empty}</Text>
    </View>
  ) : null;

  return (
    <View style={s.root}>
      <SectionList
        sections={sections}
        keyExtractor={(e: CalendarEntry) => e.key}
        onScroll={bar.onScroll}
        scrollEventThrottle={32}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={header}
        ListEmptyComponent={body}
        contentContainerStyle={[{paddingBottom: bottom + 16}, column]}
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
        renderSectionHeader={({section}: {section: Section}) => (
          <Text style={[s.day, section.today && s.today]} accessibilityRole="header">
            {section.title}
          </Text>
        )}
        renderItem={({item}: {item: CalendarEntry}) => <Entry e={item} saving={!!saving[item.key]} onOpen={open} onPlay={play} onSave={save} />}
      />
      <BackBar solid={bar.solid} title={bar.solid ? CALENDAR_TITLE : undefined} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  chips: {flexDirection: 'row', paddingHorizontal: GUTTER, paddingTop: 6, paddingBottom: 8, gap: 8},
  month: {paddingTop: 10},
  dayEmpty: {color: colors.textDim, fontSize: 15, lineHeight: 21, paddingHorizontal: GUTTER},
  pending: {color: colors.textFaint, fontSize: 14, lineHeight: 20, paddingHorizontal: GUTTER, paddingBottom: 4},
  // the site's .cal-day-head: 16.3/800 in the dim grey, 22 above, 10 under; today in white
  day: {color: colors.textDim, fontSize: 16.3, fontWeight: '800', letterSpacing: 0.16, paddingHorizontal: GUTTER, marginTop: 22, marginBottom: 10},
  today: {color: colors.text},
  // .cal-entry at phone width: a faint fill, a hairline, 10 in, the buttons under the words
  row: {marginHorizontal: GUTTER, marginBottom: 10, padding: 10, gap: 10, borderRadius: radius.l, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)'},
  top: {flexDirection: 'row', alignItems: 'center', gap: 14},
  pic: {width: PIC_W, height: PIC_W * 1.5, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center'},
  words: {flex: 1, minWidth: 0, gap: 2},
  title: {color: colors.text, fontSize: 16, fontWeight: '800'},
  // .cal-what in the accent, a premiere's in gold (.kind-premiere)
  what: {color: colors.accent, fontSize: 14.4, fontWeight: '700'},
  premiere: {color: '#ffd479'},
  detail: {color: colors.text, opacity: 0.88, fontSize: 14.4},
  meta: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 6, marginTop: 2},
  why: {color: colors.textFaint, fontSize: 13.1, flexShrink: 1},
  badge: {paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.1)'},
  badgeText: {color: colors.text, fontSize: 12.2, fontWeight: '800'},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  act: {flexGrow: 1},
  empty: {alignItems: 'center', padding: 40, gap: 14},
  emptyText: {color: colors.textDim, fontSize: 16, textAlign: 'center', lineHeight: 22},
});
