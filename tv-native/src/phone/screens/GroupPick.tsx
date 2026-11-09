// "What do we watch tonight?" on the phone — the controller in a group pick
// (the TV is usually the room's screen; the website's #/group/<CODE> and the
// TV's screens/GroupPick.tsx are the other two). The words and the rules are
// the shared groupPick.ts, the talking groupPickApi.ts; what a finger on the
// card means and this phone's not-yet-confirmed answers are ../groupSwipe.ts.
//
//   no session   Join with a code (the TV's QR lands here with the code: joined
//                at once) · Start (the same choices as the TV)
//   first time   the four-step explanation (TUTORIAL), then "How it works"
//   lobby        the code to read out, who is in, the choices (the starter
//                changes them), Add a title, Start swiping (the starter)
//   swipe        one card at a time: right yes, left no, up maybe (or the three
//                buttons), Undo, the time left; answers move on at once
//   waiting      done — who else is; the starter can add a minute or end it
//   result       the pick and why; Play (on the room's screen when there is
//                one), Something else, Swipe another round
//   chosen       Enjoy; ended: the reason
//
// followGroup drives everything (live over the socket, a poll behind it);
// every action hands the session it brought back to follow.take().
// (Back leaves the page, not the session: the member is "away" until they
// come back or the session ends. Leave says so to the others.)
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {useRoute} from '@react-navigation/native';
import QRCode from 'react-native-qrcode-svg';
import {ApiError, getBaseUrl} from '../../api';
import {
  addedLine,
  cardMeta,
  codeOk,
  currentPick,
  GroupCard,
  GroupMember,
  GroupOptions,
  GroupSearchHit,
  GroupSession,
  GroupSettings,
  GroupVerdict,
  hasNextPick,
  hostOf,
  joinedLine,
  joinUrl,
  limitLabel,
  peopleOf,
  playLabel,
  playsHere,
  progressLine,
  screenOf,
  seenLine,
  stepOf,
  tidyCode,
  timeLeft,
  TUTORIAL,
  unanswered,
  WORDS,
} from '../../groupPick';
import {followGroup, GroupFollow, groupApi, playTarget} from '../../groupPickApi';
import {phoneNative} from '../native';
import {usePNav} from '../nav';
import {cardSize} from '../tasteSwipe';
import {answer as answerLocal, Answers, BUTTONS, cardLabel, flyTo, forget, GLYPH, groupVerdict, LABEL, noAnswers, settle, STAMP, TINT, undo as undoLocal, withMine} from '../groupSwipe';
import {BackBar, useColumn, usePageTop} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import {useBarTop} from '../ui/TopBar';
import {artSrc} from '../ui/Cards';
import Avatar from '../ui/Avatar';
import Field from '../ui/Field';
import Glass from '../ui/Glass';
import Sheet from '../ui/Sheet';
import SearchBox from '../ui/SearchBox';
import Tap from '../ui/Tap';
import {ChipButton, GlassButton, PrimaryButton} from '../ui/Buttons';
import {colors, GUTTER, radius} from '../theme';

const DEFAULTS: GroupSettings = {kind: 'movie', mood: 'any', length: 'any', limitSec: 180};
const INFO_FADE = 'linear-gradient(to top, rgba(6,7,12,0.94) 0%, rgba(6,7,12,0.78) 45%, rgba(6,7,12,0) 100%)';
const OUT = Easing.bezier(0.2, 0.7, 0.3, 1);

/** The server's own words when it answered; a calm line when it could not be reached. */
export const errText = (e: unknown): string => {
  const m = e instanceof ApiError && e.status > 0 ? String(e.message || '') : '';
  return m && !/^\d{3}\s\//.test(m) ? m : WORDS.noReach;
};

const useCalm = () => {
  const calm = useRef(false);
  useEffect(() => {
    try {
      AccessibilityInfo?.isReduceMotionEnabled?.()
        .then(on => {
          calm.current = !!on;
        })
        .catch(() => {});
    } catch {}
  }, []);
  return calm;
};

// ---------- small pieces ----------

function Poster({card, w, h, style}: {card: Pick<GroupCard, 'poster' | 'title'>; w: number; h: number; style?: object}) {
  const {src} = artSrc(card.poster || null, w);
  const [failed, setFailed] = useState(false);
  return (
    <View style={[s.poster, {width: w, height: h}, style]}>
      {src && !failed ? (
        <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} onError={() => setFailed(true)} />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.fallback]}>
          <Text style={s.fallbackText} numberOfLines={4}>
            {card.title}
          </Text>
        </View>
      )}
    </View>
  );
}

function Person({m, done}: {m: GroupMember; done?: boolean}) {
  const badge = m.role === 'screen' ? WORDS.screenBadge : m.away ? WORDS.awayBadge : done && m.done ? WORDS.doneBadge : m.host ? WORDS.hostBadge : '';
  return (
    <View style={[s.person, m.away && s.away]} accessible accessibilityLabel={badge ? `${m.name}, ${badge}` : m.name}>
      <Avatar p={{name: m.name, avatar: m.avatar || '🙂', avatarImage: m.avatarImage || null, color: ''}} size={26} round />
      <Text style={s.personName} numberOfLines={1}>
        {m.name}
      </Text>
      {badge ? <Text style={[s.badge, done && m.done && s.badgeDone]}>{badge}</Text> : null}
    </View>
  );
}

function People({session, done}: {session: GroupSession; done?: boolean}) {
  return (
    <View style={s.people}>
      {peopleOf(session).map(m => (
        <Person key={m.profileId} m={m} done={done} />
      ))}
    </View>
  );
}

/** Films or series · Mood · Length · Time to swipe — as chips (the starter's). */
function Choices({opts, value, onPick, busy}: {opts: GroupOptions; value: GroupSettings; onPick: (p: Partial<GroupSettings>) => void; busy?: boolean}) {
  const rows: {name: string; field: keyof GroupSettings; items: {id: string | number; label: string}[]}[] = [
    {name: WORDS.kind, field: 'kind', items: opts.kinds},
    {name: WORDS.mood, field: 'mood', items: opts.moods},
    {name: WORDS.length, field: 'length', items: opts.lengths},
    {name: WORDS.time, field: 'limitSec', items: opts.limits.map(n => ({id: n, label: limitLabel(n)}))},
  ];
  return (
    <>
      {rows.map(r => (
        <View key={r.field} style={s.choiceRow}>
          <Text style={s.label}>{r.name}</Text>
          <View style={s.chips}>
            {r.items.map(it => (
              <ChipButton uiId="group.option" key={String(it.id)} label={it.label} active={value[r.field] === it.id} disabled={busy} onPress={() => onPick({[r.field]: it.id} as Partial<GroupSettings>)} />
            ))}
          </View>
        </View>
      ))}
    </>
  );
}

