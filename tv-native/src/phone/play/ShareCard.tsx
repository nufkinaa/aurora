// Aurora Wrapped's share card on the phone: the website's 1080×1920 picture
// (public/js/screens/wrapped.js paintShareCard) drawn as one react-native-svg
// picture — the night sky with aurora light, "AURORA WRAPPED", the profile's
// name and "since <month year>", the hours in gold, the viewer type with its
// constellation and verdict, the number one with its poster, three tiles, the
// mark. Only the profile's own name and its stats: no other profile, no
// device, no address, no roasts.
//
// It is shown small in the finale (the same picture, scaled), and turned into
// a PNG of 1080×1920 for sharing (react-native-svg's toDataURL), which the
// phone hands to Android's share sheet (../native.ts sharePicture).
//
// The poster: fetched once with the session's headers and drawn from a data
// address (the picture inside an SVG cannot send headers); without it, a drawn
// stand-in with the title's first letter.
import React, {forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState} from 'react';
import {View} from 'react-native';
import Svg, {Circle, ClipPath, Defs, Ellipse, G, Image as SvgImage, Line, LinearGradient, Polygon, RadialGradient, Rect, Stop, Text as SvgText} from 'react-native-svg';
import {artSrc} from '../ui/Cards';
import * as S from './storyWords';
import type {Ctx} from './storyWords';

export const W = 1080;
export const H = 1920;
const X = 96;

