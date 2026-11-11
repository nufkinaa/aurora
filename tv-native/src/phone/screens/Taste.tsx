// "Swipe your taste" on the phone — the website's #/taste and #/taste/list
// (public/js/screens/taste.js, docs/play/taste.md "The Deck"), in the Aurora Play look,
// with a real finger on the card:
//
//   drag right   Love           · the ♥ key
//   drag left    Not for me     · the ✕ key
//   drag up      Haven't seen   · the ↑ key
//   ↶ Undo       the last answer back, the card flies back in from where it went
//
// One screen, one idea: a deck of cards on a night sky, and every answer lights the sky a
// little. The card turns under the finger, its stamp fades in with the distance and the card
// underneath rises to meet it; let go early and it springs back, far or fast enough and it is
// thrown. A key slams the stamp onto the card (the card takes the hit), then throws it — the
// answer counts at once, a fast thumb is never held. Two plates under the cards: the deck runs
// out as the round does. The taste meter is an aurora ribbon with four stars that light at a
// quarter, a half, three quarters and the end; at a lit star a line pops over the card,
// made from this sitting's answers ("A pattern is showing: Comedy"). The end of a round is the
// one reward: the loved titles as a constellation, the number in gold with the meteor burst,
// the tally, what Aurora learned.
//
// Every answer is saved the moment it is given (POST …/taste/answer) and its reply brings the
// next cards, chosen knowing it (the server's tastedeck.js), so "Done" only has to leave. The
// queue, the answers, Undo and the round are the shared tasteSession.ts (the TV's — the
// site's rules); what a drag means is ../tasteSwipe.ts; what a sitting says is the kit's
// tasteRead.ts. All tested.
//
// "Edit list" (TasteList, the site's #/taste/list, unchanged): the poster grid — what you
// loved first, tap one to take it out (or another to put it in), and the "Not for me"
// answers, each one tap from being taken back.
//
// Motion is transform + opacity on the native driver, on a stage of fixed size: nothing
// around the card moves when it goes. "Remove animations" (Android accessibility): no slam,
// no throw (a quick fade), no pops, no burst; the line stays until the next answer; the
// reward is simply there.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Image,
  LayoutChangeEvent,
  PanResponder,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {StackActions} from '@react-navigation/native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {api, apiPost, apiRequest, HeroItem} from '../../api';
import {useApp} from '../../AppContext';
import {showToast} from '../../toast';
import {uiHit} from '../../telemetry'; // [analytics]
import {KEEP, TasteCard, TasteSession, Verdict} from '../../tasteSession';
import {phoneNative} from '../native';
import type {PhoneStackParamList} from '../navigation';
import {useBarTop} from '../ui/TopBar';
import {BackBar, usePageTop, useSolidBar} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import {artSrc} from '../ui/Cards';
import {gridColumns} from '../ui/Grid';
import Tap from '../ui/Tap';
import {ChipButton, GlassButton, PrimaryButton} from '../ui/Buttons';
import {
  cardLabel,
  cardMeta,
  cardSize,
  DIST_X,
  DIST_Y,
  editPool,
  endWords,
  flyTo,
  GLYPH,
  keyOf,
  LABEL,
  likedEntry,
  lovedLine,
  shuffled,
  SKIP_STAMP_X,
  STAMP,
  swipeVerdict,
  TasteTitle,
  TILT,
} from '../tasteSwipe';
import {colors, GUTTER} from '../theme';
import Burst from '../../play/Burst';
import Meter from '../../play/Meter';
import SkyLines from '../../play/SkyLines';
import {Pill} from '../../play/Motion';
import {Plates} from '../../play/Cards';
import {layerAt} from '../../play/deck';
import {EASE, SPRING, tween, useCalm, useInFront, useTimers} from '../../play/anim';
import {constellation, MAX_STARS, seedOf} from '../../play/constellation';
import {litAt, milestone, readTaste} from '../../play/tasteRead';
import {Star} from '../../play/Star';
import {PLAY} from '../../play/tokens';
import {Eyebrow, In, Key, PlayRoom, ty, usePress} from '../play/ui';
import {learnedTags, tallyChips} from '../play/gameWords';

// the answers' colours (play.css: LOVE in aurora green, NOPE in rose, HAVEN'T SEEN pale)
const TINT: Record<Verdict, string> = {love: PLAY.yes, nope: PLAY.no, skip: PLAY.maybe};
const INFO_FADE = 'linear-gradient(to top, rgba(4,4,14,0.96) 0%, rgba(4,4,14,0.8) 45%, rgba(4,4,14,0) 100%)';

const A11Y_ACTIONS = (['love', 'nope', 'skip'] as Verdict[]).map(v => ({name: v, label: LABEL[v]}));

type StampLevel = Animated.AnimatedInterpolation<number> | Animated.AnimatedMultiplication<number> | Animated.Value | number;

/** A thick rubber stamp: LOVE / NOPE / HAVEN'T SEEN. */
function RubberStamp({v, level, scale}: {v: Verdict; level: StampLevel; scale?: StampLevel}) {
  return (
    <Animated.View pointerEvents="none" style={[v === 'skip' ? s.stampSkipRow : s.stampSide, {opacity: level as never}]}>
      <Animated.View
        style={[
          s.stamp,
          v === 'love' ? s.stampLove : v === 'nope' ? s.stampNope : null,
          {borderColor: TINT[v]},
          scale != null ? {transform: [...(v === 'love' ? [{rotate: '-12deg'}] : v === 'nope' ? [{rotate: '12deg'}] : []), {scale: scale as never}]} : null,
        ]}>
        <Text style={[s.stampText, v === 'skip' && s.stampTextSkip, {color: TINT[v]}]}>{STAMP[v]}</Text>
      </Animated.View>
    </Animated.View>
  );
}

