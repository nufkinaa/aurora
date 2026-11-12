// Aurora Wrapped on the TV — the chapters. One full-screen page each, told in
// beats: `beat` 0 is what is there when the page opens, and every later beat
// brings one more piece (./story.ts says when). The screen keeps the clock;
// a chapter only draws what its beat says.
//
// Every piece that arrives is mounted from the start, at its place, unseen —
// the page is laid out once and nothing on it jumps. Under calm the screen
// hands every chapter the last beat at once: complete and still.
//
// Gold is for a win, three times in the story: the hours, the number one,
// the viewer type.
import React, {useMemo} from 'react';
import {Animated, Image, StyleSheet, Text, View} from 'react-native';
import {LINEAR} from '../anim';
import {BACK_SRC} from '../Cards';
import Meter from '../Meter';
import {Flip} from '../Motion';
import Odometer from '../Odometer';
import SkyLines from '../SkyLines';
import {Glow, GLOW_SRC, Star} from '../Star';
import {PLAY} from '../tokens';
import {hourLabel} from '../wrappedRules';
import type {Chapter} from '../wrappedRules';
import {Bar, Chip, Columns, Eyebrow, NightSky, Poster, Show, ty, useShow} from './parts';
import type {Place, Story} from './story';

export const FACE_SRC = require('../../assets/play-face.png');

// Where a chapter stands on the screen: inside the gutters, under the
// progress row.
export const FRAME = {x: 48, top: 48, bottom: 27};

// the viewer-type card
const CARD_W = 220;
const CARD_H = 330;
const TYPE_GAP = 56;
const TYPE_COL = 440;

// The middle of the viewer-type card on the screen: where the burst is fired.
export const typeCardCentre = (screenW: number, screenH: number) => ({
  x: Math.round(screenW / 2 - (CARD_W + TYPE_GAP + TYPE_COL) / 2 + CARD_W / 2),
  y: Math.round(FRAME.top + (screenH - FRAME.top - FRAME.bottom) / 2),
});

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

type Base = {beat: number; calm: boolean};

// ---------- opening ----------
function Opening({beat, calm, s, w, h}: Base & {s: Story; w: number; h: number}) {
  const skyH = clamp(h - 290, 130, 200);
  return (
    <View style={st.page} testID="wrapped.chapter.opening">
      <Eyebrow>Aurora Wrapped</Eyebrow>
      <Text style={[ty.title, st.big, ty.center, st.gapS]} numberOfLines={2}>
        {s.opening.title}
      </Text>
      {s.sky.stars.length ? (
        <View style={st.gapM}>
          <NightSky sky={s.sky} width={w} height={skyH} calm={calm} from={s.skyFrom} to={s.skyTo} />
        </View>
      ) : null}
      <Show on={beat >= 1} calm={calm} style={st.gapM}>
        <Text style={[ty.line, ty.center]} numberOfLines={2}>
          {s.opening.line}
        </Text>
      </Show>
      <Show on={beat >= 2} calm={calm} style={[st.row, st.gapM]}>
        {s.opening.chips.map(c => (
          <Chip key={c} label={c} />
        ))}
      </Show>
      <Show on={beat >= 3} calm={calm} dy={0} style={st.gapM}>
        <Text style={[ty.small, ty.center]} numberOfLines={1}>
          {calm ? 'Right for next  ·  Left to go back' : 'Right for next  ·  Left to go back  ·  Play/Pause to hold'}
        </Text>
      </Show>
    </View>
  );
}

// ---------- hours ----------
function Hours({beat, calm, s}: Base & {s: Story}) {
  const hrs = s.hours;
  return (
    <View style={st.page} testID="wrapped.chapter.hours">
      <Eyebrow>{hrs.eyebrow}</Eyebrow>
      <View style={st.hoursBox}>
        {/* the light behind a win: one still, soft picture */}
        <Glow size={360} color={PLAY.gold} opacity={0.2} style={st.hoursGlow} />
        <Odometer text={hrs.value} size={96} ms={1100} delay={300} calm={calm} accessibilityLabel={`${hrs.value} ${hrs.unit}`} />
      </View>
      <Show on={beat >= 1} calm={calm}>
        <Text style={[ty.sub, ty.center]} numberOfLines={1}>
          {hrs.unit}
        </Text>
      </Show>
      {hrs.lines.map((line, i) => (
        <Show key={i} on={beat >= 2 + i} calm={calm} style={i ? st.gapXS : st.gapM}>
          <Text style={[ty.line, ty.center]} numberOfLines={2}>
            {line}
          </Text>
        </Show>
      ))}
    </View>
  );
}

