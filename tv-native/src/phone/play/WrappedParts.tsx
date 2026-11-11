// Aurora Wrapped on the phone — the pieces the chapters and the page are drawn
// with (the website's posterArt, typeCard, weekBars, dial, genreBars and the
// sky of nights, public/js/screens/wrapped.js). Motion: one Animated value per
// piece, on the native driver, its parts each in their own window of it;
// `still` shows the finished state.
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, Image, LayoutChangeEvent, PanResponder, StyleSheet, Text, View} from 'react-native';
import Svg, {Circle, Line} from 'react-native-svg';
import {artSrc} from '../ui/Cards';
import {EASE, LINEAR, SPRING, tween, useValue} from '../../play/anim';
import {GLOW_SRC, Star, STAR_SRC} from '../../play/Star';
import {PLAY} from '../../play/tokens';
import {lineBox} from '../../play/constellation';
import {AURORA, GOLDFILL} from './ui';
import {dayAfter, fmtH, hashHue, hourLabel, shortDay, sinceMonth, ViewerType} from './storyWords';
import type {PhoneWrapped} from './storyWords';
import {skyLayout} from '../../play/wrappedRules';

// ---------- a title's picture, or a drawn stand-in with its name ----------
export function Poster({name, poster, w, h, radius = 14, gold, style}: {name: string; poster?: string | null; w: number; h: number; radius?: number; gold?: boolean; style?: object}) {
  const {src} = artSrc(poster || null, w);
  const [failed, setFailed] = useState(false);
  const hue = hashHue(name);
  return (
    <View style={[{width: w, height: h, borderRadius: radius, overflow: 'hidden', backgroundColor: PLAY.tile}, gold && pp.gold, style]}>
      {src && !failed ? (
        <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} onError={() => setFailed(true)} />
      ) : (
        <View style={[StyleSheet.absoluteFill, pp.drawn, {experimental_backgroundImage: `linear-gradient(160deg, hsl(${hue}, 60%, 34%) 0%, hsl(${(hue + 60) % 360}, 70%, 14%) 100%)`}]}>
          <Text style={[pp.drawnName, {fontSize: Math.max(11, Math.min(18, w / 7))}]} numberOfLines={4}>
            {name}
          </Text>
        </View>
      )}
    </View>
  );
}

// ---------- the card back (the reel, the fan, the collectible's back) ----------
export function CardBack({w, h, q, word = true, radius = 16}: {w: number; h: number; q?: boolean; word?: boolean; radius?: number}) {
  const ring = Math.round(Math.min(w, h) * 0.34);
  return (
    <View style={[pp.back, {width: w, height: h, borderRadius: radius}]}>
      <View style={[pp.backRing, {width: ring, height: ring, borderRadius: ring / 2}]}>
        <Star size={Math.round(ring * 0.42)} color={PLAY.gold} />
      </View>
      {word ? <Text style={[pp.backWord, {fontSize: Math.max(8, Math.round(w * 0.045))}]}>AURORA WRAPPED</Text> : null}
      {q ? <Text style={[pp.backQ, {fontSize: Math.round(w * 0.13)}]}>?</Text> : null}
    </View>
  );
}

// ---------- a viewer type's own constellation ----------
export function Glyph({type, size, color = '#ffffff', line = 'rgba(255,255,255,0.65)'}: {type: Pick<ViewerType, 'stars' | 'lines'>; size: number; color?: string; line?: string}) {
  const k = size / 100;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      {type.lines.map(([a, b], i) => (
        <Line key={`l${i}`} x1={type.stars[a][0]} y1={type.stars[a][1]} x2={type.stars[b][0]} y2={type.stars[b][1]} stroke={line} strokeWidth={1.6 / Math.max(0.6, k)} strokeLinecap="round" />
      ))}
      {type.stars.map(([x, y], i) => (
        <Circle key={`s${i}`} cx={x} cy={y} r={i === 0 ? 3.4 : 2.4} fill={color} />
      ))}
    </Svg>
  );
}