/** The poster (or its title on a tile), the stamps, and what it is at the foot. */
function CardFace({card, w, info = true, stamps}: {card: TasteCard; w: number; info?: boolean; stamps?: Partial<Record<Verdict, {level: StampLevel; scale?: StampLevel}>>}) {
  const {src} = artSrc(card.poster, w);
  const [failed, setFailed] = useState(false);
  const meta = cardMeta(card);
  return (
    <>
      {src && !failed ? (
        <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} onError={() => setFailed(true)} />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.fallback]}>
          <Star size={34} color="rgba(232,228,255,0.3)" />
          <Text style={s.fallbackText}>{card.title}</Text>
        </View>
      )}
      {info ? (
        <View pointerEvents="none" style={s.info}>
          <Text style={s.title} numberOfLines={2}>
            {card.title}
          </Text>
          {meta ? <Text style={s.meta}>{meta}</Text> : null}
          {card.line ? (
            <Text style={s.line} numberOfLines={2}>
              {card.line}
            </Text>
          ) : null}
        </View>
      ) : null}
      {stamps ? (Object.keys(stamps) as Verdict[]).map(v => <RubberStamp key={v} v={v} level={stamps[v]!.level} scale={stamps[v]!.scale} />) : null}
    </>
  );
}

/** An arcade key: the glyph on a thick disc with a bottom edge, its word under it. It flashes
 *  when its answer is given any other way (so a drag teaches the keys). */
function AnswerKey({verdict, onPress, off, hit, calm}: {verdict: Verdict; onPress: () => void; off: boolean; hit: Animated.Value; calm: boolean}) {
  const big = verdict !== 'skip';
  const uiId = verdict === 'love' ? 'taste.love' : verdict === 'nope' ? 'taste.nope' : 'taste.skip';
  const press = usePress(calm);
  return (
    <Tap uiId={uiId} flat rippleColor="rgba(0,0,0,0)" disabled={off} accessibilityRole="button" accessibilityLabel={LABEL[verdict]} onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut} style={s.answer}>
      <Animated.View
        style={[
          s.disc,
          big ? s.discBig : s.discSmall,
          verdict === 'love' ? s.discLove : verdict === 'nope' ? s.discNope : s.discSkip,
          {transform: [{scale: Animated.multiply(press.scale, hit.interpolate({inputRange: [0, 1], outputRange: [1, 1.14]}))}]},
        ]}>
        <Text style={[s.discGlyph, !big && s.discGlyphSmall, {color: verdict === 'skip' ? PLAY.ink : '#1b0f22'}]}>{`${GLYPH[verdict]}︎`}</Text>
      </Animated.View>
      <Text style={s.answerLabel}>{LABEL[verdict]}</Text>
    </Tap>
  );
}

// Each card's own motion, made once per card and dropped when it has flown off: where the
// finger (or a flight) has it, how far it has stepped forward from behind (lift 0 → 1), its
// fade, whether its stamps follow the drag (off while Undo flies it back in), and the slam of a
// stamp given with a key. A card that is answered keeps its element and its values, so it flies
// on from where the finger let go — nothing has to be reset under it.
type CardAnim = {
  xy: Animated.ValueXY;
  lift: Animated.Value;
  fade: Animated.Value;
  gate: Animated.Value;
  slam: Animated.Value;
  stamps: Record<Verdict, Animated.AnimatedMultiplication<number>>;
};
function makeAnim(): CardAnim {
  const xy = new Animated.ValueXY({x: 0, y: 0});
  const lift = new Animated.Value(0);
  const fade = new Animated.Value(1);
  const gate = new Animated.Value(1);
  const slam = new Animated.Value(1);
  const clamp = 'clamp' as const;
  // the site's stamps: love / nope by how far sideways, skip by how far up while nearly straight
  const upright = xy.x.interpolate({inputRange: [-SKIP_STAMP_X, -SKIP_STAMP_X + 1, SKIP_STAMP_X - 1, SKIP_STAMP_X], outputRange: [0, 1, 1, 0], extrapolate: clamp});
  return {
    xy,
    lift,
    fade,
    gate,
    slam,
    stamps: {
      love: Animated.multiply(xy.x.interpolate({inputRange: [0, DIST_X], outputRange: [0, 1], extrapolate: clamp}), gate),
      nope: Animated.multiply(xy.x.interpolate({inputRange: [-DIST_X, 0], outputRange: [1, 0], extrapolate: clamp}), gate),
      skip: Animated.multiply(Animated.multiply(xy.y.interpolate({inputRange: [-DIST_Y, 0], outputRange: [1, 0], extrapolate: clamp}), upright), gate),
    },
  };
}
const OUT = Easing.bezier(0.2, 0.7, 0.3, 1);
const SLAM_MS = 190;

type Flying = {card: TasteCard; verdict: Verdict; n: number; slammed: boolean};

/** The round's end — the one reward: the loved titles as a constellation, the number in gold,
 *  the tally, what Aurora learned, Keep going / Done. */