// a seeded sky (the website's paintStars: the same few hundred stars every time)
const rng = (seed: number) => {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const starsOf = (n: number, seed: number) => {
  const r = rng(seed);
  return Array.from({length: n}, () => ({x: r() * W, y: r() * H, r: r() < 0.1 ? 2.4 + r() * 1.6 : 0.9 + r() * 1.3, a: 0.25 + r() * 0.6}));
};

/** The poster as a data address (or null), fetched with the session's headers. */
export const posterData = async (poster: string | null | undefined): Promise<string | null> => {
  const {src} = artSrc(poster || null, 200);
  if (!src) return null;
  try {
    const res = await fetch(src.uri, {headers: src.headers || {}});
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>(resolve => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === 'string' && fr.result.startsWith('data:image') ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
};

export type ShareCardHandle = {png: () => Promise<string | null>};

type Props = {c: Ctx; width: number; poster: string | null};

const FONT = 'sans-serif';

export const ShareCard = forwardRef<ShareCardHandle, Props>(function ShareCard({c, width, poster}, ref) {
  const svg = useRef<{toDataURL?: (cb: (b64: string) => void, o?: {width: number; height: number}) => void} | null>(null);
  useImperativeHandle(ref, () => ({
    png: () =>
      new Promise(resolve => {
        const s = svg.current;
        if (!s || !s.toDataURL) return resolve(null);
        let done = false;
        const t = setTimeout(() => {
          if (!done) resolve(null);
        }, 8000);
        try {
          s.toDataURL(b64 => {
            done = true;
            clearTimeout(t);
            resolve(b64 || null);
          }, {width: W, height: H});
        } catch {
          clearTimeout(t);
          resolve(null);
        }
      }),
  }));
  const stars = useMemo(() => starsOf(260, 7), []);
  const {w, type, name} = c;
  const felt = S.hoursFelt(w.totalSec || 0);
  const nameSize = S.fitSize(name, W - 2 * X, 104, 56);
  const bigSize = S.fitSize(felt.value, W - 2 * X, 330, 160);
  const tx = X + 300;
  const tw = W - X - tx;
  const nameLines = S.wrapEstimate(type.name, tw, 64, 2);
  const verdictLines = S.wrapEstimate(type.verdict, tw, 32, 2, false);
  const typeH = Math.max(300, 126 + nameLines.length * 70 + verdictLines.length * 42 + 34);
  const top = (w.topTitles || [])[0];
  let y = 800 + typeH + 40;
  const topY = y;
  if (top) y += 370;
  const tiles = S.shareTiles(c);
  const gap = 20;
  const tileW = (W - 2 * X + 48 - 2 * gap) / 3;
  const gs = 250;
  const gx = X + 10;
  const gy = 800 + (typeH - gs) / 2;
  const topLines = top ? S.wrapEstimate(top.name, W - X - (X + 220) + 4, 60, 2) : [];
  const hue = top ? S.hashHue(top.name) : 0;
  const mark = useMemo(() => {
    const sx = X + 14;
    const sy = H - 112;
    const pts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 7 : 17;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push(`${(sx + Math.cos(a) * r).toFixed(1)},${(sy + Math.sin(a) * r).toFixed(1)}`);
    }
    return pts.join(' ');
  }, []);
  const panel = (py: number, ph: number) => <Rect x={X - 24} y={py} width={W - 2 * X + 48} height={ph} rx={44} fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.14)" strokeWidth={2} />;
  return (
    <View style={{width, height: Math.round((width * H) / W), borderRadius: Math.round(width * 0.06), overflow: 'hidden'}}>
      <Svg ref={svg as never} width={width} height={Math.round((width * H) / W)} viewBox={`0 0 ${W} ${H}`}>
        <Defs>
          <LinearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#15103b" />
            <Stop offset="0.5" stopColor="#070818" />
            <Stop offset="1" stopColor="#03141c" />
          </LinearGradient>
          <RadialGradient id="b1" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#5cf5b8" stopOpacity="0.2" />
            <Stop offset="1" stopColor="#5cf5b8" stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id="b2" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#a083ff" stopOpacity="0.2" />
            <Stop offset="1" stopColor="#a083ff" stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id="b3" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#3ad3e6" stopOpacity="0.14" />
            <Stop offset="1" stopColor="#3ad3e6" stopOpacity="0" />
          </RadialGradient>
          <LinearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#fff2c2" />
            <Stop offset="0.45" stopColor="#ffd166" />
            <Stop offset="1" stopColor="#f0a23a" />
          </LinearGradient>
          <LinearGradient id="pg" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={`hsl(${hue}, 60%, 34%)`} />
            <Stop offset="1" stopColor={`hsl(${(hue + 60) % 360}, 70%, 14%)`} />
          </LinearGradient>
          <ClipPath id="pc">
            <Rect x={X + 4} y={topY + 30} width={180} height={270} rx={22} />
          </ClipPath>
        </Defs>
        <Rect x={0} y={0} width={W} height={H} fill="url(#bg)" />
        <Ellipse cx={300} cy={260} rx={900} ry={300} fill="url(#b1)" />
        <Ellipse cx={860} cy={620} rx={760} ry={280} fill="url(#b2)" />
        <Ellipse cx={540} cy={1820} rx={900} ry={260} fill="url(#b3)" />
        <G>
          {stars.map((s, i) => (
            <Circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#ffffff" fillOpacity={s.a} />
          ))}
        </G>
        <SvgText x={X} y={168} fill="#5cf5b8" fontSize={34} fontWeight="800" fontFamily={FONT} letterSpacing={7}>
          AURORA WRAPPED
        </SvgText>
        <SvgText x={X} y={284} fill="#f7f5ff" fontSize={nameSize} fontWeight="900" fontFamily={FONT}>
          {name}
        </SvgText>
        <SvgText x={X} y={340} fill="rgba(232,228,255,0.66)" fontSize={38} fontWeight="600" fontFamily={FONT}>
          {`since ${S.sinceMonth(w.since)}`}
        </SvgText>
        <SvgText x={X - 8} y={650} fill="url(#gold)" fontSize={bigSize} fontWeight="900" fontFamily={FONT}>
          {felt.value}
        </SvgText>
        <SvgText x={X} y={730} fill="#f7f5ff" fontSize={50} fontWeight="800" fontFamily={FONT}>
          {`${felt.unit} watched`}
        </SvgText>
        {panel(800, typeH)}
        {type.lines.map(([a, b], i) => (
          <Line key={`gl${i}`} x1={gx + (type.stars[a][0] / 100) * gs} y1={gy + (type.stars[a][1] / 100) * gs} x2={gx + (type.stars[b][0] / 100) * gs} y2={gy + (type.stars[b][1] / 100) * gs} stroke="rgba(255,209,102,0.7)" strokeWidth={3} />
        ))}
        {type.stars.map(([sx, sy], i) => (
          <Circle key={`gs${i}`} cx={gx + (sx / 100) * gs} cy={gy + (sy / 100) * gs} r={8} fill="#fff2c2" />
        ))}
        <SvgText x={tx} y={890} fill="#ffd166" fontSize={28} fontWeight="800" fontFamily={FONT} letterSpacing={5}>
          VIEWER TYPE
        </SvgText>
        {nameLines.map((l, i) => (
          <SvgText key={`tn${i}`} x={tx} y={966 + i * 70} fill="#f7f5ff" fontSize={64} fontWeight="900" fontFamily={FONT}>
            {l}
          </SvgText>
        ))}
        {verdictLines.map((l, i) => (
          <SvgText key={`tv${i}`} x={tx} y={966 + nameLines.length * 70 + 8 + i * 42} fill="rgba(232,228,255,0.72)" fontSize={32} fontWeight="600" fontFamily={FONT}>
            {l}
          </SvgText>
        ))}
        {top ? (
          <G>
            {panel(topY, 330)}
            {poster ? (
              <SvgImage x={X + 4} y={topY + 30} width={180} height={270} href={{uri: poster}} preserveAspectRatio="xMidYMid slice" clipPath="url(#pc)" />
            ) : (
              <G>
                <Rect x={X + 4} y={topY + 30} width={180} height={270} rx={22} fill="url(#pg)" />
                <SvgText x={X + 56} y={topY + 200} fill="rgba(255,255,255,0.85)" fontSize={96} fontWeight="900" fontFamily={FONT}>
                  {[...top.name][0] || '?'}
                </SvgText>
              </G>
            )}
            <SvgText x={X + 220} y={topY + 92} fill="#5cf5b8" fontSize={28} fontWeight="800" fontFamily={FONT} letterSpacing={5}>
              NUMBER ONE
            </SvgText>
            {topLines.map((l, i) => (
              <SvgText key={`tl${i}`} x={X + 220} y={topY + 164 + i * 66} fill="#f7f5ff" fontSize={60} fontWeight="900" fontFamily={FONT}>
                {l}
              </SvgText>
            ))}
            <SvgText x={X + 220} y={topY + 164 + topLines.length * 66 + 12} fill="#ffd166" fontSize={40} fontWeight="800" fontFamily={FONT}>
              {S.fmtH(top.sec)}
            </SvgText>
          </G>
        ) : null}
        {tiles.map(([label, value], i) => {
          const x0 = X - 24 + i * (tileW + gap);
          return (
            <G key={label}>
              <Rect x={x0} y={y} width={tileW} height={190} rx={36} fill="rgba(255,255,255,0.07)" />
              <SvgText x={x0 + 30} y={y + 64} fill="rgba(232,228,255,0.6)" fontSize={22} fontWeight="800" fontFamily={FONT} letterSpacing={3}>
                {label}
              </SvgText>
              <SvgText x={x0 + 30} y={y + 136} fill="#f7f5ff" fontSize={S.fitSize(value, tileW - 60, 54, 30)} fontWeight="900" fontFamily={FONT}>
                {value}
              </SvgText>
            </G>
          );
        })}
        <Polygon points={mark} fill="#ffd166" />
        <SvgText x={X + 46} y={H - 98} fill="#f7f5ff" fontSize={40} fontWeight="800" fontFamily={FONT}>
          Aurora
        </SvgText>
        <SvgText x={W - X} y={H - 100} fill="rgba(232,228,255,0.55)" fontSize={30} fontWeight="600" fontFamily={FONT} textAnchor="end">
          my year in the night sky
        </SvgText>
      </Svg>
    </View>
  );
});

/** The poster of the top title, fetched once per story. */
export const usePosterData = (poster: string | null | undefined) => {
  const [data, setData] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    posterData(poster).then(d => live && setData(d));
    return () => {
      live = false;
    };
  }, [poster]);
  return data;
};