// ---------- number one ----------
function Top({beat, calm, t}: Base & {t: NonNullable<Story['top']>}) {
  const W = 200;
  const H = 300;
  const turned = beat >= 1;
  const lit = useShow(turned, {ms: 500, delay: 350, calm});
  return (
    <View style={[st.page, st.across]} testID="wrapped.chapter.top">
      <View style={{width: W, height: H}}>
        <Animated.Image
          source={GLOW_SRC}
          fadeDuration={0}
          style={[st.topGlow, {opacity: lit.interpolate({inputRange: [0, 1], outputRange: [0, 0.3]})}]}
        />
        <Flip
          flipped={turned}
          width={W}
          height={H}
          calm={calm}
          front={<Image source={BACK_SRC} fadeDuration={0} style={{width: W, height: H, borderRadius: 18}} />}
          back={
            <View style={{width: W, height: H}}>
              <Poster poster={t.poster} title={t.name} width={W} height={H} radius={18} size={20} />
              <View style={[st.edge, st.edgeGold]} pointerEvents="none" />
              <View style={st.medal}>
                <Text style={st.medalText}>1</Text>
              </View>
            </View>
          }
        />
      </View>
      <View style={st.sideCol}>
        <Eyebrow>Your number one</Eyebrow>
        <Show on={beat >= 2} calm={calm} style={st.gapS}>
          <Text style={[ty.title, st.big]} numberOfLines={2}>
            {t.name}
          </Text>
        </Show>
        <Show on={beat >= 3} calm={calm} style={st.gapS}>
          <Text style={ty.line} numberOfLines={2}>
            {t.line}
          </Text>
        </Show>
      </View>
    </View>
  );
}

// ---------- the podium ----------
function Podium({beat, calm, p}: Base & {p: NonNullable<Story['podium']>}) {
  const [first, second, third] = p.places;
  // second, first, third — as they stand on the steps; the third arrives first
  const cols: {pl: Place; at: number; pw: number; ph: number; step: number}[] = [
    {pl: second, at: 2, pw: 104, ph: 156, step: 104},
    {pl: first, at: 3, pw: 120, ph: 180, step: 124},
    {pl: third, at: 1, pw: 104, ph: 156, step: 88},
  ];
  return (
    <View style={st.page} testID="wrapped.chapter.podium">
      <Eyebrow>The podium</Eyebrow>
      <View style={[st.podium, st.gapM]}>
        <View style={st.steps}>
          {cols.map(c => {
            const win = c.pl.rank === 1;
            return (
              <View key={c.pl.rank} style={st.stepCol}>
                <Show on={beat >= c.at} calm={calm} dy={-46} ms={420} style={st.stepPoster}>
                  <Poster poster={c.pl.poster} title={c.pl.name} width={c.pw} height={c.ph} radius={12} size={14} />
                  {win ? <View style={[st.edge, st.edgeGold, st.edgeSmall]} pointerEvents="none" /> : null}
                </Show>
                <View style={[st.step, {height: c.step}, win && st.stepFirst]}>
                  <Text style={[st.stepNo, win && st.gold]}>{c.pl.rank}</Text>
                  <Show on={beat >= c.at} calm={calm} dy={6} style={st.fill}>
                    <Text style={st.stepTitle} numberOfLines={2}>
                      {c.pl.name}
                    </Text>
                    <Text style={ty.small} numberOfLines={1}>
                      {c.pl.hours}
                    </Text>
                  </Show>
                </View>
              </View>
            );
          })}
        </View>
        {p.rest.length ? (
          <Show on={beat >= 4} calm={calm} style={st.rest}>
            <Text style={ty.small} numberOfLines={1}>
              Also in your top five
            </Text>
            {p.rest.map(r => (
              <View key={r.rank} style={st.restRow}>
                <Text style={st.restNo}>{r.rank}</Text>
                <View style={st.fill}>
                  <Text style={st.restTitle} numberOfLines={2}>
                    {r.name}
                  </Text>
                  <Text style={ty.small} numberOfLines={1}>
                    {r.hours}
                  </Text>
                </View>
              </View>
            ))}
          </Show>
        ) : null}
      </View>
    </View>
  );
}