function Reward({session, dry, calm, width, onMore, onDone, onNumber}: {
  session: TasteSession;
  dry: boolean;
  calm: boolean;
  width: number;
  onMore: () => void;
  onDone: () => void;
  onNumber: (x: number, y: number) => void;
}) {
  const loved = session.history.filter(h => h.verdict === 'love');
  const read = readTaste(session.history.map(h => ({verdict: h.verdict, genres: h.card.genres})));
  const skyW = Math.min(320, width - 40);
  const sky = useMemo(() => constellation(loved.length, seedOf(loved.map(h => h.card.imdbId).join('')), {w: skyW, h: 110}), [loved.length, skyW]); // eslint-disable-line react-hooks/exhaustive-deps
  const end = endWords(session.answered, session.tally, dry);
  const tags = learnedTags(read);
  const chips = tallyChips(session.tally);
  const numRef = useRef<View>(null);
  const blank = !session.answered;
  return (
    <View style={s.reward} accessibilityLiveRegion="polite">
      <View style={s.rewardBody}>
        {sky.points.length ? (
          <View style={{width: skyW, height: 110}} accessible accessibilityLabel={`${Math.min(loved.length, MAX_STARS)} stars lit, one for each title you loved.`}>
            <SkyLines points={sky.points} lines={sky.lines} width={skyW} height={110} calm={calm} step={70} delay={120} />
          </View>
        ) : null}
        {dry ? (
          <In calm={calm} delay={230}>
            <Text style={[ty.h2, s.endTitle]} accessibilityRole="header">
              {end.title}
            </Text>
          </In>
        ) : (
          <In calm={calm} delay={230} pop>
            <View
              ref={numRef}
              collapsable={false}
              onLayout={() => numRef.current?.measureInWindow((x, y, w, h) => onNumber(x + w / 2, y + h / 2))}
              style={s.endNumWrap}>
              <Text style={s.endNum} accessibilityRole="header" accessibilityLabel={end.title}>
                {session.answered}
              </Text>
              <Text style={s.endWords}>answers — Home is already using them</Text>
            </View>
          </In>
        )}
        {blank ? null : (
          <In calm={calm} delay={340} style={s.tally}>
            {chips.map(c => (
              <View key={c.key} style={[s.tchip, c.key === 'love' ? s.tchipLove : c.key === 'nope' ? s.tchipNope : null]}>
                <Text style={[s.tchipText, {color: c.key === 'skip' ? PLAY.inkDim : TINT[c.key]}]}>{c.label.replace('♥', '♥︎')}</Text>
              </View>
            ))}
          </In>
        )}
        {tags.length ? (
          <In calm={calm} delay={450} style={s.learned}>
            <Eyebrow>Aurora learned</Eyebrow>
            <View style={s.tags}>
              {tags.map(t => (
                <View key={t.label} style={[s.tag, t.lit ? s.tagLit : s.tagDim]}>
                  {t.lit ? <Star size={12} color={PLAY.gold} /> : null}
                  <Text style={[s.tagText, t.lit ? {color: PLAY.goldHi} : {color: 'rgba(232,228,255,0.6)'}]}>{t.label}</Text>
                </View>
              ))}
            </View>
          </In>
        ) : null}
      </View>
      <In calm={calm} delay={560} style={s.endKeys}>
        {end.keepGoing ? <Key uiId="taste.more" kind="aurora" label="Keep going" onPress={onMore} calm={calm} /> : null}
        <Key uiId="taste.done" kind="gold" label="Done" onPress={onDone} calm={calm} />
      </In>
    </View>
  );
}

