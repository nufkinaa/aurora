// Aurora Wrapped on the phone — the eleven chapters of the story, as the
// website tells them at a phone's size (public/js/screens/wrapped.js
// chapterBuilders): the same words, the same order of arrival, the same one
// reward (the meteor burst when the viewer type turns over). Each chapter is
// drawn at its place from the first frame and its pieces arrive by transform
// and opacity; `still` (calm, a screen reader) draws every finished state.
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Image, StyleSheet, Text, View} from 'react-native';
import Odometer from '../../play/Odometer';
import Meter from '../../play/Meter';
import {METEOR_SRC} from '../../play/Burst';
import {EASE, LINEAR, SPRING, tween, useTimers, useValue} from '../../play/anim';
import {GLOW_SRC} from '../../play/Star';
import {PLAY} from '../../play/tokens';
import {Chip, Eyebrow, In, Key, ty} from './ui';
import {CardBack, CARD_H, CARD_W, Dial, GenreBars, NightSky, Poster, TiltCard, TypeFront, useRun, WeekBars} from './WrappedParts';
import * as S from './storyWords';
import type {Chapter, Ctx} from './storyWords';

export type ChapterApi = {
  still: boolean;
  /** run `fn` `ms` after the chapter opened — held while the story is paused, dropped when it moves on */
  at: (ms: number, fn: () => void) => void;
  width: number;
  height: number; // the stage between the frame and the foot
  burst: (x: number, y: number, count?: number) => void; // in stage coordinates
  haptic: (kind?: 'tick' | 'confirm') => void;
  replay: () => void;
  closeStory: () => void;
  share: () => void;
  shareCard: React.ReactNode; // the finale's picture
};

const glowGold = (size: number, opacity = 0.32) => (
  <Image source={GLOW_SRC} fadeDuration={0} style={{position: 'absolute', width: size, height: size, tintColor: PLAY.gold, opacity}} />
);

// ---------- 1. Opening ----------
function Opening({c, api}: {c: Ctx; api: ChapterApi}) {
  const o = S.opening(c);
  const still = api.still;
  const m = useRun(1500, {delay: 500, still, easing: LINEAR});
  return (
    <View style={cs.center}>
      {still ? null : (
        <Animated.Image
          source={METEOR_SRC}
          fadeDuration={0}
          style={[
            cs.meteor,
            {
              opacity: m.interpolate({inputRange: [0, 0.15, 0.75, 1], outputRange: [0, 0.9, 0.6, 0]}),
              transform: [
                {translateX: m.interpolate({inputRange: [0, 1], outputRange: [-api.width * 0.2, api.width * 0.9]})},
                {translateY: m.interpolate({inputRange: [0, 1], outputRange: [-api.height * 0.42, -api.height * 0.08]})},
                {rotate: '24deg'},
                {scaleX: 1.6},
              ],
            },
          ]}
        />
      )}
      <In calm={still}>
        <Eyebrow star>{o.eyebrow}</Eyebrow>
      </In>
      <In calm={still} delay={140} style={cs.gapL}>
        <Text style={[ty.h1, cs.openTitle]}>
          <Text style={ty.gold}>{o.name}</Text>
          {'\n'}
          {o.title}
        </Text>
      </In>
      <In calm={still} delay={380} style={cs.gapM}>
        <Text style={ty.lede}>{o.line}</Text>
      </In>
      <In calm={still} delay={620} style={[cs.chips, cs.gapL]}>
        {o.chips.map(x => (
          <Chip key={x} label={x} />
        ))}
      </In>
      <In calm={still} fade delay={1600} style={cs.gapXL}>
        <Text style={cs.hint}>{o.hint.toUpperCase()}</Text>
      </In>
    </View>
  );
}

