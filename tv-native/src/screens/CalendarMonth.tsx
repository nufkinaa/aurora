// The Calendar's month, for the remote (screens/Calendar.tsx shows it when the
// Month / List switch says Month; the website's is public/js/screens/calendar.js,
// the phone's phone/screens/Calendar.tsx — the same month, the same words).
//
//   left    the month's name and its line ("9 releases · 2 premieres"), the
//           weekdays from this TV's first day of the week, and the weeks: a
//           day with releases is its first poster, a coloured edge for the
//           kind, a mint tick when the server has it, "+2" for more; today in
//           violet, other months' days quiet and out of reach
//   right   Next up (OK goes to its day) and the picked day's releases in full:
//           OK on a row opens the title, Play / Save & watch beside it
//
// D-pad: a day takes focus → it is the picked day (the panel follows after a
// beat, so holding a direction does not redraw the panel twenty times). OK on
// a day goes into its releases; LEFT from them comes back to that same day,
// not to whichever day happens to sit beside the panel (and coming back from
// the arrows above or from the rail lands on it too). UP from the top week
// reaches ‹ Today ›; the rewind / fast-forward keys change month.
// Performance: one picture per day, no shadows or blur on a day, the days
// memoised so a pick redraws two of them.
import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Image, ScrollView, StyleSheet, Text, View} from 'react-native';
import Btn from '../components/Btn';
import Focusable from '../components/Focusable';
import Icon from '../components/Icon';
import {artSrc} from '../api';
import {
  canPlay,
  CAL_WORDS,
  cellLabel,
  cellOf,
  dayEmptyLine,
  entryLabel,
  firstPick,
  KIND_COLORS,
  KINDS,
  monthInfo,
  monthKeys,
  monthOf,
  monthPick,
  monthWeeks,
  PLAY_WORD,
  SAVE_WORD,
  SAVING_WORD,
} from '../calendar';
import type {Calendar, CalendarCell, CalendarEntry, CalendarGrid} from '../calendar';
import {noteOwnFocusMove, useFocusFallback, useTVKeys} from '../focus';
import {registerProfileCache} from '../profileScope';
import theme from '../theme';

const {colors, fontSize, radius, spacing} = theme;

export const CELL_W = 62;
export const CELL_H = 56;
const GAP = 4;
const PICK_AFTER_MS = 110; // a held direction does not redraw the panel on every day it passes

type NodeRef = {requestTVFocus?: () => void} | null;

// kept while this profile is here: Back from a title lands on the same day
// (and so its month). The next profile starts on its own next release
// (profileScope.ts).
let lastPick: string | null = null;
registerProfileCache('CalendarMonth', () => {
  lastPick = null;
});

const kindColor = (e: CalendarEntry) => KIND_COLORS[e.kind] || KIND_COLORS.episode;

const DayCell = memo(function CalendarDayCell({
  c,
  picked,
  col,
  claim,
  label,
  pickRef,
  onFocusDay,
  onPressDay,
}: {
  c: CalendarCell;
  picked: boolean;
  col: number;
  claim: boolean;
  label: string;
  pickRef: React.Ref<unknown> | undefined;
  onFocusDay: (key: string) => void;
  onPressDay: (key: string) => void;
}) {
  const lead = c.items[0] || null;
  const art = lead ? artSrc(lead.poster || lead.item?.cover || null, CELL_W).src : null;
  const more = c.items.length - 1;
  const have = lead && (lead.state === 'have' || lead.state === 'partial');
  return (
    <Focusable
      uiId="calendar.day"
      ref={pickRef as never}
      ringWidth={2}
      scaleTo={1.08}
      edgeLeft={col === 0}
      focusDisabled={!c.inMonth}
      hasTVPreferredFocus={claim}
      accessibilityLabel={label}
      onFocusChange={f => f && onFocusDay(c.key)}
      onPress={() => onPressDay(c.key)}
      style={[
        styles.cell,
        !c.inMonth && styles.cellOther,
        c.items.length > 0 && c.inMonth && styles.cellHas,
        c.today && styles.cellToday,
        picked && styles.cellPicked,
      ]}>
      {lead && c.inMonth ? (
        <View style={[StyleSheet.absoluteFill, c.past && styles.past]}>
          {art ? (
            <Image source={art} style={styles.art} resizeMode="cover" fadeDuration={0} />
          ) : (
            <View style={[styles.art, styles.artNone]}>
              <Text style={styles.artTitle} numberOfLines={3}>
                {lead.title}
              </Text>
            </View>
          )}
          <View style={[styles.kind, {backgroundColor: kindColor(lead)}]} />
        </View>
      ) : null}
      <View style={[styles.num, lead && c.inMonth && styles.numOnArt, c.today && styles.numToday]}>
        <Text style={[styles.numText, !c.inMonth && styles.numOther, (c.today || (lead && c.inMonth)) && styles.numBright]}>{c.n}</Text>
      </View>
      {lead && c.inMonth && have ? (
        <View style={styles.tick}>
          <Icon name="check" size={9} color={KIND_COLORS.have} />
        </View>
      ) : null}
      {c.inMonth && more > 0 ? (
        <View style={styles.more}>
          <Text style={styles.moreText}>{`+${more}`}</Text>
        </View>
      ) : null}
    </Focusable>
  );
});