// ---------- the collectible (the viewer type) ----------
export const CARD_W = 220;
export const CARD_H = 318;

export function TypeFront({type, name, since, w = CARD_W}: {type: ViewerType; name: string; since: PhoneWrapped['since']; w?: number}) {
  const k = w / CARD_W;
  const h = Math.round(CARD_H * k);
  return (
    <View style={[pp.front, {width: w, height: h, borderRadius: 18 * k}]}>
      <View style={[pp.frontIn, {borderRadius: 14 * k, padding: 10 * k, experimental_backgroundImage: `linear-gradient(165deg, hsl(${type.hue}, 50%, 24%) 0%, #120e34 62%, #0a0b1e 100%)`}]}>
        <View style={pp.frontTop}>
          <Text style={[pp.frontTiny, {fontSize: 9.5 * k}]}>{`NO. ${String(type.no).padStart(2, '0')}`}</Text>
          <Text style={[pp.frontTiny, {fontSize: 9.5 * k}]}>AURORA WRAPPED</Text>
        </View>
        <View style={[pp.art, {height: 132 * k, borderRadius: 12 * k, experimental_backgroundImage: `radial-gradient(circle at 50% 40%, hsla(${type.hue}, 80%, 62%, 0.55) 0%, hsla(${(type.hue + 40) % 360}, 70%, 30%, 0.35) 45%, rgba(8,10,29,0.2) 100%)`}]}>
          <Glyph type={type} size={Math.round(108 * k)} />
        </View>
        <Text style={[pp.frontName, {fontSize: 22 * k, lineHeight: 25 * k}]} numberOfLines={2}>
          {type.name}
        </Text>
        {type.because ? (
          <Text style={[pp.frontBecause, {fontSize: 11.5 * k}]} numberOfLines={1}>
            {type.because}
          </Text>
        ) : null}
        <View style={{flex: 1}} />
        <View style={pp.frontFoot}>
          <Text style={[pp.frontFootText, {fontSize: 9.5 * k}]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={[pp.frontFootText, {fontSize: 9.5 * k}]}>{sinceMonth(since)}</Text>
        </View>
      </View>
    </View>
  );
}

/** The collectible, face up, that tilts under the finger with its foil catching the light. */
export function TiltCard({children, w, h, still}: {children: React.ReactNode; w: number; h: number; still?: boolean}) {
  const rx = useValue(0);
  const ry = useValue(0);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => true,
        onPanResponderMove: (e, g) => {
          const x = Math.max(-1, Math.min(1, g.dx / (w * 0.6)));
          const y = Math.max(-1, Math.min(1, g.dy / (h * 0.6)));
          ry.setValue(x);
          rx.setValue(-y);
        },
        onPanResponderRelease: () => {
          Animated.parallel([tween(rx, 0, 520, {easing: SPRING}), tween(ry, 0, 520, {easing: SPRING})]).start();
        },
        onPanResponderTerminate: () => {
          rx.setValue(0);
          ry.setValue(0);
        },
      }),
    [rx, ry, w, h],
  );
  return (
    <Animated.View
      {...(still ? {} : responder.panHandlers)}
      style={{
        width: w,
        height: h,
        transform: [
          {perspective: 800},
          {rotateX: rx.interpolate({inputRange: [-1, 1], outputRange: ['-12deg', '12deg']})},
          {rotateY: ry.interpolate({inputRange: [-1, 1], outputRange: ['-14deg', '14deg']})},
        ],
      }}>
      {children}
      {/* the foil: a band of light that slides with the tilt */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, {borderRadius: 18, overflow: 'hidden'}]}>
        <Animated.View
          style={[
            pp.foil,
            {
              width: w * 1.6,
              height: h * 1.4,
              left: -w * 0.3,
              top: -h * 0.2,
              transform: [{translateX: ry.interpolate({inputRange: [-1, 1], outputRange: [-w * 0.55, w * 0.55]})}, {rotate: '18deg'}],
            },
          ]}
        />
      </View>
    </Animated.View>
  );
}