// ---------- genres ----------
// A race on ONE value: every bar is a curve of it. The runners-up set off
// fast and tire; the winner starts last and passes them all.
const RACE_MS = 2200;
function Genres({beat, calm, g}: Base & {g: NonNullable<Story['genres']>}) {
  const race = useShow(beat >= 1, {ms: RACE_MS, easing: LINEAR, calm});
  const win = Math.max(0, g.bars.findIndex(b => b.fill >= 0.999));
  const curves = useMemo(
    () =>
      g.bars.map((b, i) => {
        const f = Math.max(0.04, b.fill);
        return i === win
          ? {at: [0, 0.3, 0.6, 0.85, 1], to: [0, 0.12 * f, 0.4 * f, 0.72 * f, f]}
          : {at: [0, 0.3, 0.6, 1], to: [0, f * (0.62 - 0.06 * i), f * (0.92 - 0.02 * i), f]};
      }),
    [g, win],
  );
  return (
    <View style={st.page} testID="wrapped.chapter.genres">
      <Eyebrow>Your genre DNA</Eyebrow>
      <View style={[st.bars, st.gapL]}>
        {g.bars.map((b, i) => (
          <View key={b.name + i} style={st.barRow}>
            <Text style={[st.barName, i === win && st.barNameWin]} numberOfLines={1}>
              {b.name}
            </Text>
            <Bar v={race} at={curves[i].at} to={curves[i].to} width={480} height={22} aurora={i === win} />
            <Show on={beat >= 2} calm={calm} dy={0} delay={i * 60} style={st.barPct}>
              <Text style={[st.barPctText, i === win && st.green]} numberOfLines={1}>
                {b.pct}
              </Text>
            </Show>
          </View>
        ))}
      </View>
      <Show on={beat >= 2} calm={calm} style={st.gapL}>
        <Text style={[ty.title, ty.center]} numberOfLines={2}>
          {g.title}
        </Text>
      </Show>
    </View>
  );
}

// ---------- your hour ----------
const HOUR_W = 22;
const HOUR_GAP = 6;
const DAY_W = 16;
const CHART_H = 130;
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
function Night({beat, calm, n}: Base & {n: NonNullable<Story['night']>}) {
  return (
    <View style={st.page} testID="wrapped.chapter.night">
      <Eyebrow>When you really watch</Eyebrow>
      <View style={[st.charts, st.gapL]}>
        <View style={{width: 24 * HOUR_W + 23 * HOUR_GAP}}>
          <Columns values={n.hours} peak={n.peak} on={beat >= 1} lit={beat >= 2} calm={calm} colW={HOUR_W} gap={HOUR_GAP} height={CHART_H} />
          <View style={st.axis}>
            {[0, 6, 12, 18].map(hh => (
              <Text key={hh} style={[st.axisText, st.axisAt, {left: hh * (HOUR_W + HOUR_GAP)}]} numberOfLines={1}>
                {hourLabel(hh)}
              </Text>
            ))}
          </View>
        </View>
        <Show on={beat >= 3} calm={calm} dy={8}>
          <Columns values={n.week} peak={n.day} on={beat >= 3} lit={beat >= 3} calm={calm} colW={DAY_W} gap={HOUR_GAP} height={CHART_H} each={420} step={50} />
          <View style={[st.row, st.axis, {gap: HOUR_GAP}]}>
            {DAY_LETTERS.map((d, i) => (
              <Text key={i} style={[st.axisText, st.dayLetter, i === n.day && st.green]}>
                {d}
              </Text>
            ))}
          </View>
        </Show>
      </View>
      <Show on={beat >= 2} calm={calm} style={st.gapL}>
        <Text style={[ty.title, st.big, ty.center]} numberOfLines={1}>
          {n.title}
        </Text>
      </Show>
      <Show on={beat >= 4} calm={calm} style={st.gapS}>
        <Text style={[ty.line, ty.center]} numberOfLines={2}>
          {n.line}
        </Text>
      </Show>
    </View>
  );
}

