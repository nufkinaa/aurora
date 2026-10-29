// "Swipe your taste" on the phone — the website's #/taste and #/taste/list
// (public/js/screens/taste.js), with a real finger on the card:
//
//   drag right   Love           · the ♥ button
//   drag left    Not for me     · the ✕ button
//   drag up      Haven't seen   · the ↑ button
//   ↶ Undo       the last answer back, the card flies back in from where it went
//
// Every answer is saved the moment it is given (POST …/taste/answer) and its
// reply brings the next cards, chosen knowing it (the server's tastedeck.js),
// so "Done" only has to leave. The queue, the answers, Undo and the round are
// the shared tasteSession.ts (the TV's — the site's rules); what a drag means
// is ../tasteSwipe.ts. Both are tested.
//
// "Edit list" (TasteList, the site's #/taste/list): the poster grid — what you
// loved first, tap one to take it out (or another to put it in), and the
// "Not for me" answers, each one tap from being taken back.
//
// Motion is transform + opacity on the native driver, on a stage of fixed
// size: nothing around the card moves when it goes. "Remove animations"
// (Android accessibility): no flight, a quick fade.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
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

const LOVE = '#6ee7a8';
const NOPE = '#ff7b8a';
const SKIP = '#cfd5ff';
const TINT: Record<Verdict, string> = {love: LOVE, nope: NOPE, skip: SKIP};
const INFO_FADE = 'linear-gradient(to top, rgba(6,7,12,0.94) 0%, rgba(6,7,12,0.78) 45%, rgba(6,7,12,0) 100%)';

const A11Y_ACTIONS = (['love', 'nope', 'skip'] as Verdict[]).map(v => ({name: v, label: LABEL[v]}));

const useCalm = () => {
  const calm = useRef(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then(on => {
        calm.current = !!on;
      })
      .catch(() => {});
  }, []);
  return calm;
};

/** The poster (or its title on a tile), the stamps, and what it is at the foot. */
function CardFace({card, w, info = true, stamps}: {card: TasteCard; w: number; info?: boolean; stamps?: Partial<Record<Verdict, Animated.AnimatedInterpolation<number> | Animated.Value | number>>}) {
  const {src} = artSrc(card.poster, w);
  const [failed, setFailed] = useState(false);
  const meta = cardMeta(card);
  return (
    <>
      {src && !failed ? (
        <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} onError={() => setFailed(true)} />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.fallback]}>
          <Text style={s.fallbackText}>{card.title}</Text>
        </View>
      )}
      {stamps
        ? (Object.keys(stamps) as Verdict[]).map(v => (
            <Animated.View key={v} pointerEvents="none" style={[v === 'skip' ? s.stampSkipRow : s.stampSide, {opacity: stamps[v] as never}]}>
              <View style={[s.stamp, v === 'love' ? s.stampLove : v === 'nope' ? s.stampNope : null, {borderColor: TINT[v]}]}>
                <Text style={[s.stampText, v === 'skip' && s.stampTextSkip, {color: TINT[v]}]}>{STAMP[v]}</Text>
              </View>
            </Animated.View>
          ))
        : null}
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
    </>
  );
}

/** One answer button: the glyph in a round glass disc, its word underneath. */
function AnswerButton({verdict, onPress, off}: {verdict: Verdict; onPress: () => void; off: boolean}) {
  const big = verdict !== 'skip';
  const uiId = verdict === 'love' ? 'taste.love' : verdict === 'nope' ? 'taste.nope' : 'taste.skip';
  return (
    <Tap uiId={uiId} flat disabled={off} accessibilityRole="button" accessibilityLabel={LABEL[verdict]} onPress={onPress} style={s.answer}>
      <View style={[s.disc, big ? s.discBig : s.discSmall]}>
        <Text style={[s.discGlyph, !big && {fontSize: 18}, {color: verdict === 'skip' ? colors.text : TINT[verdict]}]}>{GLYPH[verdict]}</Text>
      </View>
      <Text style={s.answerLabel}>{LABEL[verdict]}</Text>
    </Tap>
  );
}