/** The choices in one quiet line, for everyone but the starter. */
const choiceLine = (opts: GroupOptions | null, v: GroupSettings) => {
  if (!opts) return '';
  const name = (list: {id: string | number; label: string}[], id: string | number) => (list.find(x => x.id === id) || {label: ''}).label;
  return [name(opts.kinds, v.kind), name(opts.moods, v.mood), name(opts.lengths, v.length), limitLabel(v.limitSec)].filter(Boolean).join(' · ');
};

// ---------- the first-time explanation ----------

/** The four calm drawings (plain shapes): a TV with a code, phones, a card with ✓ ? ✕, a poster with a star. */
export function TutorialArt({art}: {art: (typeof TUTORIAL)[number]['art']}) {
  if (art === 'tv')
    return (
      <View style={s.art}>
        <View style={s.artTv}>
          <Text style={s.artCode}>K7QM</Text>
          <View style={s.artQr} />
        </View>
        <View style={s.artStand} />
      </View>
    );
  if (art === 'phones')
    return (
      <View style={[s.art, s.artRow]}>
        {[0, 1, 2].map(i => (
          <View key={i} style={[s.artPhone, i === 1 && s.artPhoneMid]}>
            <View style={s.artPhoneScreen} />
          </View>
        ))}
      </View>
    );
  if (art === 'swipe')
    return (
      <View style={s.art}>
        <View style={[s.artCard, s.artTilt]} />
        <View style={s.artMarks}>
          {BUTTONS.map(v => (
            <View key={v} style={[s.artMark, {borderColor: TINT[v]}]}>
              <Text style={[s.artMarkText, {color: TINT[v]}]}>{GLYPH[v]}</Text>
            </View>
          ))}
        </View>
      </View>
    );
  return (
    <View style={s.art}>
      <View style={s.artCard}>
        <Text style={s.artStar}>★</Text>
      </View>
    </View>
  );
}

function Tutorial({onDone}: {onDone: () => void}) {
  const [i, setI] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;
  const calm = useCalm();
  const step = TUTORIAL[i];
  const last = i === TUTORIAL.length - 1;
  // a gentle fade and lift between the steps (none with "Remove animations")
  const go = (n: number) => {
    if (calm.current) return setI(n);
    Animated.timing(fade, {toValue: 0, duration: 140, useNativeDriver: true}).start(() => {
      setI(n);
      Animated.timing(fade, {toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
    });
  };
  return (
    <Glass style={s.tut}>
      <Animated.View style={[s.centered, {opacity: fade, transform: [{translateY: fade.interpolate({inputRange: [0, 1], outputRange: [10, 0]})}]}]} accessibilityLiveRegion="polite">
        <TutorialArt art={step.art} />
        <Text style={s.tutTitle} accessibilityRole="header">
          {step.title}
        </Text>
        <Text style={s.tutBody}>{step.body}</Text>
      </Animated.View>
      <View style={s.dots}>
        {TUTORIAL.map((_, n) => (
          <View key={n} style={[s.dot, n === i && s.dotOn]} />
        ))}
      </View>
      <View style={s.tutButtons}>
        {!last ? <GlassButton uiId="group.tutorial.skip" small label={WORDS.skip} onPress={onDone} /> : null}
        <PrimaryButton uiId="group.tutorial.next" label={last ? WORDS.letsGo : WORDS.next} onPress={() => (last ? onDone() : go(i + 1))} style={s.grow} />
      </View>
    </Glass>
  );
}

// ---------- Add a title ----------

function AddSheet({code, visible, onClose, onAdded}: {code: string; visible: boolean; onClose: () => void; onAdded: () => void}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<GroupSearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  useEffect(() => {
    if (!visible) return;
    const words = q.trim();
    if (words.length < 2) {
      setHits(null);
      return;
    }
    let on = true;
    const t = setTimeout(() => {
      setBusy(true);
      groupApi
        .search(code, words)
        .then(r => {
          if (!on) return;
          setHits(r.results || []);
          setErr('');
        })
        .catch(e => on && setErr(errText(e)))
        .finally(() => on && setBusy(false));
    }, 320);
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [q, code, visible]);
  const add = (h: GroupSearchHit) => {
    if (h.inDeck || added.includes(h.key)) return;
    setAdded(a => [...a, h.key]);
    phoneNative.haptic('tick');
    groupApi
      .add(code, {id: h.id, imdbId: h.imdbId, type: h.type, title: h.title, year: h.year, poster: h.poster})
      .then(() => onAdded())
      .catch(e => {
        setAdded(a => a.filter(k => k !== h.key));
        setErr(errText(e));
      });
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={WORDS.addTitle} sub={WORDS.addLine}>
      <View style={s.sheetBody}>
        <SearchBox value={q} onChangeText={setQ} onClear={() => setQ('')} placeholder={WORDS.searchPlaceholder} autoFocus />
        {err ? <Text style={s.err}>{err}</Text> : null}
        {busy && !hits ? <ActivityIndicator color={colors.text} style={s.spin} /> : null}
        {(hits || []).map(h => {
          const isIn = h.inDeck || added.includes(h.key);
          return (
            <Tap key={h.key} flat disabled={isIn} onPress={() => add(h)} style={s.hit} accessibilityRole="button" accessibilityLabel={`${h.title}${isIn ? `, ${WORDS.inDeck}` : ''}`}>
              <Poster card={h} w={44} h={66} style={s.hitPoster} />
              <View style={s.shrink}>
                <Text style={s.hitTitle} numberOfLines={2}>
                  {h.title}
                </Text>
                <View style={s.hitMeta}>
                  {h.year ? <Text style={s.hitYear}>{h.year}</Text> : null}
                  {h.lib ? <Text style={s.libBadge}>{WORDS.libBadge}</Text> : null}
                </View>
              </View>
              <Text style={[s.hitAdd, isIn && s.hitIn]}>{isIn ? (h.inDeck ? WORDS.inDeck : WORDS.added) : '+'}</Text>
            </Tap>
          );
        })}
      </View>
    </Sheet>
  );
}

// ---------- the swiping card ----------

type Flying = {card: GroupCard; v: GroupVerdict; xy: Animated.ValueXY; fade: Animated.Value; n: number};

function CardFace({card, w}: {card: GroupCard; w: number}) {
  const meta = cardMeta(card);
  const seen = seenLine(card.seenBy);
  const by = addedLine(card.addedBy);
  const {src} = artSrc(card.poster || null, w);
  const [failed, setFailed] = useState(false);
  return (
    <>
      {src && !failed ? (
        <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} onError={() => setFailed(true)} />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.fallback]}>
          <Text style={s.fallbackText}>{card.title}</Text>
        </View>
      )}
      {card.lib ? <Text style={[s.libBadge, s.cardBadge]}>{WORDS.libBadge}</Text> : null}
      <View pointerEvents="none" style={s.info}>
        <Text style={s.cardTitle} numberOfLines={2}>
          {card.title}
        </Text>
        {meta ? <Text style={s.cardMeta}>{meta}</Text> : null}
        {card.line ? (
          <Text style={s.cardLine} numberOfLines={3}>
            {card.line}
          </Text>
        ) : null}
        {seen || by ? <Text style={s.cardNote}>{[by, seen].filter(Boolean).join(' · ')}</Text> : null}
      </View>
    </>
  );
}