// ---------- the streak ----------
function Streak({beat, calm, s, k, w, h}: Base & {s: Story; k: NonNullable<Story['streak']>; w: number; h: number}) {
  const skyH = clamp(h - 240, 150, 230);
  const sky = s.sky;
  const con = useMemo(() => {
    const top = Math.max(1, ...sky.con.map(c => (sky.stars[c.i] ? sky.stars[c.i].m : 0) || 0));
    const points = sky.con.map((c, i) => {
      const m = Math.sqrt(Math.max(0, (sky.stars[c.i] ? sky.stars[c.i].m : 0) || 0) / top);
      // the longest night of the run is the biggest star — in white: gold is not for a streak
      return {x: c.x * w, y: c.y * skyH, r: (2.6 + m * 2.2) * (i === sky.brightest ? 1.4 : 1)};
    });
    const lines: [number, number][] = points.slice(1).map((_, i) => [i, i + 1]);
    return {points, lines};
  }, [sky, w, skyH]);
  const step = Math.min(70, Math.round(1800 / Math.max(1, con.points.length)));
  return (
    <View style={st.page} testID="wrapped.chapter.streak">
      <Eyebrow>Your longest streak</Eyebrow>
      <View style={[{width: w, height: skyH}, st.gapM]}>
        <NightSky sky={sky} width={w} height={skyH} calm={calm} dim ms={600} delay={0} />
        {beat >= 1 ? (
          <SkyLines points={con.points} lines={con.lines} width={w} height={skyH} step={step} calm={calm} style={st.over} />
        ) : null}
      </View>
      <Show on={beat >= 2} calm={calm} style={st.gapM}>
        <Text style={[ty.title, st.big, ty.center]} numberOfLines={1}>
          {k.title}
        </Text>
      </Show>
      <Show on={beat >= 3} calm={calm} style={st.gapS}>
        <Text style={[ty.line, ty.center]} numberOfLines={2}>
          {k.line}
        </Text>
      </Show>
    </View>
  );
}

// ---------- the longest sitting ----------
function Longest({beat, calm, l}: Base & {l: NonNullable<Story['longest']>}) {
  return (
    <View style={st.page} testID="wrapped.chapter.longest">
      <Eyebrow>Your longest sitting</Eyebrow>
      <View style={st.gapS}>
        <Odometer text={l.clock} size={96} color={PLAY.ink} ms={1000} delay={250} calm={calm} accessibilityLabel={`${l.clock} hours`} />
      </View>
      <Show on={beat >= 1} calm={calm}>
        <Text style={[ty.sub, ty.center]} numberOfLines={1}>
          hours, in one go
        </Text>
        {l.of ? (
          <Text style={[ty.line, ty.center, st.gapXS]} numberOfLines={2}>
            {l.of}
          </Text>
        ) : null}
      </Show>
      <Show on={beat >= 2} calm={calm} dy={0} style={st.gapL}>
        {/* (the ribbon's first value does not move: it starts empty and is told the length) */}
        <Meter value={beat >= 2 ? l.fill : 0} width={520} height={10} ms={900} calm={calm} />
        <View style={st.ticks}>
          {l.ticks.map(t => (
            <Text key={t} style={st.axisText}>
              {t}
            </Text>
          ))}
        </View>
      </Show>
      <Show on={beat >= 3} calm={calm} style={st.gapM}>
        <Text style={[ty.line, ty.center]} numberOfLines={2}>
          {l.quip}
        </Text>
      </Show>
    </View>
  );
}

