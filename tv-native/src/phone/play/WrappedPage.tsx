// Aurora Wrapped on the phone — the page under the story ("All the numbers":
// every stat as plain text in cards, the website's renderPage) and the teaser
// for a profile with nothing watched yet (renderTeaser). Both still: nothing
// moves here but a press, and the collectible under the finger.
import React from 'react';
import {StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import Meter from '../../play/Meter';
import {PLAY} from '../../play/tokens';
import {GUTTER} from '../theme';
import {Chip, Eyebrow, Key, PlayCard, ty} from './ui';
import {CardBack, CARD_H, CARD_W, Dial, GenreBars, NightSky, Poster, TiltCard, TypeFront, WeekBars} from './WrappedParts';
import * as S from './storyWords';
import type {Ctx} from './storyWords';

function Tile({head, children, center}: {head: string; children?: React.ReactNode; center?: boolean}) {
  return (
    <PlayCard style={[pg.tile, center && pg.tileCenter]}>
      <Eyebrow style={center ? undefined : pg.headLeft}>{head}</Eyebrow>
      {children}
    </PlayCard>
  );
}

export function WrappedNumbers({c, onPlay, onShare, onBrowse}: {c: Ctx; onPlay: () => void; onShare: () => void; onBrowse: () => void}) {
  const {width} = useWindowDimensions();
  const inner = Math.min(width, 640) - GUTTER * 2 - 44;
  const p = S.page(c);
  const g = S.genres(c);
  const showSky = !!(c.w.streak && Array.isArray(c.w.nights) && c.w.nights.length > 1);
  const cardW = Math.min(CARD_W, inner - 40);
  return (
    <View style={pg.page}>
      <View style={pg.head}>
        <Eyebrow star style={pg.headLeft}>
          {p.eyebrow}
        </Eyebrow>
        <Text style={[ty.h1, pg.left, pg.h1]} accessibilityRole="header">
          {p.title}
        </Text>
        <Text style={[ty.lede, pg.left]}>
          {c.name}
          {p.lede}
        </Text>
        <View style={pg.keys}>
          <Key uiId="wrapped.story" kind="gold" glyph="▶" label={p.play} onPress={onPlay} />
          <Key uiId="wrapped.share" label={p.share} onPress={onShare} />
        </View>
      </View>

      <Tile head={p.hours.head}>
        <Text style={[pg.big, ty.gold, ty.num]}>{p.hours.value}</Text>
        <Text style={pg.unit}>{p.hours.unit}</Text>
        {p.hours.lines.map(l => (
          <Text key={l} style={[ty.small, pg.line]}>
            {l}
          </Text>
        ))}
        <View style={pg.chips}>
          {p.hours.chips.map(x => (
            <Chip key={x} label={x} />
          ))}
        </View>
      </Tile>

      <Tile head={p.type.head} center>
        <View style={pg.typeCard}>
          <TiltCard w={cardW} h={Math.round(cardW * (CARD_H / CARD_W))}>
            <TypeFront type={c.type} name={c.name} since={c.w.since} w={cardW} />
          </TiltCard>
        </View>
        <Text style={[ty.h2, pg.typeName]}>{c.type.name}</Text>
        <Text style={[ty.small, pg.centerText]}>{c.type.verdict}</Text>
      </Tile>

      {p.top.rows.length ? (
        <Tile head={p.top.head}>
          <View style={pg.list}>
            {p.top.rows.map(r => (
              <View key={r.rank} style={pg.topRow}>
                <Text style={pg.rank}>{r.rank}</Text>
                <Poster name={r.name} poster={r.poster} w={40} h={60} radius={8} />
                <Text style={pg.topName} numberOfLines={2}>
                  {r.name}
                </Text>
                <Text style={pg.topH}>{r.hours}</Text>
              </View>
            ))}
          </View>
        </Tile>
      ) : null}

      {g.bars.length ? (
        <Tile head={p.genres.head}>
          <View style={pg.space}>
            <GenreBars bars={g.bars} still />
          </View>
        </Tile>
      ) : null}

      <Tile head={p.night.head}>
        <Text style={pg.lineBig}>{p.night.line}</Text>
        {p.night.late ? (
          <>
            <View style={pg.space}>
              <WeekBars w={c.w} height={70} compact still />
            </View>
            <View style={pg.dial}>
              <Dial w={c.w} size={Math.min(190, inner)} still />
            </View>
            <Text style={ty.small}>{p.night.late}</Text>
          </>
        ) : null}
      </Tile>

      <Tile head={p.streak.head}>
        <Text style={pg.lineBig}>
          <Text style={ty.gold}>{p.streak.value}</Text>
          {p.streak.tail}
        </Text>
        {p.streak.dates ? <Text style={ty.small}>{p.streak.dates}</Text> : null}
        {p.streak.biggest ? <Text style={ty.small}>{p.streak.biggest}</Text> : null}
        {showSky ? (
          <View style={pg.space}>
            <NightSky w={c.w} width={inner} height={Math.round(inner * 0.62)} still />
          </View>
        ) : null}
      </Tile>

      {p.longest ? (
        <Tile head={p.longest.head}>
          <Text style={[pg.lineBig, ty.num]}>
            {p.longest.clock}
            <Text style={ty.soft}>{' h:mm'}</Text>
          </Text>
          <Text style={ty.small}>{p.longest.title}</Text>
        </Tile>
      ) : null}

      {p.devices.rows.length ? (
        <Tile head={p.devices.head}>
          <View style={pg.list}>
            {p.devices.rows.map(r => (
              <View key={r.label} style={pg.devRow}>
                <Text style={pg.devName} numberOfLines={1}>
                  {r.label}
                </Text>
                <Meter value={r.share} width={Math.max(60, inner - 92 - 48 - 20)} height={10} calm />
                <Text style={pg.devPct}>{r.pct}</Text>
              </View>
            ))}
          </View>
        </Tile>
      ) : null}

      <Tile head={p.roasts.head}>
        <View style={pg.list}>
          {p.roasts.lines.map(l => (
            <View key={l} style={pg.roastRow}>
              <Text style={pg.roastQ}>“</Text>
              <Text style={[ty.small, pg.roastText]}>{l}</Text>
            </View>
          ))}
        </View>
      </Tile>

      <View style={pg.foot}>
        <Key uiId="phone.wrapped.browse" label={p.browse} onPress={onBrowse} />
      </View>
    </View>
  );
}

/** A little padlock (the website's .wr-lock), drawn. */
const Lock = () => (
  <View style={pg.lock}>
    <View style={pg.shackle} />
    <View style={pg.lockBody} />
  </View>
);

export function WrappedTeaser({name, onBrowse}: {name: string; onBrowse: () => void}) {
  const {width} = useWindowDimensions();
  const w = Math.min(150, Math.round(width * 0.38));
  const h = Math.round(w * 1.42);
  return (
    <View style={pg.teaser}>
      <View style={pg.teaserArt} importantForAccessibility="no-hide-descendants">
        <TiltCard w={w} h={h}>
          <CardBack w={w} h={h} q radius={16} />
        </TiltCard>
      </View>
      <Eyebrow star>{S.TEASER.eyebrow}</Eyebrow>
      <Text style={[ty.h1, pg.teaserTitle]} accessibilityRole="header">
        {S.TEASER.title}
        <Text style={ty.gold}>{`${name}.`}</Text>
      </Text>
      <Text style={ty.lede}>{S.TEASER.line}</Text>
      <View style={pg.locked} accessible accessibilityLabel={`${S.TEASER.lockedLabel}: ${S.TEASER.locked.join(', ')}`}>
        {S.TEASER.locked.map(x => (
          <Chip key={x} label={x} lead={<Lock />} textStyle={pg.lockedText} />
        ))}
      </View>
      <Key uiId="phone.wrapped.browse" kind="gold" label={S.TEASER.browse} onPress={onBrowse} />
    </View>
  );
}

const pg = StyleSheet.create({
  page: {gap: 16},
  head: {gap: 12, marginBottom: 8},
  headLeft: {justifyContent: 'flex-start'},
  left: {textAlign: 'left'},
  h1: {fontSize: 34},
  keys: {alignItems: 'flex-start', gap: 10, marginTop: 6},
  tile: {padding: 22, gap: 6},
  tileCenter: {alignItems: 'center'},
  big: {fontSize: 64, lineHeight: 70, fontWeight: '900', marginTop: 6, includeFontPadding: false},
  unit: {color: PLAY.ink, fontSize: 19, fontWeight: '900'},
  line: {marginTop: 4},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10},
  typeCard: {marginTop: 12, marginBottom: 6},
  typeName: {marginTop: 8},
  centerText: {textAlign: 'center'},
  list: {gap: 10, marginTop: 8},
  topRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  rank: {width: 16, color: 'rgba(232,228,255,0.62)', fontSize: 15, fontWeight: '900'},
  topName: {flex: 1, color: PLAY.ink, fontSize: 15, fontWeight: '800'},
  topH: {color: 'rgba(232,228,255,0.62)', fontSize: 13.5, fontWeight: '800', fontVariant: ['tabular-nums']},
  space: {marginTop: 12},
  dial: {alignItems: 'center', marginVertical: 12},
  lineBig: {color: PLAY.ink, fontSize: 24, fontWeight: '900', letterSpacing: -0.4, marginTop: 4},
  devRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  devName: {width: 92, color: PLAY.ink, fontSize: 14.5, fontWeight: '800'},
  devPct: {width: 48, textAlign: 'right', color: 'rgba(232,228,255,0.62)', fontSize: 13.5, fontWeight: '800'},
  roastRow: {flexDirection: 'row', gap: 8},
  roastQ: {color: PLAY.gold, fontSize: 22, lineHeight: 26, fontWeight: '900'},
  roastText: {flex: 1, color: PLAY.ink},
  foot: {alignItems: 'center', marginTop: 10},
  teaser: {alignItems: 'center', gap: 16, paddingTop: 8},
  teaserArt: {marginBottom: 8},
  teaserTitle: {marginTop: 2},
  locked: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginVertical: 4},
  lockedText: {color: 'rgba(232,228,255,0.72)'},
  lock: {width: 11, height: 14, alignItems: 'center'},
  shackle: {width: 8, height: 8, borderWidth: 2, borderBottomWidth: 0, borderColor: 'rgba(232,228,255,0.6)', borderTopLeftRadius: 4, borderTopRightRadius: 4},
  lockBody: {width: 11, height: 7, borderRadius: 2, backgroundColor: 'rgba(232,228,255,0.6)'},
});
