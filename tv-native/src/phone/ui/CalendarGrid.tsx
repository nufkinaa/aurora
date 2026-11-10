// The Calendar's month on the phone (phone/screens/Calendar.tsx draws the
// picked day's releases under it) — the website's phone layout
// (public/js/screens/calendar.js at 320–599 px) and the TV's month
// (screens/CalendarMonth.tsx): the same month, the same words (calendar.ts).
//
//   Next up                     the next release and how far off; a tap picks its day
//   November 2026   ‹ ›         the month, its line, Today
//   S M T W T F S               this phone's first day of the week
//   the weeks                   a day with releases is its first poster: a coloured
//                               edge for the kind, a mint tick for what the server
//                               has, "+2" for more; today in violet; other months quiet
//   the legend
//
// A tap picks a day; a sideways swipe on the month changes month (it slides
// in from its side, unless the phone asks for less motion).
import React, {memo, useEffect, useMemo, useRef} from 'react';
import {AccessibilityInfo, Animated, Image, PanResponder, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {
  CAL_WORDS,
  cellLabel,
  cellOf,
  KIND_COLORS,
  KINDS,
  monthInfo,
  monthKeys,
  monthOf,
  monthWeeks,
} from '../../calendar';
import type {Calendar, CalendarCell, CalendarGrid as Grid} from '../../calendar';
import {artSrc} from './Cards';
import Icon from './Icon';
import Tap from './Tap';
import {colors, GUTTER, radius} from '../theme';

const GAP = 4;
const MAX_W = 560; // a tablet / an unfolded phone: the month stays a phone's size

const Day = memo(function CalendarDay({
  c,
  w,
  h,
  picked,
  label,
  onPick,
}: {
  c: CalendarCell;
  w: number;
  h: number;
  picked: boolean;
  label: string;
  onPick: (key: string) => void;
}) {
  const lead = c.inMonth ? c.items[0] || null : null;
  const art = lead ? artSrc(lead.poster || lead.item?.cover || null, Math.round(w)).src : null;
  const more = c.items.length - 1;
  const have = lead && (lead.state === 'have' || lead.state === 'partial');
  return (
    <Tap
      uiId="calendar.day"
      flat
      disabled={!c.inMonth}
      onPress={() => onPick(c.key)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{selected: picked}}
      style={[s.cell, {width: w, height: h}, !c.inMonth && s.cellOther, lead && s.cellHas]}>
      {lead ? (
        <View style={[StyleSheet.absoluteFill, c.past && s.past]}>
          {art ? (
            <Image source={art} style={s.fill} resizeMode="cover" fadeDuration={0} />
          ) : (
            <View style={[s.fill, s.artNone]}>
              <Text style={s.artTitle} numberOfLines={3}>
                {lead.title}
              </Text>
            </View>
          )}
          <View style={s.shade} />
          <View style={[s.kind, {backgroundColor: KIND_COLORS[lead.kind] || KIND_COLORS.episode}]} />
        </View>
      ) : null}
      <View style={[s.num, c.today && s.numToday]}>
        <Text style={[s.numText, !c.inMonth && s.numOther, (c.today || lead) && s.numBright]}>{c.n}</Text>
      </View>
      {lead && have ? (
        <View style={s.tick}>
          <Icon name="check" size={9} color={KIND_COLORS.have} />
        </View>
      ) : null}
      {lead && more > 0 ? (
        <View style={s.more}>
          <Text style={s.moreText}>{`+${more}`}</Text>
        </View>
      ) : null}
      {/* the rings over the picture: today's violet, the picked day's white */}
      {c.today || picked ? <View pointerEvents="none" style={[s.ring, c.today && s.ringToday, picked && s.ringPicked]} /> : null}
    </Tap>
  );
});

export default function CalendarGrid({
  cal,
  pick,
  onPick,
  onMonth,
}: {
  cal: Calendar & {grid: Grid};
  pick: string;
  onPick: (key: string) => void;
  /** -1 / 1: the month before / after (the screen keeps the picked day) */
  onMonth: (dir: -1 | 1) => void;
}) {
  const grid = cal.grid;
  const today = cal.today;
  const {width} = useWindowDimensions();
  const gridW = Math.min(width - GUTTER * 2, MAX_W);
  const cellW = (gridW - GAP * 6) / 7;
  const cellH = Math.round(cellW * (4 / 3));
  const shown = monthOf(pick);
  const months = monthKeys(grid);
  const i = months.indexOf(shown);
  const info = monthInfo(grid, shown);
  const weeks = useMemo(() => monthWeeks(shown, grid.weekStart), [shown, grid.weekStart]);

  // a month slides in from its side
  const slide = useRef(new Animated.Value(0)).current;
  const lastShown = useRef(shown);
  const calm = useRef(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled?.().then(v => (calm.current = !!v)).catch(() => {});
  }, []);
  useEffect(() => {
    if (lastShown.current === shown) return;
    const dir = shown > lastShown.current ? 1 : -1;
    lastShown.current = shown;
    if (calm.current) return;
    slide.setValue(dir * 28);
    Animated.timing(slide, {toValue: 0, duration: 260, useNativeDriver: true}).start();
  }, [shown, slide]);
  const fade = slide.interpolate({inputRange: [-28, 0, 28], outputRange: [0.2, 1, 0.2]});

  // a sideways swipe: the month before / after
  const monthRef = useRef(onMonth);
  monthRef.current = onMonth;
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
        onPanResponderTerminationRequest: () => true,
        onPanResponderRelease: (_e, g) => {
          if (Math.abs(g.dx) > 48 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6) monthRef.current(g.dx < 0 ? 1 : -1);
        },
      }),
    [],
  );

  const next = cal.next && grid.byDay[cal.next.day] && months.includes(monthOf(cal.next.day)) ? cal.next : null;
  const nextEntry = next ? grid.byDay[next.day].items.find(e => e.key === next.key) || null : null;
  const nextArt = nextEntry ? artSrc(nextEntry.poster || nextEntry.item?.cover || null, 30).src : null;
  const line = (info && info.line) || (cal.counts.titles ? cal.empty.month || '' : '');

  return (
    <View style={[s.wrap, {width: gridW}]}>
      {next ? (
        <Tap uiId="calendar.next" flat onPress={() => onPick(next.day)} style={s.next} accessibilityRole="button" accessibilityLabel={`${CAL_WORDS.nextUp}: ${next.title}, ${next.what}, ${next.when}`}>
          <View style={s.nextPic}>{nextArt ? <Image source={nextArt} style={s.fill} resizeMode="cover" /> : null}</View>
          <View style={s.nextText}>
            <Text style={[s.nextEyebrow, {color: KIND_COLORS[next.kind] || KIND_COLORS.episode}]}>{CAL_WORDS.nextUp.toUpperCase()}</Text>
            <Text style={s.nextTitle} numberOfLines={1}>
              {next.title}
            </Text>
            <Text style={s.nextWhat} numberOfLines={1}>
              {next.what}
            </Text>
          </View>
          <View style={s.when}>
            <Text style={s.whenText}>{next.when}</Text>
          </View>
        </Tap>
      ) : null}

      <View style={s.bar}>
        <Text style={s.month} numberOfLines={1} accessibilityRole="header">
          {info ? info.month : shown} <Text style={s.year}>{info ? info.year : ''}</Text>
        </Text>
        <View style={s.nav}>
          <Tap uiId="calendar.month" borderless disabled={i <= 0} onPress={() => onMonth(-1)} style={[s.arrow, i <= 0 && s.off]} accessibilityRole="button" accessibilityLabel={CAL_WORDS.prev}>
            <Icon name="chevronLeft" size={22} color={colors.text} />
          </Tap>
          <Tap uiId="calendar.month" borderless disabled={i >= months.length - 1} onPress={() => onMonth(1)} style={[s.arrow, i >= months.length - 1 && s.off]} accessibilityRole="button" accessibilityLabel={CAL_WORDS.next}>
            <Icon name="chevronRight" size={22} color={colors.text} />
          </Tap>
        </View>
      </View>
      <View style={s.todayRow}>
        <Text style={[s.line, !(info && info.line) && s.lineQuiet]}>{line}</Text>
        <Tap uiId="calendar.today" onPress={() => onPick(today)} style={s.todayBtn} accessibilityRole="button">
          <Text style={s.todayText}>{CAL_WORDS.today}</Text>
        </Tap>
      </View>

      <View style={s.weekRow}>
        {grid.weekdays.map((w, k) => (
          <Text key={k} style={[s.wd, {width: cellW}]}>
            {w.narrow}
          </Text>
        ))}
      </View>
      <Animated.View {...swipe.panHandlers} style={{transform: [{translateX: slide}], opacity: fade}}>
        {weeks.map((w, r) => (
          <View key={`${shown}:${r}`} style={s.weekRow}>
            {w.map(key => {
              const c = cellOf(grid, key, shown, today);
              return <Day key={key} c={c} w={cellW} h={cellH} picked={key === pick} label={cellLabel(cal, c)} onPick={onPick} />;
            })}
          </View>
        ))}
      </Animated.View>

      <View style={s.legend}>
        {KINDS.map(k => (
          <View key={k} style={s.key}>
            <View style={[s.keyBar, {backgroundColor: KIND_COLORS[k]}]} />
            <Text style={s.keyText}>{CAL_WORDS[k]}</Text>
          </View>
        ))}
        <View style={s.key}>
          <View style={s.keyTick}>
            <Icon name="check" size={10} color={KIND_COLORS.have} />
          </View>
          <Text style={s.keyText}>{CAL_WORDS.have}</Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {alignSelf: 'center'},
  next: {flexDirection: 'row', alignItems: 'center', gap: 11, padding: 8, paddingRight: 10, marginBottom: 18, borderRadius: radius.xl, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)'},
  nextPic: {width: 28, height: 42, borderRadius: 6, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.08)'},
  nextText: {flex: 1, minWidth: 0},
  nextEyebrow: {fontSize: 10.5, fontWeight: '800', letterSpacing: 1.5},
  nextTitle: {color: colors.text, fontSize: 16, fontWeight: '800', writingDirection: 'auto'},
  nextWhat: {color: colors.textDim, fontSize: 13.5, fontWeight: '600'},
  when: {paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.1)'},
  whenText: {color: colors.text, fontSize: 13, fontWeight: '800'},
  bar: {flexDirection: 'row', alignItems: 'center', gap: 10},
  month: {flex: 1, minWidth: 0, color: colors.text, fontSize: 24, fontWeight: '900', letterSpacing: -0.8},
  year: {color: colors.textDim, fontWeight: '300'},
  line: {flex: 1, minWidth: 0, color: colors.textDim, fontSize: 13, fontWeight: '700'},
  lineQuiet: {color: colors.textFaint},
  nav: {flexDirection: 'row', gap: 6},
  arrow: {width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)'},
  off: {opacity: 0.3},
  todayRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, marginBottom: 12},
  todayBtn: {paddingHorizontal: 16, minHeight: 36, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)'},
  todayText: {color: colors.text, fontSize: 14, fontWeight: '800'},
  weekRow: {flexDirection: 'row', gap: GAP, marginBottom: GAP},
  wd: {color: colors.textFaint, fontSize: 11, fontWeight: '800', textAlign: 'center', marginBottom: 2},
  cell: {borderRadius: 9, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.045)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)'},
  cellHas: {backgroundColor: '#1a1c2c', borderWidth: 0},
  cellOther: {backgroundColor: 'transparent', borderColor: 'transparent'},
  past: {opacity: 0.55},
  fill: {width: '100%', height: '100%'},
  artNone: {alignItems: 'center', justifyContent: 'center', backgroundColor: '#22243a', padding: 3},
  artTitle: {color: colors.text, fontSize: 9, fontWeight: '800', textAlign: 'center'},
  shade: {position: 'absolute', left: 0, right: 0, top: 0, height: 26, backgroundColor: 'rgba(6,7,14,0.35)'},
  kind: {position: 'absolute', left: 0, right: 0, bottom: 0, height: 3},
  num: {position: 'absolute', top: 4, left: 4, minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingHorizontal: 3},
  numToday: {backgroundColor: colors.accent},
  numText: {color: colors.textDim, fontSize: 12.5, fontWeight: '800'},
  numOther: {color: colors.textFaint, opacity: 0.6},
  numBright: {color: '#fff', textShadowColor: 'rgba(0,0,0,0.8)', textShadowRadius: 3},
  tick: {position: 'absolute', left: 3, bottom: 6, width: 14, height: 14, borderRadius: 7, backgroundColor: 'rgba(8,9,16,0.86)', alignItems: 'center', justifyContent: 'center'},
  more: {position: 'absolute', right: 3, bottom: 6, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 6, backgroundColor: 'rgba(6,7,14,0.8)'},
  moreText: {color: '#fff', fontSize: 10, fontWeight: '800'},
  ring: {position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 9},
  ringToday: {borderWidth: 1.5, borderColor: 'rgba(139,123,255,0.9)'},
  ringPicked: {borderWidth: 2, borderColor: '#fff'},
  legend: {flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 8, marginTop: 10},
  key: {flexDirection: 'row', alignItems: 'center', gap: 6},
  keyBar: {width: 15, height: 4, borderRadius: 2},
  keyTick: {width: 15, height: 15, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center'},
  keyText: {color: colors.textDim, fontSize: 12, fontWeight: '700'},
});