// ---------- the week, the dial, the genres ----------
export function WeekBars({w, height = 96, compact, t, still}: {w: PhoneWrapped; height?: number; compact?: boolean; t?: Animated.Value; still?: boolean}) {
  const v = w.byWeekday || [];
  const max = Math.max(1, ...v);
  const top = v.indexOf(Math.max(...v));
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return (
    <View style={pp.week} accessible accessibilityLabel={`Most of it on ${days[top]}s`}>
      {days.map((d, i) => {
        const f = Math.max(0.035, (v[i] || 0) / max);
        const a = i * 0.09;
        const grow = still || !t ? 1 : t.interpolate({inputRange: [a, a + 0.36], outputRange: [0, 1], extrapolate: 'clamp'});
        return (
          <View key={d} style={pp.weekCol}>
            <View style={[pp.weekTrack, {height}]}>
              <Animated.View
                style={[
                  pp.weekBar,
                  {height: Math.round(height * f), experimental_backgroundImage: i === top ? GOLDFILL : 'linear-gradient(180deg, #3ad3e6 0%, rgba(58,211,230,0.32) 100%)', transformOrigin: '50% 100%', transform: [{scaleY: grow as never}]},
                  i === top && pp.weekTop,
                ]}
              />
            </View>
            <Text style={[pp.weekDay, i === top && {color: PLAY.gold}]}>{compact ? d.slice(0, 1) : d.slice(0, 3).toUpperCase()}</Text>
          </View>
        );
      })}
    </View>
  );
}

export function Dial({w, size = 200, t, still}: {w: PhoneWrapped; size?: number; t?: Animated.Value; still?: boolean}) {
  const b = w.byHour || [];
  const max = Math.max(1, ...b);
  let prime: number | null = null;
  if (b.some(Boolean)) {
    prime = 0;
    for (let i = 1; i < 24; i++) if ((b[i] || 0) > (b[prime] || 0)) prime = i;
  }
  const k = size / 220;
  const c = size / 2;
  return (
    <View style={{width: size, height: size}} accessible accessibilityLabel={prime == null ? '' : `Prime time: ${hourLabel(prime)}`}>
      <View style={[pp.dialFace, {width: size - 8 * k, height: size - 8 * k, borderRadius: size, left: 4 * k, top: 4 * k}]} />
      {/* the hub's ring of dots */}
      {Array.from({length: 24}, (_, i) => {
        const a = (i / 24) * Math.PI * 2;
        const r = 50 * k;
        return <View key={`d${i}`} style={[pp.dot, {left: c + Math.sin(a) * r - 2, top: c - Math.cos(a) * r - 2}]} />;
      })}
      {Array.from({length: 24}, (_, h) => {
        const len = (4 + 34 * ((b[h] || 0) / max)) * k;
        const win = (h / 24) * 0.7;
        const grow = still || !t ? 1 : t.interpolate({inputRange: [win, win + 0.3], outputRange: [0.05, 1], extrapolate: 'clamp'});
        return (
          <View key={`s${h}`} style={{position: 'absolute', left: c, top: c, width: 0, height: 0, transform: [{rotate: `${h * 15}deg`}]}}>
            <Animated.View
              style={{
                position: 'absolute',
                left: -3.5 * k,
                top: -(56 * k + len),
                width: 7 * k,
                height: len,
                borderRadius: 3.5 * k,
                backgroundColor: h === prime ? PLAY.gold : '#7b6cf2',
                transformOrigin: '50% 100%',
                transform: [{scaleY: grow as never}],
              }}
            />
          </View>
        );
      })}
      <Text style={[pp.tick, {left: c - 20, top: 3 * k, width: 40, textAlign: 'center'}]}>12a</Text>
      <Text style={[pp.tick, {right: 6 * k, top: c - 8, textAlign: 'right'}]}>6a</Text>
      <Text style={[pp.tick, {left: c - 20, bottom: 3 * k, width: 40, textAlign: 'center'}]}>12p</Text>
      <Text style={[pp.tick, {left: 6 * k, top: c - 8}]}>6p</Text>
      <View style={[pp.dialMid, {left: c - 44 * k, top: c - 44 * k, width: 88 * k, height: 88 * k}]}>
        <Text style={[pp.dialHour, {fontSize: 19 * k}]}>{prime == null ? '–' : hourLabel(prime)}</Text>
        <Text style={[pp.dialSub, {fontSize: 9.5 * k}]}>PRIME TIME</Text>
      </View>
    </View>
  );
}