// ---------- your type: the reward ----------
const ROLL_MS = 2000;
function Type({beat, calm, s}: Base & {s: Story}) {
  const t = s.type;
  const turned = beat >= 1;
  // the drum roll: the sealed card swells twice before it turns
  const roll = useShow(true, {ms: ROLL_MS, delay: 150, easing: LINEAR, calm});
  const points = useMemo(() => t.stars.map(([x, y]) => ({x, y, r: 3})), [t]);
  const SKY = 1.7;
  return (
    <View style={[st.page, st.across, {gap: TYPE_GAP}]} testID="wrapped.chapter.type">
      <Animated.View
        style={{
          width: CARD_W,
          height: CARD_H,
          transform: [{scale: roll.interpolate({inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [1, 1.035, 1, 1.035, 1]})}],
        }}>
        <Flip
          flipped={turned}
          width={CARD_W}
          height={CARD_H}
          calm={calm}
          front={
            <View style={st.card}>
              <Image source={BACK_SRC} fadeDuration={0} resizeMode="cover" style={st.cardImg} />
              <View style={st.seal}>
                <Text style={st.sealText} numberOfLines={1}>{`One of ${s.typeOf} types`}</Text>
              </View>
            </View>
          }
          back={
            <View style={st.card}>
              <Image source={FACE_SRC} fadeDuration={0} resizeMode="stretch" style={st.cardImg} />
              <Text style={st.faceNo} numberOfLines={1}>{`No. ${t.no} of ${s.typeOf}`}</Text>
              {turned ? (
                <SkyLines
                  points={points}
                  lines={t.lines}
                  width={100}
                  height={100}
                  scale={SKY}
                  delay={380}
                  calm={calm}
                  color={`hsl(${t.hue}, 85%, 86%)`}
                  style={[st.faceSky, {left: (CARD_W - 100 * SKY) / 2}]}
                />
              ) : null}
              <Text style={st.faceName} numberOfLines={2}>
                {t.name}
              </Text>
              <View style={[st.edge, st.edgeGold, st.edgeThin]} pointerEvents="none" />
            </View>
          }
        />
      </Animated.View>
      <View style={{width: TYPE_COL}}>
        <Eyebrow>Your viewer type</Eyebrow>
        <Text style={[ty.line, st.gapS]} numberOfLines={2}>
          Based on everything you watched, you are…
        </Text>
        <Show on={beat >= 2} calm={calm} scaleFrom={0.9} spring ms={420} style={st.gapS}>
          <Text style={st.typeName} numberOfLines={2}>
            {t.name}
          </Text>
        </Show>
        <Show on={beat >= 3} calm={calm} style={[st.row, st.gapM, st.left]}>
          <Chip label={t.because} />
        </Show>
        <Show on={beat >= 4} calm={calm} style={st.gapM}>
          <Text style={st.verdict} numberOfLines={4}>{`“${t.verdict}”`}</Text>
        </Show>
      </View>
    </View>
  );
}

// ---------- the lines ----------
const ACCENTS = [PLAY.rose, PLAY.violet, PLAY.teal, PLAY.green];
function Roasts({beat, calm, r}: Base & {r: Story['roasts']}) {
  return (
    <View style={st.page} testID="wrapped.chapter.roasts">
      <Eyebrow>{r.eyebrow}</Eyebrow>
      <Text style={[ty.title, ty.center, st.gapS]} numberOfLines={2}>
        {r.header}
      </Text>
      <View style={[st.notes, st.gapM]}>
        {r.lines.map((line, i) => (
          <Show key={i} on={beat >= i + 1} calm={calm} scaleFrom={1.06} ms={360} style={st.note}>
            <View style={[st.noteBar, {backgroundColor: ACCENTS[i % ACCENTS.length]}]} />
            <Text style={st.noteText} numberOfLines={3}>
              {line}
            </Text>
          </Show>
        ))}
      </View>
    </View>
  );
}