export default function Taste({navigation}: NativeStackScreenProps<PhoneStackParamList, 'Taste'>) {
  const {profileId} = useApp();
  const barTop = useBarTop();
  const bottom = useTabBarSpace();
  const win = useWindowDimensions();
  const front = useInFront(navigation as never);
  const session = useRef(new TasteSession()).current;
  const [, setTick] = useState(0);
  const repaint = useCallback(() => setTick(t => t + 1), []);
  const [loaded, setLoaded] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [stage, setStage] = useState({w: 0, h: 0});
  const [flying, setFlying] = useState<Flying[]>([]);
  const busy = useRef<Promise<unknown>>(Promise.resolve());
  const calm = useCalm();
  const calmRef = useRef(calm);
  calmRef.current = calm;
  const timers = useTimers();
  const {w: cardW, h: cardH} = cardSize(stage.w, Math.max(0, stage.h - 26)); // (room for the deck under the card)
  const [say, setSay] = useState<{text: string; n: number} | null>(null);
  const said = useRef(new Set<string>());
  const bursts = useRef(new Set<number>());
  const [burst, setBurst] = useState({n: 0, x: 0, y: 0, count: 16});
  const hits = useRef({love: new Animated.Value(0), nope: new Animated.Value(0), skip: new Animated.Value(0)} as Record<Verdict, Animated.Value>).current;

  const anims = useRef(new Map<string, CardAnim>()).current;
  const animOf = useCallback(
    (id: string) => {
      let a = anims.get(id);
      if (!a) {
        a = makeAnim();
        anims.set(id, a);
      }
      return a;
    },
    [anims],
  );

  // ---------- the first cards ----------
  const first = useCallback(() => {
    setLoaded('loading');
    api
      .tasteDeck(profileId, KEEP + 2)
      .then(r => {
        session.goal = r.goal || session.goal;
        session.more = r.more || session.more;
        session.take(r.cards);
        setLoaded('ok');
      })
      .catch(() => setLoaded('failed'));
  }, [profileId, session]);
  useEffect(first, [first]);

  const cur = session.current;
  const next = session.behind;
  const topId = useRef<string | null>(null);
  topId.current = cur ? cur.imdbId : null;

  // the card on show steps forward from behind; the one behind sits back (after an Undo)
  const curId = cur ? cur.imdbId : null;
  const nextId = next ? next.imdbId : null;
  useEffect(() => {
    if (!curId) return;
    const a = animOf(curId);
    a.lift.stopAnimation(v => {
      if (v < 1) Animated.timing(a.lift, {toValue: 1, duration: calmRef.current ? 120 : 300, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
    });
  }, [curId, animOf]);
  useEffect(() => {
    if (!nextId) return;
    const a = animOf(nextId);
    a.xy.stopAnimation();
    a.xy.setValue({x: 0, y: 0});
    a.fade.setValue(1);
    a.slam.setValue(1);
    a.lift.stopAnimation(v => {
      if (v > 0) Animated.timing(a.lift, {toValue: 0, duration: calmRef.current ? 120 : 260, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
    });
  }, [nextId, animOf]);

  // ---------- the meter's stars and what they say ----------
  const shown = Math.min(session.answered, session.goal);
  const lit = litAt(session.answered, session.goal);
  const litRef = useRef(lit);
  useEffect(() => {
    const was = litRef.current;
    litRef.current = lit;
    if (lit <= was || lit < 1 || lit > 3) return;
    const key = `${session.goal}:${lit}`;
    if (said.current.has(key)) return;
    said.current.add(key);
    const text = milestone(lit, readTaste(session.history.map(h => ({verdict: h.verdict, genres: h.card.genres}))));
    if (text) setSay(sv => ({text, n: (sv ? sv.n : 0) + 1}));
  }, [lit, session]);

  // ---------- motion ----------
  const flights = useRef(0);
  const fly = useCallback(
    (verdict: Verdict, card: TasteCard, from: {dx: number; dy: number} | null) => {
      const a = animOf(card.imdbId);
      const n = ++flights.current;
      const slammed = !from && !calmRef.current;
      setFlying(l => [...l.filter(f => f.card.imdbId !== card.imdbId), {card, verdict, n, slammed}]);
      const landed = ({finished}: {finished: boolean}) => {
        setFlying(l => l.filter(f => f.n !== n));
        // gone for good (not brought back with Undo half way): its values go too
        if (finished && !session.queue.some(c => c.imdbId === card.imdbId)) anims.delete(card.imdbId);
      };
      a.xy.stopAnimation();
      a.fade.stopAnimation();
      if (calmRef.current) {
        Animated.timing(a.fade, {toValue: 0, duration: 140, useNativeDriver: true}).start(landed);
        return;
      }
      const t = flyTo(verdict, from, win.width, win.height);
      const throwIt = Animated.parallel([
        Animated.timing(a.xy, {toValue: {x: t.x, y: t.y}, duration: 300, easing: Easing.in(Easing.quad), useNativeDriver: true}),
        Animated.timing(a.fade, {toValue: 0, duration: 300, easing: Easing.in(Easing.quad), useNativeDriver: true}),
      ]);
      if (!slammed) {
        Animated.parallel([
          Animated.timing(a.xy, {toValue: {x: t.x, y: t.y}, duration: 300, easing: OUT, useNativeDriver: true}),
          Animated.timing(a.fade, {toValue: 0, duration: 300, easing: Easing.in(Easing.quad), useNativeDriver: true}),
        ]).start(landed);
        return;
      }
      // a key: the stamp is slammed on (big to its size), the card takes the hit, then it is thrown
      a.slam.setValue(0);
      const nudge = verdict === 'love' ? 14 : verdict === 'nope' ? -14 : 0;
      Animated.sequence([
        Animated.parallel([
          tween(a.slam, 1, SLAM_MS, {easing: EASE}),
          Animated.timing(a.xy, {toValue: {x: nudge, y: verdict === 'skip' ? -10 : 4}, duration: SLAM_MS, easing: SPRING, useNativeDriver: true}),
        ]),
        throwIt,
      ]).start(landed);
    },
    [animOf, anims, session, win.width, win.height],
  );

  const flashKey = useCallback(
    (v: Verdict) => {
      if (calmRef.current) return;
      const h = hits[v];
      h.stopAnimation();
      h.setValue(0);
      Animated.sequence([tween(h, 1, 110), tween(h, 0, 320, {easing: SPRING})]).start();
    },
    [hits],
  );

  // ---------- answering ----------
  const answer = useCallback(
    (verdict: Verdict, from: {dx: number; dy: number} | null = null) => {
      const entry = session.answer(verdict);
      if (!entry) return;
      fly(verdict, entry.card, from);
      flashKey(verdict);
      phoneNative.haptic('tick');
      if (!calmRef.current) setSay(sv => sv); // (a line on show stays its own time)
      else setSay(null);
      repaint();
      // saved now; the reply brings the next cards, chosen with this answer known
      const queued = session.queuedIds(2);
      busy.current = busy.current.then(async () => {
        try {
          const r = await api.tasteAnswer(profileId, {imdbId: entry.card.imdbId, id: entry.card.id, title: entry.card.title, verdict, queued, n: KEEP - 2});
          session.settle(entry, r.was || null);
          session.take(r.cards, true);
        } catch {
          // not saved: the card comes back, as if it had not been answered
          if (session.fail(entry)) {
            const a = animOf(entry.card.imdbId);
            setFlying(l => l.filter(f => f.card.imdbId !== entry.card.imdbId));
            a.xy.stopAnimation();
            a.fade.stopAnimation();
            a.xy.setValue({x: 0, y: 0});
            a.fade.setValue(1);
            a.slam.setValue(1);
            showToast("Couldn't save that answer — try again", '⚠️');
          }
        }
        repaint();
      });
    },
    [session, fly, flashKey, repaint, profileId, animOf],
  );
  const answerRef = useRef(answer);
  answerRef.current = answer;

  const undo = useCallback(() => {
    const last = session.undo();
    if (!last) return;
    const id = last.card.imdbId;
    const a = animOf(id);
    const midFlight = flying.some(f => f.card.imdbId === id);
    setFlying(l => l.filter(f => f.card.imdbId !== id));
    a.xy.stopAnimation();
    a.fade.stopAnimation();
    a.lift.stopAnimation();
    a.lift.setValue(1);
    a.slam.setValue(1);
    if (calmRef.current) {
      a.xy.setValue({x: 0, y: 0});
      a.fade.setValue(0);
      Animated.timing(a.fade, {toValue: 1, duration: 140, useNativeDriver: true}).start();
    } else {
      // it comes back from where it went
      if (!midFlight) {
        const t = flyTo(last.verdict, null, win.width, win.height);
        a.xy.setValue({x: t.x, y: t.y});
        a.fade.setValue(0);
      }
      a.gate.setValue(0);
      Animated.parallel([
        Animated.timing(a.xy, {toValue: {x: 0, y: 0}, duration: 320, easing: OUT, useNativeDriver: true}),
        Animated.timing(a.fade, {toValue: 1, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true}),
      ]).start(() => a.gate.setValue(1));
    }
    repaint();
    // put the old answer back (null when it had none) — after the answer's own reply, when `was` is known
    busy.current = busy.current
      .then(() => api.tasteAnswer(profileId, {imdbId: last.card.imdbId, id: last.card.id, title: last.card.title, verdict: last.was}))
      .catch(() => showToast("Couldn't undo that one", '⚠️'));
  }, [session, animOf, flying, win.width, win.height, repaint, profileId]);

  const keepGoing = useCallback(() => {
    setFlying([]);
    session.keepGoing();
    repaint();
    if (session.queue.length < 2) {
      api
        .tasteDeck(profileId, KEEP - session.queue.length, session.queuedIds(KEEP))
        .then(r => {
          session.take(r.cards);
          repaint();
        })
        .catch(() => showToast("Couldn't load more titles", '⚠️'));
    }
  }, [session, repaint, profileId]);

  const done = useCallback(() => navigation.goBack(), [navigation]);

  // ---------- the finger ----------
  const held = useRef<string | null>(null);
  const responder = useMemo(() => {
    const back = () => {
      const a = held.current ? anims.get(held.current) : null;
      held.current = null;
      if (a) Animated.spring(a.xy, {toValue: {x: 0, y: 0}, friction: 6, tension: 80, useNativeDriver: true}).start();
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        held.current = topId.current;
        const a = held.current ? anims.get(held.current) : null;
        a?.xy.stopAnimation();
        a?.gate.setValue(1);
      },
      onPanResponderMove: (_e, g) => {
        const a = held.current ? anims.get(held.current) : null;
        a?.xy.setValue({x: g.dx, y: g.dy});
      },
      onPanResponderRelease: (_e, g) => {
        const v = swipeVerdict({dx: g.dx, dy: g.dy, vx: g.vx, vy: g.vy});
        if (v && held.current && held.current === topId.current) {
          held.current = null;
          uiHit('taste.swipe', 'touch'); // [analytics]
          answerRef.current(v, {dx: g.dx, dy: g.dy});
          return;
        }
        back(); // not far enough: back to the middle
      },
      onPanResponderTerminate: back,
    });
  }, [anims]);

  // ---------- drawing ----------
  const over = loaded === 'ok' && session.roundOver;
  const dry = session.exhausted && !session.queue.length;
  const answersOff = loaded !== 'ok' || over || !cur;

  // the round's one reward: a meteor burst from the number (a smaller one for later rounds; never twice)
  const onNumber = useCallback(
    (x: number, y: number) => {
      if (calmRef.current || dry || bursts.current.has(session.goal)) return;
      const firstRound = !bursts.current.size;
      bursts.current.add(session.goal);
      timers.after(380, () => setBurst(b => ({n: b.n + 1, x, y, count: firstRound ? 16 : 9})));
      phoneNative.haptic('confirm');
    },
    [dry, session, timers],
  );

  // behind, on show, then the ones flying off on top — all keyed by title in one list, so a
  // card keeps its element (and its picture) from behind to on show to flying away
  const deck: {card: TasteCard; place: 'behind' | 'top' | Verdict}[] = [];
  if (!over) {
    if (next) deck.push({card: next, place: 'behind'});
    if (cur) deck.push({card: cur, place: 'top'});
  }
  for (const f of flying) if (!deck.some(d => d.card.imdbId === f.card.imdbId)) deck.push({card: f.card, place: f.verdict});

  const onStage = (e: LayoutChangeEvent) => {
    const {width, height} = e.nativeEvent.layout;
    setStage(st => (Math.abs(st.w - width) < 1 && Math.abs(st.h - height) < 1 ? st : {w: width, h: height}));
  };

  // the card under the one on show rises to meet the finger
  const topA = cur ? animOf(cur.imdbId) : null;
  const pull = topA ? topA.xy.x.interpolate({inputRange: [-DIST_X, 0, DIST_X], outputRange: [1, 0, 1], extrapolate: 'clamp'}) : null;
  const rest = layerAt(0, cardH);
  const styleOf = (a: CardAnim, place: 'behind' | 'top' | Verdict) => {
    const up = a.lift.interpolate({inputRange: [0, 1], outputRange: [rest.translateY, 0]});
    const scale = a.lift.interpolate({inputRange: [0, 1], outputRange: [rest.scale, 1]});
    const pulled = place === 'behind' && pull;
    return {
      opacity: a.fade,
      transform: [
        {translateX: a.xy.x},
        {translateY: Animated.add(a.xy.y, pulled ? Animated.multiply(up, pull.interpolate({inputRange: [0, 1], outputRange: [1, 0.45]})) : up)},
        {rotate: a.xy.x.interpolate({inputRange: [-1000, 1000], outputRange: [`${-1000 * TILT}deg`, `${1000 * TILT}deg`]})},
        {scale: pulled ? Animated.add(scale, pull.interpolate({inputRange: [0, 1], outputRange: [0, 0.025]})) : scale},
      ],
    };
  };

  let stageBody: React.ReactNode = null;
  if (loaded === 'failed') {
    stageBody = (
      <View style={s.center}>
        <Text style={s.endText}>Couldn't load titles — try again in a moment.</Text>
        <Key uiId="phone.taste.retry" small label="Try again" onPress={first} calm={calm} />
      </View>
    );
  } else if (loaded === 'loading' || (!over && !cur)) {
    stageBody = (
      <View style={s.center}>
        <ActivityIndicator color={PLAY.ink} />
      </View>
    );
  } else if (over) {
    stageBody = <Reward session={session} dry={dry} calm={calm} width={stage.w || win.width} onMore={keepGoing} onDone={done} onNumber={onNumber} />;
  }

  const left = Math.max(0, session.goal - session.answered);
  const meterW = Math.max(90, win.width - GUTTER * 2 - 64 - 44 - 96 - 24);

  return (
    <View style={[s.root, {paddingTop: barTop + 56, paddingBottom: bottom}]}>
      <PlayRoom calm={calm} on={front} />
      <View style={s.head}>
        <View style={s.titleRow}>
          <Text style={s.h1} accessibilityRole="header">
            What's your taste?
          </Text>
          <PrimaryButton uiId="taste.done" label="Done" onPress={done} style={s.done} />
        </View>
        <View style={s.headRow}>
          <View style={s.progress} accessible accessibilityLabel={`${shown} of ${session.goal} answered`}>
            <Meter value={session.progress} width={meterW} height={8} lit={lit} calm={calm} />
            <Text style={s.count}>
              {shown} / {session.goal}
            </Text>
          </View>
          <Tap uiId="taste.undo" flat disabled={!session.history.length} accessibilityRole="button" accessibilityLabel="Undo" onPress={undo} style={[s.undo, !session.history.length && s.off]}>
            <Text style={s.undoGlyph}>↶</Text>
          </Tap>
          <GlassButton uiId="taste.edit" small label="Edit list" onPress={() => navigation.push('TasteList')} style={s.tool} />
        </View>
      </View>

      <View style={s.stage} onLayout={onStage}>
        {stageBody}
        {loaded === 'ok' && cardW > 0 && deck.length ? (
          <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, s.center, {paddingBottom: 22}]}>
            <View pointerEvents="box-none" style={{width: cardW, height: cardH}}>
              {/* the deck under the cards: two plates, then one, then none */}
              <View pointerEvents="none" style={{position: 'absolute', left: 0, top: 0, transform: [{translateY: 0}]}}>
                <Plates left={left} width={cardW} height={cardH} radius={22} />
              </View>
              {deck.map(({card, place}) => {
                const a = animOf(card.imdbId);
                const top = place === 'top';
                const off = place !== 'top' && place !== 'behind';
                const f = off ? flying.find(x => x.card.imdbId === card.imdbId) : null;
                const stamps = off
                  ? {
                      [place as Verdict]: f && f.slammed
                        ? {level: a.slam.interpolate({inputRange: [0, 0.35, 1], outputRange: [0, 1, 1]}), scale: a.slam.interpolate({inputRange: [0, 0.75, 1], outputRange: [2.2, 0.94, 1]})}
                        : {level: 1},
                    }
                  : top
                  ? {love: {level: a.stamps.love}, nope: {level: a.stamps.nope}, skip: {level: a.stamps.skip}}
                  : undefined;
                return (
                  <Animated.View
                    key={card.imdbId}
                    {...(top ? responder.panHandlers : {})}
                    pointerEvents={top ? 'auto' : 'none'}
                    accessible={top}
                    importantForAccessibility={top ? 'yes' : 'no-hide-descendants'}
                    accessibilityLabel={top ? cardLabel(card) : undefined}
                    accessibilityActions={top ? A11Y_ACTIONS : undefined}
                    onAccessibilityAction={top ? e => answer(e.nativeEvent.actionName as Verdict) : undefined}
                    style={[s.card, {width: cardW, height: cardH}, styleOf(a, place) as never]}>
                    <CardFace card={card} w={cardW} info={place !== 'behind'} stamps={stamps as never} />
                  </Animated.View>
                );
              })}
            </View>
          </View>
        ) : null}
        {/* a lit star's line, over the top edge of the card */}
        <View pointerEvents="none" style={s.pillRow}>
          <Pill say={over ? null : say} calm={calm} />
        </View>
      </View>

      <View style={[s.answers, answersOff && s.answersOff]} pointerEvents={answersOff ? 'none' : 'auto'} importantForAccessibility={answersOff ? 'no-hide-descendants' : 'auto'}>
        <AnswerKey verdict="nope" off={answersOff} onPress={() => answer('nope')} hit={hits.nope} calm={calm} />
        <AnswerKey verdict="skip" off={answersOff} onPress={() => answer('skip')} hit={hits.skip} calm={calm} />
        <AnswerKey verdict="love" off={answersOff} onPress={() => answer('love')} hit={hits.love} calm={calm} />
      </View>
      <Burst fire={burst.n} x={burst.x} y={burst.y} count={burst.count} calm={calm} reach={Math.max(win.width, 600) * 0.8} />
      <BackBar />
    </View>
  );
}