// ---------- 2. Hours ----------
function Hours({c, api}: {c: Ctx; api: ChapterApi}) {
  const h = S.hours(c);
  const still = api.still;
  const size = h.value.length > 4 ? 84 : 104;
  return (
    <View style={cs.center}>
      <In calm={still}>
        <Eyebrow>{h.eyebrow}</Eyebrow>
      </In>
      <In calm={still} pop delay={80} style={[cs.big, cs.gapM]}>
        {glowGold(300)}
        <Odometer text={h.value} size={size} ms={2300} delay={200} calm={still} accessibilityLabel={`${h.value} ${h.unit}`} />
      </In>
      <In calm={still} delay={1700}>
        <Text style={cs.unit}>{h.unit}</Text>
      </In>
      {h.lines.map((l, i) => (
        <In key={i} calm={still} delay={2300 + i * 650} style={cs.gapM}>
          <Text style={[ty.lede, i ? cs.second : null]}>{l}</Text>
        </In>
      ))}
    </View>
  );
}

// ---------- 3. Your number one: the deal ----------
function Top({c, api}: {c: Ctx; api: ChapterApi}) {
  const still = api.still;
  const t = S.top(c);
  const five = (c.w.topTitles || []).slice(0, 5);
  const order = S.handOrder(five);
  const win = five[0];
  const n = order.length;
  const cw = Math.min(128, Math.round(api.width * 0.32));
  const ch = Math.round(cw * 1.5);
  const T = useRun(3000, {delay: 200, still, easing: LINEAR});
  if (!t || !win) return null;
  return (
    <View style={cs.center}>
      <In calm={still}>
        <Eyebrow>{t.eyebrow}</Eyebrow>
      </In>
      <View style={[cs.fan, {width: api.width, height: ch + 60}]} importantForAccessibility="no-hide-descendants">
        <View style={[cs.fanGlow, {left: api.width / 2 - 150, top: (ch + 60) / 2 - 150}]}>{glowGold(300, 0.4)}</View>
        {order
          .map((it, k) => ({it, k}))
          .sort((a, b) => (a.it === win ? 1 : 0) - (b.it === win ? 1 : 0)) // the winner drawn last: on top
          .map(({it, k}) => {
            const off = k - (n - 1) / 2;
            const isWin = it === win;
            const s = k % 2 ? 1 : -1;
            const fanX = off * cw * 0.46;
            const outX = isWin ? 0 : off * cw * 0.62 + (off > 0 ? 18 : off < 0 ? -18 : 0);
            const steps = [0, 0.3, 0.42, 0.55, 0.6, 0.65, 0.7, 0.75, 0.88, 1];
            const x = [0, fanX, fanX, 0, s * 34, -s * 24, s * 16, 0, outX, outX];
            const y = [90, 0, 0, 0, 0, 0, 0, 0, isWin ? -6 : 14, isWin ? -6 : 14];
            const rot = [0, off * 9, off * 9, 0, s * 5, -s * 4, s * 2, 0, isWin ? 0 : off * 7, isWin ? 0 : off * 7];
            const sc = [0.6, 1, 1, 0.96, 0.96, 0.96, 0.96, 0.96, isWin ? 1.12 : 0.8, isWin ? 1.12 : 0.8];
            const op = [0, 1, 1, 1, 1, 1, 1, 1, isWin ? 1 : 0.5, isWin ? 1 : 0.5];
            // the face: up while dealt, down from the gather, the winner up again at the end
            const flipIn = [0, 0.42, 0.55, 0.76, 0.86, 1];
            const flipOut = [0, 0, 1, 1, isWin ? 0 : 1, isWin ? 0 : 1];
            const iv = (out: number[]) => (still ? out[out.length - 1] : T.interpolate({inputRange: steps, outputRange: out}));
            const flip = still ? flipOut[flipOut.length - 1] : T.interpolate({inputRange: flipIn, outputRange: flipOut});
            const faceTurn = (front: boolean) =>
              typeof flip === 'number'
                ? {opacity: (front ? flip < 0.5 : flip >= 0.5) ? 1 : 0}
                : {
                    opacity: flip.interpolate({inputRange: [0, 0.499, 0.5, 1], outputRange: front ? [1, 1, 0, 0] : [0, 0, 1, 1]}),
                    transform: [
                      {perspective: 800},
                      {rotateY: flip.interpolate({inputRange: [0, 0.5, 1], outputRange: front ? ['0deg', '90deg', '90deg'] : ['-90deg', '-90deg', '0deg']})},
                    ],
                  };
            return (
              <Animated.View
                key={`${it.name}-${k}`}
                style={{
                  position: 'absolute',
                  left: api.width / 2 - cw / 2,
                  top: 30,
                  width: cw,
                  height: ch,
                  opacity: iv(op) as never,
                  transform: [{translateX: iv(x) as never}, {translateY: iv(y) as never}, {rotate: (still ? `${rot[rot.length - 1]}deg` : T.interpolate({inputRange: steps, outputRange: rot.map(r => `${r}deg`)})) as never}, {scale: iv(sc) as never}],
                }}>
                <Animated.View style={[StyleSheet.absoluteFill, faceTurn(true) as never]}>
                  <Poster name={it.name} poster={it.poster} w={cw} h={ch} radius={16} gold={isWin} />
                </Animated.View>
                <Animated.View style={[StyleSheet.absoluteFill, faceTurn(false) as never]}>
                  <CardBack w={cw} h={ch} word={false} />
                </Animated.View>
              </Animated.View>
            );
          })}
      </View>
      <In calm={still} delay={3300} style={cs.gapS}>
        <Text style={[ty.h1, cs.topName]} numberOfLines={3}>
          {t.name}
        </Text>
      </In>
      <In calm={still} delay={3600} style={cs.gapS}>
        <Text style={ty.lede}>
          <Text style={[ty.gold, cs.bold]}>{t.hours}</Text>
          {t.rest}
        </Text>
      </In>
    </View>
  );
}

