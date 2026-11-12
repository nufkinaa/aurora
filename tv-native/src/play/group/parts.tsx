// Aurora Play — the pieces of Pick together on the TV ("Party night",
// docs/play/tv.md): the code as a ticket, the people as seats, the tally as
// stars, and the reveal's curtain. The screen (screens/GroupPick.tsx) owns the
// session and the remote; these only draw what they are handed.
//
// Motion: transform and opacity on the native driver (the kit's Pop / Rise /
// Meter). Calm: every piece in its finished state, nothing moves.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Animated, Image, StyleSheet, Text, View} from 'react-native';
import {imgSrc} from '../../api';
import {useTVKeys} from '../../focus';
import type {GroupMember} from '../../groupPick';
import {WORDS} from '../../groupPick';
import {EASE, tween, useTimers, useValue} from '../anim';
import Meter from '../Meter';
import {Pop} from '../Motion';
import PlayKey from '../PlayKey';
import Room from '../Room';
import {Glow, Star} from '../Star';
import {tallyOf, Votes} from '../tally';
import {PLAY} from '../tokens';
import {Poster} from '../wrapped/parts';
import {freeSeats, revealPlan, SHOW, STAR_AT, seatSize} from '../groupShow';

// ---------------------------------------------------------------- the ticket
// The code is what the sofa looks for: four tiles with a gold edge, big
// letters. The tiles deal in once, when the code first shows.
export function Ticket({code, calm}: {code: string; calm: boolean}) {
  return (
    <View style={s.ticket} accessible accessibilityLabel={code.split('').join(' ')}>
      {code.split('').map((ch, i) => (
        <Pop key={`${code}${i}`} run={code} delay={i * 70} from={0.7} calm={calm} style={s.tile}>
          <Text style={s.tileText}>{ch}</Text>
        </Pop>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- a seat
function Face({m, size}: {m: GroupMember; size: number}) {
  const pic = m.avatarImage ? imgSrc(m.avatarImage) : null;
  return (
    <View style={[s.face, {width: size, height: size, borderRadius: size / 2}]}>
      {pic ? (
        <Image source={pic} style={{width: size, height: size}} resizeMode="cover" fadeDuration={0} />
      ) : (
        <Text style={{fontSize: Math.round(size * 0.5), lineHeight: Math.round(size * 0.66)}}>{m.role === 'screen' && !m.avatar ? '📺' : m.avatar || '🍿'}</Text>
      )}
    </View>
  );
}

// A person as a seat: the face, the name under it; the one who started it
// carries a small gold star; away is dimmed; while the deck is out, how far
// through it they are (a ribbon) and a tick when done. A seat pops in only
// the first time that person is seen (`fresh`).
export function Seat({
  m,
  size,
  fresh,
  calm,
  deck,
  badge,
}: {
  m: GroupMember;
  size: number;
  fresh: boolean;
  calm: boolean;
  deck?: number; // the deck's length while it is out (a ribbon per voter)
  badge?: string; // the small line under the name
}) {
  const voting = deck != null && m.role === 'voter';
  const part = m.done ? 1 : deck ? Math.max(0, Math.min(1, (m.answered || 0) / deck)) : 0;
  const w = size + 28;
  return (
    <Pop calm={calm || !fresh} style={[s.seat, {width: w}, m.away && s.away]}>
      <View accessible accessibilityLabel={badge ? `${m.name}, ${badge}` : m.name} style={s.seatIn}>
        <View style={{width: size, height: size}}>
          <Face m={m} size={size} />
          {m.host ? (
            <View style={s.hostStar}>
              <Star size={12} color={PLAY.goldInk} />
            </View>
          ) : null}
          {voting && m.done ? (
            <View style={s.tick}>
              <Text style={s.tickText}>✓</Text>
            </View>
          ) : null}
        </View>
        <Text style={[s.name, size < 56 && s.nameSmall]} numberOfLines={1}>
          {m.name}
        </Text>
        {voting ? (
          <View style={s.ribbon}>
            <Meter value={part} width={size} height={5} calm={calm} tint={m.done ? PLAY.green : undefined} />
          </View>
        ) : null}
        {badge ? (
          <Text style={[s.badge, voting && m.done && s.badgeDone]} numberOfLines={1}>
            {badge}
          </Text>
        ) : null}
      </View>
    </Pop>
  );
}

// Everyone in the room. `room`: the two dashed seats that say there is room.
// Who has had their entrance is remembered by the screen (`seen`), so nobody
// pops in twice — also not when the page is redrawn.
export function Seats({
  people,
  seen,
  calm,
  deck,
  room,
  badgeOf,
  center,
}: {
  people: GroupMember[];
  seen: React.MutableRefObject<Set<string>>;
  calm: boolean;
  deck?: number;
  room?: boolean;
  badgeOf: (m: GroupMember) => string;
  center?: boolean;
}) {
  const size = seatSize(people.length);
  const fresh = people.filter(m => !seen.current.has(m.id)).map(m => m.id);
  useEffect(() => {
    for (const id of fresh) seen.current.add(id);
  });
  const free = room ? freeSeats(people.length) : 0;
  return (
    <View style={[s.seats, center && s.seatsCenter]}>
      {people.map(m => (
        <Seat key={m.id} m={m} size={size} fresh={fresh.includes(m.id)} calm={calm} deck={deck} badge={badgeOf(m)} />
      ))}
      {Array.from({length: free}, (_, i) => (
        <View key={`free${i}`} style={[s.seat, {width: size + 28}]} importantForAccessibility="no-hide-descendants">
          <View style={[s.free, {width: size, height: size, borderRadius: size / 2}]}>
            <Text style={s.freeText}>+</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- the tally
// A pick's votes as stars: gold for a yes, a pale gold for a maybe, a dim dot
// for the rest. They come in one after the other after the drop (`fresh`);
// otherwise they are simply there. A room too big to draw: nothing (the
// server's sentence beside it says it).
export function TallyStars({pick, fresh, calm, delay = 700}: {pick: Votes | null; fresh: boolean; calm: boolean; delay?: number}) {
  const marks = tallyOf(pick);
  if (!marks.length) return null;
  return (
    <View style={s.tally} importantForAccessibility="no-hide-descendants">
      {marks.map((k, i) => (
        <Pop key={i} calm={calm || !fresh} delay={delay + i * 90} from={0.3}>
          {k === 'no' ? <View style={s.dot} /> : <Star size={22} color={k === 'yes' ? PLAY.gold : 'rgba(255,209,102,0.4)'} />}
        </Pop>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- the reveal
// Over the result (complete under it), once per result, only on a screen that
// saw the vote end: "The votes are in…", three stars; a tie-break if the top
// two were level (the light jumps between the posters and stops on the
// server's pick); then the curtain lifts (`onEnd(true)`: the drop and the
// burst follow). Any key skips it — and gives up the burst (`onEnd(false)`);
// Skip holds the focus, so OK can never press Play under the curtain. Back is
// the screen's (it calls the same skip).
export type Duel = {posters: {poster?: string | null; title: string}[]; winner: number} | null;
export function Reveal({duel, onEnd, inFront}: {duel: Duel; onEnd: (lifted: boolean) => void; inFront: boolean}) {
  const timers = useTimers();
  const plan = revealPlan(!!duel, duel ? duel.winner : 0);
  const [beat, setBeat] = useState<'votes' | 'tie'>('votes');
  const [lit, setLit] = useState(-1);
  const [won, setWon] = useState(false);
  const fade = useValue(1);
  const ended = useRef(false);
  const end = useCallback(
    (lifted: boolean) => {
      if (ended.current) return;
      ended.current = true;
      timers.clear();
      tween(fade, 0, lifted ? 340 : 180).start(() => onEnd(lifted));
    },
    [timers, fade, onEnd],
  );
  useEffect(() => {
    if (duel) {
      timers.after(plan.tieAt, () => setBeat('tie'));
      for (const j of plan.jumps) timers.after(j.at, () => setLit(j.i));
      timers.after(plan.wonAt, () => setWon(true));
    }
    timers.after(plan.end, () => end(true));
    // (once: a show is mounted per result)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // the screen went away under the show: it ends quietly
  useEffect(() => {
    if (!inFront) end(false);
  }, [inFront, end]);
  // any direction skips it (OK is the Skip key's own)
  useTVKeys(
    useCallback(
      (evt: {eventType: string}) => {
        if (['left', 'right', 'up', 'down', 'playPause'].includes(evt.eventType)) end(false);
      },
      [end],
    ),
  );
  return (
    <Animated.View style={[StyleSheet.absoluteFill, {opacity: fade}]}>
      <Room on={inFront} />
      <View style={s.showIn}>
        <Text style={s.showWords} accessibilityLiveRegion="polite">
          {beat === 'tie' ? SHOW.tie : SHOW.votesIn}
        </Text>
        <View style={s.showStars} importantForAccessibility="no-hide-descendants">
          {STAR_AT.map((at, i) => (
            <Pop key={i} delay={at} from={0.2}>
              <Star size={34} color={PLAY.gold} />
            </Pop>
          ))}
        </View>
        {duel ? (
          // mounted from the start (their pictures load unseen), shown at the tie's beat
          <View style={[s.duel, beat !== 'tie' && s.unseen]} importantForAccessibility="no-hide-descendants">
            {duel.posters.map((p, k) => (
              <DuelCard key={k} p={p} lit={lit === k} won={won && k === duel.winner} />
            ))}
          </View>
        ) : null}
      </View>
      <View style={s.showSkip}>
        <PlayKey small label={SHOW.skip} hasTVPreferredFocus onPress={() => end(false)} />
      </View>
    </Animated.View>
  );
}

const DUEL_W = 132;
const DUEL_H = 198;
function DuelCard({p, lit, won}: {p: {poster?: string | null; title: string}; lit: boolean; won: boolean}) {
  const v = useValue(0);
  useEffect(() => {
    const a = tween(v, lit ? 1 : 0, lit ? 90 : 160, {easing: EASE});
    a.start();
    return () => a.stop();
  }, [lit, v]);
  return (
    <View style={s.duelCard}>
      <Animated.View style={[s.duelGlow, {opacity: v}]} pointerEvents="none">
        <Glow size={DUEL_W * 2.4} color={PLAY.gold} opacity={0.5} />
      </Animated.View>
      <Animated.View style={{transform: [{scale: v.interpolate({inputRange: [0, 1], outputRange: [0.94, 1.06]})}]}}>
        <Poster poster={p.poster} title={p.title} width={DUEL_W} height={DUEL_H} radius={14} size={15} />
        <Animated.View pointerEvents="none" style={[s.duelEdge, {opacity: v}, won && s.duelEdgeWon]} />
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  // ---- the ticket ----
  ticket: {flexDirection: 'row', gap: 8, marginTop: 8},
  tile: {
    width: 56,
    height: 72,
    borderRadius: 12,
    backgroundColor: PLAY.tile,
    borderWidth: 2,
    borderColor: 'rgba(255,209,102,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileText: {color: PLAY.ink, fontSize: 44, lineHeight: 52, fontWeight: '900', includeFontPadding: false},

  // ---- seats ----
  seats: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, rowGap: 10},
  seatsCenter: {justifyContent: 'center'},
  seat: {alignItems: 'center'},
  seatIn: {alignItems: 'center', gap: 5},
  away: {opacity: 0.45},
  face: {backgroundColor: PLAY.tileHi, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: 2, borderColor: PLAY.line},
  hostStar: {
    position: 'absolute',
    right: -2,
    top: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: PLAY.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tick: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: PLAY.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickText: {color: PLAY.auroraInk, fontSize: 13, lineHeight: 16, fontWeight: '900'},
  name: {color: PLAY.ink, fontSize: 15, lineHeight: 20, fontWeight: '800', maxWidth: '100%'},
  nameSmall: {fontSize: 13, lineHeight: 18},
  ribbon: {marginTop: 1},
  badge: {color: PLAY.inkFaint, fontSize: 13, lineHeight: 17, fontWeight: '700', marginTop: -2},
  badgeDone: {color: PLAY.green},
  free: {borderWidth: 2, borderStyle: 'dashed', borderColor: 'rgba(232,228,255,0.28)', alignItems: 'center', justifyContent: 'center'},
  freeText: {color: 'rgba(232,228,255,0.4)', fontSize: 26, lineHeight: 30, fontWeight: '300'},

  // ---- the tally ----
  tally: {flexDirection: 'row', alignItems: 'center', gap: 5},
  dot: {width: 8, height: 8, borderRadius: 4, marginHorizontal: 7, backgroundColor: 'rgba(232,228,255,0.3)'},

  // ---- the reveal ----
  showIn: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18},
  showWords: {color: PLAY.ink, fontSize: 34, lineHeight: 42, fontWeight: '900', textAlign: 'center', includeFontPadding: false},
  showStars: {flexDirection: 'row', gap: 22},
  duel: {flexDirection: 'row', gap: 44, marginTop: 6},
  unseen: {opacity: 0},
  duelCard: {width: DUEL_W, height: DUEL_H, alignItems: 'center', justifyContent: 'center'},
  duelGlow: {position: 'absolute', left: (DUEL_W - DUEL_W * 2.4) / 2, top: (DUEL_H - DUEL_W * 2.4) / 2},
  duelEdge: {position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 14, borderWidth: 3, borderColor: PLAY.gold},
  duelEdgeWon: {borderWidth: 4},
  showSkip: {position: 'absolute', left: 0, right: 0, bottom: 40, alignItems: 'center'},
});

// (the badge words a seat shows, for the screen)
export const seatBadge = (m: GroupMember, voting: boolean, deck: number) =>
  m.role === 'screen' ? WORDS.screenBadge : m.away ? WORDS.awayBadge : voting && m.done ? WORDS.doneBadge : voting ? `${Math.min(m.answered || 0, deck)} of ${deck}` : m.host ? WORDS.hostBadge : '';