// ---------- Edit list: the poster grid (#/taste/list) ----------

type TasteNow = {liked: TasteTitle[]; disliked: TasteTitle[]};
// (as the site keeps them: a catalogue title by its IMDb id, a library one by its own id)
const fromCatalog = (i: HeroItem): TasteTitle => ({imdbId: i.imdbId, title: i.title, cover: i.cover || i.poster || null, year: i.year});
const fromLibrary = (i: HeroItem): TasteTitle => ({id: i.id, title: i.title, cover: i.cover || null, year: i.year});

const Tile = React.memo(function Tile({t, on, w, onToggle}: {t: TasteTitle; on: boolean; w: number; onToggle: (t: TasteTitle) => void}) {
  const {src} = artSrc(t.cover, w);
  const [failed, setFailed] = useState(false);
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={t.title}
      accessibilityState={{selected: on}}
      onPress={() => onToggle(t)}
      style={[s.tile, {width: w, height: Math.round(w * 1.5)}, on && s.tileOn]}>
      {src && !failed ? (
        <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} onError={() => setFailed(true)} />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.fallback]}>
          <Text style={s.tileText} numberOfLines={3}>
            {t.title}
          </Text>
        </View>
      )}
      {on ? <View style={[StyleSheet.absoluteFill, s.tileDim]} /> : null}
      <View style={[s.check, on && s.checkOn]}>
        <Text style={[s.checkText, on && {color: '#fff'}]}>♥</Text>
      </View>
    </Tap>
  );
});