// ---------- 4. The podium ----------
function Podium({c, api}: {c: Ctx; api: ChapterApi}) {
  const p = S.podium(c);
  const still = api.still;
  // (a short phone: the pedestals and the posters come down with the height that is left)
  const k = Math.max(0.6, Math.min(1, api.height / 720));
  const colW = Math.min(118, Math.floor((api.width - 24) / 3));
  const pw = (rank: number) => Math.round((rank === 1 ? colW * 0.92 : colW * 0.8) * k);
  const blockH = (rank: number) => Math.round((rank === 1 ? 150 : rank === 2 ? 104 : 78) * k);
  const drop = (rank: number) => (rank === 1 ? 2100 : rank === 2 ? 1300 : 700);
  return (
    <View style={cs.center}>
      <In calm={still}>
        <Eyebrow>{p.eyebrow}</Eyebrow>
      </In>
      <View style={[cs.steps, cs.gapL]}>
        {p.places.map(pl => (
          <View key={pl.rank} style={[cs.step, {width: colW}]}>
            <In calm={still} drop delay={drop(pl.rank)} style={cs.stepTop}>
              {pl.rank === 1 ? <View style={cs.stepGlow}>{glowGold(220, 0.35)}</View> : null}
              <Poster name={pl.name} poster={pl.poster} w={pw(pl.rank)} h={Math.round(pw(pl.rank) * 1.5)} radius={12} gold={pl.rank === 1} />
              <Text style={cs.stepName} numberOfLines={2}>
                {pl.name}
              </Text>
              <Text style={[cs.stepH, pl.rank === 1 && ty.gold]}>{pl.hours}</Text>
            </In>
            <Grow calm={still} delay={pl.rank * 90} style={[cs.block, {height: blockH(pl.rank)}, pl.rank === 1 ? cs.blockGold : null]}>
              <Text style={[cs.blockNum, pl.rank === 1 && cs.blockNumGold]}>{pl.rank}</Text>
            </Grow>
          </View>
        ))}
      </View>
      {p.rest.length ? (
        <In calm={still} delay={2800} style={[cs.rest, cs.gapM]}>
          {p.rest.map(r => (
            <View key={r.rank} style={cs.restRow}>
              <Text style={cs.restRank}>{r.rank}</Text>
              <Text style={cs.restName} numberOfLines={1}>
                {r.name}
              </Text>
              <Text style={cs.restH}>{r.hours}</Text>
            </View>
          ))}
        </In>
      ) : null}
    </View>
  );
}