/** The genres as bars that race: the runners-up lead early, the winner surges and turns gold. */
export function GenreBars({bars, t, still}: {bars: {name: string; f: number; mid: number; pct: string}[]; t?: Animated.Value; still?: boolean}) {
  const [trackW, setTrackW] = useState(0);
  const onTrack = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w && Math.abs(w - trackW) > 1) setTrackW(w);
  };
  return (
    <View style={pp.genres}>
      {bars.map((x, i) => {
        const at = (p: number) => -trackW * (1 - p);
        const shift = still || !t ? at(x.f) : t.interpolate({inputRange: [0, 0.5, 1], outputRange: [at(0), at(x.mid), at(x.f)], extrapolate: 'clamp'});
        return (
          <View key={x.name} style={pp.genre}>
            <Text style={[pp.genreName, i === 0 && {color: PLAY.gold}]} numberOfLines={1}>
              {x.name}
            </Text>
            <View style={pp.genreTrack} onLayout={i === 0 ? onTrack : undefined}>
              {trackW ? (
                <Animated.View style={[pp.genreFill, {width: trackW, experimental_backgroundImage: i === 0 ? 'linear-gradient(90deg, #fff2c2 0%, #ffd166 45%, #f0a23a 100%)' : AURORA, transform: [{translateX: shift as never}]}]} />
              ) : null}
            </View>
            <Text style={[pp.genrePct, i === 0 && {color: PLAY.gold}]}>{x.pct}</Text>
          </View>
        );
      })}
    </View>
  );
}