/** YES / NO by how far sideways, MAYBE by how far up — as the finger drags. */
function Stamps({xy}: {xy: Animated.ValueXY}) {
  const clamp = 'clamp' as const;
  const level: Record<GroupVerdict, unknown> = {
    yes: xy.x.interpolate({inputRange: [0, 110], outputRange: [0, 1], extrapolate: clamp}),
    no: xy.x.interpolate({inputRange: [-110, 0], outputRange: [1, 0], extrapolate: clamp}),
    maybe: xy.y.interpolate({inputRange: [-100, 0], outputRange: [1, 0], extrapolate: clamp}),
  };
  return (
    <>
      {BUTTONS.map(v => (
        <Animated.View key={v} pointerEvents="none" style={[v === 'maybe' ? s.stampMid : v === 'yes' ? s.stampLeft : s.stampRight, {opacity: level[v] as never}]}>
          <View style={[s.stamp, {borderColor: TINT[v]}]}>
            <Text style={[s.stampText, {color: TINT[v]}]}>{STAMP[v]}</Text>
          </View>
        </Animated.View>
      ))}
    </>
  );
}

function AnswerButton({v, onPress, off}: {v: GroupVerdict; onPress: () => void; off: boolean}) {
  const big = v !== 'maybe';
  return (
    <Tap uiId={v === 'yes' ? 'group.yes' : v === 'no' ? 'group.no' : 'group.maybe'} flat disabled={off} accessibilityRole="button" accessibilityLabel={LABEL[v]} onPress={onPress} style={s.answer}>
      <View style={[s.disc, big ? s.discBig : s.discSmall]}>
        <Text style={[s.discGlyph, !big && s.discGlyphSmall, {color: TINT[v]}]}>{GLYPH[v]}</Text>
      </View>
      <Text style={s.answerLabel}>{LABEL[v]}</Text>
    </Tap>
  );
}

/** The swipe step: the head (time left, Undo, Add), the card on a stage of fixed size, the three answers. */
function SwipeStage({
  card,
  flying,
  xy,
  lift,
  responder,
  onVote,
  head,
  foot,
}: {
  card: GroupCard | null;
  flying: Flying[];
  xy: Animated.ValueXY;
  lift: Animated.Value;
  responder: ReturnType<typeof PanResponder.create>;
  onVote: (v: GroupVerdict) => void;
  head: React.ReactNode;
  foot: React.ReactNode;
}) {
  const [stage, setStage] = useState({w: 0, h: 0});
  const {w, h} = cardSize(stage.w, stage.h);
  const onStage = (e: LayoutChangeEvent) => {
    const {width, height} = e.nativeEvent.layout;
    setStage(st => (Math.abs(st.w - width) < 1 && Math.abs(st.h - height) < 1 ? st : {w: width, h: height}));
  };
  const tilt = (x: Animated.Value) => x.interpolate({inputRange: [-1000, 1000], outputRange: ['-50deg', '50deg']});
  const moving = {
    opacity: lift.interpolate({inputRange: [0, 1], outputRange: [0.55, 1]}),
    transform: [
      {translateX: xy.x},
      {translateY: Animated.add(xy.y, lift.interpolate({inputRange: [0, 1], outputRange: [14, 0]}))},
      {rotate: tilt(xy.x)},
      {scale: lift.interpolate({inputRange: [0, 1], outputRange: [0.94, 1]})},
    ],
  };
  return (
    <>
      {head}
      <View style={s.stage} onLayout={onStage}>
        {w > 0 ? (
          <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, s.center]}>
            <View pointerEvents="box-none" style={{width: w, height: h}}>
              {card ? (
                <Animated.View
                  key={card.key}
                  {...responder.panHandlers}
                  accessible
                  accessibilityLabel={cardLabel(card)}
                  accessibilityActions={BUTTONS.map(v => ({name: v, label: LABEL[v]}))}
                  onAccessibilityAction={e => onVote(e.nativeEvent.actionName as GroupVerdict)}
                  style={[s.card2, {width: w, height: h}, moving]}>
                  <CardFace card={card} w={w} />
                  <Stamps xy={xy} />
                </Animated.View>
              ) : null}
              {flying.map(f => (
                <Animated.View
                  key={`fly-${f.n}`}
                  pointerEvents="none"
                  importantForAccessibility="no-hide-descendants"
                  style={[s.card2, {width: w, height: h, opacity: f.fade, transform: [{translateX: f.xy.x}, {translateY: f.xy.y}, {rotate: tilt(f.xy.x)}]}]}>
                  <CardFace card={f.card} w={w} />
                  <View style={f.v === 'maybe' ? s.stampMid : f.v === 'yes' ? s.stampLeft : s.stampRight}>
                    <View style={[s.stamp, {borderColor: TINT[f.v]}]}>
                      <Text style={[s.stampText, {color: TINT[f.v]}]}>{STAMP[f.v]}</Text>
                    </View>
                  </View>
                </Animated.View>
              ))}
            </View>
          </View>
        ) : null}
      </View>
      {foot}
      <View style={s.answers}>
        {BUTTONS.map(v => (
          <AnswerButton key={v} v={v} off={!card} onPress={() => onVote(v)} />
        ))}
      </View>
    </>
  );
}

// ---------- the screen ----------

type Params = {code?: string | null} | undefined;