/** A pedestal that grows up from the floor. */
function Grow({children, calm, delay, style}: {children?: React.ReactNode; calm: boolean; delay: number; style?: object}) {
  const v = useRun(700, {delay, still: calm, easing: SPRING});
  return <Animated.View style={[style, {transformOrigin: '50% 100%', transform: [{scaleY: v.interpolate({inputRange: [0, 1], outputRange: [0.02, 1]})}]}]}>{children}</Animated.View>;
}

// ---------- 5. Genre DNA ----------
function Genres({c, api}: {c: Ctx; api: ChapterApi}) {
  const g = S.genres(c);
  const still = api.still;
  const t = useRun(2600, {delay: 400, still, easing: EASE});
  return (
    <View style={cs.center}>
      <In calm={still}>
        <Eyebrow>{g.eyebrow}</Eyebrow>
      </In>
      <In calm={still} delay={120} style={cs.gapM}>
        <Text style={ty.h1}>
          {'Mostly '}
          {g.first}
          {g.second ? <Text style={ty.soft}>{`, with a ${g.second} streak.`}</Text> : '.'}
        </Text>
      </In>
      <In calm={still} fade delay={300} style={[cs.gapL, cs.stretch]}>
        <GenreBars bars={g.bars} t={t} still={still} />
      </In>
    </View>
  );
}

// ---------- 6. Your night ----------
function Night({c, api}: {c: Ctx; api: ChapterApi}) {
  const nw = S.night(c);
  const still = api.still;
  const week = useRun(1200, {delay: 400, still});
  const spokes = useRun(1400, {delay: 1300, still, easing: LINEAR});
  const dial = Math.min(210, Math.round(api.height * 0.3));
  return (
    <View style={cs.center}>
      <In calm={still}>
        <Eyebrow>{nw.eyebrow}</Eyebrow>
      </In>
      <In calm={still} delay={120} style={cs.gapM}>
        <Text style={ty.h1}>
          {nw.day}
          <Text style={ty.gold}>{nw.hour}</Text>
        </Text>
      </In>
      <In calm={still} fade delay={350} style={[cs.gapL, cs.stretch]}>
        <WeekBars w={c.w} height={Math.min(104, Math.round(api.height * 0.14))} t={week} still={still} />
      </In>
      <In calm={still} pop delay={1100} style={cs.gapL}>
        <Dial w={c.w} size={dial} t={spokes} still={still} />
      </In>
      <In calm={still} delay={2600} style={cs.gapL}>
        <Text style={ty.lede}>{nw.line}</Text>
      </In>
    </View>
  );
}

// ---------- 7. The streak ----------
function Streak({c, api}: {c: Ctx; api: ChapterApi}) {
  const sk = S.streak(c);
  const still = api.still;
  const t = useRun(3600, {delay: 500, still, easing: LINEAR});
  const skyW = api.width;
  const skyH = Math.max(200, Math.round(api.height * 0.56));
  return (
    <View style={[cs.center, {justifyContent: 'flex-start', paddingTop: 12}]}>
      <In calm={still}>
        <Eyebrow>{sk.eyebrow}</Eyebrow>
      </In>
      <In calm={still} delay={100} style={[cs.row, cs.gapM]}>
        <Odometer text={sk.count} size={35} ms={1600} delay={300} calm={still} />
        <Text style={[ty.h1, cs.inline]}>{sk.tail}</Text>
      </In>
      <In calm={still} delay={400} style={cs.gapS}>
        <Text style={ty.lede}>{sk.line}</Text>
      </In>
      <In calm={still} fade delay={200} style={cs.gapM}>
        <NightSky w={c.w} width={skyW} height={skyH} t={t} still={still} />
      </In>
    </View>
  );
}