// ---------- the sky of nights ----------
// Every night a star on a calendar (one Svg, drawn once), and the best
// streak's nights flying out of it into a constellation (pictures that move
// by transform), then its lines drawn one by one; the brightest night gold and
// named. `t` runs 0 -> 1 once (about 3.6 s).
export function NightSky({w, width, height, t, still}: {w: PhoneWrapped; width: number; height: number; t?: Animated.Value; still?: boolean}) {
  const lay = useMemo(() => skyLayout(w, width >= height * 0.9), [w, width, height]);
  const maxM = Math.max(1, ...lay.stars.map(s => s.m));
  const n = lay.con.length;
  const brightest = lay.brightest;
  const label = useMemo(() => {
    if (brightest == null || !w.nightsFrom || !w.nights) return null;
    const c = lay.con[brightest];
    const day = dayAfter(w.nightsFrom, w.nights[c.i][0]);
    return {c, text: `${shortDay(day)} · ${fmtH(lay.stars[c.i].m * 60)}`};
  }, [brightest, lay, w.nightsFrom, w.nights]);
  if (!width || !height || !lay.stars.length) return <View style={{width, height}} />;
  const fly = (k: number) => {
    const a = 0.05 + (k / Math.max(1, n)) * 0.3;
    return [a, a + 0.22] as [number, number];
  };
  const lineWin = (k: number) => {
    const a = 0.55 + (k / Math.max(1, n)) * 0.3;
    return [a, a + 0.06] as [number, number];
  };
  const v = (range: [number, number], from: number, to: number) =>
    still || !t ? to : t.interpolate({inputRange: range, outputRange: [from, to], extrapolate: 'clamp'});
  return (
    <View style={{width, height}} pointerEvents="none">
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        {lay.stars.map((s, i) => {
          const k = Math.sqrt(s.m / maxM);
          return (
            <Circle
              key={i}
              cx={s.x * width}
              cy={s.y * height}
              r={1.1 + 2 * k}
              fill={s.streak ? `rgba(255,214,140,${(0.32 + 0.3 * k).toFixed(2)})` : `rgba(190,215,255,${(0.36 + 0.46 * k).toFixed(2)})`}
            />
          );
        })}
      </Svg>
      {lay.con.slice(1).map((c, j) => {
        const k = j + 1;
        const a = lay.con[k - 1];
        const box = lineBox({x: a.x * width, y: a.y * height}, {x: c.x * width, y: c.y * height});
        return (
          <Animated.View
            key={`l${k}`}
            style={{
              position: 'absolute',
              left: a.x * width,
              top: a.y * height - 0.75,
              width: box.len,
              height: 1.5,
              backgroundColor: 'rgba(255,214,140,0.62)',
              transformOrigin: '0% 50%',
              transform: [{rotate: `${box.deg.toFixed(1)}deg`}, {scaleX: v(lineWin(k), 0, 1) as never}],
            }}
          />
        );
      })}
      {lay.con.map((c, k) => {
        const s = lay.stars[c.i];
        const z = 0.65 + 0.85 * Math.sqrt(s.m / maxM);
        const big = k === brightest;
        const size = Math.round((big ? 13 : 9) * z);
        const fx = (s.x - c.x) * width;
        const fy = (s.y - c.y) * height;
        return (
          <Animated.View
            key={`s${k}`}
            style={{
              position: 'absolute',
              left: c.x * width - size / 2,
              top: c.y * height - size / 2,
              width: size,
              height: size,
              opacity: v(fly(k), 0, 1) as never,
              transform: [{translateX: v(fly(k), fx, 0) as never}, {translateY: v(fly(k), fy, 0) as never}],
            }}>
            {big ? <Image source={GLOW_SRC} fadeDuration={0} style={{position: 'absolute', left: -size * 1.6, top: -size * 1.6, width: size * 4.2, height: size * 4.2, tintColor: PLAY.gold, opacity: 0.55}} /> : null}
            <View style={[pp.conStar, {width: size, height: size, borderRadius: size / 2, backgroundColor: big ? PLAY.gold : '#fff6e0'}, big && pp.conBig]} />
          </Animated.View>
        );
      })}
      {label ? (
        <Animated.View
          style={[
            pp.skyLabel,
            {
              top: label.c.y * height + (label.c.y < 0.3 ? 16 : -62),
              ...(label.c.x > 0.5 ? {right: Math.max(4, (1 - label.c.x) * width - 12)} : {left: Math.max(4, label.c.x * width - 12)}),
              opacity: v([0.88, 1], 0, 1) as never,
            },
          ]}>
          <Text style={pp.skyLabelHead}>Brightest night</Text>
          <Text style={pp.skyLabelText}>{label.text}</Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

/** A value that runs 0 -> 1 once, after `delay`, unless still; restarted when `run` changes. */
export const useRun = (ms: number, {delay = 0, still = false, run = 1, easing = EASE}: {delay?: number; still?: boolean; run?: unknown; easing?: (t: number) => number} = {}) => {
  const v = useValue(still ? 1 : 0);
  const first = useRef(true);
  useEffect(() => {
    if (still) {
      v.setValue(1);
      return;
    }
    v.setValue(0);
    const a = tween(v, 1, ms, {delay, easing});
    a.start();
    first.current = false;
    return () => a.stop();
  }, [v, ms, delay, still, run, easing]);
  return v;
};
export {LINEAR};

const pp = StyleSheet.create({
  gold: {borderWidth: 2.5, borderColor: PLAY.gold},
  drawn: {justifyContent: 'flex-end', padding: 10},
  drawnName: {color: 'rgba(255,255,255,0.92)', fontWeight: '900', lineHeight: 20},
  back: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(255,209,102,0.55)',
    backgroundColor: '#1a1546',
    experimental_backgroundImage: 'radial-gradient(circle at 50% 42%, #2d2470 0%, #171339 60%, #0e0c26 100%)',
    overflow: 'hidden',
  },
  backRing: {alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: 'rgba(255,209,102,0.7)', backgroundColor: 'rgba(255,209,102,0.06)'},
  backWord: {color: PLAY.gold, fontWeight: '900', letterSpacing: 1.6},
  backQ: {color: PLAY.ink, fontWeight: '900', marginTop: -2},
  front: {
    padding: 4,
    backgroundColor: '#c99a3e',
    experimental_backgroundImage: 'linear-gradient(140deg, #fff2c2 0%, #d8a64a 30%, #8a5a14 55%, #ffd166 80%, #b8862c 100%)',
    boxShadow: '0 20px 44px -16px rgba(0,0,0,0.85)',
  },
  frontIn: {flex: 1, overflow: 'hidden'},
  frontTop: {flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8},
  frontTiny: {color: PLAY.gold, fontWeight: '900', letterSpacing: 1.2},
  art: {alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', overflow: 'hidden'},
  frontName: {color: PLAY.ink, fontWeight: '900', textAlign: 'center', marginTop: 12, letterSpacing: -0.3},
  frontBecause: {color: PLAY.gold, fontWeight: '800', textAlign: 'center', marginTop: 4},
  frontFoot: {flexDirection: 'row', justifyContent: 'space-between', gap: 8},
  frontFootText: {color: 'rgba(232,228,255,0.6)', fontWeight: '800', flexShrink: 1},
  foil: {position: 'absolute', experimental_backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,0) 30%, rgba(255,255,255,0.16) 46%, rgba(160,131,255,0.14) 52%, rgba(92,245,184,0.12) 58%, rgba(255,255,255,0) 72%)'},
  week: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: 6},
  weekCol: {flex: 1, alignItems: 'center', gap: 8},
  weekTrack: {width: '100%', maxWidth: 34, justifyContent: 'flex-end'},
  weekBar: {width: '100%', borderRadius: 9},
  weekTop: {boxShadow: '0 0 22px rgba(255,209,102,0.45)'},
  weekDay: {color: 'rgba(232,228,255,0.62)', fontSize: 11.5, fontWeight: '800', letterSpacing: 0.4},
  dialFace: {position: 'absolute', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: 'rgba(255,255,255,0.025)'},
  dot: {position: 'absolute', width: 4, height: 4, borderRadius: 2, backgroundColor: 'rgba(123,108,242,0.75)'},
  tick: {position: 'absolute', color: 'rgba(232,228,255,0.5)', fontSize: 10.5, fontWeight: '800'},
  dialMid: {position: 'absolute', alignItems: 'center', justifyContent: 'center'},
  dialHour: {color: PLAY.gold, fontWeight: '900'},
  dialSub: {color: 'rgba(232,228,255,0.62)', fontWeight: '800', letterSpacing: 1.2, marginTop: 2},
  genres: {gap: 14, alignSelf: 'stretch'},
  genre: {flexDirection: 'row', alignItems: 'center', gap: 10},
  genreName: {width: 104, color: PLAY.ink, fontSize: 15, fontWeight: '800'},
  genreTrack: {flex: 1, height: 14, borderRadius: 7, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.08)'},
  genreFill: {height: 14, borderRadius: 7},
  genrePct: {width: 42, textAlign: 'right', color: 'rgba(232,228,255,0.62)', fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums']},
  conStar: {},
  conBig: {boxShadow: '0 0 12px rgba(255,209,102,0.9)'},
  skyLabel: {position: 'absolute', paddingVertical: 7, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,209,102,0.35)', backgroundColor: 'rgba(8,8,24,0.86)', maxWidth: 170},
  skyLabelHead: {color: PLAY.gold, fontSize: 12.5, fontWeight: '900'},
  skyLabelText: {color: PLAY.inkDim, fontSize: 12, fontWeight: '700', marginTop: 1},
});
export {STAR_SRC};