// ---------- the finale ----------
function Finale({s, keys}: {s: Story; keys?: React.ReactNode}) {
  return (
    <View style={st.page} testID="wrapped.chapter.finale">
      <Eyebrow>That's a wrap</Eyebrow>
      <View style={[st.summary, st.gapM]}>
        <View style={st.stats}>
          {s.finale.stats.map((x, i) => (
            <View key={x.label} style={[st.stat, i > 0 && st.statNext]}>
              <Text style={st.statValue} numberOfLines={1}>
                {x.value}
              </Text>
              <Text style={st.statLabel} numberOfLines={1}>
                {x.label}
              </Text>
            </View>
          ))}
        </View>
        <View style={st.rule} />
        <Text style={ty.small} numberOfLines={1}>
          Your viewer type
        </Text>
        <View style={[st.row, st.gapXS]}>
          <Star size={22} color={PLAY.gold} />
          <Text style={st.finalType} numberOfLines={1}>
            {s.type.name}
          </Text>
        </View>
      </View>
      <View style={[st.row, st.keys]}>{keys}</View>
    </View>
  );
}

// One chapter of the story. `width` / `height`: the box it stands in.
export default function ChapterView({
  chapter,
  beat,
  calm,
  story: s,
  width: w,
  height: h,
  keys,
}: {
  chapter: Chapter;
  beat: number;
  calm: boolean;
  story: Story;
  width: number;
  height: number;
  keys?: React.ReactNode; // the finale's two keys (they are the screen's)
}) {
  switch (chapter) {
    case 'opening':
      return <Opening beat={beat} calm={calm} s={s} w={w} h={h} />;
    case 'hours':
      return <Hours beat={beat} calm={calm} s={s} />;
    case 'top':
      return s.top ? <Top beat={beat} calm={calm} t={s.top} /> : null;
    case 'podium':
      return s.podium ? <Podium beat={beat} calm={calm} p={s.podium} /> : null;
    case 'genres':
      return s.genres ? <Genres beat={beat} calm={calm} g={s.genres} /> : null;
    case 'night':
      return s.night ? <Night beat={beat} calm={calm} n={s.night} /> : null;
    case 'streak':
      return s.streak ? <Streak beat={beat} calm={calm} s={s} k={s.streak} w={w} h={h} /> : null;
    case 'longest':
      return s.longest ? <Longest beat={beat} calm={calm} l={s.longest} /> : null;
    case 'type':
      return <Type beat={beat} calm={calm} s={s} />;
    case 'roasts':
      return <Roasts beat={beat} calm={calm} r={s.roasts} />;
    default:
      return <Finale s={s} keys={keys} />;
  }
}