export function TasteList({navigation}: NativeStackScreenProps<PhoneStackParamList, 'TasteList'>) {
  const {profileId} = useApp();
  const bar = useSolidBar();
  const top = usePageTop();
  const bottom = useTabBarSpace();
  const {width} = useWindowDimensions();
  const [pool, setPool] = useState<TasteTitle[] | null>(null);
  const [nopes, setNopes] = useState<TasteTitle[]>([]);
  const [err, setErr] = useState(false);
  const [picked, setPicked] = useState<Map<string, TasteTitle>>(new Map());
  const pickedRef = useRef(picked);
  pickedRef.current = picked;

  const load = useCallback(() => {
    setErr(false);
    setPool(null);
    // Taste needs RANGE, not an inventory of what's already downloaded — the wide catalogue
    // (top + trending, films + series) with a modest slice of the library mixed in
    const cat = (type: 'movie' | 'show', category: string) => api.catalog({type, category}).catch(() => null);
    Promise.all([
      api.library().catch(() => ({movies: [], shows: []})),
      apiRequest<TasteNow>(`/api/profiles/${encodeURIComponent(profileId)}/taste`),
      cat('movie', 'top'),
      cat('movie', 'trending'),
      cat('show', 'top'),
      cat('show', 'trending'),
    ])
      .then(([lib, taste, ...cats]) => {
        const liked = taste.liked || [];
        const catalog = shuffled(cats.flatMap(c => (c && c.items) || [])).map(fromCatalog);
        const library = shuffled([...(lib.movies || []), ...(lib.shows || [])]).slice(0, 15).map(fromLibrary);
        setPicked(new Map(liked.map(t => [keyOf(t), t] as [string, TasteTitle])));
        setNopes((taste.disliked || []).slice().reverse());
        setPool(editPool(liked, catalog, library));
      })
      .catch(() => setErr(true));
  }, [profileId]);
  useEffect(load, [load]);

  // each tap saved a moment later (a run of taps goes as one), and on the way out
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (!saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    apiPost(`/api/profiles/${encodeURIComponent(profileId)}/taste`, {liked: [...pickedRef.current.values()].map(likedEntry)}).catch(() =>
      showToast("Couldn't save your picks", '⚠️'),
    );
  }, [profileId]);
  useEffect(() => () => flush(), [flush]);
  const toggle = useCallback(
    (t: TasteTitle) => {
      const k = keyOf(t);
      setPicked(m => {
        const n = new Map(m);
        if (n.has(k)) n.delete(k);
        else n.set(k, likedEntry(t));
        pickedRef.current = n;
        return n;
      });
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        apiPost(`/api/profiles/${encodeURIComponent(profileId)}/taste`, {liked: [...pickedRef.current.values()].map(likedEntry)}).catch(() =>
          showToast("Couldn't save your picks", '⚠️'),
        );
      }, 600);
    },
    [profileId],
  );

  const unNope = useCallback(
    async (t: TasteTitle) => {
      try {
        await api.tasteAnswer(profileId, {imdbId: t.imdbId || '', title: t.title, verdict: null});
        setNopes(list => list.filter(x => keyOf(x) !== keyOf(t)));
      } catch {
        showToast("Couldn't change that", '⚠️');
      }
    },
    [profileId],
  );

  // "← Back to swiping": the swipe page under this one, or a fresh one in its place
  const backToSwiping = () => {
    const routes = navigation.getState().routes;
    if (routes.length > 1 && routes[routes.length - 2].name === 'Taste') navigation.goBack();
    else navigation.dispatch(StackActions.replace('Taste'));
  };
  // Done: back to Settings (the site goes to #/preferences)
  const finish = () => {
    flush();
    const routes = navigation.getState().routes;
    const at = routes.map(r => r.name).lastIndexOf('Settings');
    if (at >= 0 && at < routes.length - 1) navigation.dispatch(StackActions.pop(routes.length - 1 - at));
    else navigation.goBack();
  };

  const cols = gridColumns(width);
  const GAP = width <= 900 ? 12 : 18;
  const tileW = Math.floor((width - GUTTER * 2 - GAP * (cols - 1)) / cols);

  const header = (
    <View style={{paddingTop: top, paddingBottom: 16}}>
      <View style={s.listHead}>
        <Text style={s.listH1} accessibilityRole="header">
          What do you love?
        </Text>
        <Text style={s.listCount}>{lovedLine(picked.size)}</Text>
      </View>
      <Text style={s.note}>Tap the ones you'd defend in an argument. Home learns from these — you can come back and change them anytime.</Text>
      <GlassButton uiId="taste.back" small label="← Back to swiping" onPress={backToSwiping} style={{alignSelf: 'flex-start', marginTop: 14}} />
    </View>
  );
  const footer = (
    <View style={{paddingBottom: bottom + 90}}>
      {nopes.length ? (
        <View style={{marginTop: 28}}>
          <Text style={s.nopesH2} accessibilityRole="header">
            Not for you
          </Text>
          <View style={s.nopeChips}>
            {nopes.map(t => (
              <ChipButton uiId="taste.unnope" key={keyOf(t) || t.title} label={`${t.title}  ✕`} onPress={() => unNope(t)} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={s.root}>
      {err ? (
        <View style={[s.center, {paddingTop: top}]}>
          <Text style={s.endText}>Couldn't load titles — try again in a moment.</Text>
          <GlassButton uiId="phone.taste.retry" small label="Try again" icon="refresh" onPress={load} style={{marginTop: 8}} />
        </View>
      ) : !pool ? (
        <ActivityIndicator color={colors.text} style={{marginTop: top + 20}} />
      ) : (
        <FlatList
          key={`cols-${cols}`}
          data={pool}
          numColumns={cols}
          keyExtractor={(t, i) => `${keyOf(t)}-${i}`}
          renderItem={({item}) => <Tile t={item} w={tileW} on={picked.has(keyOf(item))} onToggle={toggle} />}
          extraData={picked}
          columnWrapperStyle={{gap: GAP, marginBottom: 14}}
          contentContainerStyle={{paddingHorizontal: GUTTER}}
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          onScroll={bar.onScroll}
          scrollEventThrottle={32}
          initialNumToRender={cols * 5}
        />
      )}
      {/* Done floats — no scrolling a 120-poster grid just to leave */}
      {pool ? (
        <View pointerEvents="box-none" style={[s.floatDone, {bottom: bottom + 8}]}>
          <PrimaryButton label="Done" onPress={finish} />
        </View>
      ) : null}
      <BackBar solid={bar.solid} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, overflow: 'hidden'},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 12},
  off: {opacity: 0.4},
  // the head: the title and Done, then the ribbon, the count, Undo and Edit list on one line
  head: {paddingHorizontal: GUTTER, marginBottom: 10},
  titleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12},
  h1: {flexShrink: 1, color: PLAY.ink, fontSize: 23, fontWeight: '900', letterSpacing: -0.5},
  done: {minHeight: 40, height: 40, paddingHorizontal: 18},
  headRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10},
  progress: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10},
  count: {color: PLAY.inkDim, fontSize: 14.4, fontWeight: '800', fontVariant: ['tabular-nums']},
  undo: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: PLAY.line},
  undoGlyph: {color: PLAY.ink, fontSize: 18, fontWeight: '900', marginTop: -2},
  tool: {height: 40, paddingHorizontal: 14},
  // the stage: whatever height is left, the card as tall as fits (640 at most)
  stage: {flex: 1, minHeight: 240, alignItems: 'center', justifyContent: 'center'},
  pillRow: {position: 'absolute', top: -6, left: 0, right: 0, alignItems: 'center'},
  card: {
    position: 'absolute',
    left: 0,
    top: 0,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: PLAY.tile,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  fallback: {alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20, backgroundColor: PLAY.tile, experimental_backgroundImage: 'linear-gradient(160deg, #2a2266 0%, #120e34 100%)'},
  fallbackText: {color: PLAY.ink, fontSize: 21, fontWeight: '900', textAlign: 'center'},
  info: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 80, paddingHorizontal: 18, paddingBottom: 18, experimental_backgroundImage: INFO_FADE},
  title: {color: PLAY.ink, fontSize: 22, fontWeight: '900', lineHeight: 26, letterSpacing: -0.3},
  meta: {color: 'rgba(232,228,255,0.78)', fontSize: 14, fontWeight: '800', marginTop: 5},
  line: {color: 'rgba(232,228,255,0.7)', fontSize: 13.8, lineHeight: 18.6, marginTop: 6},
  // the stamps: thick rubber, on a dark plate so they read on any poster
  stamp: {paddingHorizontal: 14, paddingVertical: 4, borderWidth: 4, borderRadius: 12, backgroundColor: 'rgba(3,4,12,0.55)'},
  stampLove: {position: 'absolute', top: 26, left: 18, transform: [{rotate: '-12deg'}]},
  stampNope: {position: 'absolute', top: 26, right: 18, transform: [{rotate: '12deg'}]},
  stampSide: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  stampSkipRow: {position: 'absolute', top: '38%', left: 0, right: 0, alignItems: 'center'},
  stampText: {fontSize: 28, fontWeight: '900', letterSpacing: 2.4, includeFontPadding: false},
  stampTextSkip: {fontSize: 19},
  // the three arcade keys, the skip one smaller, their words under them
  answers: {flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-start', gap: 26, marginTop: 10, paddingBottom: 8},
  answersOff: {opacity: 0},
  answer: {alignItems: 'center', gap: 7, paddingHorizontal: 4, paddingVertical: 4, minWidth: 80},
  disc: {alignItems: 'center', justifyContent: 'center', borderBottomWidth: 4},
  discBig: {width: 64, height: 64, borderRadius: 32},
  discSmall: {width: 46, height: 46, borderRadius: 23, marginTop: 9},
  discLove: {backgroundColor: PLAY.green, experimental_backgroundImage: 'linear-gradient(180deg, #8ffad0 0%, #3fe3a3 100%)', borderBottomColor: '#1f9f70'},
  discNope: {backgroundColor: PLAY.rose, experimental_backgroundImage: 'linear-gradient(180deg, #ffa8dd 0%, #ff6fbf 100%)', borderBottomColor: '#c2408c'},
  discSkip: {backgroundColor: 'rgba(255,255,255,0.1)', borderWidth: 1, borderColor: PLAY.line, borderBottomColor: 'rgba(0,0,0,0.45)'},
  discGlyph: {fontSize: 27, fontWeight: '900', includeFontPadding: false},
  discGlyphSmall: {fontSize: 19},
  answerLabel: {color: PLAY.inkDim, fontSize: 13, fontWeight: '800'},
  // the end of a round
  reward: {flex: 1, alignSelf: 'stretch', justifyContent: 'center', paddingHorizontal: GUTTER},
  rewardBody: {alignItems: 'center', gap: 14},
  endNumWrap: {alignItems: 'center'},
  endNum: {color: PLAY.gold, fontSize: 72, lineHeight: 78, fontWeight: '900', includeFontPadding: false, textShadowColor: 'rgba(255,180,70,0.45)', textShadowRadius: 22, textShadowOffset: {width: 0, height: 0}},
  endWords: {color: PLAY.ink, fontSize: 19, fontWeight: '900', textAlign: 'center', maxWidth: 300},
  endTitle: {maxWidth: 360},
  endText: {color: PLAY.inkDim, fontSize: 15.68, textAlign: 'center', lineHeight: 22},
  tally: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8},
  tchip: {paddingHorizontal: 12, minHeight: 32, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: PLAY.line, backgroundColor: 'rgba(255,255,255,0.06)'},
  tchipLove: {borderColor: 'rgba(92,245,184,0.35)', backgroundColor: 'rgba(92,245,184,0.08)'},
  tchipNope: {borderColor: 'rgba(255,134,208,0.35)', backgroundColor: 'rgba(255,134,208,0.08)'},
  tchipText: {fontSize: 13.6, fontWeight: '800'},
  learned: {alignItems: 'center', gap: 10, marginTop: 4},
  tags: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8},
  tag: {flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34, paddingHorizontal: 13, borderRadius: 999, borderWidth: 1},
  tagLit: {borderColor: 'rgba(255,209,102,0.5)', backgroundColor: 'rgba(255,209,102,0.1)'},
  tagDim: {borderColor: 'rgba(232,228,255,0.25)', borderStyle: 'dashed'},
  tagText: {fontSize: 13.6, fontWeight: '800'},
  endKeys: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12, marginTop: 22},
  // Edit list (.taste)
  listHead: {flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 12},
  listH1: {color: colors.text, fontSize: 24, fontWeight: '900', letterSpacing: -0.72, lineHeight: 36},
  listCount: {color: colors.textFaint, fontSize: 16, fontWeight: '600'},
  note: {color: colors.textDim, fontSize: 14.4, lineHeight: 21, marginTop: 6},
  tile: {borderRadius: 12, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent', backgroundColor: colors.bgRaised},
  tileOn: {borderColor: colors.accent},
  tileDim: {backgroundColor: 'rgba(0,0,0,0.2)'},
  tileText: {color: colors.text, fontSize: 14, fontWeight: '800', textAlign: 'center'},
  check: {position: 'absolute', top: 8, right: 8, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.55)'},
  checkOn: {backgroundColor: colors.accent, transform: [{scale: 1.1}]},
  checkText: {color: 'rgba(255,255,255,0.35)', fontSize: 15},
  nopesH2: {color: colors.text, fontSize: 17.6, fontWeight: '800', marginBottom: 10},
  nopeChips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  floatDone: {position: 'absolute', left: 0, right: 0, alignItems: 'center'},
});