export default function GroupPick() {
  const route = useRoute();
  const nav = usePNav();
  const top = usePageTop();
  const barTop = useBarTop();
  const column = useColumn();
  const bottom = useTabBarSpace();
  const win = useWindowDimensions();
  const calm = useCalm();
  const raw = (route.params as Params)?.code;
  const linkCode = raw ? tidyCode(raw) : '';

  const [opts, setOpts] = useState<GroupOptions | null>(null);
  const [session, setSession] = useState<GroupSession | null>(null);
  const [lost, setLost] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>(noAnswers());
  const [tut, setTut] = useState(false);
  const [mode, setMode] = useState<'join' | 'start'>('join');
  const [typed, setTyped] = useState(linkCode);
  const [draft, setDraft] = useState<GroupSettings>(DEFAULTS);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [pressedPlay, setPressedPlay] = useState(false);
  const [, setTick] = useState(0);
  const follow = useRef<GroupFollow | null>(null);
  const live = useRef(true);
  const askedTut = useRef(false);

  useEffect(
    () => () => {
      live.current = false;
      follow.current?.stop();
    },
    [],
  );
  useEffect(() => {
    groupApi
      .options()
      .then(o => live.current && setOpts(o))
      .catch(() => live.current && setOpts(null));
  }, []);

  // ---------- following a session ----------
  const begin = useCallback((s: GroupSession) => {
    follow.current?.stop();
    setLost(null);
    setErr('');
    setPressedPlay(false);
    const f = followGroup(
      s.code,
      next => {
        if (!live.current) return;
        setSession(next);
        setAnswers(a => settle(a, next));
      },
      why => live.current && setLost(why.message || WORDS.ended),
    );
    follow.current = f;
    f.take(s);
  }, []);
  const take = (s: GroupSession | undefined) => s && follow.current?.take(s);

  // the first time here: the explanation comes first (once someone joins or starts)
  useEffect(() => {
    if (session && opts && !opts.tutorialSeen && !askedTut.current) {
      askedTut.current = true;
      setTut(true);
    }
  }, [session, opts]);
  const tutDone = () => {
    setTut(false);
    if (opts && !opts.tutorialSeen) {
      setOpts({...opts, tutorialSeen: true});
      groupApi.tutorialSeen().catch(() => {});
    }
  };

  /** An action of the starter's or anyone's: busy while it goes, its session taken, its refusal said. */
  const run = async (what: string, fn: () => Promise<unknown>, then?: (r: unknown) => void) => {
    if (busy) return;
    setBusy(what);
    setErr('');
    try {
      const r = await fn();
      if (!live.current) return;
      take((r as {session?: GroupSession} | null)?.session);
      then?.(r);
    } catch (e) {
      if (live.current) setErr(errText(e));
    } finally {
      if (live.current) setBusy(null);
    }
  };

  const join = useCallback(
    async (code: string) => {
      setErr('');
      if (!codeOk(code)) return setErr(WORDS.codeWrong);
      setBusy('join');
      try {
        const r = await groupApi.join(code, 'voter');
        if (live.current) begin(r.session);
      } catch (e) {
        if (live.current) setErr(errText(e));
      } finally {
        if (live.current) setBusy(null);
      }
    },
    [begin],
  );
  // from a link (the TV's QR): straight in
  const linked = useRef('');
  useEffect(() => {
    if (!linkCode || linked.current === linkCode) return;
    linked.current = linkCode;
    setTyped(linkCode);
    if (codeOk(linkCode)) join(linkCode);
    else setErr(WORDS.codeWrong);
  }, [linkCode, join]);

  const start = async () => {
    if (busy) return;
    setBusy('start');
    setErr('');
    try {
      const r = await groupApi.create(draft, 'voter');
      if (live.current) begin(r.session);
    } catch (e) {
      if (live.current) setErr(errText(e));
    } finally {
      if (live.current) setBusy(null);
    }
  };

  // ---------- what is on screen ----------
  const shown = session ? withMine(session, answers) : null;
  const stepNow = lost ? 'ended' : shown ? stepOf(shown) : null;
  const code = session ? session.code : '';
  const isHost = !!shown?.you?.host;
  const cards = shown ? unanswered(shown) : [];
  const card = stepNow === 'swipe' ? cards[0] || null : null;

  // the countdown: once a second while it runs
  const ticking = !!shown?.deadline && (stepNow === 'swipe' || stepNow === 'waiting');
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  const left = shown && follow.current ? timeLeft(shown, Date.now() - follow.current.receivedAt()) : '';

  // ---------- answering ----------
  const [flying, setFlying] = useState<Flying[]>([]);
  // the last answer's card finishes its flight before "done — waiting" takes the page
  const step = stepNow === 'waiting' && flying.length && session?.phase === 'swiping' ? 'swipe' : stepNow;
  // a new step (the form -> the lobby -> the result ...) opens at its top: pressing Start at the
  // foot of the long form used to land the host mid-lobby, the room's code scrolled off-screen
  const scroller = useRef<ScrollView>(null);
  useEffect(() => {
    scroller.current?.scrollTo({y: 0, animated: false});
  }, [step, tut]);
  const xy = useRef(new Animated.ValueXY({x: 0, y: 0})).current;
  const lift = useRef(new Animated.Value(1)).current;
  const flights = useRef(0);
  const cardKey = card ? card.key : null;
  const returning = useRef<string | null>(null);
  // a new card on top steps forward from behind (not one Undo is flying back in)
  useEffect(() => {
    if (!cardKey) return;
    if (returning.current === cardKey) {
      returning.current = null;
      return;
    }
    xy.setValue({x: 0, y: 0});
    lift.setValue(calm.current ? 1 : 0);
    if (!calm.current) Animated.timing(lift, {toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
  }, [cardKey, xy, lift, calm]);

  const vote = (v: GroupVerdict, from: {dx: number; dy: number} | null = null) => {
    if (!card || !session) return;
    const c = card;
    setAnswers(a => answerLocal(a.code === session.code && a.round === session.round ? a : noAnswers(session.code, session.round), c.key, v));
    phoneNative.haptic('tick');
    // the next card starts in the middle (the effect above steps it forward)
    xy.setValue({x: 0, y: 0});
    if (!calm.current) lift.setValue(0);
    // the answered card flies off from where the finger let it go
    const n = ++flights.current;
    const f: Flying = {card: c, v, xy: new Animated.ValueXY(from ? {x: from.dx, y: from.dy} : {x: 0, y: 0}), fade: new Animated.Value(1), n};
    setFlying(l => [...l.filter(x => x.card.key !== c.key), f]);
    const gone = () => setFlying(l => l.filter(x => x.n !== n));
    if (calm.current) Animated.timing(f.fade, {toValue: 0, duration: 140, useNativeDriver: true}).start(gone);
    else {
      const t = flyTo(v, from, win.width, win.height);
      Animated.parallel([
        Animated.timing(f.xy, {toValue: {x: t.x, y: t.y}, duration: 300, easing: OUT, useNativeDriver: true}),
        Animated.timing(f.fade, {toValue: 0, duration: 300, easing: Easing.in(Easing.quad), useNativeDriver: true}),
      ]).start(gone);
    }
    setErr('');
    groupApi.vote(session.code, c.key, v).catch(e => {
      if (!live.current) return;
      // refused with a reason (time's up…): the answer stays, the reason is said;
      // never reached: as if it had not been given (the card comes back)
      if (!(e instanceof ApiError && e.status > 0)) setAnswers(a => forget(a, c.key));
      setErr(errText(e));
    });
  };
  const voteRef = useRef(vote);
  voteRef.current = vote;

  const takeBack = () => {
    if (!session || !shown) return;
    const u = undoLocal(answers);
    if (!u) return;
    const was = shown.mine[u.key];
    setAnswers(u.next);
    setFlying(l => l.filter(x => x.card.key !== u.key));
    // it comes back from where it went
    returning.current = u.key;
    lift.setValue(1);
    if (calm.current || !was) xy.setValue({x: 0, y: 0});
    else {
      const t = flyTo(was, null, win.width, win.height);
      xy.setValue({x: t.x, y: t.y});
      Animated.timing(xy, {toValue: {x: 0, y: 0}, duration: 320, easing: OUT, useNativeDriver: true}).start();
    }
    setErr('');
    groupApi.vote(session.code, u.key, null).catch(e => live.current && setErr(errText(e)));
  };

  const held = useRef(false);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          held.current = true;
          xy.stopAnimation();
        },
        onPanResponderMove: (_e, g) => {
          if (held.current) xy.setValue({x: g.dx, y: g.dy});
        },
        onPanResponderRelease: (_e, g) => {
          held.current = false;
          const v = groupVerdict({dx: g.dx, dy: g.dy, vx: g.vx, vy: g.vy});
          if (v) return voteRef.current(v, {dx: g.dx, dy: g.dy});
          // not far enough: back to the middle
          Animated.spring(xy, {toValue: {x: 0, y: 0}, friction: 6, tension: 80, useNativeDriver: true}).start();
        },
        onPanResponderTerminate: () => {
          held.current = false;
          Animated.spring(xy, {toValue: {x: 0, y: 0}, friction: 6, tension: 80, useNativeDriver: true}).start();
        },
      }),
    [xy],
  );

  // ---------- the result ----------
  // a library film plays; a series or a catalogue title opens its page (the way a card opens)
  const openHere = (c: GroupCard, playNow: boolean) => {
    const t = playTarget(c);
    if (!t) return;
    if (t.kind === 'library' && t.type === 'movie' && playNow) nav.push('Player', {id: t.id, title: c.title});
    else if (t.kind === 'library') nav.push('Detail', {item: {id: t.id, type: t.type, title: c.title, year: c.year || undefined, cover: c.poster || null, source: 'downloaded'}});
    else nav.push('Detail', {item: {id: t.imdbId, imdbId: t.imdbId, type: t.type, title: c.title, year: c.year || undefined, cover: c.poster || null, poster: c.poster || null, source: 'stream'}});
  };
  // Play always tells the room; the film starts HERE only when the room has no screen
  const play = () => {
    const p = shown && currentPick(shown);
    if (!p || !shown) return;
    run(
      'play',
      () => groupApi.choose(code, p.key),
      r => {
        setPressedPlay(true);
        const after = (r as {session?: GroupSession}).session || shown;
        if (playsHere(after, true)) openHere(p.card, true);
      },
    );
  };
  const leave = () => {
    if (code && !lost && stepNow !== 'ended') groupApi.leave(code).catch(() => {});
    follow.current?.stop();
    follow.current = null;
    if (nav.canGoBack()) nav.goBack();
    else {
      setSession(null);
      setLost(null);
    }
  };
  const endAll = () =>
    run(
      'end',
      () => groupApi.end(code),
      () => {
        follow.current?.stop();
        follow.current = null;
        if (nav.canGoBack()) nav.goBack();
      },
    );

  // ---------- drawing ----------
  const errLine = err ? (
    <Text style={s.err} accessibilityRole="alert">
      {err}
    </Text>
  ) : null;
  const howTo = (
    <Tap uiId="group.howto" flat onPress={() => setTut(true)} style={s.link} accessibilityRole="button">
      <Text style={s.linkText}>{WORDS.howItWorks}</Text>
    </Tap>
  );
  const footer = shown ? (
    <View style={s.footer}>
      <GlassButton uiId="group.leave" small label={WORDS.leave} onPress={leave} />
      {isHost && step !== 'ended' && step !== 'chosen' ? <GlassButton uiId="group.end" small label={WORDS.endAll} onPress={endAll} busy={busy === 'end'} /> : null}
    </View>
  ) : null;
  const addButton = <GlassButton uiId="group.add" small label={WORDS.addTitle} onPress={() => setAdding(true)} />;

  let body: React.ReactNode;
  let fixed = false; // the swipe step fills the screen (no scrolling under a finger)

  if (tut) {
    body = <Tutorial onDone={tutDone} />;
  } else if (!shown || !step) {
    // ---- no session: join or start ----
    body = (
      <>
        <Text style={s.h1} accessibilityRole="header">
          {WORDS.feature}
        </Text>
        <Text style={s.sub}>{WORDS.entryLine}</Text>
        <View style={s.modes} accessibilityRole="tablist">
          {(['join', 'start'] as const).map(m => (
            <Tap
              key={m}
              flat
              onPress={() => {
                setMode(m);
                setErr('');
              }}
              style={[s.mode, mode === m && s.modeOn]}
              accessibilityRole="tab"
              accessibilityState={{selected: mode === m}}>
              <Text style={s.modeGlyph}>{m === 'join' ? '⌨' : '✦'}</Text>
              <Text style={[s.modeText, mode === m && s.modeTextOn]}>{m === 'join' ? WORDS.joinCode : WORDS.startHere}</Text>
            </Tap>
          ))}
        </View>
        {mode === 'join' ? (
          <Glass style={s.card}>
            <Text style={s.label}>{WORDS.codeLabel}</Text>
            <Field
              value={typed}
              onChangeText={t => {
                setTyped(tidyCode(t));
                setErr('');
              }}
              placeholder="ABCD"
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              maxLength={4}
              returnKeyType="go"
              onSubmitEditing={() => join(typed)}
              accessibilityLabel={WORDS.codeLabel}
              style={s.codeField}
            />
            <Text style={s.help}>{WORDS.codeHelp}</Text>
            {errLine}
            <PrimaryButton uiId="group.join" label={WORDS.join} onPress={() => join(typed)} busy={busy === 'join'} disabled={typed.length < 4} style={s.wide} />
          </Glass>
        ) : (
          <Glass style={s.card}>
            {opts ? <Choices opts={opts} value={draft} onPick={p => setDraft(d => ({...d, ...p}))} /> : <ActivityIndicator color={colors.text} style={s.spin} />}
            {errLine}
            <PrimaryButton uiId="group.start" label={WORDS.startHere} onPress={start} busy={busy === 'start'} style={s.wide} />
          </Glass>
        )}
        {howTo}
      </>
    );
  } else if (step === 'lobby') {
    body = (
      <>
        <Text style={s.kicker}>{WORDS.feature}</Text>
        {/* the website's code block (screens/group.js codeBlock) and the TV's join
            panel: Join in, the code, the QR code another phone's camera reads,
            how to join, and the server's address */}
        <Glass style={[s.card, s.centered]}>
          <Text style={s.label}>{WORDS.joinTitle}</Text>
          <Text style={s.bigCode} accessibilityLabel={code.split('').join(' ')} selectable>
            {code}
          </Text>
          <View style={s.qr} accessibilityLabel={`QR code for ${joinUrl(getBaseUrl(), code)}`}>
            <QRCode value={joinUrl(getBaseUrl(), code)} size={QR_SIZE} backgroundColor="#ffffff" color="#0b0c14" />
          </View>
          <Text style={s.help}>{WORDS.joinLine}</Text>
          <Text style={s.hostLine} numberOfLines={1}>
            {hostOf(getBaseUrl())}
          </Text>
        </Glass>
        <Text style={s.h2}>{joinedLine(shown)}</Text>
        <People session={shown} />
        <Glass style={s.card}>
          {isHost && opts ? (
            <Choices opts={opts} value={shown.settings} busy={busy === 'settings'} onPick={p => run('settings', () => groupApi.settings(code, p))} />
          ) : (
            <>
              <Text style={s.choiceLine}>{choiceLine(opts, shown.settings)}</Text>
              {!isHost ? <Text style={s.help}>{WORDS.onlyHost}</Text> : null}
            </>
          )}
        </Glass>
        {shown.added.length ? (
          <View style={s.addedBox}>
            <Text style={s.label}>{WORDS.addedSoFar}</Text>
            {shown.added.map(a => (
              <Text key={a.key} style={s.addedRow} numberOfLines={1}>
                {`${a.title} · ${addedLine(a.by)}`}
              </Text>
            ))}
          </View>
        ) : null}
        {errLine}
        <View style={s.actions}>
          {addButton}
          {isHost ? <PrimaryButton uiId="group.deal" label={WORDS.startSwiping} onPress={() => run('deal', () => groupApi.start(code))} busy={busy === 'deal'} disabled={shown.voters < 1} style={s.wide} /> : null}
        </View>
        {isHost && shown.voters < 1 ? <Text style={s.help}>{WORDS.needSomeone}</Text> : null}
        {footer}
        {howTo}
      </>
    );
  } else if (step === 'swipe') {
    fixed = true;
    body = (
      <SwipeStage
        card={card}
        flying={flying}
        xy={xy}
        lift={lift}
        responder={responder}
        onVote={v => vote(v)}
        head={
          <View style={s.swipeHead}>
            <View style={s.shrink}>
              {left ? <Text style={s.timeLeft}>{left}</Text> : null}
              <Text style={s.progress}>{progressLine(shown)}</Text>
            </View>
            <GlassButton uiId="group.undo" small label={`↶ ${WORDS.undo}`} disabled={!answers.history.length} onPress={takeBack} />
            {addButton}
          </View>
        }
        foot={errLine}
      />
    );
  } else if (step === 'waiting') {
    body = (
      <>
        <Text style={s.kicker}>{WORDS.feature}</Text>
        <Glass style={[s.card, s.centered]}>
          <Text style={s.bigGlyph}>✓</Text>
          <Text style={s.h2c} accessibilityRole="header">
            {WORDS.doneWaiting}
          </Text>
          <Text style={s.help}>{[progressLine(shown), left].filter(Boolean).join(' · ')}</Text>
        </Glass>
        <People session={shown} done />
        {errLine}
        <View style={s.actions}>
          {answers.history.length ? <GlassButton uiId="group.undo" small label={`↶ ${WORDS.undo}`} onPress={takeBack} /> : null}
          {addButton}
          {isHost ? <GlassButton uiId="group.extend" small label={WORDS.oneMore} onPress={() => run('extend', () => groupApi.extend(code))} busy={busy === 'extend'} /> : null}
          {isHost ? <PrimaryButton uiId="group.finish" label={WORDS.showNow} onPress={() => run('finish', () => groupApi.finish(code))} busy={busy === 'finish'} style={s.wide} /> : null}
        </View>
        {footer}
      </>
    );
  } else if (step === 'result') {
    const pick = currentPick(shown);
    const picks = shown.result?.picks.length || 0;
    const scr = screenOf(shown);
    const posterW = Math.min(220, Math.round(win.width * 0.56));
    const nextIndex = hasNextPick(shown) ? (shown.result?.index || 0) + 1 : 0;
    body = pick ? (
      <>
        <Text style={s.kicker}>{WORDS.resultTitle}</Text>
        <View style={s.centered}>
          <Poster card={pick.card} w={posterW} h={Math.round(posterW * 1.5)} />
          <Text style={s.resultTitle} accessibilityRole="header">
            {pick.card.title}
          </Text>
          {cardMeta(pick.card) ? <Text style={s.help}>{cardMeta(pick.card)}</Text> : null}
          {pick.why ? <Text style={s.why}>{pick.why}</Text> : null}
        </View>
        {errLine}
        {pressedPlay && scr && !playsHere(shown, true) ? <Text style={s.help}>{scr.app === 'tv' ? WORDS.startingOnTv : WORDS.startingOnScreen}</Text> : null}
        <View style={s.actions}>
          <PrimaryButton uiId="group.play" label={playLabel(shown)} onPress={play} busy={busy === 'play'} style={s.wide} />
          {picks > 1 ? (
            <GlassButton uiId="group.next" label={hasNextPick(shown) ? WORDS.somethingElse : WORDS.firstPick} onPress={() => run('next', () => groupApi.pick(code, nextIndex))} busy={busy === 'next'} style={s.wide} />
          ) : null}
          {isHost ? <GlassButton uiId="group.again" small label={WORDS.again} onPress={() => run('again', () => groupApi.again(code))} busy={busy === 'again'} /> : null}
        </View>
        {footer}
      </>
    ) : (
      <>
        <Text style={s.kicker}>{WORDS.feature}</Text>
        <Glass style={[s.card, s.centered]}>
          <Text style={s.bigGlyph}>🤷</Text>
          <Text style={s.h2c} accessibilityRole="header">
            {WORDS.noMatch}
          </Text>
          <Text style={s.help}>{WORDS.noMatchLine}</Text>
        </Glass>
        {errLine}
        <View style={s.actions}>
          {isHost ? <PrimaryButton uiId="group.again" label={WORDS.again} onPress={() => run('again', () => groupApi.again(code))} busy={busy === 'again'} style={s.wide} /> : <Text style={s.help}>{WORDS.onlyHost}</Text>}
        </View>
        {footer}
      </>
    );
  } else if (step === 'chosen') {
    const ch = shown.chosen;
    const scr = screenOf(shown);
    const posterW = Math.min(180, Math.round(win.width * 0.46));
    body = (
      <>
        <Text style={s.kicker}>{WORDS.feature}</Text>
        <View style={s.centered}>
          {ch ? <Poster card={ch.card} w={posterW} h={Math.round(posterW * 1.5)} /> : null}
          <Text style={s.resultTitle} accessibilityRole="header">
            {WORDS.enjoy}
          </Text>
          {ch ? <Text style={s.h2c}>{ch.card.title}</Text> : null}
          {ch?.by ? <Text style={s.help}>{`${ch.by} ${WORDS.pressedPlay}`}</Text> : null}
          {scr && shown.you?.role !== 'screen' ? <Text style={s.help}>{scr.app === 'tv' ? WORDS.startingOnTv : WORDS.startingOnScreen}</Text> : null}
        </View>
        {/* the title on this phone too (its page; nothing starts by itself) */}
        <View style={s.actions}>{ch ? <GlassButton small label={WORDS.open} onPress={() => openHere(ch.card, false)} /> : null}</View>
        {footer}
      </>
    );
  } else {
    // ended (by the starter, the clock, or the server no longer knows it)
    body = (
      <>
        <Text style={s.kicker}>{WORDS.feature}</Text>
        <Glass style={[s.card, s.centered]}>
          <Text style={s.bigGlyph}>🌙</Text>
          <Text style={s.h2c} accessibilityRole="header">
            {WORDS.ended}
          </Text>
          {shown.ended?.reason || (lost && lost !== WORDS.ended) ? <Text style={s.help}>{shown.ended?.reason || lost}</Text> : null}
        </Glass>
        {footer}
      </>
    );
  }

  return (
    <View style={s.root}>
      {fixed ? (
        <View style={[s.root, {paddingTop: barTop + 56, paddingBottom: bottom}]}>{body}</View>
      ) : (
        <KeyboardAvoidingView behavior="height" style={s.root}>
          <ScrollView ref={scroller} keyboardShouldPersistTaps="handled" contentContainerStyle={[{paddingTop: top, paddingBottom: bottom + 24, paddingHorizontal: GUTTER}, column]}>
            <View style={s.page}>{body}</View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
      {code ? <AddSheet code={code} visible={adding} onClose={() => setAdding(false)} onAdded={() => follow.current?.refresh()} /> : null}
      <BackBar />
    </View>
  );
}

const QR_SIZE = 196;

const s = StyleSheet.create({
  root: {flex: 1},
  page: {width: '100%', maxWidth: 560, alignSelf: 'center'},
  center: {alignItems: 'center', justifyContent: 'center'},
  centered: {alignItems: 'center'},
  grow: {flex: 1},
  shrink: {flex: 1, minWidth: 0},
  spin: {marginVertical: 14},
  h1: {color: colors.text, fontSize: 24, fontWeight: '900', letterSpacing: -0.72, lineHeight: 32},
  sub: {color: colors.textDim, fontSize: 15.68, lineHeight: 22, marginTop: 6},
  kicker: {color: colors.textFaint, fontSize: 13, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 10},
  h2: {color: colors.text, fontSize: 17.6, fontWeight: '800', marginTop: 20, marginBottom: 10},
  h2c: {color: colors.text, fontSize: 19, fontWeight: '800', textAlign: 'center', marginTop: 6},
  label: {color: colors.textFaint, fontSize: 13.6, fontWeight: '700', marginBottom: 8},
  help: {color: colors.textDim, fontSize: 14.4, lineHeight: 20, textAlign: 'center', marginTop: 8},
  err: {color: '#ffc9a8', fontSize: 14.4, lineHeight: 20, textAlign: 'center', marginTop: 10},
  card: {padding: 18, marginTop: 14},
  wide: {alignSelf: 'stretch', marginTop: 12},
  // the two ways in
  modes: {flexDirection: 'row', gap: 10, marginTop: 18},
  mode: {flex: 1, minHeight: 84, borderRadius: radius.l, padding: 12, alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.chip, borderWidth: 1, borderColor: colors.chipEdge},
  modeOn: {backgroundColor: 'rgba(139,123,255,0.20)', borderColor: 'rgba(139,123,255,0.55)'},
  modeGlyph: {color: colors.text, fontSize: 22},
  modeText: {color: 'rgba(243,244,248,0.82)', fontSize: 14.4, fontWeight: '800', textAlign: 'center'},
  modeTextOn: {color: '#ffffff'},
  codeField: {textAlign: 'center', fontSize: 28, fontWeight: '900', letterSpacing: 10, height: 62},
  bigCode: {color: colors.text, fontSize: 52, fontWeight: '900', letterSpacing: 12, marginVertical: 4, fontVariant: ['tabular-nums']},
  // .gp-qr: a white square with 12 of air round the code (196 + 24 = the website's 220)
  qr: {padding: 12, marginTop: 6, marginBottom: 6, borderRadius: radius.m, backgroundColor: '#ffffff'},
  hostLine: {color: colors.text, fontSize: 15.2, fontWeight: '700', marginTop: 6}, // .gp-host
  choiceRow: {marginBottom: 14},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  choiceLine: {color: colors.text, fontSize: 15.68, fontWeight: '700', textAlign: 'center'},
  link: {alignSelf: 'center', marginTop: 18, paddingVertical: 10, paddingHorizontal: 14},
  linkText: {color: colors.textDim, fontSize: 14.4, fontWeight: '700', textDecorationLine: 'underline'},
  actions: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 18},
  footer: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 26},
  // people
  people: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  person: {flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, paddingLeft: 6, paddingRight: 12, borderRadius: radius.pill, backgroundColor: colors.chip, borderWidth: 1, borderColor: colors.chipEdge, maxWidth: '100%'},
  away: {opacity: 0.6},
  personName: {color: colors.text, fontSize: 14, fontWeight: '700', flexShrink: 1},
  badge: {color: colors.textFaint, fontSize: 11.5, fontWeight: '800'},
  badgeDone: {color: '#6ee7a8'},
  addedBox: {marginTop: 18},
  addedRow: {color: colors.textDim, fontSize: 14.4, lineHeight: 22},
  // posters
  poster: {borderRadius: radius.l, overflow: 'hidden', backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)'},
  fallback: {alignItems: 'center', justifyContent: 'center', padding: 12, backgroundColor: 'rgba(110,90,220,0.28)'},
  fallbackText: {color: colors.textDim, fontSize: 16, fontWeight: '800', textAlign: 'center'},
  resultTitle: {color: colors.text, fontSize: 26, fontWeight: '900', textAlign: 'center', marginTop: 16, letterSpacing: -0.5},
  why: {color: '#cfd5ff', fontSize: 15.68, fontWeight: '700', textAlign: 'center', marginTop: 8},
  bigGlyph: {fontSize: 38, color: '#6ee7a8', marginBottom: 2},
  // the search sheet's rows
  sheetBody: {paddingHorizontal: GUTTER},
  hit: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, minHeight: 64},
  hitPoster: {borderRadius: 8},
  hitTitle: {color: colors.text, fontSize: 15.68, fontWeight: '700'},
  hitMeta: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3},
  hitYear: {color: colors.textFaint, fontSize: 13.6},
  hitAdd: {color: colors.text, fontSize: 22, fontWeight: '700', minWidth: 32, textAlign: 'center'},
  hitIn: {color: colors.textFaint, fontSize: 12.5, fontWeight: '800'},
  libBadge: {color: '#0b0c14', backgroundColor: colors.owned, fontSize: 11, fontWeight: '900', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, overflow: 'hidden'},
  // the swipe step (Swipe your taste's stage, card and answers)
  swipeHead: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: GUTTER, marginBottom: 10},
  timeLeft: {color: colors.text, fontSize: 18, fontWeight: '900', fontVariant: ['tabular-nums']},
  progress: {color: colors.textDim, fontSize: 13.6, fontWeight: '600'},
  stage: {flex: 1, minHeight: 240, marginHorizontal: GUTTER},
  card2: {position: 'absolute', left: 0, top: 0, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)'},
  cardBadge: {position: 'absolute', top: 12, left: 12},
  info: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 70, paddingHorizontal: 18, paddingBottom: 16, experimental_backgroundImage: INFO_FADE},
  cardTitle: {color: colors.text, fontSize: 21.6, fontWeight: '800', lineHeight: 26, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6, textShadowOffset: {width: 0, height: 1}},
  cardMeta: {color: 'rgba(243,244,248,0.78)', fontSize: 14, fontWeight: '600', marginTop: 4},
  cardLine: {color: 'rgba(243,244,248,0.72)', fontSize: 13.8, lineHeight: 18.6, marginTop: 6},
  cardNote: {color: '#cfd5ff', fontSize: 13, fontWeight: '700', marginTop: 6},
  stamp: {paddingHorizontal: 12, paddingVertical: 4, borderWidth: 3, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.25)'},
  stampLeft: {position: 'absolute', top: 22, left: 18, transform: [{rotate: '-12deg'}]},
  stampRight: {position: 'absolute', top: 22, right: 18, transform: [{rotate: '12deg'}]},
  stampMid: {position: 'absolute', top: '38%', left: 0, right: 0, alignItems: 'center'},
  stampText: {fontSize: 22.4, fontWeight: '900', letterSpacing: 1.3},
  answers: {flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 22, marginTop: 12, paddingBottom: 6},
  answer: {alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingVertical: 4, minWidth: 72},
  disc: {alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)'},
  discBig: {width: 60, height: 60, borderRadius: 30},
  discSmall: {width: 48, height: 48, borderRadius: 24},
  discGlyph: {fontSize: 26, fontWeight: '900'},
  discGlyphSmall: {fontSize: 20},
  answerLabel: {color: colors.textDim, fontSize: 12.5, fontWeight: '700'},
  // the explanation
  tut: {padding: 22, marginTop: 8},
  tutTitle: {color: colors.text, fontSize: 21.6, fontWeight: '900', textAlign: 'center', marginTop: 18},
  tutBody: {color: colors.textDim, fontSize: 15.68, lineHeight: 23, textAlign: 'center', marginTop: 8, minHeight: 69},
  dots: {flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 18},
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)'},
  dotOn: {width: 18, backgroundColor: colors.text},
  tutButtons: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 20},
  art: {height: 150, alignItems: 'center', justifyContent: 'center'},
  artRow: {flexDirection: 'row', gap: 14, alignItems: 'flex-end'},
  artTv: {width: 180, height: 104, borderRadius: 10, borderWidth: 3, borderColor: 'rgba(255,255,255,0.55)', backgroundColor: 'rgba(60,64,150,0.25)', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: 10},
  artCode: {color: colors.text, fontSize: 22, fontWeight: '900', letterSpacing: 4},
  artQr: {width: 40, height: 40, borderRadius: 4, borderWidth: 6, borderColor: 'rgba(255,255,255,0.7)', borderStyle: 'dotted'},
  artStand: {width: 60, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.4)', marginTop: 8},
  artPhone: {width: 52, height: 92, borderRadius: 10, borderWidth: 2.5, borderColor: 'rgba(255,255,255,0.55)', padding: 5},
  artPhoneMid: {height: 104, transform: [{translateY: -8}]},
  artPhoneScreen: {flex: 1, borderRadius: 5, backgroundColor: 'rgba(139,123,255,0.35)'},
  artCard: {width: 82, height: 118, borderRadius: 10, backgroundColor: 'rgba(139,123,255,0.30)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.45)', alignItems: 'center', justifyContent: 'center'},
  artTilt: {transform: [{rotate: '6deg'}]},
  artMarks: {flexDirection: 'row', gap: 12, marginTop: -14},
  artMark: {width: 34, height: 34, borderRadius: 17, borderWidth: 2, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(10,12,22,0.9)'},
  artMarkText: {fontSize: 16, fontWeight: '900'},
  artStar: {color: '#f0c67e', fontSize: 40},
});