const PanelRow = memo(function CalendarPanelRow({
  e,
  saving,
  first,
  firstRef,
  onOpen,
  onPlay,
  onSave,
  onFocusPanel,
}: {
  e: CalendarEntry;
  saving: boolean;
  first: boolean;
  firstRef: React.Ref<unknown>;
  onOpen: (e: CalendarEntry) => void;
  onPlay: (e: CalendarEntry) => void;
  onSave: (e: CalendarEntry) => void;
  onFocusPanel: (f: boolean) => void;
}) {
  const art = artSrc(e.poster || e.item?.cover || null, 44).src;
  const play = canPlay(e);
  // The Save button goes once its answer is in: focus on it lands on the row (the list's rule)
  const rowRef = useRef<NodeRef>(null);
  const saveFocused = useRef(false);
  useEffect(() => {
    if (!e.canSave && saveFocused.current) {
      saveFocused.current = false;
      noteOwnFocusMove();
      rowRef.current?.requestTVFocus?.();
    }
  }, [e.canSave]);
  const setRow = useCallback(
    (n: NodeRef) => {
      rowRef.current = n;
      if (first && firstRef && typeof firstRef === 'object') (firstRef as React.MutableRefObject<NodeRef>).current = n;
    },
    [first, firstRef],
  );
  const tone = e.state === 'have' || e.state === 'partial' ? KIND_COLORS.have : e.state === 'waiting' ? colors.star : colors.accent;
  return (
    <View style={styles.row}>
      <Focusable
        uiId="calendar.open"
        ref={setRow as never}
        scaleTo={1.02}
        highlightColor={colors.surfaceHover}
        accessibilityLabel={entryLabel(e)}
        onFocusChange={onFocusPanel}
        onPress={() => onOpen(e)}
        style={styles.rowOpen}>
        <View style={styles.rowPoster}>
          {art ? <Image source={art} style={styles.art} resizeMode="cover" fadeDuration={0} /> : null}
          <View style={[styles.kind, {backgroundColor: kindColor(e)}]} />
        </View>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {e.title}
          </Text>
          <Text style={[styles.rowWhat, {color: e.kind === 'premiere' ? KIND_COLORS.premiere : colors.accent}]} numberOfLines={1}>
            {e.what}
          </Text>
          {e.detail ? (
            <Text style={styles.rowDetail} numberOfLines={1}>
              {e.detail}
            </Text>
          ) : null}
          {e.badge || e.why ? (
            <View style={styles.rowMeta}>
              {e.badge ? (
                <View style={[styles.badge, {borderColor: tone}]}>
                  <View style={[styles.badgeDot, {backgroundColor: tone}]} />
                  <Text style={[styles.badgeText, {color: tone}]} numberOfLines={1}>
                    {e.badge}
                  </Text>
                </View>
              ) : null}
              {e.why ? (
                <Text style={styles.rowWhy} numberOfLines={1}>
                  {e.why}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </Focusable>
      {play || e.canSave ? (
        <View style={styles.rowActions}>
          {play ? <Btn uiId="calendar.play" primary small label={PLAY_WORD} onFocusChange={onFocusPanel} onPress={() => onPlay(e)} /> : null}
          {e.canSave ? (
            <Btn
              uiId="calendar.save"
              small
              dim={saving}
              label={saving ? SAVING_WORD : SAVE_WORD}
              onFocusChange={f => {
                saveFocused.current = f;
                onFocusPanel(f);
              }}
              onPress={() => !saving && onSave(e)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

function Arrow({dir, disabled, onPress, onFocus}: {dir: -1 | 1; disabled: boolean; onPress: () => void; onFocus: (f: boolean) => void}) {
  return (
    <Focusable
      uiId="calendar.month"
      round
      accessibilityLabel={dir < 0 ? CAL_WORDS.prev : CAL_WORDS.next}
      onFocusChange={onFocus}
      onPress={onPress}
      style={[styles.arrow, disabled && styles.arrowOff]}>
      <View style={dir > 0 ? styles.flip : null}>
        <Icon name="back" size={18} color={colors.text} />
      </View>
    </Focusable>
  );
}

export default function CalendarMonth({
  cal,
  saving,
  claimFocus,
  onOpen,
  onPlay,
  onSave,
}: {
  cal: Calendar & {grid: CalendarGrid};
  saving: Record<string, true>;
  claimFocus: boolean;
  onOpen: (e: CalendarEntry) => void;
  onPlay: (e: CalendarEntry) => void;
  onSave: (e: CalendarEntry) => void;
}) {
  const grid = cal.grid;
  const today = cal.today;
  const months = useMemo(() => monthKeys(grid), [grid]);
  const [pick, setPick] = useState<string>(() => {
    const p = lastPick && grid.byDay[lastPick] && months.includes(monthOf(lastPick)) ? lastPick : firstPick(cal) || today;
    return months.includes(monthOf(p)) ? p : monthPick(grid, p, months.includes(monthOf(today)) ? monthOf(today) : months[0], today);
  });
  const shown = monthOf(pick);
  useEffect(() => {
    lastPick = pick;
  }, [pick]);

  const weeks = useMemo(() => monthWeeks(shown, grid.weekStart), [shown, grid.weekStart]);
  const cells = useMemo(() => weeks.map(w => w.map(key => cellOf(grid, key, shown, today))), [weeks, grid, shown, today]);
  const info = monthInfo(grid, shown);
  const i = months.indexOf(shown);

  // ---- focus: a day focused is the picked day (after a beat) ----
  const pickRef = useRef<NodeRef>(null);
  const panelFirst = useRef<NodeRef>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inGrid = useRef(false); // false while focus is on the panel, the arrows, the rail
  // the picked day takes the focus on arrival, once — never again on a month change
  // (a new day mounted with hasTVPreferredFocus would pull the focus off the arrow)
  const [claiming, setClaiming] = useState(claimFocus);
  const pickNow = useRef(pick);
  pickNow.current = pick;
  // focus lost (a button that goes, a re-read): the picked day
  useFocusFallback(pickRef);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  // The picked day takes the focus on arrival. hasTVPreferredFocus alone loses to
  // the screen's loading chrome going away (its focus fallback answers 120 ms
  // later), so the claim is made again just after that.
  useEffect(() => {
    if (!claimFocus) return;
    const t = setTimeout(() => {
      if (inGrid.current) return;
      noteOwnFocusMove();
      pickRef.current?.requestTVFocus?.();
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onFocusDay = useCallback((key: string) => {
    setClaiming(false);
    const wasOutside = !inGrid.current;
    inGrid.current = true;
    if (timer.current) clearTimeout(timer.current);
    // coming back into the grid (LEFT from the panel, DOWN from the arrows, out of
    // the rail) lands on the picked day, not on whichever day sits nearest
    if (wasOutside && key !== pickNow.current) {
      noteOwnFocusMove();
      pickRef.current?.requestTVFocus?.();
      return;
    }
    timer.current = setTimeout(() => setPick(key), PICK_AFTER_MS);
  }, []);
  const leaveGrid = useCallback((f: boolean) => {
    if (f) inGrid.current = false;
  }, []);
  const onPressDay = useCallback((key: string) => {
    if (timer.current) clearTimeout(timer.current);
    setPick(key);
    // OK: into the day's releases
    setTimeout(() => panelFirst.current?.requestTVFocus?.(), 0);
  }, []);
  // A month turned from the remote while a day held the focus: that day goes with
  // its month, and Android hands the focus to whatever is nearest (the Month /
  // List switch). The new month's picked day takes it instead.
  const turned = useRef(false);
  const goMonth = useCallback(
    (dir: -1 | 1) => {
      setClaiming(false);
      const j = months.indexOf(monthOf(pickNow.current)) + dir;
      if (j < 0 || j >= months.length) return;
      if (timer.current) clearTimeout(timer.current);
      // (an arrow pressed keeps the focus itself: inGrid is false there)
      turned.current = inGrid.current;
      setPick(monthPick(grid, pickNow.current, months[j], today));
    },
    [months, grid, today],
  );
  useEffect(() => {
    if (!turned.current) return;
    turned.current = false;
    const claim = () => {
      noteOwnFocusMove();
      pickRef.current?.requestTVFocus?.();
    };
    claim();
    // …and once more, after Android's own hand-off has landed
    const t = setTimeout(claim, 150);
    return () => clearTimeout(t);
  }, [shown]);
  const toToday = useCallback(() => {
    setClaiming(false);
    if (timer.current) clearTimeout(timer.current);
    setPick(today);
  }, [today]);
  // the remote's rewind / fast-forward: a month back / on
  useTVKeys(
    useCallback(
      (evt: {eventType: string}) => {
        if (evt.eventType === 'fastForward') goMonth(1);
        else if (evt.eventType === 'rewind') goMonth(-1);
      },
      [goMonth],
    ),
  );

  const day = grid.byDay[pick] || {label: pick, date: null, items: []};
  const next = cal.next && grid.byDay[cal.next.day] ? cal.next : null;
  const nextEntry = next ? grid.byDay[next.day].items.find(e => e.key === next.key) || null : null;
  const nextArt = nextEntry ? artSrc(nextEntry.poster || nextEntry.item?.cover || null, 30).src : null;
  const line = (info && info.line) || (cal.counts.titles ? cal.empty.month || '' : '');

  return (
    <View style={styles.wrap}>
      <View style={styles.left}>
        <View style={styles.bar}>
          <View style={styles.titles}>
            <Text style={styles.month} numberOfLines={1}>
              {info ? info.month : shown} <Text style={styles.year}>{info ? info.year : ''}</Text>
            </Text>
            <Text style={[styles.line, !(info && info.line) && styles.lineQuiet]} numberOfLines={1}>
              {line}
            </Text>
          </View>
          <View style={styles.nav}>
            <Arrow dir={-1} disabled={i <= 0} onFocus={leaveGrid} onPress={() => goMonth(-1)} />
            <Btn uiId="calendar.today" small label={CAL_WORDS.today} onFocusChange={leaveGrid} onPress={toToday} />
            <Arrow dir={1} disabled={i >= months.length - 1} onFocus={leaveGrid} onPress={() => goMonth(1)} />
          </View>
        </View>
        <View style={styles.weekRow}>
          {grid.weekdays.map((w, k) => (
            <Text key={k} style={styles.wd} numberOfLines={1}>
              {w.short}
            </Text>
          ))}
        </View>
        {cells.map((w, r) => (
          <View key={`${shown}:${r}`} style={styles.weekRow}>
            {w.map((c, col) => (
              <DayCell
                key={c.key}
                c={c}
                col={col}
                picked={c.key === pick}
                claim={claiming && c.key === pick}
                label={cellLabel(cal, c)}
                pickRef={c.key === pick ? (pickRef as never) : undefined}
                onFocusDay={onFocusDay}
                onPressDay={onPressDay}
              />
            ))}
          </View>
        ))}
        <View style={styles.legend}>
          {KINDS.map(k => (
            <View key={k} style={styles.key}>
              <View style={[styles.keyBar, {backgroundColor: KIND_COLORS[k]}]} />
              <Text style={styles.keyText}>{CAL_WORDS[k]}</Text>
            </View>
          ))}
          <View style={styles.key}>
            <Icon name="check" size={11} color={KIND_COLORS.have} />
            <Text style={styles.keyText}>{CAL_WORDS.have}</Text>
          </View>
        </View>
      </View>

      <View style={styles.right}>
        {next ? (
          <Focusable
            uiId="calendar.next"
            scaleTo={1.02}
            highlightColor={colors.surfaceHover}
            accessibilityLabel={`${CAL_WORDS.nextUp}: ${next.title}, ${next.what}, ${next.when}`}
            onFocusChange={leaveGrid}
            onPress={() => {
              setClaiming(false);
              if (months.includes(monthOf(next.day))) setPick(next.day);
            }}
            style={styles.next}>
            <View style={styles.nextPic}>{nextArt ? <Image source={nextArt} style={styles.art} resizeMode="cover" fadeDuration={0} /> : null}</View>
            <View style={styles.nextText}>
              <Text style={[styles.nextEyebrow, {color: KIND_COLORS[next.kind] || colors.accent}]}>{CAL_WORDS.nextUp.toUpperCase()}</Text>
              <Text style={styles.nextTitle} numberOfLines={1}>
                {next.title}
              </Text>
              <Text style={styles.nextWhat} numberOfLines={1}>
                {next.what}
              </Text>
            </View>
            <View style={styles.when}>
              <Text style={styles.whenText}>{next.when}</Text>
            </View>
          </Focusable>
        ) : null}
        <View style={styles.panel}>
          <View style={styles.panelHead}>
            {pick === today ? <View style={styles.todayDot} /> : null}
            <Text style={styles.panelLabel} numberOfLines={1}>
              {day.label}
            </Text>
            {day.date ? <Text style={styles.panelDate}>{day.date}</Text> : null}
          </View>
          {day.items.length ? (
            <ScrollView style={styles.panelList} contentContainerStyle={styles.panelListIn} showsVerticalScrollIndicator={false}>
              {day.items.map((e, k) => (
                <PanelRow
                  key={e.key}
                  e={e}
                  first={k === 0}
                  firstRef={panelFirst as never}
                  saving={!!saving[e.key]}
                  onOpen={onOpen}
                  onPlay={onPlay}
                  onSave={onSave}
                  onFocusPanel={leaveGrid}
                />
              ))}
            </ScrollView>
          ) : (
            <Text style={styles.panelEmpty}>{dayEmptyLine(cal)}</Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, flexDirection: 'row', gap: 22},
  left: {width: CELL_W * 7 + GAP * 6},
  right: {flex: 1, minWidth: 0, paddingTop: 2},
  bar: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 10},
  titles: {flex: 1, minWidth: 0},
  month: {color: colors.text, fontSize: 24, lineHeight: 29, fontWeight: '900', letterSpacing: -0.6},
  year: {color: colors.textDim, fontWeight: '300'},
  line: {color: colors.textDim, fontSize: 12, fontWeight: '700', marginTop: 1},
  lineQuiet: {color: colors.textFaint},
  nav: {flexDirection: 'row', alignItems: 'center', gap: 6},
  arrow: {width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface},
  arrowOff: {opacity: 0.3},
  flip: {transform: [{scaleX: -1}]},
  weekRow: {flexDirection: 'row', gap: GAP, marginBottom: GAP},
  wd: {width: CELL_W, color: colors.textFaint, fontSize: 10, fontWeight: '800', letterSpacing: 1, paddingLeft: 6, marginBottom: 1},
  cell: {width: CELL_W, height: CELL_H, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.035)', overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)'},
  cellHas: {backgroundColor: '#1a1c2c'},
  cellOther: {backgroundColor: 'transparent', borderColor: 'transparent'},
  cellToday: {borderColor: 'rgba(139,123,255,0.85)', borderWidth: 1.5},
  cellPicked: {borderColor: 'rgba(255,255,255,0.95)', borderWidth: 2},
  past: {opacity: 0.55},
  art: {width: '100%', height: '100%'},
  artNone: {alignItems: 'center', justifyContent: 'center', backgroundColor: '#22243a', padding: 3},
  artTitle: {color: colors.text, fontSize: 8, fontWeight: '800', textAlign: 'center'},
  kind: {position: 'absolute', left: 0, right: 0, bottom: 0, height: 3},
  num: {position: 'absolute', top: 4, left: 5, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', borderRadius: 9, paddingHorizontal: 3},
  numOnArt: {backgroundColor: 'rgba(6,7,14,0.72)'},
  numToday: {backgroundColor: colors.accent},
  numText: {color: colors.textDim, fontSize: 11, fontWeight: '800'},
  numOther: {color: colors.textFaint, opacity: 0.6},
  numBright: {color: colors.white},
  tick: {position: 'absolute', left: 4, bottom: 6, width: 13, height: 13, borderRadius: 7, backgroundColor: 'rgba(8,9,16,0.86)', alignItems: 'center', justifyContent: 'center'},
  more: {position: 'absolute', right: 3, bottom: 6, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 6, backgroundColor: 'rgba(6,7,14,0.8)'},
  moreText: {color: colors.white, fontSize: 9, fontWeight: '800'},
  legend: {flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4, marginTop: 4},
  key: {flexDirection: 'row', alignItems: 'center', gap: 5},
  keyBar: {width: 12, height: 3, borderRadius: 2},
  keyText: {color: colors.textDim, fontSize: 10, fontWeight: '700'},
  next: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 7, paddingRight: 10, borderRadius: radius.m, backgroundColor: colors.surface, marginBottom: 10},
  nextPic: {width: 26, height: 39, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.surface},
  nextText: {flex: 1, minWidth: 0},
  nextEyebrow: {fontSize: 9, fontWeight: '900', letterSpacing: 1.4},
  nextTitle: {color: colors.text, fontSize: 14, fontWeight: '800', writingDirection: 'auto'},
  nextWhat: {color: colors.textDim, fontSize: 12, fontWeight: '600'},
  when: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.1)'},
  whenText: {color: colors.text, fontSize: 12, fontWeight: '800'},
  panel: {flex: 1, borderRadius: radius.l, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', padding: 10},
  panelHead: {flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 8},
  todayDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent, alignSelf: 'center'},
  panelLabel: {color: colors.text, fontSize: fontSize.row, fontWeight: '800', flexShrink: 1},
  panelDate: {color: colors.textDim, fontSize: fontSize.small, fontWeight: '700'},
  panelList: {flex: 1},
  panelListIn: {gap: spacing.sm, paddingBottom: 30},
  panelEmpty: {color: colors.textDim, fontSize: fontSize.small, lineHeight: 19},
  row: {gap: 6},
  rowOpen: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 6, borderRadius: radius.m, backgroundColor: 'rgba(255,255,255,0.04)'},
  rowPoster: {width: 34, height: 51, borderRadius: 5, overflow: 'hidden', backgroundColor: colors.bgRaised},
  rowText: {flex: 1, minWidth: 0, gap: 1},
  rowTitle: {color: colors.text, fontSize: 14, fontWeight: '800', writingDirection: 'auto'},
  rowWhat: {fontSize: 12, fontWeight: '700'},
  rowDetail: {color: colors.text, opacity: 0.88, fontSize: 12},
  rowMeta: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1},
  rowWhy: {flexShrink: 1, color: colors.textFaint, fontSize: 11, fontWeight: '600'},
  badge: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 1, paddingLeft: 6, paddingRight: 7, borderRadius: radius.pill, borderWidth: 1, backgroundColor: 'rgba(255,255,255,0.06)'},
  badgeDot: {width: 5, height: 5, borderRadius: 3},
  badgeText: {fontSize: 11, fontWeight: '700'},
  rowActions: {flexDirection: 'row', gap: 6},
});