// Each card's own motion, made once per card and dropped when it has flown off: where the
// finger (or a flight) has it, how far it has stepped forward from behind (lift 0 → 1), its
// fade, and whether its stamps follow the drag (off while Undo flies it back in). A card
// that is answered keeps its element and its values, so it flies on from where the finger
// let go — nothing has to be reset under it.
type CardAnim = {
  xy: Animated.ValueXY;
  lift: Animated.Value;
  fade: Animated.Value;
  gate: Animated.Value;
  style: object;
  stamps: Record<Verdict, Animated.AnimatedMultiplication<number>>;
};
function makeAnim(): CardAnim {
  const xy = new Animated.ValueXY({x: 0, y: 0});
  const lift = new Animated.Value(0);
  const fade = new Animated.Value(1);
  const gate = new Animated.Value(1);
  const clamp = 'clamp' as const;
  // the site's stamps: love / nope by how far sideways, skip by how far up while nearly straight
  const upright = xy.x.interpolate({inputRange: [-SKIP_STAMP_X, -SKIP_STAMP_X + 1, SKIP_STAMP_X - 1, SKIP_STAMP_X], outputRange: [0, 1, 1, 0], extrapolate: clamp});
  return {
    xy,
    lift,
    fade,
    gate,
    style: {
      opacity: Animated.multiply(fade, lift.interpolate({inputRange: [0, 1], outputRange: [0.55, 1]})),
      transform: [
        {translateX: xy.x},
        {translateY: Animated.add(xy.y, lift.interpolate({inputRange: [0, 1], outputRange: [14, 0]}))},
        {rotate: xy.x.interpolate({inputRange: [-1000, 1000], outputRange: [`${-1000 * TILT}deg`, `${1000 * TILT}deg`]})},
        {scale: lift.interpolate({inputRange: [0, 1], outputRange: [0.94, 1]})},
      ],
    },
    stamps: {
      love: Animated.multiply(xy.x.interpolate({inputRange: [0, DIST_X], outputRange: [0, 1], extrapolate: clamp}), gate),
      nope: Animated.multiply(xy.x.interpolate({inputRange: [-DIST_X, 0], outputRange: [1, 0], extrapolate: clamp}), gate),
      skip: Animated.multiply(Animated.multiply(xy.y.interpolate({inputRange: [-DIST_Y, 0], outputRange: [1, 0], extrapolate: clamp}), upright), gate),
    },
  };
}
const OUT = Easing.bezier(0.2, 0.7, 0.3, 1);

type Flying = {card: TasteCard; verdict: Verdict; n: number};