// ---------- 8. The longest sitting ----------
function Longest({c, api}: {c: Ctx; api: ChapterApi}) {
  const l = S.longest(c);
  const still = api.still;
  const [fill, setFill] = useState(still ? (l ? l.fill : 0) : 0);
  const timers = useTimers();
  useEffect(() => {
    // (the ribbon fills as the chapter arrives, like its other pieces)
    if (!still && l) timers.after(600, () => setFill(l.fill));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!l) return null;
  const ribbonW = api.width;
  return (
    <View style={cs.center}>
      <In calm={still}>
        <Eyebrow>{l.eyebrow}</Eyebrow>
      </In>
      <View style={[cs.longRow, cs.gapL]}>
        {l.poster ? (
          <In calm={still} pop delay={200}>
            <Poster name={l.poster.name} poster={l.poster.poster} w={84} h={126} radius={12} />
          </In>
        ) : null}
        <View style={cs.longText}>
          <In calm={still} delay={60} style={cs.big}>
            {glowGold(220, 0.28)}
            <Odometer text={l.clock} size={76} ms={2000} delay={150} calm={still} accessibilityLabel={`${l.clock} ${l.unit}`} />
          </In>
          <In calm={still} delay={900}>
            <Text style={cs.unitL}>{l.unit}</Text>
          </In>
          <In calm={still} delay={1200}>
            <Text style={[ty.lede, cs.left]}>
              {'of '}
              <Text style={[cs.bold, {color: PLAY.ink}]}>{`“${l.title}”`}</Text>
              {'.'}
            </Text>
          </In>
        </View>
      </View>
      <In calm={still} fade delay={500} style={cs.gapL}>
        <Meter value={fill} width={ribbonW} height={12} ms={1400} calm={still} />
        <View style={[cs.ticks, {width: ribbonW}]}>
          {l.ticks.map((x, i) => (
            <Text key={x} style={[cs.tick, {left: (i / (l.ticks.length - 1)) * (ribbonW - 22)}]}>
              {x}
            </Text>
          ))}
        </View>
      </In>
      <In calm={still} delay={2600} style={cs.gapXL}>
        <Text style={cs.quip}>{l.quip}</Text>
      </In>
    </View>
  );
}

// ---------- 9. Your viewer type: the reveal ----------
function Type({c, api}: {c: Ctx; api: ChapterApi}) {
  const still = api.still;
  const tw = S.typeWords(c);
  const w = Math.min(CARD_W, Math.round(api.width * 0.62), Math.round(api.height * 0.46 * (CARD_W / CARD_H)));
  const h = Math.round(w * (CARD_H / CARD_W));
  const [shown, setShown] = useState(still);
  const roll = useRun(2350, {delay: 0, still, easing: LINEAR}); // the shimmer and the wobble
  const flip = useValue(still ? 1 : 0);
  const cardY = useRef(0);
  useEffect(() => {
    if (still) return;
    api.at(2350, () => {
      setShown(true);
      tween(flip, 1, 620, {easing: EASE}).start();
      api.haptic('confirm');
      api.burst(api.width / 2, cardY.current || api.height * 0.42, 16);
    });
    // (once, when the chapter opens)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const front = {
    opacity: flip.interpolate({inputRange: [0, 0.499, 0.5, 1], outputRange: [0, 0, 1, 1]}),
    transform: [{perspective: 900}, {rotateY: flip.interpolate({inputRange: [0, 0.5, 1], outputRange: ['-90deg', '-90deg', '0deg']})}],
  };
  const back = {
    opacity: flip.interpolate({inputRange: [0, 0.499, 0.5, 1], outputRange: [1, 1, 0, 0]}),
    transform: [
      {perspective: 900},
      {rotateY: flip.interpolate({inputRange: [0, 0.5, 1], outputRange: ['0deg', '90deg', '90deg']})},
      // the drum-roll: a wobble at the end of the wait
      {rotate: roll.interpolate({inputRange: [0, 0.72, 0.78, 0.84, 0.9, 0.95, 1], outputRange: ['0deg', '0deg', '-4deg', '4deg', '-3deg', '2deg', '0deg']})},
    ],
  };
  const shimmer = (a: number, b: number) => ({
    transform: [{translateX: roll.interpolate({inputRange: [a, b], outputRange: [-w * 1.2, w * 1.2], extrapolate: 'clamp'})}, {rotate: '18deg'}],
  });
  return (
    <View style={cs.center}>
      <In calm={still}>
        <Eyebrow>{tw.eyebrow}</Eyebrow>
      </In>
      <In calm={still} delay={150} style={cs.gapS}>
        <Text style={[cs.pre]}>{tw.pre}</Text>
      </In>
      <View
        style={[cs.typeStage, {width: w, height: h}, cs.gapL]}
        onLayout={e => {
          cardY.current = e.nativeEvent.layout.y + h / 2;
        }}
        importantForAccessibility="no-hide-descendants">
        <View style={cs.typeGlow}>{glowGold(Math.round(w * 1.9), shown ? 0.32 : 0.14)}</View>
        <Animated.View style={[StyleSheet.absoluteFill, front]}>
          <TiltCard w={w} h={h} still={!shown}>
            <TypeFront type={c.type} name={c.name} since={c.w.since} w={w} />
          </TiltCard>
        </Animated.View>
        {still ? null : (
          <Animated.View style={[StyleSheet.absoluteFill, back]} pointerEvents="none">
            <CardBack w={w} h={h} radius={18} />
            <View style={[StyleSheet.absoluteFill, {borderRadius: 18, overflow: 'hidden'}]}>
              <Animated.View style={[cs.shimmer, {height: h * 1.4, top: -h * 0.2}, shimmer(0.08, 0.36)]} />
              <Animated.View style={[cs.shimmer, {height: h * 1.4, top: -h * 0.2}, shimmer(0.4, 0.68)]} />
            </View>
          </Animated.View>
        )}
      </View>
      <Text style={cs.sr} accessibilityLiveRegion="polite">
        {shown ? `${c.type.name}. ${c.type.verdict}` : ''}
      </Text>
      <In calm={still} delay={2750} style={cs.gapL}>
        <Text style={[ty.h2, cs.verdict]}>{`“${c.type.verdict}”`}</Text>
      </In>
    </View>
  );
}

// ---------- 10. The intervention: one line at a time ----------
function Roasts({c, api}: {c: Ctx; api: ChapterApi}) {
  const r = S.roasts(c);
  const still = api.still;
  const [dealt, setDealt] = useState(still ? r.lines.length : 0);
  useEffect(() => {
    if (still) return;
    r.lines.forEach((_, k) =>
      api.at(1300 + k * 2700, () => {
        setDealt(k + 1);
        api.haptic('tick');
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View style={[cs.center, {justifyContent: 'flex-start', paddingTop: api.height * 0.06}]}>
      <In calm={still}>
        <Eyebrow>{r.eyebrow}</Eyebrow>
      </In>
      <In calm={still} delay={120} style={cs.gapM}>
        <Text style={ty.h1}>{r.header}</Text>
      </In>
      {still ? (
        <View style={[cs.roastList, cs.gapL]}>
          {r.lines.map((line, i) => (
            <RoastCard key={i} line={line} n={i + 1} of={r.lines.length} />
          ))}
        </View>
      ) : (
        <View style={[cs.pile, cs.gapL, {height: Math.min(api.height * 0.62, 400)}]}>
          {r.lines.map((line, i) =>
            i < dealt ? <PiledRoast key={i} line={line} n={i + 1} of={r.lines.length} depth={Math.min(3, dealt - 1 - i)} /> : null,
          )}
        </View>
      )}
    </View>
  );
}

function RoastCard({line, n, of}: {line: string; n: number; of: number}) {
  return (
    <View style={cs.roast}>
      <Text style={cs.roastQ}>“</Text>
      <Text style={cs.roastText}>{line}</Text>
      <Text style={cs.roastN}>{`${n}/${of}`}</Text>
    </View>
  );
}

/** A line slammed onto the pile; the earlier ones pushed back (depth 0 = on top). */
function PiledRoast({line, n, of, depth}: {line: string; n: number; of: number; depth: number}) {
  const slam = useRun(420, {easing: SPRING});
  const d = useValue(depth);
  useEffect(() => {
    tween(d, depth, 360, {easing: EASE}).start();
  }, [depth, d]);
  return (
    <Animated.View
      importantForAccessibility={depth ? 'no-hide-descendants' : 'auto'}
      style={[
        cs.piled,
        {
          zIndex: 10 - depth,
          opacity: Animated.multiply(slam.interpolate({inputRange: [0, 0.3, 1], outputRange: [0, 1, 1]}), d.interpolate({inputRange: [0, 1, 2, 3], outputRange: [1, 0.55, 0.3, 0]})),
          transform: [
            {translateY: d.interpolate({inputRange: [0, 3], outputRange: [0, -36]})},
            {scale: Animated.multiply(slam.interpolate({inputRange: [0, 1], outputRange: [1.16, 1]}), d.interpolate({inputRange: [0, 3], outputRange: [1, 0.88]}))},
            {rotate: slam.interpolate({inputRange: [0, 1], outputRange: [`${n % 2 ? -3 : 3}deg`, '0deg']})},
          ],
        },
      ]}>
      <RoastCard line={line} n={n} of={of} />
    </Animated.View>
  );
}

// ---------- 11. The finale ----------
function Finale({api}: {c: Ctx; api: ChapterApi}) {
  const still = api.still;
  return (
    <View style={[cs.center, {justifyContent: 'flex-start', paddingTop: 4}]}>
      <In calm={still} pop delay={150}>
        {api.shareCard}
      </In>
      <In calm={still} delay={300} style={cs.gapL}>
        <Eyebrow>{S.FINALE.eyebrow}</Eyebrow>
      </In>
      <In calm={still} delay={400} style={cs.gapS}>
        <Text style={ty.h2}>
          {S.FINALE.title}
          <Text style={ty.gold}>{S.FINALE.gold}</Text>
        </Text>
      </In>
      <In calm={still} delay={650} style={[cs.actions, cs.gapL]}>
        <Key uiId="wrapped.share" kind="gold" label={S.FINALE.share} onPress={api.share} calm={still} />
        <Key uiId="wrapped.replay" label={S.FINALE.replay} onPress={api.replay} calm={still} />
      </In>
      <In calm={still} delay={700}>
        <Key uiId="wrapped.all" kind="quiet" small label={S.FINALE.all} onPress={api.closeStory} calm={still} />
      </In>
    </View>
  );
}

export default function ChapterView({id, c, api}: {id: Chapter; c: Ctx; api: ChapterApi}) {
  switch (id) {
    case 'opening':
      return <Opening c={c} api={api} />;
    case 'hours':
      return <Hours c={c} api={api} />;
    case 'top':
      return <Top c={c} api={api} />;
    case 'podium':
      return <Podium c={c} api={api} />;
    case 'genres':
      return <Genres c={c} api={api} />;
    case 'night':
      return <Night c={c} api={api} />;
    case 'streak':
      return <Streak c={c} api={api} />;
    case 'longest':
      return <Longest c={c} api={api} />;
    case 'type':
      return <Type c={c} api={api} />;
    case 'roasts':
      return <Roasts c={c} api={api} />;
    default:
      return <Finale c={c} api={api} />;
  }
}

export const cs = StyleSheet.create({
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  stretch: {alignSelf: 'stretch'},
  row: {flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center'},
  inline: {textAlign: 'left', marginBottom: 3},
  gapS: {marginTop: 8},
  gapM: {marginTop: 14},
  gapL: {marginTop: 22},
  gapXL: {marginTop: 34},
  bold: {fontWeight: '800'},
  left: {textAlign: 'left'},
  openTitle: {fontSize: 38, lineHeight: 41},
  meteor: {position: 'absolute', left: 0, top: '50%', width: 128, height: 16, tintColor: '#ffffff'},
  hint: {color: 'rgba(232,228,255,0.5)', fontSize: 12, fontWeight: '800', letterSpacing: 2.2},
  chips: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8},
  big: {alignItems: 'center', justifyContent: 'center'},
  unit: {color: PLAY.ink, fontSize: 24, fontWeight: '900', letterSpacing: -0.4, marginTop: 2},
  unitL: {color: PLAY.ink, fontSize: 19, fontWeight: '900', letterSpacing: -0.3},
  second: {color: 'rgba(232,228,255,0.6)'},
  fan: {marginTop: 10},
  fanGlow: {position: 'absolute', width: 300, height: 300, alignItems: 'center', justifyContent: 'center'},
  topName: {fontSize: 32, lineHeight: 35},
  steps: {flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 6},
  step: {alignItems: 'center'},
  stepTop: {alignItems: 'center', marginBottom: 8},
  stepGlow: {position: 'absolute', top: -40, alignItems: 'center', justifyContent: 'center', width: 220, height: 220},
  stepName: {color: PLAY.ink, fontSize: 13.5, fontWeight: '800', textAlign: 'center', marginTop: 8, lineHeight: 17},
  stepH: {color: 'rgba(232,228,255,0.62)', fontSize: 12.5, fontWeight: '800', marginTop: 2},
  block: {
    alignSelf: 'stretch',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    alignItems: 'center',
    paddingTop: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
    experimental_backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.03) 100%)',
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  blockGold: {experimental_backgroundImage: 'linear-gradient(180deg, rgba(255,209,102,0.55) 0%, rgba(240,162,58,0.12) 100%)', borderColor: 'rgba(255,209,102,0.5)'},
  blockNum: {color: 'rgba(232,228,255,0.8)', fontSize: 28, fontWeight: '900'},
  blockNumGold: {color: PLAY.goldHi},
  rest: {alignSelf: 'stretch', gap: 8},
  restRow: {flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 11, paddingHorizontal: 16, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)'},
  restRank: {color: 'rgba(232,228,255,0.62)', fontSize: 15, fontWeight: '900', width: 14},
  restName: {flex: 1, color: PLAY.ink, fontSize: 15, fontWeight: '800'},
  restH: {color: 'rgba(232,228,255,0.62)', fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums']},
  longRow: {flexDirection: 'row', alignItems: 'center', gap: 16},
  longText: {flexShrink: 1, alignItems: 'flex-start'},
  ticks: {height: 18, marginTop: 6},
  tick: {position: 'absolute', top: 0, width: 22, textAlign: 'center', color: 'rgba(232,228,255,0.55)', fontSize: 11.5, fontWeight: '800'},
  quip: {color: PLAY.gold, fontSize: 17.5, fontWeight: '900', textAlign: 'center'},
  pre: {color: 'rgba(232,228,255,0.62)', fontSize: 17, fontWeight: '800', textAlign: 'center', lineHeight: 23},
  typeStage: {alignItems: 'center', justifyContent: 'center'},
  typeGlow: {position: 'absolute', alignItems: 'center', justifyContent: 'center', width: 1, height: 1, left: '50%', top: '50%'},
  shimmer: {position: 'absolute', width: 70, left: 0, experimental_backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,242,194,0.32) 50%, rgba(255,255,255,0) 100%)'},
  verdict: {fontSize: 23, lineHeight: 27},
  sr: {position: 'absolute', width: 1, height: 1, opacity: 0},
  roastList: {alignSelf: 'stretch', gap: 12},
  pile: {alignSelf: 'stretch', paddingTop: 40},
  piled: {position: 'absolute', left: 0, right: 0, top: 40},
  roast: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 18,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
    backgroundColor: '#17152f',
    experimental_backgroundImage: 'linear-gradient(180deg, #221f42 0%, #141229 100%)',
  },
  roastQ: {color: PLAY.gold, fontSize: 34, lineHeight: 34, fontWeight: '900', marginTop: -2},
  roastText: {flex: 1, color: PLAY.ink, fontSize: 17, lineHeight: 23, fontWeight: '800'},
  roastN: {color: 'rgba(232,228,255,0.5)', fontSize: 11.5, fontWeight: '800', marginTop: 3},
  actions: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12},
});