const st = StyleSheet.create({
  page: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  across: {flexDirection: 'row', gap: 48},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10},
  left: {justifyContent: 'flex-start'},
  fill: {flex: 1},
  over: {position: 'absolute', left: 0, top: 0},
  gapXS: {marginTop: 4},
  gapS: {marginTop: 8},
  gapM: {marginTop: 16},
  gapL: {marginTop: 22},
  big: {fontSize: 38, lineHeight: 46},
  gold: {color: PLAY.gold},
  green: {color: PLAY.green},

  hoursBox: {height: 124, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', marginTop: 6},
  hoursGlow: {position: 'absolute'},

  topGlow: {position: 'absolute', left: -110, top: -60, width: 420, height: 420, tintColor: PLAY.gold},
  sideCol: {width: 440},
  // an edge over a picture: the picture keeps its whole box
  edge: {position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 18, borderWidth: 3},
  edgeGold: {borderColor: PLAY.gold},
  edgeSmall: {borderRadius: 12, borderWidth: 2},
  edgeThin: {borderWidth: 2},
  medal: {
    position: 'absolute',
    left: 12,
    top: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PLAY.gold,
    borderWidth: 2,
    borderColor: PLAY.goldHi,
  },
  medalText: {color: PLAY.goldInk, fontSize: 24, lineHeight: 30, fontWeight: '900', includeFontPadding: false},

  podium: {flexDirection: 'row', alignItems: 'flex-end', gap: 36},
  steps: {flexDirection: 'row', alignItems: 'flex-end', gap: 10},
  stepCol: {width: 196, alignItems: 'center'},
  stepPoster: {marginBottom: 8},
  step: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingTop: 10,
    paddingHorizontal: 12,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    backgroundColor: PLAY.tile,
    borderWidth: 1,
    borderColor: PLAY.line,
  },
  stepFirst: {backgroundColor: PLAY.tileHi},
  stepNo: {color: PLAY.inkDim, fontSize: 30, lineHeight: 36, fontWeight: '900', includeFontPadding: false},
  stepTitle: {color: PLAY.ink, fontSize: 16, lineHeight: 20, fontWeight: '800'},
  rest: {width: 220, paddingBottom: 8},
  restRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 14},
  restNo: {color: PLAY.inkFaint, fontSize: 24, lineHeight: 28, fontWeight: '900', width: 18, includeFontPadding: false},
  restTitle: {color: PLAY.ink, fontSize: 17, lineHeight: 22, fontWeight: '800'},

  bars: {gap: 14},
  barRow: {flexDirection: 'row', alignItems: 'center', gap: 16},
  barName: {width: 170, color: PLAY.inkDim, fontSize: 20, lineHeight: 26, fontWeight: '800', textAlign: 'right'},
  barNameWin: {color: PLAY.ink},
  barPct: {width: 64},
  barPctText: {color: PLAY.inkDim, fontSize: 18, lineHeight: 26, fontWeight: '800', fontVariant: ['tabular-nums']},

  charts: {flexDirection: 'row', alignItems: 'flex-start', gap: 40},
  axis: {height: 20, marginTop: 6},
  axisText: {color: PLAY.inkFaint, fontSize: 14, lineHeight: 20, fontWeight: '700', includeFontPadding: false},
  axisAt: {position: 'absolute', top: 0},
  dayLetter: {width: DAY_W, textAlign: 'center'},

  ticks: {width: 520, flexDirection: 'row', justifyContent: 'space-between', marginTop: 8},

  card: {width: CARD_W, height: CARD_H, borderRadius: 18, overflow: 'hidden', backgroundColor: PLAY.tile},
  cardImg: {width: CARD_W, height: CARD_H},
  seal: {
    position: 'absolute',
    bottom: 22,
    alignSelf: 'center',
    paddingVertical: 5,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(3,4,12,0.62)',
    borderWidth: 1,
    borderColor: PLAY.line,
  },
  sealText: {color: PLAY.ink, fontSize: 14, lineHeight: 20, fontWeight: '800', letterSpacing: 0.6, includeFontPadding: false},
  faceNo: {
    position: 'absolute',
    top: 18,
    left: 0,
    right: 0,
    textAlign: 'center',
    color: PLAY.goldHi,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '800',
    letterSpacing: 1.6,
    includeFontPadding: false,
  },
  faceSky: {position: 'absolute', top: 58},
  faceName: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 22,
    textAlign: 'center',
    color: PLAY.ink,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '900',
  },
  typeName: {color: PLAY.gold, fontSize: 40, lineHeight: 47, fontWeight: '900'},
  verdict: {color: PLAY.ink, fontSize: 22, lineHeight: 30, fontWeight: '600'},

  notes: {gap: 10},
  note: {
    width: 780,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 16,
    backgroundColor: PLAY.pill,
    borderWidth: 1,
    borderColor: PLAY.line,
  },
  noteBar: {width: 4, borderRadius: 2},
  noteText: {flex: 1, color: PLAY.ink, fontSize: 19, lineHeight: 27, fontWeight: '600'},

  summary: {
    width: 640,
    alignItems: 'center',
    paddingVertical: 22,
    paddingHorizontal: 24,
    borderRadius: 22,
    backgroundColor: PLAY.panel,
    borderWidth: 1,
    borderColor: PLAY.line,
  },
  stats: {flexDirection: 'row', alignSelf: 'stretch'},
  stat: {flex: 1, alignItems: 'center'},
  statNext: {borderLeftWidth: 1, borderLeftColor: PLAY.line},
  statValue: {color: PLAY.ink, fontSize: 44, lineHeight: 52, fontWeight: '900', fontVariant: ['tabular-nums'], includeFontPadding: false},
  statLabel: {color: PLAY.inkDim, fontSize: 15, lineHeight: 21, fontWeight: '700'},
  rule: {alignSelf: 'stretch', height: 1, backgroundColor: PLAY.line, marginVertical: 16},
  finalType: {color: PLAY.gold, fontSize: 28, lineHeight: 35, fontWeight: '900'},
  keys: {gap: 14, marginTop: 22},
});