export default function Taste({navigation}: NativeStackScreenProps<PhoneStackParamList, 'Taste'>) {
  const {profileId} = useApp();
  const barTop = useBarTop();
  const bottom = useTabBarSpace();
  const win = useWindowDimensions();
  const session = useRef(new TasteSession()).current;
  const [, setTick] = useState(0);
  const repaint = useCallback(() => setTick(t => t + 1), []);
  const [loaded, setLoaded] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [stage, setStage] = useState({w: 0, h: 0});
  const [flying, setFlying] = useState<Flying[]>([]);
  const busy = useRef<Promise<unknown>>(Promise.resolve());
  const calm = useCalm();
  const {w: cardW, h: cardH} = cardSize(stage.w, stage.h);

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
      if (v < 1) Animated.timing(a.lift, {toValue: 1, duration: calm.current ? 120 : 260, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
    });
  }, [curId, animOf, calm]);
  useEffect(() => {
    if (!nextId) return;
    const a = animOf(nextId);
    a.xy.stopAnimation();
    a.xy.setValue({x: 0, y: 0});
    a.fade.setValue(1);
    a.lift.stopAnimation(v => {
      if (v > 0) Animated.timing(a.lift, {toValue: 0, duration: calm.current ? 120 : 260, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
    });
  }, [nextId, animOf, calm]);

  // ---------- motion ----------
  const flights = useRef(0);
  const fly = useCallback(
    (verdict: Verdict, card: TasteCard, from: {dx: number; dy: number} | null) => {
      const a = animOf(card.imdbId);
      const n = ++flights.current;
      setFlying(l => [...l.filter(f => f.card.imdbId !== card.imdbId), {card, verdict, n}]);
      const landed = ({finished}: {finished: boolean}) => {
        setFlying(l => l.filter(f => f.n !== n));
        // gone for good (not brought back with Undo half way): its values go too
        if (finished && !session.queue.some(c => c.imdbId === card.imdbId)) anims.delete(card.imdbId);
      };
      a.xy.stopAnimation();
      a.fade.stopAnimation();
      if (calm.current) {
        Animated.timing(a.fade, {toValue: 0, duration: 140, useNativeDriver: true}).start(landed);
        return;
      }
      const t = flyTo(verdict, from, win.width, win.height);
      Animated.parallel([
        Animated.timing(a.xy, {toValue: {x: t.x, y: t.y}, duration: 300, easing: OUT, useNativeDriver: true}),
        Animated.timing(a.fade, {toValue: 0, duration: 300, easing: Easing.in(Easing.quad), useNativeDriver: true}),
      ]).start(landed);
    },
    [animOf, anims, session, calm, win.width, win.height],
  );

  // ---------- answering ----------
  const answer = useCallback(
    (verdict: Verdict, from: {dx: number; dy: number} | null = null) => {
      const entry = session.answer(verdict);
      if (!entry) return;
      fly(verdict, entry.card, from);
      phoneNative.haptic('tick');
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
            showToast("Couldn't save that answer — try again", '⚠️');
          }
        }
        repaint();
      });
    },
    [session, fly, repaint, profileId, animOf],
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
    if (calm.current) {
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
  }, [session, animOf, flying, calm, win.width, win.height, repaint, profileId]);

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
  const shown = Math.min(session.answered, session.goal);
  const answersOff = loaded !== 'ok' || over || !cur;

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

  let stageBody: React.ReactNode = null;
  if (loaded === 'failed') {
    stageBody = (
      <View style={s.center}>
        <Text style={s.endText}>Couldn't load titles — try again in a moment.</Text>
        <GlassButton uiId="phone.taste.retry" small label="Try again" icon="refresh" onPress={first} style={{marginTop: 8}} />
      </View>
    );
  } else if (loaded === 'loading' || (!over && !cur)) {
    stageBody = (
      <View style={s.center}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  } else if (over) {
    const end = endWords(session.answered, session.tally, dry);
    stageBody = (
      <View style={s.center} accessibilityLiveRegion="polite">
        <Text style={s.endGlyph}>{end.glyph}</Text>
        <Text style={s.endTitle} accessibilityRole="header">
          {end.title}
        </Text>
        <Text style={s.endText}>{end.tally}</Text>
        <View style={s.endActions}>
          {end.keepGoing ? <GlassButton uiId="taste.more" label="Keep going" onPress={keepGoing} /> : null}
          <PrimaryButton uiId="taste.done" label="Done" onPress={done} />
        </View>
      </View>
    );
  }

  return (
    <View style={[s.root, {paddingTop: barTop + 56, paddingBottom: bottom}]}>
      <View style={s.head}>
        <Text style={s.h1} accessibilityRole="header">
          What's your taste?
        </Text>
        <View style={s.headRow}>
          <View style={s.progress} accessibilityLabel={`${shown} of ${session.goal} answered`}>
            <View style={s.bar}>
              <View style={[s.barFill, {width: `${Math.round(100 * session.progress)}%`}]} />
            </View>
            <Text style={s.count}>
              {shown} / {session.goal}
            </Text>
          </View>
          <View style={s.tools}>
            <GlassButton uiId="taste.undo" small label="↶ Undo" disabled={!session.history.length} onPress={undo} style={s.tool} />
            <GlassButton uiId="taste.edit" small label="Edit list" onPress={() => navigation.push('TasteList')} style={s.tool} />
            <PrimaryButton uiId="taste.done" label="Done" onPress={done} style={s.tool} />
          </View>
        </View>
      </View>

      <View style={s.stage} onLayout={onStage}>
        {stageBody}
        {loaded === 'ok' && cardW > 0 && deck.length ? (
          <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, s.center]}>
            <View pointerEvents="box-none" style={{width: cardW, height: cardH}}>
              {deck.map(({card, place}) => {
                const a = animOf(card.imdbId);
                const top = place === 'top';
                const off = place !== 'top' && place !== 'behind';
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
                    style={[s.card, {width: cardW, height: cardH}, a.style]}>
                    <CardFace card={card} w={cardW} info={place !== 'behind'} stamps={off ? {[place as Verdict]: 1} : top ? a.stamps : undefined} />
                  </Animated.View>
                );
              })}
            </View>
          </View>
        ) : null}
      </View>

      <View style={[s.answers, answersOff && s.answersOff]} pointerEvents={answersOff ? 'none' : 'auto'}>
        <AnswerButton verdict="nope" off={answersOff} onPress={() => answer('nope')} />
        <AnswerButton verdict="skip" off={answersOff} onPress={() => answer('skip')} />
        <AnswerButton verdict="love" off={answersOff} onPress={() => answer('love')} />
      </View>
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
  // .ts-head on a phone: the title, then the progress and the tools on one line
  head: {paddingHorizontal: GUTTER, marginBottom: 12},
  h1: {color: colors.text, fontSize: 21.6, fontWeight: '900', letterSpacing: -0.5},
  headRow: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 8},
  progress: {flexDirection: 'row', alignItems: 'center', gap: 10},
  bar: {width: 56, height: 4, borderRadius: 2, backgroundColor: colors.surfaceHover, overflow: 'hidden'},
  barFill: {height: 4, backgroundColor: colors.accent},
  count: {color: colors.textDim, fontSize: 14.4, fontVariant: ['tabular-nums']},
  tools: {flexDirection: 'row', gap: 8},
  // .ts-tool.btn.small on a phone: 7 x 12 inside, 0.82rem
  tool: {height: 36, paddingHorizontal: 12},
  // .ts-stage: whatever height is left, the card as tall as fits (640 at most)
  stage: {flex: 1, minHeight: 240, alignItems: 'center', justifyContent: 'center'},
  card: {position: 'absolute', left: 0, top: 0, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)'},
  fallback: {alignItems: 'center', justifyContent: 'center', padding: 20, backgroundColor: 'rgba(110,90,220,0.28)'},
  fallbackText: {color: colors.textDim, fontSize: 20.8, fontWeight: '800', textAlign: 'center'},
  info: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 70, paddingHorizontal: 18, paddingBottom: 18, experimental_backgroundImage: INFO_FADE},
  title: {color: colors.text, fontSize: 21.6, fontWeight: '800', lineHeight: 26, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6, textShadowOffset: {width: 0, height: 1}},
  meta: {color: 'rgba(243,244,248,0.78)', fontSize: 14, fontWeight: '600', marginTop: 4},
  line: {color: 'rgba(243,244,248,0.72)', fontSize: 13.8, lineHeight: 18.6, marginTop: 6},
  // .ts-stamp
  stamp: {paddingHorizontal: 12, paddingVertical: 4, borderWidth: 3, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.25)'},
  stampLove: {position: 'absolute', top: 22, left: 18, transform: [{rotate: '-12deg'}]},
  stampNope: {position: 'absolute', top: 22, right: 18, transform: [{rotate: '12deg'}]},
  stampSide: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  stampSkipRow: {position: 'absolute', top: '40%', left: 0, right: 0, alignItems: 'center'},
  stampText: {fontSize: 22.4, fontWeight: '900', letterSpacing: 1.3},
  stampTextSkip: {fontSize: 17.6},
  // .ts-answers: three round buttons, the skip one smaller, their words under them
  answers: {flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 24, marginTop: 14, paddingBottom: 6},
  answersOff: {opacity: 0},
  answer: {alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingVertical: 4, minWidth: 76},
  disc: {alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)'},
  discBig: {width: 56, height: 56, borderRadius: 28},
  discSmall: {width: 44, height: 44, borderRadius: 22},
  discGlyph: {fontSize: 24, fontWeight: '900'},
  answerLabel: {color: colors.textDim, fontSize: 12.5, fontWeight: '700'},
  // .ts-end
  endGlyph: {fontSize: 42},
  endTitle: {color: colors.text, fontSize: 21.6, fontWeight: '800', textAlign: 'center', maxWidth: 420},
  endText: {color: colors.textDim, fontSize: 15.68, textAlign: 'center', lineHeight: 22},
  endActions: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12, marginTop: 8},
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
